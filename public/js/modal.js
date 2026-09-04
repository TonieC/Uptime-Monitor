'use strict';

const MONITOR_TYPE_LABELS = {
  http: 'HTTP(S)',
  ping: 'Ping (ICMP)',
  tcp: 'TCP port',
  dns: 'DNS lookup',
};

function parseHeadersCsv(text) {
  // Accepts "Name: value" lines or "Name,value" pairs, one per line.
  const headers = {};
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const sep = line.indexOf(':');
    if (sep <= 0) return { error: `Invalid header line "${line}" — expected "Name: value".` };
    const name = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (!/^[a-zA-Z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) {
      return { error: `Invalid header name "${name}".` };
    }
    headers[name] = value;
  }
  return { headers };
}

function openServiceModal({ service = null, onSaved } = {}) {
  const isEdit = Boolean(service);
  const values = {
    name: service ? service.name : '',
    type: service ? service.type || 'http' : 'http',
    url: service ? service.url : '',
    host: service ? service.host : '',
    port: service ? String(service.port ?? '') : '',
    expected_ip: service ? service.expected_ip || '' : '',
    method: service ? service.method || 'GET' : 'GET',
    expected: service ? (service.expected_status_codes || []).join(', ') : '200',
    headers: service && service.headers ? Object.entries(service.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : '',
    auth_username: service ? service.auth_username || '' : '',
    auth_password: '',
    user_agent: service ? service.user_agent || '' : '',
    follow_redirects: service ? service.follow_redirects : true,
    expected_keyword: service ? service.expected_keyword || '' : '',
    forbidden_keyword: service ? service.forbidden_keyword || '' : '',
    keyword_case_sensitive: service ? service.keyword_case_sensitive : false,
    check_certificate: service ? service.check_certificate : true,
    ssl_expiry_threshold_days: service ? String(service.ssl_expiry_threshold_days ?? 14) : '14',
    interval: service ? String(service.interval_seconds) : '60',
    timeout: service ? String(service.timeout_ms) : '10000',
    degraded: service && service.degraded_threshold_ms != null ? String(service.degraded_threshold_ms) : '',
    retries: service ? String(service.retries ?? 0) : '0',
    retry_delay_ms: service ? String(service.retry_delay_ms ?? 1000) : '1000',
    recovery_threshold: service ? String(service.recovery_threshold ?? 1) : '1',
    confirm: service ? String(service.confirm_failures) : '2',
    enabled: service ? service.enabled : true,
  };

  const root = document.getElementById('modal-root');
  root.innerHTML = '';
  const inputs = {};
  const httpFields = [];
  const nonHttpFields = [];

  function field(label, name, kind, opts = {}) {
    const wrap = el('div', { class: `field ${opts.full ? 'full' : ''}` });
    wrap.appendChild(el('label', { for: name }, label));
    const attrs = { id: name, name };
    if (kind === 'number') {
      attrs.type = 'number';
      attrs.min = opts.min ?? '';
      attrs.max = opts.max ?? '';
      attrs.step = opts.step ?? '1';
    } else if (kind === 'text') {
      attrs.type = 'text';
    } else if (kind === 'textarea') {
      attrs.rows = opts.rows ?? '3';
      attrs.spellcheck = 'false';
    } else if (kind === 'checkbox') {
      attrs.type = 'checkbox';
    }

    if (opts.placeholder) attrs.placeholder = opts.placeholder;
    if (kind === 'textarea') {
      const ta = el('textarea', attrs);
      ta.value = opts.value ?? '';
      inputs[name] = ta;
      wrap.appendChild(ta);
    } else if (kind === 'checkbox') {
      const cb = el('input', attrs);
      cb.checked = Boolean(opts.value);
      inputs[name] = cb;
      wrap.appendChild(cb);
      if (opts.inlineLabel) wrap.appendChild(el('label', { for: name }, opts.inlineLabel));
    } else {
      const input = el('input', attrs);
      input.value = opts.value ?? '';
      inputs[name] = input;
      wrap.appendChild(input);
    }
    if (opts.hint) wrap.appendChild(el('div', { class: 'hint' }, opts.hint));
    return wrap;
  }

  const body = el('div', { class: 'modal-body' });
  const form = el('form', { class: 'form-grid', id: 'service-form' });
  const errorBox = el('div', { class: 'form-error hidden' });

  const nameField = field('Monitor name', 'name', 'text', { required: true, placeholder: 'My website' });
  const typeField = (() => {
    const wrap = el('div', { class: 'field' });
    wrap.appendChild(el('label', { for: 'type' }, 'Monitor type'));
    const select = el('select', { id: 'type', name: 'type' });
    for (const t of Object.keys(MONITOR_TYPE_LABELS)) {
      select.appendChild(el('option', { value: t }, MONITOR_TYPE_LABELS[t]));
    }
    select.value = values.type;
    inputs.type = select;
    wrap.appendChild(select);
    return wrap;
  })();

  // HTTP-only fields.
  const urlField = field('URL', 'url', 'text', {
    placeholder: 'https://example.com',
    hint: 'Private addresses are blocked unless ALLOW_PRIVATE_NETWORKS=true is set.',
  });
  const methodField = field('Method', 'method', 'text', {
    placeholder: 'GET',
    hint: 'GET, HEAD, POST, PUT, PATCH or DELETE',
  });
  const codesField = field('Expected status codes', 'expected_status_codes', 'text', {
    value: values.expected,
    hint: 'Comma-separated, e.g. 200, 201, 204',
  });
  const headersField = field('Request headers', 'headers', 'textarea', {
    value: values.headers,
    hint: 'One "Name: value" pair per line.',
  });
  const authUserField = field('Basic auth username', 'auth_username', 'text', { value: values.auth_username });
  const authPassField = field('Basic auth password', 'auth_password', 'text', {
    placeholder: isEdit ? '(unchanged)' : '',
    hint: 'Stored securely; never returned by the API.',
  });
  const userAgentField = field('User agent', 'user_agent', 'text', { value: values.user_agent });
  const followField = field('Follow redirects', 'follow_redirects', 'checkbox', {
    value: values.follow_redirects,
    inlineLabel: 'Follow up to 5 redirects',
  });
  const expectedKeywordField = field('Expected keyword', 'expected_keyword', 'text', {
    value: values.expected_keyword,
    hint: 'Body must contain this text or the check fails.',
  });
  const forbiddenKeywordField = field('Forbidden keyword', 'forbidden_keyword', 'text', {
    value: values.forbidden_keyword,
    hint: 'Body must NOT contain this text.',
  });
  const keywordCaseField = field('Keyword case sensitive', 'keyword_case_sensitive', 'checkbox', {
    value: values.keyword_case_sensitive,
    inlineLabel: 'Match keyword case exactly',
  });
  const certCheckField = field('Check SSL certificate', 'check_certificate', 'checkbox', {
    value: values.check_certificate,
    inlineLabel: 'Fail on invalid certificates and alert on expiry',
  });
  const sslThresholdField = field('SSL expiry threshold (days)', 'ssl_expiry_threshold_days', 'number', {
    value: values.ssl_expiry_threshold_days,
    min: '1',
    max: '365',
  });

  // Non-HTTP fields.
  const hostField = field('Host', 'host', 'text', { placeholder: 'example.com' });
  const portField = field('Port', 'port', 'number', { min: '1', max: '65535' });
  const expectedIpField = field('Expected IP (optional)', 'expected_ip', 'text', {
    value: values.expected_ip,
    hint: 'Leave empty to accept any resolved address.',
  });

  // Common fields.
  const intervalField = field('Check interval (seconds)', 'interval_seconds', 'number', { min: '5', max: '86400' });
  const timeoutField = field('Timeout (ms)', 'timeout_ms', 'number', { min: '100', max: '120000' });
  const degradedField = field('Degraded threshold (ms)', 'degraded_threshold_ms', 'number', {
    min: '1',
    max: '600000',
    hint: 'Mark degraded when slower than this. Empty disables.',
  });
  const retriesField = field('Retries before failure', 'retries', 'number', {
    min: '0',
    max: '10',
    hint: 'Extra attempts before a check is recorded as down.',
  });
  const retryDelayField = field('Retry delay (ms)', 'retry_delay_ms', 'number', { min: '0', max: '60000' });
  const recoveryField = field('Successes to recover', 'recovery_threshold', 'number', {
    min: '1',
    max: '20',
    hint: 'Consecutive successful checks before an incident is marked resolved.',
  });
  const confirmField = field('Failures to confirm outage', 'confirm_failures', 'number', {
    min: '1',
    max: '20',
  });

  const enabledInput = el('input', { type: 'checkbox', id: 'enabled', name: 'enabled' });
  inputs.enabled = enabledInput;
  const enabledField = el('div', { class: 'checkbox-field' }, [enabledInput, el('label', { for: 'enabled' }, 'Monitoring enabled')]);

  // Group fields into sections for dynamic display.
  httpFields.push(urlField, methodField, codesField, headersField, authUserField, authPassField, userAgentField, followField, expectedKeywordField, forbiddenKeywordField, keywordCaseField, certCheckField, sslThresholdField);
  nonHttpFields.push(hostField, portField, expectedIpField);

  // Populate values.
  inputs.name.value = values.name;
  inputs.url.value = values.url;
  inputs.method.value = values.method;
  inputs.interval_seconds.value = values.interval;
  inputs.timeout_ms.value = values.timeout;
  inputs.degraded_threshold_ms.value = values.degraded;
  inputs.retries.value = values.retries;
  inputs.retry_delay_ms.value = values.retry_delay_ms;
  inputs.recovery_threshold.value = values.recovery_threshold;
  inputs.confirm_failures.value = values.confirm;
  inputs.ssl_expiry_threshold_days.value = values.ssl_expiry_threshold_days;
  inputs.host.value = values.host;
  inputs.port.value = values.port;
  inputs.expected_ip.value = values.expected_ip;
  inputs.enabled.checked = Boolean(values.enabled);

  function visibleType() {
    return inputs.type.value;
  }

  function applyTypeVisibility() {
    const t = visibleType();
    const isHttp = t === 'http';
    for (const f of httpFields) f.classList.toggle('hidden', !isHttp);
    for (const f of nonHttpFields) f.classList.toggle('hidden', isHttp);
    portField.classList.toggle('hidden', t !== 'tcp');
    expectedIpField.classList.toggle('hidden', t !== 'dns');
    urlField.classList.toggle('full', isHttp);
  }

  form.append(
    errorBox,
    nameField,
    typeField,
    ...httpFields,
    ...nonHttpFields,
    intervalField,
    timeoutField,
    degradedField,
    retriesField,
    retryDelayField,
    recoveryField,
    confirmField,
    enabledField
  );

  const foot = el('div', { class: 'modal-foot' }, [
    el('button', { type: 'button', class: 'btn', 'data-dismiss': '1' }, 'Cancel'),
    el('button', { type: 'submit', class: 'btn btn-primary', form: 'service-form' }, isEdit ? 'Save changes' : 'Add monitor'),
  ]);

  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [
      el('h2', null, isEdit ? `Edit ${service.name}` : 'Add monitor'),
      el('button', { type: 'button', class: 'modal-close', 'data-dismiss': '1', 'aria-label': 'Close' }, '×'),
    ]),
    body,
    foot,
  ]);
  body.appendChild(form);

  const overlay = el('div', { class: 'modal-overlay' }, modal);
  root.appendChild(overlay);

  applyTypeVisibility();
  inputs.type.addEventListener('change', applyTypeVisibility);

  function close() {
    overlay.remove();
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
  }

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-dismiss')) close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.add('hidden');

    const type = visibleType();
    const name = inputs.name.value.trim();
    if (!name) return showError('Monitor name is required.');

    const payload = {
      name,
      type,
      interval_seconds: Number(inputs.interval_seconds.value),
      timeout_ms: Number(inputs.timeout_ms.value),
      degraded_threshold_ms: inputs.degraded_threshold_ms.value.trim() === '' ? null : Number(inputs.degraded_threshold_ms.value),
      retries: Number(inputs.retries.value),
      retry_delay_ms: Number(inputs.retry_delay_ms.value),
      recovery_threshold: Number(inputs.recovery_threshold.value),
      confirm_failures: Number(inputs.confirm_failures.value),
      enabled: inputs.enabled.checked,
    };

    if (type === 'http') {
      const url = inputs.url.value.trim();
      if (!url) return showError('URL is required for HTTP monitors.');
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return showError('Only http:// and https:// URLs are allowed.');
        }
      } catch {
        return showError('URL is invalid.');
      }
      payload.url = url;

      const method = (inputs.method.value.trim().toUpperCase() || 'GET');
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        return showError('Method must be GET, HEAD, POST, PUT, PATCH or DELETE.');
      }
      payload.method = method;

      const expected = inputs.expected_status_codes.value
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n));
      if (expected.length === 0) return showError('Enter at least one expected status code.');
      payload.expected_status_codes = expected;

      const headers = parseHeadersCsv(inputs.headers.value);
      if (headers.error) return showError(headers.error);
      if (Object.keys(headers.headers).length > 0) payload.headers = headers.headers;

      if (inputs.auth_username.value.trim()) payload.auth_username = inputs.auth_username.value.trim();
      if (inputs.auth_password.value) payload.auth_password = inputs.auth_password.value;

      if (inputs.user_agent.value.trim()) payload.user_agent = inputs.user_agent.value.trim();
      payload.follow_redirects = inputs.follow_redirects.checked;

      if (inputs.expected_keyword.value.trim()) payload.expected_keyword = inputs.expected_keyword.value.trim();
      if (inputs.forbidden_keyword.value.trim()) payload.forbidden_keyword = inputs.forbidden_keyword.value.trim();
      payload.keyword_case_sensitive = inputs.keyword_case_sensitive.checked;
      payload.check_certificate = inputs.check_certificate.checked;
      payload.ssl_expiry_threshold_days = Number(inputs.ssl_expiry_threshold_days.value);
    } else {
      const host = inputs.host.value.trim();
      if (!host) return showError(`Host is required for ${MONITOR_TYPE_LABELS[type].toLowerCase()} monitors.`);
      payload.host = host;
      if (type === 'tcp') {
        const port = Number(inputs.port.value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return showError('Port must be an integer between 1 and 65535.');
        }
        payload.port = port;
      }
      if (type === 'dns' && inputs.expected_ip.value.trim()) {
        payload.expected_ip = inputs.expected_ip.value.trim();
      }
    }

    // Numeric validation.
    if (!Number.isInteger(payload.interval_seconds) || payload.interval_seconds < 5 || payload.interval_seconds > 86400) {
      return showError('Check interval must be an integer between 5 and 86400 seconds.');
    }
    if (!Number.isInteger(payload.timeout_ms) || payload.timeout_ms < 100 || payload.timeout_ms > 120000) {
      return showError('Timeout must be an integer between 100 and 120000 ms.');
    }
    if (payload.degraded_threshold_ms !== null) {
      if (!Number.isInteger(payload.degraded_threshold_ms) || payload.degraded_threshold_ms < 1 || payload.degraded_threshold_ms > 600000) {
        return showError('Degraded threshold must be an integer between 1 and 600000 ms.');
      }
    }
    if (!Number.isInteger(payload.retries) || payload.retries < 0 || payload.retries > 10) {
      return showError('Retries must be an integer between 0 and 10.');
    }
    if (!Number.isInteger(payload.retry_delay_ms) || payload.retry_delay_ms < 0 || payload.retry_delay_ms > 60000) {
      return showError('Retry delay must be an integer between 0 and 60000 ms.');
    }
    if (!Number.isInteger(payload.recovery_threshold) || payload.recovery_threshold < 1 || payload.recovery_threshold > 20) {
      return showError('Recovery threshold must be an integer between 1 and 20.');
    }
    if (!Number.isInteger(payload.confirm_failures) || payload.confirm_failures < 1 || payload.confirm_failures > 20) {
      return showError('Failure confirmation must be an integer between 1 and 20.');
    }

    const submitBtn = foot.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = isEdit ? 'Saving…' : 'Adding…';

    try {
      const saved = isEdit ? await API.updateService(service.id, payload) : await API.createService(payload);
      close();
      if (onSaved) onSaved(saved);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit ? 'Save changes' : 'Add monitor';
      showError(err?.message || 'Failed to save monitor.');
    }
  });

  inputs.name.focus();
}
