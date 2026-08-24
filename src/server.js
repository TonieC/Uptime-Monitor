'use strict';

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const express = require('express');

const config = require('./config');
const { createDb } = require('./db');
const { createServiceRepo } = require('./services');
const { createChecksRepo } = require('./checks');
const { createIncidentsRepo } = require('./incidents');
const { MonitoringWorker } = require('./worker');
const { createApi } = require('./api');
const { createWsHub } = require('./ws');
const { securityHeaders } = require('./security');

const WS_TOKEN = crypto.randomBytes(24).toString('hex');

// Constant-time string comparison that does not depend on input length.
// Hashes first so timingSafeEqual always receives equal-length buffers.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function basicAuth(config) {
  return function authMiddleware(req, res, next) {
    if (!config.authEnabled) return next();
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme !== 'Basic' || !encoded) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Uptime Monitor"');
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }
    let decoded;
    try {
      decoded = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }
    const idx = decoded.indexOf(':');
    const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
    const userOk = safeEqual(user, config.adminUser);
    const passOk = safeEqual(pass, config.adminPassword);
    if (!userOk || !passOk) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Uptime Monitor"');
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }
    next();
  };
}

function createApp(deps) {
  const { config } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '64kb' }));
  app.use(basicAuth(config));
  app.use((req, res, next) => {
    req.wsToken = WS_TOKEN;
    next();
  });

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { index: 'index.html', maxAge: config.nodeEnv === 'production' ? '1h' : 0 }));

  const api = createApi(deps);
  app.use('/api', api);

  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: { message: 'Not found', code: 'not_found' } });
    } else {
      res.sendFile(path.join(publicDir, 'index.html'));
    }
  });

  return app;
}

async function main() {
  const db = createDb();
  const servicesRepo = createServiceRepo(db);
  const checksRepo = createChecksRepo(db);
  const incidentsRepo = createIncidentsRepo(db);

  const worker = new MonitoringWorker({ db, servicesRepo, checksRepo, incidentsRepo, config });
  worker.on('error', (err) => {
    console.error('[worker]', err);
  });

  const deps = { db, servicesRepo, checksRepo, incidentsRepo, worker, config };
  const app = createApp(deps);
  const server = http.createServer(app);

  const wsHub = createWsHub({
    server,
    token: WS_TOKEN,
    onError: (err) => console.error('[ws]', err.message),
  });

  const broadcastMap = {
    check: (payload) => wsHub.broadcast('check', payload),
    'status-change': (payload) => wsHub.broadcast('status-change', payload),
    'incident-opened': (payload) => wsHub.broadcast('incident-opened', payload),
    'incident-resolved': (payload) => wsHub.broadcast('incident-resolved', payload),
    'service-changed': (payload) => wsHub.broadcast('service-changed', payload),
    'service-deleted': (payload) => wsHub.broadcast('service-deleted', payload),
  };
  for (const [event, handler] of Object.entries(broadcastMap)) {
    worker.on(event, handler);
  }

  // Attach ws_token to the session endpoint context.

  server.listen(config.port, config.host, () => {
    console.log(`Uptime Monitor listening on http://${config.host}:${config.port}`);
    if (config.authEnabled) console.log('Basic auth enabled');
    if (config.allowPrivateNetworks) console.log('Private networks monitoring enabled');
  });

  worker.start();

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down gracefully...`);
    worker.shutdown();
    wsHub.shutdown();
    server.close(() => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to start Uptime Monitor:', err);
    process.exit(1);
  });
}

module.exports = { createApp, main, WS_TOKEN };
