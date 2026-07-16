const BASE = '';

export function friendlyMessage(error: any): string {
  const code = error?.error || error?.message || '';
  const map: Record<string, string> = {
    backend_offline: 'Agent is offline. Changes will be applied when it reconnects.',
    request_timeout: 'Request timed out. The agent may be slow or unreachable.',
    root_unavailable: 'This root is no longer available.',
    resource_name_conflict: 'A resource with this name already exists.',
    unauthorized: 'Session expired. Please log in again.',
    session_expired: 'Session expired. Please log in again.',
    invalid_credentials: 'Invalid username or password.',
    not_found: 'Resource not found.',
    backend_slow: 'Agent is responding slowly.',
    request_stalled: 'Request appears stalled. You can cancel or retry.',
    request_cancelled: 'Request was cancelled.',
    too_many_requests: 'Too many active requests. Please wait and retry.',
    file_too_large: 'File is too large to preview.',
    preview_too_large: 'Preview is too large to render.',
    permission_denied: 'Permission denied.',
    path_denied: 'Access denied — sensitive file.',
    denied_sensitive_path: 'Access denied — sensitive file.',
    hub_overloaded: 'Server is overloaded. Please retry later.',
    agent_overloaded: 'Agent is overloaded. Please retry later.',
    invalid_root_path: 'Path does not exist or is not accessible.',
    invalid_root_name: 'Invalid root name.',
    invalid_pinned_path: 'Invalid pinned folder path.',
    invalid_collection_name: 'Invalid collection name.',
    invalid_collection_path: 'Invalid collection file path.',
    collection_name_conflict: 'A collection with this name already exists.',
    resource_rejected: 'Agent rejected this change. The folder may be missing or the root changed.',
    unsupported_feature: 'This agent version does not support pinned folders.',
  };
  if (code && map[code]) return map[code];
  return 'An unexpected error occurred.';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw { status: res.status, ...body };
  }
  return res.json();
}

// ── Session ──────────────────────────────────────────────────────────────────

export async function exchangeSession(username: string, password: string, remember: boolean) {
  return request<{ ok: boolean; permissions: string[] }>(
    '/api/session/exchange',
    { method: 'POST', body: JSON.stringify({ username, password, remember }) },
  );
}

export async function logout() {
  return request<{ ok: boolean }>('/api/session/logout', { method: 'POST' });
}

// ── Health ───────────────────────────────────────────────────────────────────

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
  collections_revision: number;
  pending_collections_update: boolean;
  collections: CollectionInfo[];
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

export async function getHealth() {
  return request<HealthResponse>('/api/health');
}

// ── Agents ───────────────────────────────────────────────────────────────────

export async function getAgents() {
  return request<AgentInfo[]>('/api/agents');
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

export async function createCollection(agentId: string, name: string) {
  const res = await request<any>(`/api/agents/${agentId}/collections`, {
    method: 'POST',
    body: JSON.stringify({ name }),
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

export async function fsList(agentId: string, root: string, path: string, limit = 200, cursor?: string, dirsOnly = false) {
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
  );
}

export async function fsStat(agentId: string, root: string, path: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ agent_id: agentId, root, path });
  return request<{ stat: FileStat | null; error?: string }>(`/api/fs/stat?${params}`, { signal });
}

export function fileRawUrl(agentId: string, root: string, path: string) {
  const params = new URLSearchParams({ agent_id: agentId, root, path });
  return `/api/file/raw?${params}`;
}

export async function createPreviewSession(agentId: string, root: string, path: string, signal?: AbortSignal) {
  return request<{ base_url: string; expires_in_sec: number }>('/api/preview/sessions', {
    method: 'POST',
    signal,
    body: JSON.stringify({ agent_id: agentId, root, path }),
  });
}

export async function cancelRequest(agentId: string, reqId: string) {
  return request<{ ok: boolean }>('/api/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, req_id: reqId }),
  });
}
