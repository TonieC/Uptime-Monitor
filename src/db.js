'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS services (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT NOT NULL,
  url                   TEXT NOT NULL,
  type                  TEXT NOT NULL DEFAULT 'http',
  host                  TEXT,
  port                  INTEGER,
  expected_ip           TEXT,
  method                TEXT NOT NULL DEFAULT 'GET',
  expected_status_codes TEXT NOT NULL DEFAULT '[200]',
  interval_seconds      INTEGER NOT NULL DEFAULT 60,
  timeout_ms            INTEGER NOT NULL DEFAULT 10000,
  degraded_threshold_ms INTEGER,
  headers               TEXT,
  auth_username         TEXT,
  auth_password         TEXT,
  user_agent            TEXT,
  follow_redirects      INTEGER NOT NULL DEFAULT 1,
  expected_keyword      TEXT,
  forbidden_keyword     TEXT,
  keyword_case_sensitive INTEGER NOT NULL DEFAULT 0,
  retries               INTEGER NOT NULL DEFAULT 0,
  retry_delay_ms        INTEGER NOT NULL DEFAULT 1000,
  recovery_threshold    INTEGER NOT NULL DEFAULT 1,
  check_certificate     INTEGER NOT NULL DEFAULT 1,
  ssl_expiry_threshold_days INTEGER NOT NULL DEFAULT 14,
  enabled               INTEGER NOT NULL DEFAULT 1,
  confirm_failures      INTEGER NOT NULL DEFAULT 2,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id      INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  timestamp       INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('up', 'degraded', 'down')),
  response_time_ms INTEGER,
  status_code     INTEGER,
  error_type      TEXT,
  error_message   TEXT,
  packet_loss     REAL,
  cert_expires_at INTEGER,
  cert_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_checks_service_timestamp ON checks (service_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_checks_timestamp ON checks (timestamp);

CREATE TABLE IF NOT EXISTS incidents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id      INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration_seconds INTEGER,
  status_code     INTEGER,
  error_type      TEXT,
  error_message   TEXT,
  response_time_ms INTEGER,
  reason          TEXT,
  check_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_incidents_service_started ON incidents (service_id, started_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  reason     TEXT
);

CREATE INDEX IF NOT EXISTS idx_mw_service_started ON maintenance_windows (service_id, started_at);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  events_json TEXT NOT NULL DEFAULT '["down","recovered"]',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  service_id      INTEGER,
  sent_at         INTEGER NOT NULL,
  success         INTEGER NOT NULL DEFAULT 1,
  detail_json     TEXT
);

CREATE INDEX IF NOT EXISTS idx_nl_dedup ON notification_log (notification_id, event_type, service_id);

CREATE TABLE IF NOT EXISTS status_pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  description   TEXT,
  branding_json TEXT NOT NULL DEFAULT '{}',
  is_public     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS status_page_monitors (
  status_page_id INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  service_id     INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (status_page_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_spm_service ON status_page_monitors (service_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
`;

const COLUMNS_BY_TABLE = {
  services: {
    type: "ALTER TABLE services ADD COLUMN type TEXT NOT NULL DEFAULT 'http'",
    host: 'ALTER TABLE services ADD COLUMN host TEXT',
    port: 'ALTER TABLE services ADD COLUMN port INTEGER',
    expected_ip: 'ALTER TABLE services ADD COLUMN expected_ip TEXT',
    headers: 'ALTER TABLE services ADD COLUMN headers TEXT',
    auth_username: 'ALTER TABLE services ADD COLUMN auth_username TEXT',
    auth_password: 'ALTER TABLE services ADD COLUMN auth_password TEXT',
    user_agent: 'ALTER TABLE services ADD COLUMN user_agent TEXT',
    follow_redirects: 'ALTER TABLE services ADD COLUMN follow_redirects INTEGER NOT NULL DEFAULT 1',
    expected_keyword: 'ALTER TABLE services ADD COLUMN expected_keyword TEXT',
    forbidden_keyword: 'ALTER TABLE services ADD COLUMN forbidden_keyword TEXT',
    keyword_case_sensitive: 'ALTER TABLE services ADD COLUMN keyword_case_sensitive INTEGER NOT NULL DEFAULT 0',
    retries: 'ALTER TABLE services ADD COLUMN retries INTEGER NOT NULL DEFAULT 0',
    retry_delay_ms: 'ALTER TABLE services ADD COLUMN retry_delay_ms INTEGER NOT NULL DEFAULT 1000',
    recovery_threshold: 'ALTER TABLE services ADD COLUMN recovery_threshold INTEGER NOT NULL DEFAULT 1',
    check_certificate: 'ALTER TABLE services ADD COLUMN check_certificate INTEGER NOT NULL DEFAULT 1',
    ssl_expiry_threshold_days: 'ALTER TABLE services ADD COLUMN ssl_expiry_threshold_days INTEGER NOT NULL DEFAULT 14',
  },
  checks: {
    packet_loss: 'ALTER TABLE checks ADD COLUMN packet_loss REAL',
    cert_expires_at: 'ALTER TABLE checks ADD COLUMN cert_expires_at INTEGER',
    cert_error: 'ALTER TABLE checks ADD COLUMN cert_error TEXT',
  },
  incidents: {
    error_type: 'ALTER TABLE incidents ADD COLUMN error_type TEXT',
    response_time_ms: 'ALTER TABLE incidents ADD COLUMN response_time_ms INTEGER',
    reason: 'ALTER TABLE incidents ADD COLUMN reason TEXT',
  },
};

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(ddl);
  }
}

function migrateToV2(db) {
  // ALTER TABLE columns (only applied when the column is missing so both fresh
  // databases and existing v1 installations upgrade safely).
  for (const [table, columns] of Object.entries(COLUMNS_BY_TABLE)) {
    for (const [column, ddl] of Object.entries(columns)) {
      ensureColumn(db, table, column, ddl);
    }
  }
}

function setVersion(db, version) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(version));
}

function getVersion(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
  return row ? Number(row.value) : 0;
}

function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

function migrate(db) {
  const version = getVersion(db);
  if (version < 2) {
    migrateToV2(db);
  }
  setVersion(db, SCHEMA_VERSION);
}

function createDb(opts) {
  const db = openDatabase(opts && opts.dbPath ? opts.dbPath : config.dbPath);
  migrate(db);
  return db;
}

module.exports = { createDb, SCHEMA_VERSION };
