'use strict';

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);

  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;

      if (key === 'class') {
        node.className = value;
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value);
      } else if (key === 'style') {
        // Do not create inline styles.
        // CSP: style-src 'self' blocks style attributes.
        // Use CSS classes instead.
        continue;
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value);
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.appendChild(
      child.nodeType ? child : document.createTextNode(String(child))
    );
  }

  return node;
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtNumber(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtPercent(p) {
  if (p === null || p === undefined) return '—';
  return `${p.toFixed(2)}%`;
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';

  if (seconds < 60) {
    return `${seconds}s`;
  }

  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }

  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  const d = Math.floor(seconds / 86400);
  const h = Math.round((seconds % 86400) / 3600);

  return h ? `${d}d ${h}h` : `${d}d`;
}

function fmtClock(ts) {
  const d = new Date(ts);

  return d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtDateTime(ts) {
  const d = new Date(ts);

  const date = d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });

  const time = d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return `${date}, ${time}`;
}

function fmtRelative(ts) {
  if (!ts) return '—';

  const diff = Date.now() - ts;

  if (diff < 0) return 'just now';
  if (diff < 10000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;

  return `${Math.floor(diff / 86400000)}d ago`;
}

function rtClass(ms) {
  if (ms === null || ms === undefined) return 'muted';
  if (ms < 300) return 'rt-fast';
  if (ms < 1000) return 'rt-mid';
  return 'rt-slow';
}

function statusLabel(status) {
  switch (status) {
    case 'up':
      return 'Operational';
    case 'degraded':
      return 'Degraded';
    case 'down':
      return 'Outage';
    case 'unknown':
      return 'No data';
    default:
      return 'Disabled';
  }
}

function statusClass(status) {
  switch (status) {
    case 'up':
      return 'pill-up';
    case 'degraded':
      return 'pill-degraded';
    case 'down':
      return 'pill-down';
    case 'unknown':
      return 'pill-unknown';
    default:
      return 'pill-disabled';
  }
}

function pill(status) {
  return el('span', { class: `pill ${statusClass(status)}` }, [
    el('span', { class: 'dot' }),
    statusLabel(status),
  ]);
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}