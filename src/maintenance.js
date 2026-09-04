'use strict';

function createMaintenanceRepo(db) {
  const statements = {
    insert: db.prepare(
      `INSERT INTO maintenance_windows (service_id, started_at, ended_at, reason)
       VALUES (@service_id, @started_at, @ended_at, @reason)`
    ),
    activeForService: db.prepare(
      `SELECT * FROM maintenance_windows
       WHERE service_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at > ?)
       ORDER BY started_at DESC LIMIT 1`
    ),
    endActiveForService: db.prepare(
      `UPDATE maintenance_windows SET ended_at = ?
       WHERE service_id = ? AND started_at <= ?
         AND (ended_at IS NULL OR ended_at > ?)`
    ),
    forService: db.prepare(
      `SELECT * FROM maintenance_windows WHERE service_id = ? ORDER BY started_at DESC LIMIT ?`
    ),
    all: db.prepare(
      `SELECT mw.*, s.name AS service_name
       FROM maintenance_windows mw JOIN services s ON s.id = mw.service_id
       ORDER BY mw.started_at DESC LIMIT ?`
    ),
    remove: db.prepare('DELETE FROM maintenance_windows WHERE id = ?'),
  };

  return {
    /**
     * Open a maintenance window for a service, ending any previously open window.
     */
    start(serviceId, { startedAt = Date.now(), until = null, reason = null } = {}) {
      this.endActive(serviceId, startedAt);
      const info = statements.insert.run({
        service_id: serviceId,
        started_at: startedAt,
        ended_at: until,
        reason: reason || null,
      });
      return db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(info.lastInsertRowid);
    },
    endActive(serviceId, atMs = Date.now()) {
      statements.endActiveForService.run(atMs, serviceId, atMs, atMs);
    },
    activeForService(serviceId, atMs = Date.now()) {
      return statements.activeForService.get(serviceId, atMs, atMs) || null;
    },
    listForService(serviceId, { limit = 100 } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
      return statements.forService.all(serviceId, safeLimit);
    },
    list({ limit = 200 } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
      return statements.all.all(safeLimit);
    },
    remove(id) {
      return statements.remove.run(id).changes > 0;
    },
    /**
     * SQL fragment used by uptime/statistics queries to exclude checks that ran
     * inside a maintenance window. Intended to be embedded as:
     *   AND NOT EXISTS (SELECT 1 FROM maintenance_windows mw
     *                   WHERE <fragment>)
     */
    maintenanceExclusionSql() {
      return `mw.service_id = c.service_id
              AND mw.started_at <= c.timestamp
              AND (mw.ended_at IS NULL OR mw.ended_at > c.timestamp)`;
    },
  };
}

module.exports = { createMaintenanceRepo };
