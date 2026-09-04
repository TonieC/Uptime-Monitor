'use strict';

function spEl(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;
      if (key === 'class') node.className = value;
      else node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.appendChild(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function spFmtRelative(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function spFmtDateTime(ts) {
  const d = new Date(ts);
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

function spFmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function spFmtPercent(p) {
  if (p === null || p === undefined) return '—';
  return `${p.toFixed(2)}%`;
}

function spStatusLabel(status) {
  switch (status) {
    case 'up':
      return 'Operational';
    case 'degraded':
      return 'Degraded';
    case 'down':
      return 'Outage';
    case 'maintenance':
      return 'Maintenance';
    case 'unknown':
      return 'No data';
    default:
      return 'Unknown';
  }
}

async function spLoad() {
  const slug = window.location.pathname.replace(/^\/status\//, '').replace(/\/+$/, '');
  const brand = document.getElementById('sp-brand');
  const overall = document.getElementById('sp-overall');
  const desc = document.getElementById('sp-description');
  const monitorsCard = document.getElementById('sp-monitors');
  const incidentsCard = document.getElementById('sp-incidents');

  let data;
  try {
    const res = await fetch(`/api/public/status/${encodeURIComponent(slug)}`);
    if (res.status === 404) throw new Error('not-found');
    if (!res.ok) throw new Error('server-error');
    data = await res.json();
  } catch (err) {
    document.title = 'Status page not found';
    brand.textContent = 'Uptime Monitor';
    overall.innerHTML = '';
    overall.appendChild(
      spEl('div', { class: 'sp-overall-badge sp-badge-error' }, 'Unavailable')
    );
    monitorsCard.innerHTML = '';
    monitorsCard.appendChild(
      spEl('div', { class: 'sp-error' }, [
        spEl('h2', null, 'Status page not found'),
        spEl('p', null, 'This status page does not exist or is not public.'),
      ])
    );
    incidentsCard.style.display = 'none';
    desc.style.display = 'none';
    return;
  }

  document.title = `${data.title} — Status`;
  if (data.branding && data.branding.title) {
    brand.textContent = data.branding.title;
  } else {
    brand.textContent = data.title;
  }

  const spinner = document.getElementById('sp-spinner');
  if (spinner) spinner.remove();

  // Overall status banner.
  const overallText =
    data.overall_status === 'up'
      ? 'All systems operational'
      : data.overall_status === 'unknown'
        ? 'No monitoring data yet'
        : 'Some systems are having issues';
  overall.appendChild(
    spEl(
      'div',
      { class: `sp-overall-badge sp-badge-${data.overall_status}` },
      overallText
    )
  );

  // Description.
  desc.innerHTML = '';
  if (data.description) {
    desc.appendChild(spEl('p', null, data.description));
  }

  // Monitors list.
  monitorsCard.innerHTML = '';
  monitorsCard.appendChild(spEl('h2', null, 'System status'));
  if (data.monitors.length === 0) {
    monitorsCard.appendChild(spEl('p', { class: 'sp-muted' }, 'No monitors are published on this page.'));
  }
  const list = spEl('ul', { class: 'sp-monitor-list' });
  for (const m of data.monitors) {
    const li = spEl('li', { class: 'sp-monitor' }, [
      spEl('div', { class: 'sp-monitor-row' }, [
        spEl('span', { class: `sp-dot sp-dot-${m.status}` }),
        spEl('div', { class: 'sp-monitor-name' }, [
          spEl('strong', null, m.name),
          spEl('span', { class: 'sp-muted' }, m.target || ''),
        ]),
        spEl('span', { class: `sp-badge sp-badge-${m.status}` }, spStatusLabel(m.status)),
      ]),
      spEl('div', { class: 'sp-monitor-meta' }, [
        spEl('span', null, `Uptime 24h: ${spFmtPercent(m.uptime_24h)}`),
        spEl('span', null, `Uptime 30d: ${spFmtPercent(m.uptime_30d)}`),
        spEl('span', null, `Uptime 90d: ${spFmtPercent(m.uptime_90d)}`),
        spEl('span', null, `Avg response: ${m.avg_response_ms_24h == null ? '—' : `${m.avg_response_ms_24h} ms`}`),
        spEl('span', null, `Last check: ${m.last_check ? spFmtRelative(m.last_check.timestamp) : '—'}`),
      ]),
    ]);
    list.appendChild(li);
  }
  monitorsCard.appendChild(list);

  // Recent incidents.
  incidentsCard.innerHTML = '';
  incidentsCard.appendChild(spEl('h2', null, 'Recent incidents'));
  if (data.incidents.length === 0) {
    incidentsCard.appendChild(spEl('p', { class: 'sp-muted' }, 'No incidents in the selected period.'));
  } else {
    const table = spEl('table', { class: 'sp-table' }, [
      spEl('thead', null, spEl('tr', null, [
        spEl('th', null, 'Monitor'),
        spEl('th', null, 'Started'),
        spEl('th', null, 'Ended'),
        spEl('th', null, 'Duration'),
        spEl('th', null, 'Reason'),
      ])),
    ]);
    const tbody = spEl('tbody');
    for (const inc of data.incidents) {
      const row = spEl('tr', null, [
        spEl('td', null, inc.monitor_name || `#${inc.monitor_id}`),
        spEl('td', null, spFmtDateTime(inc.started_at)),
        spEl('td', null, inc.ended_at ? spFmtDateTime(inc.ended_at) : '—'),
        spEl('td', null, spFmtDuration(inc.duration_seconds)),
        spEl('td', { class: 'sp-muted' }, inc.error_message || (inc.status_code ? `HTTP ${inc.status_code}` : '—')),
      ]);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    incidentsCard.appendChild(table);
  }
}

spLoad();
