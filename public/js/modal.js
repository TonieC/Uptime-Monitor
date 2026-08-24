'use strict';

function openServiceModal({ service = null, onSaved } = {}) {
  const isEdit = Boolean(service);

  const values = service
    ? {
        name: service.name,
        url: service.url,
        method: service.method || 'GET',
        expected: (service.expected_status_codes || []).join(', '),
        interval: String(service.interval_seconds),
        timeout: String(service.timeout_ms),
        degraded:
          service.degraded_threshold_ms == null
            ? ''
            : String(service.degraded_threshold_ms),
        confirm: String(service.confirm_failures),
        enabled: service.enabled,
      }
    : {
        name: '',
        url: '',
        method: 'GET',
        expected: '200',
        interval: '60',
        timeout: '10000',
        degraded: '',
        confirm: '2',
        enabled: true,
      };

  const root = document.getElementById('modal-root');
  root.innerHTML = '';

  const inputs = {};

  function field(label, name, kind, opts = {}) {
    const wrap = el('div', {
      class: `field ${opts.full ? 'full' : ''}`,
    });

    wrap.appendChild(el('label', { for: name }, label));

    const attrs = {
      id: name,
      name,
    };

    if (kind === 'number') {
      attrs.type = 'number';
      attrs.min = opts.min ?? '';
      attrs.max = opts.max ?? '';
      attrs.step = opts.step ?? '1';
    } else if (kind === 'text') {
      attrs.type = 'text';
    }

    if (opts.placeholder) {
      attrs.placeholder = opts.placeholder;
    }

    if (kind === 'select') {
      const select = el('select', attrs);

      for (const method of [
        'GET',
        'HEAD',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
      ]) {
        select.appendChild(
          el('option', { value: method }, method)
        );
      }

      inputs[name] = select;
      wrap.appendChild(select);
    } else {
      const input = el('input', attrs);
      input.value = opts.value ?? '';

      inputs[name] = input;
      wrap.appendChild(input);
    }

    if (opts.hint) {
      wrap.appendChild(
        el('div', { class: 'hint' }, opts.hint)
      );
    }

    return wrap;
  }

  const body = el('div', { class: 'modal-body' });
  const form = el('form', {
    class: 'form-grid',
    id: 'service-form',
  });

  // Hidden by default through the CSS class instead of inline style.
  const errorBox = el('div', {
    class: 'form-error hidden',
  });

  const nameField = field(
    'Service name',
    'name',
    'text',
    {
      required: true,
    }
  );

  const urlField = field(
    'URL',
    'url',
    'text',
    {
      required: true,
      placeholder: 'https://example.com',
      hint: 'HTTP or HTTPS URL. Private addresses are blocked unless ALLOW_PRIVATE_NETWORKS=true is set.',
    }
  );

  const methodField = field(
    'Method',
    'method',
    'select'
  );

  const codesField = field(
    'Expected status codes',
    'expected_status_codes',
    'text',
    {
      value: values.expected,
      hint: 'Comma-separated, e.g. 200, 201, 204',
    }
  );

  const intervalField = field(
    'Check interval (seconds)',
    'interval_seconds',
    'number',
    {
      min: '5',
      max: '86400',
    }
  );

  const timeoutField = field(
    'Timeout (ms)',
    'timeout_ms',
    'number',
    {
      min: '100',
      max: '120000',
    }
  );

  const degradedField = field(
    'Degraded threshold (ms)',
    'degraded_threshold_ms',
    'number',
    {
      min: '1',
      max: '600000',
      hint: 'Mark as degraded when response is slower than this. Leave empty to disable.',
    }
  );

  const confirmField = field(
    'Failures to confirm outage',
    'confirm_failures',
    'number',
    {
      min: '1',
      max: '20',
      hint: 'Consecutive failed checks before an incident is opened.',
    }
  );

  /*
   * Enabled checkbox
   *
   * Store the actual input in `inputs.enabled`.
   * This fixes:
   *
   * Cannot set properties of undefined (setting 'checked')
   */
  const enabledInput = el('input', {
    type: 'checkbox',
    id: 'enabled',
    name: 'enabled',
  });

  inputs.enabled = enabledInput;

  const enabledField = el(
    'div',
    { class: 'checkbox-field' },
    [
      enabledInput,
      el(
        'label',
        { for: 'enabled' },
        'Monitoring enabled'
      ),
    ]
  );

  // Populate form values.
  inputs.name.value = values.name;
  inputs.url.value = values.url;
  inputs.method.value = values.method;
  inputs.interval_seconds.value = values.interval;
  inputs.timeout_ms.value = values.timeout;
  inputs.degraded_threshold_ms.value = values.degraded;
  inputs.confirm_failures.value = values.confirm;
  inputs.enabled.checked = Boolean(values.enabled);

  form.append(
    errorBox,
    nameField,
    urlField,
    methodField,
    codesField,
    intervalField,
    timeoutField,
    degradedField,
    confirmField,
    enabledField
  );

  urlField.classList.add('full');

  const foot = el(
    'div',
    { class: 'modal-foot' },
    [
      el(
        'button',
        {
          type: 'button',
          class: 'btn',
          'data-dismiss': '1',
        },
        'Cancel'
      ),
      el(
        'button',
        {
          type: 'submit',
          class: 'btn btn-primary',
          form: 'service-form',
        },
        isEdit ? 'Save changes' : 'Add service'
      ),
    ]
  );

  const modal = el(
    'div',
    { class: 'modal' },
    [
      el(
        'div',
        { class: 'modal-head' },
        [
          el(
            'h2',
            null,
            isEdit
              ? `Edit ${service.name}`
              : 'Add service'
          ),
          el(
            'button',
            {
              type: 'button',
              class: 'modal-close',
              'data-dismiss': '1',
              'aria-label': 'Close',
            },
            '×'
          ),
        ]
      ),
      body,
      foot,
    ]
  );

  body.appendChild(form);

  const overlay = el(
    'div',
    { class: 'modal-overlay' },
    modal
  );

  root.appendChild(overlay);

  function close() {
    overlay.remove();
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
  }

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) {
      close();
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-dismiss')) {
      close();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    errorBox.classList.add('hidden');

    const name = inputs.name.value.trim();
    const url = inputs.url.value.trim();
    const expectedRaw =
      inputs.expected_status_codes.value.trim();

    if (!name) {
      return showError('Service name is required.');
    }

    if (!url) {
      return showError('URL is required.');
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(url);
    } catch {
      return showError('URL is invalid.');
    }

    if (
      parsedUrl.protocol !== 'http:' &&
      parsedUrl.protocol !== 'https:'
    ) {
      return showError(
        'Only http:// and https:// URLs are allowed.'
      );
    }

    const expected = expectedRaw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));

    if (expected.length === 0) {
      return showError(
        'Enter at least one expected status code.'
      );
    }

    const interval = Number(
      inputs.interval_seconds.value
    );

    const timeout = Number(
      inputs.timeout_ms.value
    );

    const degradedRaw =
      inputs.degraded_threshold_ms.value.trim();

    const confirm = Number(
      inputs.confirm_failures.value
    );

    if (
      !Number.isInteger(interval) ||
      interval < 5 ||
      interval > 86400
    ) {
      return showError(
        'Check interval must be an integer between 5 and 86400 seconds.'
      );
    }

    if (
      !Number.isInteger(timeout) ||
      timeout < 100 ||
      timeout > 120000
    ) {
      return showError(
        'Timeout must be an integer between 100 and 120000 ms.'
      );
    }

    if (degradedRaw !== '') {
      const degraded = Number(degradedRaw);

      if (
        !Number.isInteger(degraded) ||
        degraded < 1 ||
        degraded > 600000
      ) {
        return showError(
          'Degraded threshold must be an integer between 1 and 600000 ms.'
        );
      }
    }

    if (
      !Number.isInteger(confirm) ||
      confirm < 1 ||
      confirm > 20
    ) {
      return showError(
        'Failure confirmation must be an integer between 1 and 20.'
      );
    }

    const submitBtn = foot.querySelector(
      'button[type="submit"]'
    );

    submitBtn.disabled = true;
    submitBtn.textContent = isEdit
      ? 'Saving…'
      : 'Adding…';

    const payload = {
      name,
      url,
      method: inputs.method.value,
      expected_status_codes: expected,
      interval_seconds: interval,
      timeout_ms: timeout,
      degraded_threshold_ms:
        degradedRaw === ''
          ? null
          : Number(degradedRaw),
      confirm_failures: confirm,
      enabled: inputs.enabled.checked,
    };

    try {
      const saved = isEdit
        ? await API.updateService(
            service.id,
            payload
          )
        : await API.createService(payload);

      close();

      if (onSaved) {
        onSaved(saved);
      }
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit
        ? 'Save changes'
        : 'Add service';

      showError(
        err?.message || 'Failed to save service.'
      );
    }
  });

  inputs.name.focus();
}