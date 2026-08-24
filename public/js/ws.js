'use strict';

/**
 * WebSocket client with automatic reconnection and exponential backoff.
 * Messages are dispatched to registered handlers by type.
 */
function createWsClient({ token, onStatus, onMessage }) {
  let socket = null;
  let closed = false;
  let attempts = 0;
  let reconnectTimer = null;
  let status = 'connecting';

  const handlers = new Map();

  function setStatus(next) {
    if (next === status) return;
    status = next;
    if (onStatus) onStatus(status);
  }

  function connect() {
    if (closed) return;
    setStatus('connecting');
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
    socket = new WebSocket(url);

    socket.onopen = () => {
      attempts = 0;
      setStatus('online');
    };

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const handler = handlers.get(msg.type);
      if (handler) handler(msg);
      if (onMessage) onMessage(msg);
    };

    socket.onclose = () => {
      setStatus('offline');
      if (closed) return;
      const delay = Math.min(30000, 1000 * 2 ** attempts);
      attempts += 1;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, delay);
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  return {
    on(type, handler) {
      handlers.set(type, handler);
    },
    start() {
      closed = false;
      connect();
    },
    stop() {
      closed = true;
      clearTimeout(reconnectTimer);
      if (socket) {
        socket.onclose = null;
        socket.close();
        socket = null;
      }
      setStatus('offline');
    },
    getStatus: () => status,
  };
}
