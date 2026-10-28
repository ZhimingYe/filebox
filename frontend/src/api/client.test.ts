import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from './client';
import { friendlyMessage } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(['herdr_unavailable', 'herdr_blocked', 'herdr_timeout', 'herdr_not_idle'] as const)(
  'explains Herdr errors for %s',
  (error) => {
    expect(friendlyMessage({ error })).not.toBe('An unexpected error occurred.');
  },
);

it.each(['temp_upload_stalled', 'temp_upload_stalled: upload queue is full; retry upload'])(
  'explains upload congestion and retry for %s', (error) => {
    const message = friendlyMessage({ error, retryable: true });
    expect(message).toContain('agent');
    expect(message).toContain('retry');
    expect(message).not.toBe('An unexpected error occurred.');
  },
);

it.each([
  null,
  undefined,
  42,
  'backend_offline',
  { error: {} },
  { error: ['backend_offline'] },
  { error: 'toString' },
  { error: '__proto__' },
])('returns a string fallback for an unrecognized error %j', (error) => {
  expect(friendlyMessage(error)).toBe('An unexpected error occurred.');
});

it('recognizes error codes carried in an Error message', () => {
  expect(friendlyMessage(new Error('backend_offline'))).toContain('Agent is offline');
});

const mutations = [
  { name: 'add root', fallback: 'resource_rejected', run: () => api.addRoot('a1', 'data', '/data') },
  { name: 'patch root', fallback: 'resource_rejected', run: () => api.patchRoot('a1', 'data', { enabled: false }) },
  { name: 'delete root', fallback: 'resource_rejected', run: () => api.deleteRoot('a1', 'data') },
  { name: 'create collection', fallback: 'collection_rejected', run: () => api.createCollection('a1', 'work') },
  { name: 'patch collection', fallback: 'collection_rejected', run: () => api.patchCollection('a1', 'work', { rename: 'new' }) },
  { name: 'delete collection', fallback: 'collection_rejected', run: () => api.deleteCollection('a1', 'work') },
];

it('sends the per-Agent Herdr preference through the authenticated API', async () => {
  const settings = { enabled: false, environment_override: null };
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(settings)));
  vi.stubGlobal('fetch', fetchMock);
  await expect(api.setHerdrEnabled('agent/a', false)).resolves.toEqual(settings);
  expect(fetchMock).toHaveBeenCalledWith('/api/agents/agent%2Fa/herdr-settings', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ enabled: false }), credentials: 'include',
  }));
});

describe.each(mutations)('$name acknowledgement', ({ run, fallback }) => {
  it.each([
    { ok: false, state: 'rejected', error: 'permission_denied', message: 'Denied by agent' },
    { ok: false },
    { state: 'rejected' },
    { error: 'backend_offline', message: 'Agent disconnected', retryable: true },
    { error: 'permission_denied', retryable: false },
  ])('surfaces an HTTP 200 rejection %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await expect(run()).rejects.toMatchObject({
      status: 200,
      error: 'error' in body ? body.error : fallback,
      retryable: 'retryable' in body ? body.retryable : true,
    });
    expect(friendlyMessage({ error: fallback })).toContain('Agent rejected');
  });

  it.each(['applied', 'pending_agent_reconnect'])('preserves a successful %s response', async (state) => {
    const body = { ok: true, state };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await expect(run()).resolves.toEqual(body);
  });
});
