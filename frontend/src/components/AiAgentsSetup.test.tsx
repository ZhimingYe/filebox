import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { AiAgentsIntroduction, AiAgentsSetup, AiAgentsToggle } from './AiAgentsSetup';
import { AgentSettings } from './AgentSettings';

vi.mock('../api/client', async (original) => ({
  ...await original<typeof api>(), setAiAgentsSettings: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const agent = {
  id: 'a1', name: 'Lab', status: 'online',
  capabilities: { ai_agents: { available: false, backend: null, version: null, backends: [],
    settings: { enabled: true, environment_override: null, backend: null, backend_environment_override: null } } },
} as unknown as api.AgentInfo;
const refresh = vi.fn();
function agentWithMissingBackend() {
  return { ...agent, capabilities: { ...agent.capabilities, ai_agents: {
    available: false, backend: 'other', version: null, backends: [{ kind: 'herdr', version: '0.9.5' }],
    settings: { enabled: true, environment_override: null, backend: 'other', backend_environment_override: null },
  } } } as unknown as api.AgentInfo;
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
const originalInnerWidth = window.innerWidth;
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.innerWidth = originalInnerWidth;
});
function button(label: string) {
  return [...container.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === label)!;
}

it('introduces AI Agents for a missing backend, remembers dismissal per backend, and leaves setup reachable', async () => {
  const open = vi.fn();
  await act(async () => root.render(<AiAgentsIntroduction key="a1" agent={agent} onOpen={open} />));
  expect(container.textContent).toContain('Meet AI Agents');
  expect(container.textContent).toContain('No supported backend has been detected.');
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

it('identifies the selected backend when another backend is detected', async () => {
  const missing = agentWithMissingBackend();
  await act(async () => root.render(<AiAgentsIntroduction agent={missing} onOpen={vi.fn()} />));
  expect(container.textContent).toContain('The selected backend other is not detected on this Agent.');
  expect(container.textContent).not.toContain('No supported backend has been detected.');

  await act(async () => root.render(<AiAgentsSetup agent={missing} onRefresh={refresh} />));
  expect(container.textContent).toContain('The selected backend other is not detected on this Agent.');
  expect(container.textContent).not.toContain('No supported AI agent backend has been detected.');
});

it.each([
  { ...agent, status: 'offline' },
  { ...agent, capabilities: { ...agent.capabilities, ai_agents: { available: true, backend: 'herdr', version: '0.9.5',
    backends: [{ kind: 'herdr', version: '0.9.5' }],
    settings: { enabled: true, environment_override: null, backend: null, backend_environment_override: null } } } },
  { ...agent, capabilities: { ...agent.capabilities, ai_agents: { available: false, backend: null, version: null, backends: [],
    settings: { enabled: false, environment_override: null, backend: null, backend_environment_override: null } } } },
  { ...agent, capabilities: { ...agent.capabilities, ai_agents: undefined } },
])('does not introduce installed, disabled, offline or legacy backends', async (backend) => {
  await act(async () => root.render(<AiAgentsIntroduction agent={backend} onOpen={vi.fn()} />));
  expect(container.textContent).toBe('');
});

it('waits for a saved Agent setting instead of optimistically switching off', async () => {
  let finish!: (value: api.AiAgentsCapability) => void;
  vi.mocked(api.setAiAgentsSettings).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(<AiAgentsToggle agent={agent} onRefresh={refresh} />));
  const toggle = button('AI Agents');
  expect(toggle.style.width).toBe('40px');
  expect(toggle.style.height).toBe('22px');
  expect(toggle.querySelector('span')?.style.transform).toBe('translateX(18px)');
  await act(async () => toggle.click());
  expect(api.setAiAgentsSettings).toHaveBeenCalledWith('a1', { enabled: false, backend: null });
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  expect(toggle.disabled).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Saving…');
  await act(async () => finish({ available: false, backend: null, version: null, backends: [],
    settings: { enabled: false, environment_override: null, backend: null, backend_environment_override: null } }));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(toggle.querySelector('span')?.style.transform).toBe('');
  expect(toggle.disabled).toBe(false);
  expect(refresh).toHaveBeenCalledOnce();
});

it('shows save failures and keeps the switch at the last confirmed state', async () => {
  vi.mocked(api.setAiAgentsSettings).mockRejectedValue({ error: 'permission_denied', message: 'Cannot save setting' });
  await act(async () => root.render(<AiAgentsToggle agent={agent} onRefresh={refresh} />));
  await act(async () => button('AI Agents').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
});

it.each([true, false])('locks the Web switch when the Agent environment overrides it (%s)', async (enabled) => {
  const backend = { ...agent, capabilities: { ...agent.capabilities,
    ai_agents: { available: false, backend: null, version: null, backends: [],
      settings: { enabled, environment_override: enabled, backend: null, backend_environment_override: null } } } };
  await act(async () => root.render(<AiAgentsToggle agent={backend} onRefresh={refresh} />));
  expect(container.querySelector('button')?.disabled).toBe(true);
  expect(container.textContent).toContain(`FILEBOX_AGENT_AI_AGENTS_ENABLED=${enabled ? '1' : '0'}`);
  expect(api.setAiAgentsSettings).not.toHaveBeenCalled();
});

it('rechecks installation without running an AI agent control command', async () => {
  vi.mocked(api.setAiAgentsSettings).mockResolvedValue({ available: true, backend: 'herdr', version: '0.9.5',
    backends: [{ kind: 'herdr', version: '0.9.5' }],
    settings: { enabled: true, environment_override: null, backend: null, backend_environment_override: null } });
  await act(async () => root.render(<AiAgentsSetup agent={agent} onRefresh={refresh} />));
  await act(async () => button('Check installation').click());
  expect(api.setAiAgentsSettings).toHaveBeenCalledWith('a1', { enabled: true, backend: null });
  expect(refresh).toHaveBeenCalledOnce();
});

it('shows the backend selector only when needed and preserves the selection on changes', async () => {
  const single = { ...agent, capabilities: { ...agent.capabilities, ai_agents: {
    available: true, backend: 'herdr', version: '0.9.5', backends: [{ kind: 'herdr', version: '0.9.5' }],
    settings: { enabled: true, environment_override: null, backend: null, backend_environment_override: null },
  } } } as api.AgentInfo;
  await act(async () => root.render(<AiAgentsToggle agent={single} onRefresh={refresh} />));
  expect(container.querySelector('select')).toBeNull();

  const multi = { ...single, capabilities: { ...single.capabilities, ai_agents: {
    ...single.capabilities!.ai_agents!,
    backends: [{ kind: 'herdr', version: '0.9.5' }, { kind: 'other', version: '1.2' }],
  } } } as api.AgentInfo;
  vi.mocked(api.setAiAgentsSettings).mockResolvedValue({
    ...multi.capabilities!.ai_agents!,
    settings: { ...multi.capabilities!.ai_agents!.settings, backend: 'other' },
  });
  await act(async () => root.render(<AiAgentsToggle agent={multi} onRefresh={refresh} />));
  const select = container.querySelector('select')!;
  expect(select).toBeTruthy();
  expect(select.style.maxWidth).toBe('200px');
  expect([...select.options].map((option) => option.textContent)).toEqual(['Automatic', 'Herdr 0.9.5', 'other 1.2']);
  await act(async () => {
    select.value = 'other';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(api.setAiAgentsSettings).toHaveBeenCalledWith('a1', { enabled: true, backend: 'other' });
  await act(async () => button('AI Agents').click());
  expect(api.setAiAgentsSettings).toHaveBeenLastCalledWith('a1', { enabled: false, backend: 'other' });
});

it('explains the experimental hc binary and explicit terminal opt-in', async () => {
  const hc = { ...agent, capabilities: { ...agent.capabilities, ai_agents: {
    ...agent.capabilities!.ai_agents!, backend: 'hc',
    settings: { ...agent.capabilities!.ai_agents!.settings, backend: 'hc' },
  } } } as api.AgentInfo;
  await act(async () => root.render(<AiAgentsSetup agent={hc} onRefresh={refresh} />));
  expect(container.textContent).toContain('hc (experimental)');
  expect(container.textContent).toContain('FILEBOX_AGENT_HC');
  expect(container.textContent).toContain('hc run --bg --label fb=1 -- claude');
  expect(container.querySelector('a')?.href).toBe('https://github.com/herdrdev/herdr-core#install');
  expect(container.textContent).not.toContain('herdr server');
});

it('selects hc using the existing persisted backend setting', async () => {
  const capability = { ...agent.capabilities!.ai_agents!, available: true, backend: 'herdr',
    backends: [{ kind: 'herdr', version: '0.9.5' }, { kind: 'hc', version: '0.1.17' }] };
  const multi = { ...agent, capabilities: { ...agent.capabilities, ai_agents: capability } } as api.AgentInfo;
  vi.mocked(api.setAiAgentsSettings).mockResolvedValue({ ...capability,
    settings: { ...capability.settings, backend: 'hc' } });
  await act(async () => root.render(<AiAgentsToggle agent={multi} onRefresh={refresh} />));
  const select = container.querySelector('select')!;
  expect([...select.options].map((option) => option.textContent)).toEqual([
    'Automatic', 'Herdr 0.9.5', 'hc (experimental) 0.1.17',
  ]);
  await act(async () => {
    select.value = 'hc';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(api.setAiAgentsSettings).toHaveBeenCalledWith('a1', { enabled: true, backend: 'hc' });
  await act(async () => button('AI Agents').click());
  expect(api.setAiAgentsSettings).toHaveBeenLastCalledWith('a1', { enabled: false, backend: 'hc' });
});

it('keeps an undetected backend option readable on desktop', async () => {
  await act(async () => root.render(<AiAgentsToggle agent={agentWithMissingBackend()} onRefresh={refresh} />));
  const select = container.querySelector('select')!;
  expect(select.style.maxWidth).toBe('200px');
  expect([...select.options].map((option) => option.textContent)).toEqual(['Automatic', 'Herdr 0.9.5', 'other (not detected)']);
});

it('places the backend selector below the hints on mobile', async () => {
  window.innerWidth = 390;
  await act(async () => root.render(<AiAgentsToggle agent={agentWithMissingBackend()} onRefresh={refresh} />));
  const select = container.querySelector('select')!;
  const toggle = button('AI Agents');
  const textColumn = container.querySelector('p')?.parentElement;
  expect(select.style.maxWidth).toBe('100%');
  expect([...select.options].at(-1)?.textContent).toBe('other (not detected)');
  expect(textColumn?.contains(select)).toBe(true);
  expect(toggle.parentElement?.contains(select)).toBe(false);
});

it('locks backend selection to FILEBOX_AGENT_AI_AGENTS_BACKEND', async () => {
  const locked = { ...agent, capabilities: { ...agent.capabilities, ai_agents: {
    available: true, backend: 'herdr', version: '0.9.5', backends: [{ kind: 'herdr', version: '0.9.5' }],
    settings: { enabled: true, environment_override: null, backend: 'herdr', backend_environment_override: 'herdr' },
  } } } as api.AgentInfo;
  await act(async () => root.render(<AiAgentsToggle agent={locked} onRefresh={refresh} />));
  expect(container.querySelector('select')?.disabled).toBe(true);
  expect(container.textContent).toContain('FILEBOX_AGENT_AI_AGENTS_BACKEND=herdr');
  expect(api.setAiAgentsSettings).not.toHaveBeenCalled();
});

it('uses the same switch geometry for Office preview and AI Agents in Agent Settings', async () => {
  const backend = { ...agent, roots: [], last_seen: 0, rtt_ms: null } as api.AgentInfo;
  await act(async () => root.render(<AgentSettings agent={backend} onRefresh={refresh} />));
  const office = button('Office preview');
  const aiAgents = button('AI Agents');
  expect(aiAgents.style.width).toBe(office.style.width);
  expect(aiAgents.style.height).toBe(office.style.height);
  expect(aiAgents.style.borderRadius).toBe(office.style.borderRadius);
  expect(aiAgents.querySelector('span')?.style.cssText).toBe(office.querySelector('span')?.style.cssText);
});
