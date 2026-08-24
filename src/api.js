'use strict';

const express = require('express');
const { validateServiceInput } = require('./validation');
const {
  computeSegments,
  computeResponseTimeseries,
  computeStats,
  computeUptimePercent,
  VALID_RANGES,
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

function createApi({ db, servicesRepo, checksRepo, incidentsRepo, worker, config }) {
  const router = express.Router();

  function getService(req, res) {
    const id = Number(req.params.id);
    const service = Number.isInteger(id) ? servicesRepo.get(id) : null;
    if (!service) return err(404, 'Service not found', 'not_found');
    return service;
  }

  function enrichService(service) {
    const lastCheck = checksRepo.lastForService(service.id);
    const uptimePercent30d = computeUptimePercent(db, service.id);
    const incidentCount = incidentsRepo
      .listForService(service.id, { limit: 500 }).length;
    return {
      ...service,
      status: lastCheck ? lastCheck.status : 'unknown',
      last_check: lastCheck,
      uptime_percent_30d: uptimePercent30d,
      incident_count: incidentCount,
    };
  }

  router.get('/health', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', uptime: process.uptime(), version: 1 });
    } catch {
      res.status(503).json({ status: 'error' });
    }
  });

  router.get('/session', (req, res) => {
    res.json({ auth_enabled: config.authEnabled, ws_token: req.wsToken });
  });

  router.get('/summary', (req, res) => {
    const services = servicesRepo.list();
    const total = services.length;
    let up = 0;
    let degraded = 0;
    let down = 0;
    let unknown = 0;
    for (const s of services) {
      const last = checksRepo.lastForService(s.id);
      const status = s.enabled && last ? last.status : 'unknown';
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

  router.get('/services', (req, res) => {
    res.json(servicesRepo.list().map(enrichService));
  });

  router.post('/services', async (req, res) => {
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
  });

  router.get('/services/:id', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    res.json(enrichService(service));
  });

  router.put('/services/:id', async (req, res) => {
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
  });

  router.delete('/services/:id', (req, res) => {
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

  router.get('/services/:id/checks', (req, res) => {
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

  router.get('/services/:id/uptime', (req, res) => {
    const service = getService(req, res);
    if (service.status) return handle(res, service);
    const range = VALID_RANGES.has(req.query.range) ? req.query.range : '24h';
    const windowMs = CHECK_WINDOWS[range];
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

  router.get('/incidents', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ incidents: incidentsRepo.listRecent({ limit }) });
  });

  return router;
}

module.exports = { createApi, err };
