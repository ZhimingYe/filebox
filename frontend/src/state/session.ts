import { useState, useCallback, useEffect, useRef } from 'react';
import * as api from '../api/client';
import { forwardNext } from './forwardNext';

const navigate = (path: string) => window.location.replace(path);

export function useSession(navigateTo: (path: string) => void = navigate) {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const redirected = useRef(false);
  const resumeForward = useCallback(() => {
    const next = forwardNext(window.location.search, window.location.origin);
    if (next && !redirected.current) {
      redirected.current = true;
      navigateTo(next);
    }
  }, [navigateTo]);

  useEffect(() => {
    let cancelled = false;

    const verify = async () => {
      // Resolve opaque cookie suffix from the hub before CSRF cookie reads.
      await api.ensureCookieSuffix();
      // A single blip (hub restarting, brief network loss) must not force the
      // login screen when a session cookie is still present.
      const maxAttempts = 3;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          await api.getAgents();
          if (!cancelled) { setLoggedIn(true); resumeForward(); }
          return;
        } catch (e: any) {
          const status = e?.status;
          const code = e?.error;
          const authDead =
            status === 401
            || code === 'unauthorized'
            || code === 'session_expired';
          if (authDead) {
            if (!cancelled) setLoggedIn(false);
            return;
          }
          if (attempt + 1 < maxAttempts) {
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
            continue;
          }
          // Exhausted retries on a non-auth failure. If a CSRF cookie exists the
          // browser likely still has a session — stay optimistic rather than
          // bouncing the user to login over a transient outage.
          if (!cancelled) {
            setLoggedIn(!!api.getCsrfToken());
          }
        }
      }
    };

    verify();
    return () => {
      cancelled = true;
    };
  }, [resumeForward]);

  useEffect(() => {
    const onExpired = () => {
      api.setCsrfToken(null);
      setLoggedIn(false);
    };
    window.addEventListener('filebox:session-expired', onExpired);
    return () => window.removeEventListener('filebox:session-expired', onExpired);
  }, []);

  const login = useCallback(
    async (
      username: string,
      password: string,
      remember: boolean,
      powId: string,
      powNonce: string,
    ) => {
      const result = await api.exchangeSession(username, password, remember, powId, powNonce);
      if (result.ok) {
        setLoggedIn(true);
        resumeForward();
        return true;
      }
      return false;
    },
    [resumeForward],
  );

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
