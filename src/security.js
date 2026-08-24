'use strict';

const net = require('net');
const dns = require('dns');
const { URL } = require('url');

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
  }
  return parts.reduce((acc, p) => (acc * 256 + Number(p)) >>> 0, 0) >>> 0;
}

function isPrivateIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const a = n >>> 24;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && ((n >>> 16) & 0xff) === 254) return true;
  if (a === 172 && ((n >>> 16) & 0xf0) === 16) return true;
  if (a === 192 && ((n >>> 16) & 0xff) === 168) return true;
  if (a === 100 && ((n >>> 16) & 0xc0) === 64) return true;
  if (a === 192 && ((n >>> 16) & 0xff) === 0 && (n & 0xffff) === 0) return true;
  if (a === 192 && ((n >>> 16) & 0xff) === 0 && ((n >>> 8) & 0xff) === 2) return true;
  if (a === 198 && ((n >>> 16) & 0xfe) === 18) return true;
  if (a === 198 && ((n >>> 16) & 0xff) === 51 && ((n >>> 8) & 0xff) === 100) return true;
  if (a === 203 && ((n >>> 16) & 0xff) === 0 && ((n >>> 8) & 0xff) === 113) return true;
  if (a === 224) return true;
  if (a === 240 || a === 241 || a === 242 || a === 243 || a === 244 || a === 245 || a === 246 || a === 247 || a === 248 || a === 249 || a === 250 || a === 251 || a === 252 || a === 253 || a === 254) return true;
  if (n === 0xffffffff) return true;
  return false;
}

const IPV6_PRIVATE_PREFIXES = [
  '::1',
  '::',
  'fc',
  'fd',
  'fe80',
  'fec0',
  'feb0',
  'fe90',
  'ff',
  '2001:db8',
  '2001:10',
  '2002:',
];

function isPrivateIpv6(ip) {
  const lower = ip.toLowerCase();
  if (lower.includes('::ffff:')) {
    const v4 = lower.split('::ffff:')[1];
    if (v4 && v4.includes('.')) return isPrivateIpv4(v4);
    return true;
  }
  if (lower.includes('64:ff9b:')) {
    const v4 = lower.split('64:ff9b:')[1];
    if (v4 && v4.includes('.')) return isPrivateIpv4(v4);
    return true;
  }
  for (const prefix of IPV6_PRIVATE_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return false;
}

function isPrivateHostname(hostname) {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h === 'ip6-localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h === '.'
  );
}

function parseUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return { error: 'Invalid URL' };
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { error: 'Only http:// and https:// URLs are allowed' };
  }
  if (!parsed.hostname) {
    return { error: 'URL must include a hostname' };
  }
  if (parsed.username || parsed.password) {
    return { error: 'URL must not include credentials' };
  }
  return { parsed };
}

/**
 * Resolve hostname to all addresses. Returns { addresses: [ip,...] } or
 * { error: 'dns' } when resolution fails (temporary failure / NXDOMAIN).
 */
async function resolveHost(hostname) {
  if (net.isIP(hostname)) return { addresses: [hostname] };
  if (isPrivateHostname(hostname)) {
    return { addresses: ['127.0.0.1'] };
  }
  try {
    const res = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    const addresses = res.map((r) => r.address);
    if (addresses.length === 0) return { addresses: [] };
    return { addresses };
  } catch {
    return { error: 'dns' };
  }
}

/**
 * Full target validation including DNS resolution. Returns
 *   { ok: true, parsed }                 — target is safe to request
 *   { ok: false, code, message }         — blocked or invalid
 * DNS resolution failures are surfaced separately so the worker can
 * record them as DNS errors rather than validation errors.
 */
async function validateTarget(input, { allowPrivateNetworks = false } = {}) {
  const { parsed, error } = parseUrl(input);
  if (error) return { ok: false, code: 'invalid_url', message: error };
  if (allowPrivateNetworks) return { ok: true, parsed };

  const { addresses, error: resolveError } = await resolveHost(parsed.hostname);
  if (resolveError) return { ok: false, code: 'dns', message: 'Could not resolve hostname' };
  const privateAddresses = addresses.filter(isPrivateIp);
  if (privateAddresses.length > 0) {
    return {
      ok: false,
      code: 'blocked_private',
      message: `Target resolves to a private address (${privateAddresses[0]}). Set ALLOW_PRIVATE_NETWORKS=true to allow monitoring internal networks.`,
    };
  }
  return { ok: true, parsed };
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; ')
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
}

module.exports = {
  parseUrl,
  isPrivateIp,
  isPrivateHostname,
  resolveHost,
  validateTarget,
  securityHeaders,
};
