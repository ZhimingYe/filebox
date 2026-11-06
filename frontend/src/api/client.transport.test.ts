import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let api: typeof import('./client');
let fetchMock: ReturnType<typeof vi.fn>;
let cookies: string;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  cookies = '';
  vi.spyOn(document, 'cookie', 'get').mockImplementation(() => cookies);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = await import('./client');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('cookie discovery and CSRF', () => {
  it.each([
    ['filebox_csrf_aabb0011=%20a%2Fb%3D%E4%B8%96%E7%95%8C%20', 'a/b=世界'],
    [' __Host-filebox_csrf_aabb0011=secure%2Btoken; unrelated=x', 'secure+token'],
    ['filebox_csrf_aabb0011=%E0%A4%A', null],
    ['filebox_csrf_aabb0011=%20%20', null],
    ['filebox_csrf=legacy; unrelated=x', null],
    ['', null],
    ['filebox_csrf_aabb0011=one; filebox_csrf_bbcc0022=two', null],
  ])('reads only unambiguous, decodable suffixed cookies: %j', (cookie, token) => {
    cookies = cookie;
    expect(api.getCsrfToken()).toBe(token);
  });

  it('shares concurrent discovery and caches the normalized selected suffix', async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const first = api.ensureCookieSuffix();
    const second = api.ensureCookieSuffix();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/health', {
      credentials: 'same-origin', signal: undefined,
    });
    finish(json({ hub: { cookie_suffix: 'AABB0011' } }));
    await expect(first).resolves.toBe('aabb0011');
    await expect(second).resolves.toBe('aabb0011');
    cookies = 'filebox_csrf_bbcc0022=other; filebox_csrf_aabb0011=chosen';
    expect(api.getCsrfToken()).toBe('chosen');
    await expect(api.ensureCookieSuffix()).resolves.toBe('aabb0011');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { hub: { cookie_suffix: 'short' } },
    { hub: { cookie_suffix: 12345678 } },
    { hub: null },
    {},
  ])('does not cache invalid suffix discovery %j', async body => {
    fetchMock.mockResolvedValueOnce(json(body))
      .mockResolvedValueOnce(json({ hub: { cookie_suffix: 'aabb0011' } }));
    await expect(api.ensureCookieSuffix()).resolves.toBeNull();
    await expect(api.ensureCookieSuffix()).resolves.toBe('aabb0011');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['http', 'network', 'json'])('can retry discovery after a %s failure', async failure => {
    if (failure === 'network') fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    else if (failure === 'json') fetchMock.mockResolvedValueOnce(new Response('broken'));
    else fetchMock.mockResolvedValueOnce(json({}, 503));
    fetchMock.mockResolvedValueOnce(json({ hub: { cookie_suffix: 'aabb0011' } }));
    await expect(api.ensureCookieSuffix()).resolves.toBeNull();
    await expect(api.ensureCookieSuffix()).resolves.toBe('aabb0011');
  });

  it('prefers the selected secure cookie and falls back if it is malformed', async () => {
    fetchMock.mockResolvedValue(json({ hub: { cookie_suffix: 'aabb0011' } }));
    await api.ensureCookieSuffix();
    cookies = '__Host-filebox_csrf_aabb0011=secure; filebox_csrf_aabb0011=plain';
    expect(api.getCsrfToken()).toBe('secure');
    cookies = '__Host-filebox_csrf_aabb0011=%ZZ; filebox_csrf_aabb0011=plain';
    expect(api.getCsrfToken()).toBe('plain');
  });

  it('trims memory tokens, lets cookies override them, and clears empty tokens', () => {
    api.setCsrfToken('  memory  ');
    expect(api.getCsrfToken()).toBe('memory');
    cookies = 'filebox_csrf_aabb0011=cookie';
    expect(api.getCsrfToken()).toBe('cookie');
    cookies = '';
    expect(api.getCsrfToken()).toBe('cookie');
    api.setCsrfToken(' ');
    expect(api.getCsrfToken()).toBeNull();
    api.setCsrfToken(null);
    expect(api.getCsrfToken()).toBeNull();
  });

  it('preserves caller headers and options without mutating them', () => {
    api.setCsrfToken('secret');
    const headers = new Headers({ 'X-Other': 'kept', 'X-CSRF-Token': 'stale' });
    const signal = new AbortController().signal;
    const init = api.withCsrf({ method: 'POST', headers, body: 'payload', signal });
    expect(new Headers(init.headers).get('X-Other')).toBe('kept');
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('secret');
    expect(headers.get('X-CSRF-Token')).toBe('stale');
    expect(init).toMatchObject({
      method: 'POST', credentials: 'include', body: 'payload', signal,
    });
    api.setCsrfToken(null);
    expect(new Headers(api.withCsrf().headers).has('X-CSRF-Token')).toBe(false);
  });
});

describe('request transport through public endpoints', () => {
  function stalledFetch() {
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        if (init.signal!.aborted) reject(new DOMException('aborted', 'AbortError'));
        else init.signal!.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
    );
  }

  it.each([false, true])('preserves caller abort (pre-aborted=%s) and cleans up', async preAborted => {
    stalledFetch();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    if (preAborted) controller.abort();
    const pending = api.getAgents(controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    if (!preAborted) controller.abort();
    await assertion;
    if (!preAborted) {
      expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('distinguishes a stalled request from caller cancellation', async () => {
    stalledFetch();
    const pending = api.getAgents();
    const assertion = expect(pending).rejects.toMatchObject({
      error: 'request_stalled', retryable: true,
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 503])('cleans up the caller listener and timer after HTTP %i', async status => {
    fetchMock.mockResolvedValue(json(status === 200 ? [] : { error: 'offline' }, status));
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    if (status === 200) await expect(api.getAgents(controller.signal)).resolves.toEqual([]);
    else await expect(api.getAgents(controller.signal)).rejects.toMatchObject({ status });
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('preserves HTTP status when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(api.getAgents()).rejects.toEqual({ status: 502 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replays once with the rotated CSRF token and preserves the mutation payload', async () => {
    cookies = 'filebox_csrf_aabb0011=old';
    fetchMock.mockImplementationOnce(async () => {
      cookies = 'filebox_csrf_aabb0011=new';
      return json({ error: 'csrf_denied' }, 403);
    }).mockResolvedValueOnce(json({ ok: true }));
    await expect(api.cancelRequest('a', 'request')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0][1] as RequestInit;
    const second = fetchMock.mock.calls[1][1] as RequestInit;
    expect(new Headers(first.headers).get('X-CSRF-Token')).toBe('old');
    expect(new Headers(second.headers).get('X-CSRF-Token')).toBe('new');
    expect(second.body).toBe(first.body);
    expect(JSON.parse(second.body as string)).toEqual({ agent_id: 'a', req_id: 'request' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never retries twice even if the token rotates again', async () => {
    cookies = 'filebox_csrf_aabb0011=old';
    fetchMock.mockImplementationOnce(async () => {
      cookies = 'filebox_csrf_aabb0011=new';
      return json({ error: 'csrf_denied' }, 403);
    }).mockImplementationOnce(async () => {
      cookies = 'filebox_csrf_aabb0011=newer';
      return json({ error: 'csrf_denied' }, 403);
    });
    await expect(api.getAgents()).rejects.toMatchObject({ status: 403, error: 'csrf_denied' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['same', 'absent', 'other-error'])('does not replay when refresh is %s', async mode => {
    cookies = 'filebox_csrf_aabb0011=old';
    fetchMock.mockImplementation(async () => {
      if (mode === 'absent') cookies = '';
      if (mode === 'other-error') cookies = 'filebox_csrf_aabb0011=new';
      return json({ error: mode === 'other-error' ? 'path_denied' : 'csrf_denied' }, 403);
    });
    await expect(api.getAgents()).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 'unauthorized', true], [401, 'session_expired', true],
    [401, 'invalid_credentials', false], [403, 'unauthorized', false],
    [500, 'session_expired', false],
  ])('session-expired event for HTTP %i / %s: %s', async (status, error, emitted) => {
    fetchMock.mockResolvedValue(json({ error }, status));
    const listener = vi.fn();
    window.addEventListener('filebox:session-expired', listener);
    try {
      await expect(api.getAgents()).rejects.toMatchObject({ status, error });
      expect(listener).toHaveBeenCalledTimes(emitted ? 1 : 0);
    } finally {
      window.removeEventListener('filebox:session-expired', listener);
    }
  });
});
