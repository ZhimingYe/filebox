import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { TempTransferView } from './TempTransferView';

vi.mock('../api/client', () => ({
  fsList: vi.fn(), uploadTempFile: vi.fn(), cleanupTempFolder: vi.fn(),
  friendlyMessage: vi.fn((error: { error?: string }) => error.error || 'Transfer failed'),
}));
vi.mock('../state/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({ copiedPath: null, copyToClipboard: vi.fn() }),
}));
vi.mock('./FileDownloadLink', () => ({ FileDownloadLink: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let agent: api.AgentInfo;
let handled: ReturnType<typeof vi.fn>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function render(files?: File[]) {
  act(() => {
    root.render(<TempTransferView agent={agent}
      uploadRequest={files ? { files, nonce: 1 } : undefined} onUploadsHandled={handled} />);
  });
}
const clean = () => host.querySelector<HTMLButtonElement>('[aria-label="Clean the temp folder"]')!;
const uploadText = () => host.querySelector('[role="status"]')?.textContent;
const file = (name: string, size = 3) => new File(['x'.repeat(size)], name);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01'));
  vi.clearAllMocks();
  vi.mocked(api.fsList).mockReset().mockResolvedValue({ items: [], next_cursor: null });
  vi.mocked(api.uploadTempFile).mockReset().mockResolvedValue({ ok: true, name: 'uploaded', size: 3 });
  vi.mocked(api.cleanupTempFolder).mockReset().mockResolvedValue({ ok: true, removed: 2, freed_bytes: 10 });
  host = document.createElement('div');
  root = createRoot(host);
  agent = { id: 'a', temp_root_name: 'temp', temp_max_file_bytes: 5 } as api.AgentInfo;
  handled = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('TempTransferView queue', () => {
  it('starts the next upload without waiting for the completed upload folder refresh', async () => {
    const first = deferred<api.TempUploadResult>();
    const second = deferred<api.TempUploadResult>();
    const refresh = deferred<Awaited<ReturnType<typeof api.fsList>>>();
    vi.mocked(api.uploadTempFile).mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.mocked(api.fsList).mockResolvedValueOnce({ items: [], next_cursor: null })
      .mockReturnValueOnce(refresh.promise);
    const files = [file('first'), file('second')];
    render(files);
    await act(async () => {});
    expect(api.uploadTempFile).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve({ ok: true, name: 'first', size: 3 }); });
    expect(api.fsList).toHaveBeenCalledTimes(2);
    expect(api.uploadTempFile).toHaveBeenNthCalledWith(2, 'a', files[1], expect.any(Function));
    expect(uploadText()).toBe('firstUploadedsecond0%');
    await act(async () => { second.resolve({ ok: true, name: 'second', size: 3 }); });
    expect(uploadText()).toBe('firstUploadedsecondUploaded');
    await act(async () => { refresh.resolve({ items: [], next_cursor: null }); });
    expect(uploadText()).toBe('firstUploadedsecondUploaded');
  });

  it.each([3, 6])('binds a %i-byte queued upload to its agent across a switch', async size => {
    const first = deferred<api.TempUploadResult>();
    const second = deferred<api.TempUploadResult>();
    const oldList = deferred<Awaited<ReturnType<typeof api.fsList>>>();
    vi.mocked(api.uploadTempFile).mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.mocked(api.fsList).mockReturnValueOnce(oldList.promise);
    const firstFile = file('agent-a');
    const secondFile = file('agent-b', size);
    render([firstFile]);
    const other = { ...agent, id: 'b', temp_root_name: 'other-temp', temp_max_file_bytes: 10 };
    await act(async () => {
      root.render(<TempTransferView agent={other}
        uploadRequest={{ files: [secondFile], nonce: 2 }} />);
    });
    expect(api.uploadTempFile).toHaveBeenCalledExactlyOnceWith('a', firstFile, expect.any(Function));
    expect(api.fsList).toHaveBeenLastCalledWith('b', 'other-temp', '/', 1000, undefined, false);
    await act(async () => { first.resolve({ ok: true, name: 'agent-a', size: 3 }); });
    expect(api.uploadTempFile).toHaveBeenNthCalledWith(2, 'b', secondFile, expect.any(Function));
    expect(uploadText()).toBe('agent-b0%');
    act(() => { vi.mocked(api.uploadTempFile).mock.calls[0][2]!(1, 1); });
    expect(uploadText()).toBe('agent-b0%');
    await act(async () => { second.resolve({ ok: true, name: 'agent-b', size }); });
    expect(uploadText()).toBe('agent-bUploaded');
    expect(vi.mocked(api.fsList).mock.calls.map(call => [call[0], call[1]]))
      .toEqual([['a', 'temp'], ['b', 'other-temp'], ['b', 'other-temp']]);
    await act(async () => {
      oldList.resolve({ items: [{
        name: 'stale-agent-a', entry_type: 'file', size: 3,
      } as api.FsEntry], next_cursor: 'stale' });
    });
    expect(host.textContent).not.toContain('stale-agent-a');
    expect(uploadText()).toBe('agent-bUploaded');
  });

  it('queues new nonce batches behind every previously arrived file', async () => {
    const first = deferred<api.TempUploadResult>();
    const second = deferred<api.TempUploadResult>();
    const third = deferred<api.TempUploadResult>();
    vi.mocked(api.uploadTempFile).mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    const files = [file('first'), file('second'), file('third'), file('fourth')];
    render(files.slice(0, 2));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    act(() => {
      root.render(<TempTransferView agent={agent}
        uploadRequest={{ files: files.slice(2), nonce: 2 }} />);
    });
    expect(api.uploadTempFile).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve({ ok: true, name: 'first', size: 3 }); });
    expect(api.uploadTempFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.uploadTempFile).mock.calls[1][1]).toBe(files[1]);
    await act(async () => { second.resolve({ ok: true, name: 'second', size: 3 }); });
    expect(api.uploadTempFile).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.uploadTempFile).mock.calls[2][1]).toBe(files[2]);
    await act(async () => { third.resolve({ ok: true, name: 'third', size: 3 }); });
    expect(vi.mocked(api.uploadTempFile).mock.calls.map(call => call[1])).toEqual(files);
    expect(uploadText()).toBe('firstUploadedsecondUploadedthirdUploadedfourthUploaded');
  });
  it('uploads sequentially and caps progress below completion until the upload resolves', async () => {
    const first = deferred<api.TempUploadResult>();
    vi.mocked(api.uploadTempFile).mockReturnValueOnce(first.promise);
    const files = [file('first'), file('second')];
    render(files);
    await act(async () => {});
    expect(api.uploadTempFile).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledTimes(1);
    const progress = vi.mocked(api.uploadTempFile).mock.calls[0][2]!;
    act(() => { progress(100, 100); });
    expect(uploadText()).toContain('99%');
    expect(uploadText()).not.toContain('100%');
    expect(uploadText()).not.toContain('Uploaded');
    await act(async () => { first.resolve({ ok: true, name: 'first', size: 3 }); });
    expect(api.uploadTempFile).toHaveBeenNthCalledWith(2, 'a', files[1], expect.any(Function));
    expect(uploadText()).toBe('firstUploadedsecondUploaded');
    expect(api.fsList).toHaveBeenCalledTimes(3);
  });

  it('rejects oversized files locally but continues with a file at the cap', async () => {
    const oversized = file('large', 6);
    const accepted = file('at-cap', 5);
    render([oversized, accepted]);
    await act(async () => {});
    expect(api.uploadTempFile).toHaveBeenCalledExactlyOnceWith('a', accepted, expect.any(Function));
    expect(uploadText()).toContain('temp_file_too_large');
    expect(uploadText()).toContain('at-capUploaded');
  });

  it('continues after upload failure and clears completed/error rows after the display period', async () => {
    vi.mocked(api.uploadTempFile).mockRejectedValueOnce({ error: 'network_error' });
    render([file('failed'), file('next')]);
    await act(async () => {});
    expect(api.uploadTempFile).toHaveBeenCalledTimes(2);
    expect(uploadText()).toContain('network_error');
    expect(uploadText()).toContain('nextUploaded');
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});

describe('TempTransferView cleanup', () => {
  it.each(['success', 'failure'])('ignores late cleanup %s after switching agents', async outcome => {
    const pending = deferred<api.TempCleanupResult>();
    vi.mocked(api.cleanupTempFolder).mockReturnValueOnce(pending.promise);
    render();
    await act(async () => { clean().click(); });
    expect(clean().disabled).toBe(true);
    await act(async () => {
      root.render(<TempTransferView agent={{ ...agent, id: 'b', temp_root_name: 'other-temp' }} />);
    });
    expect(clean().disabled).toBe(false);
    await act(async () => {
      if (outcome === 'success') pending.resolve({ ok: true, removed: 2, freed_bytes: 10 });
      else pending.reject({ error: 'old-agent-error' });
    });
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(vi.mocked(api.fsList).mock.calls.map(call => call[0])).toEqual(['a', 'b']);
    expect(clean().disabled).toBe(false);
  });

  it('guards cleanup while busy, re-lists on success, and dismisses its result banner', async () => {
    const pending = deferred<api.TempCleanupResult>();
    vi.mocked(api.cleanupTempFolder).mockReturnValueOnce(pending.promise);
    render();
    await act(async () => {});
    act(() => { clean().click(); });
    expect(clean().disabled).toBe(true);
    act(() => { clean().click(); });
    expect(api.cleanupTempFolder).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ ok: true, removed: 2, freed_bytes: 10 }); });
    expect(clean().disabled).toBe(false);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('removed 2 items (10 B)');
    expect(api.fsList).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('shows cleanup failure, unlocks the control, and permits retry', async () => {
    vi.mocked(api.cleanupTempFolder).mockRejectedValueOnce({ error: 'backend_offline' });
    render();
    await act(async () => {});
    await act(async () => { clean().click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('backend_offline');
    expect(clean().disabled).toBe(false);
    await act(async () => { clean().click(); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Cleaned the temp folder');
  });
});
