'use strict';

const { EventEmitter } = require('events');

const NOTIFICATION_TYPES = new Set(['discord', 'email', 'telegram', 'webhook']);
const NOTIFICATION_EVENTS = new Set(['down', 'recovered', 'ssl_expiring', 'degraded']);
const SSL_COOLDOWN_MS = 24 * 3600 * 1000;
const MAX_POST_TIMEOUT_MS = 15000;

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function rowToNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: parseJson(row.config_json, {}),
    events: parseJson(row.events_json, ['down', 'recovered']),
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toPublicNotification(notification) {
  if (!notification) return null;
  const copy = { ...notification, config: { ...notification.config } };
  // Never leak credentials/webhook tokens back through the API.
  for (const key of ['webhook_url', 'bot_token', 'password', 'pass', 'username', 'user', 'from', 'to', 'chat_id']) {
    if (key in copy.config) copy.config[key] = Boolean(copy.config[key]);
  }
  copy.config._redacted = true;
  return copy;
}

function createNotificationsRepo(db) {
  const statements = {
    all: db.prepare('SELECT * FROM notifications ORDER BY id ASC'),
    byId: db.prepare('SELECT * FROM notifications WHERE id = ?'),
    insert: db.prepare(
      `INSERT INTO notifications (name, type, config_json, events_json, enabled, created_at, updated_at)
       VALUES (@name, @type, @config_json, @events_json, @enabled, @created_at, @updated_at)`
    ),
    update: db.prepare(
      `UPDATE notifications SET name = @name, type = @type, config_json = @config_json,
         events_json = @events_json, enabled = @enabled, updated_at = @updated_at
       WHERE id = @id`
    ),
    remove: db.prepare('DELETE FROM notifications WHERE id = ?'),
    logInsert: db.prepare(
      `INSERT INTO notification_log (notification_id, event_type, service_id, sent_at, success, detail_json)
       VALUES (@notification_id, @event_type, @service_id, @sent_at, @success, @detail_json)`
    ),
    recentSend: db.prepare(
      `SELECT * FROM notification_log
       WHERE notification_id = ? AND event_type = ? AND service_id IS ?
       ORDER BY sent_at DESC LIMIT 1`
    ),
  };

  return {
    list() {
      return statements.all.all().map(rowToNotification);
    },
    get(id) {
      return rowToNotification(statements.byId.get(id));
    },
    create(data) {
      const now = Date.now();
      const info = statements.insert.run({
        name: data.name,
        type: data.type,
        config_json: JSON.stringify(data.config || {}),
        events_json: JSON.stringify(data.events || ['down', 'recovered']),
        enabled: data.enabled === false ? 0 : 1,
        created_at: now,
        updated_at: now,
      });
      return this.get(info.lastInsertRowid);
    },
    update(id, patch) {
      const existing = this.get(id);
      if (!existing) return null;
      const merged = {
        name: patch.name !== undefined ? patch.name : existing.name,
        type: patch.type !== undefined ? patch.type : existing.type,
        config: patch.config !== undefined ? patch.config : existing.config,
        events: patch.events !== undefined ? patch.events : existing.events,
        enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
      };
      statements.update.run({
        id,
        name: merged.name,
        type: merged.type,
        config_json: JSON.stringify(merged.config || {}),
        events_json: JSON.stringify(merged.events || []),
        enabled: merged.enabled === false ? 0 : 1,
        updated_at: Date.now(),
      });
      return this.get(id);
    },
    remove(id) {
      return statements.remove.run(id).changes > 0;
    },
    logSend({ notificationId, eventType, serviceId, success = true, detail = null }) {
      return statements.logInsert.run({
        notification_id: notificationId,
        event_type: eventType,
        service_id: serviceId ?? null,
        sent_at: Date.now(),
        success: success ? 1 : 0,
        detail_json: detail ? JSON.stringify(detail) : null,
      }).lastInsertRowid;
    },
    recentSend(notificationId, eventType, serviceId) {
      return statements.recentSend.get(notificationId, eventType, serviceId ?? null) || null;
    },
  };
}

async function postJson(url, body, { method = 'POST', headers = {}, timeoutMs = MAX_POST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

function discordEmbed(eventType, payload) {
  const colors = { down: 0xd1554a, recovered: 0x4caf6f, degraded: 0xc99a2e, ssl_expiring: 0xc99a2e };
  const titles = {
    down: 'Monitor is DOWN',
    recovered: 'Monitor recovered',
    degraded: 'Monitor is degraded',
    ssl_expiring: 'SSL certificate expiring soon',
  };
  const fields = [];
  if (payload.target) fields.push({ name: 'Target', value: String(payload.target).slice(0, 1024), inline: false });
  if (payload.status_code != null) fields.push({ name: 'HTTP status', value: String(payload.status_code), inline: true });
  if (payload.response_time_ms != null) fields.push({ name: 'Response time', value: `${payload.response_time_ms} ms`, inline: true });
  if (payload.error_message) fields.push({ name: 'Error', value: String(payload.error_message).slice(0, 1024), inline: false });
  if (payload.incident) {
    fields.push({ name: 'Started', value: new Date(payload.incident.started_at).toISOString(), inline: true });
    if (payload.incident.duration_seconds != null) {
      fields.push({ name: 'Duration', value: `${payload.incident.duration_seconds}s`, inline: true });
    }
  }
  if (payload.days_left != null) fields.push({ name: 'Days until expiry', value: `${Math.round(payload.days_left * 10) / 10}`, inline: true });
  if (payload.cert_expires_at != null) fields.push({ name: 'Expires', value: new Date(payload.cert_expires_at).toISOString(), inline: true });

  return {
    embeds: [
      {
        title: titles[eventType] || 'Uptime Monitor alert',
        description: payload.monitor ? `**${payload.monitor}**` : undefined,
        color: colors[eventType] || 0x4f83cc,
        fields,
        timestamp: new Date(payload.timestamp).toISOString(),
        footer: { text: 'Uptime Monitor' },
      },
    ],
  };
}

function telegramText(eventType, payload) {
  const lines = [`⚠️ ${eventType.toUpperCase()}`];
  if (payload.monitor) lines.push(`**${payload.monitor}**`);
  if (payload.target) lines.push(`Target: ${payload.target}`);
  if (payload.status_code != null) lines.push(`HTTP: ${payload.status_code}`);
  if (payload.response_time_ms != null) lines.push(`Response: ${payload.response_time_ms} ms`);
  if (payload.error_message) lines.push(`Error: ${payload.error_message}`);
  if (payload.incident) {
    lines.push(`Started: ${new Date(payload.incident.started_at).toISOString()}`);
    if (payload.incident.duration_seconds != null) lines.push(`Duration: ${payload.incident.duration_seconds}s`);
  }
  if (payload.days_left != null) lines.push(`Days until expiry: ${Math.round(payload.days_left * 10) / 10}`);
  if (payload.cert_expires_at != null) lines.push(`Expires: ${new Date(payload.cert_expires_at).toISOString()}`);
  return lines.join('\n');
}

function emailBody(eventType, payload) {
  const title = `Uptime Monitor: ${eventType}`;
  const rows = [];
  const add = (k, v) => {
    if (v !== null && v !== undefined && v !== '') rows.push(`<tr><td style="padding:4px 12px 4px 0;color:#667085"><b>${k}</b></td><td>${v}</td></tr>`);
  };
  add('Monitor', payload.monitor);
  add('Target', payload.target);
  add('HTTP status', payload.status_code);
  add('Response time', payload.response_time_ms != null ? `${payload.response_time_ms} ms` : null);
  add('Error', payload.error_message);
  if (payload.incident) {
    add('Started', new Date(payload.incident.started_at).toISOString());
    if (payload.incident.duration_seconds != null) add('Duration', `${payload.incident.duration_seconds}s`);
  }
  if (payload.days_left != null) add('Days until expiry', Math.round(payload.days_left * 10) / 10);
  if (payload.cert_expires_at != null) add('Expires', new Date(payload.cert_expires_at).toISOString());
  add('Time', new Date(payload.timestamp).toISOString());
  const html = `<h2>${title}</h2><table>${rows.join('')}</table>`;
  const text = `${title}\n${rows
    .map((r) => r.replace(/<[^>]+>/g, '').replace(/<[^>]+>/g, ''))
    .join('\n')}`;
  return { title, html, text };
}

function defaultTransport(config, nodemailer) {
  return {
    async discord(cfg, payload) {
      await postJson(cfg.webhook_url, discordEmbed(payload.event, payload));
    },
    async telegram(cfg, payload) {
      await postJson(`https://api.telegram.org/bot${cfg.bot_token}/sendMessage`, {
        chat_id: cfg.chat_id,
        text: telegramText(payload.event, payload),
        parse_mode: 'Markdown',
      });
    },
    async webhook(cfg, payload) {
      await postJson(cfg.url, payload, {
        method: cfg.method || 'POST',
        headers: cfg.headers || {},
      });
    },
    async email(cfg, payload) {
      const transporter = nodemailer.createTransport({
        host: cfg.host || config.smtpHost,
        port: cfg.port || config.smtpPort,
        secure: cfg.secure !== undefined ? Boolean(cfg.secure) : config.smtpSecure,
        auth: {
          user: cfg.username || config.smtpUser,
          pass: cfg.password || config.smtpPass,
        },
      });
      const { title, html, text } = emailBody(payload.event, payload);
      await transporter.sendMail({
        from: cfg.from || config.smtpFrom || cfg.username || config.smtpUser,
        to: cfg.to,
        subject: cfg.subject || title,
        html,
        text,
      });
    },
  };
}

function buildBasePayload(service, eventType) {
  const target =
    service.type === 'http'
      ? service.url
      : service.port
        ? `${service.host}:${service.port}`
        : service.host;
  return {
    event: eventType,
    monitor: service.name,
    monitor_type: service.type || 'http',
    target,
    timestamp: Date.now(),
  };
}

class Notifier extends EventEmitter {
  constructor({ repo, servicesRepo, config, transport, nodemailer }) {
    super();
    this.repo = repo;
    this.servicesRepo = servicesRepo;
    this.config = config;
    this.transport = transport || defaultTransport(config, nodemailer || require('nodemailer'));
  }

  attach(worker) {
    worker.on('incident-opened', (incident) => {
      this.handleEvent('down', { incident }).catch((err) => {
        this.emit('error', err);
      });
    });
    worker.on('incident-resolved', (incident) => {
      this.handleEvent('recovered', { incident }).catch((err) => {
        this.emit('error', err);
      });
    });
    worker.on('ssl-expiring', (payload) => {
      this.handleEvent('ssl_expiring', payload).catch((err) => {
        this.emit('error', err);
      });
    });
    worker.on('status-change', (payload) => {
      if (payload.to === 'degraded') {
        this.handleEvent('degraded', payload).catch((err) => {
          this.emit('error', err);
        });
      }
    });
  }

  async handleEvent(eventType, source) {
    const notifications = this.repo.list().filter((n) => n.enabled && n.events.includes(eventType));
    if (notifications.length === 0) return;

    const service = this.resolveService(source);
    if (!service) return;
    const payload = this.buildPayload(service, eventType, source);
    if (!payload) return;

    for (const notification of notifications) {
      try {
        if (this.shouldDedupe(notification, eventType, service.id, source)) continue;
        await this.send(notification, payload);
        this.repo.logSend({
          notificationId: notification.id,
          eventType,
          serviceId: service.id,
          success: true,
          detail: { incidentId: source.incident ? source.incident.id : null },
        });
        this.emit('sent', { notificationId: notification.id, eventType, serviceId: service.id });
      } catch (err) {
        this.repo.logSend({
          notificationId: notification.id,
          eventType,
          serviceId: service.id,
          success: false,
          detail: { error: err.message },
        });
        this.emit('send-error', { notificationId: notification.id, eventType, error: err.message });
      }
    }
  }

  resolveService(source) {
    let serviceId;
    if (source.incident) serviceId = source.incident.service_id;
    else if (source.serviceId) serviceId = source.serviceId;
    if (!serviceId) return null;
    return this.servicesRepo.get(serviceId);
  }

  buildPayload(service, eventType, source) {
    const base = buildBasePayload(service, eventType);
    if (eventType === 'down') {
      const inc = source.incident;
      return {
        ...base,
        current_status: 'down',
        previous_status: 'up',
        error_message: inc.error_message,
        error_type: inc.error_type,
        status_code: inc.status_code,
        response_time_ms: inc.response_time_ms,
        incident: {
          id: inc.id,
          started_at: inc.started_at,
          check_count: inc.check_count,
          duration_seconds: null,
        },
      };
    }
    if (eventType === 'recovered') {
      const inc = source.incident;
      return {
        ...base,
        current_status: 'up',
        previous_status: 'down',
        incident: {
          id: inc.id,
          started_at: inc.started_at,
          ended_at: inc.ended_at,
          duration_seconds: inc.duration_seconds,
        },
      };
    }
    if (eventType === 'ssl_expiring') {
      return {
        ...base,
        days_left: source.daysLeft,
        cert_expires_at: source.expiresAt,
      };
    }
    if (eventType === 'degraded') {
      return {
        ...base,
        current_status: 'degraded',
        previous_status: source.from,
        response_time_ms: source.check ? source.check.responseTime : null,
      };
    }
    return base;
  }

  shouldDedupe(notification, eventType, serviceId, source) {
    if (eventType === 'ssl_expiring') {
      const last = this.repo.recentSend(notification.id, eventType, serviceId);
      if (last && last.success && Date.now() - last.sent_at < SSL_COOLDOWN_MS) return true;
    }
    if (eventType === 'down' || eventType === 'recovered') {
      // Edge-triggered by the worker: an incident opens/resolves exactly once.
      // A restart restores state without re-emitting, so no duplicate is sent.
      const incidentId = source.incident ? source.incident.id : null;
      if (incidentId) {
        const last = this.repo.recentSend(notification.id, eventType, serviceId);
        if (last) {
          const detail = parseJson(last.detail_json, {});
          if (detail.incidentId === incidentId) return true;
        }
      }
    }
    return false;
  }

  async send(notification, payload) {
    const fn = this.transport[notification.type];
    if (!fn) throw new Error(`Unsupported notification type: ${notification.type}`);
    await fn(notification.config, payload);
  }

  /**
   * Send a test payload (used by the "test notification" endpoint).
   */
  async test(notification) {
    const payload = {
      event: 'test',
      monitor: notification.name,
      monitor_type: 'test',
      target: 'test',
      timestamp: Date.now(),
    };
    await this.send(notification, payload);
  }
}

module.exports = {
  Notifier,
  createNotificationsRepo,
  toPublicNotification,
  rowToNotification,
  buildBasePayload,
  NOTIFICATION_TYPES,
  NOTIFICATION_EVENTS,
};
