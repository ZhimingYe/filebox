import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalPane } from './TerminalPane';
import type { AgentInfo } from '../api/client';

const mocks = vi.hoisted(() => ({ mobile: false, created: vi.fn(), dispose: vi.fn() }));
vi.mock('../state/useIsMobile', () => ({ useIsMobile: () => mocks.mobile }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; modes = {};
  parser = { registerOscHandler: vi.fn() };
  constructor() { mocks.created(); }
  loadAddon() {} open() {} focus() {} write() {}
  onData() { return { dispose() {} }; }
  dispose() { mocks.dispose(); }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
class Socket {
  static OPEN = 1; static CONNECTING = 0; static sockets: Socket[] = [];
  readyState = 0;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  send = vi.fn(); close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
  constructor() { Socket.sockets.push(this); }
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const agent = { id: 'agent', name: 'Agent' } as AgentInfo;
const reconnect = vi.fn();
const opened = vi.fn();
const pane = () => <StrictMode><TerminalPane agent={agent} ticket="ticket" agentCode="123456" onReconnect={reconnect} onSessionOpened={opened} /></StrictMode>;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.mobile = false; Socket.sockets = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('spends one ticket under StrictMode, waits for Agent and keeps xterm on breakpoint changes', async () => {
  await act(async () => { root.render(pane()); });
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(Socket.sockets).toHaveLength(1);
  expect(container.textContent).toContain('Connecting');
  const socket = Socket.sockets[0]; socket.readyState = Socket.OPEN;
  await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: 'opened', session_id: 'shell' }) }));
  expect(opened).toHaveBeenCalledWith('shell');
  const creations = mocks.created.mock.calls.length;
  mocks.mobile = true;
  await act(async () => root.render(pane()));
  expect(mocks.created).toHaveBeenCalledTimes(creations);
  expect(Socket.sockets).toHaveLength(1);
  await act(async () => socket.onclose?.());
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Enter new backend code')!;
  await act(async () => button.click());
  expect(reconnect).toHaveBeenCalledTimes(1);
  expect(Socket.sockets).toHaveLength(1);
});
it('bounds a stalled handshake and offers retry', async () => {
  await act(async () => root.render(pane()));
  await act(async () => { vi.advanceTimersByTime(8001); });
  expect(container.textContent).toContain('Still waiting');
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(container.textContent).toContain('Connection timed out');
  expect(Socket.sockets[0].close).toHaveBeenCalled();
});

it.each(['error', 'closed', 'disconnect'] as const)('preserves %s state after both connection timers elapse', async (kind) => {
  await act(async () => root.render(pane()));
  await act(async () => { vi.advanceTimersByTime(1); });
  const socket = Socket.sockets[0];
  await act(async () => {
    if (kind === 'error') socket.onmessage?.({ data: JSON.stringify({ type: 'error', error: 'agent_overloaded' }) });
    if (kind === 'closed') socket.onmessage?.({ data: JSON.stringify({ type: 'closed', reason: 'Shell exited' }) });
    socket.onclose?.();
  });
  const notice = container.querySelector('[role="status"]')?.textContent;
  expect(notice).toContain(kind === 'error' ? 'maximum number' : kind === 'closed' ? 'Shell exited' : 'Disconnected');
  await act(async () => { vi.advanceTimersByTime(90_000); });
  expect(container.querySelector('[role="status"]')?.textContent).toBe(notice);
});
it('answers heartbeats without keyboard input and detects a silent Hub', async () => {
  await act(async () => root.render(pane()));
  await act(async () => { vi.advanceTimersByTime(1); });
  const socket = Socket.sockets[0]; socket.readyState = Socket.OPEN;
  await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: 'opened', session_id: 'shell' }) }));
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      socket.onmessage?.({ data: JSON.stringify({ type: 'ping', nonce: `probe-${i}` }) });
    });
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'pong', nonce: `probe-${i}` }));
  }
  expect(socket.close).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(65_000); });
  expect(container.textContent).toContain('Connection lost');
  expect(socket.close).toHaveBeenCalledTimes(1);
  // Late data cannot revive a terminal after a liveness failure.
  await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: 'opened', session_id: 'shell' }) }));
  expect(container.textContent).toContain('Connection lost');
});
