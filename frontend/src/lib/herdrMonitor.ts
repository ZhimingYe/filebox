interface Check {
  controller: AbortController | null;
  due: number;
}

/** Reconcile only changed backends; unrelated checks and their cadence survive. */
export function createHerdrMonitor(check: (id: string, signal: AbortSignal) => Promise<void>) {
  const checks = new Map<string, Check>();
  let active = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pump = () => {
    clearTimeout(timer);
    if (stopped) return;
    // Oldest due first: insertion order can starve later backends when a
    // large cohort takes longer than one refresh interval to drain.
    const ready = [...checks.entries()].filter(([, entry]) => !entry.controller && entry.due <= Date.now())
      .sort((a, b) => a[1].due - b[1].due);
    for (const [id, entry] of ready) {
      if (active >= 2) break;
      const controller = new AbortController();
      entry.controller = controller;
      active++;
      void check(id, controller.signal).finally(() => {
        active--;
        entry.controller = null;
        entry.due = Date.now() + 30_000;
        pump();
      });
    }
    if (active < 2) {
      const due = Math.min(...[...checks.values()].filter((entry) => !entry.controller).map((entry) => entry.due));
      if (Number.isFinite(due)) timer = setTimeout(pump, Math.max(0, due - Date.now()));
    }
  };

  return {
    sync(ids: string[]) {
      const keep = new Set(ids);
      for (const [id, entry] of checks) if (!keep.has(id)) {
        checks.delete(id);
        entry.controller?.abort();
      }
      for (const id of ids) if (!checks.has(id)) checks.set(id, { controller: null, due: 0 });
      pump();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      for (const entry of checks.values()) entry.controller?.abort();
      checks.clear();
    },
  };
}
