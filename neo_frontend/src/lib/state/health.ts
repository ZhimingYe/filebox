import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../api/client';
import { syncAgentOnlineStatus } from './agentReconnect';

export function useHealth(enabled: boolean, intervalMs = 5000) {
  const [health, setHealth] = useState<api.HealthResponse | null>(null);
  const [agents, setAgents] = useState<api.AgentInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const refreshGenerationRef = useRef(0);
  const prevAgentIdsRef = useRef<string>('');
  const prevHealthRef = useRef<string>('');

  const refresh = useCallback(async () => {
    if (refreshControllerRef.current) return;
    const controller = new AbortController();
    const generation = ++refreshGenerationRef.current;
    refreshControllerRef.current = controller;
    try {
      const [healthData, agentData] = await Promise.all([
        api.getHealth(controller.signal),
        api.getAgents(controller.signal),
      ]);
      if (generation !== refreshGenerationRef.current || controller.signal.aborted) return;
      // Only update state if data actually changed to prevent unnecessary re-renders
      const agentKey = JSON.stringify(agentData);
      if (agentKey !== prevAgentIdsRef.current) {
        prevAgentIdsRef.current = agentKey;
        syncAgentOnlineStatus(agentData);
        setAgents(agentData);
      }
      const healthKey = JSON.stringify(healthData);
      if (healthKey !== prevHealthRef.current) {
        prevHealthRef.current = healthKey;
        setHealth(healthData);
      }
      setError(null);
    } catch (e: any) {
      if (!controller.signal.aborted && generation === refreshGenerationRef.current) {
        setError(e.message || 'Failed to fetch health');
      }
    } finally {
      if (refreshControllerRef.current === controller) {
        refreshControllerRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Clear any existing interval when disabled
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      refreshGenerationRef.current += 1;
      syncAgentOnlineStatus([]);
      prevAgentIdsRef.current = '';
      prevHealthRef.current = '';
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
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      refreshGenerationRef.current += 1;
    };
  }, [enabled, refresh, intervalMs]);

  return { health, agents, error, refresh };
}
