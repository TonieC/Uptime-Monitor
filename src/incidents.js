'use strict';

function createIncidentsRepo(db) {
  const statements = {
    insert: db.prepare(
      `INSERT INTO incidents (service_id, started_at, ended_at, duration_seconds, status_code, error_type, error_message, response_time_ms, reason, check_count)
       VALUES (@service_id, @started_at, @ended_at, @duration_seconds, @status_code, @error_type, @error_message, @response_time_ms, @reason, @check_count)`
    ),
    openForService: db.prepare(
      `SELECT * FROM incidents WHERE service_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
    ),
    updateOpen: db.prepare(
      `UPDATE incidents SET check_count = @check_count, status_code = @status_code,
         error_type = @error_type, error_message = @error_message,
         response_time_ms = @response_time_ms, reason = @reason,
         duration_seconds = @duration_seconds
       WHERE id = @id AND ended_at IS NULL`
    ),
    resolve: db.prepare(
      `UPDATE incidents SET ended_at = @ended_at, duration_seconds = @duration_seconds WHERE id = @id`
    ),
    byService: db.prepare(
      `SELECT * FROM incidents WHERE service_id = ? ORDER BY started_at DESC LIMIT ?`
    ),
    allRecent: db.prepare(
      `SELECT i.*, s.name AS service_name, s.url AS service_url
       FROM incidents i JOIN services s ON s.id = i.service_id
       ORDER BY i.started_at DESC LIMIT ?`
    ),
    allRecentForService: db.prepare(
      `SELECT i.*, s.name AS service_name, s.url AS service_url
       FROM incidents i JOIN services s ON s.id = i.service_id
       WHERE i.service_id = ? ORDER BY i.started_at DESC LIMIT ?`
    ),
    countOpen: db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE ended_at IS NULL'),
    countInWindow: db.prepare(
      `SELECT COUNT(*) AS n FROM incidents WHERE service_id = ? AND started_at >= ?`
    ),
    totalDowntimeInWindow: db.prepare(
      `SELECT COALESCE(SUM(duration_seconds), 0) AS total
       FROM incidents
       WHERE service_id = ? AND ended_at IS NOT NULL AND started_at >= ?`
    ),
  };

  return {
    create(data) {
      const info = statements.insert.run({
        service_id: data.service_id,
        started_at: data.started_at,
        ended_at: null,
        duration_seconds: null,
        status_code: data.status_code ?? null,
        error_type: data.error_type ?? null,
        error_message: data.error_message ?? null,
        response_time_ms: data.response_time_ms ?? null,
        reason: data.reason ?? null,
        check_count: data.check_count ?? 1,
      });
      return db.prepare('SELECT * FROM incidents WHERE id = ?').get(info.lastInsertRowid);
    },
    openForService(serviceId) {
      return statements.openForService.get(serviceId) || null;
    },
    recordFailure(id, { status_code, error_type, error_message, response_time_ms, reason, duration_seconds, check_count }) {
      statements.updateOpen.run({
        id,
        status_code: status_code ?? null,
        error_type: error_type ?? null,
        error_message: error_message ?? null,
        response_time_ms: response_time_ms ?? null,
        reason: reason ?? null,
        duration_seconds: duration_seconds ?? null,
        check_count,
      });
    },
    resolve(id, atMs) {
      const started = db.prepare('SELECT started_at FROM incidents WHERE id = ?').get(id);
      if (!started) return null;
      const durationSeconds = Math.round((atMs - started.started_at) / 1000);
      statements.resolve.run({ id, ended_at: atMs, duration_seconds: durationSeconds });
      return db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
    },
    listForService(serviceId, { limit = 100 } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
      return statements.byService.all(serviceId, safeLimit);
    },
    listRecent({ limit = 100 } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
      return statements.allRecent.all(safeLimit);
    },
    listRecentForService(serviceId, { limit = 100 } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
      return statements.allRecentForService.all(serviceId, safeLimit);
    },
    countOpenIncidents() {
      return statements.countOpen.get().n;
    },
    countInWindow(serviceId, startMs) {
      return statements.countInWindow.get(serviceId, startMs).n;
    },
    totalDowntimeInWindow(serviceId, startMs) {
      return statements.totalDowntimeInWindow.get(serviceId, startMs).total;
    },
  };
}

module.exports = { createIncidentsRepo };
