'use strict';

const { validateTarget, validateHostPort } = require('./security');
const { MONITOR_TYPES } = require('./services');

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_NAME_LENGTH = 200;
const MAX_STATUS_CODES = 20;
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE_LENGTH = 2048;

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

function validateHostValue(input, partial) {
  const errors = [];
  const out = {};

  let type = 'http';
  const typeRes = asTrimmedString(input.type, 'type', 10);
  if (typeRes.error) errors.push(typeRes.error);
  else if (typeRes.value !== undefined) {
    const t = typeRes.value.toLowerCase();
    if (!MONITOR_TYPES.has(t)) errors.push('type must be one of http, ping, tcp, dns');
    else type = t;
  }
  out.type = type;

  // Non-HTTP monitors target a host (plus an optional port). The legacy `url`
  // column stores a canonical string for display/back-compat.
  if (type === 'http') {
    const urlRes = asTrimmedString(input.url, 'url', 2048);
    if (urlRes.error) errors.push(urlRes.error);
    else if (urlRes.value === undefined) {
      if (!partial) errors.push('url is required for http monitors');
    } else {
      out.url = urlRes.value;
    }
  } else {
    const hostRes = asTrimmedString(input.host, 'host', 255);
    if (hostRes.error) errors.push(hostRes.error);
    else if (hostRes.value === undefined) {
      if (!partial) errors.push(`host is required for ${type} monitors`);
    } else {
      out.host = hostRes.value;
    }
  }

  // TCP monitors require a port. Reject invalid host characters up front so an
  // invalid configuration can never reach the worker.
  if (type === 'tcp') {
    const port = asInt(input.port, 'port', { min: 1, max: 65535 });
    if (port.error) errors.push(port.error);
    else if (port.value === undefined && !partial) errors.push('port is required for tcp monitors');
    else if (port.value !== undefined) out.port = port.value;
  }

  if (type === 'dns' && input.expected_ip !== undefined) {
    const ip = asTrimmedString(input.expected_ip, 'expected_ip', 45);
    if (ip.error) errors.push(ip.error);
    else if (ip.value !== undefined) out.expected_ip = ip.value;
  }

  return { errors, value: out };
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

  const base = validateHostValue(input, partial);
  errors.push(...base.errors);
  const type = base.value.type;
  Object.assign(out, base.value);

  // SSRF validation for whichever target was provided.
  if (out.url && type === 'http') {
    const target = await validateTarget(out.url, { allowPrivateNetworks });
    if (!target.ok) {
      if (target.code === 'dns') {
        errors.push('URL hostname could not be resolved');
      } else {
        errors.push(target.message);
      }
    }
  } else if (out.host) {
    const target = await validateHostPort(out.host, out.port || 1, { allowPrivateNetworks });
    if (!target.ok && target.code !== 'dns') {
      errors.push(target.message);
    }
  }

  // HTTP-only fields.
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

  if (input.headers !== undefined) {
    if (!isPlainObject(input.headers)) {
      errors.push('headers must be an object of string values');
    } else {
      const keys = Object.keys(input.headers);
      if (keys.length > MAX_HEADERS) {
        errors.push(`headers must have at most ${MAX_HEADERS} entries`);
      } else {
        const parsedHeaders = {};
        let headerError = false;
        for (const key of keys) {
          if (!/^[a-zA-Z0-9!#$%&'*+\-.^_`|~]+$/.test(key)) {
            errors.push(`header name "${key}" is invalid`);
            headerError = true;
            break;
          }
          const v = input.headers[key];
          if (typeof v !== 'string' || v.length > MAX_HEADER_VALUE_LENGTH) {
            errors.push(`header "${key}" must be a string of at most ${MAX_HEADER_VALUE_LENGTH} characters`);
            headerError = true;
            break;
          }
          parsedHeaders[key] = v;
        }
        if (!headerError) out.headers = parsedHeaders;
      }
    }
  }

  const authUser = asTrimmedString(input.auth_username, 'auth_username', 255);
  if (authUser.error) errors.push(authUser.error);
  else if (authUser.value !== undefined) out.auth_username = authUser.value;

  if (input.auth_password !== undefined) {
    if (input.auth_password === null || input.auth_password === '') {
      out.auth_password = null;
    } else if (typeof input.auth_password !== 'string') {
      errors.push('auth_password must be a string');
    } else if (input.auth_password.length > 512) {
      errors.push('auth_password must be at most 512 characters');
    } else {
      out.auth_password = input.auth_password;
    }
  }

  const userAgent = asTrimmedString(input.user_agent, 'user_agent', 512);
  if (userAgent.error) errors.push(userAgent.error);
  else if (userAgent.value !== undefined) out.user_agent = userAgent.value;

  const follow = asBool(input.follow_redirects, 'follow_redirects');
  if (follow.error) errors.push(follow.error);
  else if (follow.value !== undefined) out.follow_redirects = follow.value;

  const expectedKeyword = asTrimmedString(input.expected_keyword, 'expected_keyword', 512);
  if (expectedKeyword.error) errors.push(expectedKeyword.error);
  else if (expectedKeyword.value !== undefined) out.expected_keyword = expectedKeyword.value;

  const forbiddenKeyword = asTrimmedString(input.forbidden_keyword, 'forbidden_keyword', 512);
  if (forbiddenKeyword.error) errors.push(forbiddenKeyword.error);
  else if (forbiddenKeyword.value !== undefined) out.forbidden_keyword = forbiddenKeyword.value;

  const keywordCase = asBool(input.keyword_case_sensitive, 'keyword_case_sensitive');
  if (keywordCase.error) errors.push(keywordCase.error);
  else if (keywordCase.value !== undefined) out.keyword_case_sensitive = keywordCase.value;

  // Common numeric fields.
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

  const retries = asInt(input.retries, 'retries', { min: 0, max: 10 });
  if (retries.error) errors.push(retries.error);
  else if (retries.value !== undefined) out.retries = retries.value;

  const retryDelay = asInt(input.retry_delay_ms, 'retry_delay_ms', { min: 0, max: 60000 });
  if (retryDelay.error) errors.push(retryDelay.error);
  else if (retryDelay.value !== undefined) out.retry_delay_ms = retryDelay.value;

  const recoveryThreshold = asInt(input.recovery_threshold, 'recovery_threshold', { min: 1, max: 20 });
  if (recoveryThreshold.error) errors.push(recoveryThreshold.error);
  else if (recoveryThreshold.value !== undefined) out.recovery_threshold = recoveryThreshold.value;

  const checkCert = asBool(input.check_certificate, 'check_certificate');
  if (checkCert.error) errors.push(checkCert.error);
  else if (checkCert.value !== undefined) out.check_certificate = checkCert.value;

  const sslThreshold = asInt(input.ssl_expiry_threshold_days, 'ssl_expiry_threshold_days', {
    min: 1,
    max: 365,
  });
  if (sslThreshold.error) errors.push(sslThreshold.error);
  else if (sslThreshold.value !== undefined) out.ssl_expiry_threshold_days = sslThreshold.value;

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
