import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { TerminalView } from './TerminalView';

vi.mock('../api/client', async (original) => ({
  ...await original<typeof api>(),
  terminalTicket: vi.fn(),
  listTerminals: vi.fn(),
}));
vi.mock('./TerminalPane', () => ({ TerminalPane: ({ onReconnect }: { onReconnect: () => void }) => <button onClick={() => onReconnect()}>Live terminal</button> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const agent = { id: 'agent-1', name: 'Research server', capabilities: { terminal_agent_2fa: true, terminal_persistent: true, terminal_manage: true } } as api.AgentInfo;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.terminalTicket).mockResolvedValue({ ticket: 'ticket', expires_in_sec: 60 });
  vi.mocked(api.listTerminals).mockResolvedValue({ sessions: [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});
async function render(backend = agent) {
  await act(async () => root.render(<TerminalView agent={backend} />));
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
async function enterCode() {
  const input = container.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '123456');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Agent-local terminal authorization', () => {
  it('shows local setup instructions without requesting a ticket for unconfigured agents', async () => {
    await render({ ...agent, capabilities: {} });
    expect(container.textContent).toContain('agent --setup-terminal-2fa');
    expect(container.querySelector('input')).toBeNull();
    expect(api.terminalTicket).not.toHaveBeenCalled();
  });
  it('requires explicit submission and another code after reconnect', async () => {
    await render();
    await enterCode();
    expect(api.terminalTicket).not.toHaveBeenCalled();
    await click('Open terminal');
    expect(api.terminalTicket).toHaveBeenCalledWith(agent.id);
    expect(container.textContent).toContain('Live terminal');
    await click('Live terminal');
    expect(container.querySelector('input')?.value).toBe('');
    expect(api.terminalTicket).toHaveBeenCalledTimes(1);
  });
  it('ignores a ticket response after cancellation', async () => {
    let resolve!: (value: { ticket: string; expires_in_sec: number }) => void;
    vi.mocked(api.terminalTicket).mockReturnValue(new Promise(r => { resolve = r; }));
    await render(); await enterCode(); await click('Open terminal');
    await click('Cancel');
    await act(async () => { resolve({ ticket: 'late', expires_in_sec: 60 }); });
    expect(container.textContent).not.toContain('Live terminal');
    expect(container.querySelector('input')?.value).toBe('');
  });
  it('reports ticket failures and permits retry', async () => {
    vi.mocked(api.terminalTicket).mockRejectedValue({ error: 'backend_offline' });
    await render(); await enterCode(); await click('Open terminal');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('input')?.disabled).toBe(false);
  });
});
