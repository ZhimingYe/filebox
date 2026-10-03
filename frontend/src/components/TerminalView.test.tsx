import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { TerminalView } from './TerminalView';

vi.mock('../api/client', async (original) => ({
  ...await original<typeof api>(),
  terminalTicket: vi.fn(),
  listTerminals: vi.fn(),
  killTerminalSession: vi.fn(),
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
    expect(api.terminalTicket).toHaveBeenCalledWith(agent.id, expect.any(AbortSignal));
    expect(container.textContent).toContain('Live terminal');
    await click('Live terminal');
    expect(container.querySelector('input')?.value).toBe('');
    expect(api.terminalTicket).toHaveBeenCalledTimes(1);
  });
  it('ignores a ticket response after cancellation', async () => {
    let resolve!: (value: { ticket: string; expires_in_sec: number }) => void;
    vi.mocked(api.terminalTicket).mockReturnValue(new Promise(r => { resolve = r; }));
    await render(); await enterCode(); await click('Open terminal');
    const signal = vi.mocked(api.terminalTicket).mock.calls[0][1]!;
    await click('Cancel');
    expect(signal.aborted).toBe(true);
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

describe('Terminal session recovery', () => {
  const session = { req_id: 'term_session-1234', age_secs: 60, idle_secs: 30, cols: 80, rows: 24 };
  const panel = async () => {
    const button = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    await act(async () => button.click());
  };
  it('aborts a cancelled refresh and ignores its late response', async () => {
    let resolve!: (value: { sessions: api.TerminalSessionInfo[] }) => void;
    vi.mocked(api.listTerminals).mockReturnValue(new Promise(r => { resolve = r; }));
    await render(); await panel();
    const signal = vi.mocked(api.listTerminals).mock.calls[0][1]!;
    await click('Cancel refresh');
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve({ sessions: [session] }); });
    expect(container.textContent).toContain('refresh cancelled');
    expect(container.textContent).not.toContain('session-1234');
    vi.mocked(api.listTerminals).mockResolvedValue({ sessions: [] });
    await click('Retry');
    expect(container.textContent).toContain('No active sessions');
  });
  it('does not resurrect an ended shell with an older refresh result', async () => {
    vi.mocked(api.listTerminals).mockResolvedValueOnce({ sessions: [session] });
    await render(); await panel();
    let resolve!: (value: { sessions: api.TerminalSessionInfo[] }) => void;
    vi.mocked(api.listTerminals).mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValue({ sessions: [] });
    await click('Refresh');
    const signal = vi.mocked(api.listTerminals).mock.calls[1][1]!;
    await click('End'); await click('Confirm end?');
    expect(signal.aborted).toBe(true);
    expect(api.killTerminalSession).toHaveBeenCalledWith(agent.id, session.req_id, expect.any(AbortSignal));
    expect(container.textContent).toContain('No active sessions');
    await act(async () => { resolve({ sessions: [session] }); });
    expect(container.textContent).not.toContain('session-1234');
  });
  it('shows a slow listing and permits cancellation', async () => {
    vi.useFakeTimers();
    vi.mocked(api.listTerminals).mockReturnValue(new Promise(() => {}));
    await render(); await panel();
    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(container.textContent).toContain('Still waiting');
    await click('Cancel refresh');
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(container.textContent).not.toContain('Still waiting');
    expect(container.textContent).toContain('refresh cancelled');
  });
  it('aborts management and ticket requests on unmount', async () => {
    vi.mocked(api.listTerminals).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.killTerminalSession).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.terminalTicket).mockReturnValue(new Promise(() => {}));
    await render(); await panel(); await click('End'); await click('Confirm end?');
    await enterCode(); await click('Open terminal');
    const killSignal = vi.mocked(api.killTerminalSession).mock.calls[0][2]!;
    const ticketSignal = vi.mocked(api.terminalTicket).mock.calls[0][1]!;
    await act(async () => root.render(null));
    expect(killSignal.aborted).toBe(true);
    expect(ticketSignal.aborted).toBe(true);
  });
  it('reports an unconfirmed End without pretending the shell was stopped', async () => {
    vi.mocked(api.listTerminals).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.killTerminalSession).mockRejectedValue({ error: 'request_stalled' });
    await render(); await panel(); await click('End'); await click('Confirm end?');
    expect(container.textContent).toContain('Ending this session was not confirmed');
    expect(container.textContent).toContain('Refresh Sessions');
    expect(container.textContent).toContain('session-1234');
  });
});
