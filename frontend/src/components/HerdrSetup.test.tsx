import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { HerdrIntroduction, HerdrSetup, HerdrToggle } from './HerdrSetup';

vi.mock('../api/client', async (original) => ({
  ...await original<typeof api>(), setHerdrEnabled: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const agent = {
  id: 'a1', name: 'Lab', status: 'online',
  capabilities: { herdr: false, herdr_settings: { enabled: true, environment_override: null } },
} as api.AgentInfo;
const refresh = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
function button(label: string) {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
}

it('introduces missing Herdr, remembers dismissal per backend, and leaves setup reachable', async () => {
  const open = vi.fn();
  await act(async () => root.render(<HerdrIntroduction key="a1" agent={agent} onOpen={open} />));
  expect(container.textContent).toContain('Meet Herdr');
  expect(container.textContent).toContain('file browsing works without it');
  await act(async () => button('Learn more').click());
  expect(open).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  await act(async () => root.render(<HerdrIntroduction key="a1" agent={agent} onOpen={open} />));
  expect(container.textContent).toBe('');
  await act(async () => root.render(<HerdrIntroduction key="a2" agent={{ ...agent, id: 'a2' }} onOpen={open} />));
  expect(container.textContent).toContain('Meet Herdr');
  await act(async () => root.render(<HerdrSetup agent={agent} onRefresh={refresh} />));
  expect(container.querySelector('a')?.href).toBe('https://herdr.ink/');
  expect(button('Check installation')).toBeTruthy();
});

it.each([
  { ...agent, status: 'offline' },
  { ...agent, capabilities: { ...agent.capabilities, herdr: true } },
  { ...agent, capabilities: { ...agent.capabilities, herdr_settings: { enabled: false, environment_override: null } } },
  { ...agent, capabilities: { ...agent.capabilities, herdr_settings: undefined } },
])('does not introduce installed, disabled, offline or legacy backends', async (backend) => {
  await act(async () => root.render(<HerdrIntroduction agent={backend} onOpen={vi.fn()} />));
  expect(container.textContent).toBe('');
});

it('waits for a saved Agent setting instead of optimistically switching off', async () => {
  let finish!: (value: api.HerdrSettings) => void;
  vi.mocked(api.setHerdrEnabled).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(<HerdrToggle agent={agent} onRefresh={refresh} />));
  await act(async () => button('On').click());
  expect(api.setHerdrEnabled).toHaveBeenCalledWith('a1', false);
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  expect(button('Saving…').disabled).toBe(true);
  await act(async () => finish({ enabled: false, environment_override: null }));
  expect(button('Off')).toBeTruthy();
  expect(refresh).toHaveBeenCalledOnce();
});

it('shows save failures and keeps the switch at the last confirmed state', async () => {
  vi.mocked(api.setHerdrEnabled).mockRejectedValue({ error: 'permission_denied', message: 'Cannot save setting' });
  await act(async () => root.render(<HerdrToggle agent={agent} onRefresh={refresh} />));
  await act(async () => button('On').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
});

it.each([true, false])('locks the Web switch when the Agent environment overrides it (%s)', async (enabled) => {
  const backend = { ...agent, capabilities: { ...agent.capabilities,
    herdr_settings: { enabled, environment_override: enabled } } };
  await act(async () => root.render(<HerdrToggle agent={backend} onRefresh={refresh} />));
  expect(container.querySelector('button')?.disabled).toBe(true);
  expect(container.textContent).toContain(`FILEBOX_AGENT_HERDR_ENABLED=${enabled ? '1' : '0'}`);
  expect(api.setHerdrEnabled).not.toHaveBeenCalled();
});

it('rechecks installation without running a Herdr control command', async () => {
  vi.mocked(api.setHerdrEnabled).mockResolvedValue({ enabled: true, environment_override: null });
  await act(async () => root.render(<HerdrSetup agent={agent} onRefresh={refresh} />));
  await act(async () => button('Check installation').click());
  expect(api.setHerdrEnabled).toHaveBeenCalledWith('a1', true);
  expect(refresh).toHaveBeenCalledOnce();
});
