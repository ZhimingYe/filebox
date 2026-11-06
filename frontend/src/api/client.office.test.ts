import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let api: typeof import('./client');
let fetchMock: ReturnType<typeof vi.fn>;
const hash = 'a1'.repeat(32);
const pdf = { label: 'Document', format: 'pdf', cache_key: hash, size: 12 };

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = await import('./client');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function respond(body: unknown) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => body });
}

const convert = () => api.officeConvert('agent', 'root', '/表.xlsx', 'req', 'nonce', true);

describe('officeConvert', () => {
  it('retains valid PDF and zero-byte CSV outputs and sends nonce/force', async () => {
    const csv = { label: '空表', format: 'csv', cache_key: hash.toUpperCase(), size: 0 };
    respond({ req_id: 'req', cache_key: null, size: null, outputs: [pdf, csv] });
    await expect(convert()).resolves.toEqual({
      req_id: 'req', cache_key: hash, size: 12, outputs: [pdf, csv],
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/agents/agent/office-convert');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      root: 'root', path: '/表.xlsx', req_id: 'req', client_nonce: 'nonce', force: true,
    });
  });

  it.each([
    { label: null }, { format: 'html' }, { cache_key: 'short' },
    { cache_key: 'z'.repeat(64) }, { size: '12' }, { size: NaN },
    { size: Infinity }, { size: -1 }, { size: 0 },
  ])('drops invalid output fields %j while preserving valid outputs', async patch => {
    respond({ cache_key: null, size: null, outputs: [{ ...pdf, ...patch }, pdf] });
    expect((await convert()).outputs).toEqual([pdf]);
  });

  it('rejects an entirely invalid output list without a legacy fallback', async () => {
    respond({ cache_key: null, size: null, outputs: [{ ...pdf, size: 0 }] });
    await expect(convert()).rejects.toMatchObject({
      status: 502, error: 'office_convert_failed',
    });
  });

  it('supports the legacy single-PDF response and defaults force to false', async () => {
    respond({ cache_key: hash, size: 20 });
    await expect(api.officeConvert('a', 'r', '/old.doc', 'id', 'nonce')).resolves.toMatchObject({
      cache_key: hash, size: 20,
      outputs: [{ label: 'Document', format: 'pdf', cache_key: hash, size: 20 }],
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).force).toBe(false);
  });

  it('surfaces an agent conversion error instead of consuming its outputs', async () => {
    respond({ error: 'office_convert_timeout', outputs: [pdf] });
    await expect(convert()).rejects.toEqual({
      status: 400, error: 'office_convert_timeout', message: 'office_convert_timeout',
    });
  });
});

describe('officeCacheVirtualPath', () => {
  it('uses PDF by default and CSV for sheet output', () => {
    expect(api.officeCacheVirtualPath(hash)).toBe('/.filebox/office-cache/' + hash + '.pdf');
    expect(api.officeCacheVirtualPath(hash, 'csv')).toBe('/.filebox/office-cache/' + hash + '.csv');
  });
});
