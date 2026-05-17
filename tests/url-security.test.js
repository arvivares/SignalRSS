import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeHttpUrl, isBlockedIp, parseSafeHttpUrl } from '../src/url-security.js';

test('blocks private and metadata IP ranges', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fc00::1',
    'fe80::1',
  ]) {
    assert.equal(isBlockedIp(address), true, address);
  }
});

test('allows public IP ranges', () => {
  assert.equal(isBlockedIp('1.1.1.1'), false);
  assert.equal(isBlockedIp('8.8.8.8'), false);
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
});

test('rejects unsafe URL forms before fetching', () => {
  assert.throws(() => parseSafeHttpUrl('file:///etc/passwd'), /Blocked URL protocol/);
  assert.throws(() => parseSafeHttpUrl('http://user:pass@example.com'), /embedded credentials/);
  assert.throws(() => parseSafeHttpUrl('http://localhost:3000'), /Blocked hostname/);
  assert.throws(() => parseSafeHttpUrl('http://127.0.0.1:3000'), /Blocked private IP URL/);
  assert.throws(() => parseSafeHttpUrl('http://169.254.169.254/latest/meta-data'), /Blocked private IP URL/);
  assert.throws(() => parseSafeHttpUrl('http://service.localhost'), /Blocked hostname/);
});

test('can require HTTPS for webhooks and uploads', () => {
  assert.throws(() => parseSafeHttpUrl('http://example.com', { allowHttp: false }), /Only HTTPS/);
  assert.equal(parseSafeHttpUrl('https://example.com', { allowHttp: false }).hostname, 'example.com');
});

test('assertSafeHttpUrl blocks literal private IPs without DNS lookup', async () => {
  await assert.rejects(
    () => assertSafeHttpUrl('http://192.168.1.10/feed.xml'),
    /Blocked private IP URL/,
  );
});
