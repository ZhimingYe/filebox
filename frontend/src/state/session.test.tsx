import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { useSession } from './session';
import { forwardNext } from './forwardNext';

vi.mock('../api/client', () => ({
  ensureCookieSuffix: vi.fn(),
  getAgents: vi.fn(),
  getCsrfToken: vi.fn(),
  setCsrfToken: vi.fn(),
  exchangeSession: vi.fn(),
  logout: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null;
let host: HTMLDivElement;
let session: ReturnType<typeof useSession>;
let renders: number;
let navigate: ReturnType<typeof vi.fn>;

function Harness() {
  const value = useSession(navigate);
  renders++;
  useEffect(() => { session = value; });
  return null;
}

function mount() {
  host = document.createElement('div');
  root = createRoot(host);
  act(() => { root!.render(<Harness />); });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  renders = 0;
  root = null;
  navigate = vi.fn();
  vi.mocked(api.ensureCookieSuffix).mockResolvedValue(null);
  vi.mocked(api.getAgents).mockResolvedValue([]);
  vi.mocked(api.getCsrfToken).mockReturnValue(null);
});
afterEach(() => {
  act(() => { root?.unmount(); });
  host?.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

describe('useSession verification', () => {
  it('waits for cookie-suffix discovery before verifying the session', async () => {
    const discovery = deferred<string | null>();
    vi.mocked(api.ensureCookieSuffix).mockReturnValue(discovery.promise);
    mount();
    expect(session.loggedIn).toBeNull();
    expect(api.ensureCookieSuffix).toHaveBeenCalledTimes(1);
    expect(api.getAgents).not.toHaveBeenCalled();
    await act(async () => { discovery.resolve('aabb0011'); });
    expect(api.getAgents).toHaveBeenCalledTimes(1);
    expect(session.loggedIn).toBe(true);
  });

  it('retries transient failures after 400ms and 800ms, then accepts success', async () => {
    vi.mocked(api.getAgents)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValueOnce([]);
    mount();
    await act(async () => {});
    expect(api.getAgents).toHaveBeenCalledTimes(1);
    expect(session.loggedIn).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(399); });
    expect(api.getAgents).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.getAgents).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(799); });
    expect(api.getAgents).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.getAgents).toHaveBeenCalledTimes(3);
    expect(session.loggedIn).toBe(true);
    expect(api.getCsrfToken).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { status: 401 }, { error: 'unauthorized' }, { error: 'session_expired' },
  ])('logs out immediately for auth failure %j without CSRF fallback', async error => {
    vi.mocked(api.getAgents).mockRejectedValue(error);
    vi.mocked(api.getCsrfToken).mockReturnValue('still-present');
    mount();
    await act(async () => {});
    expect(session.loggedIn).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getAgents).toHaveBeenCalledTimes(1);
    expect(api.getCsrfToken).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, 'csrf-present'])('uses CSRF presence only after exhaustion: %j', async token => {
    vi.mocked(api.getAgents).mockRejectedValue({ status: 503 });
    vi.mocked(api.getCsrfToken).mockReturnValue(token);
    mount();
    await act(async () => {});
    expect(api.getCsrfToken).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(api.getAgents).toHaveBeenCalledTimes(3);
    expect(api.getCsrfToken).toHaveBeenCalledTimes(1);
    expect(session.loggedIn).toBe(!!token);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getAgents).toHaveBeenCalledTimes(3);
  });

  it.each(['success', 'failure'])('suppresses late verification %s after unmount', async outcome => {
    const pending = deferred<api.AgentInfo[]>();
    vi.mocked(api.getAgents).mockReturnValue(pending.promise);
    mount();
    await act(async () => {});
    act(() => { root!.unmount(); root = null; });
    const previousRenders = renders;
    await act(async () => {
      if (outcome === 'success') pending.resolve([]);
      else pending.reject({ status: 503 });
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(api.getCsrfToken).not.toHaveBeenCalled();
    expect(session.loggedIn).toBeNull();
    expect(renders).toBe(previousRenders);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useSession actions and expiry', () => {
  it('clears session on expiry and removes its event listener on unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    mount();
    await act(async () => {});
    expect(session.loggedIn).toBe(true);
    act(() => { window.dispatchEvent(new Event('filebox:session-expired')); });
    expect(session.loggedIn).toBe(false);
    expect(api.setCsrfToken).toHaveBeenCalledExactlyOnceWith(null);
    const subscription = add.mock.calls.find(([name]) => name === 'filebox:session-expired')!;
    act(() => { root!.unmount(); root = null; });
    expect(remove).toHaveBeenCalledWith('filebox:session-expired', subscription[1]);
    window.dispatchEvent(new Event('filebox:session-expired'));
    expect(api.setCsrfToken).toHaveBeenCalledTimes(1);
  });

  it('returns false for rejected credentials, then accepts login and forwards all arguments', async () => {
    vi.mocked(api.getAgents).mockRejectedValue({ status: 401 });
    vi.mocked(api.exchangeSession)
      .mockResolvedValueOnce({ ok: false, permissions: [] })
      .mockResolvedValueOnce({ ok: true, permissions: ['read'] });
    mount();
    await act(async () => {});
    const args = ['alice', 'password', true, 'challenge', 'nonce'] as const;
    await act(async () => { expect(await session.login(...args)).toBe(false); });
    expect(session.loggedIn).toBe(false);
    await act(async () => { expect(await session.login(...args)).toBe(true); });
    expect(session.loggedIn).toBe(true);
    expect(api.exchangeSession).toHaveBeenNthCalledWith(1, ...args);
    expect(api.exchangeSession).toHaveBeenNthCalledWith(2, ...args);
  });

  it('propagates login transport failure without changing the session', async () => {
    const failure = new TypeError('offline');
    vi.mocked(api.exchangeSession).mockRejectedValue(failure);
    mount();
    await act(async () => {});
    await act(async () => {
      await expect(session.login('u', 'p', false, 'id', 'n')).rejects.toBe(failure);
    });
    expect(session.loggedIn).toBe(true);
  });

  it.each([false, true])('clears local session even when logout rejects: %s', async reject => {
    if (reject) vi.mocked(api.logout).mockRejectedValue(new Error('offline'));
    else vi.mocked(api.logout).mockResolvedValue({ ok: true });
    mount();
    await act(async () => {});
    await act(async () => { await session.logout(); });
    expect(session.loggedIn).toBe(false);
    expect(api.logout).toHaveBeenCalledTimes(1);
    if (reject) expect(api.setCsrfToken).toHaveBeenCalledWith(null);
  });
});

describe('forward login return targets', () => {
  const target = '/_fwd/agent/8888/lab?token=demo&path=My%20Notebook.ipynb';
  function next(value: string) { window.history.replaceState(null, '', '/?next=' + encodeURIComponent(value)); }

  it('returns to the original path and query after successful login, not rejected credentials', async () => {
    next(target);
    vi.mocked(api.getAgents).mockRejectedValue({ status: 401 });
    vi.mocked(api.exchangeSession).mockResolvedValueOnce({ ok: false, permissions: [] }).mockResolvedValueOnce({ ok: true, permissions: [] });
    mount();
    await act(async () => {});
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { await session.login('u', 'p', false, 'id', 'nonce'); });
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { await session.login('u', 'p', false, 'id', 'nonce'); });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(target);
  });

  it('returns immediately after verifying an existing login, only once', async () => {
    next(target);
    mount();
    await act(async () => {});
    expect(navigate).toHaveBeenCalledExactlyOnceWith(target);
    vi.mocked(api.exchangeSession).mockResolvedValue({ ok: true, permissions: [] });
    await act(async () => { await session.login('u', 'p', false, 'id', 'nonce'); });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it.each(['', '/', '/api/agents', '//evil.test/_fwd/a/1/', 'https://evil.test/_fwd/a/1/', 'https://localhost/_fwd/a/1/', 'javascript:alert(1)', '\\evil.test', '/_fwd/agent/1/\\evil', '/_fwd/../private', '/_fwd/%2e%2e/private', '/_fwd/a/1/%2f%2fevil', '/_fwd/a/1/%5cevil', '/_fwd/a/1/%252e%252e', '/_fwd/a/1/%0a', '/_fwd/a/1/%zz', '/_fwd/a/1/\n', '%2F_fwd%2Fa%2F1%2F'])('ignores unsafe or non-forward next target %j', async value => {
    next(value);
    mount();
    await act(async () => {});
    expect(navigate).not.toHaveBeenCalled();
    expect(forwardNext(window.location.search, window.location.origin)).toBeNull();
  });

  it('ignores duplicate next parameters and absent next values', () => {
    expect(forwardNext('?next=/_fwd/a/1/&next=/_fwd/b/2/', window.location.origin)).toBeNull();
    expect(forwardNext('', window.location.origin)).toBeNull();
    expect(forwardNext('?next=' + encodeURIComponent('/_fwd/a/1/My%20File?url=https%3A%2F%2Fexample.test#cell'), window.location.origin)).toBe('/_fwd/a/1/My%20File?url=https%3A%2F%2Fexample.test#cell');
  });
});
