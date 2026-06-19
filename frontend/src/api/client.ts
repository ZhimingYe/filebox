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
  roots: { name: string; path_display: string; enabled: boolean }[];
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
  mem_bytes: number;
  cpu_usage: number;
}

export interface SysStats {
  cpu_usage_percent: number;
  mem_used_bytes: number;
  mem_total_bytes: number;
  swap_used_bytes: number;
  swap_total_bytes: number;
  top_processes: ProcessInfo[];
  load_avg: [number, number, number];
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
    top_processes: [],
    load_avg: [0, 0, 0],
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

export async function patchRoot(agentId: string, rootName: string, patch: { enabled?: boolean; name?: string; path?: string }) {
  return request<any>(`/api/agents/${agentId}/roots/${rootName}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteRoot(agentId: string, rootName: string) {
  return request<any>(`/api/agents/${agentId}/roots/${rootName}`, {
    method: 'DELETE',
  });
}

// ── Filesystem ───────────────────────────────────────────────────────────────

export interface FsEntry {
  name: string;
  entry_type: 'file' | 'directory' | 'symlink';
  size: number | null;
  modified: string | null;
  denied: boolean;
}

export async function fsList(agentId: string, root: string, path: string, limit = 200, cursor?: string) {
  const params = new URLSearchParams({
    agent_id: agentId,
    root,
    path,
    limit: String(limit),
  });
  if (cursor) params.set('cursor', cursor);
  return request<{ items: FsEntry[]; next_cursor: string | null; error?: string }>(
    `/api/fs/list?${params}`,
  );
}

export async function fsStat(agentId: string, root: string, path: string) {
  const params = new URLSearchParams({ agent_id: agentId, root, path });
  return request<{ stat: FsEntry | null; error?: string }>(`/api/fs/stat?${params}`);
}

export function fileRawUrl(agentId: string, root: string, path: string) {
  const params = new URLSearchParams({ agent_id: agentId, root, path });
  return `/api/file/raw?${params}`;
}

export async function cancelRequest(agentId: string, reqId: string) {
  return request<{ ok: boolean }>('/api/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, req_id: reqId }),
  });
}
