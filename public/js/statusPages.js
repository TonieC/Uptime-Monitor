'use strict';

const StatusPages = {
  container: null,
  pages: [],
  services: [],
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
        el('h1', null, 'Status pages'),
        el('p', null, 'Share a public view of monitor health with anyone'),
      ]),
      el('div', { class: 'view-actions' }, [
        el('button', { class: 'btn btn-primary', id: 'add-status-page-btn' }, [
          el('span', null, '+'),
          el('span', null, 'New status page'),
        ]),
      ]),
    ]);
    const wrap = el('div', { class: 'section', id: 'status-pages-wrap' });
    this.container.append(header, wrap);
    this.container.querySelector('#add-status-page-btn').addEventListener('click', () => this.openModal());
  },

  async load() {
    const wrap = this.container.querySelector('#status-pages-wrap');
    wrap.innerHTML = '';
    wrap.appendChild(el('div', { class: 'loading-state' }, [el('div', { class: 'spinner' })]));
    const token = ++this.loadToken;
    try {
      const [pagesRes, services] = await Promise.all([API.listStatusPages(), API.listServices()]);
      if (this.destroyed || token !== this.loadToken) return;
      this.pages = pagesRes.status_pages || [];
      this.services = services;
      this.render();
    } catch (err) {
      if (this.destroyed || token !== this.loadToken) return;
      wrap.innerHTML = '';
      wrap.appendChild(
        el('div', { class: 'error-state card' }, [
          el('div', { class: 'err-icon' }, '!'),
          el('h3', null, 'Could not load status pages'),
          el('p', null, err.message),
          el('button', { class: 'btn', onclick: () => this.load() }, 'Retry'),
        ])
      );
    }
  },

  render() {
    const wrap = this.container.querySelector('#status-pages-wrap');
    wrap.innerHTML = '';
    if (this.pages.length === 0) {
      wrap.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'empty-state' }, [
            el('div', { class: 'empty-icon' }, '{}'),
            el('h3', null, 'No status pages yet'),
            el('p', null, 'Create a status page to publish monitor status publicly at /status/&lt;slug&gt;.'),
          ]),
        ])
      );
      return;
    }
    const grid = el('div', { class: 'service-grid' });
    for (const page of this.pages) {
      grid.appendChild(this.renderCard(page));
    }
    wrap.appendChild(grid);
  },

  renderCard(page) {
    const pub = el('span', { class: `pill ${page.is_public ? 'pill-up' : 'pill-disabled'}` }, page.is_public ? 'Public' : 'Private');
    const link = el('a', { href: `/status/${encodeURIComponent(page.slug)}`, target: '_blank', rel: 'noopener' }, `/status/${page.slug}`);
    const card = el('div', { class: 'card sp-card' }, [
      el('div', { class: 'sp-header' }, [
        el('div', { class: 'sp-title' }, [
          el('strong', null, page.title),
          el('span', { class: 'sp-slug' }, link),
        ]),
        pub,
      ]),
      el('div', { class: 'sp-meta' }, [
        el('span', null, `${(page.monitor_ids || []).length} monitors`),
        el('span', null, `Updated ${fmtRelative(page.updated_at)}`),
      ]),
      el('div', { class: 'sp-desc' }, page.description || 'No description'),
      el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => this.openModal(page) }, 'Edit'),
        el('button', { class: 'btn btn-sm danger', type: 'button', onclick: () => this.remove(page) }, 'Delete'),
      ]),
    ]);
    return card;
  },

  async remove(page) {
    if (!window.confirm(`Delete status page "${page.title}"?`)) return;
    try {
      await API.deleteStatusPage(page.id);
      this.load();
    } catch (err) {
      toast(err?.message || 'Could not delete status page.', 'error');
    }
  },

  openModal(page = null) {
    const isEdit = Boolean(page);
    const root = document.getElementById('modal-root');
    root.innerHTML = '';

    const values = page
      ? {
          title: page.title,
          slug: page.slug,
          description: page.description || '',
          is_public: page.is_public,
          monitor_ids: page.monitor_ids || [],
          branding: page.branding || {},
        }
      : { title: '', slug: '', description: '', is_public: true, monitor_ids: [], branding: {} };

    const errorBox = el('div', { class: 'form-error hidden' });
    const inputs = {};
    function f(label, name, kind, opts = {}) {
      const wrap = el('div', { class: `field ${opts.full ? 'full' : ''}` });
      wrap.appendChild(el('label', { for: name }, label));
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

    const titleField = f('Title', 'sp_title', 'text');
    const slugField = f('Slug', 'sp_slug', 'text', { hint: 'Lowercase letters, numbers and hyphens. Public URL: /status/<slug>' });
    const descField = f('Description', 'sp_description', 'textarea', { full: true });

    const publicWrap = el('div', { class: 'checkbox-field' });
    const publicCb = el('input', { type: 'checkbox', id: 'sp_public' });
    inputs.sp_public = publicCb;
    publicCb.checked = Boolean(values.is_public);
    publicWrap.appendChild(publicCb);
    publicWrap.appendChild(el('label', { for: 'sp_public' }, 'Publicly accessible'));

    const monitorsWrap = el('div', { class: 'field full' });
    monitorsWrap.appendChild(el('label', null, 'Monitors to display'));
    const monitorChecks = el('div', { class: 'event-checks' });
    if (this.services.length === 0) {
      monitorChecks.appendChild(el('span', { class: 'hint' }, 'No monitors yet — add some first.'));
    }
    for (const s of this.services) {
      const cb = el('input', { type: 'checkbox', value: String(s.id), id: `sp-mon-${s.id}` });
      cb.checked = values.monitor_ids.includes(s.id);
      monitorChecks.appendChild(cb);
      monitorChecks.appendChild(el('label', { for: `sp-mon-${s.id}` }, `${s.name} (${monitorTypeLabel(s.type || 'http')})`));
    }
    monitorsWrap.appendChild(monitorChecks);

    inputs.sp_title.value = values.title;
    inputs.sp_slug.value = values.slug;
    inputs.sp_description.value = values.description;

    const form = el('form', { class: 'form-grid', id: 'status-page-form' }, [
      errorBox,
      titleField,
      slugField,
      descField,
      publicWrap,
      monitorsWrap,
    ]);

    const foot = el('div', { class: 'modal-foot' }, [
      el('button', { type: 'button', class: 'btn', 'data-dismiss': '1' }, 'Cancel'),
      el('button', { type: 'submit', class: 'btn btn-primary', form: 'status-page-form' }, isEdit ? 'Save changes' : 'Create status page'),
    ]);
    const modal = el('div', { class: 'modal' }, [
      el('div', { class: 'modal-head' }, [
        el('h2', null, isEdit ? `Edit ${page.title}` : 'New status page'),
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
      errorBox.classList.add('hidden');

      const title = inputs.sp_title.value.trim();
      const slug = inputs.sp_slug.value.trim();
      if (!title) {
        errorBox.textContent = 'Title is required.';
        errorBox.classList.remove('hidden');
        return;
      }
      if (!slug) {
        errorBox.textContent = 'Slug is required.';
        errorBox.classList.remove('hidden');
        return;
      }
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
        errorBox.textContent = 'Slug must be lowercase letters, numbers and hyphens (1-64 chars).';
        errorBox.classList.remove('hidden');
        return;
      }

      const monitor_ids = [...monitorChecks.querySelectorAll('input:checked')].map((cb) => Number(cb.value));
      const payload = {
        title,
        slug,
        description: inputs.sp_description.value.trim() || null,
        is_public: inputs.sp_public.checked,
        monitor_ids,
      };
      const submitBtn = foot.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        if (isEdit) await API.updateStatusPage(page.id, payload);
        else await API.createStatusPage(payload);
        overlay.remove();
        this.load();
      } catch (err) {
        submitBtn.disabled = false;
        errorBox.textContent = err?.message || 'Failed to save status page.';
        errorBox.classList.remove('hidden');
      }
    });
  },
};
