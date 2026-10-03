import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalInputQueue, TERMINAL_INPUT_QUEUE_BYTES } from './terminalInput';
let queue: TerminalInputQueue;
let sent: { bytes: Uint8Array; seq: number }[];
const progress = vi.fn();
const fail = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); sent = [];
  queue = new TerminalInputQueue({ send: (bytes, seq) => sent.push({ bytes: bytes.slice(), seq }), progress, fail });
});
afterEach(() => { queue.dispose(); vi.useRealTimers(); });
it('delivers a large Unicode paste byte-for-byte with one write outstanding', () => {
  const text = 'a'.repeat(16383) + '汉字🙂'.repeat(10000);
  expect(queue.enqueue(text)).toBe(true);
  expect(sent).toHaveLength(1);
  queue.acknowledge(999); // Unrelated/duplicate acks cannot grant credit.
  expect(sent).toHaveLength(1);
  for (let i = 0; i < sent.length; i++) {
    expect(sent[i].bytes.length).toBeLessThanOrEqual(16384);
    expect(sent[i].seq).toBe(i + 1);
    queue.acknowledge(sent[i].seq);
    queue.acknowledge(sent[i].seq);
  }
  const bytes = new Uint8Array(sent.reduce((n, s) => n + s.bytes.length, 0));
  let offset = 0;
  for (const frame of sent) { bytes.set(frame.bytes, offset); offset += frame.bytes.length; }
  expect(new TextDecoder().decode(bytes)).toBe(text);
  expect(progress).toHaveBeenLastCalledWith(0);
});
it('coalesces queued keystrokes and query replies in their original order', () => {
  queue.enqueue('a'); queue.enqueue('b'); queue.enqueue('\x1b]4;0;rgb:0000/0000/0000\x1b\\');
  expect(sent).toHaveLength(1);
  queue.acknowledge(1);
  expect(new TextDecoder().decode(sent[1].bytes)).toBe('b\x1b]4;0;rgb:0000/0000/0000\x1b\\');
});
it('rejects oversized input atomically, including UTF-8 expansion and an already full queue', () => {
  expect(queue.enqueue('汉'.repeat(TERMINAL_INPUT_QUEUE_BYTES / 2))).toBe(false);
  expect(sent).toHaveLength(0);
  expect(queue.enqueue('x'.repeat(TERMINAL_INPUT_QUEUE_BYTES))).toBe(true);
  expect(queue.enqueue('a')).toBe(false);
  expect(sent).toHaveLength(1);
});
it('shows a slow write and times out on lack of PTY progress', () => {
  queue.enqueue('a');
  vi.advanceTimersByTime(8000);
  expect(progress).toHaveBeenLastCalledWith(1);
  queue.acknowledge(9); // Stale confirmation cannot reset the deadline.
  vi.advanceTimersByTime(7000);
  expect(fail).toHaveBeenCalledTimes(1);
  queue.acknowledge(1);
  expect(queue.enqueue('b')).toBe(false);
  expect(sent).toHaveLength(1);
});
it('resets the stall deadline only after the matching acknowledgement', () => {
  queue.enqueue('a'); queue.enqueue('b');
  vi.advanceTimersByTime(14000);
  queue.acknowledge(1);
  vi.advanceTimersByTime(14000);
  expect(fail).not.toHaveBeenCalled();
  queue.acknowledge(2);
  vi.advanceTimersByTime(90000);
  expect(fail).not.toHaveBeenCalled();
});
it('disposes unsent chunks and all timers on cancellation', () => {
  queue.enqueue('x'.repeat(50000)); queue.dispose();
  queue.acknowledge(1); vi.advanceTimersByTime(90000);
  expect(sent).toHaveLength(1);
  expect(fail).not.toHaveBeenCalled();
});
it('reports socket send failure and drops the unsent remainder', () => {
  queue.dispose();
  queue = new TerminalInputQueue({ send: () => { throw new Error('socket gone'); }, progress, fail });
  queue.enqueue('x'.repeat(50000));
  expect(fail).toHaveBeenCalledTimes(1);
  queue.acknowledge(1); vi.advanceTimersByTime(90000);
  expect(fail).toHaveBeenCalledTimes(1);
});
