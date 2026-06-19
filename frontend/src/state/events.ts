import { useEffect, useRef, useCallback } from 'react';

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

type Listener = (event: SseEvent) => void;

class SseManager {
  private source: EventSource | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    if (!this.source) {
      this.connect();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.disconnect();
      }
    };
  }

  private connect() {
    if (this.source) return;

    const es = new EventSource('/api/events');
    this.source = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const evt: SseEvent = { event: e.type || 'message', data };
        for (const listener of this.listeners) {
          listener(evt);
        }
      } catch {
        // ignore parse errors
      }
    };

    es.addEventListener('agent_connected', (e) => {
      this.dispatch('agent_connected', e.data);
    });
    es.addEventListener('agent_disconnected', (e) => {
      this.dispatch('agent_disconnected', e.data);
    });
    es.addEventListener('resources_updated', (e) => {
      this.dispatch('resources_updated', e.data);
    });
    es.addEventListener('progress', (e) => {
      this.dispatch('progress', e.data);
    });
    es.addEventListener('sync_required', (e) => {
      this.dispatch('sync_required', e.data);
    });

    es.onerror = () => {
      es.close();
      this.source = null;
      // Reconnect after 3 seconds
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    };
  }

  private dispatch(event: string, rawData: string) {
    try {
      const data = JSON.parse(rawData);
      const evt: SseEvent = { event, data };
      for (const listener of this.listeners) {
        listener(evt);
      }
    } catch {
      // ignore
    }
  }

  private disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }
}

const manager = new SseManager();

export function useSse(listener: Listener, enabled = true) {
  const ref = useRef(listener);
  ref.current = listener;

  const stableListener = useCallback((event: SseEvent) => {
    ref.current(event);
  }, []);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    return manager.subscribe(stableListener);
  }, [enabled, stableListener]);
}
