# Local Debugging Guide

A runbook for bringing up Filebox locally and diagnosing problems. Written
for AI coding agents working in this repo, but useful for humans too.

**Read this before you `kill` a process or assume "the backend is broken."**
Most local-debugging failures are not in the code you just changed — they
are environment state (stale processes, poisoned browser caches, cookie
traps) that reading code will never reveal.

---

## 0. Mental model (read first)

```text
Browser ──HTTP──▶ Hub ◀──WS(outbound)── Agent ──▶ local files
```

- **The frontend is a thin client.** It renders nothing useful without a
  live Hub AND at least one connected Agent. A Vite dev server alone is not
  enough — there is no mock backend. If you see "No agents connected" or an
  empty file list, the data path (Hub → Agent → filesystem) is broken
  somewhere, not the UI.
- **Hub serves the built frontend** via `tower_http::ServeDir`, reading
  `frontend/dist` from disk at request time. It is **not** embedded at
  compile time, and **not** a Vite dev server. So after a frontend change
  you must `npm run build` (or `vite build`) — then the running Hub picks
  it up immediately, no Hub restart needed.
- **Agents dial out.** They hold a persistent WS to `/ws/agent` on the Hub.
  Browsers never touch agents directly. Agents reconnect forever; a brief
  Hub restart just makes them reconnect.

---

## 1. Standard bring-up

### Prerequisites

```bash
command -v cargo      # Rust toolchain
command -v node       # Node (frontend build)
ls target/release/hub target/release/agent 2>/dev/null  # prebuilt? if not, cargo build --release
```

You do **not** need `mkpasswd`, `hub.json`, or `agent.toml` for local work.
`FILEBOX_DEV_MODE=1` gives you insecure defaults bound to `127.0.0.1` —
exactly what local debugging wants.

### Dev-mode defaults (no config files needed)

| Thing | Value |
|---|---|
| Hub bind | `127.0.0.1:3000` (override via `FILEBOX_LISTEN_ADDR`) |
| Login | `admin` / `dev-password` |
| Agent token | `dev-token` |
| Session cookie | `filebox_session`, **no `Secure` flag** (so HTTP works) |
| CSRF cookie | `filebox_csrf` (readable by JS; send as `X-CSRF-Token` header only) |

### Step 1 — Build the frontend

Any frontend change requires this, or the Hub serves stale JS:

```bash
cd frontend && npx vite build && cd ..
```

Verify the build references match what the Hub will serve:

```bash
grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' frontend/dist/index.html
curl -s http://127.0.0.1:3000/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js'
# Must be identical. If the Hub serves a different hash, it's reading a
# different frontend/dist (set FILEBOX_FRONTEND_DIR explicitly).
```

### Step 2 — Start the Hub

```bash
FILEBOX_DEV_MODE=1 \
FILEBOX_FRONTEND_DIR="$(pwd)/frontend/dist" \
RUST_LOG=info \
./target/release/hub
```

Always set `FILEBOX_FRONTEND_DIR` to an absolute path. Without it the Hub
walks up from the binary looking for `frontend/dist`; if your shell's cwd
differs from where you expect, it can serve the wrong (or no) dist.

Rebuild the Hub binary only when you changed Rust. Frontend-only changes
do not need a Hub restart (ServeDir reads disk live).

### Step 3 — Start an Agent

Pick a directory with files you want to browse, then:

```bash
FILEBOX_AGENT_HUB="ws://127.0.0.1:3000" \
FILEBOX_AGENT_TOKEN="dev-token" \
FILEBOX_AGENT_NAME="local" \
FILEBOX_ALLOW_INSECURE_HUB=1 \
./target/release/agent
```

`FILEBOX_ALLOW_INSECURE_HUB=1` is mandatory for a plaintext (`ws://`) hub
URL. The agent refuses to dial otherwise.

> Agents persist `agent_id` under their data dir. If you start two agents
> pointing at the same data dir they will fight over one identity. Give
> each its own `FILEBOX_AGENT_DATA_DIR` if you run more than one.

### Step 4 — Seed test data

Create files that exercise the thing you are testing. For UI work
(truncation, alignment, long names), make names that only differ at the
end:

```bash
mkdir -p /tmp/fbx_demo/reports
cd /tmp/fbx_demo/reports
for n in 1503 1607 1708 1854 2031; do
  touch "2025_AUTOMATIC_SERVICE_MODIFY_REWIND_A_${n}.md"
done
touch README.md a.md data.csv   # mix in short names too
```

Then add `/tmp/fbx_demo` as a root via the UI (Settings), or via the API
(see §3). Files dropped into an existing root are usually visible on the
next list; the agent has an mtime-keyed `DirCache` (cleared on root apply),
so if a listing looks stale after an in-place overwrite that keeps the
same mtime, refresh or wait for cache invalidation.

---

## 2. Backend API probes (do this BEFORE blaming the frontend)

When the UI shows an error or empty state, **prove the backend works with
curl first.** The frontend is a thin client; if curl works, the problem is
browser-side (§4). If curl fails, the problem is Hub/Agent. This single
discipline localizes ~90% of issues.

### Authenticate and keep the cookie

```bash
# Fetch a login proof-of-work challenge and solve it. The hub asks for a
# nonce where sha256("{id}:{salt}:{nonce}") has `difficulty` leading zero
# bits — ~1M hashes at the default difficulty 20 (sub-second in CPython's
# C-backed hashlib). Every login attempt consumes its challenge, so fetch
# a fresh one per attempt.
POW_JSON=$(curl -s --noproxy '*' http://127.0.0.1:3000/api/pow/challenge)
POW_ID=$(printf '%s' "$POW_JSON" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
POW_NONCE=$(printf '%s' "$POW_JSON" | python3 -c "
import sys, json, hashlib
ch = json.load(sys.stdin)
prefix = f\"{ch['id']}:{ch['salt']}:\"
target = ch['difficulty']
nonce = 0
while True:
    digest = hashlib.sha256((prefix + str(nonce)).encode()).digest()
    if int.from_bytes(digest, 'big') >> (256 - target) == 0:
        break
    nonce += 1
print(nonce)")

# Login, store session + CSRF cookies in a jar (mimics a browser)
curl -s -c /tmp/fb.cookie --noproxy '*' \
  -X POST http://127.0.0.1:3000/api/session/exchange \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"dev-password\",\"pow_id\":\"$POW_ID\",\"pow_nonce\":\"$POW_NONCE\"}" \
  -o /tmp/fb.login.json

# CSRF token from login JSON (also present as filebox_csrf cookie)
CSRF=$(python3 -c "import json;print(json.load(open('/tmp/fb.login.json'))['csrf_token'])")

# Confirm Set-Cookie includes session + csrf, without Secure in dev mode
# (fresh challenge required — the previous one was consumed by the login above)
POW_JSON=$(curl -s --noproxy '*' http://127.0.0.1:3000/api/pow/challenge)
POW_ID=$(printf '%s' "$POW_JSON" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
POW_NONCE=$(printf '%s' "$POW_JSON" | python3 -c "
import sys, json, hashlib
ch = json.load(sys.stdin)
prefix = f\"{ch['id']}:{ch['salt']}:\"
target = ch['difficulty']
nonce = 0
while True:
    digest = hashlib.sha256((prefix + str(nonce)).encode()).digest()
    if int.from_bytes(digest, 'big') >> (256 - target) == 0:
        break
    nonce += 1
print(nonce)")
curl -s -D - -o /dev/null --noproxy '*' \
  -X POST http://127.0.0.1:3000/api/session/exchange \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"dev-password\",\"pow_id\":\"$POW_ID\",\"pow_nonce\":\"$POW_NONCE\"}" \
  | grep -i set-cookie
```

**Why `--noproxy '*'`:** if your shell has `http_proxy`/`https_proxy` set
(common on dev machines), curl routes `127.0.0.1` through the proxy,
injecting `Proxy-Connection` headers and sometimes mangling the request.
Always bypass the proxy for localhost probes. The appearance of
`Proxy-Connection` in a response is a tell that the proxy interfered.

### Probe the data path

```bash
# Health (no auth)
curl -s --noproxy '*' http://127.0.0.1:3000/api/health

# Agents (auth + CSRF required) — the key signal for "No agents connected"
curl -s -b /tmp/fb.cookie --noproxy '*' \
  -H "X-CSRF-Token: $CSRF" \
  http://127.0.0.1:3000/api/agents

# List a directory: agent_id + root + path
AGENT_ID=$(curl -s -b /tmp/fb.cookie --noproxy '*' \
  -H "X-CSRF-Token: $CSRF" \
  http://127.0.0.1:3000/api/agents \
  | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
curl -s -b /tmp/fb.cookie --noproxy '*' \
  -H "X-CSRF-Token: $CSRF" \
  "http://127.0.0.1:3000/api/fs/list?agent_id=$AGENT_ID&root=<ROOT>&path=/&limit=200"

# SSE stream — mint a short-lived GET access token (EventSource cannot set headers)
ACCESS=$(curl -s -b /tmp/fb.cookie --noproxy '*' \
  -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' \
  -d '{"purpose":"events"}' \
  http://127.0.0.1:3000/api/access-tokens \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s -N -b /tmp/fb.cookie --noproxy '*' \
  -H 'Accept: text/event-stream' \
  "http://127.0.0.1:3000/api/events?access_token=$ACCESS"
```

### Key endpoints (verified against `routes.rs`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | no | Liveness + version |
| GET | `/api/pow/challenge` | no (IP rate limited) | Fresh login proof-of-work challenge (single-use, 5 min TTL, no-store) |
| POST | `/api/session/exchange` | no | Login → sets session + CSRF cookies (requires `pow_id` + `pow_nonce`) |
| POST | `/api/session/logout` | yes + CSRF | Logout → clears cookies |
| GET | `/api/agents` | yes + CSRF | List agents (the "No agents connected" source) |
| GET | `/api/agents/{id}` | yes | One agent + roots + collections |
| GET / PUT | `/api/agents/{id}/resources` | yes | Resource snapshot / full replace |
| POST | `/api/agents/{id}/roots` | yes | Add root |
| PATCH / DELETE | `/api/agents/{id}/roots/{name}` | yes | Update / remove root |
| POST | `/api/agents/{id}/collections` | yes | Create collection (optional initial item) |
| PATCH / DELETE | `/api/agents/{id}/collections/{name}` | yes | Mutate / delete collection |
| POST | `/api/agents/{id}/workspace-search` | yes | Workspace Search (find / content modes) |
| GET | `/api/fs/list` | yes | Directory listing (proxied to agent) |
| GET | `/api/fs/stat` | yes | File metadata |
| GET | `/api/file/raw` | yes + CSRF header, or `access_token` | File bytes |
| POST | `/api/access-tokens` | yes + CSRF | Mint short-lived GET bearer (`file_raw` / `events`) |
| POST | `/api/preview/sessions` | yes | HTML preview session token |
| GET | `/api/preview/{token}/{*path}` | token | HTML relative asset |
| GET | `/api/agents/{id}/sys-stats` | yes | CPU/mem/etc |
| POST | `/api/cancel` | yes | Cancel in-flight request |
| GET | `/api/events` | yes + CSRF header, or `access_token` | SSE stream of agent events |
| WS | `/ws/agent` | token | Agent → Hub (agents only) |

---

## 3. Adding roots and collections via API

Roots and collections are normally managed from the UI. For automation:

```bash
# Add a root (absolute path, or ~/… under the agent's home)
curl -s -b /tmp/fb.cookie --noproxy '*' \
  -X POST "http://127.0.0.1:3000/api/agents/$AGENT_ID/roots" \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","path":"/tmp/fbx_demo"}'

# Create a collection, optionally with an initial item (atomic create+add)
curl -s -b /tmp/fb.cookie --noproxy '*' \
  -X POST "http://127.0.0.1:3000/api/agents/$AGENT_ID/collections" \
  -H 'Content-Type: application/json' \
  -d '{"name":"watchlist","item":{"root":"demo","path":"/reports/README.md"}}'

# Add / remove an item (PATCH deltas)
curl -s -b /tmp/fb.cookie --noproxy '*' \
  -X PATCH "http://127.0.0.1:3000/api/agents/$AGENT_ID/collections/watchlist" \
  -H 'Content-Type: application/json' \
  -d '{"item_add":{"root":"demo","path":"/reports/a.md"}}'
```

If the agent is offline, the Hub stores the update as pending and applies
it on reconnect (`state: "pending_agent_reconnect"`). A rejected update
(e.g. missing root path) becomes `config_error` / clears pending and
**never destroys the last known good state.** Collection mutations against
a legacy agent return `400 unsupported_feature`.

### Workspace Search via API

```bash
# Filename search (fd-like). Empty query lists names under the folder.
curl -s -b /tmp/fb.cookie --noproxy '*' \
  -X POST "http://127.0.0.1:3000/api/agents/$AGENT_ID/workspace-search" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"find","root":"demo","path":"/","query":"REWIND","max_results":50}'

# Content search (rg-like regex). Optional extensions filter.
curl -s -b /tmp/fb.cookie --noproxy '*' \
  -X POST "http://127.0.0.1:3000/api/agents/$AGENT_ID/workspace-search" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"content","root":"demo","path":"/reports","query":"TODO|FIXME","extensions":["md","rs"],"context":2,"ignore":["renv","venv","node_modules"],"max_depth":8}'
```

Optional body fields: `ignore` (folder-name list) and `max_depth`
(directory layers under `path`; omit/`0` = unlimited). Progress events
use SSE `phase: "search"`. Cancel with `POST /api/cancel` (and the same
`client_nonce` if you sent one). Only one search runs per agent at a
time; long trees are truncated by scan/result caps. Legacy agents
without `capabilities.workspace_search` return unsupported.

---

## 4. Frontend verification checklist

After a frontend change, the running Hub serves the new build, but the
**browser may be holding stale state**. Work through this in order:

1. **Hard refresh.** `Cmd+Shift+R` / `Ctrl+Shift+R`. Plain refresh can serve
   a cached JS bundle even when `index.html` is fresh.
2. **Check the served JS hash matches dist.** See §1 Step 1 — if the
   browser fetched a different hash than what's in `frontend/dist`, it hit a
   stale cache or the wrong Hub.
3. **Use a private/incognito window.** This sidesteps cached cookies, HSTS
   entries, service workers, and localStorage from previous sessions. If it
   works in incognito but not your normal window, the problem is browser
   state, not your code.
4. **Prefer `http://localhost:3000` over `http://127.0.0.1:3000`.** HSTS is
   keyed by hostname. Chrome/Edge/Firefox exempt `localhost` from HSTS;
   `127.0.0.1` is not always exempt. If you ever visited any HTTPS service
   on `127.0.0.1`, the browser may force-upgrade all `127.0.0.1` traffic to
   HTTPS — and the Hub only speaks HTTP.
5. **DevTools → Network tab.** Look for: red/failed requests, `(blocked)`
   or `(failed) net::ERR_...`, requests that went to `https://` when you
   typed `http://` (HSTS upgrade), 401s on `/api/*` (cookie not stored).
6. **DevTools → Application → Cookies.** After login, is `filebox_session`
   actually present with a non-empty value? If the login response set it
   but it is not here, a second Set-Cookie likely cleared it (this was a
   real bug — see §6).

---

## 5. Known traps (all bitten by these)

### Stale Hub process holding port 3000

**Symptom:** `failed to bind: Address already in use` when starting a Hub,
or you rebuild but behavior does not change.

A Hub started in a previous session (often daemonized, PPID=1) can outlive
the session that launched it. `cargo build` produces a new binary, but the
old process is still running the old code.

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN        # who holds the port?
ps -p <PID> -o pid,ppid,etime,command   # how long has it run? PPID 1 = orphaned
kill <PID>                              # then restart
```

**Before killing, identify the process.** Confirm it is actually a `hub`
binary and roughly how long it has run. Do not blindly `kill -9` whatever
holds the port.

### HSTS poisoning on `127.0.0.1`

**Symptom:** UI loads but every `/api/*` request fails; browser shows it
retried over `https://127.0.0.1:3000` which the Hub cannot serve.

The Hub historically emitted `Strict-Transport-Security` unconditionally,
even on plaintext HTTP. Browsers remembered it and force-upgraded
subsequent `http://` requests to `https://`. The Hub has no TLS listener,
so those requests die.

This is fixed in code (HSTS now gated on actual TLS), but a browser that
already cached the old HSTS will keep force-upgrading until the entry
expires or is cleared. Recovery:

- Use `http://localhost:3000` (different HSTS key, usually exempt).
- Or clear the HSTS entry: Chrome/Edge `chrome://net-internals/#hsts` →
  "Delete domain security policies" → `127.0.0.1`.
- Or use an incognito window.

### Session cookie cleared on login

**Symptom:** Login succeeds (Hub logs `login_success`), but every
subsequent `/api/*` is 401; UI shows empty data ("No agents connected").

The login handler once appended **two** `Set-Cookie` headers: the valid
session, followed by `filebox_session=; Max-Age=0` which immediately
erased it. Per RFC 6265 the second same-named cookie wins. This is fixed,
but the diagnostic holds: **after login, inspect DevTools cookies.** A
single login must set a surviving `filebox_session` (HttpOnly) and a
`filebox_csrf` (readable; required as `X-CSRF-Token` on API calls).

### Proxy intercepting localhost

**Symptom:** Intermittent failures, weird headers (`Proxy-Connection`),
requests that worked one minute fail the next.

If `http_proxy`/`https_proxy`/`ALL_PROXY` is set in the shell, curl (and
sometimes the browser via system proxy) routes `127.0.0.1` through it.
Always use `--noproxy '*'` for curl probes. For the browser, ensure
`127.0.0.1` and `localhost` are in the no-proxy / bypass list.

### Agent connected to a different Hub

If you have ever run two Hubs (e.g. on 3000 and 3001), an agent's
persisted `agent_id` plus its `FILEBOX_AGENT_HUB` URL determine where it
lands. An agent showing "online" via one Hub's API does not mean it is
visible to the Hub the browser is hitting. Confirm the agent's Hub URL and
that the same Hub serves the browser.

---

## 6. Diagnostic decision tree

```
UI shows empty / error
        │
        ▼
   curl /api/health  ──fail──▶  Hub not running / wrong port / proxy.
        │                          Fix Hub bring-up (§1).
        ok
        │
        ▼
   login via curl, store cookie
        │
        ├─ login itself fails ──▶  Wrong creds / rate-limited.
        │                          Check dev defaults (§1).
        │
        ▼
   curl -b cookie /api/agents
        │
        ├─ 401 ───────────────▶  Cookie not stored → multiple Set-Cookie?
        │                          Check §5 "Session cookie cleared on login".
        │
        ├─ 200 but [] ────────▶  No agent connected. Start an agent (§1 Step 3),
        │                          confirm it registers in Hub logs.
        │
        ▼ 200 with agents
        │
   curl -b cookie /api/fs/list?...
        │
        ├─ fail ──────────────▶  Agent online but not serving path.
        │                          Check root exists, path inside root.
        │
        ▼ works
        │
   Backend is healthy. Problem is browser-side → §4 checklist
   (hard refresh, incognito, localhost vs 127.0.0.1, HSTS).
```

The discipline: **make curl work end-to-end first.** Only then investigate
the browser. Skipping straight to "let me re-read the React component"
burns time when the real cause is a poisoned HSTS cache or a stray
Set-Cookie.

---

## 7. Restart hygiene

- **Frontend-only change:** `vite build`. No restart. Hard-refresh browser.
- **Hub (Rust) change:** `cargo build --release -p filebox-hub`, then stop
  the old Hub (`kill <PID>`, wait for port release) and start the new one.
  Agents reconnect automatically within seconds.
- **Agent (Rust) change:** rebuild, stop old agent, start new. It re-registers
  with the same persisted `agent_id` (no duplicate entries — the Hub's
  abort-on-reregister handles this).
- **Never `kill -9` first.** Try `kill` (SIGTERM) and wait. The Hub and
  Agent both close WS connections cleanly on SIGTERM, which avoids spurious
  reconnect storms.

---

## 8. Office preview (optional LibreOffice)

Office preview is **off** unless the agent can run an external `soffice`.
The agent never bundles LibreOffice; point it at a user-installed binary
(rootless-friendly).

**Automated e2e (no real LibreOffice):** from the repo root run
`./scripts/e2e_office_preview.sh`. It builds debug hub/agent, starts them
with a fake `soffice`, and asserts capability, convert, virtual PDF/CSV raw
read, cache hit, pptx/xlsx, denylist, unsupported format, `agent_busy`,
cancel, and capability-off behavior.

### Configure the agent

```bash
# Absolute path to the soffice executable (preferred)
export FILEBOX_AGENT_SOFFICE="$HOME/opt/libreoffice/opt/libreoffice26.2/program/soffice"

# Or a directory containing soffice / program/soffice
# export FILEBOX_AGENT_SOFFICE_DIR="$HOME/opt/libreoffice/opt/libreoffice26.2/program"

# Optional knobs
# FILEBOX_AGENT_OFFICE_TIMEOUT_SECS=120
# FILEBOX_AGENT_OFFICE_MAX_SRC_BYTES=536870912
# FILEBOX_AGENT_OFFICE_MAX_PDF_BYTES=1073741824
# FILEBOX_AGENT_OFFICE_MAX_LOG_BYTES=8388608
# FILEBOX_AGENT_OFFICE_MAX_MEMORY_BYTES=2147483648 # resident process-tree bytes on Linux
# FILEBOX_AGENT_OFFICE_CACHE_BYTES=1073741824
```

`FILEBOX_AGENT_OFFICE_CACHE_BYTES` counts artifacts, metadata, manifests, and
empty-file entries and must fit one complete converted preview; otherwise
conversion fails safely with `office_cache_too_small`. Linux checks the active
LibreOffice process tree's resident memory against
`FILEBOX_AGENT_OFFICE_MAX_MEMORY_BYTES`; it does not use `RLIMIT_AS`, because
Impress commonly reserves much more virtual address space than resident
memory. The other process, output, timeout, and cleanup bounds remain portable.
Converted PDFs are checked for a complete header/trailer/xref before caching,
and a browser decode failure can force regeneration instead of reusing the
same artifact.

On successful probe (`soffice --headless --version`), the agent advertises
`capabilities.office_pdf_preview: true`. The UI Settings page has an
**Office preview** switch (browser `localStorage`, default on) to
disable conversion without removing LibreOffice.

There is no periodic Office monitor. Startup performs one bounded probe;
later checks happen only when a user requests a conversion. Removing Office
or making the configured binary non-executable mid-run yields a retryable
`office_unavailable` result without stopping the agent or blocking file
browsing and other preview types.

### Rootless install (no sudo)

**Debian/Ubuntu-style hosts** — download the official deb tarball, extract
packages into your home directory:

```bash
VERSION=26.2.5
PREFIX="$HOME/opt/libreoffice"
mkdir -p /tmp/lo-dl "$PREFIX" && cd /tmp/lo-dl
curl -L -O \
  "https://download.documentfoundation.org/libreoffice/stable/${VERSION}/deb/x86_64/LibreOffice_${VERSION}_Linux_x86-64_deb.tar.gz"
tar -xzf "LibreOffice_${VERSION}_Linux_x86-64_deb.tar.gz"
cd LibreOffice_*_Linux_x86-64_deb/DEBS
for deb in *.deb; do dpkg-deb -x "$deb" "$PREFIX"; done
ls "$PREFIX"/opt/libreoffice*/program/soffice
```

**Rocky / RHEL-style hosts** — same idea with the rpm tarball:

```bash
VERSION=26.2.5
PREFIX="$HOME/opt/libreoffice"
mkdir -p /tmp/lo-dl "$PREFIX" && cd /tmp/lo-dl
curl -L -O \
  "https://download.documentfoundation.org/libreoffice/stable/${VERSION}/rpm/x86_64/LibreOffice_${VERSION}_Linux_x86-64_rpm.tar.gz"
tar -xzf "LibreOffice_${VERSION}_Linux_x86-64_rpm.tar.gz"
cd LibreOffice_*_Linux_x86-64_rpm/RPMS
for rpm in *.rpm; do rpm2cpio "$rpm" | (cd "$PREFIX" && cpio -idm); done
ls "$PREFIX"/opt/libreoffice*/program/soffice
```

Do **not** use `sudo apt` / `sudo dnf` as the primary path for rootless agents.

### Curl probe

After login (cookie + CSRF) and with a connected agent that has the capability:

```bash
# Convert (long request; cancel via POST /api/cancel with returned/SSE req_id)
curl -sS -X POST "http://127.0.0.1:3000/api/agents/${AGENT_ID}/office-convert" \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" \
  -b "$COOKIE_JAR" \
  -d '{"root":"docs","path":"/report.docx"}'
# → { "req_id":"…", "cache_key":"<64-hex>", "size":…,
#     "outputs":[{"label":"Document","format":"pdf","cache_key":"…","size":…}],
#     "error":null }

# Read derived PDF (virtual path; same /api/file/raw as other files)
curl -sS -D- -o /tmp/out.pdf \
  "http://127.0.0.1:3000/api/file/raw?agent_id=${AGENT_ID}&root=docs&path=/.filebox/office-cache/${CACHE_KEY}.pdf" \
  -H "X-CSRF-Token: $CSRF" -b "$COOKIE_JAR"
```

Supported extensions: `doc`, `docx`, `docm`, `ppt`, `pptx`, `pptm`,
`xls`, `xlsx`, `xlsm`, `ods`. Spreadsheets return one CSV output per
worksheet; use each output's cache key with a `.csv` virtual path.

---

## 9. Quick reference

```bash
# One-shot: dev Hub + one agent + demo files
cd <repo>
( cd frontend && npx vite build )
FILEBOX_DEV_MODE=1 FILEBOX_FRONTEND_DIR="$(pwd)/frontend/dist" \
  RUST_LOG=info ./target/release/hub &
FILEBOX_AGENT_HUB="ws://127.0.0.1:3000" FILEBOX_AGENT_TOKEN="dev-token" \
  FILEBOX_AGENT_NAME="local" FILEBOX_ALLOW_INSECURE_HUB=1 \
  ./target/release/agent &

# Open http://localhost:3000  →  admin / dev-password
```

Env vars (verified):

| Var | Role |
|---|---|
| `FILEBOX_DEV_MODE` | Insecure local hub defaults |
| `FILEBOX_LISTEN_ADDR` | Hub bind address |
| `FILEBOX_FRONTEND_DIR` | Absolute path to `frontend/dist` |
| `FILEBOX_CONFIG_PATH` | Hub `hub.json` path |
| `FILEBOX_TRUST_XFF` | Trust `X-Forwarded-For` for login rate-limit IP |
| `FILEBOX_AGENT_HUB` | Agent hub URL (`ws://` needs insecure flag) |
| `FILEBOX_AGENT_TOKEN` | Agent auth token |
| `FILEBOX_AGENT_NAME` | Agent display name |
| `FILEBOX_AGENT_DATA_DIR` | Persisted `agent_state.json` directory |
| `FILEBOX_AGENT_CONFIG` | Agent toml path |
| `FILEBOX_ALLOW_INSECURE_HUB` | Allow plaintext `ws://` / `http://` hub |
| `FILEBOX_AGENT_STATS_TTL_SECS` | Sysinfo cache TTL (default 60) |
| `FILEBOX_AGENT_DIR_CACHE_RESTAT_COOLDOWN_MS` | Dir cache per-entry re-stat cooldown (default 2000; 0 = stat every hit) |
| `FILEBOX_AGENT_SOFFICE` | Absolute path to LibreOffice `soffice` (enables Office preview) |
| `FILEBOX_AGENT_SOFFICE_DIR` | Directory containing `soffice` / `program/soffice` |
| `FILEBOX_AGENT_OFFICE_TIMEOUT_SECS` | Convert timeout (default 120) |
| `FILEBOX_AGENT_OFFICE_MAX_SRC_BYTES` | Max source Office file size |
| `FILEBOX_AGENT_OFFICE_MAX_PDF_BYTES` | Max combined derived output size (compatibility name) |
| `FILEBOX_AGENT_OFFICE_MAX_LOG_BYTES` | Max captured stdout/stderr per conversion |
| `FILEBOX_AGENT_OFFICE_MAX_MEMORY_BYTES` | LibreOffice resident process-tree limit on Linux |
| `FILEBOX_AGENT_OFFICE_CACHE_BYTES` | On-disk derived preview cache budget (LRU) |
| `FILEBOX_UPDATE_BASE_URL` | `--update` mirror base URL |
| `FILEBOX_ALLOW_INSECURE_UPDATE` | Allow `http://` update source |
| `FILEBOX_ALLOW_DOWNGRADE` | Allow updater downgrade |
