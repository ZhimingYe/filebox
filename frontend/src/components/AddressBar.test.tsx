import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fsList, type FsEntry } from '../api/client';
import { AddressBar } from './AddressBar';

vi.mock('../api/client', () => ({ fsList: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let navigate: ReturnType<typeof vi.fn>;
const roots = [{ name: 'r', path_display: '/srv', enabled: true }];
const entry = (name: string, entry_type: FsEntry['entry_type'] = 'directory', denied = false): FsEntry => ({
  name, entry_type, denied, size: null, modified: null,
});
const input = () => host.querySelector<HTMLInputElement>('input[placeholder="/path/to/directory"]')!;
function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(name: string) {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
}
function mount(entries: FsEntry[] = []) {
  act(() => {
    root.render(<AddressBar selectedRoot="r" currentPath="/" roots={roots}
      entries={entries} agentId="a" onNavigate={navigate} />);
  });
  act(() => { host.querySelector<HTMLElement>('[role="button"]')!.click(); });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  navigate = vi.fn();
  vi.mocked(fsList).mockResolvedValue({ items: [], next_cursor: null });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('AddressBar', () => {
  it('offers only readable directories, filtering names case-insensitively', () => {
    mount([entry('Docs'), entry('deny', 'directory', true), entry('data.txt', 'file'), entry('Other')]);
    type('/d');
    expect(host.textContent).toContain('Docs');
    expect(host.textContent).not.toContain('deny');
    expect(host.textContent).not.toContain('data.txt');
    expect(host.textContent).not.toContain('Other');
    expect(fsList).not.toHaveBeenCalled();
  });

  it('Tab completes the selected folder without navigating', async () => {
    mount([entry('Docs'), entry('Downloads')]);
    type('/do');
    await key('ArrowDown');
    await key('Tab');
    expect(input().value).toBe('/Downloads/');
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ['foo//bar///', '/foo/bar'],
    ['///foo//bar/', '/foo/bar'],
    ['/', '/'],
  ])('Enter normalizes %j to %j', async (typed, path) => {
    mount();
    type(typed);
    await act(async () => {});
    await key('Enter');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('r', path);
    expect(input()).toBeNull();
  });

  it('Enter navigates into the selected suggestion', async () => {
    mount([entry('Docs')]);
    type('/do');
    await key('Enter');
    expect(navigate).toHaveBeenCalledWith('r', '/Docs');
  });

  it('Escape cancels without navigation and restores the original path next time', async () => {
    mount();
    type('/unfinished');
    await key('Escape');
    expect(input()).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    act(() => { host.querySelector<HTMLElement>('[role="button"]')!.click(); });
    expect(input().value).toBe('/');
  });

  it('ignores stale remote suggestions after typing a newer parent', async () => {
    const old = deferred<Awaited<ReturnType<typeof fsList>>>();
    vi.mocked(fsList).mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ items: [entry('New')], next_cursor: null });
    mount();
    type('/old/');
    type('/new/');
    await act(async () => {});
    expect(host.textContent).toContain('New');
    await act(async () => { old.resolve({ items: [entry('Stale')], next_cursor: null }); });
    expect(host.textContent).not.toContain('Stale');
    expect(host.textContent).toContain('New');
    await key('Tab');
    expect(input().value).toBe('/new/New/');
  });

  it('keeps a manually typed path usable after suggestion lookup fails', async () => {
    vi.mocked(fsList).mockRejectedValue(new Error('offline'));
    mount();
    type('/unavailable/child');
    await act(async () => {});
    await key('Enter');
    expect(navigate).toHaveBeenCalledWith('r', '/unavailable/child');
  });
});
