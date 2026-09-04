'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { startTestServer, startProbeServer, request } = require('./helpers');

const basicAuth = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

let ctx;
let probe;
let base;
let probeUrl;

let secure;
let secBase;

before(async () => {
  ctx = await startTestServer();
  base = ctx.baseUrl;
  probe = await startProbeServer();
  probeUrl = probe.url;

  secure = await startTestServer({
    authEnabled: true,
    adminUser: 'admin',
    adminPassword: 's3cret!',
  });
  secBase = secure.baseUrl;
});

after(async () => {
  await ctx.close();
  await secure.close();
  await new Promise((resolve) => probe.server.close(resolve));
});

async function createMonitor(name, url) {
  const res = await request(base, 'POST', '/api/monitors', {
    name,
    url: url || `${probeUrl}/fast`,
    interval_seconds: 60,
    timeout_ms: 5000,
    expected_status_codes: [200],
  });
  assert.equal(res.status, 201, `create ${name}`);
  return res.json();
}

describe('monitors alias and per-monitor endpoints', () => {
  test('/api/monitors mirrors /api/services', async () => {
    const svc = await createMonitor('alias-mon');
    const [sRes, mRes] = await Promise.all([
      request(base, 'GET', '/api/services'),
      request(base, 'GET', '/api/monitors'),
    ]);
    const services = await sRes.json();
    const monitors = await mRes.json();
    assert.deepEqual(monitors.map((m) => m.id).sort(), services.map((s) => s.id).sort());
    const found = monitors.find((m) => m.id === svc.id);
    assert.equal(found.type, 'http');
    assert.equal(found.status, 'unknown');
  });

  test('/api/monitors/:id/status reports uptime and open incident', async () => {
    const svc = await createMonitor('status-mon');
    const beforeRes = await request(base, 'GET', `/api/monitors/${svc.id}/status`);
    assert.equal(beforeRes.status, 200);
    const before = await beforeRes.json();
    assert.equal(before.service_id, svc.id);
    assert.equal(before.open_incident, null);
    assert.ok('uptime_percent_24h' in before && 'uptime_percent_30d' in before);

    const checkRes = await request(base, 'POST', `/api/monitors/${svc.id}/check`);
    assert.equal(checkRes.status, 200);
    const after = await (await request(base, 'GET', `/api/monitors/${svc.id}/status`)).json();
    assert.equal(after.status, 'up');
    assert.equal(after.last_check.status, 'up');
  });

  test('/api/monitors/:id/statistics supports 24h/90d/1y windows', async () => {
    const svc = await createMonitor('stats-mon');
    await request(base, 'POST', `/api/monitors/${svc.id}/check`);
    for (const range of ['24h', '90d', '1y']) {
      const res = await request(base, 'GET', `/api/monitors/${svc.id}/statistics?range=${range}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.range, range);
      assert.ok(body.stats.checks >= 1);
      assert.ok('incident_stats' in body);
      assert.equal(typeof body.incident_stats.incidents, 'number');
      assert.equal(typeof body.incident_uptime_percent, 'number');
      assert.ok('uptime_percent' in body);
    }
    const bad = await (await request(base, 'GET', `/api/monitors/${svc.id}/statistics?range=xx`)).json();
    assert.equal(bad.range, '24h');
  });

  test('/api/monitors/:id/uptime handles extended ranges', async () => {
    const svc = await createMonitor('uptime-mon');
    await request(base, 'POST', `/api/monitors/${svc.id}/check`);
    for (const [range, segments] of [['90d', 90], ['1y', 52]]) {
      const res = await request(base, 'GET', `/api/monitors/${svc.id}/uptime?range=${range}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.segments.length, segments);
    }
  });

  test('global statistics endpoint accepts extended ranges', async () => {
    for (const range of ['24h', '7d', '30d', '90d', '1y']) {
      const res = await request(base, 'GET', `/api/statistics?range=${range}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.range, range);
      assert.equal(typeof body.checks, 'number');
    }
    const junk = await (await request(base, 'GET', '/api/statistics?range=nope')).json();
    assert.equal(junk.range, '24h');
  });
});

describe('maintenance mode API', () => {
  test('start, list, and end a maintenance window for a monitor', async () => {
    const svc = await createMonitor('maint-mon');
    const startRes = await request(base, 'POST', '/api/maintenance', {
      service_id: svc.id,
      until: Date.now() + 60 * 1000,
      reason: 'scheduled upgrade',
    });
    assert.equal(startRes.status, 201);
    const window = (await startRes.json()).maintenance;
    assert.equal(window.service_id, svc.id);
    assert.ok(window.ended_at > Date.now());

    // Monitor now shows maintenance status in listings.
    const monitors = await (await request(base, 'GET', '/api/monitors')).json();
    assert.equal(monitors.find((m) => m.id === svc.id).status, 'maintenance');

    const list = await (await request(base, 'GET', `/api/monitors/${svc.id}/maintenance`)).json();
    assert.ok(list.maintenance.some((w) => w.id === window.id));

    const all = await (await request(base, 'GET', '/api/maintenance')).json();
    assert.ok(all.maintenance.some((w) => w.id === window.id && w.service_name === 'maint-mon'));

    const endRes = await request(base, 'POST', `/api/maintenance/${window.id}/end`);
    assert.equal(endRes.status, 200);
    const ended = (await endRes.json()).maintenance;
    assert.ok(ended.ended_at <= Date.now() + 1000);

    const after = await (await request(base, 'GET', `/api/monitors/${svc.id}/status`)).json();
    assert.equal(after.status, 'unknown');
  });

  test('maintenance validation rejects bad input', async () => {
    const bad = await request(base, 'POST', '/api/maintenance', { service_id: 999999 });
    assert.equal(bad.status, 400);
    const past = await request(base, 'POST', '/api/maintenance', { service_id: 1, until: Date.now() - 1000 });
    assert.equal(past.status, 400);
    const missing = await request(base, 'POST', '/api/maintenance', {});
    assert.equal(missing.status, 400);
    const unknownEnd = await request(base, 'POST', '/api/maintenance/999999/end');
    assert.equal(unknownEnd.status, 404);
  });
});

describe('status pages API and public endpoints', () => {
  test('CRUD a status page and expose public data anonymously', async () => {
    const svc = await createMonitor('page-mon');
    const res = await request(base, 'POST', '/api/status-pages', {
      title: 'Acme Systems',
      slug: 'acme-systems',
      description: 'Public status for Acme',
      monitor_ids: [svc.id],
      branding: { background_color: '#0f172a' },
    });
    assert.equal(res.status, 201);
    const page = (await res.json()).status_page;
    assert.deepEqual(page.monitor_ids, [svc.id]);

    const list = await (await request(base, 'GET', '/api/status-pages')).json();
    assert.equal(list.status_pages.length, 1);
    assert.deepEqual(list.status_pages[0].monitor_ids, [svc.id]);

    // Anonymous data endpoint.
    const pub = await request(base, 'GET', `/api/public/status/${page.slug}`);
    assert.equal(pub.status, 200);
    const pubBody = await pub.json();
    assert.equal(pubBody.slug, page.slug);
    assert.equal(pubBody.title, 'Acme Systems');
    assert.equal(pubBody.monitors.length, 1);
    assert.equal(pubBody.monitors[0].name, 'page-mon');
    assert.ok('uptime_24h' in pubBody.monitors[0]);

    // Public HTML page served without authentication.
    const html = await request(base, 'GET', `/status/${page.slug}`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<html/i);

    // Duplicate slug rejected.
    const dup = await request(base, 'POST', '/api/status-pages', { title: 'X', slug: page.slug });
    assert.equal(dup.status, 400);

    // Updating monitor set + making private hides it publicly.
    const upd = await request(base, 'PUT', `/api/status-pages/${page.id}`, {
      monitor_ids: [],
      is_public: false,
    });
    assert.equal(upd.status, 200);
    const hidden = await request(base, 'GET', `/api/public/status/${page.slug}`);
    assert.equal(hidden.status, 404);

    const del = await request(base, 'DELETE', `/api/status-pages/${page.id}`);
    assert.equal(del.status, 204);
    const gone = await request(base, 'GET', `/api/public/status/${page.slug}`);
    assert.equal(gone.status, 404);
  });

  test('invalid status page bodies are rejected', async () => {
    const badSlug = await request(base, 'POST', '/api/status-pages', { title: 'X', slug: 'UPPER CASE' });
    assert.equal(badSlug.status, 400);
    const noTitle = await request(base, 'POST', '/api/status-pages', { slug: 'ok-slug' });
    assert.equal(noTitle.status, 400);
    const badMonitor = await request(base, 'POST', '/api/status-pages', { title: 'X', slug: 'ok2', monitor_ids: [999999] });
    assert.equal(badMonitor.status, 400);
  });
});

describe('notifications API redaction', () => {
  test('secrets are never returned through the API', async () => {
    const token = 'glpat-secret-webhook-123456789';
    const res = await request(base, 'POST', '/api/notifications', {
      name: 'Discord ops',
      type: 'discord',
      config: { webhook_url: `https://discord.com/api/webhooks/123/${token}` },
      events: ['down', 'recovered'],
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes(token), 'discord webhook token must be redacted');
    assert.equal(body.notification.config._redacted, true);
    assert.equal(body.notification.config.webhook_url, true);

    const list = await (await request(base, 'GET', '/api/notifications')).json();
    assert.ok(!JSON.stringify(list).includes(token));
    const n = list.notifications.find((x) => x.name === 'Discord ops');
    assert.equal(n.config.webhook_url, true);

    // Validation on create.
    const bad = await request(base, 'POST', '/api/notifications', {
      name: 'Bad',
      type: 'discord',
      config: { webhook_url: 'http://insecure.example' },
    });
    assert.equal(bad.status, 400);
    const unknownType = await request(base, 'POST', '/api/notifications', { name: 'Bad', type: 'pagerduty' });
    assert.equal(unknownType.status, 400);
  });
});

describe('API key authentication', () => {
  test('keys protect the API when basic auth is enabled', async () => {
    // Anonymous is rejected.
    const anon = await request(base, 'GET', '/api/services');
    assert.equal(anon.status, 200); // this server has auth disabled

    const denied = await request(secBase, 'GET', '/api/services');
    assert.equal(denied.status, 401);
    assert.ok(denied.headers.get('www-authenticate'));

    // Basic auth works.
    const viaBasic = await request(secBase, 'GET', '/api/services', undefined, { Authorization: basicAuth('admin', 's3cret!') });
    assert.equal(viaBasic.status, 200);

    // Create a key (plaintext returned exactly once).
    const keyRes = await request(secBase, 'POST', '/api/api-keys', { name: 'ci-bot' }, {
      Authorization: basicAuth('admin', 's3cret!'),
    });
    assert.equal(keyRes.status, 201);
    const { api_key } = await keyRes.json();
    assert.ok(api_key.key, 'plaintext key returned at creation');
    assert.ok(api_key.key.startsWith(api_key.key_prefix));
    assert.ok(!api_key.key_hash, 'hash never returned');
    assert.ok(!JSON.stringify(api_key).includes('key_hash'));

    // List never returns the raw key or hash.
    const list = await (await request(secBase, 'GET', '/api/api-keys', undefined, {
      Authorization: basicAuth('admin', 's3cret!'),
    })).json();
    assert.ok(!JSON.stringify(list).includes(api_key.key));
    assert.equal(list.api_keys[0].key_prefix, api_key.key_prefix);
    assert.ok(!('key' in list.api_keys[0]) && !('key_hash' in list.api_keys[0]));

    // Use the key via X-API-Key and Bearer.
    const viaHeader = await request(secBase, 'GET', '/api/services', undefined, { 'X-API-Key': api_key.key });
    assert.equal(viaHeader.status, 200);
    const viaBearer = await request(secBase, 'GET', '/api/services', undefined, { Authorization: `Bearer ${api_key.key}` });
    assert.equal(viaBearer.status, 200);

    // An unknown key is rejected.
    const junk = await request(secBase, 'GET', '/api/services', undefined, { 'X-API-Key': 'um-key-invalid-0000000000' });
    assert.equal(junk.status, 401);

    // Disabled key stops working.
    await request(secBase, 'PATCH', `/api/api-keys/${api_key.id}`, { enabled: false }, {
      Authorization: basicAuth('admin', 's3cret!'),
    });
    const disabled = await request(secBase, 'GET', '/api/services', undefined, { 'X-API-Key': api_key.key });
    assert.equal(disabled.status, 401);

    // Re-enable and delete.
    await request(secBase, 'PATCH', `/api/api-keys/${api_key.id}`, { enabled: true }, {
      Authorization: basicAuth('admin', 's3cret!'),
    });
    const reenabled = await request(secBase, 'GET', '/api/services', undefined, { 'X-API-Key': api_key.key });
    assert.equal(reenabled.status, 200);
    const del = await request(secBase, 'DELETE', `/api/api-keys/${api_key.id}`, undefined, {
      Authorization: basicAuth('admin', 's3cret!'),
    });
    assert.equal(del.status, 204);
  });

  test('status pages remain public even with auth enabled', async () => {
    // Create a monitor and a public status page via the secured API.
    const monRes = await request(secBase, 'POST', '/api/monitors', {
      name: 'secured-mon',
      url: `${probeUrl}/fast`,
      interval_seconds: 60,
      timeout_ms: 5000,
    }, { Authorization: basicAuth('admin', 's3cret!') });
    assert.equal(monRes.status, 201);
    const mon = await monRes.json();

    const pageRes = await request(secBase, 'POST', '/api/status-pages', {
      title: 'Public Page',
      slug: 'public-page',
      monitor_ids: [mon.id],
    }, { Authorization: basicAuth('admin', 's3cret!') });
    assert.equal(pageRes.status, 201);

    // No auth needed for the public data or HTML page.
    const pub = await request(secBase, 'GET', `/api/public/status/public-page`);
    assert.equal(pub.status, 200);
    assert.equal((await pub.json()).title, 'Public Page');
    const html = await request(secBase, 'GET', '/status/public-page');
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<html/i);

    // A private page is hidden even while public endpoints bypass auth.
    const privatePage = await request(secBase, 'POST', '/api/status-pages', {
      title: 'Private',
      slug: 'private-page',
      is_public: false,
    }, { Authorization: basicAuth('admin', 's3cret!') });
    assert.equal(privatePage.status, 201);
    const hidden = await request(secBase, 'GET', '/api/public/status/private-page');
    assert.equal(hidden.status, 404);
  });
});
