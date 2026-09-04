'use strict';

const express = require('express');
const { validateServiceInput } = require('./validation');
const { toPublicNotification } = require('./notifications');
const {
  computeSegments,
  computeResponseTimeseries,
  computeStats,
  computeIncidentStats,
  computeUptimePercent,
  computeGlobalStats,
  VALID_RANGES,
  RANGE_WINDOWS,
} = require('./uptime');

const CHECK_WINDOWS = {
  '24h': 24 * 3600 * 1000,
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
};

function err(status, message, code) {
  return { status, body: { error: { message, code } } };
}

function handle(res, result) {
  if (result.status !== 200) {
    return res.status(result.status).json(result.body);
  }
  return res.json(result.body);
}

function parseRange(queryRange) {
  return VALID_RANGES.has(queryRange) ? queryRange : '24h';
}

function createApi({
  db,
  servicesRepo,
  checksRepo,
  incidentsRepo,
  maintenanceRepo,
  notificationsRepo,
  statusPagesRepo,
  apiKeysRepo,
  notifier,
  worker,
  config,
}) {
  const router = express.Router();

  function getService(req, res) {
    const id = Number(req.params.id);
    const service = Number.isInteger(id) ? servicesRepo.get(id) : null;
    if (!service) return err(404, 'Service not found', 'not_found');
    return service;
  }

  function serviceStatus(service, lastCheck) {
    if (!service.enabled) return 'unknown';
    if (maintenanceRepo && maintenanceRepo.activeForService(service.id)) return 'maintenance';
    return lastCheck ? lastCheck.status : 'unknown';
  }

  function enrichService(service) {
    const lastCheck = checksRepo.lastForService(service.id);
    const uptimePercent30d = computeUptimePercent(db, service.id);
    const incidentCount = incidentsRepo.listForService(service.id, { limit: 500 }).length;
    return {
      ...service,
      status: serviceStatus(service, lastCheck),
      last_check: lastCheck,
      uptime_percent_30d: uptimePercent30d,
      incident_count: incidentCount,
    };
  }

  // ---------------------------------------------------------------------------
  // Health & session
  // ---------------------------------------------------------------------------

  router.get('/health', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', uptime: process.uptime(), version: 2 });
    } catch {
      res.status(503).json({ status: 'error' });
    }
  });

  router.get('/session', (req, res) => {
    res.json({
      auth_enabled: config.authEnabled,
      api_key_auth: Boolean(apiKeysRepo && apiKeysRepo.list().length > 0),
      ws_token: req.wsToken,
    });
  });

  // ---------------------------------------------------------------------------
  // Public status page data (no authentication required)
  // ---------------------------------------------------------------------------

  router.get('/public/status/:slug', (req, res) => {
    const page = statusPagesRepo.getBySlug(req.params.slug);
    if (!page) return handle(res, err(404, 'Status page not found', 'not_found'));
    if (!page.is_public) return handle(res, err(404, 'Status page not found', 'not_found'));

    const monitorIds = statusPagesRepo.getMonitorIds(page.id);
    const monitors = [];
    for (const id of monitorIds) {
      const service = servicesRepo.get(id);
      if (!service || !service.enabled) continue;
      const lastCheck = checksRepo.lastForService(service.id);
      monitors.push({
        id: service.id,
        name: service.name,
        type: service.type || 'http',
        target: service.url || (service.port ? `${service.host}:${service.port}` : service.host),
        status: serviceStatus(service, lastCheck),
        last_check: lastCheck,
        uptime_24h: computeUptimePercent(db, service.id, { days: 1 }),
        uptime_30d: computeUptimePercent(db, service.id, { days: 30 }),
        uptime_90d: computeUptimePercent(db, service.id, { days: 90 }),
        avg_response_ms_24h: avgResponseMs(db, service.id, Date.now() - 24 * 3600 * 1000),
      });
    }

    const recentIncidents = [];
    for (const id of monitorIds) {
      const service = servicesRepo.get(id);
      if (!service || !service.enabled) continue;
      for (const inc of incidentsRepo.listForService(id, { limit: 5 })) {
        recentIncidents.push({
          ...inc,
          monitor_name: service.name,
          monitor_id: id,
        });
      }
    }
    recentIncidents.sort((a, b) => b.started_at - a.started_at);
    const allUp = monitors.every((m) => m.status === 'up');

    res.json({
      slug: page.slug,
      title: page.title,
      description: page.description,
      branding: page.branding,
      overall_status: monitors.length === 0 ? 'unknown' : allUp ? 'up' : 'issues',
      monitors,
      incidents: recentIncidents.slice(0, 20),
      updated_at: Date.now(),
    });
  });

  function avgResponseMs(db, serviceId, startMs) {
    const row = db
      .prepare(
        `SELECT AVG(response_time_ms) AS avg_ms FROM checks
         WHERE service_id = ? AND timestamp >= ? AND response_time_ms IS NOT NULL`
      )
      .get(serviceId, startMs);
    return row.avg_ms == null ? null : Math.round(row.avg_ms);
  }

  // ---------------------------------------------------------------------------
  // Summary & global statistics
  // ---------------------------------------------------------------------------

  router.get('/summary', (req, res) => {
    const services = servicesRepo.list();
    const total = services.length;
    let up = 0;
    let degraded = 0;
    let down = 0;
    let unknown = 0;
    for (const s of services) {
      const last = checksRepo.lastForService(s.id);
      const status = serviceStatus(s, last);
      if (status === 'up') up += 1;
      else if (status === 'degraded') degraded += 1;
      else if (status === 'down') down += 1;
      else unknown += 1;
    }
    res.json({
      services_total: total,
      services_up: up,
      services_degraded: degraded,
      services_down: down,
      services_unknown: unknown,
      incidents_open: incidentsRepo.countOpenIncidents(),
      checks_total: db.prepare('SELECT COUNT(*) AS n FROM checks').get().n,
    });
  });

  router.get('/statistics', (req, res) => {
    const range = parseRange(req.query.range);
    const start = Date.now() - RANGE_WINDOWS[range];
    const global = computeGlobalStats(db, start);
    res.json({ range, start, ...global });
  });

  // ---------------------------------------------------------------------------
  // Services & monitors (aliases)
  // ---------------------------------------------------------------------------

  router.get('/services', (req, res) => {
    res.json(servicesRepo.list().map(enrichService));
  });
  router.get('/monitors', (req, res) => {
    res.json(servicesRepo.list().map(enrichService));
  });

  router.post('/services', async (req, res) => {
    await createService(req, res);
  });
  router.post('/monitors', async (req, res) => {
    await createService(req, res);
  });

  async function createService(req, res) {
    const { errors, value } = await validateServiceInput(req.body, {
      allowPrivateNetworks: config.allowPrivateNetworks,
    });
    if (errors.length > 0) {
      return handle(res, err(400, errors.join('; '), 'validation_error'));
    }
    try {
      const service = servicesRepo.create(value);
      worker.syncService(service);
      worker.emit('service-changed', { service, action: 'created' });
      return res.status(201).json(enrichService(service));
    } catch (e) {
      return handle(res, err(500, 'Could not create service', 'internal_error'));
    }
  }

  router.get('/services/:id', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    res.json(enrichService(service));
  });
  router.get('/monitors/:id', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    res.json(enrichService(service));
  });

  router.put('/services/:id', async (req, res) => {
    await updateService(req, res);
  });
  router.put('/monitors/:id', async (req, res) => {
    await updateService(req, res);
  });

  async function updateService(req, res) {
    const service = getService(req, res);
    if (service.status) return handle(res, service);

    const { errors, value } = await validateServiceInput(req.body, {
      allowPrivateNetworks: config.allowPrivateNetworks,
      partial: true,
    });
    if (errors.length > 0) {
      return handle(res, err(400, errors.join('; '), 'validation_error'));
    }
    const updated = servicesRepo.update(service.id, value);
    if (!updated) return handle(res, err(404, 'Service not found', 'not_found'));
    worker.syncService(updated);
    worker.emit('service-changed', { service: updated, action: 'updated' });
    res.json(enrichService(updated));
  }

  router.delete('/services/:id', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    worker.removeService(service.id);
    servicesRepo.remove(service.id);
    worker.emit('service-deleted', { serviceId: service.id });
    res.status(204).end();
  });
  router.delete('/monitors/:id', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    worker.removeService(service.id);
    servicesRepo.remove(service.id);
    worker.emit('service-deleted', { serviceId: service.id });
    res.status(204).end();
  });

  router.post('/services/:id/check', async (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    try {
      const result = await worker.runService(service, { reschedule: false });
      res.json({ check: result });
    } catch (e) {
      handle(res, err(500, 'Check failed', 'internal_error'));
    }
  });
  router.post('/monitors/:id/check', async (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    try {
      const result = await worker.runService(service, { reschedule: false });
      res.json({ check: result });
    } catch (e) {
      handle(res, err(500, 'Check failed', 'internal_error'));
    }
  });

  router.get('/services/:id/checks', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const before = Number(req.query.before) || undefined;
    const checks = checksRepo.listForService(service.id, { limit, before });
    res.json({ checks, total: checks.length });
  });
  router.get('/monitors/:id/checks', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const before = Number(req.query.before) || undefined;
    const checks = checksRepo.listForService(service.id, { limit, before });
    res.json({ checks, total: checks.length });
  });

  router.get('/services/:id/incidents', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ incidents: incidentsRepo.listForService(service.id, { limit }) });
  });
  router.get('/monitors/:id/incidents', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ incidents: incidentsRepo.listForService(service.id, { limit }) });
  });

  router.get('/services/:id/uptime', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    const range = parseRange(req.query.range);
    const windowMs = RANGE_WINDOWS[range];
    const segments = computeSegments(db, checksRepo, service.id, range);
    const timeseries = computeResponseTimeseries(db, service.id, range);
    const stats = computeStats(db, service.id, Date.now() - windowMs);
    const lastCheck = checksRepo.lastForService(service.id);
    res.json({
      service_id: service.id,
      range,
      segments: segments.segments,
      window: { start: segments.start, end: segments.end, segmentSeconds: segments.segmentSeconds },
      timeseries,
      stats,
      last_check: lastCheck,
    });
  });
  router.get('/monitors/:id/uptime', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    const range = parseRange(req.query.range);
    const windowMs = RANGE_WINDOWS[range];
    const segments = computeSegments(db, checksRepo, service.id, range);
    const timeseries = computeResponseTimeseries(db, service.id, range);
    const stats = computeStats(db, service.id, Date.now() - windowMs);
    const lastCheck = checksRepo.lastForService(service.id);
    res.json({
      service_id: service.id,
      range,
      segments: segments.segments,
      window: { start: segments.start, end: segments.end, segmentSeconds: segments.segmentSeconds },
      timeseries,
      stats,
      last_check: lastCheck,
    });
  });

  // ---------------------------------------------------------------------------
  // Monitor status & statistics
  // ---------------------------------------------------------------------------

  router.get('/monitors/:id/status', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    const lastCheck = checksRepo.lastForService(service.id);
    const currentIncident = incidentsRepo.openForService(service.id);
    res.json({
      service_id: service.id,
      status: serviceStatus(service, lastCheck),
      last_check: lastCheck,
      open_incident: currentIncident,
      uptime_percent_24h: computeUptimePercent(db, service.id, { days: 1 }),
      uptime_percent_7d: computeUptimePercent(db, service.id, { days: 7 }),
      uptime_percent_30d: computeUptimePercent(db, service.id, { days: 30 }),
    });
  });

  router.get('/monitors/:id/statistics', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    const range = parseRange(req.query.range);
    const windowMs = RANGE_WINDOWS[range];
    const start = Date.now() - windowMs;
    const stats = computeStats(db, service.id, start);
    const incidentStats = computeIncidentStats(db, incidentsRepo, service.id, start);
    res.json({
      service_id: service.id,
      range,
      window: { start, end: Date.now() },
      stats,
      incident_stats: incidentStats,
      uptime_percent: stats.uptime_percent,
      incident_uptime_percent: incidentStats.uptime_percent,
    });
  });

  // ---------------------------------------------------------------------------
  // Incidents
  // ---------------------------------------------------------------------------

  router.get('/incidents', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ incidents: incidentsRepo.listRecent({ limit }) });
  });

  router.get('/incidents/:id', (req, res) => {
    const id = Number(req.params.id);
    const incident = Number.isInteger(id) ? db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) : null;
    if (!incident) return handle(res, err(404, 'Incident not found', 'not_found'));
    const service = servicesRepo.get(incident.service_id);
    res.json({ incident: { ...incident, monitor: service ? { id: service.id, name: service.name } : null } });
  });

  // ---------------------------------------------------------------------------
  // Maintenance mode
  // ---------------------------------------------------------------------------

  router.get('/maintenance', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const windows = maintenanceRepo.list({ limit });
    res.json({ maintenance: windows });
  });

  router.get('/monitors/:id/maintenance', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ maintenance: maintenanceRepo.listForService(service.id, { limit }) });
  });
  router.get('/services/:id/maintenance', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ maintenance: maintenanceRepo.listForService(service.id, { limit }) });
  });

  router.post('/maintenance', (req, res) => {
    const serviceId = Number(req.body.service_id);
    const service = Number.isInteger(serviceId) ? servicesRepo.get(serviceId) : null;
    if (!service) return handle(res, err(400, 'service_id is required and must reference an existing monitor', 'validation_error'));
    const until = req.body.until !== undefined && req.body.until !== null ? Number(req.body.until) : null;
    if (until !== null && (!Number.isFinite(until) || until <= Date.now())) {
      return handle(res, err(400, 'until must be a future timestamp in milliseconds', 'validation_error'));
    }
    const reason = typeof req.body.reason === 'string' ? req.body.reason.slice(0, 500) : null;
    const window = maintenanceRepo.start(serviceId, { until, reason });
    worker.emit('service-changed', { service, action: 'maintenance' });
    res.status(201).json({ maintenance: window });
  });

  router.post('/maintenance/:id/end', (req, res) => {
    const id = Number(req.params.id);
    const window = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id);
    if (!window) return handle(res, err(404, 'Maintenance window not found', 'not_found'));
    maintenanceRepo.endActive(window.service_id, Date.now());
    const service = servicesRepo.get(window.service_id);
    if (service) worker.emit('service-changed', { service, action: 'maintenance-end' });
    res.json({ maintenance: maintenanceRepo.listForService(window.service_id, { limit: 1 })[0] });
  });

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  router.get('/notifications', (req, res) => {
    res.json({ notifications: notificationsRepo.list().map(toPublicNotification) });
  });

  router.post('/notifications', (req, res) => {
    const body = req.body || {};
    const errors = [];
    if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.length > 200) {
      errors.push('name must be 1-200 characters');
    }
    if (!['discord', 'email', 'telegram', 'webhook'].includes(body.type)) {
      errors.push('type must be one of discord, email, telegram, webhook');
    }
    const configObj = body.config && typeof body.config === 'object' ? body.config : {};
    const type = body.type;
    if (type === 'discord' && (typeof configObj.webhook_url !== 'string' || !configObj.webhook_url.startsWith('https://'))) {
      errors.push('config.webhook_url must be an https URL');
    }
    if (type === 'telegram' && (typeof configObj.bot_token !== 'string' || !configObj.bot_token) && typeof configObj.chat_id !== 'string') {
      errors.push('telegram requires config.bot_token and config.chat_id');
    }
    if (type === 'email' && (typeof configObj.to !== 'string' || !configObj.to)) {
      errors.push('config.to is required for email notifications');
    }
    if (type === 'webhook' && (typeof configObj.url !== 'string' || !/^https?:\/\//.test(configObj.url))) {
      errors.push('config.url must be an http(s) URL');
    }
    const events = body.events;
    const validEvents = ['down', 'recovered', 'ssl_expiring', 'degraded'];
    if (events !== undefined) {
      if (!Array.isArray(events) || events.length === 0 || events.some((e) => !validEvents.includes(e))) {
        errors.push(`events must be a non-empty subset of ${validEvents.join(', ')}`);
      }
    }
    if (errors.length > 0) return handle(res, err(400, errors.join('; '), 'validation_error'));
    const created = notificationsRepo.create({
      name: body.name.trim(),
      type,
      config: configObj,
      events: events || ['down', 'recovered'],
      enabled: body.enabled === undefined ? true : body.enabled,
    });
    res.status(201).json({ notification: toPublicNotification(created) });
  });

  router.put('/notifications/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = notificationsRepo.get(id);
    if (!existing) return handle(res, err(404, 'Notification not found', 'not_found'));
    const body = req.body || {};
    const updated = notificationsRepo.update(id, {
      name: body.name,
      type: body.type,
      config: body.config,
      events: body.events,
      enabled: body.enabled,
    });
    res.json({ notification: toPublicNotification(updated) });
  });

  router.delete('/notifications/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!notificationsRepo.remove(id)) return handle(res, err(404, 'Notification not found', 'not_found'));
    res.status(204).end();
  });

  router.post('/notifications/:id/test', async (req, res) => {
    const id = Number(req.params.id);
    const notification = notificationsRepo.get(id);
    if (!notification) return handle(res, err(404, 'Notification not found', 'not_found'));
    if (!notifier) return handle(res, err(500, 'Notifier is not configured', 'internal_error'));
    try {
      await notifier.test(notification);
      res.json({ ok: true, message: 'Test notification sent' });
    } catch (e) {
      res.status(502).json({ ok: false, error: { message: e.message } });
    }
  });

  // ---------------------------------------------------------------------------
  // Status pages
  // ---------------------------------------------------------------------------

  router.get('/status-pages', (req, res) => {
    const pages = statusPagesRepo.list().map((page) => ({
      ...page,
      monitor_ids: statusPagesRepo.getMonitorIds(page.id),
    }));
    res.json({ status_pages: pages });
  });

  router.post('/status-pages', (req, res) => {
    const body = req.body || {};
    const { errors, value } = statusPagesRepo.validate(body, { requireCore: true });
    if (errors.length > 0) return handle(res, err(400, errors.join('; '), 'validation_error'));
    if (statusPagesRepo.getBySlug(value.slug)) {
      return handle(res, err(400, 'slug already exists', 'conflict'));
    }
    if (value.monitor_ids) {
      for (const sid of value.monitor_ids) {
        if (!servicesRepo.get(sid)) {
          return handle(res, err(400, `monitor id ${sid} does not exist`, 'validation_error'));
        }
      }
    }
    const page = statusPagesRepo.create(value);
    res.status(201).json({ status_page: { ...page, monitor_ids: statusPagesRepo.getMonitorIds(page.id) } });
  });

  router.put('/status-pages/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = statusPagesRepo.get(id);
    if (!existing) return handle(res, err(404, 'Status page not found', 'not_found'));
    const body = req.body || {};
    const { errors, value } = statusPagesRepo.validate(body);
    if (errors.length > 0) return handle(res, err(400, errors.join('; '), 'validation_error'));
    if (value.slug && value.slug !== existing.slug && statusPagesRepo.getBySlug(value.slug)) {
      return handle(res, err(400, 'slug already exists', 'conflict'));
    }
    if (value.monitor_ids) {
      for (const sid of value.monitor_ids) {
        if (!servicesRepo.get(sid)) {
          return handle(res, err(400, `monitor id ${sid} does not exist`, 'validation_error'));
        }
      }
    }
    const page = statusPagesRepo.update(id, value);
    res.json({ status_page: { ...page, monitor_ids: statusPagesRepo.getMonitorIds(page.id) } });
  });

  router.delete('/status-pages/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!statusPagesRepo.remove(id)) return handle(res, err(404, 'Status page not found', 'not_found'));
    res.status(204).end();
  });

  // ---------------------------------------------------------------------------
  // API keys
  // ---------------------------------------------------------------------------

  router.get('/api-keys', (req, res) => {
    res.json({ api_keys: apiKeysRepo.list() });
  });

  router.post('/api-keys', (req, res) => {
    const { errors } = apiKeysRepo.validate(req.body || {});
    if (errors.length > 0) return handle(res, err(400, errors.join('; '), 'validation_error'));
    const created = apiKeysRepo.create({ name: (req.body || {}).name.trim() });
    res.status(201).json({ api_key: created });
  });

  router.patch('/api-keys/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = apiKeysRepo.get(id);
    if (!existing) return handle(res, err(404, 'API key not found', 'not_found'));
    const enabled = typeof (req.body || {}).enabled === 'boolean' ? (req.body || {}).enabled : !existing.enabled;
    apiKeysRepo.disable(id, enabled);
    res.json({ api_key: apiKeysRepo.get(id) });
  });

  router.delete('/api-keys/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!apiKeysRepo.remove(id)) return handle(res, err(404, 'API key not found', 'not_found'));
    res.status(204).end();
  });

  return router;
}

module.exports = { createApi, err };
