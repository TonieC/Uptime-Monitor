'use strict';

const ApiKeys = {
  container: null,
  keys: [],
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
        el('h1', null, 'API keys'),
        el('p', null, 'Authenticate to the REST API from scripts with X-API-Key'),
      ]),
      el('div', { class: 'view-actions' }, [
        el('button', { class: 'btn btn-primary', id: 'add-api-key-btn' }, [
          el('span', null, '+'),
          el('span', null, 'Create API key'),
        ]),
      ]),
    ]);
    const wrap = el('div', { class: 'section', id: 'api-keys-wrap' });
    this.container.append(header, wrap);
    this.container.querySelector('#add-api-key-btn').addEventListener('click', () => this.openCreate());
  },

  async load() {
    const wrap = this.container.querySelector('#api-keys-wrap');
    wrap.innerHTML = '';
    wrap.appendChild(el('div', { class: 'loading-state' }, [el('div', { class: 'spinner' })]));
    const token = ++this.loadToken;
    try {
      const data = await API.listApiKeys();
      if (this.destroyed || token !== this.loadToken) return;
      this.keys = data.api_keys || [];
      this.render();
    } catch (err) {
      if (this.destroyed || token !== this.loadToken) return;
      wrap.innerHTML = '';
      wrap.appendChild(
        el('div', { class: 'error-state card' }, [
          el('div', { class: 'err-icon' }, '!'),
          el('h3', null, 'Could not load API keys'),
          el('p', null, err.message),
          el('button', { class: 'btn', onclick: () => this.load() }, 'Retry'),
        ])
      );
    }
  },

  render() {
    const wrap = this.container.querySelector('#api-keys-wrap');
    wrap.innerHTML = '';
    if (this.keys.length === 0) {
      wrap.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'empty-state' }, [
            el('div', { class: 'empty-icon' }, '{}'),
            el('h3', null, 'No API keys'),
            el('p', null, 'Create an API key to access the REST API from your own scripts using the X-API-Key header.'),
          ]),
        ])
      );
      return;
    }
    wrap.appendChild(
      el('div', { class: 'card table-wrap' }, [
        el('table', null, [
          el('thead', null, el('tr', null, [
            el('th', null, 'Name'),
            el('th', null, 'Prefix'),
            el('th', null, 'Status'),
            el('th', null, 'Last used'),
            el('th', null, 'Created'),
            el('th', null, 'Actions'),
          ])),
          el('tbody', null, this.keys.map((k) => this.renderRow(k))),
        ]),
      ])
    );
  },

  renderRow(k) {
    const enabled = el('span', { class: `pill ${k.enabled ? 'pill-up' : 'pill-disabled'}` }, k.enabled ? 'Active' : 'Disabled');
    return el('tr', null, [
      el('td', null, el('strong', null, k.name)),
      el('td', null, el('code', { class: 'key-prefix' }, `${k.key_prefix}\u2026`)),
      el('td', null, enabled),
      el('td', null, k.last_used_at ? fmtRelative(k.last_used_at) : 'Never'),
      el('td', null, fmtDateTime(k.created_at)),
      el('td', { class: 'row-actions' }, [
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => this.toggle(k) }, k.enabled ? 'Disable' : 'Enable'),
        el('button', { class: 'btn btn-sm danger', type: 'button', onclick: () => this.remove(k) }, 'Delete'),
      ]),
    ]);
  },

  async toggle(k) {
    try {
      await API.toggleApiKey(k.id, !k.enabled);
      this.load();
    } catch (err) {
      toast(err?.message || 'Could not update API key.', 'error');
    }
  },

  async remove(k) {
    if (!window.confirm(`Delete API key "${k.name}"? This cannot be undone.`)) return;
    try {
      await API.deleteApiKey(k.id);
      this.load();
    } catch (err) {
      toast(err?.message || 'Could not delete API key.', 'error');
    }
  },

  openCreate() {
    const root = document.getElementById('modal-root');
    root.innerHTML = '';
    const errorBox = el('div', { class: 'form-error hidden' });
    const input = el('input', { type: 'text', id: 'api-key-name', name: 'api-key-name', placeholder: 'e.g. deploy script' });

    const form = el('form', { class: 'form-grid', id: 'api-key-form' }, [
      errorBox,
      el('div', { class: 'field full' }, [
        el('label', { for: 'api-key-name' }, 'Key name'),
        input,
      ]),
    ]);

    const foot = el('div', { class: 'modal-foot' }, [
      el('button', { type: 'button', class: 'btn', 'data-dismiss': '1' }, 'Cancel'),
      el('button', { type: 'submit', class: 'btn btn-primary', form: 'api-key-form' }, 'Create key'),
    ]);
    const modal = el('div', { class: 'modal' }, [
      el('div', { class: 'modal-head' }, [
        el('h2', null, 'Create API key'),
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
      const name = input.value.trim();
      if (!name) {
        errorBox.textContent = 'Name is required.';
        errorBox.classList.remove('hidden');
        return;
      }
      const submitBtn = foot.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const res = await API.createApiKey(name);
        overlay.remove();
        this.load();
        this.showKey(res.api_key);
      } catch (err) {
        submitBtn.disabled = false;
        errorBox.textContent = err?.message || 'Failed to create API key.';
        errorBox.classList.remove('hidden');
      }
    });
  },

  showKey(apiKey) {
    const root = document.getElementById('modal-root');
    root.innerHTML = '';
    const valueBox = el('code', { class: 'secret-value' }, apiKey.key);
    const form = el('div', { class: 'form-grid' }, [
      el('div', { class: 'field full' }, [
        el('label', null, 'API key'),
        valueBox,
        el('div', { class: 'hint' }, 'Copy this now. The full key is shown only once and is never stored in plaintext.'),
      ]),
    ]);
    const foot = el('div', { class: 'modal-foot' }, [
      el('button', { type: 'button', class: 'btn btn-primary', 'data-dismiss': '1', onclick: () => navigator.clipboard && navigator.clipboard.writeText(apiKey.key).catch(() => {}) }, 'Copy'),
      el('button', { type: 'button', class: 'btn', 'data-dismiss': '1' }, 'Close'),
    ]);
    const modal = el('div', { class: 'modal' }, [
      el('div', { class: 'modal-head' }, [
        el('h2', null, 'API key created'),
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
  },
};
