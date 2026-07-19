import { useEffect, useRef, useCallback } from 'react';
import { eventsAccessUrl } from '../api/client';

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

type Listener = (event: SseEvent) => void;

/** Remint a bit before the Hub's 30m events token TTL so SSE never 403s mid-tab. */
const EVENTS_TOKEN_REFRESH_MARGIN_MS = 60_000;

class SseManager {
  private source: EventSource | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private connectGeneration = 0;

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    if (!this.source) {
      void this.connect();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.disconnect();
      }
    };
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearRefreshTimer() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private scheduleReconnect(generation: number) {
    if (generation !== this.connectGeneration || this.listeners.size === 0) {
      return;
    }
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, 3000);
  }

  /** Close and remint before the access token expires (Hub default 30m). */
  private scheduleProactiveRefresh(generation: number, expiresInSec: number) {
    this.clearRefreshTimer();
    const delayMs = Math.max(
      5_000,
      expiresInSec * 1000 - EVENTS_TOKEN_REFRESH_MARGIN_MS,
    );
    this.refreshTimer = setTimeout(() => {
      if (generation !== this.connectGeneration || this.listeners.size === 0) {
        return;
      }
      if (this.source) {
        this.source.close();
        this.source = null;
      }
      void this.connect();
    }, delayMs);
  }

  private async connect() {
    if (this.source) return;
    this.clearReconnectTimer();
    this.clearRefreshTimer();

    const generation = ++this.connectGeneration;
    let url: string;
    let expiresInSec: number;
    try {
      // EventSource cannot set X-CSRF-Token; mint a short-lived GET bearer.
      const minted = await eventsAccessUrl();
      url = minted.url;
      expiresInSec = minted.expiresInSec;
    } catch {
      // Same generation/listener gates as the success path — otherwise a mint
      // that fails after logout / last-subscriber-gone keeps hammering forever.
      this.scheduleReconnect(generation);
      return;
    }
    if (generation !== this.connectGeneration || this.listeners.size === 0) {
      return;
    }

    const es = new EventSource(url);
    this.source = es;
    this.scheduleProactiveRefresh(generation, expiresInSec);

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
    es.addEventListener('collections_updated', (e) => {
      this.dispatch('collections_updated', e.data);
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
      this.clearRefreshTimer();
      // Remint access token on reconnect (old one may be expired).
      this.scheduleReconnect(generation);
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
    this.connectGeneration += 1;
    this.clearReconnectTimer();
    this.clearRefreshTimer();
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
