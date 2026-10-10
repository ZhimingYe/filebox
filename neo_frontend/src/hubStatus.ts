/** Lightweight Hub reachability probe for the neo shell status bar. */

export type HubHealth = {
  ok: boolean
  detail: string
}

type HealthJson = {
  version?: string
  hub?: { cookie_suffix?: string }
}

export async function fetchHubHealth(signal?: AbortSignal): Promise<HubHealth> {
  try {
    const res = await fetch('/api/health', {
      credentials: 'same-origin',
      signal,
    })
    if (!res.ok) {
      return { ok: false, detail: `Hub HTTP ${res.status}` }
    }
    const data = (await res.json()) as HealthJson
    const version = data.version ?? 'unknown'
    return { ok: true, detail: `Hub reachable · v${version}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unreachable'
    return { ok: false, detail: `Hub offline (${msg})` }
  }
}
