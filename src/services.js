'use strict';

const SERVICE_DEFAULTS = {
  type: 'http',
  method: 'GET',
  expected_status_codes: [200],
  interval_seconds: 60,
  timeout_ms: 10000,
  degraded_threshold_ms: null,
  follow_redirects: true,
  keyword_case_sensitive: false,
  retries: 0,
  retry_delay_ms: 1000,
  recovery_threshold: 1,
  check_certificate: true,
  ssl_expiry_threshold_days: 14,
  enabled: true,
  confirm_failures: 2,
};

const MONITOR_TYPES = new Set(['http', 'ping', 'tcp', 'dns']);

function parseCodes(str) {
  try {
    const arr = JSON.parse(str);
    return Array.isArray(arr) ? arr : [200];
  } catch {
    return [200];
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function rowToService(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    type: row.type || 'http',
    host: row.host,
    port: row.port,
    expected_ip: row.expected_ip,
    method: row.method,
    expected_status_codes: parseCodes(row.expected_status_codes),
    interval_seconds: row.interval_seconds,
    timeout_ms: row.timeout_ms,
    degraded_threshold_ms: row.degraded_threshold_ms,
    headers: parseJson(row.headers, null),
    auth_username: row.auth_username,
    auth_password: row.auth_password,
    user_agent: row.user_agent,
    follow_redirects: Boolean(row.follow_redirects),
    expected_keyword: row.expected_keyword,
    forbidden_keyword: row.forbidden_keyword,
    keyword_case_sensitive: Boolean(row.keyword_case_sensitive),
    retries: row.retries,
    retry_delay_ms: row.retry_delay_ms,
    recovery_threshold: row.recovery_threshold,
    check_certificate: Boolean(row.check_certificate),
    ssl_expiry_threshold_days: row.ssl_expiry_threshold_days,
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
        (name, url, type, host, port, expected_ip, method, expected_status_codes,
         interval_seconds, timeout_ms, degraded_threshold_ms, headers,
         auth_username, auth_password, user_agent, follow_redirects,
         expected_keyword, forbidden_keyword, keyword_case_sensitive,
         retries, retry_delay_ms, recovery_threshold, check_certificate,
         ssl_expiry_threshold_days, enabled, confirm_failures, created_at, updated_at)
       VALUES (@name, @url, @type, @host, @port, @expected_ip, @method,
         @expected_status_codes, @interval_seconds, @timeout_ms,
         @degraded_threshold_ms, @headers, @auth_username, @auth_password,
         @user_agent, @follow_redirects, @expected_keyword, @forbidden_keyword,
         @keyword_case_sensitive, @retries, @retry_delay_ms, @recovery_threshold,
         @check_certificate, @ssl_expiry_threshold_days, @enabled,
         @confirm_failures, @created_at, @updated_at)`
    ),
    update: db.prepare(
      `UPDATE services SET
         name = @name,
         url = @url,
         type = @type,
         host = @host,
         port = @port,
         expected_ip = @expected_ip,
         method = @method,
         expected_status_codes = @expected_status_codes,
         interval_seconds = @interval_seconds,
         timeout_ms = @timeout_ms,
         degraded_threshold_ms = @degraded_threshold_ms,
         headers = @headers,
         auth_username = @auth_username,
         auth_password = @auth_password,
         user_agent = @user_agent,
         follow_redirects = @follow_redirects,
         expected_keyword = @expected_keyword,
         forbidden_keyword = @forbidden_keyword,
         keyword_case_sensitive = @keyword_case_sensitive,
         retries = @retries,
         retry_delay_ms = @retry_delay_ms,
         recovery_threshold = @recovery_threshold,
         check_certificate = @check_certificate,
         ssl_expiry_threshold_days = @ssl_expiry_threshold_days,
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
      type: service.type || 'http',
      host: service.host ?? null,
      port: service.port ?? null,
      expected_ip: service.expected_ip ?? null,
      method: service.method,
      expected_status_codes: JSON.stringify(service.expected_status_codes || [200]),
      interval_seconds: service.interval_seconds,
      timeout_ms: service.timeout_ms,
      degraded_threshold_ms: service.degraded_threshold_ms ?? null,
      headers: service.headers && Object.keys(service.headers).length > 0
        ? JSON.stringify(service.headers)
        : null,
      auth_username: service.auth_username || null,
      auth_password: service.auth_password || null,
      user_agent: service.user_agent || null,
      follow_redirects: service.follow_redirects === false ? 0 : 1,
      expected_keyword: service.expected_keyword || null,
      forbidden_keyword: service.forbidden_keyword || null,
      keyword_case_sensitive: service.keyword_case_sensitive ? 1 : 0,
      retries: service.retries,
      retry_delay_ms: service.retry_delay_ms,
      recovery_threshold: service.recovery_threshold,
      check_certificate: service.check_certificate === false ? 0 : 1,
      ssl_expiry_threshold_days: service.ssl_expiry_threshold_days,
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

/**
 * Public (safe) representation of a service. Secrets such as auth passwords and
 * stored notification/webhook credentials must never be exposed through the API.
 */
function toPublicService(service) {
  if (!service) return null;
  const copy = { ...service };
  delete copy.auth_password;
  return copy;
}

module.exports = {
  createServiceRepo,
  rowToService,
  toPublicService,
  SERVICE_DEFAULTS,
  MONITOR_TYPES,
};
