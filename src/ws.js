'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

/**
 * WebSocket hub for live dashboard updates.
 *
 * Clients authenticate by connecting with ?token=<ws_token>, where the token
 * is issued by the (Basic-auth protected) /api/session endpoint. This works
 * around browsers not sending Authorization headers on WebSocket upgrades.
 */
function createWsHub({ server, token, onError }) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set();

  function isAuthorized(url) {
    const parsed = new URL(url, 'http://localhost');
    const given = parsed.searchParams.get('token');
    if (!token || !given) return false;
    // Hash both values so the comparison is constant-time and length-independent.
    const a = crypto.createHash('sha256').update(String(token)).digest();
    const b = crypto.createHash('sha256').update(String(given)).digest();
    return crypto.timingSafeEqual(a, b);
  }

  wss.on('connection', (socket, req) => {
    if (!isAuthorized(req.url)) {
      socket.close(4001, 'Unauthorized');
      return;
    }
    clients.add(socket);
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', (err) => {
      if (onError) onError(err);
      clients.delete(socket);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        clients.delete(socket);
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30000);
  if (heartbeat.unref) heartbeat.unref();

  function broadcast(type, payload) {
    const msg = JSON.stringify({ type, ...payload });
    for (const socket of clients) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(msg);
      }
    }
  }

  function clientCount() {
    return clients.size;
  }

  function shutdown() {
    clearInterval(heartbeat);
    for (const socket of clients) socket.close(1001, 'Server shutting down');
    wss.close();
  }

  return { broadcast, clientCount, shutdown };
}

module.exports = { createWsHub };
