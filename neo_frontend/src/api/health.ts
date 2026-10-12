/**
 * Thin hub health probe — proves same-origin API reachability from the neo shell.
 *
 * TODO(neo): Prefer sharing CSRF / cookie-suffix helpers with classic
 * `frontend/src/api/client.ts` once a clean import path exists (monorepo package
 * or Vite alias into ../frontend/src). For this spike we only hit the public
 * `/api/health` endpoint (no session / CSRF required).
 */

export type HubHealth = {
  ok: boolean;
  status: number;
  cookieSuffix: string | null;
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
