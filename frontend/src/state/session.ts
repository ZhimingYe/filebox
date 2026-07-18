import { useState, useCallback, useEffect } from 'react';
import * as api from '../api/client';

export function useSession() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);

  useEffect(() => {
    // Verify session by hitting a protected endpoint
    api.getAgents()
      .then(() => setLoggedIn(true))
      .catch((e) => {
        if (e.status === 401) {
          setLoggedIn(false);
        } else {
          // Network error — can't determine state, assume logged out
          setLoggedIn(false);
        }
      });
  }, []);

  const login = useCallback(async (username: string, password: string, remember: boolean) => {
    const result = await api.exchangeSession(username, password, remember);
    if (result.ok) {
      setLoggedIn(true);
      return true;
    }
    return false;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Ignore errors — still clear local CSRF so a later login cannot reuse it
      api.setCsrfToken(null);
    }
    setLoggedIn(false);
  }, []);

  return { loggedIn, login, logout };
}
