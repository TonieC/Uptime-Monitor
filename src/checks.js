'use strict';

function createChecksRepo(db) {
  const statements = {
    insert: db.prepare(
      `INSERT INTO checks (service_id, timestamp, status, response_time_ms, status_code, error_type, error_message)
       VALUES (@service_id, @timestamp, @status, @response_time_ms, @status_code, @error_type, @error_message)`
    ),
    byService: db.prepare(
      `SELECT * FROM checks WHERE service_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`
    ),
    byServiceLatest: db.prepare(
      `SELECT * FROM checks WHERE service_id = ? ORDER BY timestamp DESC LIMIT ?`
    ),
    lastByService: db.prepare(
      `SELECT * FROM checks WHERE service_id = ? ORDER BY timestamp DESC LIMIT 1`
    ),
    inWindow: db.prepare(
      `SELECT timestamp, status, response_time_ms FROM checks
       WHERE service_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC`
    ),
    countInWindow: db.prepare(
      `SELECT COUNT(*) AS n FROM checks WHERE service_id = ? AND timestamp >= ?`
    ),
    pruneOlderThan: db.prepare('DELETE FROM checks WHERE timestamp < ?'),
  };

  return {
    insert(check) {
      return statements.insert.run({
        service_id: check.service_id,
        timestamp: check.timestamp,
        status: check.status,
        response_time_ms: check.response_time_ms ?? null,
        status_code: check.status_code ?? null,
        error_type: check.error_type ?? null,
        error_message: check.error_message ?? null,
      }).lastInsertRowid;
    },
    listForService(serviceId, { limit = 50, before = Infinity } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
      const beforeVal = Number(before) && Number(before) > 0 ? Number(before) : Infinity;
      return statements.byService.all(serviceId, beforeVal, safeLimit);
    },
    latestForService(serviceId, limit = 50) {
      const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
      return statements.byServiceLatest.all(serviceId, safeLimit);
    },
    lastForService(serviceId) {
      return statements.lastByService.get(serviceId) || null;
    },
    inWindow(serviceId, start, end) {
      return statements.inWindow.all(serviceId, start, end);
    },
    pruneOlderThan(timestamp) {
      return statements.pruneOlderThan.run(timestamp).changes;
    },
  };
}

module.exports = { createChecksRepo };
