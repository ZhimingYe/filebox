import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fsStat } from '../api/client';
import {
  findNearestExistingDir, loadNavPosMap, loadPathMemoryMap, memKey,
  NAV_POS_STORAGE, PATH_MEM_STORAGE, persistNavState,
} from './navPersistence';

vi.mock('../api/client', () => ({ fsStat: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(fsStat).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('navigation storage', () => {
  it('rejects populated arrays instead of treating their indexes as map keys', () => {
    localStorage.setItem(NAV_POS_STORAGE, '[{"root":"r","path":"/"}]');
    localStorage.setItem(PATH_MEM_STORAGE, '["/unexpected"]');
    expect(loadNavPosMap()).toEqual(new Map());
    expect(loadPathMemoryMap()).toEqual(new Map());
  });
  it('round-trips agent positions and independent per-root memories', () => {
    const positions = new Map([
      ['a', { root: 'data', path: '/one' }],
      ['b', { root: 'data', path: '/two' }],
    ]);
    const memory = new Map([
      [memKey('a', 'data'), '/one'],
      [memKey('b', 'data'), '/two'],
      [memKey('a', 'other'), '/three'],
    ]);
    persistNavState(positions, memory);
    expect(loadNavPosMap()).toEqual(positions);
    expect(loadPathMemoryMap()).toEqual(memory);
    const loaded = loadNavPosMap();
    loaded.get('a')!.path = '/changed';
    expect(loadNavPosMap().get('a')?.path).toBe('/one');
    persistNavState(new Map(), new Map());
    expect(loadNavPosMap().size).toBe(0);
    expect(loadPathMemoryMap().size).toBe(0);
  });

  it.each(['{broken', 'null', '[]', '42', 'true'])(
    'loads safe defaults for %j',
    raw => {
      localStorage.setItem(NAV_POS_STORAGE, raw);
      localStorage.setItem(PATH_MEM_STORAGE, raw);
      expect(loadNavPosMap()).toEqual(new Map());
      expect(loadPathMemoryMap()).toEqual(new Map());
    },
  );

  it('keeps valid records and ignores null, missing and wrong field types', () => {
    localStorage.setItem(NAV_POS_STORAGE, JSON.stringify({
      valid: { root: 'r', path: '/' },
      nil: null, missing: { root: 'r' },
      number: { root: 1, path: '/' }, nested: { root: 'r', path: {} },
    }));
    localStorage.setItem(PATH_MEM_STORAGE, JSON.stringify({
      'a:r': '/', nil: null, array: [], number: 4, object: {},
    }));
    expect(loadNavPosMap()).toEqual(new Map([
      ['valid', { root: 'r', path: '/' }],
    ]));
    expect(loadPathMemoryMap()).toEqual(new Map([['a:r', '/']]));
  });

  it('tolerates blocked storage reads and writes', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(loadNavPosMap()).toEqual(new Map());
    expect(loadPathMemoryMap()).toEqual(new Map());
    expect(() => persistNavState(
      new Map([['a', { root: 'r', path: '/' }]]),
      new Map([['a:r', '/']]),
    )).not.toThrow();
  });
});

const directory = { stat: { entry_type: 'directory' } } as Awaited<ReturnType<typeof fsStat>>;
const file = { stat: { entry_type: 'file' } } as Awaited<ReturnType<typeof fsStat>>;
const missing = { stat: null } as Awaited<ReturnType<typeof fsStat>>;

describe('findNearestExistingDir', () => {
  it('ignores a successful directory result if aborted while the probe was pending', async () => {
    const controller = new AbortController();
    vi.mocked(fsStat).mockImplementation(async () => {
      controller.abort();
      return directory;
    });
    await expect(findNearestExistingDir('a', 'r', '/gone', controller.signal)).resolves.toBeNull();
    expect(fsStat).toHaveBeenCalledTimes(1);
  });
  it('returns an existing directory without probing parents', async () => {
    vi.mocked(fsStat).mockResolvedValue(directory);
    await expect(findNearestExistingDir('agent', 'root', '/目录')).resolves.toBe('/目录');
    expect(fsStat).toHaveBeenCalledExactlyOnceWith('agent', 'root', '/目录', undefined);
  });

  it('walks from a file through missing parents to the root', async () => {
    vi.mocked(fsStat)
      .mockResolvedValueOnce(file)
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(directory);
    await expect(findNearestExistingDir('a', 'r', '/gone/file')).resolves.toBe('/');
    expect(vi.mocked(fsStat).mock.calls.map(call => call[2]))
      .toEqual(['/gone/file', '/gone', '/']);
  });

  it('stops at the nearest ancestor and terminates if even root is missing', async () => {
    vi.mocked(fsStat).mockResolvedValueOnce(missing).mockResolvedValueOnce(directory);
    await expect(findNearestExistingDir('a', 'r', '/parent/gone'))
      .resolves.toBe('/parent');
    vi.mocked(fsStat).mockReset().mockResolvedValue(missing);
    await expect(findNearestExistingDir('a', 'r', '/gone')).resolves.toBeNull();
    expect(vi.mocked(fsStat).mock.calls.map(call => call[2])).toEqual(['/gone', '/']);
  });

  it.each(['network_error', 'permission_denied', 'backend_offline'])(
    'does not replace the original position on %s',
    async error => {
      vi.mocked(fsStat).mockRejectedValue({ error, status: 503 });
      await expect(findNearestExistingDir('a', 'r', '/parent/gone')).resolves.toBeNull();
      expect(fsStat).toHaveBeenCalledTimes(1);
    },
  );

  it('does not probe with an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(findNearestExistingDir('a', 'r', '/x', controller.signal))
      .resolves.toBeNull();
    expect(fsStat).not.toHaveBeenCalled();
  });

  it('aborts an in-flight probe without probing another ancestor', async () => {
    const controller = new AbortController();
    vi.mocked(fsStat).mockImplementation((_a, _r, _p, signal) =>
      new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
    );
    const result = findNearestExistingDir('a', 'r', '/parent/gone', controller.signal);
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(fsStat).toHaveBeenCalledExactlyOnceWith(
      'a', 'r', '/parent/gone', controller.signal,
    );
  });

  it('checks cancellation between fulfilled missing-directory probes', async () => {
    const controller = new AbortController();
    vi.mocked(fsStat).mockImplementation(async () => {
      controller.abort();
      return missing;
    });
    await expect(findNearestExistingDir('a', 'r', '/parent/gone', controller.signal))
      .resolves.toBeNull();
    expect(fsStat).toHaveBeenCalledTimes(1);
  });
});
