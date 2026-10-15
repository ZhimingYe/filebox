import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { useHerdrAttention } from './useHerdrAttention';
import { useHerdrEnabled, setHerdrEnabled } from './useHerdrEnabled';

vi.mock('../api/client', async (original) => ({ ...await original<typeof api>(), herdrCommand: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, clear: () => values.clear() });
  setHerdrEnabled(true);
});

it('disables monitoring in memory when storage is full, then follows a persisted change', async () => {
  vi.useFakeTimers();
  let value = '1';
  const setItem = vi.fn<() => void>(() => { throw new DOMException('full', 'QuotaExceededError'); });
  vi.stubGlobal('localStorage', { getItem: () => value, setItem, clear: () => {} });
  const container = document.createElement('div');
  const root = createRoot(container);
  let signal: AbortSignal | undefined;
  vi.mocked(api.herdrCommand).mockImplementation((_id, _body, s) => {
    signal = s;
    return new Promise((_resolve, reject) => s!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  });
  function Probe() {
    const enabled = useHerdrEnabled();
    useHerdrAttention([{ id: 'b', status: 'online', capabilities: { herdr: true } } as api.AgentInfo], enabled, null);
    return <button onClick={() => setHerdrEnabled(!enabled)}>{String(enabled)}</button>;
  }
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toBe('false');
    expect(signal?.aborted).toBe(true);
    expect(value).toBe('1');
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(api.herdrCommand).toHaveBeenCalledTimes(1);
    // A new subscriber must also see the in-memory override.
    await act(async () => root.render(<Probe key="remounted" />));
    expect(container.textContent).toBe('false');
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: 'filebox.herdrEnabled' })));
    expect(container.textContent).toBe('true');
    expect(api.herdrCommand).toHaveBeenCalledTimes(2);
    // A later successful local write also returns to persisted preferences.
    setItem.mockImplementation(() => { value = '0'; });
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toBe('false');
    expect(value).toBe('0');
  } finally { act(() => root.unmount()); }
});
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetAllMocks(); });
it('persists disabling, aborts monitoring, and follows changes in other browser windows', async () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  const root = createRoot(container);
  let signal: AbortSignal | undefined;
  vi.mocked(api.herdrCommand).mockImplementation((_id, _body, s) => {
    signal = s;
    return new Promise((_resolve, reject) => s!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  });
  function Probe() {
    const enabled = useHerdrEnabled();
    useHerdrAttention([{ id: 'b', status: 'online', capabilities: { herdr: true } } as api.AgentInfo], enabled, null);
    return <button onClick={() => setHerdrEnabled(!enabled)}>{String(enabled)}</button>;
  }
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => container.querySelector('button')!.click());
    expect(signal?.aborted).toBe(true);
    expect(localStorage.getItem('filebox.herdrEnabled')).toBe('0');
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(api.herdrCommand).toHaveBeenCalledTimes(1);
    await act(async () => {
      localStorage.setItem('filebox.herdrEnabled', '1');
      window.dispatchEvent(new StorageEvent('storage', { key: 'filebox.herdrEnabled' }));
    });
    expect(container.textContent).toBe('true');
    expect(api.herdrCommand).toHaveBeenCalledTimes(2);
  } finally { act(() => root.unmount()); }
});
