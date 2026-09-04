'use strict';

const net = require('net');
const dns = require('dns');
const tls = require('tls');
const { execFile } = require('child_process');
const { validateTarget, parseUrl, validateHostPort } = require('./security');

const MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = 'UptimeMonitor/1.0 (+https://github.com/uptime-monitor)';
const MAX_BODY_BYTES = 1024 * 1024;

function classifyError(err) {
  const cause = err && err.cause ? err.cause : {};
  const code = cause.code || '';
  const name = (err && err.name ? err.name : '') + (cause.name || '');

  if (err && err.name === 'AbortError') {
    return { errorType: 'timeout', message: 'Request timed out' };
  }
  if (
    code === 'UND_ERR_ABORTED' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'ETIMEDOUT'
  ) {
    return { errorType: 'timeout', message: 'Request timed out' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA') {
    return { errorType: 'dns', message: 'DNS resolution failed' };
  }
  if (
    /CERT|TLS|UNABLE_TO_VERIFY|DEPTH_ZERO|SSL|HANDSHAKE/i.test(code) ||
    /CERT|TLS|SSL/i.test(name)
  ) {
    return { errorType: 'tls', message: 'TLS/SSL error' };
  }
  if (
    ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'ECONNABORTED', 'EADDRNOTAVAIL'].includes(code)
  ) {
    return { errorType: 'connection', message: 'Connection failed' };
  }
  return { errorType: 'other', message: (err && err.message) || 'Request failed' };
}

function failure(errorType, message, statusCode, startMs, opts = {}) {
  return {
    status: 'down',
    responseTime: Date.now() - startMs,
    statusCode: statusCode ?? null,
    errorType,
    errorMessage: message,
    timestamp: opts.timestamp ?? startMs,
    packetLoss: opts.packetLoss ?? null,
    certExpiresAt: opts.certExpiresAt ?? null,
    certError: opts.certError ?? null,
  };
}

function applyDegradation(result, service) {
  if (
    result.status === 'up' &&
    service.degraded_threshold_ms &&
    result.responseTime != null &&
    result.responseTime > service.degraded_threshold_ms
  ) {
    result.status = 'degraded';
  }
  return result;
}

function buildHeaders(service) {
  const headers = { accept: '*/*' };
  headers['user-agent'] = service.user_agent || DEFAULT_USER_AGENT;
  if (service.auth_username && service.auth_password) {
    headers.authorization =
      'Basic ' + Buffer.from(`${service.auth_username}:${service.auth_password}`).toString('base64');
  }
  if (service.headers && typeof service.headers === 'object') {
    for (const [key, value] of Object.entries(service.headers)) {
      if (value === null || value === undefined) continue;
      headers[String(key).toLowerCase()] = String(value);
    }
  }
  return headers;
}

async function doFetch(parsedUrl, service, startMs, { readBody = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), service.timeout_ms);
  try {
    const res = await fetch(parsedUrl.toString(), {
      method: service.method || 'GET',
      signal: controller.signal,
      redirect: 'manual',
      cache: 'no-store',
      headers: buildHeaders(service),
    });
    const elapsed = Date.now() - startMs;
    const location = res.headers.get('location');
    let body = null;
    if (readBody && res.body) {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (total < MAX_BODY_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.length;
          if (total >= MAX_BODY_BYTES) break;
        }
      } catch {
        /* truncated body is acceptable for keyword checks */
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
      }
      body = Buffer.concat(chunks).toString('utf8');
    } else if (res.body) {
      res.body.cancel().catch(() => {});
    }
    return { ok: true, status: res.status, elapsed, location, body };
  } catch (err) {
    return { ok: false, error: classifyError(err) };
  } finally {
    clearTimeout(timer);
  }
}

function keywordCheck(service, bodyText, statusOk) {
  if (!statusOk) return { down: false };
  if (!service.expected_keyword && !service.forbidden_keyword) return { down: false };
  if (bodyText == null) {
    return {
      down: true,
      errorType: 'content',
      errorMessage: 'Response body could not be read for keyword check',
    };
  }
  const cs = Boolean(service.keyword_case_sensitive);
  const haystack = cs ? bodyText : bodyText.toLowerCase();
  if (service.expected_keyword) {
    const needle = cs ? service.expected_keyword : service.expected_keyword.toLowerCase();
    if (!haystack.includes(needle)) {
      return {
        down: true,
        errorType: 'content',
        errorMessage: `Expected keyword "${service.expected_keyword}" not found in response`,
      };
    }
  }
  if (service.forbidden_keyword) {
    const needle = cs ? service.forbidden_keyword : service.forbidden_keyword.toLowerCase();
    if (haystack.includes(needle)) {
      return {
        down: true,
        errorType: 'content',
        errorMessage: `Forbidden keyword "${service.forbidden_keyword}" found in response`,
      };
    }
  }
  return { down: false };
}

/**
 * Inspect the TLS certificate presented by an HTTPS host. Always resolves
 * (never throws); network failures yield null cert data rather than failing
 * the HTTP check, which records its own outcome.
 */
function inspectCertificate(parsed, timeoutMs) {
  return new Promise((resolve) => {
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 443;
    let socket;
    try {
      socket = tls.connect({
        host,
        port,
        servername: host,
        rejectUnauthorized: false,
      });
    } catch {
      return resolve({ certExpiresAt: null, certError: null });
    }
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    const timer = setTimeout(() => done({ certExpiresAt: null, certError: null }), timeoutMs);
    socket.on('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      let certExpiresAt = null;
      if (cert && cert.valid_to) {
        const t = Date.parse(cert.valid_to);
        if (!Number.isNaN(t)) certExpiresAt = t;
      }
      let certError = null;
      if (!socket.authorized) {
        certError = socket.authorizationError
          ? String(socket.authorizationError)
          : 'Certificate is not authorized';
      }
      done({ certExpiresAt, certError });
    });
    socket.on('error', () => done({ certExpiresAt: null, certError: null }));
    socket.on('timeout', () => done({ certExpiresAt: null, certError: null }));
  });
}

async function checkHttp(service, startMs, allowPrivateNetworks) {
  const { parsed, error } = parseUrl(service.url);
  if (error) return failure('invalid', error, null, startMs);

  const followRedirects = service.follow_redirects !== false;
  const needBody = Boolean(service.expected_keyword || service.forbidden_keyword);
  let target = service.url;
  let redirects = 0;
  let certTarget = parsed;

  const sslPromise =
    parsed.protocol === 'https:' && service.check_certificate !== false
      ? inspectCertificate(parsed, service.timeout_ms)
      : Promise.resolve({ certExpiresAt: null, certError: null });

  while (true) {
    const validation = await validateTarget(target, { allowPrivateNetworks });
    if (!validation.ok) {
      if (validation.code === 'dns') {
        return failure('dns', 'DNS resolution failed', null, startMs);
      }
      return failure('blocked', validation.message, null, startMs);
    }
    certTarget = validation.parsed;

    const res = await doFetch(validation.parsed, service, startMs, { readBody: needBody });
    if (!res.ok) {
      const f = failure(res.error.errorType, res.error.message, null, startMs);
      const cert = await sslPromise;
      return { ...f, certExpiresAt: cert.certExpiresAt, certError: cert.certError };
    }

    if (followRedirects && res.status >= 300 && res.status < 400 && res.location) {
      if (redirects >= MAX_REDIRECTS) {
        const f = failure('other', 'Too many redirects', res.status, startMs);
        const cert = await sslPromise;
        return { ...f, certExpiresAt: cert.certExpiresAt, certError: cert.certError };
      }
      redirects += 1;
      try {
        target = new URL(res.location, validation.parsed).toString();
      } catch {
        const f = failure('invalid', 'Invalid redirect URL', res.status, startMs);
        const cert = await sslPromise;
        return { ...f, certExpiresAt: cert.certExpiresAt, certError: cert.certError };
      }
      continue;
    }

    const expected = service.expected_status_codes || [200];
    const statusOk = expected.includes(res.status);
    const keyword = keywordCheck(service, res.body, statusOk);

    let status;
    let errorType = null;
    let errorMessage = null;
    if (!statusOk) {
      status = 'down';
      errorType = 'http_status';
      errorMessage = `Expected status ${expected.join(', ')} but received ${res.status}`;
    } else if (keyword.down) {
      status = 'down';
      errorType = keyword.errorType;
      errorMessage = keyword.errorMessage;
    } else if (service.degraded_threshold_ms && res.elapsed > service.degraded_threshold_ms) {
      status = 'degraded';
    } else {
      status = 'up';
    }

    const cert = await sslPromise;
    return {
      status,
      responseTime: res.elapsed,
      statusCode: res.status,
      errorType,
      errorMessage,
      timestamp: startMs,
      redirects,
      packetLoss: null,
      certExpiresAt: cert.certExpiresAt,
      certError: cert.certError,
    };
  }
}

const PING_COUNT = 3;

function parsePingOutput(stdout) {
  const timeMatches = [...String(stdout).matchAll(/time[=<]([\d.]+)\s*ms/g)].map((m) => Number(m[1]));
  const avgMs =
    timeMatches.length > 0
      ? Math.round(timeMatches.reduce((a, b) => a + b, 0) / timeMatches.length)
      : null;
  const lossMatch = String(stdout).match(/([\d.]+)%\s*packet loss/i);
  const packetLoss = lossMatch ? Number(lossMatch[1]) : null;
  return { avgMs, packetLoss };
}

function runPing(host, count, timeoutMs) {
  return new Promise((resolve) => {
    const waitSec = Math.max(1, Math.floor(timeoutMs / 1000));
    execFile(
      'ping',
      ['-c', String(count), '-W', String(waitSec), host],
      { timeout: timeoutMs + 3000 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') {
            resolve({ error: 'unavailable', stdout, stderr });
          } else if (err.killed || err.code === null) {
            resolve({ error: 'timeout', stdout, stderr });
          } else {
            resolve({ error: 'ping', stdout, stderr });
          }
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
  });
}

async function checkPing(service, startMs, allowPrivateNetworks) {
  const host = service.host;
  if (!host) return failure('invalid', 'A host is required for ping monitoring', null, startMs);

  const validation = await validateHostPort(host, 0, { allowPrivateNetworks });
  if (!validation.ok) {
    if (validation.code === 'dns') {
      return failure('dns', 'DNS resolution failed', null, startMs);
    }
    return failure('blocked', validation.message, null, startMs);
  }

  const out = await runPing(host, PING_COUNT, service.timeout_ms);
  if (out.error === 'unavailable') {
    return failure('unavailable', 'The ping command is not available on this host', null, startMs);
  }
  const { avgMs, packetLoss } = parsePingOutput(out.stdout || '');
  if (out.error === 'timeout') {
    return failure('timeout', 'Ping timed out', null, startMs, { packetLoss });
  }
  if (avgMs == null || (packetLoss != null && packetLoss >= 100)) {
    return failure(
      'ping',
      packetLoss != null ? `No reply (${packetLoss}% packet loss)` : 'No reply from host',
      null,
      startMs,
      { packetLoss: packetLoss ?? 100 }
    );
  }
  return applyDegradation(
    {
      status: packetLoss != null && packetLoss > 0 ? 'degraded' : 'up',
      responseTime: avgMs,
      statusCode: null,
      errorType: null,
      errorMessage: null,
      timestamp: startMs,
      packetLoss,
    },
    service
  );
}

async function checkTcp(service, startMs, allowPrivateNetworks) {
  const host = service.host;
  const port = service.port;
  if (!host || !port) return failure('invalid', 'Host and port are required for TCP monitoring', null, startMs);

  const validation = await validateHostPort(host, port, { allowPrivateNetworks });
  if (!validation.ok) {
    if (validation.code === 'dns') {
      return failure('dns', 'DNS resolution failed', null, startMs);
    }
    return failure('blocked', validation.message, null, startMs);
  }

  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      done(failure('timeout', 'Connection timed out', null, startMs));
    }, service.timeout_ms);
    socket.setTimeout(service.timeout_ms);
    socket.on('connect', () => {
      done(
        applyDegradation(
          {
            status: 'up',
            responseTime: Date.now() - startMs,
            statusCode: null,
            errorType: null,
            errorMessage: null,
            timestamp: startMs,
          },
          service
        )
      );
    });
    socket.on('error', (err) => {
      const code = err.code || '';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA') {
        done(failure('dns', 'DNS resolution failed', null, startMs));
      } else if (code === 'ETIMEDOUT') {
        done(failure('timeout', 'Connection timed out', null, startMs));
      } else {
        const msg =
          code === 'ECONNREFUSED'
            ? 'Connection refused'
            : code === 'EHOSTUNREACH'
              ? 'Host unreachable'
              : 'Connection failed';
        done(failure('connection', msg, null, startMs));
      }
    });
    socket.on('timeout', () => {
      done(failure('timeout', 'Connection timed out', null, startMs));
    });
  });
}

async function checkDns(service, startMs, allowPrivateNetworks) {
  const host = service.host;
  if (!host) return failure('invalid', 'A host is required for DNS monitoring', null, startMs);

  const validation = await validateHostPort(host, 53, { allowPrivateNetworks });
  if (!validation.ok && validation.code !== 'dns') {
    return failure('blocked', validation.message, null, startMs);
  }

  try {
    const res = await dns.promises.lookup(host, { all: true, verbatim: true });
    const elapsed = Date.now() - startMs;
    const addresses = res.map((r) => r.address);
    const expectedIp = service.expected_ip;
    if (expectedIp && !addresses.includes(expectedIp)) {
      return {
        status: 'down',
        responseTime: elapsed,
        statusCode: null,
        errorType: 'dns_content',
        errorMessage: `Expected IP ${expectedIp} but resolved ${addresses.join(', ') || 'nothing'}`,
        timestamp: startMs,
        addresses,
      };
    }
    return applyDegradation(
      {
        status: 'up',
        responseTime: elapsed,
        statusCode: null,
        errorType: null,
        errorMessage: null,
        timestamp: startMs,
        addresses,
      },
      service
    );
  } catch (err) {
    return failure('dns', 'DNS resolution failed', null, startMs);
  }
}

/**
 * Perform a single check for a monitor. Dispatches on service.type and returns
 * a normalized result:
 *   { status, responseTime, statusCode, errorType, errorMessage, timestamp,
 *     packetLoss, certExpiresAt, certError }
 */
async function performCheck(service, { allowPrivateNetworks = false } = {}) {
  const startMs = Date.now();
  const type = service.type || 'http';
  switch (type) {
    case 'ping':
      return checkPing(service, startMs, allowPrivateNetworks);
    case 'tcp':
      return checkTcp(service, startMs, allowPrivateNetworks);
    case 'dns':
      return checkDns(service, startMs, allowPrivateNetworks);
    case 'http':
    default:
      return checkHttp(service, startMs, allowPrivateNetworks);
  }
}

module.exports = {
  performCheck,
  classifyError,
  parsePingOutput,
  keywordCheck,
  inspectCertificate,
};
