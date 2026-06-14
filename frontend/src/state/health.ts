import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../api/client';

export function useHealth(enabled: boolean, intervalMs = 5000) {
  const [health, setHealth] = useState<api.HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getHealth();
      setHealth(data);
      setError(null);
    } catch (e: any) {
      setError(e.message || 'Failed to fetch health');
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Clear any existing interval when disabled
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Immediate fetch when enabled
    refresh();

    // Start polling
    intervalRef.current = setInterval(refresh, intervalMs);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, refresh, intervalMs]);

  return { health, error, refresh };
}
