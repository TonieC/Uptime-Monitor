'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const HOUR = 3600 * 1000;
const NOW = Date.now();

// Build index.html with all <script src> tags inlined so no external
// resource loading is needed (jsdom 26 no longer ships a public ResourceLoader).
function inlineHtml() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  return html.replace(/<script src="(\/js\/[^"]+\.js)"><\/script>/g, (_, src) => {
    const file = path.resolve(PUBLIC, src.replace(/^\//, ''));
    const code = fs.readFileSync(file, 'utf8');
    return `<script>\n${code}\n</script>`;
  });
}

function makeService(id, overrides = {}) {
  return {
    id,
    name: `Service ${id}`,
    url: 'https://example.com/api',
    method: 'GET',
    enabled: true,
    status: id === 2 ? 'degraded' : 'up',
    interval_seconds: 60,
    timeout_ms: 5000,
    degraded_threshold_ms: 2000,
    confirm_failures: 1,
    incident_count: 0,
    uptime_percent_30d: 99.9,
    last_check: {
      timestamp: NOW - 12000,
      status: 'up',
      response_time_ms: id === 2 ? 2500 : 120,
      status_code: 200,
    },
    created_at: NOW - 86400000,
    ...overrides,
  };
}

function segmentsFor(serviceId) {
  const segments = [];
  for (let i = 0; i < 24; i++) {
    const start = NOW - (24 - i) * HOUR;
    const status = serviceId === 2 && i >= 20 ? 'degraded' : i === 10 ? 'down' : 'up';
    segments.push({ start, end: start + HOUR, status, checks: 1, up: 1, degraded: status === 'degraded' ? 1 : 0, down: status === 'down' ? 1 : 0, avg_response_ms: status === 'down' ? null : 150 });
  }
  return segments;
}

const SERVICES = [makeService(1), makeService(2)];

function createDom({ captureErrors = [] } = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (e) => captureErrors.push(String(e)));

  const sockets = [];
  const fetchMock = async (url, options = {}) => {
    const u = String(url);
    const respond = (data, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
    });
    if (u.startsWith('/api/session')) return respond({ ws_token: 'tok123' });
    if (u.startsWith('/api/summary')) {
      return respond({ services_total: 2, services_up: 1, services_degraded: 1, services_down: 0, incidents_open: 0 });
    }
    if (u.startsWith('/api/services') && options.method === 'POST') {
      return respond(makeService(99), 201);
    }
    if (u.match(/\/api\/services\/\d+\/uptime/)) {
      const id = Number(u.match(/\/api\/services\/(\d+)\/uptime/)[1]);
      return respond({
        segments: segmentsFor(id),
        stats: { checks: 24, up: 22, degraded: 1, down: 1, uptime_percent: 95.83, avg_response_ms: 150, min_response_ms: 80, max_response_ms: 2500 },
        last_check: { timestamp: NOW - 12000, status: 'up', response_time_ms: 120, status_code: 200 },
        timeseries: {
          points: Array.from({ length: 10 }, (_, i) => ({ t: NOW - (10 - i) * 60000, value: i % 3 === 0 ? null : 150 + i * 5 })),
        },
      });
    }
    if (u.match(/\/api\/services\/\d+\/checks/)) {
      return respond({ checks: [
        { timestamp: NOW - 1000, status: 'up', response_time_ms: 120, status_code: 200 },
        { timestamp: NOW - 61000, status: 'up', response_time_ms: 130, status_code: 200 },
      ] });
    }
    if (u.match(/\/api\/services\/\d+\/incidents/)) {
      return respond({ incidents: [] });
    }
    if (u.match(/\/api\/services\/\d+$/)) {
      const id = Number(u.match(/\/api\/services\/(\d+)$/)[1]);
      return respond(makeService(id));
    }
    if (u.startsWith('/api/services')) return respond(SERVICES);
    if (u.startsWith('/api/incidents')) return respond({ incidents: [] });
    return respond({ error: { message: `Unhandled: ${u}` } }, 404);
  };

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this._sent = [];
      sockets.push(this);
    }
    send(data) { this._sent.push(data); }
    close() {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000 });
    }
  }

  const dom = new JSDOM(inlineHtml(), {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    virtualConsole,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = fetchMock;
      window.WebSocket = FakeWebSocket;
      window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
      window.cancelAnimationFrame = (id) => clearTimeout(id);
      window.confirm = () => true;
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      // jsdom has no canvas implementation; provide a no-op 2D context.
      const ctx2d = new Proxy(
        {
          canvas: null,
          measureText: () => ({ width: 0 }),
          getImageData: () => ({ data: [] }),
          createLinearGradient: () => ({ addColorStop() {} }),
          createRadialGradient: () => ({ addColorStop() {} }),
        },
        {
          get(target, prop) {
            if (prop in target) return target[prop];
            return () => {};
          },
          set(target, prop, value) {
            target[prop] = value;
            return true;
          },
        }
      );
      window.HTMLCanvasElement.prototype.getContext = () => ctx2d;
    },
  });

  return { dom, sockets, fetchMock };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('frontend smoke', () => {
  let ctx;
  let errors;
  beforeEach(() => {
    errors = [];
    ctx = createDom({ captureErrors: errors });
  });
  afterEach(() => {
    ctx.dom.window.close();
  });

  test('dashboard renders services, summary and uptime bars', async () => {
    const dom = ctx.dom;
    const { window } = ctx.dom;
    const doc = window.document;
    // Wait for init + async loads
    await sleep(150);
    assert.equal(doc.querySelector('h1')?.textContent, 'Dashboard');
    const cards = doc.querySelectorAll('.service-card');
    assert.equal(cards.length, 2);
    assert.ok(doc.querySelector('#summary-row .stat-card'));
    assert.ok(cards[0].querySelector('.uptime-bar .seg'), 'uptime bar segments rendered');
    assert.equal(doc.querySelector('#live-badge .dot').className, 'dot');
    // WS connected with token
    assert.equal(ctx.sockets.length >= 1, true, 'a websocket was created');
    assert.ok(ctx.sockets[0].url.includes('tok123'), 'token passed to WS url');
  });

  test('detail view renders service stats and incident rows', async () => {
    const dom = ctx.dom;
    const { window } = ctx.dom;
    const doc = window.document;
    await sleep(100);
    window.location.hash = '#/services/1';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await sleep(200);
    assert.ok(doc.querySelector('.service-card') === null, 'dashboard unmounted');
    const nameEls = [...doc.querySelectorAll('.detail-name h1')];
    assert.ok(nameEls.some((e) => e.textContent.includes('Service 1')), 'detail title shows service name');
    assert.ok(doc.querySelector('.stat-grid'), 'detail stat grid rendered');
    assert.ok(doc.querySelector('#detail-uptime-bar .seg'), 'detail uptime bar rendered');
  });

  test('incidents view renders and WS incident message refreshes', async () => {
    const dom = ctx.dom;
    const { window } = ctx.dom;
    const doc = window.document;
    await sleep(100);
    window.location.hash = '#/incidents';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await sleep(100);
    assert.ok(doc.querySelector('.view-title h1')?.textContent.includes('Incidents'));
    // Simulate a live incident message over the socket
    const sock = ctx.sockets[0];
    sock.onopen && sock.onopen({});
    sock.onmessage({ data: JSON.stringify({ type: 'incident-opened', serviceId: 1 }) });
    await sleep(120);
    // should not throw; view still mounted
    assert.ok(doc.querySelector('.view-title h1'));
  });

  test('no uncaught errors during dashboard + navigation', async () => {
    const dom = ctx.dom;
    const { window } = ctx.dom;
    await sleep(150);
    window.location.hash = '#/services/1';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await sleep(200);
    window.location.hash = '#/';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await sleep(150);
    assert.deepEqual(errors, []);
  });
});
