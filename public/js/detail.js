'use strict';

const RANGES_OPTIONS = ['24h', '7d', '30d', '90d', '1y'];

const Detail = {
  container: null,
  serviceId: null,
  service: null,
  range: '24h',
  uptime: null,
  incidents: [],
  checks: [],
  maintenance: [],
  chart: null,
  destroyed: false,
  loadToken: 0,
  recentTimer: null,

  mount(container, serviceId) {
    this.container = container;
    this.serviceId = serviceId;
    this.destroyed = false;
    this.renderShell();
    this.load();
  },

  unmount() {
    this.destroyed = true;
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
    if (this.recentTimer) {
      clearInterval(this.recentTimer);
      this.recentTimer = null;
    }
  },

  renderShell() {
    this.container.innerHTML = '';
    const loading = el('div', { class: 'loading-state' }, [
      el('div', { class: 'spinner' }),
      el('div', { class: 'loading-text' }, 'Loading service\u2026'),
    ]);
    this.container.appendChild(loading);
  },

  renderError(err) {
    this.container.innerHTML = '';
    this.container.appendChild(
      el('div', { class: 'error-state card' }, [
        el('div', { class: 'err-icon' }, '!'),
        el('h3', null, 'Could not load service'),
        el('p', null, err.message),
        el('button', {
          class: 'btn',
          onclick: () => this.load(),
        }, 'Retry'),
      ])
    );
  },

  async load() {
    const token = ++this.loadToken;
    try {
      const [service, uptime, incidents, checks, maintenance] = await Promise.all([
        API.getService(this.serviceId),
        API.getUptime(this.serviceId, this.range),
        API.getServiceIncidents(this.serviceId, 100),
        API.getChecks(this.serviceId, 50),
        API.getServiceMaintenance(this.serviceId),
      ]);
      if (this.destroyed || token !== this.loadToken) return;
      this.service = service;
      this.uptime = uptime;
      this.incidents = incidents.incidents;
      this.checks = checks.checks;
      this.maintenance = maintenance.maintenance || [];
      this.render();
      this.recentTimer = setInterval(() => this.refreshRecent(), 15000);
    } catch (err) {
      if (this.destroyed || token !== this.loadToken) return;
      this.renderError(err);
    }
  },

  render() {
    const s = this.service;
    const container = this.container;
    container.innerHTML = '';

    const back = el('a', { href: '#/', class: 'back-link' }, '\u2190 Dashboard');
    const activeMaintenance = this.maintenance.find((m) => !m.ended_at) || null;
    const header = el('div', { class: 'detail-head' }, [
      el('div', null, [
        el('div', { class: 'detail-name' }, [
          el('div', { class: 'sc-avatar', dataset: { status: s.enabled ? s.status : 'unknown' } }, s.name.charAt(0)),
          el('div', null, [
            el('h1', null, s.name),
            el('div', { class: 'detail-url' }, [
              el('span', { class: 'monitor-type' }, monitorTypeLabel(s.type || 'http')),
              serviceTarget(s),
            ]),
          ]),
          pill(s.enabled ? s.status : 'disabled'),
        ]),
      ]),
      el('div', { class: 'detail-actions' }, [
        el('button', { class: 'btn', id: 'detail-check-now' }, '\u23f3 Check now'),
        el('button', { class: 'btn', id: 'detail-maintenance' }, activeMaintenance ? 'End maintenance' : 'Maintenance'),
        el('button', { class: 'btn', id: 'detail-toggle' }, s.enabled ? 'Pause' : 'Resume'),
        el('button', { class: 'btn', id: 'detail-edit' }, 'Edit'),
        el('button', { class: 'btn btn-danger', id: 'detail-delete' }, 'Delete'),
      ]),
    ]);

    container.append(back, header);

    const stats = this.uptime.stats;
    const last = this.uptime.last_check;
    const cards = [
      { label: 'Current response', value: fmtMs(last ? last.response_time_ms : null), sub: last ? fmtRelative(last.timestamp) : 'No checks yet', valueClass: rtClass(last ? last.response_time_ms : null) },
      { label: 'Average response', value: fmtMs(stats.avg_response_ms), sub: 'over selected range' },
      { label: 'Min response', value: fmtMs(stats.min_response_ms), sub: 'over selected range' },
      { label: 'Max response', value: fmtMs(stats.max_response_ms), sub: 'over selected range' },
      { label: 'Uptime', value: fmtPercent(stats.uptime_percent), sub: 'over selected range', valueClass: stats.uptime_percent != null && stats.uptime_percent < 100 ? 'rt-slow' : 'rt-fast' },
      { label: 'Checks', value: String(stats.checks), sub: 'over selected range' },
      { label: 'Incidents', value: String(s.incident_count), sub: `of which ${this.openIncidentCount()} open` },
      { label: 'Interval', value: `${s.interval_seconds}s`, sub: `timeout ${(s.timeout_ms / 1000).toFixed(0)}s` },
    ];
    const statGrid = el('div', { class: 'stat-grid' });
    for (const c of cards) {
      const valueAttrs = c.valueClass ? { class: `stat-value ${c.valueClass}` } : { class: 'stat-value' };
      statGrid.appendChild(
        el('div', { class: 'stat-card card' }, [
          el('div', { class: 'stat-label' }, c.label),
          el('div', valueAttrs, c.value),
          el('div', { class: 'stat-sub' }, c.sub),
        ])
      );
    }
    container.appendChild(statGrid);

    // Response time graph
    const chartWrap = el('div', { class: 'section' }, [
      el('div', { class: 'section-head' }, [
        el('h2', null, 'Response time'),
        this.rangeToggle(),
      ]),
      el('div', { class: 'card chart-wrap' }, [el('canvas', { class: 'chart-canvas' })]),
    ]);
    container.appendChild(chartWrap);
    const canvas = chartWrap.querySelector('canvas');
    const series = this.uptime.timeseries.points.map((p) => ({ t: p.t, value: p.value }));
    this.chart = createLineChart(canvas, series, {
      color: '#4f8cff',
      onHover: (point) => {
        this.chartTooltip(point);
      },
    });

    // Uptime history
    const history = el('div', { class: 'section' }, [
      el('div', { class: 'section-head' }, [el('h2', null, 'Uptime history')]),
      el('div', { class: 'card' }, [
        el('div', { class: 'chart-wrap' }, [
          el('div', { class: 'uptime-bar lg', id: 'detail-uptime-bar' }),
          el('div', { class: 'uptime-legend' }, [
            legendItem('up', 'Operational'),
            legendItem('degraded', 'Degraded'),
            legendItem('down', 'Outage'),
            legendItem('none', 'No data'),
          ]),
        ]),
      ]),
    ]);
    container.appendChild(history);
    const bar = history.querySelector('#detail-uptime-bar');
    renderUptimeBar(bar, this.uptime.segments);

    // Incidents
    container.appendChild(this.renderIncidentsSection());

    // Maintenance history
    if (this.maintenance.length > 0) {
      container.appendChild(this.renderMaintenanceSection());
    }

    // Recent checks
    container.appendChild(this.renderChecksSection());

    this.bindActions();
  },

  renderMaintenanceSection() {
    const sec = el('div', { class: 'section' }, [
      el('div', { class: 'section-head' }, [
        el('h2', null, `Maintenance windows (${this.maintenance.length})`),
      ]),
      el('div', { class: 'card table-wrap' }, [
        el('table', null, [
          el('thead', null, el('tr', null, [
            el('th', null, 'Started'),
            el('th', null, 'Ended'),
            el('th', null, 'Status'),
            el('th', null, 'Reason'),
          ])),
          el('tbody', null, this.maintenance.map((m) => el('tr', null, [
            el('td', { class: 'td-dim' }, fmtDateTime(m.started_at)),
            el('td', { class: 'td-dim' }, m.ended_at ? fmtDateTime(m.ended_at) : '\u2014'),
            el('td', null, pill(m.ended_at ? 'up' : 'maintenance')),
            el('td', null, el('div', { class: 'err-msg', title: m.reason || '' }, m.reason || '\u2014')),
          ]))),
        ]),
      ]),
    ]);
    return sec;
  },

  chartTooltip(point) {
    let tip = document.querySelector('#chart-tooltip');
    if (!point) {
      if (tip) tip.remove();
      return;
    }
    if (!tip) {
      tip = el('div', { class: 'popover', id: 'chart-tooltip' });
      document.body.appendChild(tip);
    }
    tip.innerHTML = '';
    tip.appendChild(el('div', { class: 'row' }, [
      el('span', { class: 'k' }, fmtDateTime(point.t)),
    ]));
    tip.appendChild(el('div', { class: 'row' }, [
      el('span', { class: 'k' }, 'Response'),
      el('span', { class: 'v' }, fmtMs(point.value)),
    ]));
  },

  rangeToggle() {
    const seg = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Time range' });
    for (const r of RANGES_OPTIONS) {
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
    await this.reloadUptime();
  },

  async reloadUptime() {
    try {
      const uptime = await API.getUptime(this.serviceId, this.range);
      if (this.destroyed) return;
      this.uptime = uptime;
      const series = uptime.timeseries.points.map((p) => ({ t: p.t, value: p.value }));
      if (this.chart) this.chart.update(series);
      const bar = this.container.querySelector('#detail-uptime-bar');
      if (bar) renderUptimeBar(bar, uptime.segments);
      this.rerenderStats();
    } catch {
      /* ignore */
    }
  },

  rerenderStats() {
    const s = this.service;
    const stats = this.uptime.stats;
    const last = this.uptime.last_check;
    const grid = this.container.querySelector('.stat-grid');
    if (!grid) return;
    const values = [
      fmtMs(last ? last.response_time_ms : null),
      fmtMs(stats.avg_response_ms),
      fmtMs(stats.min_response_ms),
      fmtMs(stats.max_response_ms),
      fmtPercent(stats.uptime_percent),
      String(stats.checks),
      String(s.incident_count),
      `${s.interval_seconds}s`,
    ];
    const vals = grid.querySelectorAll('.stat-value');
    vals.forEach((v, i) => {
      if (i < values.length) v.textContent = values[i];
    });
  },

  renderIncidentsSection() {
    const sec = el('div', { class: 'section', id: 'incidents-sec' }, [
      el('div', { class: 'section-head' }, [
        el('h2', null, `Incidents (${this.incidents.length})`),
      ]),
      el('div', { class: 'card table-wrap' }, [
        this.incidents.length === 0
          ? el('div', { class: 'empty-state' }, [
              el('h3', null, 'No incidents'),
              el('p', null, 'No downtime has been recorded for this service.'),
            ])
          : el('table', null, [
              el('thead', null, el('tr', null, [
                el('th', null, 'Status'),
                el('th', null, 'Started'),
                el('th', null, 'Ended'),
                el('th', null, 'Duration'),
                el('th', null, 'Checks'),
                el('th', null, 'Error'),
              ])),
              el('tbody', { id: 'incidents-tbody' }, this.incidents.map((inc) => el('tr', null, [
                el('td', null, incidentBadge(inc)),
                el('td', null, fmtDateTime(inc.started_at)),
                el('td', null, inc.ended_at ? fmtDateTime(inc.ended_at) : '\u2014'),
                el('td', null, fmtDuration(inc.duration_seconds)),
                el('td', null, String(inc.check_count)),
                el('td', null, el('div', { class: 'err-msg', title: inc.error_message || '' }, inc.error_message || (inc.status_code ? `HTTP ${inc.status_code}` : '\u2014'))),
              ]))),
            ]),
      ]),
    ]);
    return sec;
  },

  renderChecksSection() {
    const sec = el('div', { class: 'section', id: 'recent-checks-sec' }, [
      el('div', { class: 'section-head' }, [
        el('h2', null, `Recent checks (${this.checks.length})`),
      ]),
      el('div', { class: 'card table-wrap' }, [
        this.checks.length === 0
          ? el('div', { class: 'empty-state' }, [
              el('h3', null, 'No checks yet'),
              el('p', null, 'The first check will run shortly after the service is added.'),
            ])
          : el('table', null, [
              el('thead', null, el('tr', null, [
                el('th', null, 'Time'),
                el('th', null, 'Status'),
                el('th', null, 'Response'),
                el('th', null, 'HTTP'),
                el('th', null, 'Error'),
              ])),
              el('tbody', { id: 'recent-checks-tbody' }, this.checks.map((c) => el('tr', null, [
                el('td', { class: 'td-dim' }, fmtDateTime(c.timestamp)),
                el('td', null, pill(c.status)),
                el('td', null, el('span', { class: `mono ${rtClass(c.response_time_ms)}` }, fmtMs(c.response_time_ms))),
                el('td', { class: 'mono' }, c.status_code != null ? String(c.status_code) : '\u2014'),
                el('td', null, el('div', { class: 'err-msg', title: c.error_message || '' }, c.error_message || '\u2014')),
              ]))),
            ]),
      ]),
    ]);
    return sec;
  },

  openIncidentCount() {
    return this.incidents.filter((i) => !i.ended_at).length;
  },

  bindActions() {
    const s = this.service;
    const checkBtn = this.container.querySelector('#detail-check-now');
    const toggleBtn = this.container.querySelector('#detail-toggle');
    const editBtn = this.container.querySelector('#detail-edit');
    const deleteBtn = this.container.querySelector('#detail-delete');

    checkBtn.addEventListener('click', async () => {
      checkBtn.disabled = true;
      checkBtn.textContent = 'Checking\u2026';
      try {
        const { check } = await API.checkNow(s.id);
        this.uptime.last_check = check;
        this.uptime.stats = { ...this.uptime.stats, ...pickStats(check) };
        this.rerenderStats();
        this.refreshRecent();
        toast('Check complete', 'success');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        checkBtn.disabled = false;
        checkBtn.textContent = '\u23f3 Check now';
      }
    });

    toggleBtn.addEventListener('click', async () => {
      try {
        await API.updateService(s.id, { enabled: !s.enabled });
        toast(s.enabled ? 'Monitoring paused' : 'Monitoring resumed', 'success');
        await this.load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    const maintenanceBtn = this.container.querySelector('#detail-maintenance');
    if (maintenanceBtn) {
      maintenanceBtn.addEventListener('click', () => {
        const active = this.maintenance.find((m) => !m.ended_at);
        if (active) {
          this.endMaintenance(active);
        } else {
          this.openMaintenanceModal();
        }
      });
    }

    editBtn.addEventListener('click', () => {
      openServiceModal({
        service: s,
        onSaved: () => {
          this.load();
        },
      });
    });

    deleteBtn.addEventListener('click', async () => {
      if (!window.confirm(`Delete "${s.name}"? This removes all checks and incident history.`)) return;
      try {
        await API.deleteService(s.id);
        toast('Service deleted', 'success');
        navigate('#/');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  },

  async refreshRecent() {
    try {
      const data = await API.getChecks(this.serviceId, 50);
      if (this.destroyed) return;
      this.checks = data.checks;
      const sec = this.renderChecksSection();
      const old = document.getElementById('recent-checks-sec');
      if (old && old !== sec) old.replaceWith(sec);
    } catch {
      /* ignore */
    }
  },

  // ---- Live WebSocket updates -----------------------------------------

  applyCheck({ serviceId, check }) {
    if (serviceId !== this.serviceId || this.destroyed) return;
    if (this.uptime && this.uptime.last_check) {
      this.uptime.last_check = { ...this.uptime.last_check, ...check };
    }
    this.service.status = check.status;
    this.rerenderStats();
    this.prependCheck(check);
  },

  prependCheck(check) {
    const existing = this.checks.find((c) => c.timestamp === check.timestamp);
    if (existing) return;
    this.checks = [check, ...this.checks].slice(0, 50);
    const tbody = this.container.querySelector('#recent-checks-tbody');
    if (!tbody) return;
    const row = el('tr', null, [
      el('td', { class: 'td-dim' }, fmtDateTime(check.timestamp)),
      el('td', null, pill(check.status)),
      el('td', null, el('span', { class: `mono ${rtClass(check.response_time_ms)}` }, fmtMs(check.response_time_ms))),
      el('td', { class: 'mono' }, check.status_code != null ? String(check.status_code) : '\u2014'),
      el('td', null, el('div', { class: 'err-msg', title: check.error_message || '' }, check.error_message || '\u2014')),
    ]);
    tbody.prepend(row);
    while (tbody.children.length > 50) tbody.lastChild.remove();
  },

  handleStatusChange(msg) {
    if (msg.serviceId !== this.serviceId || this.destroyed) return;
    this.service.status = msg.to;
    this.reloadUptime();
  },

  handleIncident() {
    API.getServiceIncidents(this.serviceId, 100)
      .then((data) => {
        if (this.destroyed) return;
        this.incidents = data.incidents;
        const sec = this.renderIncidentsSection();
        const old = document.getElementById('incidents-sec');
        if (old && old !== sec) old.replaceWith(sec);
        this.service.incident_count = data.incidents.length;
      })
      .catch(() => {});
  },

  refreshServiceData() {
    API.getService(this.serviceId)
      .then((s) => {
        if (this.destroyed) return;
        this.service = s;
      })
      .catch(() => {});
  },

  async openMaintenanceModal() {
    const s = this.service;
    const root = document.getElementById('modal-root');
    root.innerHTML = '';

    const errorBox = el('div', { class: 'form-error hidden' });
    const durationInput = el('input', { type: 'number', id: 'mw-duration', min: '1', max: '1440', value: '60' });
    const reasonSelect = el('select', { id: 'mw-reason' });
    for (const r of maintenanceReasonOptions()) {
      reasonSelect.appendChild(el('option', { value: r }, r));
    }

    const form = el('form', { class: 'form-grid', id: 'maintenance-form' }, [
      errorBox,
      el('div', { class: 'field' }, [
        el('label', { for: 'mw-duration' }, 'Duration (minutes)'),
        durationInput,
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'mw-reason' }, 'Reason'),
        reasonSelect,
      ]),
      el('div', { class: 'full hint' }, 'While a maintenance window is active, failures are ignored, no alerts are sent, and downtime is excluded from statistics.'),
    ]);

    const foot = el('div', { class: 'modal-foot' }, [
      el('button', { type: 'button', class: 'btn', 'data-dismiss': '1' }, 'Cancel'),
      el('button', { type: 'submit', class: 'btn btn-primary', form: 'maintenance-form' }, 'Start maintenance'),
    ]);
    const modal = el('div', { class: 'modal' }, [
      el('div', { class: 'modal-head' }, [
        el('h2', null, `Maintenance for ${s.name}`),
        el('button', { type: 'button', class: 'modal-close', 'data-dismiss': '1', 'aria-label': 'Close' }, '×'),
      ]),
      el('div', { class: 'modal-body' }, form),
      foot,
    ]);
    const overlay = el('div', { class: 'modal-overlay' }, modal);
    root.appendChild(overlay);

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-dismiss')) overlay.remove();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const minutes = Number(durationInput.value);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        errorBox.textContent = 'Duration must be an integer between 1 and 1440 minutes.';
        errorBox.classList.remove('hidden');
        return;
      }
      const until = Date.now() + minutes * 60000;
      const submitBtn = foot.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await API.startMaintenance(s.id, until, reasonSelect.value);
        overlay.remove();
        toast('Maintenance started. Alerts are paused during this window.', 'success');
        this.load();
      } catch (err) {
        submitBtn.disabled = false;
        errorBox.textContent = err?.message || 'Could not start maintenance.';
        errorBox.classList.remove('hidden');
      }
    });
  },

  async endMaintenance(window) {
    if (!window.confirm('End this maintenance window now? Failures will count again immediately.')) return;
    try {
      await API.endMaintenance(window.id);
      toast('Maintenance ended.', 'success');
      this.load();
    } catch (err) {
      toast(err?.message || 'Could not end maintenance.', 'error');
    }
  },
};

function legendItem(cls, label) {
  return el('span', { class: 'item' }, [
    el('span', { class: `swatch sw-${cls}` }),
    label,
  ]);
}

function incidentBadge(inc) {
  const cls = inc.ended_at ? 'resolved' : 'open';
  return el('span', { class: `incident-badge ${cls}` }, inc.ended_at ? 'Resolved' : 'Open');
}

function pickStats(check) {
  return {
    avg_response_ms: check.response_time_ms,
    min_response_ms: check.response_time_ms,
    max_response_ms: check.response_time_ms,
  };
}

function serviceTarget(service) {
  if (service.type === 'http') {
    return service.method === 'GET' ? service.url : `${service.method} ${service.url}`;
  }
  if (service.port) return `${service.host}:${service.port}`;
  if (service.expected_ip) return `${service.host} \u2192 ${service.expected_ip}`;
  return service.host || '';
}

function maintenanceReasonOptions() {
  return ['Planned upgrade', 'Scheduled maintenance', 'Configuration change', 'DNS migration', 'Manual'];
}
