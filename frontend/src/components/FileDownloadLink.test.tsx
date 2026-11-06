import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileRawAccessUrl, friendlyMessage } from '../api/client';
import { FileDownloadLink } from './FileDownloadLink';

vi.mock('../api/client', () => ({ fileRawAccessUrl: vi.fn(), friendlyMessage: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | null;
let rowClick: ReturnType<typeof vi.fn>;
let clicked: { href: string; download: string; rel: string; connected: boolean }[];
const button = () => host.querySelector<HTMLButtonElement>('button[aria-label="Download report"]')!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  rowClick = vi.fn();
  clicked = [];
  vi.mocked(fileRawAccessUrl).mockResolvedValue('/api/file/raw?access_token=bearer');
  vi.mocked(friendlyMessage).mockReturnValue('Download unavailable');
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.getAttribute('href')!, download: this.download,
      rel: this.rel, connected: this.isConnected });
  });
  act(() => {
    root!.render(<div onClick={rowClick}>
      <FileDownloadLink agentId="a" root="r" path="/report.pdf" aria-label="Download report" />
    </div>);
  });
});
afterEach(() => {
  act(() => { root?.unmount(); });
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('FileDownloadLink', () => {
  it('does not mint or download merely by rendering', () => {
    expect(fileRawAccessUrl).not.toHaveBeenCalled();
    expect(clicked).toEqual([]);
    expect(button().disabled).toBe(false);
  });

  it('mints on click, downloads the bearer URL, and does not activate the row', async () => {
    await act(async () => { button().click(); });
    expect(fileRawAccessUrl).toHaveBeenCalledExactlyOnceWith('a', 'r', '/report.pdf');
    expect(clicked).toEqual([{
      href: '/api/file/raw?access_token=bearer', download: '', rel: 'noopener', connected: true,
    }]);
    expect(clicked[0].href).not.toContain('csrf');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('prevents another mint during cooldown and permits one at the boundary', async () => {
    await act(async () => { button().click(); });
    act(() => { button().click(); });
    expect(button().disabled).toBe(true);
    expect(fileRawAccessUrl).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
    expect(button().disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(button().disabled).toBe(false);
    await act(async () => { button().click(); });
    expect(fileRawAccessUrl).toHaveBeenCalledTimes(2);
  });

  it('surfaces mint failure without downloading and recovers after cooldown', async () => {
    const error = { error: 'backend_offline' };
    vi.mocked(fileRawAccessUrl).mockRejectedValueOnce(error);
    await act(async () => { button().click(); });
    expect(friendlyMessage).toHaveBeenCalledWith(error);
    expect(window.alert).toHaveBeenCalledWith('Download unavailable');
    expect(clicked).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { button().click(); });
    expect(clicked).toHaveLength(1);
  });

  it('clears its cooldown timer on unmount', async () => {
    await act(async () => { button().click(); });
    act(() => { root!.unmount(); root = null; });
    expect(vi.getTimerCount()).toBe(0);
  });
});
