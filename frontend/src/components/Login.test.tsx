import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPowChallenge, type PowChallenge } from '../api/client';
import { solvePow } from '../lib/pow';
import { Login } from './Login';

vi.mock('../api/client', () => ({ getPowChallenge: vi.fn() }));
vi.mock('../lib/pow', () => ({ solvePow: vi.fn() }));
vi.mock('../state/useIsMobile', () => ({ useIsMobile: () => false }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | null;
let login: ReturnType<typeof vi.fn>;
const challenge: PowChallenge = { id: 'first', salt: 'salt', difficulty: 4, expires_in_secs: 60 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function button(text: string) {
  return [...host.querySelectorAll('button')].find(b => b.textContent === text)!;
}
function fill(label: string, text: string) {
  const id = [...host.querySelectorAll('label')].find(el => el.textContent === label)!.htmlFor;
  const input = host.querySelector<HTMLInputElement>('#' + id)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function submit() {
  host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
async function ready() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  fill('Username', 'alice');
  fill('Password', 'secret');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01'));
  vi.resetAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  login = vi.fn().mockResolvedValue(true);
  vi.mocked(getPowChallenge).mockResolvedValue(challenge);
  vi.mocked(solvePow).mockResolvedValue('nonce');
  act(() => { root!.render(<Login onLogin={login} />); });
});
afterEach(() => {
  act(() => { root?.unmount(); });
  host.remove();
  vi.useRealTimers();
});

describe('Login verification', () => {
  it('moves from loading to solving to ready, capping progress until completion', async () => {
    const fetching = deferred<PowChallenge>();
    const solving = deferred<string>();
    vi.mocked(getPowChallenge).mockReturnValueOnce(fetching.promise);
    vi.mocked(solvePow).mockReturnValueOnce(solving.promise);
    expect(button('Continue').disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(solvePow).not.toHaveBeenCalled();
    await act(async () => { fetching.resolve(challenge); });
    expect(host.textContent).toContain('Solving… 0%');
    const options = vi.mocked(solvePow).mock.calls[0][1]!;
    act(() => { options.onProgress?.(1000000); });
    expect(host.textContent).toContain('Solving… 99%');
    expect(host.textContent).not.toContain('100%');
    await act(async () => { solving.resolve('solved'); });
    expect(host.textContent).toContain('Ready');
    fill('Username', 'alice');
    fill('Password', 'secret');
    expect(button('Continue').disabled).toBe(false);
  });

  it('shows challenge rate-limit feedback and can retry discovery', async () => {
    vi.mocked(getPowChallenge).mockRejectedValueOnce({
      error: 'pow_rate_limited', message: 'Wait before verifying',
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(host.textContent).toContain('Wait before verifying');
    expect(button('Continue').disabled).toBe(true);
    await act(async () => { button('Retry').click(); });
    expect(host.textContent).toContain('Ready');
    expect(getPowChallenge).toHaveBeenCalledTimes(2);
  });

  it('shows a solver failure and recovers using a new verification run', async () => {
    vi.mocked(solvePow).mockRejectedValueOnce(new Error('solver unavailable'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(host.textContent).toContain('Could not complete verification.');
    await act(async () => { button('Retry').click(); });
    expect(getPowChallenge).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Ready');
  });

  it('ignores an older challenge response after two rapid reruns', async () => {
    await ready();
    const old = deferred<PowChallenge>();
    const current = deferred<PowChallenge>();
    vi.mocked(getPowChallenge).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const refresh = host.querySelector<HTMLButtonElement>('[aria-label="Re-run verification"]')!;
    act(() => { refresh.click(); refresh.click(); });
    expect(getPowChallenge).toHaveBeenCalledTimes(3);
    await act(async () => { current.resolve({ ...challenge, id: 'current' }); });
    await act(async () => { old.resolve({ ...challenge, id: 'stale' }); });
    expect(solvePow).toHaveBeenCalledTimes(2);
    await act(async () => { submit(); });
    expect(login).toHaveBeenCalledWith('alice', 'secret', false, 'current', 'nonce');
  });

  it('aborts solving on unmount and ignores late progress/completion', async () => {
    const pending = deferred<string>();
    vi.mocked(solvePow).mockReturnValueOnce(pending.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const options = vi.mocked(solvePow).mock.calls[0][1]!;
    act(() => { root!.unmount(); root = null; });
    expect(options.signal!.aborted).toBe(true);
    await act(async () => { options.onProgress?.(1000000); pending.resolve('late'); });
    expect(host.textContent).toBe('');
    expect(login).not.toHaveBeenCalled();
  });
});

describe('Login submission', () => {
  it('locks submission synchronously while login is pending', async () => {
    const pending = deferred<boolean>();
    login.mockReturnValueOnce(pending.promise);
    await ready();
    act(() => { submit(); submit(); });
    expect(login).toHaveBeenCalledTimes(1);
    expect(button('Signing in…').disabled).toBe(true);
    await act(async () => { pending.resolve(true); });
    expect(button('Continue').disabled).toBe(false);
  });

  it('fetches a fresh single-use challenge after login returns false', async () => {
    login.mockResolvedValueOnce(false);
    await ready();
    await act(async () => { submit(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Invalid username or password');
    expect(getPowChallenge).toHaveBeenCalledTimes(2);
    expect(solvePow).toHaveBeenCalledTimes(2);
    expect(button('Continue').disabled).toBe(false);
  });

  it.each([
    ['invalid_credentials', undefined, 'Invalid username or password', 2],
    ['pow_failed', 'Proof expired', 'Proof expired', 2],
    ['login_rate_limited', 'Please wait', 'Please wait', 1],
    ['network_error', undefined, 'Authentication failed. Check the hub is reachable.', 2],
  ])('shows %s feedback and refreshes only consumed challenges', async (error, message, copy, calls) => {
    login.mockRejectedValueOnce({ error, message });
    await ready();
    await act(async () => { submit(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy);
    expect(getPowChallenge).toHaveBeenCalledTimes(calls);
    expect(button('Continue').disabled).toBe(false);
  });
});
