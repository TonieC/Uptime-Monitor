'use strict';

const Incidents = {
  container: null,
  incidents: [],
  destroyed: false,
  loadToken: 0,

  mount(container) {
    this.container = container;
    this.destroyed = false;
    this.renderShell();
    this.load();
  },

  unmount() {
    this.destroyed = true;
  },

  renderShell() {
    this.container.innerHTML = '';
    const header = el('div', { class: 'view-header' }, [
      el('div', { class: 'view-title' }, [
        el('h1', null, 'Incidents'),
        el('p', null, 'Outage history across all monitored services'),
      ]),
    ]);
    const wrap = el('div', { class: 'section', id: 'incidents-table-wrap' });
    this.container.append(header, wrap);
  },

  async load() {
    const wrap = this.container.querySelector('#incidents-table-wrap');
    wrap.innerHTML = '';
    wrap.appendChild(
      el('div', { class: 'loading-state' }, [el('div', { class: 'spinner' })])
    );
    const token = ++this.loadToken;
    try {
      const data = await API.getIncidents(100);
      if (this.destroyed || token !== this.loadToken) return;
      this.incidents = data.incidents;
      this.render();
    } catch (err) {
      if (this.destroyed || token !== this.loadToken) return;
      wrap.innerHTML = '';
      wrap.appendChild(
        el('div', { class: 'error-state card' }, [
          el('div', { class: 'err-icon' }, '!'),
          el('h3', null, 'Could not load incidents'),
          el('p', null, err.message),
          el('button', { class: 'btn', onclick: () => this.load() }, 'Retry'),
        ])
      );
    }
  },

  render() {
    const wrap = this.container.querySelector('#incidents-table-wrap');
    wrap.innerHTML = '';
    if (this.incidents.length === 0) {
      wrap.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'empty-state' }, [
            el('div', { class: 'empty-icon' }, '\u2713'),
            el('h3', null, 'No incidents recorded'),
            el('p', null, 'When a monitored service goes down and an outage is confirmed, it will appear here.'),
          ]),
        ])
      );
      return;
    }
    wrap.appendChild(
      el('div', { class: 'card table-wrap' }, [
        el('table', { id: 'incidents-table' }, [
          el('thead', null, el('tr', null, [
            el('th', null, 'Status'),
            el('th', null, 'Service'),
            el('th', null, 'Started'),
            el('th', null, 'Ended'),
            el('th', null, 'Duration'),
            el('th', null, 'Checks'),
            el('th', null, 'Error'),
          ])),
          el('tbody', { id: 'incidents-tbody' }, this.incidents.map((inc) => el('tr', {
            class: 'clickable',
            onclick: () => navigate(`#/services/${inc.service_id}`),
          }, [
            el('td', null, incidentBadge(inc)),
            el('td', null, el('a', { href: `#/services/${inc.service_id}`, onclick: (e) => e.stopPropagation() }, inc.service_name)),
            el('td', null, fmtDateTime(inc.started_at)),
            el('td', null, inc.ended_at ? fmtDateTime(inc.ended_at) : '\u2014'),
            el('td', null, fmtDuration(inc.duration_seconds)),
            el('td', null, String(inc.check_count)),
            el('td', null, el('div', { class: 'err-msg', title: inc.error_message || '' }, inc.error_message || (inc.status_code ? `HTTP ${inc.status_code}` : '\u2014'))),
          ]))),
        ]),
      ])
    );
  },

  refresh() {
    API.getIncidents(100)
      .then((data) => {
        if (this.destroyed) return;
        this.incidents = data.incidents;
        this.render();
      })
      .catch(() => {});
  },
};
