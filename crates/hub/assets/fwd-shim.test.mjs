import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('./fwd-shim.js', import.meta.url), 'utf8');
function setup() {
  const calls = [];
  const context = {
    URL, Request, location: new URL('http://hub.test/_fwd/agent/9001/'),
    document: { baseURI: 'http://hub.test/_fwd/agent/9001/' },
    navigator: {}, history: {}, XMLHttpRequest: class { open() {} },
    fetch: (...args) => { calls.push(args); return Promise.resolve(); },
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return { context, calls };
}

test('rewrites Request URLs at construction without rebuilding upload bodies at fetch', async () => {
  const { context, calls } = setup();
  const request = new context.Request('/api/x', { method: 'POST', body: 'payload' });
  assert.equal(request.url, 'http://hub.test/_fwd/agent/9001/api/x');
  assert.ok(request instanceof Request);
  await context.fetch(request);
  assert.equal(calls[0][0], request);
  assert.equal(request.bodyUsed, false);
  assert.equal(await request.text(), 'payload');
});

test('preserves copied, empty and pre-existing Requests for native fetch and Referer fallback', async () => {
  const { context, calls } = setup();
  for (const request of [new context.Request('/api/x'), new context.Request(new context.Request('/api/x')), new Request('http://hub.test/api/x', { method: 'PUT', body: 'original' })]) {
    await context.fetch(request);
    assert.equal(calls.at(-1)[0], request);
  }
});

test('keeps strings, URLs, external origins and repeated injection working', async () => {
  const { context, calls } = setup();
  for (const input of ['/api/x', new URL('http://hub.test/api/x')]) {
    await context.fetch(input);
    assert.equal(calls.at(-1)[0], 'http://hub.test/_fwd/agent/9001/api/x');
  }
  assert.equal(new context.Request('https://other.test/api').url, 'https://other.test/api');
  assert.throws(() => new context.Request('/api/x', { method: 'GET', body: 'invalid' }), TypeError);
  const patched = context.Request;
  vm.runInNewContext(source, context);
  assert.equal(context.Request, patched);
});
