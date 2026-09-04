'use strict';

const { EventEmitter } = require('events');
const { performCheck } = require('./checkers');

const SSL_NOTIFY_COOLDOWN_MS = 24 * 3600 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultState() {
  return {
    consecutiveFailures: 0,
    incidentId: null,
    lastStatus: null,
    lastCheckAt: null,
    recoveryStreak: 0,
    sslNotifiedAt: 0,
  };
}

class MonitoringWorker extends EventEmitter {
  constructor({ db, servicesRepo, checksRepo, incidentsRepo, maintenanceRepo, notifier, config }) {
    super();
    this.db = db;
    this.servicesRepo = servicesRepo;
    this.checksRepo = checksRepo;
    this.incidentsRepo = incidentsRepo;
    this.maintenanceRepo = maintenanceRepo || null;
    this.notifier = notifier || null;
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
        ...defaultState(),
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
      this.state.set(service.id, defaultState());
    }
    this.scheduleService(service);
  }

  removeService(serviceId) {
    this.clearTimer(serviceId);
    this.state.delete(serviceId);
  }

  isInMaintenance(serviceId, atMs = Date.now()) {
    if (!this.maintenanceRepo) return null;
    return this.maintenanceRepo.activeForService(serviceId, atMs);
  }

  /**
   * Run one check now (used by manual "check now" and the normal timer).
   * Failed checks are retried per the monitor configuration before the
   * result is committed.
   */
  async runService(service, { reschedule = true } = {}) {
    const st = this.state.get(service.id) || defaultState();

    let result;
    try {
      result = await this.runWithRetries(service);
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
        packet_loss: result.packetLoss,
        cert_expires_at: result.certExpiresAt,
        cert_error: result.certError,
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

  async runWithRetries(service) {
    let result = await performCheck(service, {
      allowPrivateNetworks: this.config.allowPrivateNetworks,
    });
    const maxRetries = Math.min(Math.max(Number(service.retries) || 0, 0), 10);
    let used = 0;
    while (result.status === 'down' && used < maxRetries) {
      used += 1;
      if (Number(service.retry_delay_ms) > 0) {
        await sleep(Math.min(Number(service.retry_delay_ms) || 0, 60000));
      }
      result = await performCheck(service, {
        allowPrivateNetworks: this.config.allowPrivateNetworks,
      });
    }
    result.retriesUsed = used;
    return result;
  }

  handleResult(service, result, st) {
    const previousStatus = st.lastStatus;
    const ts = result.timestamp;

    if (this.isInMaintenance(service.id, ts)) {
      // During maintenance the monitor still runs internally, but outages are
      // not counted and no incidents/notifications are produced. The UI shows
      // the service as "maintenance".
      st.lastStatus = 'maintenance';
      st.lastCheckAt = ts;
      this.state.set(service.id, st);
      if (previousStatus !== 'maintenance') {
        this.emit('status-change', {
          serviceId: service.id,
          from: previousStatus,
          to: 'maintenance',
          check: result,
        });
      }
      this.emit('check', { serviceId: service.id, check: result });
      return;
    }

    if (result.status === 'down') {
      st.recoveryStreak = 0;
      st.consecutiveFailures += 1;
      if (st.consecutiveFailures >= service.confirm_failures) {
        const open = this.incidentsRepo.openForService(service.id);
        if (!open) {
          const incident = this.incidentsRepo.create({
            service_id: service.id,
            started_at: ts,
            status_code: result.statusCode,
            error_type: result.errorType,
            error_message: result.errorMessage,
            response_time_ms: result.responseTime,
            reason: 'Monitor is down',
            check_count: st.consecutiveFailures,
          });
          st.incidentId = incident.id;
          this.emit('incident-opened', incident);
        } else {
          st.incidentId = open.id;
          this.incidentsRepo.recordFailure(open.id, {
            status_code: result.statusCode,
            error_type: result.errorType,
            error_message: result.errorMessage,
            response_time_ms: result.responseTime,
            reason: 'Monitor is down',
            duration_seconds: Math.round((ts - open.started_at) / 1000),
            check_count: st.consecutiveFailures,
          });
        }
      }
    } else {
      // Successful check. Require `recovery_threshold` consecutive successes
      // before declaring an open incident resolved.
      if (st.incidentId) {
        st.recoveryStreak = (st.recoveryStreak || 0) + 1;
        if (st.recoveryStreak >= service.recovery_threshold) {
          const resolved = this.incidentsRepo.resolve(st.incidentId, ts);
          if (resolved) {
            this.emit('incident-resolved', resolved);
          }
          st.incidentId = null;
          st.recoveryStreak = 0;
        }
      } else {
        st.recoveryStreak = 0;
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

    // SSL certificate expiry alerting. Emitted at most once per cooldown
    // window; the notification layer deduplicates further.
    if (result.certExpiresAt && service.check_certificate !== false) {
      const daysLeft = (result.certExpiresAt - ts) / 86400000;
      const threshold = service.ssl_expiry_threshold_days ?? 14;
      if (daysLeft < threshold && ts - st.sslNotifiedAt >= SSL_NOTIFY_COOLDOWN_MS) {
        st.sslNotifiedAt = ts;
        this.state.set(service.id, st);
        this.emit('ssl-expiring', {
          serviceId: service.id,
          service,
          check: result,
          daysLeft,
          expiresAt: result.certExpiresAt,
        });
      }
    }
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
