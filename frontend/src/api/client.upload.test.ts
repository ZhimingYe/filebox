import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Progress = { loaded: number; total: number; lengthComputable: boolean };

class FakeXhr {
  static instances: FakeXhr[] = [];
  method = '';
  url = '';
  withCredentials = false;
  timeout = 0;
  status = 0;
  responseText = '';
  headers = new Map<string, string>();
  body: unknown;
  upload: { onprogress: ((event: Progress) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() { FakeXhr.instances.push(this); }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
  send(body: unknown) { this.body = body; }
  abort() { this.onabort?.(); this.onloadend?.(); }
  finish(status: number, body: unknown, raw = false) {
    this.status = status;
    this.responseText = raw ? body as string : JSON.stringify(body);
    this.onload?.();
    this.onloadend?.();
  }
  fail(kind: 'network' | 'timeout') {
    if (kind === 'network') this.onerror?.();
    else this.ontimeout?.();
    this.onloadend?.();
  }
}

let api: typeof import('./client');
let cookies: string;
const file = () => new File(['abc'], '  目录 #?.txt  ');
const lastXhr = () => FakeXhr.instances.at(-1)!;

beforeEach(async () => {
  vi.resetModules();
  FakeXhr.instances = [];
  cookies = '';
  vi.spyOn(document, 'cookie', 'get').mockImplementation(() => cookies);
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  api = await import('./client');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('uploadTempFile', () => {
  it('sends trimmed encoded names, credentials, raw file bytes and CSRF headers', async () => {
    api.setCsrfToken('csrf-secret');
    const input = file();
    const pending = api.uploadTempFile('a/世界 #?', input);
    const xhr = lastXhr();
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe(
      '/api/agents/a%2F%E4%B8%96%E7%95%8C%20%23%3F/temp-upload?name='
      + encodeURIComponent('目录 #?.txt'),
    );
    expect(xhr.url).not.toContain('csrf-secret');
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.timeout).toBeGreaterThan(0);
    expect(xhr.headers.get('X-CSRF-Token')).toBe('csrf-secret');
    expect(xhr.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(xhr.body).toBe(input);
    xhr.finish(201, { ok: true, name: 'published.txt', size: 3 });
    await expect(pending).resolves.toEqual({ ok: true, name: 'published.txt', size: 3 });
  });

  it('reports only computable upload progress and defaults missing success metadata', async () => {
    const progress = vi.fn();
    const pending = api.uploadTempFile('a', file(), progress);
    const xhr = lastXhr();
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 1, total: 0 });
    expect(progress).not.toHaveBeenCalled();
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 3 });
    expect(progress).toHaveBeenCalledExactlyOnceWith(2, 3);
    xhr.finish(200, { ok: true, name: 42, size: '3' });
    await expect(pending).resolves.toEqual({ ok: true, name: '目录 #?.txt', size: 0 });
  });

  it.each([
    [200, 'broken', true, { status: 200 }],
    [200, { ok: false, error: 'rejected' }, false, { status: 200, error: 'rejected' }],
    [507, { error: 'temp_quota_exceeded', message: 'full', retryable: false }, false,
      { status: 507, error: 'temp_quota_exceeded', message: 'full', retryable: false }],
  ] as const)('maps upload HTTP %i failures', async (status, body, raw, expected) => {
    const pending = api.uploadTempFile('a', file());
    const assertion = expect(pending).rejects.toMatchObject(expected);
    lastXhr().finish(status, body, raw);
    await assertion;
  });

  it.each([
    ['network', 'network_error'], ['timeout', 'request_stalled'], ['abort', 'cancelled'],
  ] as const)('maps %s failures and removes the abort listener', async (kind, error) => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = api.uploadTempFile('a', file(), undefined, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ error });
    if (kind === 'abort') controller.abort();
    else lastXhr().fail(kind);
    await assertion;
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
  });

  it('removes the abort listener after success so later abort cannot touch the upload', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = api.uploadTempFile('a', file(), undefined, controller.signal);
    const xhr = lastXhr();
    const abort = vi.spyOn(xhr, 'abort');
    xhr.finish(200, { ok: true });
    await pending;
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    controller.abort();
    expect(abort).not.toHaveBeenCalled();
  });

  it('retries once after token rotation, using the same file and new header', async () => {
    cookies = 'filebox_csrf_aabb0011=old';
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const input = file();
    const pending = api.uploadTempFile('a', input, undefined, controller.signal);
    const first = lastXhr();
    cookies = 'filebox_csrf_aabb0011=new';
    first.finish(403, { error: 'csrf_denied' });
    expect(FakeXhr.instances).toHaveLength(2);
    const second = lastXhr();
    expect(first.headers.get('X-CSRF-Token')).toBe('old');
    expect(second.headers.get('X-CSRF-Token')).toBe('new');
    expect(second.body).toBe(input);
    expect(second.url).toBe(first.url);
    second.finish(200, { ok: true });
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[1][1]);
  });

  it('does not replay a second denial even if the cookie rotates again', async () => {
    cookies = 'filebox_csrf_aabb0011=old';
    const pending = api.uploadTempFile('a', file());
    const assertion = expect(pending).rejects.toMatchObject({ status: 403, error: 'csrf_denied' });
    cookies = 'filebox_csrf_aabb0011=new';
    lastXhr().finish(403, { error: 'csrf_denied' });
    cookies = 'filebox_csrf_aabb0011=newer';
    lastXhr().finish(403, { error: 'csrf_denied' });
    await assertion;
    expect(FakeXhr.instances).toHaveLength(2);
  });

  it.each(['unchanged', 'missing'])('does not replay when refreshed token is %s', async mode => {
    cookies = 'filebox_csrf_aabb0011=old';
    const pending = api.uploadTempFile('a', file());
    const assertion = expect(pending).rejects.toMatchObject({ status: 403 });
    if (mode === 'missing') cookies = '';
    lastXhr().finish(403, { error: 'csrf_denied' });
    await assertion;
    expect(FakeXhr.instances).toHaveLength(1);
  });
});
