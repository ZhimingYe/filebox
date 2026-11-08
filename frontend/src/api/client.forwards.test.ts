import { afterEach, expect, it, vi } from 'vitest';
import * as api from './client';

afterEach(() => {
  api.setCsrfToken(null);
  vi.unstubAllGlobals();
});

it.each([
  { method: 'POST', body: { port: 9001, name: 'Python' }, run: () => api.addForward('agent/a', { port: 9001, name: 'Python' }) },
  { method: 'DELETE', body: { port: 9001 }, run: () => api.deleteForward('agent/a', 9001) },
])('sends $method with credentials and CSRF', async ({ method, body, run }) => {
  api.setCsrfToken('csrf');
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, state: 'pending_agent_reconnect' })));
  vi.stubGlobal('fetch', fetch);
  await expect(run()).resolves.toEqual({ ok: true, state: 'pending_agent_reconnect' });
  expect(fetch).toHaveBeenCalledWith('/api/agents/agent%2Fa/forwards', expect.objectContaining({
    method, body: JSON.stringify(body), credentials: 'include',
  }));
  expect((fetch.mock.calls[0][1].headers as Headers).get('X-CSRF-Token')).toBe('csrf');
});

it.each([{ ok: false }, { state: 'rejected' }, { error: 'invalid_forward', message: 'Duplicate port' }])('surfaces rejected updates %j', async (body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
  await expect(api.addForward('a', { port: 9001, name: 'Python' })).rejects.toMatchObject({
    message: 'message' in body ? body.message : 'Agent rejected the forward update.',
  });
});

it('encodes Agent IDs in forward links', () => {
  expect(api.forwardPath('agent/a', 9001)).toBe('/_fwd/agent%2Fa/9001/');
});
