import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { AgentSettings } from './AgentSettings';

vi.mock('../api/client', async (original) => ({ ...await original<typeof api>(), setHerdrEnabled: vi.fn() }));
vi.mock('./RootManager', () => ({ RootManager: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const agent = {
  id: 'lab', name: 'Lab box', status: 'online', roots: [], last_seen: 0,
  rtt_ms: null, resource_revision: 0, inflight: 0,
  capabilities: { herdr: false, herdr_settings: true, herdr_enabled: true, herdr_locked: false },
} as api.AgentInfo;
const toggle = () => container.querySelector<HTMLButtonElement>('[aria-label="Herdr integration"]')!;
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('saves the Agent setting even with no CLI and refreshes only after acknowledgement', async () => {
  let resolve!: (value: { enabled: boolean; available: boolean; locked: boolean }) => void;
  vi.mocked(api.setHerdrEnabled).mockReturnValue(new Promise((done) => { resolve = done; }));
  const refresh = vi.fn();
  await act(async () => root.render(<AgentSettings agent={agent} onRefresh={refresh} />));
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  await act(async () => toggle().click());
  expect(api.setHerdrEnabled).toHaveBeenCalledWith('lab', false);
  expect(toggle().disabled).toBe(true);
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => resolve({ enabled: false, available: false, locked: false }));
  expect(refresh).toHaveBeenCalledOnce();
  await act(async () => root.render(<AgentSettings agent={{ ...agent, capabilities: { ...agent.capabilities, herdr_enabled: false } }} onRefresh={refresh} />));
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  expect(container.textContent).toContain('Disabled');
});

it('keeps the prior setting and shows a retryable error when persistence fails', async () => {
  vi.mocked(api.setHerdrEnabled).mockRejectedValue(new Error('Could not write Agent configuration. Please retry.'));
  const refresh = vi.fn();
  await act(async () => root.render(<AgentSettings agent={agent} onRefresh={refresh} />));
  await act(async () => toggle().click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not write');
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  expect(toggle().disabled).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
});

it.each(['offline', 'locked', 'legacy'])('does not offer an ineffective switch for %s Agents', async (state) => {
  const backend = { ...agent, status: state === 'offline' ? 'offline' : 'online',
    capabilities: { ...agent.capabilities, herdr_locked: state === 'locked', herdr_settings: state !== 'legacy' } };
  await act(async () => root.render(<AgentSettings agent={backend} onRefresh={vi.fn()} />));
  expect(toggle().disabled).toBe(true);
  expect(container.textContent).toContain(state === 'locked' ? 'Controlled by' : state === 'legacy' ? 'Update the Filebox Agent' : 'Reconnect this backend');
});
