import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(new URL('../../../frontend/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(new URL('./fwd-shim.js', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('./fwd-worker-shim.js', import.meta.url), 'utf8');
const prefix = '/_fwd/agent/9001';
function setup(html = '', protocol = 'https:') {
  const dom = new JSDOM(html, { url: `${protocol}//hub.test${prefix}/dir/page`, runScripts: 'outside-only' });
  const { window } = dom;
  const calls = [];
  // jsdom omits the browser's reflected formAction property.
  for (const type of [window.HTMLButtonElement, window.HTMLInputElement]) {
    if (!Object.getOwnPropertyDescriptor(type.prototype, 'formAction')) Object.defineProperty(type.prototype, 'formAction', {
      configurable: true,
      get() { return new URL(this.getAttribute('formaction') || '', window.document.baseURI).href; },
      set(value) { this.setAttribute('formaction', value); },
    });
  }
  window.Request = Request;
  window.fetch = (...args) => { calls.push(args); return Promise.resolve(); };
  window.eval(source);
  return { dom, window, document: window.document, calls };
}

test('static/dynamic manifests, case and rel tokens, explicit crossorigin and mutation observer', async () => {
  const { dom, document } = setup('<link rel="MANIFEST alternate" href="/manifest"><link rel=manifest crossorigin=anonymous>');
  try {
    assert.equal(document.querySelector('link').getAttribute('crossorigin'), 'use-credentials');
    assert.equal(document.querySelectorAll('link')[1].getAttribute('crossorigin'), 'anonymous');
    const container = document.createElement('div');
    container.innerHTML = '<link href="/dynamic" rel=manifest><link rel=manifest crossorigin="">';
    document.body.append(container);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(container.firstChild.getAttribute('crossorigin'), 'use-credentials');
    assert.equal(container.lastChild.getAttribute('crossorigin'), '');
    const link = document.createElement('link');
    document.head.append(link);
    link.rel = 'alternate manifest';
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(link.crossOrigin, 'use-credentials');
    link.removeAttribute('crossorigin');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(link.crossOrigin, 'use-credentials');
  } finally { dom.window.close(); }
});

test('base URI is honored for relative paths, root bases, loopback bases and external bases', async () => {
  const { dom, document, window, calls } = setup(`<base href="${prefix}/app/">`);
  try {
    await window.fetch('api');
    assert.equal(calls.at(-1)[0], `https://hub.test${prefix}/app/api`);
    document.querySelector('base').href = '/next/';
    assert.equal(document.baseURI, `https://hub.test${prefix}/next/`);
    await window.fetch('api');
    assert.equal(calls.at(-1)[0], `https://hub.test${prefix}/next/api`);
    document.querySelector('base').setAttribute('href', 'http://localhost:9001/local/');
    assert.equal(document.baseURI, `https://hub.test${prefix}/local/`);
    document.querySelector('base').href = 'https://external.test/base/';
    await window.fetch('api');
    assert.equal(calls.at(-1)[0], 'api');
  } finally { dom.window.close(); }
});

test('all specified elements rewrite URL attributes and inherited native property setters without changing external/invalid URLs', () => {
  const { dom, document } = setup();
  try {
    for (const [tag, keys] of [['script', ['src']], ['link', ['href']], ['img', ['src']], ['iframe', ['src']], ['a', ['href']], ['form', ['action']], ['source', ['src']], ['video', ['src', 'poster']], ['audio', ['src']], ['button', ['formAction']], ['input', ['formAction']]]) {
      const element = document.createElement(tag);
      for (const key of keys) {
        const attribute = key.toLowerCase();
        element.setAttribute(attribute, '/asset');
        assert.equal(element.getAttribute(attribute), `https://hub.test${prefix}/asset`, `${tag} ${attribute}`);
        element[key] = '/property';
        assert.equal(element.getAttribute(attribute), `https://hub.test${prefix}/property`, `${tag} ${key}`);
        for (const value of ['https://external.test/x', 'data:text/plain,hello', 'javascript:void(0)', 'http://[bad']) {
          assert.doesNotThrow(() => element.setAttribute(attribute, value));
          assert.equal(element.getAttribute(attribute), value);
        }
        assert.doesNotThrow(() => { element[key] = ''; });
        assert.doesNotThrow(() => { element[key] = null; });
      }
    }
    const div = document.createElement('div');
    div.setAttribute('src', '/unchanged');
    assert.equal(div.getAttribute('src'), '/unchanged');
  } finally { dom.window.close(); }
});

test('capture click handles nested anchors, _blank/noreferrer and native markup; form submit and external submitter formaction', () => {
  const { dom, document, window } = setup('<meta name=referrer content=no-referrer><a target=_blank rel=noreferrer href="/next"><span>Go</span></a><form id=f action=/submit><button formaction=/alternate>Send</button></form><button id=outside form=f formaction=/outside>External</button>');
  try {
    const anchor = document.querySelector('a');
    document.addEventListener('click', event => event.preventDefault());
    anchor.firstChild.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(anchor.href, `https://hub.test${prefix}/next`);
    assert.equal(anchor.target, '_blank');
    assert.equal(anchor.rel, 'noreferrer');
    const form = document.querySelector('form');
    document.addEventListener('submit', event => event.preventDefault());
    form.dispatchEvent(new window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: document.getElementById('outside') }));
    assert.equal(form.action, `https://hub.test${prefix}/submit`);
    assert.equal(document.querySelector('form button').getAttribute('formaction'), `https://hub.test${prefix}/alternate`);
    assert.equal(document.getElementById('outside').getAttribute('formaction'), `https://hub.test${prefix}/outside`);
    form.removeAttribute('action');
    form.dispatchEvent(new window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
    assert.equal(form.action, window.location.href);
  } finally { dom.window.close(); }
});

test('loopback http/https/ws/wss URLs map only the forwarded port, preserving query/fragment and cross-forward paths', async () => {
  const { dom, window, calls } = setup();
  try {
    for (const scheme of ['http', 'https', 'ws', 'wss']) for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      await window.fetch(`${scheme}://${host}:9001/api?q=1#x`);
      assert.equal(calls.at(-1)[0], `${scheme.startsWith('ws') ? 'wss' : 'https'}://hub.test${prefix}/api?q=1#x`);
    }
    for (const input of ['http://localhost:9002/x', 'http://localhost.evil:9001/x', 'http://[invalid', 'data:text/plain,x']) {
      await window.fetch(input);
      assert.equal(calls.at(-1)[0], input);
    }
    await window.fetch(prefix + '/x');
    assert.equal(calls.at(-1)[0], 'https://hub.test' + prefix + '/x');
    await window.fetch('/_fwd/other/9002/x');
    assert.equal(calls.at(-1)[0], 'https://hub.test/_fwd/other/9002/x');
  } finally { dom.window.close(); }
});

test('document.cookie scopes paths, drops domains, aliases host cookies and preserves deletion/expiry', () => {
  for (const protocol of ['https:', 'http:']) {
    const { dom, window, document } = setup('', protocol);
    try {
      document.cookie = '__Host-id=a=b; Path=/; Domain=localhost; Secure; SameSite=None';
      document.cookie = '__Secure-id=secure; Path=/; Secure; SameSite=None';
      document.cookie = 'normal=x; Path=/';
      assert.ok(document.cookie.includes('__Host-id=a=b'));
      assert.ok(document.cookie.includes('__Secure-id=secure'));
      const cookies = dom.cookieJar.getCookiesSync(window.location.href);
      assert.ok(cookies.every(cookie => cookie.path === prefix + '/'));
      assert.ok(cookies.every(cookie => cookie.hostOnly));
      assert.ok(cookies.some(cookie => cookie.key === (protocol === 'https:' ? '__Secure-fbh-id' : 'fbs-fbh-id')));
      assert.ok(cookies.some(cookie => cookie.key === (protocol === 'https:' ? '__Secure-id' : 'fbs-id')));
      if (protocol === 'http:') { assert.ok(cookies.every(cookie => !cookie.secure)); assert.equal(cookies.find(c => c.key === 'fbs-id').sameSite, 'lax'); }
      assert.equal(dom.cookieJar.getCookieStringSync(`${protocol}//hub.test/_fwd/agent/9002/`), '');
      document.cookie = '__Host-id=; Path=/; Secure; Max-Age=0';
      assert.ok(!document.cookie.includes('__Host-id='));
      document.cookie = `already=1; Path=${prefix}/; Path=/other; Domain=hub.test`;
      assert.ok(document.cookie.includes('already=1'));
      document.cookie = 'default=1';
      assert.ok(document.cookie.includes('default=1'));
      document.cookie = 'expired=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
      assert.ok(!document.cookie.includes('expired='));
      assert.doesNotThrow(() => { document.cookie = ''; });
    } finally { dom.window.close(); }
  }
});

test('shim is idempotent and does not alter non-forward pages', () => {
  const { dom, window } = setup();
  try {
    const original = window.Element.prototype.setAttribute;
    const cookie = Object.getOwnPropertyDescriptor(window.document, 'cookie');
    window.eval(source);
    assert.equal(window.Element.prototype.setAttribute, original);
    assert.equal(Object.getOwnPropertyDescriptor(window.document, 'cookie').set, cookie.set);
  } finally { dom.window.close(); }
  const outside = new JSDOM('', { url: 'https://hub.test/', runScripts: 'outside-only' });
  const original = outside.window.Element.prototype.setAttribute;
  outside.window.eval(source);
  assert.equal(outside.window.Element.prototype.setAttribute, original);
  outside.window.close();
});

test('worker shim supports classic and module contexts: fetch, native Requests, XHR, WebSocket/EventSource and importScripts', async () => {
  for (const module of [false, true]) {
    const calls = [];
    const context = { URL, Request, location: new URL(`https://hub.test${prefix}/worker.js`), fetch: (...args) => { calls.push(['fetch', ...args]); return Promise.resolve(); }, XMLHttpRequest: class { open(...args) { calls.push(['xhr', ...args]); } }, WebSocket: class { constructor(...args) { calls.push(['ws', ...args]); } }, EventSource: class { constructor(...args) { calls.push(['events', ...args]); } } };
    if (!module) context.importScripts = (...args) => calls.push(['imports', ...args]);
    context.self = context;
    vm.runInNewContext(workerSource, context);
    await context.fetch('/api');
    assert.deepEqual(calls.at(-1), ['fetch', `https://hub.test${prefix}/api`]);
    const request = new context.Request('/api', { method: 'POST', body: 'upload' });
    await context.fetch(request);
    assert.equal(calls.at(-1)[1], request);
    assert.equal(await request.text(), 'upload');
    new context.XMLHttpRequest().open('GET', '/xhr');
    assert.deepEqual(calls.at(-1), ['xhr', 'GET', `https://hub.test${prefix}/xhr`]);
    new context.WebSocket('ws://127.0.0.1:9001/ws');
    assert.deepEqual(calls.at(-1), ['ws', `wss://hub.test${prefix}/ws`]);
    new context.EventSource('/events');
    assert.deepEqual(calls.at(-1), ['events', `https://hub.test${prefix}/events`]);
    if (!module) { context.importScripts('/a.js', 'https://external.test/b.js'); assert.deepEqual(calls.at(-1), ['imports', `https://hub.test${prefix}/a.js`, 'https://external.test/b.js']); }
    await context.fetch('http://localhost:9002/other');
    assert.equal(calls.at(-1)[1], 'http://localhost:9002/other');
    await context.fetch('http://[invalid');
    assert.equal(calls.at(-1)[1], 'http://[invalid');
    const original = context.fetch;
    vm.runInNewContext(workerSource, context);
    assert.equal(context.fetch, original);
  }
});
