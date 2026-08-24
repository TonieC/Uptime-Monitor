'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS services (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT NOT NULL,
  url                   TEXT NOT NULL,
  method                TEXT NOT NULL DEFAULT 'GET',
  expected_status_codes TEXT NOT NULL DEFAULT '[200]',
  interval_seconds      INTEGER NOT NULL DEFAULT 60,
  timeout_ms            INTEGER NOT NULL DEFAULT 10000,
  degraded_threshold_ms INTEGER,
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
  error_message   TEXT
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
  error_message   TEXT,
  check_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_incidents_service_started ON incidents (service_id, started_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

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

function initSettings(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
  if (!row) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  }
}

function createDb(opts) {
  const db = openDatabase(opts && opts.dbPath ? opts.dbPath : config.dbPath);
  initSettings(db);
  return db;
}

module.exports = { createDb, SCHEMA_VERSION };
