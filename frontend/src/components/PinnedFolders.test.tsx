import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fsStat, type AgentInfo } from '../api/client';
import { PinnedFolders } from './PinnedFolders';

vi.mock('../api/client', () => ({ fsStat: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let agent: AgentInfo;
let unpin: ReturnType<typeof vi.fn>;
let navigate: ReturnType<typeof vi.fn>;
const existing = (path = '/reports') => ({
  stat: { path, entry_type: 'directory' as const, size: 0, modified: null, denied: false },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function render(next = agent) {
  act(() => {
    root.render(<PinnedFolders agent={next} collapsed={false} onNavigate={navigate} onUnpin={unpin} />);
  });
}
const pinButton = (text = 'reports') =>
  [...host.querySelectorAll('button')].find(button => button.textContent === text)!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01'));
  vi.resetAllMocks();
  host = document.createElement('div');
  root = createRoot(host);
  agent = {
    id: 'a', status: 'online',
    roots: [{ name: 'r', path_display: '/srv', enabled: true, pinned_folders: ['/reports'] }],
  } as AgentInfo;
  unpin = vi.fn().mockResolvedValue(true);
  navigate = vi.fn();
  vi.mocked(fsStat).mockResolvedValue(existing());
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('PinnedFolders', () => {
  it('hides disabled groups without deleting their pins and restores them when enabled', async () => {
    render({ ...agent, roots: agent.roots.map(r => ({ ...r, enabled: false })) });
    expect(host.textContent).not.toContain('reports');
    expect(fsStat).not.toHaveBeenCalled();
    render();
    await act(async () => {});
    expect(pinButton()).toBeDefined();
    expect(agent.roots[0].pinned_folders).toEqual(['/reports']);
    expect(unpin).not.toHaveBeenCalled();
    act(() => { pinButton().click(); });
    expect(navigate).toHaveBeenCalledWith('r', '/reports');
  });

  it('bounds outstanding probes to four, even for a large pin list', async () => {
    const pending: ReturnType<typeof deferred<Awaited<ReturnType<typeof fsStat>>>>[] = [];
    vi.mocked(fsStat).mockImplementation(() => {
      const probe = deferred<Awaited<ReturnType<typeof fsStat>>>();
      pending.push(probe);
      return probe.promise;
    });
    const pins = Array.from({ length: 9 }, (_, i) => '/pin-' + i);
    render({ ...agent, roots: [{ ...agent.roots[0], pinned_folders: pins }] });
    expect(fsStat).toHaveBeenCalledTimes(4);
    await act(async () => { pending[0].resolve(existing()); });
    expect(fsStat).toHaveBeenCalledTimes(4);
    await act(async () => { pending.slice(1, 4).forEach(p => p.resolve(existing())); });
    expect(fsStat).toHaveBeenCalledTimes(8);
    await act(async () => { pending.slice(4, 8).forEach(p => p.resolve(existing())); });
    expect(fsStat).toHaveBeenCalledTimes(9);
    await act(async () => { pending[8].resolve(existing()); });
  });

  it('does not probe offline agents but keeps their pins navigable', async () => {
    render({ ...agent, status: 'offline' });
    await act(async () => {});
    expect(fsStat).not.toHaveBeenCalled();
    act(() => { pinButton().click(); });
    expect(navigate).toHaveBeenCalledWith('r', '/reports');
    expect(pinButton().title).not.toContain('not found');
  });

  it('caches a positive result only until its TTL expires', async () => {
    render();
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(59999); });
    render({ ...agent, roots: [...agent.roots] });
    await act(async () => {});
    expect(fsStat).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    vi.mocked(fsStat).mockResolvedValueOnce({ stat: null });
    render({ ...agent, roots: [...agent.roots] });
    await act(async () => {});
    expect(fsStat).toHaveBeenCalledTimes(2);
    expect(pinButton().title).toContain('Folder not found');
  });

  it.each(['missing', 'file'])('does not cache a negative %s result', async kind => {
    vi.mocked(fsStat).mockResolvedValueOnce(kind === 'missing'
      ? { stat: null } : { stat: { ...existing().stat, entry_type: 'file' } });
    render();
    await act(async () => {});
    expect(pinButton().title).toContain('Folder not found');
    render({ ...agent, roots: [...agent.roots] });
    await act(async () => {});
    expect(fsStat).toHaveBeenCalledTimes(2);
    expect(pinButton().title).not.toContain('not found');
  });

  it.each(['network', 'permission', 'denied-stat'])('treats %s failure as unknown, not missing', async kind => {
    if (kind === 'denied-stat') {
      vi.mocked(fsStat).mockResolvedValueOnce({
        stat: { ...existing().stat, entry_type: 'file', denied: true },
      });
    } else vi.mocked(fsStat).mockRejectedValueOnce(
      kind === 'permission' ? { status: 403, error: 'path_denied' } : new TypeError('offline'),
    );
    render();
    await act(async () => {});
    expect(pinButton().title).not.toContain('not found');
    act(() => { pinButton().click(); });
    expect(navigate).toHaveBeenCalledWith('r', '/reports');
  });

  it.each([true, false])('forwards unpin and shows transient feedback for success=%s', async success => {
    unpin.mockResolvedValueOnce(success);
    render();
    await act(async () => {});
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Unpin r reports"]')!.click();
    });
    expect(unpin).toHaveBeenCalledExactlyOnceWith('r', '/reports');
    expect(host.textContent?.includes("Couldn't unpin")).toBe(!success);
    if (!success) {
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(host.textContent).not.toContain("Couldn't unpin");
    }
  });
});
