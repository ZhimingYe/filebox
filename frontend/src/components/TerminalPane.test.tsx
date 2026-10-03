import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalPane } from './TerminalPane';
import type { AgentInfo } from '../api/client';

const mocks = vi.hoisted(() => ({
  mobile: false, created: vi.fn(), dispose: vi.fn(),
  data: undefined as ((data: string) => void) | undefined,
  writes: [] as { data: string | Uint8Array; callback?: () => void }[],
  writeError: false,
}));
vi.mock('../state/useIsMobile', () => ({ useIsMobile: () => mocks.mobile }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; modes = {};
  parser = { registerOscHandler: vi.fn() };
  constructor() { mocks.created(); }
  loadAddon() {} open() {} focus() {}
  write(data: string | Uint8Array, callback?: () => void) {
    if (mocks.writeError) throw new Error('write data discarded');
    mocks.writes.push({ data, callback });
  }
  onData(handler: (data: string) => void) { mocks.data = handler; return { dispose() {} }; }
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
const pane = (sessionId?: string) => <StrictMode><TerminalPane agent={agent} ticket="ticket" agentCode="123456" sessionId={sessionId} onReconnect={reconnect} onSessionOpened={opened} /></StrictMode>;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.mobile = false; Socket.sockets = [];
  mocks.data = undefined; mocks.writes = []; mocks.writeError = false;
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
  await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: 'opened', input_ack: true, session_id: 'shell' }) }));
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
  await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: 'opened', input_ack: true, session_id: 'shell' }) }));
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
  await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: 'opened', input_ack: true, session_id: 'shell' }) }));
  expect(container.textContent).toContain('Connection lost');
});

async function resume(replayBytes: number | null = 0) {
  await act(async () => { root.render(pane('shell')); });
  await act(async () => { vi.advanceTimersByTime(1); });
  const socket = Socket.sockets[0]; socket.readyState = Socket.OPEN;
  await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: 'opened', input_ack: true, session_id: 'shell', replay_bytes: replayBytes }) }));
  return socket;
}
async function output(socket: Socket, text: string) {
  await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: 'output', data: btoa(text) }) }));
}
function inputs(socket: Socket) {
  return socket.send.mock.calls.map(([frame]) => JSON.parse(frame)).filter(frame => frame.type === 'input');
}
it('suppresses replay replies until all chunks are parsed, then forwards live replies and keys', async () => {
  const first = '\x1b[c\x1b]10;?\x07';
  const last = '\x1b]4;0;?;1;?\x07';
  const socket = await resume(first.length + last.length);
  expect(container.textContent).toContain('Restoring terminal history');
  await output(socket, first);
  await act(async () => { mocks.data?.('\x1b[?1;2c\x1b]10;rgb:ffff/ffff/ffff\x1b\\'); });
  await output(socket, last);
  // Receiving the last frame is insufficient: xterm has not parsed it yet.
  await act(async () => { mocks.data?.('\x1b]4;0;rgb:0000/0000/0000\x1b\\'); });
  expect(inputs(socket)).toEqual([]);
  expect(container.textContent).toContain('Restoring terminal history');
  await act(async () => { mocks.writes[1].callback?.(); });
  expect(container.querySelector('[role="status"]')).toBeNull();
  const liveReply = '\x1b]4;1;rgb:ffff/0000/0000\x1b\\';
  await act(async () => { mocks.data?.(liveReply); mocks.data?.('ls\r'); });
  await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: 'input_ack', seq: 1 }) }));
  expect(inputs(socket).map(frame => atob(frame.data))).toEqual([liveReply, 'ls\r']);
});
it('separates replay and live bytes sharing an output frame', async () => {
  const socket = await resume(3);
  await output(socket, 'oldnew');
  expect(mocks.writes.map(write => new TextDecoder().decode(write.data as Uint8Array))).toEqual(['old', 'new']);
  expect(mocks.writes[0].callback).toBeTypeOf('function');
  expect(mocks.writes[1].callback).toBeTypeOf('function');
  await act(async () => { mocks.writes[1].callback?.(); mocks.data?.('ls\r'); });
  expect(inputs(socket)).toEqual([]);
});
it.each(['disconnect', 'unmount'] as const)('ignores a replay callback after %s', async (kind) => {
  const socket = await resume(3);
  await output(socket, 'old');
  const callback = mocks.writes[0].callback!;
  await act(async () => {
    if (kind === 'disconnect') socket.onclose?.();
    else root.render(null);
  });
  await act(async () => {
    callback();
    mocks.data?.('ls\r');
  });
  expect(inputs(socket)).toEqual([]);
  expect(socket.send.mock.calls.map(([frame]) => JSON.parse(frame)).filter(frame => frame.type === 'resize')).toEqual([]);
  if (kind === 'disconnect') expect(container.textContent).toContain('Disconnected');
});
it('bounds an incomplete replay and offers retry without accepting input', async () => {
  const socket = await resume(4);
  await output(socket, 'old');
  await act(async () => { mocks.writes[0].callback?.(); });
  await act(async () => { vi.advanceTimersByTime(35_000); mocks.data?.('ls\r'); });
  expect(container.textContent).toContain('Connection timed out');
  expect(inputs(socket)).toEqual([]);
  expect(socket.close).toHaveBeenCalled();
});
it.each([null, -1, 0.5, 256 * 1024 + 1])('rejects unsafe resume metadata %s while preserving the shell', async (replayBytes) => {
  const socket = await resume(replayBytes);
  expect(container.textContent).toContain('Update the hub and backend');
  expect(socket.close).toHaveBeenCalled();
  expect(inputs(socket)).toEqual([]);
});
it('allows a resume with empty history immediately', async () => {
  const socket = await resume();
  expect(container.querySelector('[role="status"]')).toBeNull();
  await act(async () => { mocks.data?.('ls\r'); });
  expect(inputs(socket).map(frame => atob(frame.data))).toEqual(['ls\r']);
});
it('gates real xterm query replies across asynchronously parsed replay and live output', async () => {
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  const { Terminal: RealTerminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm');
  const real = new RealTerminal();
  const host = document.createElement('div');
  document.body.append(host);
  real.open(host);
  const replies: string[] = [];
  real.onData(data => { replies.push(data); mocks.data?.(data); });
  try {
    // Exercise the actual color/device/cursor parser, including an OSC
    // palette query matching the reported bug. Split it across replay chunks.
    const history = '\x1b]4;0;?;1;?\x07\x1b]10;?\x07\x1b[c\x1b[6n';
    const socket = await resume(history.length);
    await output(socket, history.slice(0, 2));
    await output(socket, history.slice(2));
    await output(socket, '\x1b]4;0;?\x07'); // Live IO arrives before replay parsing ends.
    for (const write of mocks.writes.splice(0)) {
      await act(async () => {
        real.write(write.data, write.callback);
        await vi.advanceTimersByTimeAsync(1);
      });
    }
    expect(replies.length).toBe(6);
    expect(replies[0]).toContain('rgb:');
    expect(inputs(socket).map(frame => atob(frame.data))).toEqual([replies[5]]);
  } finally { real.dispose(); host.remove(); canvas.mockRestore(); }
});

it('bounds unparsed output, reports overload, and ignores callbacks after detaching', async () => {
  const socket = await resume();
  const chunk = 'x'.repeat(16384);
  for (let i = 0; i < 64; i++) await output(socket, chunk);
  expect(socket.close).not.toHaveBeenCalled();
  await output(socket, chunk);
  expect(container.textContent).toContain('output is arriving faster');
  expect(container.textContent).toContain('shell is still running');
  expect(socket.close).toHaveBeenCalledTimes(1);
  await act(async () => { mocks.writes.forEach(write => write.callback?.()); mocks.data?.('ls\r'); });
  expect(inputs(socket)).toEqual([]);
});
it('releases output credit on parser completion', async () => {
  const socket = await resume();
  const chunk = 'x'.repeat(16384);
  for (let i = 0; i < 80; i++) {
    await output(socket, chunk);
    await act(async () => { mocks.writes.at(-1)?.callback?.(); });
  }
  expect(socket.close).not.toHaveBeenCalled();
});
it.each(['parser', 'base64'] as const)('surfaces %s failure rather than silently discarding output', async (kind) => {
  const socket = await resume();
  if (kind === 'parser') mocks.writeError = true;
  await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: 'output', data: kind === 'parser' ? btoa('hello') : '!!!' }) }));
  expect(container.textContent).toContain('output could not be displayed');
  expect(socket.close).toHaveBeenCalledTimes(1);
});
it('sends a large paste in acknowledged wire-safe frames, with visible progress', async () => {
  const socket = await resume();
  const text = 'a'.repeat(50000) + '汉字🙂'.repeat(1000);
  await act(async () => { mocks.data?.(text); });
  expect(inputs(socket)).toHaveLength(1);
  expect(container.textContent).toContain('Sending input');
  for (let i = 0; i < inputs(socket).length; i++) {
    const frame = inputs(socket)[i];
    expect(new TextEncoder().encode(JSON.stringify(frame)).length).toBeLessThan(65536);
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: 'input_ack', seq: frame.seq }) }));
  }
  const binary = inputs(socket).map(frame => atob(frame.data)).join('');
  expect(new TextDecoder().decode(Uint8Array.from(binary, ch => ch.charCodeAt(0)))).toBe(text);
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(socket.close).not.toHaveBeenCalled();
});
it('cancels pending input without sending the remainder or killing the shell', async () => {
  const socket = await resume();
  await act(async () => { mocks.data?.('x'.repeat(50000)); });
  const cancel = [...container.querySelectorAll('button')].find(button => button.textContent === 'Cancel input')!;
  await act(async () => { cancel.click(); socket.onmessage?.({ data: JSON.stringify({ type: 'input_ack', seq: 1 }) }); });
  expect(inputs(socket)).toHaveLength(1);
  expect(container.textContent).toContain('Some input may have reached');
  expect(socket.close).toHaveBeenCalledTimes(1);
});
it('times out a stalled paste even while Hub heartbeats continue', async () => {
  const socket = await resume();
  await act(async () => { mocks.data?.('x'.repeat(50000)); });
  await act(async () => {
    vi.advanceTimersByTime(10000);
    socket.onmessage?.({ data: JSON.stringify({ type: 'ping', nonce: 'alive' }) });
    vi.advanceTimersByTime(5000);
  });
  expect(container.textContent).toContain('Input delivery stalled');
  expect(socket.close).toHaveBeenCalledTimes(1);
});
it('rejects an oversized paste before sending any input and permits a smaller retry', async () => {
  const socket = await resume();
  await act(async () => { mocks.data?.('x'.repeat(2 * 1024 * 1024 + 1)); });
  expect(inputs(socket)).toEqual([]);
  expect(container.textContent).toContain('This input was not sent');
  await act(async () => { mocks.data?.('a'); });
  expect(inputs(socket).map(frame => atob(frame.data))).toEqual(['a']);
  expect(socket.close).not.toHaveBeenCalled();
});
it('requires input-ack support before exposing the shell', async () => {
  await act(async () => { root.render(pane()); });
  await act(async () => { vi.advanceTimersByTime(1); });
  const socket = Socket.sockets[0]; socket.readyState = Socket.OPEN;
  await act(async () => {
    socket.onmessage?.({ data: JSON.stringify({ type: 'opened', replay_bytes: 0 }) });
    mocks.data?.('a');
  });
  expect(container.textContent).toContain('Update the hub and backend');
  expect(inputs(socket)).toEqual([]);
});

it('detects a stalled parser even for small output while Hub heartbeats continue', async () => {
  const socket = await resume();
  await output(socket, 'small but stuck');
  await act(async () => { vi.advanceTimersByTime(8000); });
  expect(container.textContent).toContain('taking longer to display');
  expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Disconnect')).toBe(true);
  await act(async () => {
    vi.advanceTimersByTime(7000);
    socket.onmessage?.({ data: JSON.stringify({ type: 'ping', nonce: 'healthy' }) });
    vi.advanceTimersByTime(15000);
  });
  expect(container.textContent).toContain('output display stalled');
  expect(socket.close).toHaveBeenCalledTimes(1);
  await act(async () => { mocks.writes[0].callback?.(); mocks.data?.('must-not-send'); });
  expect(inputs(socket)).toEqual([]);
});
it('resets the display stall deadline only on parser progress and clears it when drained', async () => {
  const socket = await resume();
  await output(socket, 'first'); await output(socket, 'second');
  await act(async () => { vi.advanceTimersByTime(29000); mocks.writes[0].callback?.(); });
  expect(container.textContent).not.toContain('taking longer');
  await act(async () => { vi.advanceTimersByTime(29000); });
  expect(socket.close).not.toHaveBeenCalled();
  await act(async () => {
    mocks.writes[1].callback?.();
    socket.onmessage?.({ data: JSON.stringify({ type: 'ping', nonce: 'alive' }) });
    vi.advanceTimersByTime(40000);
  });
  expect(socket.close).not.toHaveBeenCalled();
  expect(container.querySelector('[role="status"]')).toBeNull();
});
it('allows cancelling a slow parser without closing the shell or accepting more input', async () => {
  const socket = await resume();
  await output(socket, 'stuck');
  await act(async () => { vi.advanceTimersByTime(8000); });
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Disconnect')!;
  await act(async () => { button.click(); mocks.writes[0].callback?.(); mocks.data?.('late'); });
  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('shell is still running');
  expect(inputs(socket)).toEqual([]);
  await act(async () => { vi.advanceTimersByTime(90000); });
  expect(container.textContent).not.toContain('display stalled');
});
it.each(['resize', 'pong'] as const)('reports a %s send failure without an uncaught exception', async (kind) => {
  if (kind === 'resize') {
    await act(async () => { root.render(pane()); });
    await act(async () => { vi.advanceTimersByTime(1); });
  } else await resume();
  const socket = Socket.sockets[0]; socket.readyState = Socket.OPEN;
  socket.send.mockImplementation(() => { throw new Error('send buffer full'); });
  await act(async () => socket.onmessage?.({ data: JSON.stringify(kind === 'resize'
    ? { type: 'opened', input_ack: true, replay_bytes: 0 }
    : { type: 'ping', nonce: 'probe' }) }));
  expect(container.textContent).toContain('Connection lost while sending');
  expect(socket.close).toHaveBeenCalledTimes(1);
});
