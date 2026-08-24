'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { performCheck, MonitoringWorker } = require('../src/worker');
const { makeConfig, startProbeServer } = require('./helpers');
const { createDb } = require('../src/db');
const { createServiceRepo } = require('../src/services');
const { createChecksRepo } = require('../src/checks');
const { createIncidentsRepo } = require('../src/incidents');

let probe;
let base;

before(async () => {
  probe = await startProbeServer();
  base = probe.url;
});

after(() => {
  probe.server.close();
});

describe('performCheck', () => {
  test('marks a fast 200 as up', async () => {
    const r = await performCheck({ url: `${base}/fast`, timeout_ms: 3000, expected_status_codes: [200], degraded_threshold_ms: null }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'up');
    assert.equal(r.statusCode, 200);
    assert.ok(r.responseTime >= 0);
    assert.equal(r.errorType, null);
  });

  test('marks a slow 200 as degraded when above threshold', async () => {
    const r = await performCheck({ url: `${base}/slow`, timeout_ms: 5000, expected_status_codes: [200], degraded_threshold_ms: 100 }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'degraded');
    assert.equal(r.statusCode, 200);
    assert.ok(r.responseTime >= 400);
  });

  test('marks a slow 200 as up when below threshold', async () => {
    const r = await performCheck({ url: `${base}/slow`, timeout_ms: 5000, expected_status_codes: [200], degraded_threshold_ms: 5000 }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'up');
  });

  test('marks unexpected status as down', async () => {
    const r = await performCheck({ url: `${base}/error`, timeout_ms: 3000, expected_status_codes: [200], degraded_threshold_ms: null }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'down');
    assert.equal(r.errorType, 'http_status');
    assert.equal(r.statusCode, 500);
  });

  test('marks connection refused as down with connection error', async () => {
    const closed = await startProbeServer();
    const { server, url } = closed;
    await new Promise((resolve) => server.close(resolve));
    const r = await performCheck({ url, timeout_ms: 2000, expected_status_codes: [200], degraded_threshold_ms: null }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'down');
    assert.equal(r.errorType, 'connection');
  });

  test('marks timeout as down with timeout error', async () => {
    const r = await performCheck({ url: `${base}/hang`, timeout_ms: 300, expected_status_codes: [200], degraded_threshold_ms: null }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'down');
    assert.equal(r.errorType, 'timeout');
  });

  test('marks DNS failure as down with dns error', async () => {
    const r = await performCheck({ url: 'http://this-host-does-not-exist.invalid/', timeout_ms: 3000, expected_status_codes: [200], degraded_threshold_ms: null }, { allowPrivateNetworks: false });
    assert.equal(r.status, 'down');
    assert.equal(r.errorType, 'dns');
  });

  test('follows a redirect and reports the final status', async () => {
    const r = await performCheck({ url: `${base}/redirect`, timeout_ms: 3000, expected_status_codes: [200], degraded_threshold_ms: null }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'up');
    assert.equal(r.statusCode, 200);
    assert.ok(r.redirects >= 1);
  });

  test('follows a relative redirect', async () => {
    const r = await performCheck({ url: `${base}/redirect-relative`, timeout_ms: 3000, expected_status_codes: [200], degraded_threshold_ms: null }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'up');
    assert.equal(r.statusCode, 200);
  });

  test('fails on redirect loops', async () => {
    const r = await performCheck({ url: `${base}/redirect-loop`, timeout_ms: 5000, expected_status_codes: [200], degraded_threshold_ms: null }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'down');
    assert.match(r.errorMessage, /redirects/i);
  });

  test('blocks a private target when the guard is active', async () => {
    const srv = await startProbeServer();
    const { server, url } = srv;
    const r = await performCheck({ url, timeout_ms: 3000, expected_status_codes: [200], degraded_threshold_ms: null }, { allowPrivateNetworks: false });
    assert.equal(r.status, 'down');
    assert.equal(r.errorType, 'blocked');
    await new Promise((resolve) => server.close(resolve));
  });

  test('rejects an invalid URL', async () => {
    const r = await performCheck({ url: 'not-a-url', timeout_ms: 1000, expected_status_codes: [200], degraded_threshold_ms: null }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'down');
    assert.equal(r.errorType, 'invalid');
  });
});

describe('MonitoringWorker incident detection', () => {
  function makeWorker(cfgOverrides) {
    const cfg = makeConfig(cfgOverrides);
    const db = createDb({ dbPath: cfg.dbPath });
    const servicesRepo = createServiceRepo(db);
    const checksRepo = createChecksRepo(db);
    const incidentsRepo = createIncidentsRepo(db);
    const worker = new MonitoringWorker({ db, servicesRepo, checksRepo, incidentsRepo, config: cfg });
    return { cfg, db, servicesRepo, checksRepo, incidentsRepo, worker };
  }

  test('opens an incident only after confirm_failures consecutive failures', async () => {
    const { db, servicesRepo, checksRepo, incidentsRepo, worker } = makeWorker();
    const svc = servicesRepo.create({
      name: 'flaky',
      url: `${base}/error`,
      interval_seconds: 5,
      timeout_ms: 2000,
      expected_status_codes: [200],
      confirm_failures: 2,
    });
    const events = [];
    worker.on('incident-opened', (i) => events.push(i));
    worker.on('incident-resolved', (i) => events.push(i));

    // First failure: below confirmation threshold, no incident.
    await worker.runService(svc, { reschedule: false });
    assert.equal(incidentsRepo.openForService(svc.id), null);

    // Second consecutive failure: incident opens.
    await worker.runService(svc, { reschedule: false });
    const open = incidentsRepo.openForService(svc.id);
    assert.ok(open);
    assert.equal(open.check_count, 2);
    assert.equal(events.length, 1);

    // Third failure: grouped into the same incident.
    await worker.runService(svc, { reschedule: false });
    const same = incidentsRepo.openForService(svc.id);
    assert.equal(same.id, open.id);
    assert.equal(same.check_count, 3);
    assert.equal(events.length, 1);

    // A single failure is not re-counted from zero after recovery.
    worker.shutdown();
    db.close();
  });

  test('a single blip does not open an incident', async () => {
    const { db, servicesRepo, incidentsRepo, worker } = makeWorker();
    const svc = servicesRepo.create({
      name: 'blip',
      url: `${base}/error`,
      interval_seconds: 5,
      timeout_ms: 2000,
      expected_status_codes: [200],
      confirm_failures: 3,
    });
    await worker.runService(svc, { reschedule: false });
    assert.equal(incidentsRepo.openForService(svc.id), null);
    worker.shutdown();
    db.close();
  });

  test('resolves the incident when the service recovers', async () => {
    const { db, servicesRepo, checksRepo, incidentsRepo, worker } = makeWorker();
    const svc = servicesRepo.create({
      name: 'recover',
      url: `${base}/error`,
      interval_seconds: 5,
      timeout_ms: 2000,
      expected_status_codes: [200],
      confirm_failures: 2,
    });
    const events = [];
    worker.on('incident-opened', (i) => events.push(['open', i.id]));
    worker.on('incident-resolved', (i) => events.push(['resolved', i.id]));

    await worker.runService(svc, { reschedule: false });
    await worker.runService(svc, { reschedule: false });
    const open = incidentsRepo.openForService(svc.id);
    assert.ok(open);

    // Recover: point at the fast endpoint and run again.
    svc.url = `${base}/fast`;
    await worker.runService(svc, { reschedule: false });
    const resolved = incidentsRepo.listForService(svc.id, { limit: 5 })[0];
    assert.ok(resolved.ended_at);
    assert.ok(resolved.duration_seconds >= 0);
    assert.equal(resolved.check_count, 2);
    assert.deepEqual(events[1], ['resolved', open.id]);
    assert.equal(incidentsRepo.openForService(svc.id), null);
    worker.shutdown();
    db.close();
  });

  test('emits status-change events on transitions', async () => {
    const { db, servicesRepo, incidentsRepo, worker } = makeWorker();
    const svc = servicesRepo.create({
      name: 'transitions',
      url: `${base}/error`,
      interval_seconds: 5,
      timeout_ms: 2000,
      expected_status_codes: [200],
      confirm_failures: 1,
    });
    const changes = [];
    worker.on('status-change', (m) => changes.push([m.from, m.to]));

    await worker.runService(svc, { reschedule: false });
    assert.deepEqual(changes[0], [null, 'down']);

    svc.url = `${base}/fast`;
    await worker.runService(svc, { reschedule: false });
    assert.deepEqual(changes[1], ['down', 'up']);
    worker.shutdown();
    db.close();
  });

  test('start() restores an open incident from the database', async () => {
    const ctx = makeWorker();
    const { db, servicesRepo, checksRepo, incidentsRepo, worker, cfg } = ctx;
    const svc = servicesRepo.create({
      name: 'restore',
      url: `${base}/error`,
      interval_seconds: 5,
      timeout_ms: 2000,
      expected_status_codes: [200],
      confirm_failures: 2,
    });
    await worker.runService(svc, { reschedule: false });
    await worker.runService(svc, { reschedule: false });
    assert.ok(incidentsRepo.openForService(svc.id));
    worker.shutdown();
    db.close();

    // New worker on the same database resumes with the incident open.
    const db2 = createDb({ dbPath: cfg.dbPath });
    const servicesRepo2 = createServiceRepo(db2);
    const checksRepo2 = createChecksRepo(db2);
    const incidentsRepo2 = createIncidentsRepo(db2);
    const worker2 = new MonitoringWorker({ db: db2, servicesRepo: servicesRepo2, checksRepo: checksRepo2, incidentsRepo: incidentsRepo2, config: cfg });
    worker2.start();
    const svc2 = servicesRepo2.get(svc.id);
    assert.equal(svc2.url, `${base}/error`);
    // The recovered incident state: one more failure continues the open incident.
    await worker2.runService(svc2, { reschedule: false });
    const open = incidentsRepo2.openForService(svc2.id);
    assert.ok(open);
    assert.equal(open.check_count, 3);
    worker2.shutdown();
    db2.close();
  });
});
