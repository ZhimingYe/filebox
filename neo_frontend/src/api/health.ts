/**
 * Thin hub health probe for the neo chrome status chip.
 *
 * Session / CSRF for real API calls go through classic
 * `@lib/api/client` (`ensureCookieSuffix`, `withCsrf`, cookie reads).
 * This helper only reports reachability + whether a CSRF cookie is present
 * after classic suffix resolution.
 */

export type HubHealth = {
  ok: boolean;
  status: number;
  cookieSuffix: string | null;
  /** True when classic client can read a CSRF token (cookie or in-memory). */
  hasCsrf?: boolean;
  error?: string;
};

export async function fetchHubHealth(signal?: AbortSignal): Promise<HubHealth> {
  try {
    const res = await fetch('/api/health', {
      signal,
      credentials: 'same-origin',
    });
    if (!res.ok) {
      return { ok: false, status: res.status, cookieSuffix: null, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { hub?: { cookie_suffix?: unknown } };
    const suffix = body?.hub?.cookie_suffix;
    const cookieSuffix =
      typeof suffix === 'string' && /^[0-9a-f]{8}$/i.test(suffix)
        ? suffix.toLowerCase()
        : null;
    return { ok: true, status: res.status, cookieSuffix };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, cookieSuffix: null, error: message };
  }
}
