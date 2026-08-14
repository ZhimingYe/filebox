const BASE = '';

/**
 * In-memory CSRF after login (JSON body) before `document.cookie` reflects
 * Set-Cookie. Cookie is authoritative whenever present so another tab's
 * re-login cannot leave this tab sending a stale synchronizer forever.
 */
let csrfToken: string | null = null;

function readCookieValue(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    try {
      const value = decodeURIComponent(trimmed.slice(prefix.length)).trim();
      return value || null;
    } catch {
      return null;
    }
  }
  return null;
}

function readCsrfFromCookie(): string | null {
  // Prefer the Secure/__Host- name when both somehow exist.
  return readCookieValue('__Host-filebox_csrf') || readCookieValue('filebox_csrf');
}

export function getCsrfToken(): string | null {
  const fromCookie = readCsrfFromCookie();
  if (fromCookie) {
    csrfToken = fromCookie;
    return fromCookie;
  }
  return csrfToken;
}

export function setCsrfToken(token: string | null) {
  csrfToken = token && token.trim() ? token.trim() : null;
}

/** Merge CSRF header into fetch init for credentialed API / raw-file calls. */
export function withCsrf(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  const csrf = getCsrfToken();
  if (csrf) {
    headers.set('X-CSRF-Token', csrf);
  }
  return { ...init, credentials: 'include', headers };
}

export function friendlyMessage(error: any): string {
  const raw = error?.error || error?.message || '';
  // Agent may return "agent_busy: ..." — match on prefix.
  const code = typeof raw === 'string' && raw.includes(':')
    ? raw.split(':')[0]
    : raw;
  const map: Record<string, string> = {
    backend_offline: 'Agent is offline. Reconnect it, then retry.',
    request_timeout: 'Request timed out. The agent may be slow or unreachable.',
    root_unavailable: 'This root is no longer available.',
    resource_name_conflict: 'A resource with this name already exists.',
    unauthorized: 'Session expired. Please log in again.',
    session_expired: 'Session expired. Please log in again.',
    csrf_denied: 'Security check failed. Reload the page and try again.',
    access_token_invalid: 'Download authorization expired. Retry the download.',
    invalid_credentials: 'Invalid username or password.',
    not_found: 'Resource not found.',
    backend_slow: 'Agent is responding slowly.',
    request_stalled: 'Request appears stalled. You can cancel or retry.',
    request_cancelled: 'Request was cancelled.',
    login_rate_limited: 'Too many login attempts. Please wait and retry.',
    file_too_large: 'File is too large to preview.',
    file_unavailable: 'The file is no longer available or cannot be accessed.',
    preview_too_large: 'Preview is too large to render.',
    permission_denied: 'Permission denied.',
    path_denied: 'Access denied — sensitive file.',
    denied_sensitive_path: 'Access denied — sensitive file.',
    hub_overloaded: 'Server is overloaded. Please retry later.',
    agent_overloaded: 'Agent is overloaded. Please retry later.',
    agent_internal_error: 'The agent operation failed safely. Please retry.',
    invalid_root_path: 'Path does not exist or is not accessible.',
    invalid_root_name: 'Invalid root name.',
    invalid_pinned_path: 'Invalid pinned folder path.',
    invalid_collection_name: 'Invalid collection name.',
    unsupported: 'This agent does not support that feature. Upgrade the agent.',
    invalid_request: 'Invalid search request.',
    invalid_search_pattern: 'The search pattern is invalid.',
    search_path_unavailable: 'The search folder is no longer available.',
    search_failed: 'Search failed safely. Please retry.',
    cancelled: 'Request was cancelled.',
    agent_busy: 'Agent is busy with another request. Wait or cancel it.',
    invalid_collection_path: 'Invalid collection file path.',
    collection_name_conflict: 'A collection with this name already exists.',
    resource_rejected: 'Agent rejected this change. The folder may be missing or the root changed.',
    unsupported_feature: 'This agent does not support that feature.',
    unsupported_format: 'This file type cannot be converted for preview.',
    office_unavailable: 'Office preview is temporarily unavailable. You can still download the original.',
    office_timeout: 'Office conversion timed out. You can still download the original.',
    office_convert_failed: 'Could not convert this document for preview. You can still download the original.',
    office_storage_error: 'The agent could not store the temporary preview.',
    office_cache_too_small: 'The converted preview exceeds the agent’s Office cache budget. Increase FILEBOX_AGENT_OFFICE_CACHE_BYTES.',
    office_source_unavailable: 'The source document is no longer readable.',
    office_source_too_large: 'This document exceeds the agent’s configured conversion limit.',
    office_output_too_large: 'The converted preview exceeds the agent’s configured output limit.',
    office_memory_limit: 'Office conversion exceeded its memory limit. Increase FILEBOX_AGENT_OFFICE_MAX_MEMORY_BYTES or retry on a larger machine.',
    office_invalid_pdf: 'Office produced an invalid PDF. Retry to rebuild the preview.',
    office_internal_error: 'The Office preview worker failed safely. Please retry.',
    denied: 'Access denied — sensitive file.',
    temp_file_too_large: 'This file exceeds the agent’s upload limit.',
    temp_quota_exceeded: 'The temp folder is full. Clean it up and retry.',
    temp_name_invalid: 'Invalid file name for upload.',
    temp_name_conflict: 'Could not find a free name for this file.',
    temp_upload_interrupted: 'The upload was interrupted.',
    temp_length_required: 'The upload failed: missing length.',
    temp_upload_incomplete: 'The upload body ended early. Retry.',
  };
  if (code && map[code]) return map[code];
  return 'An unexpected error occurred.';
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

async function request<T>(
  path: string,
  init: RequestInit = {},
  retried = false,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const csrf = getCsrfToken();
  if (csrf) {
    headers.set('X-CSRF-Token', csrf);
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (init.signal?.aborted) {
    controller.abort();
  } else {
    init.signal?.addEventListener('abort', onAbort, { once: true });
  }
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // Another tab may have rotated the CSRF cookie while this tab still had
      // a stale in-memory value. Drop memory, re-read cookie, retry once.
      if (
        !retried
        && !(
          typeof ReadableStream !== 'undefined'
          && init.body instanceof ReadableStream
        )
        && res.status === 403
        && (body as { error?: string }).error === 'csrf_denied'
      ) {
        setCsrfToken(null);
        const refreshed = getCsrfToken();
        if (refreshed && refreshed !== csrf) {
          return request<T>(path, init, true, timeoutMs);
        }
      }
      const errCode = (body as { error?: string }).error;
      if (
        res.status === 401
        && (errCode === 'session_expired' || errCode === 'unauthorized')
        && typeof window !== 'undefined'
      ) {
        window.dispatchEvent(new CustomEvent('filebox:session-expired'));
      }
      throw { status: res.status, ...body };
    }
    return await res.json();
  } catch (error) {
    if (timedOut) {
      throw {
        error: 'request_stalled',
        message: 'The request stalled before completing.',
        retryable: true,
      };
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    init.signal?.removeEventListener('abort', onAbort);
  }
}

/** Shape thrown by `request` for non-2xx API responses (`{ status, ...body }`). */
export interface ApiError {
  status?: number;
  error?: string;
  message?: string;
  retryable?: boolean;
}

// ── Session ──────────────────────────────────────────────────────────────────

/** Self-hosted proof-of-work login challenge. Single-use: a fresh challenge
 *  must be fetched and solved after every submit attempt. */
export interface PowChallenge {
  id: string;
  salt: string;
  difficulty: number;
  expires_in_secs: number;
}

export async function getPowChallenge(signal?: AbortSignal) {
  return request<PowChallenge>('/api/pow/challenge', signal ? { signal } : {});
}

export async function exchangeSession(
  username: string,
  password: string,
  remember: boolean,
  powId: string,
  powNonce: string,
) {
  const result = await request<{ ok: boolean; permissions: string[]; csrf_token?: string }>(
    '/api/session/exchange',
    {
      method: 'POST',
      body: JSON.stringify({
        username,
        password,
        remember,
        pow_id: powId,
        pow_nonce: powNonce,
      }),
    },
  );
  if (result.ok && result.csrf_token) {
    setCsrfToken(result.csrf_token);
  }
  return result;
}

export async function logout() {
  try {
    return await request<{ ok: boolean }>('/api/session/logout', { method: 'POST' });
  } finally {
    setCsrfToken(null);
  }
}

// ── Login audit ──────────────────────────────────────────────────────────────

export type LoginAuditEvent =
  | 'login_success'
  | 'login_failed'
  | 'login_rate_limited'
  | 'pow_failed'
  | 'logout'
  | (string & {});

export interface LoginAuditEntry {
  id: number;
  at_ms: number;
  event: LoginAuditEvent;
  username: string;
  ip: string;
  user_agent: string;
}

/** Newest-first page of hub login audit records. `before` = exclusive entry
 *  id, used to page backwards into older records. */
export async function getLoginAudit(
  opts: { limit?: number; before?: number } = {},
  signal?: AbortSignal,
) {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  const qs = params.toString();
  return request<{ entries: LoginAuditEntry[]; has_more: boolean }>(
    `/api/audit/logins${qs ? `?${qs}` : ''}`,
    { signal },
    false,
    15_000,
  );
}

// ── Health ───────────────────────────────────────────────────────────────────

export interface AgentCapabilities {
  office_pdf_preview: boolean;
  office_max_src_bytes?: number | null;
  office_max_pdf_bytes?: number | null;
  office_timeout_secs?: number | null;
  workspace_search: boolean;
  pinned_folders: boolean;
  collections: boolean;
  temp_upload: boolean;
}

export interface AgentInfo {
  id: string;
  name: string;
  status: string;
  last_seen: number;
  rtt_ms: number | null;
  inflight: number;
  resource_revision: number;
  pending_resource_update: boolean;
  last_config_error: string | null;
  roots: RootInfo[];
  /** Name of the agent's temp-upload root (also listed in `roots` unless a
      user root shadows it). Present on temp-capable agents only. */
  temp_root_name?: string | null;
  /** Agent-enforced per-file upload cap (bytes), when advertised. */
  temp_max_file_bytes?: number | null;
  collections_revision: number;
  pending_collections_update: boolean;
  collections: CollectionInfo[];
  /** Present on current hubs; treat missing fields as false for older hubs. */
  capabilities?: Partial<AgentCapabilities>;
}

export interface CollectionItem {
  root: string;
  path: string;
  label?: string | null;
}

export interface CollectionInfo {
  name: string;
  items: CollectionItem[];
}

/// A root as returned by the hub (display shape). `pinned_folders` holds
/// root-relative paths (leading `/`) that the user pinned to the sidebar.
export interface RootInfo {
  name: string;
  path_display: string;
  enabled: boolean;
  pinned_folders: string[];
}

export interface HealthResponse {
  hub: { status: string; version: string; uptime_sec: number };
}

export async function getHealth(signal?: AbortSignal) {
  return request<HealthResponse>('/api/health', { signal }, false, 10_000);
}

// ── Agents ───────────────────────────────────────────────────────────────────

export async function getAgents(signal?: AbortSignal) {
  return request<AgentInfo[]>('/api/agents', { signal }, false, 10_000);
}

export async function getAgent(agentId: string) {
  return request<AgentInfo>(`/api/agents/${agentId}`);
}

export interface ProcessInfo {
  pid: number;
  name: string;
  user: string;
  uid: number;
  state: string;          // R/S/D/Z/I/T/...
  mem_bytes: number;
  cpu_usage: number;
  accumulated_cpu_ms: number;
  start_time: number;     // epoch seconds
  run_time_secs: number;
  parent_pid: number | null;
  command: string;        // full argv joined; length-capped on agent
  nproc: number | null;   // HPC parallelism hint parsed from argv
}

export interface UserAgg {
  user: string;
  uid: number;
  cpu_usage: number;
  mem_bytes: number;
  accumulated_cpu_ms: number;
  process_count: number;
}

export interface UserTotals {
  user_count: number;
  total_cpu_usage: number;
  total_mem_bytes: number;
  total_processes: number;
}

export interface SysStats {
  cpu_usage_percent: number;
  mem_used_bytes: number;
  mem_total_bytes: number;
  swap_used_bytes: number;
  swap_total_bytes: number;
  load_avg: [number, number, number];
  uptime_secs: number;
  boot_time: number;
  top_processes: ProcessInfo[];
  total_processes: number;
  top_users: UserAgg[];
  user_totals: UserTotals;
}

export async function getSysStats(agentId: string): Promise<SysStats & { error?: string }> {
  const raw = await request<{ stats: SysStats | null; error: string | null }>(
    `/api/agents/${agentId}/sys-stats`,
  );
  if (raw.error) return { ...emptyStats(), error: raw.error };
  return raw.stats!;
}

export type SearchMode = 'find' | 'content';

export interface SearchContextLine {
  line: number;
  text: string;
  is_match: boolean;
}

export interface SearchHit {
  root: string;
  path: string;
  line?: number | null;
  context: SearchContextLine[];
}

export interface WorkspaceSearchResult {
  hits: SearchHit[];
  truncated: boolean;
  scanned: number;
}

export async function workspaceSearch(
  agentId: string,
  body: {
    mode: SearchMode;
    root: string;
    path?: string;
    query: string;
    extensions?: string[];
    max_results?: number;
    context?: number;
    /** Directory/file names to skip at any depth (e.g. venv, renv). */
    ignore?: string[];
    /** Max directory layers under the search folder; omit/0 = unlimited. */
    max_depth?: number | null;
    /** Echoed on the hub's initial SSE progress so Cancel binds to this search. */
    client_nonce?: string;
  },
  signal?: AbortSignal,
): Promise<{ result: WorkspaceSearchResult | null; error?: string; req_id?: string }> {
  const raw = await request<{
    req_id?: string;
    result: WorkspaceSearchResult | null;
    error: string | null;
  }>(`/api/agents/${agentId}/workspace-search`, {
    method: 'POST',
    body: JSON.stringify({
      path: '/',
      extensions: [],
      ignore: [],
      ...body,
    }),
    signal,
  }, false, 10 * 60_000);
  if (raw.error) return { result: null, error: raw.error, req_id: raw.req_id };
  if (!raw.result) return { result: null, req_id: raw.req_id };
  return {
    req_id: raw.req_id,
    result: {
      hits: (raw.result.hits ?? []).map((h) => ({
        ...h,
        context: h.context ?? [],
      })),
      truncated: !!raw.result.truncated,
      scanned: raw.result.scanned ?? 0,
    },
  };
}

function emptyStats(): SysStats {
  return {
    cpu_usage_percent: 0,
    mem_used_bytes: 0,
    mem_total_bytes: 0,
    swap_used_bytes: 0,
    swap_total_bytes: 0,
    load_avg: [0, 0, 0],
    uptime_secs: 0,
    boot_time: 0,
    top_processes: [],
    total_processes: 0,
    top_users: [],
    user_totals: {
      user_count: 0,
      total_cpu_usage: 0,
      total_mem_bytes: 0,
      total_processes: 0,
    },
  };
}

export async function getAgentResources(agentId: string) {
  return request<{ agent_id: string; resource_revision: number; roots: any[] }>(
    `/api/agents/${agentId}/resources`,
  );
}

// ── Resource Management ─────────────────────────────────────────────────────

export async function addRoot(agentId: string, name: string, path: string, enabled = true) {
  return request<any>(`/api/agents/${agentId}/roots`, {
    method: 'POST',
    body: JSON.stringify({ name, path, enabled }),
  });
}

export async function patchRoot(
  agentId: string,
  rootName: string,
  patch: {
    enabled?: boolean;
    name?: string;
    path?: string;
    pinned_folders?: string[];
    /** Single-item delta: add this path to pinned_folders if absent. */
    pin_add?: string;
    /** Single-item delta: remove this path from pinned_folders if present. */
    pin_remove?: string;
  },
) {
  const res = await request<any>(`/api/agents/${agentId}/roots/${rootName}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  // The agent can REJECT the new resource state (e.g. a pinned path whose
  // shape is bad, or a root path that vanished) while the hub still returns
  // HTTP 200 with `{ ok: false, state: "rejected", error, message }`. A
  // 2xx-only check in the shared `request()` would let that through as success,
  // so togglePin / handleUnpin would refresh the UI as if the change landed.
  // Throw here so callers' catch arms surface the rejection instead.
  if (res && typeof res === 'object' && (res.ok === false || res.state === 'rejected')) {
    throw {
      status: 200,
      error: res.error || 'resource_rejected',
      message: res.message || 'Agent rejected the resource update.',
      retryable: true,
    };
  }
  return res;
}

export async function deleteRoot(agentId: string, rootName: string) {
  return request<any>(`/api/agents/${agentId}/roots/${rootName}`, {
    method: 'DELETE',
  });
}

// ── Virtual Collections ─────────────────────────────────────────────────────

async function throwIfCollectionRejected(res: any) {
  if (res && typeof res === 'object' && (res.ok === false || res.state === 'rejected')) {
    throw {
      status: 200,
      error: res.error || 'collection_rejected',
      message: res.message || 'Agent rejected the collection update.',
      retryable: true,
    };
  }
  return res;
}

export async function createCollection(
  agentId: string,
  name: string,
  /** Optional initial item — create+add in one desired-state rewrite. */
  item?: CollectionItem,
) {
  const res = await request<any>(`/api/agents/${agentId}/collections`, {
    method: 'POST',
    body: JSON.stringify(item ? { name, item } : { name }),
  });
  return throwIfCollectionRejected(res);
}

export async function patchCollection(
  agentId: string,
  collectionName: string,
  patch: {
    rename?: string;
    item_add?: CollectionItem;
    item_remove?: { root: string; path: string };
    items?: CollectionItem[];
  },
) {
  const res = await request<any>(`/api/agents/${agentId}/collections/${encodeURIComponent(collectionName)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return throwIfCollectionRejected(res);
}

export async function deleteCollection(agentId: string, collectionName: string) {
  const res = await request<any>(`/api/agents/${agentId}/collections/${encodeURIComponent(collectionName)}`, {
    method: 'DELETE',
  });
  return throwIfCollectionRejected(res);
}

// ── Filesystem ───────────────────────────────────────────────────────────────

export interface FsEntry {
  name: string;
  entry_type: 'file' | 'directory' | 'symlink';
  size: number | null;
  modified: string | null;
  denied: boolean;
}

/** Agent stat payload — uses `path`; list entries use `name`. */
export interface FileStat {
  path: string;
  entry_type: 'file' | 'directory' | 'symlink';
  size: number;
  modified: string | null;
  permissions?: string | null;
  denied: boolean;
}

export function statToFsEntry(stat: FileStat, pathHint?: string): FsEntry {
  const path = stat.path || pathHint || '';
  const parts = path.split('/').filter(Boolean);
  const name = parts[parts.length - 1] ?? path;
  return {
    name,
    entry_type: stat.entry_type,
    size: stat.size ?? null,
    modified: stat.modified ?? null,
    denied: stat.denied,
  };
}

export async function fsList(
  agentId: string,
  root: string,
  path: string,
  limit = 200,
  cursor?: string,
  dirsOnly = false,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({
    agent_id: agentId,
    root,
    path,
    limit: String(limit),
  });
  if (cursor) params.set('cursor', cursor);
  if (dirsOnly) params.set('dirs_only', 'true');
  return request<{ items: FsEntry[]; next_cursor: string | null; error?: string }>(
    `/api/fs/list?${params}`,
    { signal },
  );
}

export async function fsStat(agentId: string, root: string, path: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ agent_id: agentId, root, path });
  return request<{ stat: FileStat | null; error?: string }>(`/api/fs/stat?${params}`, { signal });
}

/** Bare raw-file URL (session cookie + CSRF header, or `access_token` query). */
export function fileRawUrl(agentId: string, root: string, path: string, accessToken?: string) {
  const params = new URLSearchParams({ agent_id: agentId, root, path });
  if (accessToken) {
    params.set('access_token', accessToken);
  }
  return `/api/file/raw?${params}`;
}

export type AccessTokenPurpose = 'file_raw' | 'events';

/** Mint a short-lived GET bearer (CSRF-gated). Never put the CSRF secret in URLs. */
export async function createAccessToken(body: {
  purpose: AccessTokenPurpose;
  agent_id?: string;
  root?: string;
  path?: string;
}, signal?: AbortSignal) {
  return request<{ token: string; expires_in_sec: number }>('/api/access-tokens', {
    method: 'POST',
    signal,
    body: JSON.stringify(body),
  });
}

export async function fileRawAccessUrl(
  agentId: string,
  root: string,
  path: string,
  signal?: AbortSignal,
) {
  const { url } = await mintFileRawAccess(agentId, root, path, signal);
  return url;
}

/** Mint a file_raw access URL and return its TTL so long-lived viewers can refresh. */
export async function mintFileRawAccess(
  agentId: string,
  root: string,
  path: string,
  signal?: AbortSignal,
) {
  const { token, expires_in_sec } = await createAccessToken(
    { purpose: 'file_raw', agent_id: agentId, root, path },
    signal,
  );
  return { url: fileRawUrl(agentId, root, path, token), expiresInSec: expires_in_sec };
}

export async function eventsAccessUrl(signal?: AbortSignal) {
  const { token, expires_in_sec } = await createAccessToken({ purpose: 'events' }, signal);
  return {
    url: `/api/events?access_token=${encodeURIComponent(token)}`,
    expiresInSec: expires_in_sec,
  };
}

export async function createPreviewSession(agentId: string, root: string, path: string, signal?: AbortSignal) {
  return request<{ base_url: string; document_url: string; expires_in_sec: number }>('/api/preview/sessions', {
    method: 'POST',
    signal,
    body: JSON.stringify({ agent_id: agentId, root, path }),
  });
}

export async function cancelRequest(agentId: string, reqId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>('/api/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, req_id: reqId }),
    signal,
  }, false, 10_000);
}

export interface OfficePreviewOutput {
  label: string;
  format: 'pdf' | 'csv';
  cache_key: string;
  size: number;
}

/** Virtual path for a cached Office-derived preview on the agent. */
export function officeCacheVirtualPath(cacheKey: string, format: 'pdf' | 'csv' = 'pdf'): string {
  return `/.filebox/office-cache/${cacheKey}.${format}`;
}

export async function officeConvert(
  agentId: string,
  root: string,
  path: string,
  reqId: string,
  clientNonce: string,
  force = false,
  signal?: AbortSignal,
): Promise<{
  req_id?: string;
  cache_key: string;
  size: number;
  outputs: OfficePreviewOutput[];
}> {
  const raw = await request<{
    req_id?: string;
    cache_key: string | null;
    size: number | null;
    outputs?: Array<{
      label?: unknown;
      format?: unknown;
      cache_key?: unknown;
      size?: unknown;
    }>;
    error: string | null;
  }>(`/api/agents/${agentId}/office-convert`, {
    method: 'POST',
    body: JSON.stringify({
      root,
      path,
      req_id: reqId,
      client_nonce: clientNonce,
      force,
    }),
    signal,
  });
  if (raw.error) {
    throw { status: 400, error: raw.error, message: raw.error };
  }
  const outputs = (raw.outputs || []).flatMap((output): OfficePreviewOutput[] => {
    if (
      typeof output.label !== 'string'
      || (output.format !== 'pdf' && output.format !== 'csv')
      || typeof output.cache_key !== 'string'
      || !/^[0-9a-f]{64}$/i.test(output.cache_key)
      || typeof output.size !== 'number'
      || !Number.isFinite(output.size)
      || output.size < 0
      || (output.format === 'pdf' && output.size === 0)
    ) {
      return [];
    }
    return [{
      label: output.label,
      format: output.format,
      cache_key: output.cache_key,
      size: output.size,
    }];
  });
  if (outputs.length === 0) {
    if (!raw.cache_key || raw.size == null || raw.size <= 0) {
      throw { status: 502, error: 'office_convert_failed', message: 'office_convert_failed' };
    }
    outputs.push({
      label: 'Document',
      format: 'pdf',
      cache_key: raw.cache_key,
      size: raw.size,
    });
  }
  const primary = outputs[0];
  return {
    req_id: raw.req_id,
    cache_key: raw.cache_key || primary.cache_key,
    size: raw.size ?? primary.size,
    outputs,
  };
}

// ── Temp upload folder ──────────────────────────────────────────────────────

export interface TempUploadResult {
  ok: boolean;
  name: string;
  size: number;
}

export interface TempCleanupResult {
  ok: boolean;
  removed: number;
  freed_bytes: number;
}

/**
 * Upload one file into the agent's dedicated temp folder. Uses XHR so the
 * caller can render real upload progress; the CSRF synchronizer rides in the
 * header exactly like `request()`, and a stale-token 403 retries once after
 * re-reading the cookie.
 */
export function uploadTempFile(
  agentId: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<TempUploadResult> {
  return new Promise((resolve, reject) => {
    const attempt = (retried: boolean) => {
      const xhr = new XMLHttpRequest();
      const name = file.name.trim();
      const url = `/api/agents/${encodeURIComponent(agentId)}/temp-upload?name=${encodeURIComponent(name)}`;
      xhr.open('POST', url);
      xhr.withCredentials = true;
      xhr.timeout = 130_000;
      const csrf = getCsrfToken();
      if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded, e.total);
      };
      const onAbort = () => xhr.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      xhr.onloadend = () => {
        signal?.removeEventListener('abort', onAbort);
      };
      xhr.onerror = () => reject({ error: 'network_error', message: 'Network error during upload.' });
      xhr.ontimeout = () => reject({ error: 'request_stalled', message: 'The upload stalled.' });
      xhr.onabort = () => reject({ error: 'cancelled', message: 'Upload cancelled.' });
      xhr.onload = () => {
        const body = ((): Record<string, unknown> => {
          try { return JSON.parse(xhr.responseText) as Record<string, unknown>; } catch { return {}; }
        })();
        if (xhr.status >= 200 && xhr.status < 300 && body.ok === true) {
          resolve({
            ok: true,
            name: typeof body.name === 'string' ? body.name : name,
            size: typeof body.size === 'number' ? body.size : 0,
          });
          return;
        }
        if (
          !retried
          && xhr.status === 403
          && body.error === 'csrf_denied'
        ) {
          setCsrfToken(null);
          const refreshed = getCsrfToken();
          if (refreshed && refreshed !== csrf) {
            attempt(true);
            return;
          }
        }
        reject({ status: xhr.status, error: body.error, message: body.message, retryable: body.retryable });
      };
      xhr.send(file);
    };
    attempt(false);
  });
}

/** One-click cleanup of the agent's temp upload folder. */
export async function cleanupTempFolder(agentId: string, signal?: AbortSignal) {
  return request<TempCleanupResult>(
    `/api/agents/${encodeURIComponent(agentId)}/temp-cleanup`,
    { method: 'POST', signal },
    false,
    75_000,
  );
}
