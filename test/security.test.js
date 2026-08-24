'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  isPrivateIp,
  parseUrl,
  validateTarget,
} = require('../src/security');

describe('private IP detection', () => {
  const privateIps = [
    '127.0.0.1', '10.0.0.5', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.10.10', '0.0.0.0', '100.64.0.1', '192.0.2.1',
    '224.0.0.1', '240.0.0.1', '::1', '::', 'fc00::1', 'fd12::1',
    'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1', '2001:db8::1',
  ];
  for (const ip of privateIps) {
    test(`detects ${ip} as private`, () => {
      assert.equal(isPrivateIp(ip), true);
    });
  }

  const publicIps = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1::a'];
  for (const ip of publicIps) {
    test(`detects ${ip} as public`, () => {
      assert.equal(isPrivateIp(ip), false);
    });
  }
});

describe('URL parsing', () => {
  test('accepts http and https', () => {
    assert.ok(parseUrl('https://example.com').parsed);
    assert.ok(parseUrl('http://example.com/path').parsed);
  });
  test('rejects non-http schemes', () => {
    assert.match(parseUrl('ftp://example.com').error, /http/i);
    assert.match(parseUrl('file:///etc/passwd').error, /http/i);
    assert.match(parseUrl('javascript:alert(1)').error, /http/i);
  });
  test('rejects credentials in URL', () => {
    assert.match(parseUrl('https://user:pass@example.com').error, /credentials/i);
  });
  test('rejects missing hostname', () => {
    assert.ok(parseUrl('https://').error);
    assert.ok(parseUrl('http://').error);
  });
  test('rejects garbage', () => {
    assert.ok(parseUrl('not a url').error);
  });
});

describe('target validation (SSRF guard)', () => {
  test('blocks private IP literals', async () => {
    const r = await validateTarget('http://127.0.0.1:3000/', {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'blocked_private');
  });

  test('blocks private hostnames', async () => {
    const r = await validateTarget('http://localhost/', {});
    assert.equal(r.ok, false);
  });

  test('allows public hostnames', async () => {
    const r = await validateTarget('https://example.com/', {});
    if (r.ok) {
      assert.equal(r.code, undefined);
    } else {
      // Offline environment: DNS resolution may fail, which is surfaced
      // as a DNS error, not a blocked/validation error.
      assert.equal(r.code, 'dns');
    }
  });

  test('allows private targets when allowPrivateNetworks is true', async () => {
    const r = await validateTarget('http://127.0.0.1:3000/', { allowPrivateNetworks: true });
    assert.equal(r.ok, true);
  });

  test('surfaces DNS failures as dns code', async () => {
    const r = await validateTarget('http://this-host-does-not-exist.invalid/', {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'dns');
  });
});
