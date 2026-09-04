'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createDb, SCHEMA_VERSION } = require('../src/db');
const { createServiceRepo } = require('../src/services');
const { createChecksRepo } = require('../src/checks');
const { createIncidentsRepo } = require('../src/incidents');
const { makeConfig } = require('./helpers');

function freshRepos() {
  const cfg = makeConfig();
  const db = createDb({ dbPath: cfg.dbPath });
  return {
    db,
    servicesRepo: createServiceRepo(db),
    checksRepo: createChecksRepo(db),
    incidentsRepo: createIncidentsRepo(db),
    close: () => db.close(),
  };
}

describe('database layer', () => {
  test('schema is created and settings are initialized', () => {
    const { db, close } = freshRepos();
    const version = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
    assert.equal(version.value, String(SCHEMA_VERSION));
    close();
  });

  test('service CRUD roundtrip preserves fields', () => {
    const { db, servicesRepo, close } = freshRepos();
    const created = servicesRepo.create({
      name: 'Portfolio',
      url: 'https://example.com',
      method: 'GET',
      expected_status_codes: [200, 204],
      interval_seconds: 30,
      timeout_ms: 5000,
      degraded_threshold_ms: 800,
      enabled: true,
      confirm_failures: 3,
    });
    assert.ok(created.id > 0);
    assert.deepEqual(created.expected_status_codes, [200, 204]);
    assert.equal(created.interval_seconds, 30);
    assert.equal(created.degraded_threshold_ms, 800);

    const updated = servicesRepo.update(created.id, { interval_seconds: 120, enabled: false });
    assert.equal(updated.interval_seconds, 120);
    assert.equal(updated.enabled, false);
    assert.equal(updated.name, 'Portfolio');
    assert.equal(updated.timeout_ms, 5000);

    assert.ok(servicesRepo.remove(created.id));
    assert.equal(servicesRepo.get(created.id), null);
    close();
  });

  test('checks are stored and retrieved newest-first', () => {
    const { db, servicesRepo, checksRepo, close } = freshRepos();
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    checksRepo.insert({ service_id: svc.id, timestamp: 1000, status: 'up', response_time_ms: 50, status_code: 200 });
    checksRepo.insert({ service_id: svc.id, timestamp: 2000, status: 'down', response_time_ms: null, status_code: null, error_type: 'connection', error_message: 'refused' });
    const all = checksRepo.listForService(svc.id, { limit: 10 });
    assert.equal(all.length, 2);
    assert.equal(all[0].timestamp, 2000);
    assert.equal(all[0].status, 'down');
    assert.equal(checksRepo.lastForService(svc.id).timestamp, 2000);
    close();
  });

  test('deleting a service cascades to checks and incidents', () => {
    const { db, servicesRepo, checksRepo, incidentsRepo, close } = freshRepos();
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    checksRepo.insert({ service_id: svc.id, timestamp: 1000, status: 'up', response_time_ms: 50, status_code: 200 });
    incidentsRepo.create({ service_id: svc.id, started_at: 1000, status_code: 500, error_message: 'err', check_count: 2 });
    servicesRepo.remove(svc.id);
    assert.equal(checksRepo.listForService(svc.id, { limit: 10 }).length, 0);
    assert.equal(incidentsRepo.listForService(svc.id, { limit: 10 }).length, 0);
    close();
  });

  test('incident open/resolve lifecycle', () => {
    const { db, servicesRepo, incidentsRepo, close } = freshRepos();
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    const inc = incidentsRepo.create({ service_id: svc.id, started_at: 1000, status_code: 500, error_message: 'err', check_count: 1 });
    assert.equal(inc.ended_at, null);
    assert.equal(incidentsRepo.openForService(svc.id).id, inc.id);
    incidentsRepo.recordFailure(inc.id, { status_code: 500, error_message: 'err2', duration_seconds: 5, check_count: 3 });
    const resolved = incidentsRepo.resolve(inc.id, 6000);
    assert.equal(resolved.ended_at, 6000);
    assert.equal(resolved.duration_seconds, 5);
    assert.equal(resolved.check_count, 3);
    assert.equal(incidentsRepo.openForService(svc.id), null);
    assert.equal(incidentsRepo.countOpenIncidents(), 0);
    close();
  });

  test('prune removes old checks', () => {
    const { db, servicesRepo, checksRepo, close } = freshRepos();
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    checksRepo.insert({ service_id: svc.id, timestamp: 1000000, status: 'up', response_time_ms: 50, status_code: 200 });
    checksRepo.insert({ service_id: svc.id, timestamp: Date.now(), status: 'up', response_time_ms: 50, status_code: 200 });
    const deleted = checksRepo.pruneOlderThan(2000000);
    assert.equal(deleted, 1);
    close();
  });
});
