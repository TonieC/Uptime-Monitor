'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createDb } = require('../src/db');
const { createServiceRepo } = require('../src/services');
const { createIncidentsRepo } = require('../src/incidents');
const { Notifier, createNotificationsRepo, toPublicNotification } = require('../src/notifications');
const { makeConfig } = require('./helpers');

const MINUTE = 60 * 1000;

function setup() {
  const cfg = makeConfig();
  const db = createDb({ dbPath: cfg.dbPath });
  const servicesRepo = createServiceRepo(db);
  const incidentsRepo = createIncidentsRepo(db);
  const repo = createNotificationsRepo(db);
  const sent = [];
  const transport = {
    discord: async (nCfg, payload) => sent.push({ type: 'discord', cfg: nCfg, payload }),
    webhook: async (nCfg, payload) => sent.push({ type: 'webhook', cfg: nCfg, payload }),
    email: async (nCfg, payload) => sent.push({ type: 'email', cfg: nCfg, payload }),
    telegram: async (nCfg, payload) => sent.push({ type: 'telegram', cfg: nCfg, payload }),
    failing: async () => {
      throw new Error('boom');
    },
  };
  const notifier = new Notifier({ repo, servicesRepo, config: cfg, transport });
  const workerEvents = new EventEmitter();
  notifier.attach(workerEvents);
  const svc = servicesRepo.create({ name: 'API', url: 'https://example.com/api', type: 'http' });
  return { cfg, db, servicesRepo, incidentsRepo, repo, notifier, workerEvents, svc, sent, transport };
}

function openIncident(incidentsRepo, svcId, startedMs = Date.now() - MINUTE) {
  return incidentsRepo.create({ service_id: svcId, started_at: startedMs, error_type: 'timeout', error_message: 'timed out', status_code: 500 });
}

describe('notification repository', () => {
  test('create/update/list/get/remove round trip and redaction of secrets', () => {
    const { db, repo } = setup();
    const secret = 'shh-secret-token';
    const created = repo.create({
      name: 'Ops',
      type: 'webhook',
      config: { url: 'https://hooks.example.com/xyz', password: secret },
      events: ['down', 'recovered', 'ssl_expiring', 'degraded'],
    });
    assert.ok(created.id);
    assert.equal(created.type, 'webhook');
    assert.equal(created.config.password, secret);
    assert.equal(repo.get(created.id).name, 'Ops');

    const updated = repo.update(created.id, { name: 'Ops2', enabled: false });
    assert.equal(updated.name, 'Ops2');
    assert.equal(updated.enabled, false);
    assert.equal(repo.list().length, 1);

    const pub = toPublicNotification(repo.get(created.id));
    assert.equal(pub.config._redacted, true);
    assert.equal(pub.config.password, true);
    assert.equal(pub.config.url, 'https://hooks.example.com/xyz');
    assert.ok(!JSON.stringify(pub).includes(secret), 'plaintext secret must not leak');

    assert.equal(repo.remove(created.id), true);
    assert.equal(repo.get(created.id), null);
    assert.equal(repo.remove(created.id), false);
    db.close();
  });
});

describe('notifier dispatch', () => {
  test('sends a webhook when an incident opens', async () => {
    const { db, incidentsRepo, repo, notifier, workerEvents, svc, sent } = setup();
    const notif = repo.create({ name: 'Hook', type: 'webhook', config: { url: 'https://h.example.com/x' } });
    const incident = openIncident(incidentsRepo, svc.id);
    workerEvents.emit('incident-opened', incident);
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'webhook');
    assert.equal(sent[0].cfg.url, 'https://h.example.com/x');
    assert.equal(sent[0].payload.monitor, 'API');
    assert.equal(sent[0].payload.current_status, 'down');
    assert.equal(sent[0].payload.error_message, 'timed out');
    assert.equal(sent[0].payload.incident.id, incident.id);
    assert.ok(sent[0].payload.target.includes('example.com'));
    const log = repo.recentSend(notif.id, 'down', svc.id);
    assert.ok(log);
    assert.equal(JSON.parse(log.detail_json).incidentId, incident.id);
    db.close();
  });

  test('does not resend for the same incident (edge-trigger dedup)', async () => {
    const { db, incidentsRepo, repo, workerEvents, svc, sent } = setup();
    repo.create({ name: 'Hook', type: 'webhook', config: { url: 'https://h.example.com/x' } });
    const incident = openIncident(incidentsRepo, svc.id);
    workerEvents.emit('incident-opened', incident);
    await new Promise((r) => setImmediate(r));
    workerEvents.emit('incident-opened', incident); // duplicate emission (e.g. reconnect)
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    db.close();
  });

  test('sends recovered with duration once an incident resolves', async () => {
    const { db, incidentsRepo, repo, workerEvents, svc, sent } = setup();
    repo.create({ name: 'Hook', type: 'webhook', config: { url: 'https://h.example.com/x' } });
    const incident = openIncident(incidentsRepo, svc.id);
    const resolved = incidentsRepo.resolve(incident.id, incident.started_at + 5 * MINUTE);
    workerEvents.emit('incident-resolved', resolved);
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.current_status, 'up');
    assert.equal(sent[0].payload.previous_status, 'down');
    assert.equal(sent[0].payload.incident.duration_seconds, 300);
    db.close();
  });

  test('respects event subscriptions and enabled flag', async () => {
    const { db, incidentsRepo, repo, workerEvents, svc, sent } = setup();
    const onlyDown = repo.create({ name: 'Down only', type: 'webhook', config: { url: 'https://a' }, events: ['down'] });
    const disabled = repo.create({ name: 'Disabled', type: 'webhook', config: { url: 'https://b' }, enabled: false });
    const incident = openIncident(incidentsRepo, svc.id);
    const resolved = incidentsRepo.resolve(incident.id, incident.started_at + 60 * 1000);
    workerEvents.emit('incident-resolved', resolved);
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 0, 'not subscribed to recovered');
    workerEvents.emit('incident-opened', incident);
    await new Promise((r) => setImmediate(r));
    // onlyDown fires; disabled never fires.
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.monitor, 'API');
    assert.ok(!sent.some((s) => s.cfg.url === 'https://b'));
    db.close();
  });

  test('logs failures and emits send-error without throwing', async () => {
    const { db, incidentsRepo, repo, notifier, workerEvents, svc, sent } = setup();
    repo.create({ name: 'Fragile', type: 'failing', config: {} });
    const errors = [];
    notifier.on('send-error', (e) => errors.push(e));
    const incident = openIncident(incidentsRepo, svc.id);
    workerEvents.emit('incident-opened', incident);
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error, 'boom');
    const log = repo.recentSend(1, 'down', svc.id);
    assert.equal(log.success, 0);
    assert.equal(JSON.parse(log.detail_json).error, 'boom');
    db.close();
  });

  test('ssl_expiring is deduplicated by a 24h cooldown', async () => {
    const { db, repo, workerEvents, svc, sent } = setup();
    repo.create({ name: 'SSL', type: 'webhook', config: { url: 'https://h' }, events: ['ssl_expiring'] });
    const sslPayload = { serviceId: svc.id, service: { name: 'API', url: 'https://example.com', type: 'http' }, daysLeft: 5, expiresAt: Date.now() + 5 * 86400000 };
    workerEvents.emit('ssl-expiring', sslPayload);
    await new Promise((r) => setImmediate(r));
    workerEvents.emit('ssl-expiring', sslPayload);
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1, 'second ssl alert within 24h is suppressed');
    assert.ok(sent[0].payload.days_left < 14);
    db.close();
  });

  test('test() sends a test payload through the transport', async () => {
    const { db, repo, notifier, sent } = setup();
    const notif = repo.create({ name: 'Hook', type: 'webhook', config: { url: 'https://h.example.com/x' } });
    await notifier.test(notif);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.event, 'test');
    db.close();
  });
});
