# crates/ — Rust workspace

filebox's backend is a Cargo workspace of four crates. Two binaries
(`hub`, `agent`) share a wire protocol library and a small updater helper.

```text
Browser ──HTTPS──▶ Hub ◀──WSS (outbound)── Agent ──▶ local files + sysinfo
                     │
                     └── ServeDir(frontend/dist)
```

Agents dial out; the Hub never opens inbound connections to them. Browsers
talk only to the Hub.

## Workspace members

| Crate | Package | Kind | Role |
|---|---|---|---|
| [`protocol/`](protocol/) | `filebox-protocol` | library | Shared WS/JSON types, capabilities, denylist |
| [`hub/`](hub/) | `filebox-hub` | binary `hub` | Auth, agent registry, HTTP/SSE API, static UI |
| [`agent/`](agent/) | `filebox-agent` | binary `agent` | Outbound WS client; read-only FS, search, stats |
| [`updater/`](updater/) | `filebox-updater` | library | Shared `--init-config` / `--update` CLI helpers |

Dependency graph (compile-time):

```text
filebox-hub ──────┐
                  ├──▶ filebox-protocol
filebox-agent ────┘
       │
       └──▶ filebox-updater   (hub also depends on updater)
```

`protocol` and `updater` have no dependency on hub/agent. Workspace version
and shared deps live in the root [`Cargo.toml`](../Cargo.toml).

## Runtime architecture

```text
┌─────────────┐   cookie session    ┌──────────────────────┐
│  Frontend   │ ──────────────────▶ │         Hub          │
│  (browser)  │ ◀──── SSE / JSON ── │  Axum HTTP + WS      │
└─────────────┘                     │                      │
                                    │  auth · registry     │
                                    │  fs_proxy            │
                                    │  search_proxy        │
                                    │  ServeDir(dist)      │
                                    └──────────┬───────────┘
                                               │ JSON over WSS
                                               │ (agents dial out)
                                    ┌──────────▼───────────┐
                                    │        Agent         │
                                    │  reconnect forever   │
                                    │  fs · search · stats │
                                    │  agent_state.json    │
                                    └──────────────────────┘
```

Every Hub→Agent request carries a `req_id` and can be cancelled. Long ops
emit `Progress`; file reads stream as `FileChunk` so the agent never
slurps whole files into memory.

## `protocol` — shared contract

Source of truth for messages both sides serialize. Keep this crate small
and free of I/O.

| Module | Contents |
|---|---|
| `message.rs` | Tagged enums: hub→agent / agent→hub frames (`Register`, `FsList`, `FileChunk`, `Cancel`, `Progress`, collections, search, …) |
| `resources.rs` | Roots, pinned folders, collections, revisions, `Capabilities` |
| `search.rs` | Workspace Search request/result types |
| `agent.rs` | Agent identity / info shapes used at register time |
| `denylist.rs` | Default-deny sensitive paths even inside allowed roots |

**Capability flags that matter:** `pinned_folders`, `collections`,
`workspace_search`. Older agents omit them; the Hub returns unsupported
rather than silently no-op'ing. Vestigial flags (`image_preview`,
`pdf_preview`, `serve_dir`) default `false` and are not gated on.

## `hub` — control plane + API

Axum server. Serves the built frontend from disk (`ServeDir`), authenticates
users, holds the live agent registry, and proxies file/search ops over the
agent WebSocket.

| Module | Responsibility |
|---|---|
| `routes.rs` | HTTP route table |
| `auth.rs` | bcrypt users, session cookies, per-IP login rate limit |
| `net.rs` | Client IP / `FILEBOX_TRUST_XFF` |
| `ws.rs` | Agent WSS handler; abort-on-reregister |
| `agent_registry.rs` | Online/offline lifecycle; coalesced pending root/collection updates; `config_error` |
| `fs_proxy.rs` | List / stat / raw file proxy to agent WS |
| `search_proxy.rs` | Workspace Search proxy (long timeout, cancel binding) |
| `events.rs` | SSE fanout to browsers |
| `health.rs` | Liveness + version |
| `config.rs` / `state.rs` | Config load + shared `AppState` |

Notable invariants (see also root [`CLAUDE.md`](../CLAUDE.md)):

- New `Register` for an existing `agent_id` aborts the old connection;
  `unregister` checks `same_channel()` so a stale socket cannot clobber a
  fresh one.
- Offline root/collection edits coalesce into a single pending update
  (last write wins). Rejection never destroys last known-good state.
- Body limit is 1MB; resource/collection payloads stay tiny by design.

## `agent` — data plane on the machine

Outbound-only Tokio process. Reconnects forever with backoff/jitter.
Persists identity and desired config under `data_dir` (`agent_state.json`).

| Module | Responsibility |
|---|---|
| `connection.rs` | Dial Hub, reconnect loop, ping/liveness, write timeouts |
| `resources.rs` | Validate + atomically apply roots / pins / collections |
| `config_store.rs` | Persist `agent_id`, roots, pins, collections, revisions |
| `fs.rs` | Read-only list/stat/read with path safety + denylist |
| `dir_cache.rs` | mtime-keyed directory listing cache (capped; cleared on root apply) |
| `search.rs` | In-process fd/rg-like Workspace Search (`ignore` + `regex`) |
| `sysinfo.rs` | TTL-cached system stats (HPC-safe refresh) |
| `config.rs` | TOML / env bootstrap |

Path safety on every FS/search op: resolve root → join → normalize /
canonicalize → stay inside root → reject symlink escape → denylist →
open read-only. Home-relative roots (`~/…`) expand against the agent's
`$HOME`.

Search is in-process (no system `fd`/`rg`). One concurrent search per
agent; scan/result caps and cooperative cancel keep large trees from
freezing the process.

## `updater` — install / upgrade helpers

Library used by both binaries for operator UX:

- `--init-config` — interactive config generation (bcrypt hashing in-process,
  `0600` files, `--output` / `--force`)
- `--update` — download matching Linux x86_64 musl release tarball, verify
  `SHA256SUMS.txt`, refuse downgrade by default; mirrors via
  `--update-base-url` (HTTP requires `--allow-insecure-update`)

No Hub/Agent protocol knowledge; pure packaging + CLI.

## Key request paths

**Browse a directory**

```text
GET /api/fs/list → fs_proxy → HubMessage::FsList
  → agent fs.rs (+ DirCache) → DirListing → JSON to browser
```

**Apply roots / pins**

```text
POST|PATCH /api/agents/{id}/roots
  → DesiredResources rewrite → ResourcesSetDesired (WS)
  → agent validates + persists → ResourcesApplied → SSE
```

**Collections** (same pattern, independent `collections_revision`)

```text
POST|PATCH|DELETE /api/agents/{id}/collections
  → CollectionsSetDesired → agent agent_state.json → SSE collections_updated
```

**Workspace Search**

```text
POST /api/agents/{id}/workspace-search
  → search_proxy → WorkspaceSearchRequest
  → agent search.rs (spawn_blocking) + Progress
  → WorkspaceSearchResponse
```

## Build

From the repo root:

```bash
cargo build --release -p filebox-hub -p filebox-agent
# binaries: target/release/hub  target/release/agent
```

The Hub expects a built frontend at `frontend/dist` (or
`FILEBOX_FRONTEND_DIR`). Local bring-up and curl probes:
[`docs/local-debugging.md`](../docs/local-debugging.md).

For agent/coding invariants (reconnect, sysinfo cache, collections), prefer
[`CLAUDE.md`](../CLAUDE.md) over duplicating them here.
