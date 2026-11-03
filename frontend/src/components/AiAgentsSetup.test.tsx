import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { AiAgentsIntroduction, AiAgentsSetup, AiAgentsToggle } from './AiAgentsSetup';
import { AgentSettings } from './AgentSettings';

vi.mock('../api/client', async (original) => ({
  ...await original<typeof api>(), setAiAgentsEnabled: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const agent = {
  id: 'a1', name: 'Lab', status: 'online',
  capabilities: { ai_agents: { available: false, backend: null, version: null, settings: { enabled: true, environment_override: null } } },
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
  return [...container.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === label)!;
}

it('introduces missing AiAgent, remembers dismissal per backend, and leaves setup reachable', async () => {
  const open = vi.fn();
  await act(async () => root.render(<AiAgentsIntroduction key="a1" agent={agent} onOpen={open} />));
  expect(container.textContent).toContain('Meet AI Agents');
  expect(container.textContent).toContain('file browsing works without it');
  await act(async () => button('Learn more').click());
  expect(open).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  await act(async () => root.render(<AiAgentsIntroduction key="a1" agent={agent} onOpen={open} />));
  expect(container.textContent).toBe('');
  await act(async () => root.render(<AiAgentsIntroduction key="a2" agent={{ ...agent, id: 'a2' }} onOpen={open} />));
  expect(container.textContent).toContain('Meet AI Agents');
  await act(async () => root.render(<AiAgentsSetup agent={agent} onRefresh={refresh} />));
  expect(container.querySelector('a')?.href).toBe('https://herdr.ink/');
  expect(button('Check installation')).toBeTruthy();
});

it.each([
  { ...agent, status: 'offline' },
  { ...agent, capabilities: { ...agent.capabilities, ai_agents: { available: true, backend: 'herdr', version: '0.9.5', settings: { enabled: true, environment_override: null } } } },
  { ...agent, capabilities: { ...agent.capabilities, ai_agents: { available: false, backend: null, version: null, settings: { enabled: false, environment_override: null } } } },
  { ...agent, capabilities: { ...agent.capabilities, ai_agents: undefined } },
])('does not introduce installed, disabled, offline or legacy backends', async (backend) => {
  await act(async () => root.render(<AiAgentsIntroduction agent={backend} onOpen={vi.fn()} />));
  expect(container.textContent).toBe('');
});

it('waits for a saved Agent setting instead of optimistically switching off', async () => {
  let finish!: (value: api.AiAgentsCapability) => void;
  vi.mocked(api.setAiAgentsEnabled).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(<AiAgentsToggle agent={agent} onRefresh={refresh} />));
  const toggle = button('AI Agents');
  expect(toggle.style.width).toBe('40px');
  expect(toggle.style.height).toBe('22px');
  expect(toggle.querySelector('span')?.style.transform).toBe('translateX(18px)');
  await act(async () => toggle.click());
  expect(api.setAiAgentsEnabled).toHaveBeenCalledWith('a1', false);
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  expect(toggle.disabled).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Saving…');
  await act(async () => finish({ available: false, backend: null, version: null, settings: { enabled: false, environment_override: null } }));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(toggle.querySelector('span')?.style.transform).toBe('');
  expect(toggle.disabled).toBe(false);
  expect(refresh).toHaveBeenCalledOnce();
});

it('shows save failures and keeps the switch at the last confirmed state', async () => {
  vi.mocked(api.setAiAgentsEnabled).mockRejectedValue({ error: 'permission_denied', message: 'Cannot save setting' });
  await act(async () => root.render(<AiAgentsToggle agent={agent} onRefresh={refresh} />));
  await act(async () => button('AI Agents').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
});

it.each([true, false])('locks the Web switch when the Agent environment overrides it (%s)', async (enabled) => {
  const backend = { ...agent, capabilities: { ...agent.capabilities,
    ai_agents: { available: false, backend: null, version: null, settings: { enabled, environment_override: enabled } } } };
  await act(async () => root.render(<AiAgentsToggle agent={backend} onRefresh={refresh} />));
  expect(container.querySelector('button')?.disabled).toBe(true);
  expect(container.textContent).toContain(`FILEBOX_AGENT_AI_AGENTS_ENABLED=${enabled ? '1' : '0'}`);
  expect(api.setAiAgentsEnabled).not.toHaveBeenCalled();
});

it('rechecks installation without running a AiAgent control command', async () => {
  vi.mocked(api.setAiAgentsEnabled).mockResolvedValue({ available: true, backend: 'herdr', version: '0.9.5', settings: { enabled: true, environment_override: null } });
  await act(async () => root.render(<AiAgentsSetup agent={agent} onRefresh={refresh} />));
  await act(async () => button('Check installation').click());
  expect(api.setAiAgentsEnabled).toHaveBeenCalledWith('a1', true);
  expect(refresh).toHaveBeenCalledOnce();
});

it('uses the same switch geometry for Office preview and AiAgent in Agent Settings', async () => {
  const backend = { ...agent, roots: [], last_seen: 0, rtt_ms: null } as api.AgentInfo;
  await act(async () => root.render(<AgentSettings agent={backend} onRefresh={refresh} />));
  const office = button('Office preview');
  const aiAgents = button('AI Agents');
  expect(aiAgents.style.width).toBe(office.style.width);
  expect(aiAgents.style.height).toBe(office.style.height);
  expect(aiAgents.style.borderRadius).toBe(office.style.borderRadius);
  expect(aiAgents.querySelector('span')?.style.cssText).toBe(office.querySelector('span')?.style.cssText);
});
