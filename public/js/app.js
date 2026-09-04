'use strict';

const state = {
  ws: null,
  view: null,
  session: null,
};

const view = document.getElementById('view');
const liveBadge = document.getElementById('live-badge');

document.addEventListener('click', (event) => {
  const target = event.target.closest('#add-service-btn');
  if (!target) return;

  openServiceModal({
    onSaved: () => {
      if (state.view === Dashboard) Dashboard.load();
    },
  });
});

function toast(message, kind = 'info') {
  const root = document.getElementById('toast-root');
  const item = el('div', { class: `toast ${kind}` }, message);
  root.appendChild(item);
  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transition = 'opacity 0.3s ease';
    setTimeout(() => item.remove(), 320);
  }, 4000);
}

// ---- Browser notifications -------------------------------------------------

function browserNotificationsSupported() {
  return typeof window.Notification !== 'undefined';
}

function browserNotificationsEnabled() {
  try {
    return localStorage.getItem('um_browser_notif') === '1';
  } catch {
    return false;
  }
}

function updateNotifButton() {
  const label = document.getElementById('notif-btn-label');
  const btn = document.getElementById('notif-btn');
  if (!label || !btn) return;
  if (!browserNotificationsSupported()) {
    label.textContent = 'Alerts unsupported';
    btn.classList.add('disabled');
    return;
  }
  if (Notification.permission === 'granted' && browserNotificationsEnabled()) {
    label.textContent = 'Alerts on';
    btn.classList.add('on');
  } else {
    label.textContent = 'Enable alerts';
    btn.classList.remove('on');
  }
}

function setupNotifButton() {
  const btn = document.getElementById('notif-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!browserNotificationsSupported()) {
      toast('Browser notifications are not supported in this browser.', 'error');
      return;
    }
    if (Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast('Notifications blocked by the browser.', 'error');
        return;
      }
    }
    try {
      localStorage.setItem('um_browser_notif', '1');
    } catch {
      /* storage unavailable */
    }
    updateNotifButton();
    toast('Browser alerts enabled.', 'ok');
  });
}

function showBrowserNotification(title, body, kind = 'info') {
  if (!browserNotificationsSupported()) return;
  if (Notification.permission !== 'granted') return;
  if (!browserNotificationsEnabled()) return;
  try {
    const n = new Notification(title, { body, tag: 'um-alert', icon: './favicon.svg' });
    n.onclick = () => window.focus();
  } catch {
    /* notification rejected */
  }
}

function navigate(hash) {
  if (window.location.hash === hash) {
    renderRoute();
  } else {
    window.location.hash = hash;
  }
}

function normalizeCheck(check) {
  if (!check) return check;
  if ('response_time_ms' in check) return check;
  return {
    timestamp: check.timestamp,
    status: check.status,
    response_time_ms: check.responseTime ?? null,
    status_code: check.statusCode ?? null,
    error_type: check.errorType ?? null,
    error_message: check.errorMessage ?? null,
  };
}

function currentView() {
  const hash = window.location.hash || '#/';
  const m = hash.match(/^#\/services\/(\d+)/);
  if (m) return { name: 'detail', serviceId: Number(m[1]) };
  if (hash.startsWith('#/incidents')) return { name: 'incidents' };
  if (hash.startsWith('#/notifications')) return { name: 'notifications' };
  if (hash.startsWith('#/status-pages')) return { name: 'status-pages' };
  if (hash.startsWith('#/api-keys')) return { name: 'api-keys' };
  return { name: 'dashboard' };
}

function unmountCurrent() {
  if (state.view) {
    state.view.unmount();
    state.view = null;
  }
}

function renderRoute() {
  const route = currentView();
  unmountCurrent();
  document.querySelectorAll('.nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.route === (route.name === 'detail' ? 'dashboard' : route.name));
  });
  switch (route.name) {
    case 'detail':
      state.view = Detail;
      Detail.mount(view, route.serviceId);
      break;
    case 'incidents':
      state.view = Incidents;
      Incidents.mount(view);
      break;
    case 'notifications':
      state.view = Notifications;
      Notifications.mount(view);
      break;
    case 'status-pages':
      state.view = StatusPages;
      StatusPages.mount(view);
      break;
    case 'api-keys':
      state.view = ApiKeys;
      ApiKeys.mount(view);
      break;
    default:
      state.view = Dashboard;
      Dashboard.mount(view);
      break;
  }
}

function dispatchWs(msg) {
  switch (msg.type) {
    case 'check': {
      const check = normalizeCheck(msg.check);
      if (state.view === Dashboard) Dashboard.applyCheck({ serviceId: msg.serviceId, check });
      if (state.view === Detail) Detail.applyCheck({ serviceId: msg.serviceId, check });
      break;
    }
    case 'status-change':
      if (state.view === Dashboard) Dashboard.handleStatusChange(msg);
      if (state.view === Detail) Detail.handleStatusChange(msg);
      break;
    case 'incident-opened':
      showBrowserNotification('Monitor down', msg.service ? `${msg.service.name} is experiencing an outage.` : 'A monitor is down.', 'error');
      if (state.view === Dashboard) Dashboard.handleIncident();
      if (state.view === Detail) Detail.handleIncident();
      if (state.view === Incidents) Incidents.refresh();
      break;
    case 'incident-resolved':
      showBrowserNotification('Monitor recovered', msg.service ? `${msg.service.name} is back online.` : 'A monitor recovered.', 'ok');
      if (state.view === Dashboard) Dashboard.handleIncident();
      if (state.view === Detail) Detail.handleIncident();
      if (state.view === Incidents) Incidents.refresh();
      break;
    case 'service-changed':
      if (state.view === Dashboard) Dashboard.load(false);
      if (state.view === Incidents) Incidents.refresh();
      break;
    case 'service-deleted':
      if (state.view === Dashboard) Dashboard.load(false);
      if (state.view === Detail && Detail.serviceId === msg.serviceId) {
        navigate('#/');
      }
      break;
    default:
      break;
  }
}

async function init() {
  window.addEventListener('hashchange', renderRoute);
  setupNotifButton();
  updateNotifButton();

  try {
    const session = await API.getSession();
    state.session = session;

    state.ws = createWsClient({
      token: session.ws_token,
      onStatus: (status) => {
        liveBadge.className = `live-badge ${status}`;
        liveBadge.querySelector('span:last-child').textContent =
          status === 'online' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Reconnecting';
      },
      onMessage: dispatchWs,
    });
    state.ws.start();
  } catch (err) {
    if (err.status === 401) {
      liveBadge.className = 'live-badge offline';
      liveBadge.querySelector('span:last-child').textContent = 'Auth required';
      toast('Authentication required. Reload to sign in.', 'error');
    } else {
      liveBadge.className = 'live-badge offline';
      liveBadge.querySelector('span:last-child').textContent = 'Offline';
    }
  }

  renderRoute();
}

init();
