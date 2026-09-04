'use strict';

const path = require('path');

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < (min || 1)) return fallback;
  if (max !== undefined && n > max) return fallback;
  return n;
}

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: parsePositiveInt(process.env.PORT, 3000, 1, 65535),
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
  dbFile: process.env.DB_FILE || '',
  adminUser: process.env.ADMIN_USER || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  allowPrivateNetworks: parseBool(process.env.ALLOW_PRIVATE_NETWORKS, false),
  checkRetentionDays: parsePositiveInt(process.env.CHECK_RETENTION_DAYS, 90, 1, 3650),
  checkRetentionIntervalMinutes: parsePositiveInt(
    process.env.CHECK_RETENTION_INTERVAL_MINUTES, 60, 1, 1440
  ),
  // Optional SMTP defaults used by email notifications. Per-notification
  // settings override these when set.
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parsePositiveInt(process.env.SMTP_PORT, 587, 1, 65535),
  smtpSecure: parseBool(process.env.SMTP_SECURE, false),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || '',
  nodeEnv: process.env.NODE_ENV || 'development',
};

config.authEnabled = Boolean(config.adminUser && config.adminPassword);
config.dbPath = config.dbFile || path.join(config.dataDir, 'uptime.db');

module.exports = config;
