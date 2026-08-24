'use strict';

const { EventEmitter } = require('events');
const { validateTarget, parseUrl } = require('./security');

const MAX_REDIRECTS = 5;
const USER_AGENT = 'UptimeMonitor/1.0 (+https://github.com/uptime-monitor)';

function classifyError(err) {
  const cause = err && err.cause ? err.cause : {};
  const code = cause.code || '';
  const name = (err && err.name ? err.name : '') + (cause.name || '');

  if (err && err.name === 'AbortError') {
    return { errorType: 'timeout', message: 'Request timed out' };
  }
  if (
    code === 'UND_ERR_ABORTED' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'ETIMEDOUT'
  ) {
    return { errorType: 'timeout', message: 'Request timed out' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA') {
    return { errorType: 'dns', message: 'DNS resolution failed' };
  }
  if (
    /CERT|TLS|UNABLE_TO_VERIFY|DEPTH_ZERO|SSL|HANDSHAKE/i.test(code) ||
    /CERT|TLS|SSL/i.test(name)
  ) {
    return { errorType: 'tls', message: 'TLS/SSL error' };
  }
  if (
    ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'ECONNABORTED', 'EADDRNOTAVAIL'].includes(code)
  ) {
    return { errorType: 'connection', message: 'Connection failed' };
  }
  return { errorType: 'other', message: (err && err.message) || 'Request failed' };
}

async function doFetch(parsedUrl, service, startMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), service.timeout_ms);
  try {
    const res = await fetch(parsedUrl.toString(), {
      method: service.method || 'GET',
      signal: controller.signal,
      redirect: 'manual',
      cache: 'no-store',
      headers: {
        'user-agent': USER_AGENT,
        accept: '*/*',
      },
    });
    const elapsed = Date.now() - startMs;
    const location = res.headers.get('location');
    if (res.body) res.body.cancel().catch(() => {});
    return { ok: true, status: res.status, elapsed, location };
  } catch (err) {
    return { ok: false, error: classifyError(err) };
  } finally {
    clearTimeout(timer);
  }
}

function failure(errorType, message, statusCode, startMs, opts = {}) {
  return {
    status: 'down',
    responseTime: Date.now() - startMs,
    statusCode: statusCode ?? null,
    errorType,
    errorMessage: message,
    timestamp: opts.timestamp ?? startMs,
  };
}

/**
 * Perform a single HTTP check for a service. Returns a normalized result:
 *   { status: 'up'|'degraded'|'down', responseTime, statusCode, errorType, errorMessage, timestamp }
 * Redirects are followed manually so every hop is re-validated against the
 * SSRF guard.
 */
async function performCheck(service, { allowPrivateNetworks = false } = {}) {
  const startMs = Date.now();
  let target = service.url;
  let redirects = 0;

  const { parsed, error } = parseUrl(service.url);
  if (error) return failure('invalid', error, null, startMs);

  while (true) {
    const validation = await validateTarget(target, { allowPrivateNetworks });
    if (!validation.ok) {
      if (validation.code === 'dns') {
        return failure('dns', 'DNS resolution failed', null, startMs);
      }
      return failure('blocked', validation.message, null, startMs);
    }

    const res = await doFetch(validation.parsed, service, startMs);
    if (!res.ok) {
      const f = failure(res.error.errorType, res.error.message, null, startMs);
      return f;
    }

    if (res.status >= 300 && res.status < 400 && res.location) {
      if (redirects >= MAX_REDIRECTS) {
        return failure('other', 'Too many redirects', res.status, startMs);
      }
      redirects += 1;
      try {
        target = new URL(res.location, validation.parsed).toString();
      } catch {
        return failure('invalid', 'Invalid redirect URL', res.status, startMs);
      }
      continue;
    }

    const expected = service.expected_status_codes || [200];
    const statusOk = expected.includes(res.status);
    let status;
    if (!statusOk) {
      status = 'down';
    } else if (
      service.degraded_threshold_ms &&
      res.elapsed > service.degraded_threshold_ms
    ) {
      status = 'degraded';
    } else {
      status = 'up';
    }

    return {
      status,
      responseTime: res.elapsed,
      statusCode: res.status,
      errorType: statusOk ? null : 'http_status',
      errorMessage: statusOk
        ? null
        : `Expected status ${expected.join(', ')} but received ${res.status}`,
      timestamp: startMs,
      redirects,
    };
  }
}

class MonitoringWorker extends EventEmitter {
  constructor({ db, servicesRepo, checksRepo, incidentsRepo, config }) {
    super();
    this.db = db;
    this.servicesRepo = servicesRepo;
    this.checksRepo = checksRepo;
    this.incidentsRepo = incidentsRepo;
    this.config = config;

    this.timers = new Map();
    this.state = new Map();
    this.shuttingDown = false;
    this.retentionTimer = null;
  }

  start() {
    const services = this.servicesRepo.list();
    for (const service of services) {
      const last = this.checksRepo.lastForService(service.id);
      const openIncident = this.incidentsRepo.openForService(service.id);
      let consecutiveFailures = 0;
      if (openIncident) {
        consecutiveFailures = service.confirm_failures;
      } else if (last && last.status === 'down') {
        consecutiveFailures = 1;
      }
      this.state.set(service.id, {
        consecutiveFailures,
        incidentId: openIncident ? openIncident.id : null,
        lastStatus: last ? last.status : null,
        lastCheckAt: last ? last.timestamp : null,
      });
    }

    // Stagger first checks so many services do not hit simultaneously.
    let offset = 0;
    for (const service of services) {
      if (service.enabled) this.scheduleService(service, { delayMs: offset });
      offset += 250;
    }

    this.startRetentionPruner();
    this.emit('started');
  }

  scheduleService(service, { delayMs } = {}) {
    this.clearTimer(service.id);
    if (!service.enabled || this.shuttingDown) return;
    const delay = delayMs !== undefined ? delayMs : service.interval_seconds * 1000;
    const timer = setTimeout(() => {
      this.runService(service);
    }, delay);
    if (timer.unref) timer.unref();
    this.timers.set(service.id, timer);
  }

  clearTimer(serviceId) {
    const existing = this.timers.get(serviceId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(serviceId);
    }
  }

  /**
   * Called after a service is created or updated: (re)schedule it.
   */
  syncService(service) {
    if (!this.state.has(service.id)) {
      this.state.set(service.id, {
        consecutiveFailures: 0,
        incidentId: null,
        lastStatus: null,
        lastCheckAt: null,
      });
    }
    this.scheduleService(service);
  }

  removeService(serviceId) {
    this.clearTimer(serviceId);
    this.state.delete(serviceId);
  }

  /**
   * Run one check now (used by manual "check now" and the normal timer).
   */
  async runService(service, { reschedule = true } = {}) {
    const st = this.state.get(service.id) || {
      consecutiveFailures: 0,
      incidentId: null,
      lastStatus: null,
    };

    let result;
    try {
      result = await performCheck(service, {
        allowPrivateNetworks: this.config.allowPrivateNetworks,
      });
    } catch (err) {
      this.emit('worker-error', { serviceId: service.id, message: err.message });
      return null;
    }

    try {
      this.checksRepo.insert({
        service_id: service.id,
        timestamp: result.timestamp,
        status: result.status,
        response_time_ms: result.responseTime,
        status_code: result.statusCode,
        error_type: result.errorType,
        error_message: result.errorMessage,
      });
      this.handleResult(service, result, st);
    } catch (err) {
      this.emit('worker-error', { serviceId: service.id, message: err.message });
      return null;
    }

    if (reschedule) {
      this.scheduleService(service, { delayMs: service.interval_seconds * 1000 });
    }
    return result;
  }

  handleResult(service, result, st) {
    const previousStatus = st.lastStatus;
    const ts = result.timestamp;

    if (result.status === 'down') {
      st.consecutiveFailures += 1;
      if (st.consecutiveFailures >= service.confirm_failures) {
        const open = this.incidentsRepo.openForService(service.id);
        if (!open) {
          const incident = this.incidentsRepo.create({
            service_id: service.id,
            started_at: ts,
            status_code: result.statusCode,
            error_message: result.errorMessage,
            check_count: st.consecutiveFailures,
          });
          st.incidentId = incident.id;
          this.emit('incident-opened', incident);
        } else {
          st.incidentId = open.id;
          this.incidentsRepo.recordFailure(open.id, {
            status_code: result.statusCode,
            error_message: result.errorMessage,
            duration_seconds: Math.round((ts - open.started_at) / 1000),
            check_count: st.consecutiveFailures,
          });
        }
      }
    } else {
      if (st.incidentId) {
        const resolved = this.incidentsRepo.resolve(st.incidentId, ts);
        if (resolved) {
          this.emit('incident-resolved', resolved);
        }
        st.incidentId = null;
      }
      st.consecutiveFailures = 0;
    }

    st.lastStatus = result.status;
    st.lastCheckAt = ts;
    this.state.set(service.id, st);

    if (previousStatus !== result.status) {
      this.emit('status-change', {
        serviceId: service.id,
        from: previousStatus,
        to: result.status,
        check: result,
      });
    }
    this.emit('check', { serviceId: service.id, check: result });
  }

  startRetentionPruner() {
    const intervalMinutes = this.config.checkRetentionIntervalMinutes || 60;
    const retentionMs = (this.config.checkRetentionDays || 90) * 24 * 3600 * 1000;
    const prune = () => {
      try {
        const cutoff = Date.now() - retentionMs;
        const deleted = this.checksRepo.pruneOlderThan(cutoff);
        if (deleted > 0) this.emit('pruned', { deleted, cutoff });
      } catch (err) {
        this.emit('worker-error', { message: `Retention prune failed: ${err.message}` });
      }
    };
    prune();
    this.retentionTimer = setInterval(prune, intervalMinutes * 60 * 1000);
    if (this.retentionTimer.unref) this.retentionTimer.unref();
  }

  shutdown() {
    this.shuttingDown = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
  }
}

module.exports = { MonitoringWorker, performCheck };
