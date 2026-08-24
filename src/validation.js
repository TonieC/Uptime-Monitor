'use strict';

const { validateTarget } = require('./security');

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_NAME_LENGTH = 200;
const MAX_STATUS_CODES = 20;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asTrimmedString(value, field, maxLen) {
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { error: `${field} must not be empty` };
  if (maxLen !== undefined && trimmed.length > maxLen) {
    return { error: `${field} must be at most ${maxLen} characters` };
  }
  return { value: trimmed };
}

function asInt(value, field, { min, max, required = false, allowNull = false } = {}) {
  if (value === undefined) return { value: undefined };
  if (value === null || value === '') {
    if (allowNull) return { value: null };
    if (required) return { error: `${field} is required` };
    return { value: undefined };
  }
  const n = Number(value);
  if (!Number.isInteger(n)) return { error: `${field} must be an integer` };
  if (min !== undefined && n < min) return { error: `${field} must be at least ${min}` };
  if (max !== undefined && n > max) return { error: `${field} must be at most ${max}` };
  return { value: n };
}

function asBool(value, field) {
  if (value === undefined) return { value: undefined };
  if (value === null) return { value: undefined };
  if (typeof value === 'boolean') return { value };
  if (value === 0 || value === 1) return { value: Boolean(value) };
  if (value === 'true' || value === 'false') return { value: value === 'true' };
  return { error: `${field} must be a boolean` };
}

async function validateServiceInput(input, { allowPrivateNetworks = false, partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!isPlainObject(input)) {
    return { errors: ['Request body must be a JSON object'], value: null };
  }

  const name = asTrimmedString(input.name, 'name', MAX_NAME_LENGTH);
  if (name.error) errors.push(name.error);
  else if (name.value !== undefined) out.name = name.value;
  else if (!partial) errors.push('name is required');

  let url = null;
  const urlRes = asTrimmedString(input.url, 'url', 2048);
  if (urlRes.error) errors.push(urlRes.error);
  else if (urlRes.value === undefined) {
    if (!partial) errors.push('url is required');
  } else {
    url = urlRes.value;
  }

  if (url) {
    const target = await validateTarget(url, { allowPrivateNetworks });
    if (!target.ok) {
      if (target.code === 'dns') {
        errors.push('URL hostname could not be resolved');
      } else {
        errors.push(target.message);
      }
    } else {
      out.url = url;
      out._parsedUrl = target.parsed;
    }
  }

  const method = asTrimmedString(input.method, 'method', 10);
  if (method.error) errors.push(method.error);
  else if (method.value !== undefined) {
    const m = method.value.toUpperCase();
    if (!HTTP_METHODS.has(m)) errors.push('method must be one of GET, HEAD, POST, PUT, PATCH, DELETE');
    else out.method = m;
  }

  if (input.expected_status_codes !== undefined) {
    const codes = input.expected_status_codes;
    if (!Array.isArray(codes) || codes.length === 0) {
      errors.push('expected_status_codes must be a non-empty array');
    } else if (codes.length > MAX_STATUS_CODES) {
      errors.push(`expected_status_codes must have at most ${MAX_STATUS_CODES} entries`);
    } else {
      const parsedCodes = [];
      for (const c of codes) {
        const n = Number(c);
        if (!Number.isInteger(n) || n < 100 || n > 599) {
          errors.push('expected_status_codes must contain integers between 100 and 599');
          break;
        }
        parsedCodes.push(n);
      }
      if (parsedCodes.length === codes.length) out.expected_status_codes = parsedCodes;
    }
  }

  const interval = asInt(input.interval_seconds, 'interval_seconds', { min: 5, max: 86400 });
  if (interval.error) errors.push(interval.error);
  else if (interval.value !== undefined) out.interval_seconds = interval.value;

  const timeout = asInt(input.timeout_ms, 'timeout_ms', { min: 100, max: 120000 });
  if (timeout.error) errors.push(timeout.error);
  else if (timeout.value !== undefined) out.timeout_ms = timeout.value;

  const degraded = asInt(input.degraded_threshold_ms, 'degraded_threshold_ms', {
    min: 1,
    max: 600000,
    allowNull: true,
  });
  if (degraded.error) errors.push(degraded.error);
  else if (degraded.value !== undefined) out.degraded_threshold_ms = degraded.value;

  const enabled = asBool(input.enabled, 'enabled');
  if (enabled.error) errors.push(enabled.error);
  else if (enabled.value !== undefined) out.enabled = enabled.value;

  const confirm = asInt(input.confirm_failures, 'confirm_failures', { min: 1, max: 20 });
  if (confirm.error) errors.push(confirm.error);
  else if (confirm.value !== undefined) out.confirm_failures = confirm.value;

  if (errors.length > 0) return { errors, value: null };
  return { errors: [], value: out };
}

module.exports = { validateServiceInput, HTTP_METHODS };
