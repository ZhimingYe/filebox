import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLoginAudit, friendlyMessage, type LoginAuditEntry } from '../api/client';
import { LoginAudit } from './LoginAudit';

vi.mock('../api/client', () => ({ getLoginAudit: vi.fn(), friendlyMessage: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
type Page = Awaited<ReturnType<typeof getLoginAudit>>;
const entry = (id: number): LoginAuditEntry => ({
  id, at_ms: 0, event: 'login_success', username: 'user-' + id, ip: '127.0.0.1', user_agent: 'test',
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find(el => el.textContent === text)!;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount() { act(() => { root.render(<LoginAudit />); }); }
async function initial() {
  vi.mocked(getLoginAudit).mockResolvedValueOnce({ entries: [entry(10), entry(7)], has_more: true });
  mount();
  await act(async () => {});
}
const refresh = () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh audit records"]')!;

beforeEach(() => {
  vi.resetAllMocks();
  host = document.createElement('div');
  root = createRoot(host);
  vi.mocked(getLoginAudit).mockResolvedValue({ entries: [], has_more: false });
  vi.mocked(friendlyMessage).mockImplementation(error => (error as Error).message);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('LoginAudit', () => {
  it('loads initially and shows an empty state when there are no records', async () => {
    const page = deferred<Page>();
    vi.mocked(getLoginAudit).mockReturnValueOnce(page.promise);
    mount();
    expect(refresh().disabled).toBe(true);
    expect(getLoginAudit).toHaveBeenCalledWith({ limit: 50 }, expect.any(AbortSignal));
    await act(async () => { page.resolve({ entries: [], has_more: false }); });
    expect(host.textContent).toContain('No login records yet.');
    expect(button('Load older')).toBeUndefined();
    expect(refresh().disabled).toBe(false);
  });

  it('uses the oldest id as cursor and stops paging after an empty terminal page', async () => {
    await initial();
    vi.mocked(getLoginAudit).mockResolvedValueOnce({ entries: [entry(3)], has_more: true });
    await act(async () => { button('Load older').click(); });
    expect(getLoginAudit).toHaveBeenLastCalledWith({ limit: 50, before: 7 });
    expect(host.textContent).toContain('user-3');
    await act(async () => { button('Load older').click(); });
    expect(getLoginAudit).toHaveBeenLastCalledWith({ limit: 50, before: 3 });
    expect(button('Load older')).toBeUndefined();
    expect(host.textContent).toContain('3 records');
  });

  it.each(['success', 'failure'])('refresh supersedes an older page %s and clears its loading flag', async outcome => {
    await initial();
    const older = deferred<Page>();
    vi.mocked(getLoginAudit).mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce({ entries: [entry(20)], has_more: true });
    act(() => { button('Load older').click(); });
    expect(button('Loading…').disabled).toBe(true);
    await act(async () => { refresh().click(); });
    expect(host.textContent).toContain('user-20');
    await act(async () => {
      if (outcome === 'success') older.resolve({ entries: [entry(1)], has_more: false });
      else older.reject(new Error('stale error'));
    });
    expect(host.textContent).not.toContain('user-1');
    expect(host.textContent).not.toContain('stale error');
    expect(button('Load older').disabled).toBe(false);
    expect(host.textContent).toContain('user-20');
  });

  it('shows an initial error and recovers through Retry', async () => {
    vi.mocked(getLoginAudit).mockRejectedValueOnce(new Error('initial unavailable'));
    mount();
    await act(async () => {});
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('initial unavailable');
    await act(async () => { button('Retry').click(); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('No login records yet.');
  });

  it('keeps records on older-page failure and clears that error on retry', async () => {
    await initial();
    vi.mocked(getLoginAudit).mockRejectedValueOnce(new Error('older unavailable'))
      .mockResolvedValueOnce({ entries: [entry(2)], has_more: false });
    await act(async () => { button('Load older').click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('older unavailable');
    expect(host.textContent).toContain('user-10');
    expect(button('Load older').disabled).toBe(false);
    await act(async () => { button('Load older').click(); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('user-2');
  });

  it('shows a refresh error independently while keeping loaded records', async () => {
    await initial();
    vi.mocked(getLoginAudit).mockRejectedValueOnce(new Error('refresh unavailable'));
    await act(async () => { refresh().click(); });
    expect(host.textContent).toContain('user-10');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('refresh unavailable');
    expect(refresh().disabled).toBe(false);
  });
});
