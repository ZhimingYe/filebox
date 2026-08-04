type Waiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

const waiters = new Map<string, Set<Waiter>>();

export function notifyAgentConnected(agentId: string) {
  const pending = waiters.get(agentId);
  if (!pending) return;
  for (const waiter of pending) {
    waiter.resolve();
  }
  waiters.delete(agentId);
}

export function waitForAgentOnline(
  agentId: string,
  signal?: AbortSignal,
  timeoutMs = 90_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const waiter: Waiter = {
      resolve: () => finish(resolve),
      reject: (error) => finish(() => reject(error)),
    };

    let bucket = waiters.get(agentId);
    if (!bucket) {
      bucket = new Set();
      waiters.set(agentId, bucket);
    }
    bucket.add(waiter);

    const timer = window.setTimeout(() => {
      waiter.reject(new Error('Timed out waiting for agent to reconnect'));
    }, timeoutMs);

    const onAbort = () => {
      waiter.reject(new DOMException('Aborted', 'AbortError'));
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const current = waiters.get(agentId);
      current?.delete(waiter);
      if (current?.size === 0) {
        waiters.delete(agentId);
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
