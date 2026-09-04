'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { MonitoringWorker } = require('../src/worker');
const { makeConfig } = require('./helpers');
const { createDb } = require('../src/db');
const { createServiceRepo } = require('../src/services');
const { createChecksRepo } = require('../src/checks');
const { createIncidentsRepo } = require('../src/incidents');
const { createMaintenanceRepo } = require('../src/maintenance');

function makeWorker(cfgOverrides) {
  const cfg = makeConfig(cfgOverrides);
  const db = createDb({ dbPath: cfg.dbPath });
  const servicesRepo = createServiceRepo(db);
  const checksRepo = createChecksRepo(db);
  const incidentsRepo = createIncidentsRepo(db);
  const maintenanceRepo = createMaintenanceRepo(db);
  const worker = new MonitoringWorker({ db, servicesRepo, checksRepo, incidentsRepo, maintenanceRepo, config: cfg });
  return { cfg, db, servicesRepo, checksRepo, incidentsRepo, maintenanceRepo, worker };
}

function baseService(url, overrides = {}) {
  return {
    name: 's',
    url,
    type: 'http',
    method: 'GET',
    interval_seconds: 5,
    timeout_ms: 2000,
    expected_status_codes: [200],
    confirm_failures: 1,
    degraded_threshold_ms: null,
    retries: 0,
    retry_delay_ms: 0,
    recovery_threshold: 1,
    check_certificate: true,
    ssl_expiry_threshold_days: 14,
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    consecutiveFailures: 0,
    incidentId: null,
    lastStatus: null,
    lastCheckAt: null,
    recoveryStreak: 0,
    sslNotifiedAt: 0,
    ...overrides,
  };
}

// Server that fails (500) the first `failures` requests then succeeds.
function startFlakyServer(failures) {
  let count = 0;
  const server = http.createServer((req, res) => {
    count += 1;
    if (count <= failures) {
      res.writeHead(500);
      res.end('fail');
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        hits: () => count,
      });
    });
  });
}

describe('worker retries', () => {
  test('retries before committing a result, reporting the final outcome', async () => {
    const flaky = await startFlakyServer(2);
    const { db, servicesRepo, checksRepo, incidentsRepo, worker } = makeWorker();
    const svc = servicesRepo.create(baseService(flaky.url, { retries: 3, retry_delay_ms: 10 }));
    const events = [];
    worker.on('incident-opened', (i) => events.push(i));

    await worker.runService(svc, { reschedule: false });
    // Attempt 1 + 2 fail, retry 3 succeeds -> up, and hits == 3.
    assert.equal(flaky.hits(), 3);
    assert.equal(checksRepo.lastForService(svc.id).status, 'up');
    assert.equal(incidentsRepo.openForService(svc.id), null);
    assert.equal(events.length, 0);
    worker.shutdown();
    await new Promise((r) => flaky.server.close(r));
    db.close();
  });

  test('retries do not mask a genuine outage beyond configured attempts', async () => {
    const flaky = await startFlakyServer(5);
    const { db, servicesRepo, checksRepo, incidentsRepo, worker } = makeWorker();
    const svc = servicesRepo.create(baseService(flaky.url, { retries: 2, retry_delay_ms: 5, confirm_failures: 1 }));
    const events = [];
    worker.on('incident-opened', (i) => events.push(i));

    await worker.runService(svc, { reschedule: false });
    assert.equal(flaky.hits(), 3); // 1 original + 2 retries
    assert.equal(checksRepo.lastForService(svc.id).status, 'down');
    assert.ok(incidentsRepo.openForService(svc.id));
    assert.equal(events.length, 1);
    worker.shutdown();
    await new Promise((r) => flaky.server.close(r));
    db.close();
  });
});

describe('recovery threshold', () => {
  test('requires recovery_threshold consecutive successes to resolve', async () => {
    const { db, servicesRepo, checksRepo, incidentsRepo, worker } = makeWorker();
    const url = 'http://127.0.0.1:1'; // always refused
    const svc = servicesRepo.create(baseService(url, { confirm_failures: 1, recovery_threshold: 2 }));
    await worker.runService(svc, { reschedule: false });
    assert.ok(incidentsRepo.openForService(svc.id));

    // First success after downtime does not resolve.
    const good = await startFlakyServer(0);
    svc.url = good.url;
    await worker.runService(svc, { reschedule: false });
    const afterOne = incidentsRepo.openForService(svc.id);
    assert.ok(afterOne, 'incident remains after a single success');
    assert.equal(afterOne.ended_at, null);

    // Second consecutive success resolves.
    await worker.runService(svc, { reschedule: false });
    assert.equal(incidentsRepo.openForService(svc.id), null);
    const resolved = incidentsRepo.listForService(svc.id, { limit: 5 })[0];
    assert.ok(resolved.ended_at);
    worker.shutdown();
    await new Promise((r) => good.server.close(r));
    db.close();
  });
});

describe('maintenance mode', () => {
  test('no incident is opened during a maintenance window', async () => {
    const { db, servicesRepo, incidentsRepo, maintenanceRepo, worker } = makeWorker();
    const svc = servicesRepo.create(baseService('http://127.0.0.1:1', { confirm_failures: 1 }));
    maintenanceRepo.start(svc.id, { until: Date.now() + 60000, reason: 'upgrade' });
    const statusChanges = [];
    worker.on('status-change', (m) => statusChanges.push([m.from, m.to]));

    await worker.runService(svc, { reschedule: false });
    assert.equal(incidentsRepo.openForService(svc.id), null);
    assert.deepEqual(statusChanges[0], [null, 'maintenance']);

    // Ending the window means failures count again.
    maintenanceRepo.endActive(svc.id);
    await worker.runService(svc, { reschedule: false });
    assert.ok(incidentsRepo.openForService(svc.id));
    worker.shutdown();
    db.close();
  });

  test('an open incident is not resolved during maintenance', async () => {
    const { db, servicesRepo, incidentsRepo, maintenanceRepo, worker } = makeWorker();
    const svc = servicesRepo.create(baseService('http://127.0.0.1:1'));
    await worker.runService(svc, { reschedule: false });
    assert.ok(incidentsRepo.openForService(svc.id));

    maintenanceRepo.start(svc.id, { until: Date.now() + 60000, reason: 'planned' });
    const good = await startFlakyServer(0);
    svc.url = good.url;
    await worker.runService(svc, { reschedule: false });
    assert.ok(incidentsRepo.openForService(svc.id), 'incident stays open through maintenance');

    maintenanceRepo.endActive(svc.id);
    await worker.runService(svc, { reschedule: false });
    assert.equal(incidentsRepo.openForService(svc.id), null, 'incident resolves after maintenance');
    worker.shutdown();
    await new Promise((r) => good.server.close(r));
    db.close();
  });
});

describe('SSL expiry alerting', () => {
  test('emits ssl-expiring once per cooldown window', async () => {
    const { db, servicesRepo, worker } = makeWorker();
    const svc = servicesRepo.create(baseService('http://127.0.0.1:1', { check_certificate: true, ssl_expiry_threshold_days: 14 }));
    const events = [];
    worker.on('ssl-expiring', (p) => events.push(p));

    const ts = Date.now();
    const nearExpiry = ts + 5 * 24 * 3600 * 1000; // 5 days left
    worker.handleResult(svc, {
      status: 'up',
      responseTime: 10,
      statusCode: 200,
      errorType: null,
      errorMessage: null,
      timestamp: ts,
      certExpiresAt: nearExpiry,
    }, makeState());

    assert.equal(events.length, 1);
    assert.ok(events[0].daysLeft < 14);

    // A subsequent check shortly after must not re-emit.
    worker.handleResult(svc, {
      status: 'up',
      responseTime: 10,
      statusCode: 200,
      errorType: null,
      errorMessage: null,
      timestamp: ts + 1000,
      certExpiresAt: nearExpiry,
    }, worker.state.get(svc.id));

    assert.equal(events.length, 1, 'cooldown suppresses duplicate ssl alerts');
    worker.shutdown();
    db.close();
  });

  test('does not emit when the certificate is far from expiry', async () => {
    const { db, servicesRepo, worker } = makeWorker();
    const svc = servicesRepo.create(baseService('http://127.0.0.1:1'));
    const events = [];
    worker.on('ssl-expiring', (p) => events.push(p));
    const ts = Date.now();
    worker.handleResult(svc, {
      status: 'up',
      responseTime: 10,
      statusCode: 200,
      timestamp: ts,
      certExpiresAt: ts + 300 * 24 * 3600 * 1000,
    }, {});
    assert.equal(events.length, 0);
    worker.shutdown();
    db.close();
  });
});
