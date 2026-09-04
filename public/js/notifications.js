'use strict';

const NotificationTypes = { discord: 'Discord', email: 'Email', telegram: 'Telegram', webhook: 'Webhook' };
const EventLabels = { down: 'Down', recovered: 'Recovered', ssl_expiring: 'SSL expiring', degraded: 'Degraded' };

const Notifications = {
  container: null,
  notifications: [],
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
        el('h1', null, 'Notifications'),
        el('p', null, 'Send alerts to Discord, email, Telegram or a webhook when monitors change state'),
      ]),
      el('div', { class: 'view-actions' }, [
        el('button', { class: 'btn btn-primary', id: 'add-notification-btn' }, [
          el('span', null, '+'),
          el('span', null, 'Add notification'),
        ]),
      ]),
    ]);
    const wrap = el('div', { class: 'section', id: 'notifications-wrap' });
    this.container.append(header, wrap);
    this.container.querySelector('#add-notification-btn').addEventListener('click', () => this.openModal());
  },

  async load() {
    const wrap = this.container.querySelector('#notifications-wrap');
    wrap.innerHTML = '';
    wrap.appendChild(el('div', { class: 'loading-state' }, [el('div', { class: 'spinner' })]));
    const token = ++this.loadToken;
    try {
      const data = await API.listNotifications();
      if (this.destroyed || token !== this.loadToken) return;
      this.notifications = data.notifications || [];
      this.render();
    } catch (err) {
      if (this.destroyed || token !== this.loadToken) return;
      wrap.innerHTML = '';
      wrap.appendChild(
        el('div', { class: 'error-state card' }, [
          el('div', { class: 'err-icon' }, '!'),
          el('h3', null, 'Could not load notifications'),
          el('p', null, err.message),
          el('button', { class: 'btn', onclick: () => this.load() }, 'Retry'),
        ])
      );
    }
  },

  render() {
    const wrap = this.container.querySelector('#notifications-wrap');
    wrap.innerHTML = '';
    if (this.notifications.length === 0) {
      wrap.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'empty-state' }, [
            el('div', { class: 'empty-icon' }, '!'),
            el('h3', null, 'No notifications configured'),
            el('p', null, 'Add a notification channel to get alerted when a monitor goes down, recovers, or its SSL certificate is about to expire.'),
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
            el('th', null, 'Channel'),
            el('th', null, 'Events'),
            el('th', null, 'Status'),
            el('th', null, 'Actions'),
          ])),
          el('tbody', null, this.notifications.map((n) => this.renderRow(n))),
        ]),
      ])
    );
  },

  renderRow(n) {
    const enabled = el('span', { class: `pill ${n.enabled ? 'pill-up' : 'pill-disabled'}` }, n.enabled ? 'Enabled' : 'Disabled');
    const row = el('tr', null, [
      el('td', null, el('strong', null, n.name)),
      el('td', null, el('span', { class: 'monitor-type' }, NotificationTypes[n.type] || n.type)),
      el('td', null, (n.events || []).map((e) => EventLabels[e] || e).join(', ')),
      el('td', null, enabled),
      el('td', { class: 'row-actions' }, [
        el('button', { class: 'btn btn-sm', type: 'button', title: 'Send test', onclick: () => this.test(n.id) }, 'Test'),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => this.openModal(n) }, 'Edit'),
        el('button', { class: 'btn btn-sm danger', type: 'button', onclick: () => this.remove(n) }, 'Delete'),
      ]),
    ]);
    return row;
  },

  async test(id) {
    try {
      await API.testNotification(id);
      toast('Test notification sent.', 'ok');
    } catch (err) {
      toast(err?.message || 'Test notification failed.', 'error');
    }
  },

  async remove(n) {
    if (!window.confirm(`Delete notification "${n.name}"?`)) return;
    try {
      await API.deleteNotification(n.id);
      this.load();
    } catch (err) {
      toast(err?.message || 'Could not delete notification.', 'error');
    }
  },

  openModal(notification = null) {
    const isEdit = Boolean(notification);
    const root = document.getElementById('modal-root');
    root.innerHTML = '';

    const values = notification
      ? {
          name: notification.name,
          type: notification.type,
          events: notification.events || [],
          enabled: notification.enabled,
          cfg: notification.config || {},
        }
      : { name: '', type: 'discord', events: ['down', 'recovered'], enabled: true, cfg: {} };

    const inputs = {};
    function f(label, name, kind, opts = {}) {
      const wrap = el('div', { class: `field ${opts.full ? 'full' : ''}` });
      wrap.appendChild(el('label', { for: name }, label));
      if (kind === 'select') {
        const select = el('select', { id: name, name });
        inputs[name] = select;
        wrap.appendChild(select);
        return wrap;
      }
      if (kind === 'checkbox') {
        const cb = el('input', { type: 'checkbox', id: name, name });
        inputs[name] = cb;
        wrap.appendChild(cb);
        if (opts.inlineLabel) wrap.appendChild(el('label', { for: name }, opts.inlineLabel));
        return wrap;
      }
      if (kind === 'textarea') {
        const ta = el('textarea', { id: name, name, rows: opts.rows || '3' });
        inputs[name] = ta;
        wrap.appendChild(ta);
        return wrap;
      }
      const input = el('input', { type: 'text', id: name, name });
      inputs[name] = input;
      wrap.appendChild(input);
      return wrap;
    }

    const errorBox = el('div', { class: 'form-error hidden' });
    const nameField = f('Name', 'n_name', 'text');

    const typeWrap = el('div', { class: 'field' });
    typeWrap.appendChild(el('label', { for: 'n_type' }, 'Channel'));
    const typeSelect = el('select', { id: 'n_type', name: 'n_type' });
    for (const [t, label] of Object.entries(NotificationTypes)) {
      typeSelect.appendChild(el('option', { value: t }, label));
    }
    typeSelect.value = values.type;
    inputs.n_type = typeSelect;
    typeWrap.appendChild(typeSelect);

    // Channel config fields (all hidden, shown based on type).
    const cfgFields = {};
    function cfgField(key, label, kind, hint) {
      const wrap = el('div', { class: 'field full cfg-field', dataset: { for: kind } });
      wrap.appendChild(el('label', { for: key }, label));
      const input = kind === 'number' ? el('input', { type: 'number', id: key, name: key }) : el('input', { type: 'text', id: key, name: key });
      inputs[key] = input;
      wrap.appendChild(input);
      if (hint) wrap.appendChild(el('div', { class: 'hint' }, hint));
      return wrap;
    }
    const discordFields = [cfgField('discord_webhook', 'Discord webhook URL', 'text', 'Paste the webhook URL from your Discord channel settings.')];
    const telegramFields = [
      cfgField('tg_token', 'Bot token', 'text', 'Token from BotFather.'),
      cfgField('tg_chat', 'Chat ID', 'text', 'Numeric chat or channel ID.'),
    ];
    const emailFields = [
      cfgField('email_to', 'Recipient(s)', 'text', 'Comma-separated email addresses.'),
      cfgField('email_from', 'From address', 'text', 'Overrides the SMTP from configured in the environment.'),
      cfgField('email_host', 'SMTP host', 'text', 'Defaults to SMTP_HOST.'),
      cfgField('email_port', 'SMTP port', 'number'),
    ];
    const webhookFields = [cfgField('wh_url', 'Webhook URL', 'text', 'HTTP(S) endpoint that receives a JSON POST.')];

    const eventsWrap = el('div', { class: 'field full' });
    eventsWrap.appendChild(el('label', null, 'Events'));
    const eventsBox = el('div', { class: 'event-checks' });
    const eventInputs = {};
    for (const [ev, label] of Object.entries(EventLabels)) {
      const cb = el('input', { type: 'checkbox', value: ev, id: `ev-${ev}` });
      cb.checked = values.events.includes(ev);
      eventInputs[ev] = cb;
      eventsBox.appendChild(cb);
      eventsBox.appendChild(el('label', { for: `ev-${ev}` }, label));
    }
    eventsWrap.appendChild(eventsBox);

    const enabledWrap = el('div', { class: 'checkbox-field' });
    const enabledCb = el('input', { type: 'checkbox', id: 'n_enabled' });
    enabledCb.checked = Boolean(values.enabled);
    inputs.n_enabled = enabledCb;
    enabledWrap.appendChild(enabledCb);
    enabledWrap.appendChild(el('label', { for: 'n_enabled' }, 'Enabled'));

    // Seed config values. Redacted secrets arrive as booleans from the server;
    // skip them so the edit form never round-trips a placeholder like "true".
    const seedConfig = (key, fieldKey) => {
      const v = values.cfg[key];
      if (v !== undefined && typeof v !== 'boolean' && inputs[fieldKey]) {
        inputs[fieldKey].value = String(v);
      }
    };
    seedConfig('webhook_url', 'discord_webhook');
    seedConfig('bot_token', 'tg_token');
    seedConfig('chat_id', 'tg_chat');
    seedConfig('to', 'email_to');
    seedConfig('from', 'email_from');
    seedConfig('host', 'email_host');
    seedConfig('port', 'email_port');
    seedConfig('url', 'wh_url');

    const cfgByType = {
      discord: { fields: discordFields, kind: 'discord' },
      telegram: { fields: telegramFields, kind: 'telegram' },
      email: { fields: emailFields, kind: 'email' },
      webhook: { fields: webhookFields, kind: 'webhook' },
    };

    function applyType() {
      const t = inputs.n_type.value;
      for (const [tt, group] of Object.entries(cfgByType)) {
        for (const fieldEl of group.fields) {
          fieldEl.classList.toggle('hidden', tt !== t);
        }
      }
    }

    typeSelect.addEventListener('change', applyType);

    const form = el('form', { class: 'form-grid', id: 'notification-form' }, [
      errorBox,
      nameField,
      typeWrap,
      ...discordFields,
      ...telegramFields,
      ...emailFields,
      ...webhookFields,
      eventsWrap,
      enabledWrap,
    ]);

    const foot = el('div', { class: 'modal-foot' }, [
      el('button', { type: 'button', class: 'btn', 'data-dismiss': '1' }, 'Cancel'),
      el('button', { type: 'submit', class: 'btn btn-primary', form: 'notification-form' }, isEdit ? 'Save changes' : 'Add notification'),
    ]);

    const modal = el('div', { class: 'modal' }, [
      el('div', { class: 'modal-head' }, [
        el('h2', null, isEdit ? `Edit ${notification.name}` : 'Add notification'),
        el('button', { type: 'button', class: 'modal-close', 'data-dismiss': '1', 'aria-label': 'Close' }, '×'),
      ]),
      el('div', { class: 'modal-body' }, form),
      foot,
    ]);
    const overlay = el('div', { class: 'modal-overlay' }, modal);
    root.appendChild(overlay);

    inputs.n_name.value = values.name;
    applyType();

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-dismiss')) overlay.remove();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.classList.add('hidden');

      const name = inputs.n_name.value.trim();
      if (!name) {
        errorBox.textContent = 'Name is required.';
        errorBox.classList.remove('hidden');
        return;
      }

      const type = inputs.n_type.value;
      const config = {};
      if (type === 'discord') {
        config.webhook_url = inputs.discord_webhook.value.trim();
        if (!config.webhook_url.startsWith('https://')) {
          errorBox.textContent = 'Discord webhook URL must be an https URL.';
          errorBox.classList.remove('hidden');
          return;
        }
      } else if (type === 'telegram') {
        config.bot_token = inputs.tg_token.value.trim();
        config.chat_id = inputs.tg_chat.value.trim();
        if (!config.bot_token || !config.chat_id) {
          errorBox.textContent = 'Both bot token and chat ID are required for Telegram.';
          errorBox.classList.remove('hidden');
          return;
        }
      } else if (type === 'email') {
        config.to = inputs.email_to.value.trim();
        if (!config.to) {
          errorBox.textContent = 'At least one recipient email is required.';
          errorBox.classList.remove('hidden');
          return;
        }
        if (inputs.email_from.value.trim()) config.from = inputs.email_from.value.trim();
        if (inputs.email_host.value.trim()) config.host = inputs.email_host.value.trim();
        if (inputs.email_port.value.trim()) config.port = Number(inputs.email_port.value);
      } else if (type === 'webhook') {
        config.url = inputs.wh_url.value.trim();
        if (!/^https?:\/\//.test(config.url)) {
          errorBox.textContent = 'Webhook URL must start with http:// or https://.';
          errorBox.classList.remove('hidden');
          return;
        }
      }

      const events = Object.keys(eventInputs).filter((k) => eventInputs[k].checked);
      if (events.length === 0) {
        errorBox.textContent = 'Select at least one event to alert on.';
        errorBox.classList.remove('hidden');
        return;
      }

      const payload = { name, type, config, events, enabled: inputs.n_enabled.checked };
      const submitBtn = foot.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        if (isEdit) await API.updateNotification(notification.id, payload);
        else await API.createNotification(payload);
        overlay.remove();
        this.load();
      } catch (err) {
        submitBtn.disabled = false;
        errorBox.textContent = err?.message || 'Failed to save notification.';
        errorBox.classList.remove('hidden');
      }
    });
  },
};
