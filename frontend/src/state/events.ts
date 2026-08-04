import { useEffect, useRef, useCallback } from 'react';
import { eventsAccessUrl } from '../api/client';
import { notifyAgentConnected } from './agentReconnect';

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

type Listener = (event: SseEvent) => void;

/** Remint a bit before the Hub's 30m events token TTL so SSE never 403s mid-tab. */
const EVENTS_TOKEN_REFRESH_MARGIN_MS = 60_000;
const EVENTS_TOKEN_REUSE_FAILURES = 2;

class SseManager {
  private source: EventSource | null = null;
  private connectPromise: Promise<void> | null = null;
  private access: { url: string; expiresAt: number } | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private connectGeneration = 0;
  private reconnectAttempt = 0;

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    if (!this.source) {
      void this.ensureConnected();
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
    const base = Math.min(30_000, 1_000 * (2 ** Math.min(this.reconnectAttempt, 5)));
    const delay = base + Math.floor(Math.random() * Math.max(1, base / 2));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      void this.ensureConnected();
    }, delay);
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
      this.access = null;
      void this.ensureConnected();
    }, delayMs);
  }

  private async ensureConnected() {
    if (this.source || this.connectPromise) return;
    const pending = this.connect();
    this.connectPromise = pending;
    try {
      await pending;
    } finally {
      if (this.connectPromise === pending) this.connectPromise = null;
    }
  }

  private async connect() {
    if (this.source || this.listeners.size === 0) return;
    this.clearReconnectTimer();
    this.clearRefreshTimer();

    const generation = ++this.connectGeneration;
    let url: string;
    let expiresInSec: number;
    const now = Date.now();
    if (this.access && this.access.expiresAt - now > EVENTS_TOKEN_REFRESH_MARGIN_MS) {
      url = this.access.url;
      expiresInSec = Math.max(1, Math.floor((this.access.expiresAt - now) / 1000));
    } else {
      try {
        // EventSource cannot set X-CSRF-Token; mint one bearer and reuse it
        // across transient network reconnects until it nears expiry.
        const minted = await eventsAccessUrl();
        url = minted.url;
        expiresInSec = minted.expiresInSec;
        this.access = {
          url,
          expiresAt: Date.now() + expiresInSec * 1000,
        };
      } catch {
        // Same generation/listener gates as the success path — otherwise a mint
        // that fails after logout / last-subscriber-gone keeps hammering forever.
        this.scheduleReconnect(generation);
        return;
      }
    }
    if (generation !== this.connectGeneration || this.listeners.size === 0) {
      return;
    }

    const es = new EventSource(url);
    this.source = es;
    this.scheduleProactiveRefresh(generation, expiresInSec);
    es.onopen = () => {
      if (generation === this.connectGeneration) this.reconnectAttempt = 0;
    };

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
      if (this.source === es) this.source = null;
      this.clearRefreshTimer();
      // A network error does not invalidate the bearer. Reuse it with bounded
      // exponential backoff first. After repeated failures, remint so a Hub
      // restart (which clears in-memory tokens) cannot strand SSE until TTL.
      if (this.reconnectAttempt >= EVENTS_TOKEN_REUSE_FAILURES) {
        this.access = null;
      }
      this.scheduleReconnect(generation);
    };
  }

  private dispatch(event: string, rawData: string) {
    try {
      const data = JSON.parse(rawData);
      if (event === 'agent_connected' && typeof data.agent_id === 'string') {
        notifyAgentConnected(data.agent_id);
      }
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
    this.access = null;
    this.connectPromise = null;
    this.reconnectAttempt = 0;
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
