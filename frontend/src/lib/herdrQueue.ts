// Herdr permits two commands per backend. Keep this view's work bounded and
// let a second window/status request proceed during a prompt's long wait.
export class HerdrQueue {
  private active = 0;
  private pending: { priority: number; start: () => void }[] = [];

  run<T>(task: () => Promise<T>, signal: AbortSignal, priority = 0): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      if (this.pending.length >= 8) { reject({ error: 'agent_busy' }); return; }
      const remove = () => { this.pending = this.pending.filter((item) => item !== entry); };
      const abort = () => { remove(); cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
      const timer = setTimeout(() => {
        remove(); cleanup(); reject({ error: 'request_timeout' });
      }, 10_000);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const entry = { priority, start: () => {
        cleanup();
        this.active++;
        void Promise.resolve().then(task).then(resolve, reject).finally(() => {
          this.active--;
          this.drain();
        });
      } };
      signal.addEventListener('abort', abort, { once: true });
      this.pending.push(entry);
      this.pending.sort((a, b) => b.priority - a.priority);
      this.drain();
    });
  }

  private drain() {
    while (this.active < 2 && this.pending.length) this.pending.shift()!.start();
  }
}
