import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCopyToClipboard } from './useCopyToClipboard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useCopyToClipboard', () => {
  let host: HTMLDivElement;
  let root: Root;
  let mounted: boolean;
  let current: ReturnType<typeof useCopyToClipboard>;
  let writeText: ReturnType<typeof vi.fn>;
  let execCommand: ReturnType<typeof vi.fn>;
  let originalExec: PropertyDescriptor | undefined;

  function Harness() {
    current = useCopyToClipboard();
    return <span>{current.copiedPath}</span>;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    writeText = vi.fn().mockResolvedValue(undefined);
    execCommand = vi.fn().mockReturnValue(false);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    originalExec = Object.getOwnPropertyDescriptor(document, 'execCommand');
    Object.defineProperty(document, 'execCommand', {
      configurable: true, value: execCommand,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mounted = true;
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    if (mounted) act(() => root.unmount());
    host.remove();
    if (originalExec) Object.defineProperty(document, 'execCommand', originalExec);
    else Reflect.deleteProperty(document, 'execCommand');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function copy(text = '/目录/file', label = 'file') {
    let result: boolean | undefined;
    await act(async () => {
      result = await current.copyToClipboard(text, label);
    });
    return result;
  }

  it('writes the exact text and shows its label only for two seconds', async () => {
    expect(current.copiedPath).toBeNull();
    expect(await copy()).toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith('/目录/file');
    expect(execCommand).not.toHaveBeenCalled();
    expect(host.textContent).toBe('file');
    act(() => vi.advanceTimersByTime(1999));
    expect(current.copiedPath).toBe('file');
    act(() => vi.advanceTimersByTime(1));
    expect(current.copiedPath).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('repeated copy replaces the label and restarts its expiry timer', async () => {
    await copy('first', 'first');
    act(() => vi.advanceTimersByTime(1500));
    await copy('second', 'second');
    act(() => vi.advanceTimersByTime(500));
    expect(current.copiedPath).toBe('second');
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(1500));
    expect(current.copiedPath).toBeNull();
  });

  it('clears its active expiry timer on unmount', async () => {
    await copy();
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.unmount());
    mounted = false;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['rejected', 'unavailable'])(
    'falls back to selected textarea when clipboard is %s',
    async reason => {
      if (reason === 'rejected') writeText.mockRejectedValue(new Error('denied'));
      else vi.stubGlobal('navigator', {});
      execCommand.mockImplementation((command: string) => {
        const textarea = document.activeElement as HTMLTextAreaElement;
        expect(command).toBe('copy');
        expect(textarea.tagName).toBe('TEXTAREA');
        expect(textarea.value).toBe('/目录/file');
        expect(textarea.readOnly).toBe(true);
        expect(textarea.selectionStart).toBe(0);
        expect(textarea.selectionEnd).toBe('/目录/file'.length);
        return true;
      });
      expect(await copy()).toBe(true);
      expect(current.copiedPath).toBe('file');
      expect(document.querySelector('textarea')).toBeNull();
      expect(execCommand).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['false', 'throws'])(
    'does not claim success when fallback %s',
    async failure => {
      writeText.mockRejectedValue(new Error('denied'));
      execCommand.mockImplementation(() => {
        if (failure === 'throws') throw new Error('blocked');
        return false;
      });
      expect(await copy()).toBe(false);
      expect(current.copiedPath).toBeNull();
      expect(document.querySelector('textarea')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('falls back after a stalled clipboard write without later reporting success twice', async () => {
    let finish!: () => void;
    writeText.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    execCommand.mockReturnValue(true);
    let pending!: Promise<boolean>;
    act(() => { pending = current.copyToClipboard('text', 'label'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(799); });
    expect(execCommand).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await expect(pending).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1000));
    await act(async () => { finish(); await Promise.resolve(); });
    act(() => vi.advanceTimersByTime(1000));
    expect(current.copiedPath).toBeNull();
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(document.querySelector('textarea')).toBeNull();
  });
});
