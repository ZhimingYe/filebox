# CLAUDE.md

> **Bringing the stack up locally or debugging a "nothing works" symptom?**
> Read **[`docs/local-debugging.md`](docs/local-debugging.md)** first. It is a
> runbook for local bring-up, backend API probes, and the environment traps
> (stale processes, HSTS poisoning, cookie clearing, proxy interception) that
> reading code will never reveal. Default discipline: make `curl` work
> end-to-end before blaming the frontend.

## What This Is

filebox is a **read-only remote file browser with system monitoring**.
User logs into one HTTPS web page, sees backend machines ("Agents") that
have dialed out to a central Hub, browses files, searches workspaces,
organizes virtual collections, and reads system stats.

```text
Browser ──HTTPS──▶ Hub ◀──WSS (outbound)── Agent ──▶ local files + sysinfo
```

Agents connect outward; browsers never touch agents directly. Backend
machines need no public IP, inbound port, VPN, or port mapping.

## Out of Scope (do not resurrect without explicit sign-off)

- Write / edit / delete / rename files — **sole sanctioned exception: the
  per-agent temp-upload folder** (see "Temp Upload Folder" below). The agent
  writes ONLY inside `<temp base>/<upload folder>` and nothing else, ever.
- Shell execution, terminal, remote desktop
- Arbitrary TCP proxying, LAN scanning, **port forwarding** (an earlier
  draft planned a port-tunnel feature; it was dropped)
- WebDAV, sync drive behavior
- Multi-tenant user management, RBAC, general audit log (only the
  **login audit trail** exists — see "Login Audit" below)

## Hard Rules

- **NEVER run `git checkout -- <file>`, `git restore <file>`, `git reset --hard`,
  or any destructive git command without first showing `git diff` of exactly
  what will be lost and getting explicit confirmation.** This has caused
  catastrophic data loss before — uncommitted working-tree changes are
  irrecoverable. When you need to revert a specific edit you made, use the
  Edit tool to undo that specific edit, not a git command that nukes the
  entire file.
- **Frontend is the control surface.** Roots, pins, and collections are
  managed from the UI. CLI is bootstrap / automation / recovery only.
- **Read-only.** Never add writes, shell, or arbitrary proxying. The ONLY
  write path is the temp-upload folder (browser drag-drop → hub relay →
  agent writes into its dedicated folder). Nothing else writes.
- **Reconnect forever.** Survives 24h+ outages; identity persists; no
  duplicate backend entries on reconnect.
- **Never freeze silently.** Long ops are fine, but every one needs visible
  progress, a cancel affordance, bounded memory/queue, no infinite spinner,
  and a clear failed / stalled / retryable state. Stalled = no progress,
  not "took a long time."
- **No emojis in the frontend.** Custom 16×16 SVG icons.
- **All UI tokens come from `frontend/src/theme.ts`.** No hardcoded colors.
  Inline styles only — no CSS modules, no Tailwind.
- **No drive-by formatting.** Do not run broad formatting tools such as
  `cargo fmt`, `rustfmt`, Prettier, or similar formatters unless the user
  explicitly asks for it, or unless formatting the touched file is strictly
  necessary to make a targeted change pass. Keep diffs focused on behavior
  and the lines you intentionally changed.

## Stack

**Frontend** (`frontend/`): TypeScript + Vite + React. Files and
Collections share `FileEntryList` / `WorkspaceSplit`. Workspace Search
renders in `SearchFloatWindow` (desktop: a draggable / resizable floating
window, geometry persisted in localStorage) or `SearchBottomSheet` (mobile:
an iOS-style bottom sheet over the lower half of the screen with swipe-down
dismiss) — both overlay the current view instead of replacing it, while
staying mounted when closed so long scans survive. Heavy preview components are
`React.lazy()`-loaded (`PdfPreview`, `TextPreview`, `MarkdownPreview`,
`HtmlPreview`, `CsvPreview`, `ImagePreview`). `PreviewWorkspace` owns
multi-tab state; `PreviewPane` is a memoized dispatcher — memoization is
what stops splitter-drag stutter. Vite `manualChunks` splits react /
markdown / tiff vendor chunks so deployments that don't bump a vendor
reuse the cached chunk. Monaco is kept behind the `TextPreview` lazy
import (do not force it into a manual chunk — that previously pulled the
~4MB editor into the main preload). PDF uses `react-pdf` + `pdfjs-dist`
worker (bundled via
`new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)`) because
some mobile browsers ship no native PDF viewer.

**Hub** (`crates/hub/`): Rust + Tokio + Axum + tower-http +
tokio-tungstenite. Serves the built frontend via `ServeDir`. 1MB body
limit. CORS mirrors request origin (credentials need non-`*` ACAO). See
`routes.rs` for the full route table; `auth.rs` (bcrypt + sessions +
per-IP login rate limit), `pow.rs` (self-hosted login proof-of-work
challenges), `net.rs` (`FILEBOX_TRUST_XFF` for client IP),
`agent_registry.rs` (lifecycle + coalesced pending root/collection
updates + config_error), `ws.rs` (agent WSS handler with
abort-on-reregister), `events.rs` (SSE fanout), `fs_proxy.rs` (proxies
file ops to agent WS), `search_proxy.rs` (workspace search),
`temp_proxy.rs` (temp-folder upload relay + cleanup), `health.rs`.

**Agent** (`crates/agent/`): Rust + Tokio + tokio-tungstenite (rustls
webpki-roots) + sysinfo. Connects outward, reconnects forever.
`connection.rs` (reconnect loop — see "Reconnect & liveness" below),
`resources.rs` (validate + apply root/pin/collection updates atomically;
bad updates never destroy last good state), `fs.rs` (read-only ops + path
safety + denylist), `search.rs` (in-process fd/rg-like workspace search),
`dir_cache.rs` (mtime-keyed directory listing cache, cleared on root
apply, capped), `sysinfo.rs` (TTL-cached stats — see below),
`temp_store.rs` (the ONLY write path: dedicated temp-upload folder),
`config_store.rs` (persists `agent_id`, roots, pins, collections,
revisions under `data_dir` in `agent_state.json`).

**Updater** (`crates/updater/`): shared CLI for hub and agent —
`--init-config` (interactive bcrypt hashing, `0600` files) and `--update`
(download musl release tarball, verify `SHA256SUMS.txt`, refuse downgrade
by default; mirrors via `--update-base-url`).

**Protocol** (`crates/protocol/`): JSON over WS, tagged enums in
`message.rs`. Every request has `req_id`, supports `Cancel` / `Progress` /
`Error` / terminal response. File reads stream as `FileChunk { offset,
data, done }` — agent never slurps whole files. Search types live in
`search.rs`. `Capabilities` gates real features (`pinned_folders`,
`collections`, `workspace_search`); vestigial flags (`image_preview`,
`pdf_preview`, `serve_dir`) default `false` and aren't gated on — don't
read meaning into them.

## Reconnect & Liveness (non-obvious invariants)

Both sides were hardened specifically for "very flaky network" scenarios.
Re-read `crates/agent/src/connection.rs` and `crates/hub/src/{ws.rs,
agent_registry.rs}` before touching this path.

**Agent:**

- `CONNECT_TIMEOUT = 10s` — give up on handshake, retry.
- `NO_MESSAGE_TIMEOUT = 45s` — proactively reconnect if nothing (data or
  Ping) for 45s. Catches half-open connections the kernel hasn't noticed.
- `WS_WRITE_TIMEOUT = 10s` — writes blocking longer than 10s abort the
  connection. Prevents stuck TCP send buffer from freezing the agent.
- `STABLE_CONNECTION_THRESHOLD = 30s` — a connection that lasted ≥30s is
  "stable"; its next disconnect resets backoff to 1s. A flapping
  connection keeps growing backoff.
- Backoff: 1s base, doubles per consecutive flap, capped at 300s, with
  up-to-half-of-base jitter (so a cohort of agents reconnecting after a
  hub restart doesn't synchronize).
- Always sends a clean `Close` frame before reconnecting when possible.
- URL scheme: `http(s)://` hub URL → `ws(s)://`. TLS via rustls
  webpki-roots (no OS cert store dependency).

**Hub:**

- Per-connection `Arc<Notify>` abort handle. New `Register` for an existing
  `agent_id` calls `notify_one()` on the old handle; the old read loop
  exits cleanly via its `tokio::select!` abort arm.
- `unregister` verifies `same_channel()` between caller's sender and
  registry entry before tearing down — a slow old connection can't
  clobber a fresh one's status back to Offline.
- Only emits `agent_disconnected` SSE on normal-close exits, not on abort,
  so reconnect-driven rotation doesn't flash spurious offline to the UI.

## Sysinfo TTL Cache (non-obvious invariant)

HPC boxes (terabyte memory, tens of thousands of PIDs) make each
`sysinfo` refresh take seconds. Naive per-request refresh froze the agent.
`StatsCache` (`crates/agent/src/sysinfo.rs`) does:

- **Fresh** (within TTL): return cached instantly.
- **Stale** (past TTL): return cached + schedule a background
  `spawn_blocking` refresh. Concurrent requests collapse into one refresh
  via an atomic `refreshing` flag (CAS).
- **Cold** (no cache yet): synchronous `spawn_blocking` refresh so the
  first request still returns real data, just slower.
- The `System` instance is reused across refreshes so CPU deltas compute
  correctly without an extra sleep.

TTL configurable via `FILEBOX_AGENT_STATS_TTL_SECS` (default 60). No
periodic timer — if nobody asks, no work happens.

## Runtime Resource Management (roots)

Roots are a dynamic allowlist, not hardcoded. Paths may be absolute or
home-relative (`~` / `~/…`); the agent expands `~` against its own `$HOME`
and rejects escapes.

```text
Frontend POST /api/agents/{id}/roots
  → Hub validates name/path, rewrites desired set
  → Hub sends ResourcesSetDesired { req_id, desired_revision, roots }
  → Agent validates, applies atomically, persists, replies ResourcesApplied
  → Hub updates registry, broadcasts via SSE
```

If agent offline: hub calls `set_pending_update` (coalesced — replaces any
prior pending; last write wins, no queue), returns
`state: "pending_agent_reconnect"`, applies on reconnect.

If agent rejects (e.g. path missing): hub stores the message as
`config_error`, surfaces via SSE. **Bad updates never destroy last known
good state.** Rejection is non-destructive.

Pinned folders are per-root path lists on the same resources channel
(`pin_add` / `pin_remove` PATCH deltas), gated by
`capabilities.pinned_folders`.

## Virtual Collections

Collections are per-agent named lists of file references (`root` +
root-relative `path`). Items may span multiple roots. They are virtual —
no files are copied or moved on disk. Existence is not checked on apply;
the UI probes `fsStat` and shows ok / missing / denied.

```text
Frontend POST/PATCH/DELETE /api/agents/{id}/collections
  → Hub rewrites DesiredCollections (collections_revision++)
  → Hub sends CollectionsSetDesired over WS
  → Agent validates, persists agent_state.json, replies CollectionsApplied
  → Hub mirrors state, SSE collections_updated
```

Offline: `pending_collections_update` (coalesced). Reject clears pending and
keeps last good collections. Legacy agents without
`capabilities.collections` get `400 unsupported_feature`. Revision is
independent of `resource_revision`.

## Workspace Search

Sibling of Files/Collections (sidebar **Search**). In-process on the
agent (`ignore` + `regex`) — no system `fd`/`rg` binaries.

| Mode | Behavior |
|---|---|
| `find` (Files) | Case-insensitive filename substring (fd-like); empty query matches all names |
| `content` (Content) | Case-insensitive regex over file lines (rg-like), with ±context |

Scoped to one enabled root + optional folder under that root. Optional
extension filter (extensions only, not globs). Per-request `ignore`
(path-component names; UI defaults cover `renv`/`venv`/…) and
`max_depth` (directory layers under the search folder). Same path
safety / denylist / no-symlink-follow as `fs.rs`. Content mode skips
binaries (NUL in first 8 KiB) and files > 1 MiB.

```text
Frontend POST /api/agents/{id}/workspace-search
  → HubMessage::WorkspaceSearchRequest
  → Agent spawn_blocking run_search (+ Progress phase "search")
  → AgentMessage::WorkspaceSearchResponse
```

Hardening: result/scan caps, ~512 KiB payload soft limit, 9 min agent
deadline / 10 min hub wait, one concurrent search per agent, cancel via
`/api/cancel` (and on client disconnect). Gated by
`capabilities.workspace_search`. Hitting a result opens the parent folder in
the current browsing mode: in Files it navigates there as before; in
Explorer it stays in the tree, which expands to the folder and shows a
"Located the folder." notice once the reveal settles (a vanished folder
settles on the nearest existing ancestor with an honest fallback notice).
The browser also restores the last selected agent, the Files/Explorer mode,
and the per-agent/per-root browse position after a refresh; a restored
folder that no longer exists falls back to the nearest existing ancestor
(validated once per (agent, root) pair per session via `fsStat` — the pair
is only marked validated after the probe completes, so a navigation away
mid-probe doesn't burn the check), and a removed backend is simply not
re-selected. The Search view stays mounted when hidden so long scans
survive navigation.

## Temp Upload Folder (the ONLY write path)

The agent maintains a dedicated scratch folder and writes ONLY there:
`<temp base>/<upload folder>` (defaults `<data_dir>/temp` /
`agent-temp-copied-file`; env `FILEBOX_AGENT_TEMP_DIR`,
`FILEBOX_AGENT_TEMP_UPLOAD_NAME`, or agent.toml `temp_dir` /
`temp_upload_name`). The browser drags small files onto the hub (app-wide
drop overlay in `App.tsx`; upload/clean buttons in `FileBrowser.tsx`);
the hub relays bytes over the agent WS; the agent writes them into the
folder. The folder appears in the root selector as a synthetic root and is
browsable/readable like any root. "一键清理" = the trash button on that
root view (`POST /api/agents/{id}/temp-cleanup`), which deletes every
entry inside the folder (never the folder itself, never symlink targets).

```text
Drop files → POST /api/agents/{id}/temp-upload?name=…  (body = raw bytes)
  → Hub validates name + Content-Length, caps body at 64 MiB, 4 concurrent
    uploads, streams TempUploadBegin/Chunk(done) over WS
  → Agent temp_store.rs: validates name/quotas, writes into 0700 staging,
    hard-links (atomic no-clobber) into the 0700 upload folder, verifies
    the canonical final path stays inside, replies TempUploadResponse
```

Security invariants (`crates/agent/src/temp_store.rs` is the authority):

- **Only writes inside the folder.** Names are single path components
  (`crates/protocol/src/temp.rs` validates: no `/` `\` NUL `..`), so a
  name can never escape. The final published path is canonicalized and
  re-verified inside the folder before acceptance.
- **Never overwrites.** Collisions get a ` (2)`-style suffix; publish uses
  `hard_link` (atomic, fails on existing target).
- **Quotas.** Per-file cap (`max_file_bytes`, default 20 MiB, hub body cap
  64 MiB) and total folder quota (default 1 GiB, reservation-based;
  accounting survives restarts). Exceed → 413 / 507 `temp_quota_exceeded`.
- **No symlink following.** Staging files open with `O_NOFOLLOW`;
  cleanup unlinks symlinks instead of their targets and refuses to run if
  the folder itself was swapped for a symlink. Staging leftovers are
  reaped at startup; sessions are aborted on Cancel / disconnect.
- **Privacy of the folder**: 0700 dirs, 0600 files. Reads of uploaded
  files still go through the standard fs denylist, so a dropped `id_rsa`
  shows as denied (it can be cleaned up, not re-read).
- Gated by `capabilities.temp_upload` (false when the folder can't be
  initialized or for legacy agents → `unsupported_feature`). Uploads also
  ride the normal session + CSRF protection.

## Security

- Users: bcrypt-hashed passwords in `hub.json`. Sessions: `HttpOnly;
  Secure; SameSite=Strict` cookies.
- **Login proof of work** (`crates/hub/src/pow.rs`): self-hosted effort
  check. `GET /api/pow/challenge` (public, per-IP rate limited, `no-store`)
  issues `{ id, salt, difficulty }` (default 20, env `FILEBOX_POW_DIFFICULTY`,
  clamped 12–24). Login must echo `pow_id` + `pow_nonce` proving
  `sha256("{id}:{salt}:{nonce}")` has ≥ difficulty leading zero bits —
  verified in a single hash server-side (wire format must match the
  frontend solver `frontend/src/lib/pow.ts` byte-for-byte). Challenges are
  in-memory, single-use (consumed by the first verification, valid or not),
  5-min TTL, bounded per IP and globally. Failed proofs are audited as
  `pow_failed`. Rate-limit split (deliberate): proof failures do NOT
  consume the password-attempt budget (otherwise five zero-work requests
  could lock out a NAT-sharing user); a separate 60/min-per-IP request
  bound on the login POST caps garbage traffic, only credential failures
  burn the 5/30s password budget, and a successful login clears all three
  limits. The nonce is any ASCII decimal string ≤ 20 digits (the browser
  solver zero-pads to a fixed 16; the python helpers don't pad) — the
  verifier hashes the submitted string verbatim. Verifies effort, not
  humanity — the per-IP password limiter remains the primary brute-force
  defense; PoW prices each guess in CPU. No external service — works on
  air-gapped hubs.
- Agents: bcrypt-hashed token in `hub.json`. Token separate from user
  session.
- Login is rate-limited per IP (`state.rate_limiter`).
- **Path safety** (every file request):
  1. Receive root name + relative path.
  2. Resolve active root by name.
  3. Join, normalize, canonicalize when possible.
  4. Verify final path remains inside root.
  5. Reject symlink escape.
  6. Apply denylist.
  7. Open read-only.

  Never trust browser paths. Never allow `../`. Never follow symlinks
  outside the root.
- **Sensitive denylist** (`crates/protocol/src/denylist.rs`):
  default-deny privacy-sensitive files even inside allowed roots. Covers
  `.git/`, `.ssh/`, `.gnupg/`, `.env*`, shell rc + history files, cloud
  CLI credential dirs (`.aws/`, `.azure/`, `.gcloud/`, `.kube/`,
  `.docker/`, `.cargo/credentials*`), private keys (`*.pem`, `*.key`,
  `id_*`), `credentials*.json`, `*.sqlite*`, `*.keychain`, and more.
  Denied entries may be shown as "denied" (so the user knows they exist)
  but never previewable. Read-only access can still leak secrets — that's
  why the list is broad.

## Login Audit (non-obvious invariants)

The hub records every `login_success`, `login_failed`, `login_rate_limited`,
`pow_failed`, and `logout` with username, client IP, user agent, and
timestamp
(`crates/hub/src/audit.rs`), and exposes them read-only via
`GET /api/audit/logins?limit=&before=` (session + CSRF protected; `before`
is an exclusive entry id for paging backwards). The sidebar **Audit** view
(lives on the hub, so it works with no agent selected) renders it newest
first with "Load older" paging.

- **Persistence**: JSONL sidecar `audit-log.jsonl` next to the hub config
  (dev mode: cwd, gitignored), mode 0600. Records survive restarts; ids
  keep increasing across reloads so `before` cursors stay stable.
- **Bounded**: in-memory ring caps at 2000 entries (evicted entries are
  gone — `has_more` never pages past them). The file is compacted
  (temp file + rename, keeping only the in-memory tail) once it exceeds
  ~1.5× the cap. Username/IP/UA strings are length-capped before they
  touch disk.
- **Never fails login**: any persistence error degrades to in-memory-only
  with one warning per streak — auditing must not block or reject auth.
- **Attribution**: `Session.username` exists specifically so `logout` can
  be attributed after the session is removed (captured before removal).
  Keep it set when touching session lifecycle.

## Preview Behavior

- **Workspace**: multi-tab on desktop (`PreviewWorkspace` +
  `usePreviewTabs`). Tabs are metadata: a tab's body mounts only while it
  is the active tab — unless the user **pins** the tab (pin button on the
  tab, or the tab context menu), in which case the body stays mounted
  hidden in the background so switching back is instant and viewer state
  (PDF page/zoom, image zoom, Monaco scroll) survives. Unpinned inactive
  tabs hold no viewer resources; pinned bodies are an explicit opt-in
  (each pinned HTML document stays fully rendered — the user's choice).
  The manual refresh button (`rev` bump) always re-fetches. Arrow keys
  walk files in the current directory or collection; Esc closes the active
  tab; context menu supports bulk close and pin; tab-jump dropdown among
  open tabs. `PreviewErrorBoundary` isolates viewer crashes. Hidden pinned
  panes are `visibility:hidden` + absolute off-flow positioning, never
  `display:none` — Chrome unloads the document of a `display:none` iframe
  (an HTML tab would reload white on switch-back), and `display:none`
  zeroes the ResizeObserver/IntersectionObserver measurements that keep
  virtualized PDF pages mounted (PDFs would unmount and re-render every
  page on switch-back). **Safari exception: iframe-bearing panes (HTML
  preview) must NOT use `visibility:hidden` either** — WebKit fails to
  repaint a hidden-then-shown iframe (intermittent white screen) and its
  wheel scrolling gets stuck. HTML panes hide OFFScreen instead (parked
  10000px left, real size, fully rendered) + `inert`/`aria-hidden` while
  hidden. The hidden Files/Explorer shells in `App.tsx` (`filesViewHidden`)
  follow the same visibility rule.
- **Markdown**: fetch raw → render → sanitize HTML → safe mode for large.
- **Code**: Monaco Editor (read-only), word-wrap toggle, Find (Ctrl/Cmd+F).
  Lazy-loaded via `TextPreview`; large files gated by size threshold
  (Monaco virtualizes rendering so Prism-style truncation is gone).
- **PDF**: react-pdf, range requests honored, never force full download,
  slow detection at 8s.
- **Image**: `React.lazy()`-loaded. Large OK (30MB+); judge by decoded
  dimensions/memory; downscale before display (max edge 8192, max
  ~16M pixels; GIF/SVG not re-encoded). Stage fits tall images; wheel /
  pinch zoom, pointer pan when zoomed, toolbar ± / rotate / Reset.
  Slow detection at 8s.
- **HTML**: sandboxed preview sessions (`/api/preview/sessions` + token
  resource fetch). The iframe loads the session's `document_url` directly;
  the hub serves **navigation** requests (`Sec-Fetch-Mode: navigate` /
  `nested-navigate`) in document mode — byte-level injected `<base>` (absolute
  origin from `X-Forwarded-Proto` + `Host`, captured at session creation),
  CSP meta, charset meta, and a capture-phase click fixup for `#fragment`
  links (the injected base would otherwise resolve them to the token
  directory). Subresources / HEAD / XHR stay in raw resource mode (locked
  down, `frame-ancestors 'none'`, `X-Frame-Options: DENY`). Document-mode
  responses carry a `x-filebox-preview-document` sentinel so the global
  `security_headers` layer skips its blanket `X-Frame-Options` for them;
  their CSP omits `frame-ancestors` so the sandboxed iframe and the blob
  new-window wrapper (both opaque origins) can render them. Whole documents
  are buffered for injection, capped at 64 MiB (413 `preview_too_large`);
  `../` stays a hard sandbox boundary. Non-UTF-8 pages pass through byte-
  intact. Sanitization not enforced — previewing attacker-controlled HTML
  is out of threat-model scope for this trusted-internal tool.
- **CSV**: rendered as table.
- **Long ops**: `LoadingOverlay` shows spinner + (after 8s) slow warning.
  Does not force cancel — user waits or cancels.

## Repo Layout

```text
filebox/
  CLAUDE.md
  Cargo.toml                # Rust workspace (protocol, updater, hub, agent)
  README.md
  NEWS.md
  docs/local-debugging.md   # local bring-up + curl probes
  crates/
    README.md               # Rust workspace architecture
    protocol/src/           # message.rs, agent.rs, resources.rs (roots/pins/
                            # collections), search.rs, denylist.rs, temp.rs
                            # (shared upload-name validation)
    updater/src/            # --init-config, --update
    hub/src/                # … + search_proxy.rs, temp_proxy.rs (upload relay),
                            # net.rs, audit.rs (login audit)
    agent/src/              # … + search.rs, dir_cache.rs, temp_store.rs
                            # (write-scoped temp upload folder)
  frontend/
    vite.config.ts          # manualChunks: react / markdown / tiff
                            # (Monaco stays behind TextPreview lazy import)
    src/
      App.tsx               # layout, sidebar: Files/Search/Collections/…
      theme.ts
      monacoSetup.ts        # Monaco workers/theme (loaded with TextPreview)
      api/client.ts
      hooks/                # usePreviewTabs
      state/                # session, events (SSE), health, useIsMobile
      components/
        Login BackendList FileBrowser FileEntryList WorkspaceSearch
        CollectionsView CollectionPicker WorkspaceSplit PreviewWorkspace
        PreviewPane previewShared {Pdf,Text,Markdown,Html,Csv,Image}Preview
        DirectoryTree AddressBar DateFilterControl PinnedFolders
        AgentSettings RootManager HealthPanel SystemStats AboutDialog
        LoginAudit
  scripts/
    release.sh
    gen_notice.sh
  .github/workflows/
    release.yml
```

## Deployment

**Pre-built Release (recommended):** static musl Linux x86_64 binaries on
the [Releases page](https://github.com/ZhimingYe/filebox/releases). The
pipeline (`.github/workflows/release.yml`) fires on `v*` tag, which
`scripts/release.sh` creates and pushes. Each release ships:

- `filebox-hub-<version>-x86_64-musl.tar.gz` — `bin/hub` + bundled
  `frontend/dist` + `hub.json.example`
- `filebox-agent-<version>-x86_64-musl.tar.gz` — `agent` binary +
  `agent.toml.example`
- `SHA256SUMS.txt`

Install:

```bash
tar xzf filebox-hub-*-x86_64-musl.tar.gz
./bin/hub --init-config                    # creates config/hub.json internally
./bin/hub
```

**Build from source:**

```bash
cd frontend && npm install && npm run build && cd ..
cargo build --release
```

**Behind nginx:** proxy to `127.0.0.1:3000`; for `/` set
`proxy_http_version 1.1` + `Upgrade`/`Connection: "upgrade"` (WebSocket);
set `proxy_buffering off` + `proxy_cache off` (SSE). Forward
`X-Forwarded-For` and `X-Forwarded-Proto`.

## Final Notes

- When touching the reconnect path, the sysinfo cache, or collections /
  roots apply, re-read the code first. Non-obvious invariants include
  abort-on-reregister, `same_channel` ownership check, atomic
  `refreshing` flag, stable-conn backoff reset, and independent
  `collections_revision` vs `resource_revision`.
- Hub body limit is 1MB. Resource / collection payloads are tiny by
  design — don't raise this without reason.
- The Hub→Agent WS is a single JSON channel; large file reads stream as
  `FileChunk` on the same channel but never block control messages
  (agent's read loop is independent of its writer; writes have a 10s
  timeout).
- `DirCache` on the agent caches directory listings by mtime (cap 256);
  cache hits re-stat the requested page so in-place edits surface, throttled
  per entry by a default 2s cooldown
  (`FILEBOX_AGENT_DIR_CACHE_RESTAT_COOLDOWN_MS`, 0 = stat every hit); it is
  cleared when roots are applied. Do not assume every list hits disk.
- Workspace Search is in-process (`ignore` + `regex`); do not assume
  system `fd`/`rg` binaries. One search per agent at a time; long scans
  must stay cancelable and progress-visible.

## Cursor Cloud specific instructions

The startup update script runs `rustup default stable` + `npm --prefix
frontend install`. It intentionally does **not** build — you must build
before running services.

- **Rust toolchain gotcha:** dependencies (e.g. `bcrypt 0.19`) require
  `edition2024`, so Rust **≥ 1.85** is mandatory. The base image's default
  toolchain (1.83) fails with `feature 'edition2024' is required`. The
  update script pins `rustup default stable`; if you ever hit that error,
  run `rustup default stable` yourself.
- **Build before run:** the Hub serves `frontend/dist` from disk (not
  embedded), so build the frontend first: `cd frontend && npm run build`.
  Then `cargo build` (debug binaries land at `target/debug/{hub,agent}`).
- **Dev bring-up** is documented in `docs/local-debugging.md` §1/§8. In
  short, with no config files: start the Hub with `FILEBOX_DEV_MODE=1`
  `FILEBOX_FRONTEND_DIR="$(pwd)/frontend/dist"`, then an Agent with
  `FILEBOX_AGENT_HUB=ws://127.0.0.1:3000 FILEBOX_AGENT_TOKEN=dev-token
  FILEBOX_ALLOW_INSECURE_HUB=1` (give each agent its own
  `FILEBOX_AGENT_DATA_DIR`). Dev login is `admin` / `dev-password`.
- **There is no mock backend:** the UI is useless without a live Hub AND a
  connected Agent. Add a root (Settings → Add Root, or `POST
  /api/agents/{id}/roots`) or the file list stays empty. Prove the data
  path with `curl` (see `docs/local-debugging.md` §2) before blaming the UI.
- **Browser testing gotchas:** type the username explicitly (`admin` in
  dev) — the login field has no username placeholder. Use
  `http://localhost:3000` (not `127.0.0.1`) to avoid HSTS upgrade traps,
  and prefer an Incognito window to sidestep stale cookie/HSTS state.
