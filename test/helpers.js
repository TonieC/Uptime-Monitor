'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const config = require('../src/config');
const { createDb } = require('../src/db');
const { createServiceRepo } = require('../src/services');
const { createChecksRepo } = require('../src/checks');
const { createIncidentsRepo } = require('../src/incidents');
const { MonitoringWorker } = require('../src/worker');
const { createApp } = require('../src/server');

function makeConfig(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'um-test-'));
  return {
    ...config,
    dataDir: tmp,
    dbPath: path.join(tmp, 'test.db'),
    port: 0,
    host: '127.0.0.1',
    allowPrivateNetworks: true,
    authEnabled: false,
    adminUser: '',
    adminPassword: '',
    checkRetentionDays: 90,
    checkRetentionIntervalMinutes: 60,
    nodeEnv: 'test',
    ...overrides,
  };
}

async function startTestServer(overrides = {}) {
  const cfg = makeConfig(overrides);
  const db = createDb({ dbPath: cfg.dbPath });
  const servicesRepo = createServiceRepo(db);
  const checksRepo = createChecksRepo(db);
  const incidentsRepo = createIncidentsRepo(db);
  const worker = new MonitoringWorker({ db, servicesRepo, checksRepo, incidentsRepo, config: cfg });
  const app = createApp({ db, servicesRepo, checksRepo, incidentsRepo, worker, config: cfg });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    cfg,
    baseUrl,
    db,
    servicesRepo,
    checksRepo,
    incidentsRepo,
    worker,
    server,
    async close() {
      worker.shutdown();
      await new Promise((resolve) => server.close(resolve));
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

function request(baseUrl, method, pathname, body, headers = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function startProbeServer() {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url === '/fast') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }, 20);
    } else if (url === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('slow');
      }, 400);
    } else if (url === '/error') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom');
    } else if (url === '/redirect') {
      res.writeHead(302, { Location: '/fast' });
      res.end();
    } else if (url === '/redirect-loop') {
      res.writeHead(302, { Location: '/redirect-loop' });
      res.end();
    } else if (url === '/redirect-relative') {
      res.writeHead(302, { Location: 'fast' });
      res.end();
    } else if (url === '/hang') {
      /* never responds */
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url };
}

module.exports = { makeConfig, startTestServer, startProbeServer, request };
