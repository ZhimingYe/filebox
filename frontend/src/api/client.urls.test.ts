import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileStat } from './client';

let api: typeof import('./client');
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
  fetchMock = vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify({ token: 'bearer /世界#?', expires_in_sec: 90 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  api = await import('./client');
  api.setCsrfToken('csrf-secret-never-in-url');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('audit query', () => {
  it.each([
    [{}, ''],
    [{ limit: 0, before: 0 }, ''],
    [{ limit: 25 }, '?limit=25'],
    [{ before: 123 }, '?before=123'],
    [{ limit: 25, before: 123 }, '?limit=25&before=123'],
  ])('omits absent and zero parameters for %j', async (opts, query) => {
    await api.getLoginAudit(opts);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/audit/logins' + query);
  });

  it('serializes numeric query values through URLSearchParams', async () => {
    await api.getLoginAudit({ before: 1e21 });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/audit/logins?before=1e%2B21');
  });
});

describe('file and bearer URLs', () => {
  const agent = 'agent /世界#?';
  const root = 'root /世界#?';
  const path = '/目录/a b#?.txt';

  it.each(['list', 'stat'] as const)('round-trips reserved characters through fs%s', async operation => {
    if (operation === 'list') await api.fsList(agent, root, path, 25, 'cursor /#?', true);
    else await api.fsStat(agent, root, path);
    const url = new URL(fetchMock.mock.calls[0][0], 'https://filebox.test');
    expect(url.pathname).toBe('/api/fs/' + operation);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      agent_id: agent, root, path,
    });
    expect(url.hash).toBe('');
    expect(url.href).not.toContain('csrf-secret');
    if (operation === 'list') {
      expect(url.searchParams.get('cursor')).toBe('cursor /#?');
      expect(url.searchParams.get('limit')).toBe('25');
      expect(url.searchParams.get('dirs_only')).toBe('true');
    }
  });

  it('omits list cursor and dirs_only when not requested', async () => {
    await api.fsList(agent, root, path);
    const url = new URL(fetchMock.mock.calls[0][0], 'https://filebox.test');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(url.searchParams.has('dirs_only')).toBe(false);
    expect(url.searchParams.get('limit')).toBe('200');
  });

  it('builds raw URLs without CSRF, adding only an optional encoded bearer', () => {
    const bare = new URL(api.fileRawUrl(agent, root, path), 'https://filebox.test');
    expect(Object.fromEntries(bare.searchParams)).toEqual({ agent_id: agent, root, path });
    const access = new URL(
      api.fileRawUrl(agent, root, path, 'token /#?世界'), bare.origin,
    );
    expect(access.searchParams.get('access_token')).toBe('token /#?世界');
    expect(access.hash).toBe('');
    expect(access.href).not.toContain('csrf-secret');
    expect(bare.href).not.toContain('csrf-secret');
  });

  it('mints file access for the exact file without leaking CSRF into the returned URL', async () => {
    const url = new URL(await api.fileRawAccessUrl(agent, root, path), 'https://filebox.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      agent_id: agent, root, path, access_token: 'bearer /世界#?',
    });
    expect(url.href).not.toContain('csrf-secret');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(fetchMock.mock.calls[0][0]).toBe('/api/access-tokens');
    expect(JSON.parse(init.body as string)).toEqual({
      purpose: 'file_raw', agent_id: agent, root, path,
    });
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-secret-never-in-url');
  });

  it('mints an events-scoped bearer URL and retains its TTL', async () => {
    const result = await api.eventsAccessUrl();
    const url = new URL(result.url, 'https://filebox.test');
    expect(url.pathname).toBe('/api/events');
    expect([...url.searchParams]).toEqual([['access_token', 'bearer /世界#?']]);
    expect(url.hash).toBe('');
    expect(result.expiresInSec).toBe(90);
    expect(result.url).not.toContain('csrf-secret');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ purpose: 'events' });
  });
});

describe('statToFsEntry', () => {
  it.each([
    ['/目录/file.txt', '/ignored', 'file.txt'],
    ['', '/fallback/name/', 'name'],
    ['/', '/ignored', '/'],
    ['', undefined, ''],
  ])('chooses basename from %j then hint %j', (path, hint, name) => {
    const stat = { path, entry_type: 'symlink', denied: true } as FileStat;
    expect(api.statToFsEntry(stat, hint)).toEqual({
      name, entry_type: 'symlink', size: null, modified: null, denied: true,
    });
  });

  it('preserves zero size and metadata without changing the stat object', () => {
    const stat: FileStat = {
      path: '/empty', entry_type: 'file', size: 0,
      modified: '2024-01-01', denied: false,
    };
    const before = { ...stat };
    expect(api.statToFsEntry(stat)).toEqual({
      name: 'empty', entry_type: 'file', size: 0,
      modified: '2024-01-01', denied: false,
    });
    expect(stat).toEqual(before);
  });
});
