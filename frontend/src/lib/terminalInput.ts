/** Bounded UTF-8 input, paced by acknowledgements of actual PTY writes. */
export const TERMINAL_INPUT_CHUNK_BYTES = 16 * 1024;
export const TERMINAL_INPUT_QUEUE_BYTES = 2 * 1024 * 1024;
export const TERMINAL_INPUT_STALL_MS = 15_000;

export class TerminalInputQueue {
  private chunks: { bytes: Uint8Array; used: number }[] = [];
  private remaining = 0;
  private sequence = 0;
  private awaiting: { seq: number; bytes: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private showingProgress = false;

  private callbacks: {
    send: (bytes: Uint8Array, seq: number) => void;
    progress: (remaining: number) => void;
    fail: () => void;
  };

  constructor(callbacks: TerminalInputQueue['callbacks']) { this.callbacks = callbacks; }

  enqueue(text: string): boolean {
    if (this.disposed) return false;
    // Reject the whole input before sending any of it; avoid encoding an
    // arbitrarily large paste just to discover that it exceeds the budget.
    if (text.length > TERMINAL_INPUT_QUEUE_BYTES - this.remaining) return false;
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > TERMINAL_INPUT_QUEUE_BYTES - this.remaining) return false;
    for (let offset = 0; offset < bytes.length;) {
      let tail = this.chunks[this.chunks.length - 1];
      if (!tail || tail.used === TERMINAL_INPUT_CHUNK_BYTES) {
        tail = { bytes: new Uint8Array(TERMINAL_INPUT_CHUNK_BYTES), used: 0 };
        this.chunks.push(tail);
      }
      const length = Math.min(bytes.length - offset, TERMINAL_INPUT_CHUNK_BYTES - tail.used);
      tail.bytes.set(bytes.subarray(offset, offset + length), tail.used);
      tail.used += length;
      offset += length;
    }
    this.remaining += bytes.length;
    if (this.remaining > TERMINAL_INPUT_CHUNK_BYTES) this.showingProgress = true;
    if (this.showingProgress) this.callbacks.progress(this.remaining);
    this.pump();
    return true;
  }

  acknowledge(seq: number): void {
    if (this.disposed || this.awaiting?.seq !== seq) return;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.slowTimer !== null) clearTimeout(this.slowTimer);
    this.timer = null;
    this.slowTimer = null;
    this.remaining -= this.awaiting.bytes;
    this.awaiting = null;
    if (this.showingProgress) this.callbacks.progress(this.remaining);
    if (this.remaining === 0) this.showingProgress = false;
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.slowTimer !== null) clearTimeout(this.slowTimer);
    this.timer = null;
    this.slowTimer = null;
    this.chunks = [];
    this.awaiting = null;
    this.remaining = 0;
  }

  private pump(): void {
    if (this.disposed || this.awaiting || !this.chunks.length) return;
    const chunk = this.chunks.shift()!;
    const seq = ++this.sequence;
    this.awaiting = { seq, bytes: chunk.used };
    this.slowTimer = setTimeout(() => {
      this.showingProgress = true;
      this.callbacks.progress(this.remaining);
    }, 8000);
    this.timer = setTimeout(() => {
      this.dispose();
      this.callbacks.fail();
    }, TERMINAL_INPUT_STALL_MS);
    try { this.callbacks.send(chunk.bytes.subarray(0, chunk.used), seq); }
    catch { this.dispose(); this.callbacks.fail(); }
  }
}
