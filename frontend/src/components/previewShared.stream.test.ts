import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBodyWithProgress } from './previewShared';

afterEach(() => vi.restoreAllMocks());

function response(chunks: Uint8Array[], length?: string) {
  let index = 0;
  const read = vi.fn(async () => index < chunks.length
    ? { done: false, value: chunks[index++] }
    : { done: true, value: undefined });
  return {
    headers: new Headers(length === undefined ? {} : { 'content-length': length }),
    body: { getReader: () => ({ read }) },
  } as unknown as Response;
}

describe('readBodyWithProgress', () => {
  it('joins chunks byte-for-byte, skips empty chunks, and reports final completion', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const progress = vi.fn();
    const buffer = await readBodyWithProgress(response([
      new Uint8Array([0, 255]), new Uint8Array(), new Uint8Array([128, 7]),
    ], '4'), progress);
    expect([...new Uint8Array(buffer)]).toEqual([0, 255, 128, 7]);
    expect(progress.mock.calls).toEqual([[0, 4], [2, 4], [4, 4]]);
  });

  it.each([undefined, '', 'invalid', '-1', 'Infinity'])(
    'treats content-length %j as unknown and resolves an empty stream',
    async length => {
      const progress = vi.fn();
      expect((await readBodyWithProgress(response([], length), progress)).byteLength).toBe(0);
      expect(progress.mock.calls).toEqual([[0, null], [0, 0]]);
    },
  );

  it('accepts a declared zero-byte body', async () => {
    const progress = vi.fn();
    expect((await readBodyWithProgress(response([], '0'), progress)).byteLength).toBe(0);
    expect(progress.mock.calls).toEqual([[0, 0], [0, 0]]);
  });

  it.each(['2', '4'])('rejects mismatched declared length %s without reporting completion', async length => {
    const progress = vi.fn();
    await expect(readBodyWithProgress(response([new Uint8Array(3)], length), progress))
      .rejects.toMatchObject({
        error: 'request_stalled', retryable: true,
        message: `File download incomplete (3 of ${length} bytes).`,
      });
    expect(progress.mock.calls[0]).toEqual([0, Number(length)]);
  });

  it.each([undefined, '3'])('uses arrayBuffer when no reader exists (length=%s)', async length => {
    const data = new Uint8Array([1, 2, 3]).buffer;
    const arrayBuffer = vi.fn().mockResolvedValue(data);
    const res = {
      headers: new Headers(length ? { 'content-length': length } : {}),
      body: null, arrayBuffer,
    } as unknown as Response;
    const progress = vi.fn();
    expect(await readBodyWithProgress(res, progress)).toBe(data);
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls).toEqual([[0, length ? 3 : null], [3, 3]]);
  });

  it('also validates length on the non-streaming fallback', async () => {
    const res = {
      headers: new Headers({ 'content-length': '4' }),
      body: null, arrayBuffer: async () => new Uint8Array(3).buffer,
    } as unknown as Response;
    await expect(readBodyWithProgress(res, vi.fn()))
      .rejects.toMatchObject({ error: 'request_stalled', retryable: true });
  });

  it('propagates reader failure without claiming final completion', async () => {
    const error = new Error('reader failed');
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array([1]) })
      .mockRejectedValueOnce(error);
    const res = {
      headers: new Headers({ 'content-length': '4' }),
      body: { getReader: () => ({ read }) },
    } as unknown as Response;
    const progress = vi.fn();
    await expect(readBodyWithProgress(res, progress)).rejects.toBe(error);
    expect(progress).not.toHaveBeenCalledWith(4, 4);
  });

  it('throttles small rapid chunks but emits the final byte count', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const progress = vi.fn();
    await readBodyWithProgress(
      response(Array.from({ length: 10 }, () => new Uint8Array(1))), progress,
    );
    expect(progress.mock.calls).toEqual([[0, null], [1, null], [10, 10]]);
  });

  it('reports again after enough bytes even without elapsed time', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const progress = vi.fn();
    await readBodyWithProgress(response([
      new Uint8Array(1), new Uint8Array(262144), new Uint8Array(1),
    ]), progress);
    expect(progress.mock.calls).toEqual([
      [0, null], [1, null], [262145, null], [262146, 262146],
    ]);
  });

  it('reports small chunks again after the time throttle expires', async () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0).mockReturnValueOnce(99).mockReturnValueOnce(100);
    const progress = vi.fn();
    await readBodyWithProgress(response([
      new Uint8Array(1), new Uint8Array(1), new Uint8Array(1),
    ]), progress);
    expect(progress.mock.calls).toEqual([[0, null], [1, null], [3, null], [3, 3]]);
  });
});
