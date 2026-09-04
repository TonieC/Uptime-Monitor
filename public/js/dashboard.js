'use strict';

const RANGES = ['24h', '7d', '30d', '90d', '1y'];

const Dashboard = {
  container: null,
  range: '24h',
  services: [],
  segments: new Map(),
  stats: new Map(),
  summary: null,
  loadToken: 0,
  refreshTimer: null,
  destroyed: false,

  mount(container) {
    this.container = container;
    this.destroyed = false;
    this.renderShell();
    this.load();
    this.refreshTimer = setInterval(() => this.load(false), 60000);
  },

  unmount() {
    this.destroyed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  },

  renderShell() {
    const header = el('div', { class: 'view-header' }, [
      el('div', { class: 'view-title' }, [
        el('h1', null, 'Dashboard'),
        el('p', null, 'Monitor the health of your websites and APIs'),
      ]),
      el('div', { class: 'view-actions' }, [
        this.rangeToggle(),
        el('button', { class: 'btn btn-primary', id: 'dashboard-add' }, [
          el('span', null, '+'),
          el('span', null, 'Add service'),
        ]),
      ]),
    ]);

    const summaryRow = el('div', { class: 'stat-grid', id: 'summary-row' });
    const grid = el('div', { class: 'service-grid', id: 'service-grid' });
    const loading = el('div', { class: 'loading-state' }, [
      el('div', { class: 'spinner' }),
      el('div', { class: 'loading-text' }, 'Loading services\u2026'),
    ]);

    this.container.innerHTML = '';
    this.container.append(header, summaryRow, grid, loading);

    header.querySelector('#dashboard-add').addEventListener('click', () => {
      openServiceModal({ onSaved: () => this.load() });
    });
  },

  rangeToggle() {
    const seg = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Time range' });
    for (const r of RANGES) {
      const btn = el('button', { type: 'button', dataset: { range: r } }, r.toUpperCase());
      if (r === this.range) btn.classList.add('active');
      btn.addEventListener('click', () => this.setRange(r));
      seg.appendChild(btn);
    }
    return seg;
  },

  async setRange(range) {
    if (range === this.range) return;
    this.range = range;
    this.container.querySelectorAll('.segmented button').forEach((b) => {
      b.classList.toggle('active', b.dataset.range === range);
    });
    this.load(false);
  },

  async load(showSpinner = true) {
    const token = ++this.loadToken;
    try {
      const [services, summary] = await Promise.all([API.listServices(), API.getSummary()]);
      if (this.destroyed || token !== this.loadToken) return;
      this.services = services;
      this.summary = summary;
      this.renderSummary();
      this.renderGrid();
    } catch (err) {
      if (this.destroyed || token !== this.loadToken) return;
      this.renderError(err);
    }
  },

  renderSummary() {
    const row = this.container.querySelector('#summary-row');
    if (!row || !this.summary) return;
    const s = this.summary;
    const cards = [
      { label: 'Services', value: s.services_total, cls: '' },
      { label: 'Operational', value: s.services_up, cls: 'ok', color: 'var(--green)' },
      { label: 'Degraded', value: s.services_degraded, cls: 'warn', color: 'var(--yellow)' },
      { label: 'Outages', value: s.services_down, cls: 'bad', color: 'var(--red)' },
      { label: 'Open incidents', value: s.incidents_open, cls: 'bad', color: 'var(--red)' },
    ];
    row.innerHTML = '';
    for (const c of cards) {
      const valStyle = c.color ? `style="color: ${c.color}"` : '';
      row.appendChild(
        el('div', { class: 'stat-card card' }, [
          el('div', { class: 'stat-label' }, c.label),
          el('div', { class: 'stat-value', ...(c.color ? { style: `color: ${c.color}` } : {}) }, String(c.value)),
        ])
      );
    }
  },

  renderGrid() {
    const grid = this.container.querySelector('#service-grid');
    const loading = this.container.querySelector('.loading-state');
    if (loading) loading.remove();
    if (!grid) return;

    if (this.services.length === 0) {
      grid.innerHTML = '';
      grid.appendChild(
        el('div', { class: 'empty-state card' }, [
          el('div', { class: 'empty-icon' }, '{}'),
          el('h3', null, 'No services being monitored'),
          el('p', null, 'Add your first website or API to start tracking uptime, response times, and incidents.'),
        ])
      );
      return;
    }

    grid.innerHTML = '';
    for (const service of this.services) {
      grid.appendChild(this.renderCard(service));
    }
    // Lazy-fetch segments for each service
    for (const service of this.services) {
      this.fetchSegments(service.id);
    }
  },

  async fetchSegments(serviceId) {
    try {
      const data = await API.getUptime(serviceId, this.range);
      if (this.destroyed || this.services.length === 0) return;
      const service = this.services.find((s) => s.id === serviceId);
      if (!service) return;
      this.segments.set(serviceId, data.segments);
      this.stats.set(serviceId, data.stats);
      const card = this.container.querySelector(`.service-card[data-id="${serviceId}"]`);
      if (card) this.renderCardInto(card, service, data.segments, data.stats);
    } catch {
      /* segments are non-critical; card still renders */
    }
  },

  renderCard(service) {
    const card = el('div', { class: 'service-card card', dataset: { id: service.id }, tabindex: '0' });
    this.renderCardInto(card, service, this.segments.get(service.id) || null, this.stats.get(service.id) || null);
    card.addEventListener('click', () => navigate(`#/services/${service.id}`));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') navigate(`#/services/${service.id}`);
    });
    return card;
  },

  renderCardInto(card, service, segments, stats) {
    const status = service.enabled ? service.status : 'disabled';
    const lastCheck = service.last_check || null;
    const uptimePct =
      stats && stats.uptime_percent != null ? stats.uptime_percent : service.uptime_percent_30d;
    const responseTime = lastCheck ? lastCheck.response_time_ms : null;

    const barWrap = el('div', { class: 'sc-bar' });
    const bar = el('div', { class: 'uptime-bar sm' });
    barWrap.appendChild(bar);

    const avatar = el('div', {
      class: 'sc-avatar',
      dataset: { status: service.enabled ? service.status : 'unknown' },
    }, (service.name || '?').charAt(0));

    const header = el('div', { class: 'sc-header' }, [
      avatar,
      el('div', { class: 'sc-title' }, [
        el('div', { class: 'sc-name' }, service.name),
        el('div', { class: 'sc-url' }, [
          el('span', { class: 'monitor-type' }, monitorTypeLabel(service.type || 'http')),
          service.method === 'GET' ? service.url : `${service.method} ${service.url}`,
        ]),
      ]),
      pill(status),
    ]);

    const statsGrid = el('div', { class: 'sc-stats' }, [
      el('div', { class: 'sc-stat' }, [
        el('span', { class: 'label' }, 'Uptime'),
        el('span', { class: `value ${uptimePct == null ? 'muted' : ''}` }, fmtPercent(uptimePct)),
      ]),
      el('div', { class: 'sc-stat' }, [
        el('span', { class: 'label' }, 'Response'),
        el('span', { class: `value ${rtClass(responseTime)}` }, fmtMs(responseTime)),
      ]),
      el('div', { class: 'sc-stat' }, [
        el('span', { class: 'label' }, 'Last check'),
        el('span', { class: 'value' }, fmtRelative(lastCheck ? lastCheck.timestamp : null)),
      ]),
      el('div', { class: 'sc-stat' }, [
        el('span', { class: 'label' }, 'Incidents'),
        el('span', { class: `value ${service.incident_count ? '' : 'muted'}` }, String(service.incident_count)),
      ]),
    ]);

    card.innerHTML = '';
    card.append(header, statsGrid, barWrap);

    if (segments) {
      renderUptimeBar(bar, segments);
    } else {
      bar.appendChild(el('div', { class: 'seg seg-none' }));
    }
  },

  // ---- Live WebSocket updates -----------------------------------------

  applyCheck({ serviceId, check }) {
    const service = this.services.find((s) => s.id === serviceId);
    if (!service) return;
    service.last_check = { ...service.last_check, ...check };
    service.status = check.status;
    this.services = this.services.map((s) => (s.id === serviceId ? service : s));
    const card = this.container.querySelector(`.service-card[data-id="${serviceId}"]`);
    if (card) this.renderCardInto(card, service, this.segments.get(serviceId) || null, this.stats.get(serviceId) || null);
  },

  async handleStatusChange(msg) {
    const service = this.services.find((s) => s.id === msg.serviceId);
    if (!service) return;
    service.status = msg.to;
    // Refetch segments so the bar reflects the new state
    await this.fetchSegments(msg.serviceId);
    const card = this.container.querySelector(`.service-card[data-id="${msg.serviceId}"]`);
    if (card) this.renderCardInto(card, service, this.segments.get(service.id) || null, this.stats.get(service.id) || null);
    try {
      this.summary = await API.getSummary();
      this.renderSummary();
    } catch {
      /* ignore */
    }
  },

  handleIncident() {
    // Keep counts fresh; refetch summary when an incident opens/resolves.
    API.getSummary().then((s) => {
      if (!this.destroyed) {
        this.summary = s;
        this.renderSummary();
      }
    }).catch(() => {});
  },

  async refreshService(serviceId) {
    try {
      const service = await API.getService(serviceId);
      if (this.destroyed) return;
      const idx = this.services.findIndex((s) => s.id === serviceId);
      if (idx >= 0) this.services[idx] = service;
      else this.services.push(service);
      const card = this.container.querySelector(`.service-card[data-id="${serviceId}"]`);
      if (card) {
        this.renderCardInto(card, service, this.segments.get(serviceId) || null, this.stats.get(serviceId) || null);
      }
      await this.fetchSegments(serviceId);
    } catch {
      /* ignore */
    }
  },

  renderError(err) {
    const grid = this.container.querySelector('#service-grid');
    const loading = this.container.querySelector('.loading-state');
    if (loading) loading.remove();
    if (!grid) return;
    grid.innerHTML = '';
    grid.appendChild(
      el('div', { class: 'error-state card' }, [
        el('div', { class: 'err-icon' }, '!'),
        el('h3', null, 'Could not load services'),
        el('p', null, err.message),
        el('button', { class: 'btn', onclick: () => this.load() }, 'Retry'),
      ])
    );
  },
};
