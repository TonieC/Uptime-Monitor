'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { startTestServer, startProbeServer, request } = require('./helpers');

let serverCtx;
let probe;
let base;
let probeUrl;

before(async () => {
  serverCtx = await startTestServer();
  base = serverCtx.baseUrl;
  probe = await startProbeServer();
  probeUrl = probe.url;
});

after(async () => {
  await serverCtx.close();
  await new Promise((resolve) => probe.server.close(resolve));
});

describe('REST API', () => {
  test('GET /api/health returns ok', async () => {
    const res = await request(base, 'GET', '/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });

  test('GET /api/session returns a ws token', async () => {
    const res = await request(base, 'GET', '/api/session');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ws_token.length > 10);
  });

  test('services CRUD lifecycle', async () => {
    // Create
    const createdRes = await request(base, 'POST', '/api/services', {
      name: 'Portfolio',
      url: `${probeUrl}/fast`,
      interval_seconds: 60,
      timeout_ms: 5000,
      expected_status_codes: [200],
    });
    assert.equal(createdRes.status, 201);
    const created = await createdRes.json();
    assert.equal(created.name, 'Portfolio');
    assert.equal(created.status, 'unknown');
    assert.equal(created.interval_seconds, 60);
    assert.equal(created.method, 'GET');
    assert.equal(created.confirm_failures, 2);

    // List
    const listRes = await request(base, 'GET', '/api/services');
    const list = await listRes.json();
    assert.ok(list.some((s) => s.id === created.id));

    // Get one
    const getRes = await request(base, 'GET', `/api/services/${created.id}`);
    assert.equal(getRes.status, 200);
    const one = await getRes.json();
    assert.equal(one.id, created.id);

    // Update (partial — should not reset other fields)
    const updateRes = await request(base, 'PUT', `/api/services/${created.id}`, {
      interval_seconds: 120,
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.interval_seconds, 120);
    assert.equal(updated.timeout_ms, 5000);
    assert.equal(updated.name, 'Portfolio');

    // Delete
    const delRes = await request(base, 'DELETE', `/api/services/${created.id}`);
    assert.equal(delRes.status, 204);
    const goneRes = await request(base, 'GET', `/api/services/${created.id}`);
    assert.equal(goneRes.status, 404);
  });

  test('POST /api/services validates input', async () => {
    const bad = await request(base, 'POST', '/api/services', { name: '', url: 'https://example.com' });
    assert.equal(bad.status, 400);
    const badJson = await bad.json();
    assert.ok(badJson.error.message);

    const badUrl = await request(base, 'POST', '/api/services', { name: 'x', url: 'ftp://example.com' });
    assert.equal(badUrl.status, 400);

    const noBody = await request(base, 'POST', '/api/services', {});
    assert.equal(noBody.status, 400);
  });

  test('GET /api/services/:id/checks returns recent checks', async () => {
    const svc = await createService('checks-test');
    await serverCtx.worker.runService(svc, { reschedule: false });
    const res = await request(base, 'GET', `/api/services/${svc.id}/checks?limit=10`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.checks.length >= 1);
    assert.equal(body.checks[0].status, 'up');
  });

  test('manual check endpoint returns a check result', async () => {
    const svc = await createService('manual-check');
    const res = await request(base, 'POST', `/api/services/${svc.id}/check`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.check.status, 'up');
    assert.equal(body.check.statusCode, 200);
  });

  test('GET /api/services/:id/uptime returns segments, timeseries and stats', async () => {
    const svc = await createService('uptime-api');
    await serverCtx.worker.runService(svc, { reschedule: false });
    for (const range of ['24h', '7d', '30d']) {
      const res = await request(base, 'GET', `/api/services/${svc.id}/uptime?range=${range}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      const expected = { '24h': 24, '7d': 56, '30d': 120 }[range];
      assert.equal(body.segments.length, expected);
      assert.ok(Array.isArray(body.timeseries.points));
      assert.ok(body.stats.checks >= 1);
      assert.equal(body.range, range);
    }
  });

  test('uptime endpoint defaults to 24h and validates range', async () => {
    const svc = await createService('uptime-default');
    const res = await request(base, 'GET', `/api/services/${svc.id}/uptime`);
    const body = await res.json();
    assert.equal(body.range, '24h');
  });

  test('GET /api/incidents and service incidents return empty initially', async () => {
    const all = await request(base, 'GET', '/api/incidents');
    const allBody = await all.json();
    assert.ok(Array.isArray(allBody.incidents));

    const svc = await createService('incidents-empty');
    const res = await request(base, 'GET', `/api/services/${svc.id}/incidents`);
    const body = await res.json();
    assert.deepEqual(body.incidents, []);
  });

  test('incidents are created and reported through the API', async () => {
    const res = await request(base, 'POST', '/api/services', {
      name: 'down-service',
      url: `${probeUrl}/error`,
      interval_seconds: 60,
      timeout_ms: 2000,
      confirm_failures: 2,
    });
    const svc = await res.json();
    await serverCtx.worker.runService(svc, { reschedule: false });
    await serverCtx.worker.runService(svc, { reschedule: false });

    const list = await request(base, 'GET', '/api/services');
    const services = await list.json();
    const found = services.find((s) => s.id === svc.id);
    assert.equal(found.status, 'down');
    assert.equal(found.incident_count, 1);

    const incidents = await request(base, 'GET', '/api/incidents');
    const incidentsBody = await incidents.json();
    const inc = incidentsBody.incidents.find((i) => i.service_id === svc.id);
    assert.ok(inc);
    assert.equal(inc.ended_at, null);
    assert.equal(inc.check_count, 2);

    const svcIncidents = await request(base, 'GET', `/api/services/${svc.id}/incidents`);
    const svcIncidentsBody = await svcIncidents.json();
    assert.equal(svcIncidentsBody.incidents.length, 1);
  });

  test('summary reflects service counts', async () => {
    const res = await request(base, 'GET', '/api/summary');
    const body = await res.json();
    assert.ok(body.services_total >= 0);
    assert.ok(typeof body.services_up === 'number');
  });

  test('404 for unknown service id', async () => {
    const res = await request(base, 'GET', '/api/services/999999');
    assert.equal(res.status, 404);
  });

  test('security headers are present', async () => {
    const res = await request(base, 'GET', '/api/health');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.ok(res.headers.get('content-security-policy'));
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  async function createService(name) {
    const res = await request(base, 'POST', '/api/services', {
      name,
      url: `${probeUrl}/fast`,
      interval_seconds: 60,
      timeout_ms: 5000,
    });
    assert.equal(res.status, 201);
    return res.json();
  }
});
