import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../api/client';

export function useHealth(enabled: boolean, intervalMs = 5000) {
  const [health, setHealth] = useState<api.HealthResponse | null>(null);
  const [agents, setAgents] = useState<api.AgentInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [healthData, agentData] = await Promise.all([
        api.getHealth(),
        api.getAgents(),
      ]);
      setHealth(healthData);
      setAgents(agentData);
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
      setAgents([]);
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

  return { health, agents, error, refresh };
}
