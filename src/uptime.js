'use strict';

const RANGES = {
  '24h': { segments: 24, segmentSeconds: 3600, bucketSeconds: 60 },
  '7d': { segments: 56, segmentSeconds: 10800, bucketSeconds: 600 },
  '30d': { segments: 120, segmentSeconds: 21600, bucketSeconds: 3600 },
  '90d': { segments: 90, segmentSeconds: 86400, bucketSeconds: 14400 },
  '1y': { segments: 52, segmentSeconds: 604800, bucketSeconds: 86400 },
};

const VALID_RANGES = new Set(Object.keys(RANGES));

// Milliseconds per range, used to bound statistics windows.
const RANGE_WINDOWS = {
  '24h': 24 * 3600 * 1000,
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
  '90d': 90 * 24 * 3600 * 1000,
  '1y': 365 * 24 * 3600 * 1000,
};

function resolveRange(range) {
  return RANGES[range] || RANGES['24h'];
}

// SQL fragment excluding checks that ran inside an active maintenance window.
const MAINTENANCE_EXCLUSION = `
  AND NOT EXISTS (
    SELECT 1 FROM maintenance_windows mw
    WHERE mw.service_id = c.service_id
      AND mw.started_at <= c.timestamp
      AND (mw.ended_at IS NULL OR mw.ended_at > c.timestamp)
  )`;

/**
 * Aggregate checks into a set of status segments for the given range.
 * Each segment is classified:
 *   - 'down'     if any check in the period failed
 *   - 'degraded' if any check was degraded (and none down)
 *   - 'up'       if all checks were up
 *   - 'none'     if there is no monitoring data for the period (gray)
 * Checks that ran during maintenance windows are excluded.
 */
function computeSegments(db, checksRepo, serviceId, rangeName, nowMs = Date.now(), opts = {}) {
  const range = resolveRange(rangeName);
  const segmentMs = range.segmentSeconds * 1000;
  const excludeMaintenance = opts.excludeMaintenance !== false;
  const alignedEnd = Math.floor(nowMs / segmentMs) * segmentMs;
  const start = alignedEnd - (range.segments - 1) * segmentMs;

  const rows = db
    .prepare(
      `SELECT
         CAST((c.timestamp / 1000 / ?) AS INTEGER) * ? * 1000 AS bucket_start,
         COUNT(*) AS total,
         SUM(CASE WHEN c.status = 'down' THEN 1 ELSE 0 END) AS down,
         SUM(CASE WHEN c.status = 'degraded' THEN 1 ELSE 0 END) AS degraded,
         SUM(CASE WHEN c.status = 'up' THEN 1 ELSE 0 END) AS up
       FROM checks c
       WHERE c.service_id = ? AND c.timestamp >= ? AND c.timestamp < ?
       ${excludeMaintenance ? MAINTENANCE_EXCLUSION : ''}
       GROUP BY bucket_start`
    )
    .all(range.segmentSeconds, range.segmentSeconds, serviceId, start, nowMs);

  const byBucket = new Map();
  for (const r of rows) {
    byBucket.set(r.bucket_start, r);
  }

  const segments = [];
  for (let i = 0; i < range.segments; i++) {
    const segStart = start + i * segmentMs;
    const segEnd = i === range.segments - 1 ? nowMs : segStart + segmentMs;
    const row = byBucket.get(segStart);
    let status = 'none';
    let checks = 0;
    let down = 0;
    let degraded = 0;
    let up = 0;
    if (row) {
      checks = row.total;
      down = row.down;
      degraded = row.degraded;
      up = row.up;
      if (down > 0) status = 'down';
      else if (degraded > 0) status = 'degraded';
      else if (up > 0) status = 'up';
    }
    segments.push({
      start: segStart,
      end: segEnd,
      status,
      checks,
      down,
      degraded,
      up,
    });
  }
  return { start, end: nowMs, segmentSeconds: range.segmentSeconds, segments };
}

/**
 * Response-time time series for the range, bucketed for charting.
 * Rows are [timestampMs, avgResponseTimeMs]. Buckets with no timed checks
 * are filled with null so the chart stays continuous on the x-axis.
 */
function computeResponseTimeseries(db, serviceId, rangeName, nowMs = Date.now(), opts = {}) {
  const range = resolveRange(rangeName);
  const bucketMs = range.bucketSeconds * 1000;
  const rangeMs = range.segmentSeconds * range.segments * 1000;
  const excludeMaintenance = opts.excludeMaintenance !== false;
  const alignedEnd = Math.floor(nowMs / bucketMs) * bucketMs;
  const start = alignedEnd - rangeMs;
  const count = Math.floor(rangeMs / bucketMs);

  const rows = db
    .prepare(
      `SELECT
         CAST((c.timestamp / 1000 / ?) AS INTEGER) * ? * 1000 AS bucket_start,
         AVG(c.response_time_ms) AS avg_ms
       FROM checks c
       WHERE c.service_id = ? AND c.timestamp >= ? AND c.timestamp < ?
         AND c.response_time_ms IS NOT NULL AND c.status IN ('up', 'degraded')
       ${excludeMaintenance ? MAINTENANCE_EXCLUSION : ''}
       GROUP BY bucket_start`
    )
    .all(range.bucketSeconds, range.bucketSeconds, serviceId, start, nowMs);

  const byBucket = new Map();
  for (const r of rows) byBucket.set(r.bucket_start, Math.round(r.avg_ms));

  const points = [];
  for (let i = 0; i <= count; i++) {
    const t = start + i * bucketMs;
    points.push({ t, value: byBucket.get(t) ?? null });
  }
  return { start, end: nowMs, bucketMs, points };
}

/**
 * Aggregate statistics for a service over the given window (milliseconds).
 */
function computeStats(db, serviceId, startMs, opts = {}) {
  const excludeMaintenance = opts.excludeMaintenance !== false;
  const rows = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN c.status IN ('up', 'degraded') THEN 1 ELSE 0 END) AS ok,
         SUM(CASE WHEN c.status = 'down' THEN 1 ELSE 0 END) AS down,
         SUM(CASE WHEN c.status = 'degraded' THEN 1 ELSE 0 END) AS degraded,
         AVG(CASE WHEN c.response_time_ms IS NOT NULL THEN c.response_time_ms END) AS avg_ms,
         MIN(CASE WHEN c.response_time_ms IS NOT NULL THEN c.response_time_ms END) AS min_ms,
         MAX(CASE WHEN c.response_time_ms IS NOT NULL THEN c.response_time_ms END) AS max_ms
       FROM checks c
       WHERE c.service_id = ? AND c.timestamp >= ?
       ${excludeMaintenance ? MAINTENANCE_EXCLUSION : ''}`
    )
    .get(serviceId, startMs);

  const total = rows.total || 0;
  const ok = rows.ok || 0;
  return {
    checks: total,
    up: ok - (rows.degraded || 0),
    degraded: rows.degraded || 0,
    down: rows.down || 0,
    uptime_percent: total > 0 ? Math.round((ok / total) * 10000) / 100 : null,
    avg_response_ms: rows.avg_ms == null ? null : Math.round(rows.avg_ms),
    min_response_ms: rows.min_ms == null ? null : Math.round(rows.min_ms),
    max_response_ms: rows.max_ms == null ? null : Math.round(rows.max_ms),
  };
}

/**
 * Incident statistics for a service over the window (milliseconds).
 */
function computeIncidentStats(db, incidentsRepo, serviceId, startMs) {
  const count = incidentsRepo.countInWindow(serviceId, startMs);
  const totalDowntime = incidentsRepo.totalDowntimeInWindow(serviceId, startMs);
  const totalMs = Math.max(Date.now() - startMs, 1);
  const uptimeFromIncidents =
    totalDowntime >= 0 ? Math.max(0, Math.round((1 - totalDowntime / (totalMs / 1000)) * 10000) / 100) : null;
  return {
    incidents: count,
    total_downtime_seconds: totalDowntime,
    avg_duration_seconds: count > 0 ? Math.round(totalDowntime / count) : null,
    uptime_percent: uptimeFromIncidents,
  };
}

/**
 * Compute rolling uptime used on cards/headers. Defaults to 30 days.
 */
function computeUptimePercent(db, serviceId, opts = {}) {
  const days = opts.days || 30;
  const start = Date.now() - days * 24 * 3600 * 1000;
  const excludeMaintenance = opts.excludeMaintenance !== false;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN c.status IN ('up', 'degraded') THEN 1 ELSE 0 END) AS ok
       FROM checks c WHERE c.service_id = ? AND c.timestamp >= ?
       ${excludeMaintenance ? MAINTENANCE_EXCLUSION : ''}`
    )
    .get(serviceId, start);
  if (!row.total) return null;
  return Math.round((row.ok / row.total) * 10000) / 100;
}

/**
 * Global aggregate statistics across all monitors over the window.
 * Returns uptime based on checks and incident-based downtime.
 */
function computeGlobalStats(db, startMs, opts = {}) {
  const excludeMaintenance = opts.excludeMaintenance !== false;
  const checks = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN c.status IN ('up', 'degraded') THEN 1 ELSE 0 END) AS ok,
         AVG(CASE WHEN c.response_time_ms IS NOT NULL THEN c.response_time_ms END) AS avg_ms
       FROM checks c WHERE c.timestamp >= ?
       ${excludeMaintenance ? MAINTENANCE_EXCLUSION : ''}`
    )
    .get(startMs);
  const total = checks.total || 0;
  const incidents = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(duration_seconds), 0) AS downtime
       FROM incidents WHERE ended_at IS NOT NULL AND started_at >= ?`
    )
    .get(startMs);
  const totalMs = Math.max(Date.now() - startMs, 1);
  return {
    checks: total,
    uptime_percent: total > 0 ? Math.round((checks.ok / total) * 10000) / 100 : null,
    avg_response_ms: checks.avg_ms == null ? null : Math.round(checks.avg_ms),
    incidents: incidents.n,
    total_downtime_seconds: incidents.downtime,
    incident_uptime_percent:
      incidents.downtime >= 0
        ? Math.max(0, Math.round((1 - incidents.downtime / (totalMs / 1000)) * 10000) / 100)
        : null,
  };
}

function uptimePercent(checksInWindow) {
  if (!checksInWindow || checksInWindow.length === 0) return null;
  let ok = 0;
  for (const c of checksInWindow) {
    if (c.status === 'up' || c.status === 'degraded') ok++;
  }
  return Math.round((ok / checksInWindow.length) * 10000) / 100;
}

module.exports = {
  RANGES,
  VALID_RANGES,
  RANGE_WINDOWS,
  computeSegments,
  computeResponseTimeseries,
  computeStats,
  computeIncidentStats,
  computeGlobalStats,
  computeUptimePercent,
  uptimePercent,
};
