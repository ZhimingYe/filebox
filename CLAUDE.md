# CLAUDE.md

> **Bringing the stack up locally or debugging a "nothing works" symptom?**
> Read **[`docs/local-debugging.md`](docs/local-debugging.md)** first. It is a
> runbook for local bring-up, backend API probes, and the environment traps
> (stale processes, HSTS poisoning, cookie clearing, proxy interception) that
> reading code will never reveal. Default discipline: make `curl` work
> end-to-end before blaming the frontend.

## What This Is

Filebox is a **read-only remote file browser with system monitoring**. User
logs into one HTTPS web page, sees backend machines ("Agents") that have
dialed out to a central Hub, and browses files / reads system stats.

```text
Browser ──HTTPS──▶ Hub ◀──WSS (outbound)── Agent ──▶ local files + sysinfo
```

Agents connect outward; browsers never touch agents directly. Backend
machines need no public IP, inbound port, VPN, or port mapping.

## Out of Scope (do not resurrect without explicit sign-off)

- Write / edit / delete / rename files
- Shell execution, terminal, remote desktop
- Arbitrary TCP proxying, LAN scanning, **port forwarding** (an earlier
  draft planned a port-tunnel feature; it was dropped)
- WebDAV, sync drive behavior
- Multi-tenant user management, RBAC, audit log

## Hard Rules

- **NEVER run `git checkout -- <file>`, `git restore <file>`, `git reset --hard`,
  or any destructive git command without first showing `git diff` of exactly
  what will be lost and getting explicit confirmation.** This has caused
  catastrophic data loss before — uncommitted working-tree changes are
  irrecoverable. When you need to revert a specific edit you made, use the
  Edit tool to undo that specific edit, not a git command that nukes the
  entire file.
- **Frontend is the control surface.** Roots are managed from the UI. CLI
  is bootstrap / automation / recovery only.
- **Read-only.** Never add writes, shell, or arbitrary proxying.
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

**Frontend** (`frontend/`): TypeScript + Vite + React. Heavy preview
components are `React.lazy()`-loaded (`PdfPreview`, `TextPreview`,
`MarkdownPreview`, `HtmlPreview`, `CsvPreview`); `ImagePreview` stays inline.
`previewShared.tsx` holds shared utilities. `PreviewPane` is a memoized
dispatcher — memoization is what stops splitter-drag stutter. Vite
`manualChunks` splits react / highlighter / markdown vendor chunks so
deployments that don't bump a vendor reuse the cached chunk. PDF uses
`react-pdf` + `pdfjs-dist` worker (bundled via
`new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)`) because
some mobile browsers ship no native PDF viewer.

**Hub** (`crates/hub/`): Rust + Tokio + Axum + tower-http +
tokio-tungstenite. Serves the built frontend via `ServeDir`. 1MB body
limit. CORS mirrors request origin (credentials need non-`*` ACAO). See
`routes.rs` for the full route table; `auth.rs` (bcrypt + sessions +
per-IP login rate limit), `agent_registry.rs` (lifecycle + coalesced
pending root updates + config_error), `ws.rs` (agent WSS handler with
abort-on-reregister), `events.rs` (SSE fanout), `fs_proxy.rs` (proxies
file ops to agent WS), `health.rs`.

**Agent** (`crates/agent/`): Rust + Tokio + tokio-tungstenite (rustls
webpki-roots) + sysinfo. Connects outward, reconnects forever.
`connection.rs` (reconnect loop — see "Reconnect & liveness" below),
`resources.rs` (validate + apply root updates atomically; bad updates
never destroy last good state), `fs.rs` (read-only ops + path safety +
denylist), `sysinfo.rs` (TTL-cached stats — see below), `config_store.rs`
(persists `agent_id`, roots, revision under `data_dir`).

**Protocol** (`crates/protocol/`): JSON over WS, tagged enums in
`message.rs`. Every request has `req_id`, supports `Cancel` / `Progress` /
`Error` / terminal response. File reads stream as `FileChunk { offset,
data, done }` — agent never slurps whole files. `Capabilities` struct has
vestigial flags (`image_preview`, `pdf_preview`, `serve_dir`) that default
`false` and aren't gated on — don't read meaning into them.

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

Roots are a dynamic allowlist, not hardcoded.

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

## Security

- Users: bcrypt-hashed passwords in `hub.json`. Sessions: `HttpOnly;
  Secure; SameSite=Strict` cookies.
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

## Preview Behavior

- **Markdown**: fetch raw → render → sanitize HTML → safe mode for large.
- **Code**: Prism via react-syntax-highlighter, word-wrap toggle. Disable
  highlighter for large files (plain `<pre>` fallback). Partial /
  virtualized for very large.
- **PDF**: react-pdf, range requests honored, never force full download,
  slow detection at 8s.
- **Image**: large OK (30MB+); judge by decoded dimensions/memory not
  just size; downscaled preview when needed; slow detection at 8s.
- **HTML**: Blob URL with `<base>` injection. Toolbar with open-in-new-tab
  + copy-HTML. Sanitization not enforced — previewing attacker-controlled
  HTML is out of threat-model scope for this trusted-internal tool.
- **CSV**: rendered as table.
- **Long ops**: `LoadingOverlay` shows spinner + (after 8s) slow warning.
  Does not force cancel — user waits or cancels.

## Repo Layout

```text
filebox/
  CLAUDE.md
  Cargo.toml                # Rust workspace
  README.md
  crates/
    protocol/src/           # message.rs (tagged enums), agent.rs, resources.rs,
                            # denylist.rs
    hub/src/                # main.rs, config.rs, routes.rs, state.rs, ws.rs,
                            # auth.rs, agent_registry.rs, events.rs, fs_proxy.rs,
                            # health.rs
    agent/src/              # main.rs, config.rs, config_store.rs, connection.rs,
                            # resources.rs, fs.rs, sysinfo.rs
  frontend/
    vite.config.ts          # manualChunks: react / highlighter / markdown vendor
    src/
      App.tsx               # layout, sidebar, routing, mobile drawer, toasts
      theme.ts              # all design tokens
      api/client.ts         # fetch wrapper + types
      state/                # session, events (SSE), health, useIsMobile
      components/
        Login BackendList FileBrowser PreviewPane previewShared
        {Pdf,Text,Markdown,Html,Csv}Preview   # lazy
        AgentSettings RootManager HealthPanel SystemStats
  scripts/
    release.sh              # bump + commit + tag + push → triggers release.yml
    gen_notice.sh           # refreshes Rust/frontend license manifests
  .github/workflows/
    release.yml             # v* tag → musl tarballs + GitHub Release
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

- When touching the reconnect path or the sysinfo cache, re-read the code
  first. Both have non-obvious invariants (abort-on-reregister,
  `same_channel` ownership check, atomic `refreshing` flag, stable-conn
  backoff reset) that a "small" refactor can break silently.
- Hub body limit is 1MB. Resource payloads are tiny by design — don't
  raise this without reason.
- The Hub→Agent WS is a single JSON channel; large file reads stream as
  `FileChunk` on the same channel but never block control messages
  (agent's read loop is independent of its writer; writes have a 10s
  timeout).

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
- **Browser testing gotchas:** the login username field shows `admin` only
  as *placeholder* text — you must actually type the username or the login
  hangs. Use `http://localhost:3000` (not `127.0.0.1`) to avoid HSTS
  upgrade traps, and prefer an Incognito window to sidestep stale
  cookie/HSTS state.
