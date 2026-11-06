import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '../api/client';
import * as api from '../api/client';
import { CollectionPicker } from './CollectionPicker';

vi.mock('../api/client', () => ({
  patchCollection: vi.fn(), createCollection: vi.fn(),
  friendlyMessage: vi.fn((error: { message?: string; error?: string }) => error.message || error.error),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('CollectionPicker', () => {
  let host: HTMLDivElement;
  let anchor: HTMLButtonElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    anchor = document.createElement('button');
    document.body.append(host, anchor);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    anchor.remove();
  });

  it('stays open when its own list scrolls after the hover-only trigger unmounts', () => {
    const onClose = vi.fn();
    const agent = { id: 'a1', collections: [] } as unknown as AgentInfo;
    act(() => {
      root.render(
        <CollectionPicker
          agent={agent}
          target={{ root: 'r', path: '/f.txt' }}
          anchorEl={anchor}
          onClose={onClose}
          onChanged={() => {}}
        />,
      );
    });
    const panel = host.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();

    anchor.remove();
    act(() => {
      (panel!.lastElementChild ?? panel!).dispatchEvent(new Event('scroll'));
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(new Event('scroll'));
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('CollectionPicker mutations and dismissal', () => {
  let host: HTMLDivElement;
  let anchor: HTMLButtonElement;
  let root: Root;
  let agent: AgentInfo;
  let close: ReturnType<typeof vi.fn>;
  let changed: ReturnType<typeof vi.fn>;
  const target = { root: 'r', path: '/f.txt' };
  const applied = { ok: true, state: 'applied' } as Awaited<ReturnType<typeof api.patchCollection>>;

  function render() {
    act(() => {
      root.render(<CollectionPicker agent={agent} target={target} anchorEl={anchor}
        onClose={close} onChanged={changed} />);
    });
  }
  const button = (prefix: string) =>
    [...host.querySelectorAll('button')].find(el => el.textContent?.startsWith(prefix))!;
  function type(text: string) {
    const input = host.querySelector<HTMLInputElement>('input[placeholder="Collection name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.patchCollection).mockReset().mockResolvedValue(applied);
    vi.mocked(api.createCollection).mockReset().mockResolvedValue(applied);
    host = document.createElement('div');
    anchor = document.createElement('button');
    document.body.append(host, anchor);
    root = createRoot(host);
    agent = { id: 'a', collections: [{ name: 'Work', items: [] }] } as unknown as AgentInfo;
    close = vi.fn();
    changed = vi.fn();
    render();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    anchor.remove();
  });

  it('adds an item, refreshes parent state, and disables an already-added collection', async () => {
    await act(async () => { button('Work').click(); });
    expect(api.patchCollection).toHaveBeenCalledExactlyOnceWith('a', 'Work', { item_add: target });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    agent = { ...agent, collections: [{ name: 'Work', items: [target] }] };
    render();
    expect(button('Work (added)').disabled).toBe(true);
    act(() => { button('Work (added)').click(); });
    expect(api.patchCollection).toHaveBeenCalledTimes(1);
  });

  it('locks mutations while pending, then accepts a pending-agent acknowledgement', async () => {
    let finish!: (value: typeof applied) => void;
    vi.mocked(api.patchCollection).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    act(() => { button('Work').click(); });
    expect(button('Adding…').disabled).toBe(true);
    expect(button('New collection…').disabled).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    await act(async () => { finish({ ...applied, state: 'pending_agent_reconnect' }); });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(button('Work').disabled).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it('shows a rejected add and unlocks the control for retry', async () => {
    vi.mocked(api.patchCollection).mockRejectedValueOnce({ message: 'Agent rejected collection' });
    await act(async () => { button('Work').click(); });
    expect(host.textContent).toContain('Agent rejected collection');
    expect(changed).not.toHaveBeenCalled();
    expect(button('Work').disabled).toBe(false);
    await act(async () => { button('Work').click(); });
    expect(host.textContent).not.toContain('Agent rejected collection');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('creates with a trimmed name and initial item in one request', async () => {
    act(() => { button('New collection…').click(); });
    type('  Reports  ');
    await act(async () => { button('Add').click(); });
    expect(api.createCollection).toHaveBeenCalledExactlyOnceWith('a', 'Reports', target);
    expect(api.patchCollection).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(host.querySelector('input[placeholder="Collection name"]')).toBeNull();
  });

  it('rejects blank names locally and surfaces duplicate-name rejection from the API', async () => {
    act(() => { button('New collection…').click(); });
    type('   ');
    expect(button('Add').disabled).toBe(true);
    act(() => { button('Add').click(); });
    expect(api.createCollection).not.toHaveBeenCalled();
    vi.mocked(api.createCollection).mockRejectedValueOnce({ message: 'Collection already exists' });
    type('Work');
    await act(async () => { button('Add').click(); });
    expect(host.textContent).toContain('Collection already exists');
    expect(button('Add').disabled).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it('Escape cancels name entry first, then closes the picker', () => {
    act(() => { button('New collection…').click(); });
    type('draft');
    act(() => {
      host.querySelector('input')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(host.querySelector('input')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('ignores inside and anchor clicks but closes on an outside pointerdown', () => {
    act(() => {
      host.querySelector('[role="dialog"]')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      anchor.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(close).not.toHaveBeenCalled();
    act(() => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
