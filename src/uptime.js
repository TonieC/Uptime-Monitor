'use strict';

const RANGES = {
  '24h': { segments: 24, segmentSeconds: 3600, bucketSeconds: 60 },
  '7d': { segments: 56, segmentSeconds: 10800, bucketSeconds: 600 },
  '30d': { segments: 120, segmentSeconds: 21600, bucketSeconds: 3600 },
};

const VALID_RANGES = new Set(Object.keys(RANGES));

function resolveRange(range) {
  return RANGES[range] || RANGES['24h'];
}

/**
 * Aggregate checks into a set of status segments for the given range.
 * Each segment is classified:
 *   - 'down'     if any check in the period failed
 *   - 'degraded' if any check was degraded (and none down)
 *   - 'up'       if all checks were up
 *   - 'none'     if there is no monitoring data for the period (gray)
 */
function computeSegments(db, checksRepo, serviceId, rangeName, nowMs = Date.now()) {
  const range = resolveRange(rangeName);
  const segmentMs = range.segmentSeconds * 1000;
  // Segment boundaries are aligned to absolute time. The last segment is the
  // current (partial) period and covers [alignedEnd, nowMs); the preceding
  // segments are complete periods. The query window runs to nowMs so checks
  // recorded in the current period are included.
  const alignedEnd = Math.floor(nowMs / segmentMs) * segmentMs;
  const start = alignedEnd - (range.segments - 1) * segmentMs;

  const rows = db
    .prepare(
      `SELECT
         CAST((timestamp / 1000 / ?) AS INTEGER) * ? * 1000 AS bucket_start,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down,
         SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS degraded,
         SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up
       FROM checks
       WHERE service_id = ? AND timestamp >= ? AND timestamp < ?
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
function computeResponseTimeseries(db, serviceId, rangeName, nowMs = Date.now()) {
  const range = resolveRange(rangeName);
  const bucketMs = range.bucketSeconds * 1000;
  const rangeMs = range.segmentSeconds * range.segments * 1000;
  // Points are aligned to absolute bucket boundaries; the query window runs
  // to nowMs so the current partial bucket includes its checks.
  const alignedEnd = Math.floor(nowMs / bucketMs) * bucketMs;
  const start = alignedEnd - rangeMs;
  const count = Math.floor(rangeMs / bucketMs);

  const rows = db
    .prepare(
      `SELECT
         CAST((timestamp / 1000 / ?) AS INTEGER) * ? * 1000 AS bucket_start,
         AVG(response_time_ms) AS avg_ms
       FROM checks
       WHERE service_id = ? AND timestamp >= ? AND timestamp < ?
         AND response_time_ms IS NOT NULL AND status IN ('up', 'degraded')
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
function computeStats(db, serviceId, startMs) {
  const rows = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('up', 'degraded') THEN 1 ELSE 0 END) AS ok,
         SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down,
         SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS degraded,
         AVG(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END) AS avg_ms,
         MIN(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END) AS min_ms,
         MAX(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END) AS max_ms
       FROM checks
       WHERE service_id = ? AND timestamp >= ?`
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
 * Compute 30-day rolling uptime used on cards/headers.
 */
function computeUptimePercent(db, serviceId) {
  const days = 30;
  const start = Date.now() - days * 24 * 3600 * 1000;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status IN ('up', 'degraded') THEN 1 ELSE 0 END) AS ok
       FROM checks WHERE service_id = ? AND timestamp >= ?`
    )
    .get(serviceId, start);
  if (!row.total) return null;
  return Math.round((row.ok / row.total) * 10000) / 100;
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
  computeSegments,
  computeResponseTimeseries,
  computeStats,
  computeUptimePercent,
  uptimePercent,
};
