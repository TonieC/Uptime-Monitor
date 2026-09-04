'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');
const { createServiceRepo } = require('../src/services');
const { createChecksRepo } = require('../src/checks');
const { createIncidentsRepo } = require('../src/incidents');
const { createMaintenanceRepo } = require('../src/maintenance');
const { makeConfig } = require('./helpers');
const {
  computeSegments,
  computeResponseTimeseries,
  computeStats,
  computeIncidentStats,
  computeUptimePercent,
  uptimePercent,
} = require('../src/uptime');

const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;
// Fixed reference time so all bucketing math is deterministic.
const NOW = 1700000000000;
const SEGMENT_MS = 3600 * 1000;

// Segment index for a timestamp under the 24h view.
function segmentIndex(ts) {
  const alignedEnd = Math.floor(NOW / SEGMENT_MS) * SEGMENT_MS;
  const start = alignedEnd - 23 * SEGMENT_MS;
  return Math.floor((ts - start) / SEGMENT_MS);
}

function seed(serviceId, checksRepo, entries) {
  for (const e of entries) {
    checksRepo.insert({
      service_id: serviceId,
      timestamp: e.ts,
      status: e.status,
      response_time_ms: e.ms ?? null,
      status_code: e.status === 'up' || e.status === 'degraded' ? 200 : null,
      error_type: e.status === 'down' ? 'connection' : null,
      error_message: e.status === 'down' ? 'err' : null,
    });
  }
}

describe('uptime aggregation', () => {
  test('computeSegments classifies 24h window correctly', () => {
    const cfg = makeConfig();
    const db = createDb({ dbPath: cfg.dbPath });
    const servicesRepo = createServiceRepo(db);
    const checksRepo = createChecksRepo(db);
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });

    seed(svc.id, checksRepo, [
      { ts: NOW - 22.5 * HOUR, status: 'up', ms: 100 },
      { ts: NOW - 21 * HOUR, status: 'up', ms: 90 },
      { ts: NOW - 19.5 * HOUR, status: 'degraded', ms: 5000 },
      { ts: NOW - 3 * HOUR, status: 'down' },
      { ts: NOW - 1.5 * HOUR, status: 'up', ms: 110 },
    ]);

    const { segments } = computeSegments(db, checksRepo, svc.id, '24h', NOW);
    assert.equal(segments.length, 24);
    assert.equal(segments[segmentIndex(NOW - 22.5 * HOUR)].status, 'up');
    assert.equal(segments[segmentIndex(NOW - 21 * HOUR)].status, 'up');
    assert.equal(segments[segmentIndex(NOW - 19.5 * HOUR)].status, 'degraded');
    assert.equal(segments[segmentIndex(NOW - 3 * HOUR)].status, 'down');
    assert.equal(segments[segmentIndex(NOW - 1.5 * HOUR)].status, 'up');
    // Segments with no checks are 'none'.
    const emptyIdx = segmentIndex(NOW - 10 * HOUR);
    assert.equal(segments[emptyIdx].status, 'none');
    assert.equal(segments[emptyIdx].checks, 0);
    // The final (partial) segment is the current hour and ends at nowMs.
    const last = segments[segments.length - 1];
    assert.equal(last.end, NOW);
    assert.equal(last.start, Math.floor(NOW / SEGMENT_MS) * SEGMENT_MS);

    db.close();
  });

  test('computeSegments down takes precedence over degraded', () => {
    const cfg = makeConfig();
    const db = createDb({ dbPath: cfg.dbPath });
    const servicesRepo = createServiceRepo(db);
    const checksRepo = createChecksRepo(db);
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    // Both checks land inside the current partial hour segment.
    seed(svc.id, checksRepo, [
      { ts: NOW - 10 * MINUTE, status: 'down' },
      { ts: NOW - 5 * MINUTE, status: 'degraded', ms: 4000 },
    ]);
    const { segments } = computeSegments(db, checksRepo, svc.id, '24h', NOW);
    const last = segments[segments.length - 1];
    assert.equal(last.status, 'down');
    assert.equal(last.down, 1);
    assert.equal(last.degraded, 1);
    db.close();
  });

  test('computeSegments counts checks within a segment', () => {
    const cfg = makeConfig();
    const db = createDb({ dbPath: cfg.dbPath });
    const servicesRepo = createServiceRepo(db);
    const checksRepo = createChecksRepo(db);
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    seed(svc.id, checksRepo, [
      { ts: NOW - 30 * MINUTE, status: 'up', ms: 100 },
      { ts: NOW - 24 * MINUTE, status: 'up', ms: 120 },
      { ts: NOW - 18 * MINUTE, status: 'down' },
    ]);
    const { segments } = computeSegments(db, checksRepo, svc.id, '24h', NOW);
    // 18-30 minutes ago is inside the full hour before the current one.
    const seg = segments[segments.length - 2];
    assert.equal(seg.status, 'down');
    assert.equal(seg.checks, 3);
    assert.equal(seg.up, 2);
    assert.equal(seg.down, 1);
    db.close();
  });

  test('computeStats returns correct aggregates', () => {
    const cfg = makeConfig();
    const db = createDb({ dbPath: cfg.dbPath });
    const servicesRepo = createServiceRepo(db);
    const checksRepo = createChecksRepo(db);
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    const now = Date.now();
    seed(svc.id, checksRepo, [
      { ts: now - 3600, status: 'up', ms: 100 },
      { ts: now - 1800, status: 'degraded', ms: 300 },
      { ts: now - 900, status: 'down' },
      { ts: now - 100, status: 'up', ms: 200 },
    ]);
    const stats = computeStats(db, svc.id, now - 24 * HOUR);
    assert.equal(stats.checks, 4);
    assert.equal(stats.up, 2);
    assert.equal(stats.degraded, 1);
    assert.equal(stats.down, 1);
    assert.equal(stats.uptime_percent, 75);
    assert.equal(stats.avg_response_ms, 200);
    assert.equal(stats.min_response_ms, 100);
    assert.equal(stats.max_response_ms, 300);
    db.close();
  });

  test('computeStats returns nulls when no checks exist', () => {
    const cfg = makeConfig();
    const db = createDb({ dbPath: cfg.dbPath });
    const servicesRepo = createServiceRepo(db);
    const checksRepo = createChecksRepo(db);
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    const stats = computeStats(db, svc.id, Date.now() - 24 * HOUR);
    assert.equal(stats.checks, 0);
    assert.equal(stats.uptime_percent, null);
    assert.equal(stats.avg_response_ms, null);
    db.close();
  });

  test('computeResponseTimeseries buckets correctly', () => {
    const cfg = makeConfig();
    const db = createDb({ dbPath: cfg.dbPath });
    const servicesRepo = createServiceRepo(db);
    const checksRepo = createChecksRepo(db);
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    seed(svc.id, checksRepo, [
      { ts: NOW - 5000, status: 'up', ms: 100 },
      { ts: NOW - 4000, status: 'up', ms: 300 },
      { ts: NOW - 3000, status: 'down' },
    ]);
    const series = computeResponseTimeseries(db, svc.id, '24h', NOW);
    assert.equal(series.points.length, 1441);
    const last = series.points[series.points.length - 1];
    // The three checks all fall in the current 1-minute bucket; the down
    // check is excluded from the response-time average.
    assert.equal(last.value, 200);
    db.close();
  });

  test('computeUptimePercent computes 30-day rolling uptime', () => {
    const cfg = makeConfig();
    const db = createDb({ dbPath: cfg.dbPath });
    const servicesRepo = createServiceRepo(db);
    const checksRepo = createChecksRepo(db);
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    const now = Date.now();
    seed(svc.id, checksRepo, [
      { ts: now - 5 * 86400 * 1000, status: 'up', ms: 100 },
      { ts: now - 4 * 86400 * 1000, status: 'down' },
      { ts: now - 3 * 86400 * 1000, status: 'up', ms: 100 },
      { ts: now - 2 * 86400 * 1000, status: 'up', ms: 100 },
      { ts: now - 1 * 86400 * 1000, status: 'up', ms: 100 },
    ]);
    assert.equal(computeUptimePercent(db, svc.id), 80);
    db.close();
  });

  test('uptimePercent util handles empty input', () => {
    assert.equal(uptimePercent([]), null);
    assert.equal(uptimePercent([{ status: 'up' }, { status: 'degraded' }, { status: 'down' }]), 66.67);
  });
});

describe('uptime maintenance exclusion', () => {
  test('computeStats ignores checks that ran inside a maintenance window', () => {
    const cfg = makeConfig();
    const db = createDb({ dbPath: cfg.dbPath });
    const servicesRepo = createServiceRepo(db);
    const checksRepo = createChecksRepo(db);
    const maintenanceRepo = createMaintenanceRepo(db);
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    const now = Date.now();
    // Maintenance covered the 8-4 day window.
    maintenanceRepo.start(svc.id, {
      startedAt: now - 8 * 86400 * 1000,
      until: now - 4 * 86400 * 1000,
      reason: 'planned',
    });
    seed(svc.id, checksRepo, [
      { ts: now - 6 * 86400 * 1000, status: 'down' }, // inside window
      { ts: now - 5 * 86400 * 1000, status: 'down' }, // inside window
      { ts: now - 2 * 86400 * 1000, status: 'up', ms: 100 },
      { ts: now - 1 * 86400 * 1000, status: 'up', ms: 100 },
    ]);
    const withExclusion = computeStats(db, svc.id, now - 30 * 86400 * 1000);
    assert.equal(withExclusion.checks, 2);
    assert.equal(withExclusion.down, 0);
    assert.equal(withExclusion.up, 2);
    assert.equal(withExclusion.uptime_percent, 100);
    const without = computeStats(db, svc.id, now - 30 * 86400 * 1000, { excludeMaintenance: false });
    assert.equal(without.checks, 4);
    assert.equal(without.uptime_percent, 50);
    db.close();
  });

  test('computeSegments shows maintenance periods as gray', () => {
    const cfg = makeConfig();
    const db = createDb({ dbPath: cfg.dbPath });
    const servicesRepo = createServiceRepo(db);
    const checksRepo = createChecksRepo(db);
    const maintenanceRepo = createMaintenanceRepo(db);
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    // Maintenance window from 4h ago to 2h ago.
    maintenanceRepo.start(svc.id, { startedAt: NOW - 4 * HOUR, until: NOW - 2 * HOUR, reason: 'upgrade' });
    seed(svc.id, checksRepo, [
      { ts: NOW - 3 * HOUR, status: 'down' },
      { ts: NOW - 1 * HOUR, status: 'up', ms: 100 },
    ]);
    const { segments } = computeSegments(db, checksRepo, svc.id, '24h', NOW);
    assert.equal(segments[segmentIndex(NOW - 3 * HOUR)].status, 'none');
    assert.equal(segments[segmentIndex(NOW - 3 * HOUR)].checks, 0);
    assert.equal(segments[segmentIndex(NOW - 1 * HOUR)].status, 'up');
    // Disabling exclusion makes the down check visible again.
    const raw = computeSegments(db, checksRepo, svc.id, '24h', NOW, { excludeMaintenance: false });
    assert.equal(raw.segments[segmentIndex(NOW - 3 * HOUR)].status, 'down');
    db.close();
  });

  test('computeUptimePercent excludes maintenance-covered downtime', () => {
    const cfg = makeConfig();
    const db = createDb({ dbPath: cfg.dbPath });
    const servicesRepo = createServiceRepo(db);
    const checksRepo = createChecksRepo(db);
    const maintenanceRepo = createMaintenanceRepo(db);
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    const now = Date.now();
    maintenanceRepo.start(svc.id, {
      startedAt: now - 10 * 86400 * 1000,
      until: now - 3 * 86400 * 1000,
      reason: 'migration',
    });
    seed(svc.id, checksRepo, [
      { ts: now - 5 * 86400 * 1000, status: 'down' }, // inside window
      { ts: now - 1 * 86400 * 1000, status: 'up', ms: 100 },
    ]);
    assert.equal(computeUptimePercent(db, svc.id, { days: 30 }), 100);
    assert.equal(computeUptimePercent(db, svc.id, { days: 30, excludeMaintenance: false }), 50);
    db.close();
  });
});

describe('incident statistics', () => {
  test('computeIncidentStats aggregates resolved incidents in the window', () => {
    const cfg = makeConfig();
    const db = createDb({ dbPath: cfg.dbPath });
    const servicesRepo = createServiceRepo(db);
    const incidentsRepo = createIncidentsRepo(db);
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    const now = Date.now();
    const one = incidentsRepo.create({ service_id: svc.id, started_at: now - 60 * MINUTE });
    incidentsRepo.resolve(one.id, now - 30 * MINUTE); // 30 min downtime
    const two = incidentsRepo.create({ service_id: svc.id, started_at: now - 20 * MINUTE });
    incidentsRepo.resolve(two.id, now - 10 * MINUTE); // 10 min downtime
    const stats = computeIncidentStats(db, incidentsRepo, svc.id, now - 24 * HOUR);
    assert.equal(stats.incidents, 2);
    assert.equal(stats.total_downtime_seconds, 40 * 60);
    assert.equal(stats.avg_duration_seconds, 20 * 60);
    assert.ok(stats.uptime_percent < 100);
    // Older incidents outside the window are not counted.
    const old = incidentsRepo.create({ service_id: svc.id, started_at: now - 2 * 24 * HOUR });
    incidentsRepo.resolve(old.id, now - 2 * 24 * HOUR + 60 * MINUTE);
    const within = computeIncidentStats(db, incidentsRepo, svc.id, now - 24 * HOUR);
    assert.equal(within.incidents, 2);
    db.close();
  });

  test('computeIncidentStats handles services with no incidents', () => {
    const cfg = makeConfig();
    const db = createDb({ dbPath: cfg.dbPath });
    const servicesRepo = createServiceRepo(db);
    const incidentsRepo = createIncidentsRepo(db);
    const svc = servicesRepo.create({ name: 'S', url: 'https://example.com' });
    const stats = computeIncidentStats(db, incidentsRepo, svc.id, Date.now() - 24 * HOUR);
    assert.equal(stats.incidents, 0);
    assert.equal(stats.total_downtime_seconds, 0);
    assert.equal(stats.avg_duration_seconds, null);
    db.close();
  });
});
