'use strict';

const SERVICE_DEFAULTS = {
  method: 'GET',
  expected_status_codes: [200],
  interval_seconds: 60,
  timeout_ms: 10000,
  degraded_threshold_ms: null,
  enabled: true,
  confirm_failures: 2,
};

function parseCodes(str) {
  try {
    const arr = JSON.parse(str);
    return Array.isArray(arr) ? arr : [200];
  } catch {
    return [200];
  }
}

function rowToService(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method,
    expected_status_codes: parseCodes(row.expected_status_codes),
    interval_seconds: row.interval_seconds,
    timeout_ms: row.timeout_ms,
    degraded_threshold_ms: row.degraded_threshold_ms,
    enabled: Boolean(row.enabled),
    confirm_failures: row.confirm_failures,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createServiceRepo(db) {
  const statements = {
    all: db.prepare('SELECT * FROM services ORDER BY id ASC'),
    byId: db.prepare('SELECT * FROM services WHERE id = ?'),
    insert: db.prepare(
      `INSERT INTO services
        (name, url, method, expected_status_codes, interval_seconds, timeout_ms,
         degraded_threshold_ms, enabled, confirm_failures, created_at, updated_at)
       VALUES (@name, @url, @method, @expected_status_codes, @interval_seconds, @timeout_ms,
         @degraded_threshold_ms, @enabled, @confirm_failures, @created_at, @updated_at)`
    ),
    update: db.prepare(
      `UPDATE services SET
         name = @name,
         url = @url,
         method = @method,
         expected_status_codes = @expected_status_codes,
         interval_seconds = @interval_seconds,
         timeout_ms = @timeout_ms,
         degraded_threshold_ms = @degraded_threshold_ms,
         enabled = @enabled,
         confirm_failures = @confirm_failures,
         updated_at = @updated_at
       WHERE id = @id`
    ),
    remove: db.prepare('DELETE FROM services WHERE id = ?'),
  };

  function toRow(service) {
    return {
      name: service.name,
      url: service.url,
      method: service.method,
      expected_status_codes: JSON.stringify(service.expected_status_codes || [200]),
      interval_seconds: service.interval_seconds,
      timeout_ms: service.timeout_ms,
      degraded_threshold_ms: service.degraded_threshold_ms ?? null,
      enabled: service.enabled ? 1 : 0,
      confirm_failures: service.confirm_failures,
    };
  }

  return {
    list() {
      return statements.all.all().map(rowToService);
    },
    get(id) {
      return rowToService(statements.byId.get(id));
    },
    create(service) {
      const now = Date.now();
      const merged = { ...SERVICE_DEFAULTS, ...service };
      const info = statements.insert.run({
        ...toRow(merged),
        created_at: now,
        updated_at: now,
      });
      return this.get(info.lastInsertRowid);
    },
    update(id, patch) {
      const existing = this.get(id);
      if (!existing) return null;
      const merged = { ...existing, ...patch };
      statements.update.run({
        ...toRow(merged),
        id,
        updated_at: Date.now(),
      });
      return this.get(id);
    },
    remove(id) {
      return statements.remove.run(id).changes > 0;
    },
    count() {
      return db.prepare('SELECT COUNT(*) AS n FROM services').get().n;
    },
  };
}

module.exports = { createServiceRepo, rowToService, SERVICE_DEFAULTS };
