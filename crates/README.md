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
| [`agent/`](agent/) | `filebox-agent` | binary `agent` | Outbound WS client; read-only FS, search, stats, temp uploads and optional Herdr CLI |
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
| `message.rs` | Tagged enums: hub→agent / agent→hub frames (`Register`, `FsList`, `FileChunk`, `Cancel`, `Progress`, collections, search, temp upload, …) |
| `resources.rs` | Roots, pinned folders, collections, revisions, `Capabilities`, `TempRootInfo` |
| `search.rs` | Workspace Search request/result types |
| `agent.rs` | Agent identity / info shapes used at register time |
| `denylist.rs` | Default-deny sensitive paths even inside allowed roots |
| `temp.rs` | Shared temp-upload name validation (single path component) |
| `herdr.rs` | Herdr CLI whitelist types (`status`/`read`/`prompt`/`send_keys`) |

Herdr settings use `HerdrSettingsSet` / `HerdrSettingsApplied` with
generation-owned acknowledgements. `Capabilities.herdr_settings` exposes
effective enablement and the environment lock separately from CLI availability
(`herdr`).

**Capability flags that matter:** `pinned_folders`, `collections`,
`workspace_search`, `temp_upload`, `herdr`. Older agents omit them; the Hub returns
unsupported rather than silently no-op'ing. Vestigial flags
(`image_preview`, `pdf_preview`, `serve_dir`) default `false` and are not
gated on.

## `hub` — control plane + API

Axum server. Serves the built frontend from disk (`ServeDir`), authenticates
users, holds the live agent registry, and proxies file/search ops over the
agent WebSocket.

| Module | Responsibility |
|---|---|
| `routes.rs` / `routes/` | HTTP route assembly; separate middleware, session, access-token, preview, cancel, root and collection handlers |
| `auth.rs` | bcrypt users, session cookies, per-IP login rate limit |
| `pow.rs` | Self-hosted login proof-of-work challenges |
| `net.rs` | Client IP / `FILEBOX_TRUST_XFF` |
| `ws.rs` / `ws/` | Agent WSS upgrade, bounded authentication, generation-owned session, registration, dispatch and state acknowledgements |
| `agent_requests.rs` | Shared response-channel identity, client-disconnect cleanup and generation-bound cancellation |
| `agent_registry.rs` | Online/offline lifecycle; coalesced pending root/collection updates; `config_error` |
| `fs_proxy.rs` | List / stat / raw file proxy to agent WS |
| `search_proxy.rs` | Workspace Search proxy (long timeout, cancel binding) |
| `temp_proxy.rs` | Temp-folder upload relay (streams body → WS chunks) + one-click cleanup |
| `herdr_proxy.rs` | Herdr CLI relay (`POST /api/agents/{id}/herdr`); prompts pass the mandatory review choke point with Hub-read window context |
| `prompt_review.rs` | Herdr prompt LLM review: file-only config, DeepSeek chat-completions / responses / messages, strict verdict parsing |
| `preview_doc.rs` | Sandboxed HTML/notebook navigation, locked base/CSP, relative links and 64 MiB document cap |
| `ipynb_preview.rs` | Read-only nbformat-to-HTML washer; sanitized Markdown, escaped code/text and bounded image outputs; no kernel/widgets/HTML output execution |
| `audit.rs` | Login audit trail |
| `events.rs` | SSE fanout to browsers |
| `health.rs` | Liveness + version |
| `config.rs` / `state.rs` | Config load + shared `AppState` |

Notable invariants (see also root [`CLAUDE.md`](../CLAUDE.md)):

- New `Register` for an existing `agent_id` aborts the old connection;
  `unregister` checks `same_channel()` so a stale socket cannot clobber a
  fresh one.
- Offline root/collection edits coalesce into a single pending update
  (last write wins). Rejection never destroys last known-good state.
- Authentication runs in at most four native bcrypt jobs, without holding the
  registry lock. Registration and its connected event are published atomically.
- Replacement registration transfers old in-flight desired updates before
  announcing the new generation. Delayed acknowledgements cannot consume a newer
  coalesced edit; request cleanup checks channel identity as well as generation.
- Agent ingress never waits on HTTP response queues. Cancel waits at most 5s for
  the captured sender, then aborts only that transport so workers are released.
  Congested deliveries survive caller cancellation, with at most 256 background
  waits. Office cancellation reserves caller-chosen IDs before releasing locks.
  Upload chunks remain on their Begin generation and wait at most 10s for space.
- FileChunk JSON is parsed once and bytes are decoded only by the HTTP consumer;
  base64 and legacy byte arrays remain supported, with unchanged wire framing.
- Body limit is 1MB; resource/collection payloads stay tiny by design.
- Session and CSRF cookies use an opaque eight-hex suffix derived from the
  Agent-token hash and listen port (`__Host-` names in production). Frontend
  bootstrap reads it from `/api/health`; changing the inputs requires re-login.

## `agent` — data plane on the machine

Outbound-only Tokio process. Reconnects forever with backoff/jitter.
Persists identity and desired config under `data_dir` (`agent_state.json`).

| Module | Responsibility |
|---|---|
| `connection.rs` | Reconnect/backoff, fair bounded writer, shared filesystem job admission |
| `connection/runtime.rs` | Resource state, caches, Herdr settings and worker limits that survive reconnects |
| `connection/handshake.rs` | Bounded connect/auth/register and capability advertisement |
| `connection/session.rs` | Transport queues, liveness, dispatch, shutdown/Drop cancellation |
| `connection/{resources,filesystem,search,office,uploads,herdr,control}.rs` | Business handlers borrowing the connection context |
| `resources.rs` | Validate + atomically apply roots / pins / collections |
| `config_store.rs` | Persist `agent_id`, roots, pins, collections, revisions and `herdr_enabled` |
| `fs.rs` | Read-only list/stat/read with path safety + denylist |
| `dir_cache.rs` | mtime-keyed directory listing cache (capped; cleared on root apply) |
| `search.rs` | In-process fd/rg-like Workspace Search (`ignore` + `regex`) |
| `sysinfo.rs` | TTL-cached system stats (HPC-safe refresh) |
| `temp_store.rs` | Dedicated file-upload write path (staging, quotas, no-clobber publish, symlink-safe cleanup); also used by Transfer image paste |
| `herdr.rs` | Optional local Herdr CLI probe (`FILEBOX_AGENT_HERDR` / PATH) and argv-only whitelist |
| `config.rs` | TOML / env bootstrap |

The receive loop reserves two control reply slots before accepting a request,
so resource/collection `Updated` always precedes its `Applied` reply. Business
handlers never await socket writes or upload queue capacity. Temp uploads use
four worker permits shared across reconnects, at most sixteen 512 KiB chunks
per upload, and worker-owned staging cleanup. Queue congestion terminates only
the upload with `temp_upload_stalled`.
`ConnectionSession::Drop` sets cancellation flags and aborts its async wrappers/writer. Native filesystem calls cannot be
forcibly stopped; they retain global worker permits until they return.

The Agent uses **two Tokio async workers** and serial sysinfo collection on a
blocking worker, not an all-core Rayon scan. Cached stats reads use a separate
snapshot lock and cold requests share one collection. This is not CPU affinity
or a process/child CPU quota; blocking filesystem I/O has its own pool. There
is no CPU-limit config field or environment variable for this fixed policy.

### Herdr configuration and settings

Install a matching Herdr CLI/server on the Agent host (tested with v0.9.5).
Discovery uses `FILEBOX_AGENT_HERDR` or PATH. The Agent only invokes list, read,
prompt and allowlisted send-keys as argv, never shell commands. Requests have
bounded output, deadlines and cancellation; disabling Filebox integration does
not stop Herdr or its coding agents.

`herdr_enabled` defaults to `true` in `agent_state.json` under `data_dir`.
The per-Agent web switch sends `POST /api/agents/{id}/herdr-settings` through
the Hub to the Agent, which persists using the existing state store before
acknowledging and updating capabilities/SSE. It is not an `agent.toml` field.
`FILEBOX_AGENT_HERDR_ENABLED` is a startup override: `0`/`false` disables
discovery/probing and requests, `1`/`true` enables, and invalid values disable.
Any explicit override locks the web switch; unset it and restart to use saved
settings. New installations show onboarding and Check installation can reprobe
the current executable search path. Offline/legacy Agents cannot save settings.

Prompt review is separate from this Agent switch. By default the Hub refuses
prompts without `herdr_prompt_review` in `hub.json` or on provider failure.
Only `FILEBOX_HUB_HERDR_PROMPT_REVIEW_ENABLED=0`/`false` at startup restores
unreviewed relay; no runtime endpoint changes provider configuration. The Hub
reads target-window context itself before review and relays exactly the reviewed
prompt through one choke point. Status/read/keys are not reviewed. See
[the configuration table](../README.md#configuration-reference) and
[Herdr compatibility](../docs/herdr-compatibility.md) for provider fields,
HTTPS requirements, privacy, timeout budgets and detection limits.

### Preview and Transfer clients

The browser's read-only Monaco viewer highlights Quarto/R Markdown source
(`.qmd`, `.rmd`, `.rmarkdown`) without running chunks. `.ipynb` uses Hub-washed
HTML in the same sandboxed session path as `.html`/`.htm`; arbitrary notebook
HTML, widgets and JavaScript outputs are omitted. The HTML CSP permits embedded
`data:` styles/scripts for self-contained documents while restricting network
access. Confirmation gates are 2 MiB for HTML and 15 MiB for notebooks; document
reads have a 64 MiB hard cap.

Pinned previews preserve state: PDF/Office/HTML/notebook sessions park offscreen
(at most three inactive heavy mounts); lighter viewers restore saved state.
Evicted heavy mounts may reload and lose live state. Clicking a preview path
navigates to its folder in Files/Explorer (Collections switches to Files).
Markdown math supports dollar, bracket and parenthesis delimiters through KaTeX;
see [syntax and escaping](../README.md#markdown-math).

Transfer image paste uses the existing bounded temp-upload protocol, not a new
write API. Clipboard uploads leave editable-input paste alone and consume one
clipboard file source to avoid duplicate images.


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
