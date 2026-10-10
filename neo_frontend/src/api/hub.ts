/** Thin same-origin Hub client for neo (session cookie + CSRF). */

export interface FsEntry {
  name: string
  entry_type: 'file' | 'directory' | 'symlink'
  size: number | null
  modified: string | null
  denied: boolean
}

export interface RootInfo {
  name: string
  path_display: string
  enabled: boolean
  pinned_folders: string[]
}

export interface AgentInfo {
  id: string
  name: string
  status: string
  roots: RootInfo[]
}

function readCookieValue(name: string): string | null {
  if (typeof document === 'undefined') return null
  const prefix = `${name}=`
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim()
    if (!trimmed.startsWith(prefix)) continue
    try {
      return decodeURIComponent(trimmed.slice(prefix.length)).trim() || null
    } catch {
      return null
    }
  }
  return null
}

let cookieSuffix: string | null = null

async function ensureCookieSuffix(signal?: AbortSignal): Promise<string | null> {
  if (cookieSuffix) return cookieSuffix
  try {
    const res = await fetch('/api/health', { signal, credentials: 'same-origin' })
    if (!res.ok) return null
    const body = (await res.json()) as { hub?: { cookie_suffix?: unknown } }
    const suffix = body?.hub?.cookie_suffix
    if (typeof suffix === 'string' && /^[0-9a-f]{8}$/i.test(suffix)) {
      cookieSuffix = suffix.toLowerCase()
      return cookieSuffix
    }
  } catch {
    /* ignore */
  }
  return null
}

function getCsrfToken(): string | null {
  if (cookieSuffix) {
    return (
      readCookieValue(`__Host-filebox_csrf_${cookieSuffix}`) ||
      readCookieValue(`filebox_csrf_${cookieSuffix}`)
    )
  }
  const names = document.cookie.split(';').map((p) => p.trim().split('=')[0])
  const prefixed = names.filter((n) =>
    /^(?:__Host-)?filebox_csrf_[0-9a-f]{8}$/i.test(n || ''),
  )
  if (prefixed.length === 1 && prefixed[0]) return readCookieValue(prefixed[0])
  return null
}

async function request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  await ensureCookieSuffix(signal)
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json')
  }
  const csrf = getCsrfToken()
  if (csrf) headers.set('X-CSRF-Token', csrf)
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers,
    signal,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw { status: res.status, ...body }
  }
  return (await res.json()) as T
}

export async function getAgents(signal?: AbortSignal) {
  return request<AgentInfo[]>('/api/agents', {}, signal)
}

export async function fsList(
  agentId: string,
  root: string,
  path: string,
  limit = 200,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({
    agent_id: agentId,
    root,
    path,
    limit: String(limit),
  })
  return request<{ items: FsEntry[]; next_cursor: string | null; error?: string }>(
    `/api/fs/list?${params}`,
    {},
    signal,
  )
}

export async function createPreviewSession(
  agentId: string,
  root: string,
  path: string,
  signal?: AbortSignal,
) {
  return request<{ base_url: string; document_url: string; expires_in_sec: number }>(
    '/api/preview/sessions',
    {
      method: 'POST',
      body: JSON.stringify({ agent_id: agentId, root, path }),
    },
    signal,
  )
}

/** Same-origin raw file URL (needs CSRF header or access_token; not iframe-safe). */
export function fileRawUrl(agentId: string, root: string, path: string, accessToken?: string) {
  const params = new URLSearchParams({ agent_id: agentId, root, path })
  if (accessToken) params.set('access_token', accessToken)
  return `/api/file/raw?${params}`
}

/**
 * Fetch PDF/bytes with session+CSRF into a blob: URL.
 * Hub raw responses set X-Frame-Options: DENY, so iframe src must be blob:/object URL.
 */
export async function fetchFileRawBlobUrl(
  agentId: string,
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  await ensureCookieSuffix(signal)
  const headers = new Headers()
  const csrf = getCsrfToken()
  if (csrf) headers.set('X-CSRF-Token', csrf)
  const res = await fetch(fileRawUrl(agentId, root, path), {
    credentials: 'include',
    headers,
    signal,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw { status: res.status, ...body }
  }
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

/** Default cap for text previews (CSV/MD): never pull whole HPC-sized files. */
export const TEXT_PREVIEW_MAX_BYTES = 5 * 1024 * 1024

export type RawTextResult = {
  text: string
  /** True when the file was larger than maxBytes and only a prefix was read. */
  truncated: boolean
  /** Content-Length when the hub sent one. */
  totalBytes: number | null
}

/**
 * Fetch a UTF-8 text prefix with session+CSRF. Sends a Range hint but does not
 * rely on it: the body is streamed and cancelled once maxBytes is reached, so
 * memory stays bounded even if the hub ignores Range.
 */
export async function fetchFileRawText(
  agentId: string,
  root: string,
  path: string,
  signal?: AbortSignal,
  maxBytes = TEXT_PREVIEW_MAX_BYTES,
): Promise<RawTextResult> {
  await ensureCookieSuffix(signal)
  const headers = new Headers()
  const csrf = getCsrfToken()
  if (csrf) headers.set('X-CSRF-Token', csrf)
  headers.set('Range', `bytes=0-${maxBytes - 1}`)
  const res = await fetch(fileRawUrl(agentId, root, path), {
    credentials: 'include',
    headers,
    signal,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw { status: res.status, ...body }
  }
  const lenHeader = res.headers.get('Content-Range')?.split('/')[1]
    ?? res.headers.get('Content-Length')
  const parsedLen = lenHeader ? Number(lenHeader) : NaN
  const totalBytes = Number.isFinite(parsedLen) ? parsedLen : null

  if (!res.body) {
    const text = await res.text()
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes, totalBytes }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    if (received + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - received))
      received = maxBytes
      truncated = true
      void reader.cancel()
      break
    }
    chunks.push(value)
    received += value.byteLength
  }
  const merged = new Uint8Array(received)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(merged)
  if (totalBytes != null && totalBytes > received) truncated = true
  return { text, truncated, totalBytes }
}
