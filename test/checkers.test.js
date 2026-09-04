'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performCheck, parsePingOutput, keywordCheck } = require('../src/checkers');

let httpServer;
let httpBase;
let tcpServer;
let tcpPort;
let tlsServer;
let tlsPort;
let certDir;

async function startHttpServer() {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url === '/fast') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } else if (url === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('slow');
      }, 400);
    } else if (url === '/error') {
      res.writeHead(500);
      res.end('boom');
    } else if (url === '/hello') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Hello Uptime world');
    } else if (url === '/no-hello') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('nothing here');
    } else if (url === '/echo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ headers: req.headers, method: req.method }));
    } else if (url === '/auth') {
      const auth = req.headers.authorization || '';
      const expected = 'Basic ' + Buffer.from('user:secret').toString('base64');
      if (auth === expected) {
        res.writeHead(200);
        res.end('authorized');
      } else {
        res.writeHead(401);
        res.end('unauthorized');
      }
    } else if (url === '/guarded-header') {
      if (req.headers['x-custom'] === 'yes') {
        res.writeHead(200);
        res.end('header ok');
      } else {
        res.writeHead(400);
        res.end('missing header');
      }
    } else if (url === '/guarded-agent') {
      if (req.headers['user-agent'] === 'CustomAgent/1.0') {
        res.writeHead(200);
        res.end('agent ok');
      } else {
        res.writeHead(400);
        res.end('missing agent');
      }
    } else if (url === '/redirect') {
      res.writeHead(302, { Location: '/fast' });
      res.end();
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

async function startTcpServer() {
  const server = net.createServer((socket) => {
    socket.on('data', () => socket.end('pong'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

function makeCert() {
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-cert-'));
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '30', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

before(async () => {
  httpServer = await startHttpServer();
  httpBase = `http://127.0.0.1:${httpServer.address().port}`;
  tcpServer = await startTcpServer();
  tcpPort = tcpServer.address().port;

  const { key, cert } = makeCert();
  tlsServer = tls.createServer({ key, cert }, (socket) => {
    socket.end();
  });
  await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
  tlsPort = tlsServer.address().port;
});

after(() => {
  httpServer.close();
  tcpServer.close();
  if (tlsServer) tlsServer.close();
  if (certDir) fs.rmSync(certDir, { recursive: true, force: true });
});

function svc(overrides) {
  return {
    type: 'http',
    url: `${httpBase}/fast`,
    method: 'GET',
    timeout_ms: 3000,
    expected_status_codes: [200],
    degraded_threshold_ms: null,
    follow_redirects: true,
    ...overrides,
  };
}

describe('keyword checks', () => {
  test('succeeds when expected keyword is present (case-insensitive by default)', async () => {
    const r = await performCheck(svc({ url: `${httpBase}/hello`, expected_keyword: 'uptime' }), { allowPrivateNetworks: true });
    assert.equal(r.status, 'up');
  });

  test('fails when expected keyword is missing', async () => {
    const r = await performCheck(svc({ url: `${httpBase}/no-hello`, expected_keyword: 'hello' }), { allowPrivateNetworks: true });
    assert.equal(r.status, 'down');
    assert.equal(r.errorType, 'content');
    assert.match(r.errorMessage, /Expected keyword/);
  });

  test('respects keyword_case_sensitive', async () => {
    const caseSensitive = await performCheck(svc({ url: `${httpBase}/hello`, expected_keyword: 'Uptime', keyword_case_sensitive: true }), { allowPrivateNetworks: true });
    assert.equal(caseSensitive.status, 'up');
    const wrongCase = await performCheck(svc({ url: `${httpBase}/hello`, expected_keyword: 'uptime', keyword_case_sensitive: true }), { allowPrivateNetworks: true });
    assert.equal(wrongCase.status, 'down');
  });

  test('fails when forbidden keyword is present', async () => {
    const r = await performCheck(svc({ url: `${httpBase}/hello`, forbidden_keyword: 'Uptime' }), { allowPrivateNetworks: true });
    assert.equal(r.status, 'down');
    assert.equal(r.errorType, 'content');
    assert.match(r.errorMessage, /Forbidden keyword/);
  });

  test('passes when no keywords are configured (no crash on null body)', async () => {
    const r = await performCheck(svc({ method: 'HEAD' }), { allowPrivateNetworks: true });
    assert.equal(r.status, 'up');
  });

  test('keywordCheck pure helper edge cases', () => {
    assert.deepEqual(keywordCheck({}, null, true), { down: false });
    assert.deepEqual(keywordCheck({ expected_keyword: 'x' }, null, true).down, true);
    assert.deepEqual(keywordCheck({ expected_keyword: 'x' }, 'abc', false), { down: false });
  });
});

describe('HTTP request customization', () => {
  test('sends custom headers', async () => {
    const r = await performCheck(svc({ url: `${httpBase}/guarded-header`, headers: { 'x-custom': 'yes' } }), { allowPrivateNetworks: true });
    assert.equal(r.status, 'up');
  });

  test('fails when required header is not sent', async () => {
    const r = await performCheck(svc({ url: `${httpBase}/guarded-header` }), { allowPrivateNetworks: true });
    assert.equal(r.status, 'down');
    assert.equal(r.statusCode, 400);
  });

  test('sends basic auth credentials', async () => {
    const ok = await performCheck(svc({ url: `${httpBase}/auth`, auth_username: 'user', auth_password: 'secret' }), { allowPrivateNetworks: true });
    assert.equal(ok.status, 'up');
    const bad = await performCheck(svc({ url: `${httpBase}/auth`, auth_username: 'user', auth_password: 'wrong', expected_status_codes: [200] }), { allowPrivateNetworks: true });
    assert.equal(bad.status, 'down');
    assert.equal(bad.statusCode, 401);
  });

  test('sends a custom user agent', async () => {
    const r = await performCheck(svc({ url: `${httpBase}/guarded-agent`, user_agent: 'CustomAgent/1.0' }), { allowPrivateNetworks: true });
    assert.equal(r.status, 'up');
  });

  test('supports POST method with expected code', async () => {
    const r = await performCheck(svc({ url: `${httpBase}/echo`, method: 'POST', expected_status_codes: [200] }), { allowPrivateNetworks: true });
    assert.equal(r.status, 'up');
  });

  test('rejects POST when method not allowed returns 404', async () => {
    const r = await performCheck(svc({ url: `${httpBase}/nonexistent`, expected_status_codes: [204] }), { allowPrivateNetworks: true });
    assert.equal(r.status, 'down');
    assert.equal(r.errorType, 'http_status');
  });
});

describe('TCP checks', () => {
  test('marks an open port as up', async () => {
    const r = await performCheck({ type: 'tcp', host: '127.0.0.1', port: tcpPort, timeout_ms: 2000, degraded_threshold_ms: null }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'up');
    assert.ok(r.responseTime >= 0);
  });

  test('marks a closed port as down with connection refused', async () => {
    const r = await performCheck({ type: 'tcp', host: '127.0.0.1', port: 1, timeout_ms: 2000, degraded_threshold_ms: null }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'down');
    assert.equal(r.errorType, 'connection');
  });

  test('marks unresolved host as down with dns error', async () => {
    const r = await performCheck({ type: 'tcp', host: 'does-not-exist.invalid', port: 80, timeout_ms: 2000, degraded_threshold_ms: null }, { allowPrivateNetworks: false });
    assert.equal(r.status, 'down');
    assert.equal(r.errorType, 'dns');
  });
});

describe('DNS checks', () => {
  test('marks a resolvable host as up', async () => {
    const r = await performCheck({ type: 'dns', host: 'localhost', timeout_ms: 2000, degraded_threshold_ms: null }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'up');
    assert.ok(Array.isArray(r.addresses) && r.addresses.includes('127.0.0.1'));
  });

  test('fails when expected_ip does not match', async () => {
    const r = await performCheck({ type: 'dns', host: 'localhost', expected_ip: '203.0.113.9', timeout_ms: 2000, degraded_threshold_ms: null }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'down');
    assert.equal(r.errorType, 'dns_content');
    assert.match(r.errorMessage, /Expected IP/);
  });
});

describe('Ping checks', () => {
  test('parsePingOutput extracts latency and loss', () => {
    const lossy =
      '64 bytes from 8.8.8.8: icmp_seq=1 ttl=116 time=12.4 ms\n' +
      '64 bytes from 8.8.8.8: icmp_seq=2 ttl=116 time=13.1 ms\n' +
      '--- ping statistics ---\n' +
      '3 packets transmitted, 2 received, 33.3% packet loss, time 2002ms\n' +
      'rtt min/avg/max/mdev = 12.4/12.7/13.1/0.3 ms';
    const parsed = parsePingOutput(lossy);
    assert.equal(parsed.packetLoss, 33.3);
    assert.equal(parsed.avgMs, 13);
    const noTimes = parsePingOutput('3 packets transmitted, 0 received, 100% packet loss, time 2002ms');
    assert.equal(noTimes.packetLoss, 100);
    assert.equal(noTimes.avgMs, null);
    const single = parsePingOutput('64 bytes from x: icmp_seq=1 ttl=64 time=9.6 ms\n2 packets transmitted, 1 received, 50% packet loss');
    assert.equal(single.packetLoss, 50);
    assert.equal(single.avgMs, 10);
  });

  test('pings localhost successfully', async () => {
    const r = await performCheck({ type: 'ping', host: '127.0.0.1', timeout_ms: 8000, degraded_threshold_ms: null }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'up');
    assert.equal(r.packetLoss, 0);
    assert.ok(r.responseTime >= 0);
  });

  test('missing host is invalid', async () => {
    const r = await performCheck({ type: 'ping', host: '', timeout_ms: 1000, degraded_threshold_ms: null }, { allowPrivateNetworks: true });
    assert.equal(r.status, 'down');
    assert.equal(r.errorType, 'invalid');
  });
});

describe('SSL certificate inspection', () => {
  test('extracts expiry and reports untrusted certificate', async () => {
    const url = `https://127.0.0.1:${tlsPort}/`;
    const r = await performCheck(
      svc({ url, expected_status_codes: [200] }),
      { allowPrivateNetworks: true }
    );
    // The handshake may fail at the HTTP layer because the cert is self-signed,
    // but the certificate inspection must still populate cert data.
    assert.ok(r.certExpiresAt > Date.now(), 'cert expiry is populated and in the future');
    assert.ok(r.certError, 'cert error present for self-signed certificate');
  });
});
