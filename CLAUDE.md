# CLAUDE.md

## What We Are Building

Build a minimal read-only remote file browser.

The product has three parts:

1. **Frontend**: TypeScript web app hosted by the Hub.
2. **Hub**: Rust server exposed over HTTPS.
3. **Agent**: Rust daemon running on backend machines.

Architecture:

```text
Browser
  -> HTTPS
  -> Hub
  -> outbound WSS/HTTPS connection
  -> Agent
  -> local read-only files / allowed local web ports
```

Agents connect outward to Hub. Browsers never connect directly to Agents. Backend machines must not need public IPs, inbound ports, VPN, or port mapping.

---

## MVP Goal

The first usable version should let a user:

1. Open one HTTPS web page.
2. Login with username and password (bcrypt-hashed).
3. See connected Agents.
4. Add allowed folders from the frontend.
5. Browse those folders read-only.
6. Preview Markdown, code, PDF, and images.
7. Add allowed local HTTP ports from the frontend.
8. Open those allowed ports through the Hub.
9. See health status for Hub, Agents, requests, and config updates.
10. Monitor agent system stats (CPU, memory, top processes).
11. Continue working after Agent disconnects/reconnects.

This is not a file editor, terminal, sync drive, WebDAV server, or remote desktop.

---

## Hard Product Rules

### Frontend is the main control surface

Do not make CLI the normal workflow.

Users should manage roots and ports from the frontend:

* Add root.
* Remove root.
* Enable/disable root.
* Add local port.
* Remove local port.
* Enable/disable port.
* See pending/applied/rejected config states.

CLI may exist only for bootstrap, emergency recovery, automation, or debugging.

If normal use requires CLI, the implementation is incomplete.

### Read-only only

Never implement:

* Upload.
* Edit.
* Delete.
* Rename.
* File modification.
* Shell execution.
* Arbitrary command execution.
* Arbitrary TCP proxying.
* Arbitrary LAN scanning.
* Remote desktop.
* WebDAV.
* Sync drive behavior.

### Agents reconnect forever

Agent must automatically reconnect after network failure, even after 24h+ outage.

Agent identity must be stable. Reconnect must not create duplicate backend entries.

### Never freeze silently

Long operations are allowed.

Large images and PDFs may take time.

But every long operation must have:

* Visible progress or status.
* Cancel button.
* Bounded memory.
* Bounded queue.
* No infinite spinner.
* Clear failed/stalled/retryable state.

Do not kill large files just because total elapsed time is long. Mark stalled only when there is no progress.

---

## UI Design System

The frontend uses a shadcn/Linear-inspired design with a neutral slate color palette. All design tokens live in `frontend/src/theme.ts` -- every component imports from there.

### Theme Tokens

```ts
// frontend/src/theme.ts
export const c = {
  bg: '#ffffff', bgSubtle: '#f8fafc', bgMuted: '#f1f5f9',
  bgOverlay: 'rgba(15,23,42,0.4)', surface: '#ffffff',
  border: '#e2e8f0', borderSubtle: '#f1f5f9',
  text: '#0f172a', textSecondary: '#475569', textMuted: '#94a3b8', textFaint: '#cbd5e1',
  accent: '#6366f1', accentHover: '#4f46e5', accentBg: '#eef2ff',
  danger: '#ef4444', dangerBg: '#fef2f2',
  warning: '#f59e0b', warningBg: '#fffbeb',
  success: '#10b981', successBg: '#ecfdf5',
} as const;

export const radius = { sm: 6, md: 8, lg: 12, pill: 9999 } as const;
export const shadow = {
  xs: '0 1px 2px rgba(0,0,0,0.05)',
  sm: '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)',
  md: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)',
  lg: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
} as const;
export const font = {
  sans: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: '"JetBrains Mono", "SF Mono", "Fira Code", monospace',
} as const;
```

### Design Principles

* **No emojis**: Use custom inline SVG icons (16x16, stroke-based) instead of emoji characters.
* **Inline styles**: All components use `const styles: Record<string, React.CSSProperties>` -- no CSS modules, no Tailwind.
* **Compact spacing**: 4/6/8/10/12/16/20/24px scale.
* **Subtle borders**: `c.border` (#e2e8f0) primary, `c.borderSubtle` (#f1f5f9) for light dividers.
* **Rounded corners**: radius.sm (6px) for badges, radius.md (8px) for inputs/buttons, radius.lg (12px) for panels.
* **Semantic colors**: success (green), warning (amber), danger (red), accent (indigo) for interactive elements.

---

## Components to Implement

### 1. Frontend

Use TypeScript.

Stack:

* Vite.
* React.
* PDF.js.
* Markdown renderer with sanitization.
* Code highlighter with size limits.

Components:

```text
Login              - Username/password login form
BackendList        - Agent sidebar list with status dots
FileBrowser        - Virtualized file table with filter, sort, icons
PreviewPane        - Markdown/code/PDF/image/HTML preview with loading states
AgentSettings      - Agent configuration and root management
RootManager        - Add/remove/enable/disable root directories
HealthPanel        - Hub and agent health status display
SystemStats        - CPU, memory, gauge bars, top processes table
```

Frontend supports:

* Username/password login (bcrypt-validated).
* Cookie-based session after login.
* Backend/Agent list with online/offline status.
* File browsing with glob/regex filename filter.
* File preview with word-wrap toggle for code.
* Modification date column with sorting.
* Binary file preview blocking.
* System monitoring (CPU, memory, top processes).
* Responsive mobile layout with hamburger drawer.
* Health display with SSE real-time updates.
* Agent settings with root management.
* Root management with enable/disable toggles.
* Config update status (pending/applied/rejected).
* Request cancel/retry.
* Denied sensitive path state (shown as denied, not previewable).
* Copy path/filename to clipboard.
* Slow loading detection (8s timer) for images and PDFs.
* Progress toasts for long operations via SSE.
* Key-based forced remount on file switch for clean state.

---

### 2. Hub

Use Rust.

Stack:

* Tokio.
* Axum.
* rustls or reverse-proxy TLS.
* WebSocket.

Hub must:

* Serve frontend static files.
* Validate username/password login with bcrypt.
* Authenticate browser sessions via secure cookies.
* Authenticate Agents via bcrypt-hashed token.
* Track Agent online/offline/slow state.
* Store Agent registry.
* Store latest Agent resource state.
* Store pending resource updates for offline Agents.
* Proxy file list/stat/range-read requests.
* Proxy system stats requests to agents.
* Proxy preview requests.
* Proxy allowed local HTTP/WebSocket ports.
* Expose health API.
* Enforce permissions.
* Enforce limits.
* Never queue infinitely.

Hub configuration is loaded from `hub.json` (JSON format):

```json
{
  "listen_addr": "0.0.0.0:3000",
  "agent_token_hash": "$2b$12$...",
  "users": [
    { "username": "admin", "password_hash": "$2b$12$..." }
  ]
}
```

Hub APIs (implemented):

```http
POST   /api/session/exchange
POST   /api/session/logout
GET    /api/health
GET    /api/agents
GET    /api/agents/{agent_id}
GET    /api/agents/{agent_id}/resources
GET    /api/agents/{agent_id}/sys-stats
GET    /api/events                       (SSE stream)
POST   /api/cancel                       (cancel in-flight request)

POST   /api/agents/{agent_id}/roots
PATCH  /api/agents/{agent_id}/roots/{root_name}
DELETE /api/agents/{agent_id}/roots/{root_name}

PUT    /api/agents/{agent_id}/resources  (set desired resources)

GET    /api/fs/list
GET    /api/fs/stat
GET    /api/file/raw

GET    /ws/agent                         (Agent WebSocket connection)
```

Hub APIs (planned, not yet implemented):

```http
POST   /api/agents/{agent_id}/ports
PATCH  /api/agents/{agent_id}/ports/{port_name}
DELETE /api/agents/{agent_id}/ports/{port_name}

POST   /api/serve-dir
GET    /api/tunnel/{agent_id}/{port_name}/...
```

---

### 3. Agent

Use Rust.

Agent bootstrap config is loaded from `agent.toml` (TOML format, env vars override):

```toml
hub = "https://fileview.example.com"
token = "agent_xxx"
name = "Lab Server 1"
data_dir = "/var/lib/filebox"
```

Environment variables `FILEBOX_AGENT_HUB`, `FILEBOX_AGENT_TOKEN`, `FILEBOX_AGENT_NAME`, `FILEBOX_AGENT_DATA_DIR` override TOML values.

Agent must persist locally:

```text
agent_id
accepted roots
accepted ports
resource revision
last known good resource state
```

Agent must:

* Connect outward to Hub.
* Reconnect forever.
* Register current roots/ports/capabilities.
* Receive resource updates from Hub.
* Validate resource updates.
* Apply updates atomically.
* Keep last good state if update is invalid.
* List directories.
* Stat files.
* Read file ranges.
* Collect system stats (CPU, memory, top processes via sysinfo crate).
* Generate basic previews when needed.
* Forward only explicitly allowed local ports.
* Enforce read-only access.
* Enforce path safety.
* Enforce sensitive denylist.
* Send progress for long operations.
* Support cancellation.

---

## Runtime Resource Management

Roots and ports are dynamic allowlists.

They are not hardcoded.

Normal flow:

```text
Frontend
  -> Hub permission check
  -> Hub sends desired resource update to Agent
  -> Agent validates
  -> Agent applies atomically
  -> Agent persists
  -> Hub updates registry
  -> Frontend refreshes
```

If Agent is offline:

```text
Frontend request
  -> Hub stores latest desired state as pending
  -> Frontend shows pending
  -> Agent reconnects later
  -> Hub sends pending update
  -> Agent applies or rejects
```

Pending updates must be visible and cancellable.

Do not create infinite pending queues. Coalesce to latest desired state.

---

## Security Requirements

### Authentication

User authentication uses bcrypt-hashed passwords stored in `hub.json`.

Agent authentication uses bcrypt-hashed token stored in `hub.json`.

No plaintext passwords or tokens are stored or transmitted.

Session cookies are HttpOnly, Secure, and SameSite.

### Path safety

Every file request must:

```text
1. Receive root name and relative path.
2. Resolve active root.
3. Join root and relative path.
4. Normalize.
5. Canonicalize when possible.
6. Verify final path remains inside root.
7. Reject symlink escape.
8. Apply deny rules.
9. Open read-only.
```

Never trust browser paths.

Never allow `../` escape.

Never follow symlinks outside root.

### Sensitive denylist

Default-deny privacy-sensitive files even inside allowed roots.

At minimum deny:

```text
.git/
.ssh/
.gnupg/
.env
.env.*
*.env
.envrc
.direnv/
.bashrc
.bash_profile
.profile
.zshrc
.zprofile
.zshenv
.config/fish/config.fish
.bash_history
.zsh_history
.python_history
.mysql_history
.psql_history
.sqlite_history
.aws/
.azure/
.gcloud/
.config/gcloud/
.kube/
.docker/
.netrc
.git-credentials
.gitconfig
.npmrc
.yarnrc
.pnpmrc
.pypirc
.cargo/credentials
.cargo/credentials.toml
.condarc
.jupyter/
.ipython/profile_default/security/
.Renviron
.Rprofile
*.pem
*.key
*.crt
*.p12
*.pfx
id_rsa
id_dsa
id_ecdsa
id_ed25519
credentials
credentials.json
token.json
secrets.json
service-account*.json
*.sqlite
*.sqlite3
*.db
*.keychain
```

Denied files should be hidden by default or shown as denied and not previewable.

Read-only access can still leak secrets.

---

## Preview Requirements

### Markdown

* Fetch raw text.
* Render in frontend.
* Sanitize HTML.
* Use safe mode for large files.

### Code

* Highlight small files.
* Disable highlighter for large files.
* Use partial or virtualized text preview.
* Word-wrap toggle.

### PDF

* Use PDF.js.
* Support range requests.
* Do not force full download.
* Slow loading detection at 8 seconds.

### Images

* Support large images, including 30MB+ files.
* Do not judge only by file size.
* Consider dimensions and decoded memory.
* Use downscaled/compressed preview when needed.
* Show progress for expensive previews.
* Slow loading detection at 8 seconds.

### HTML

* Render via Blob URL with base tag injection.
* Toolbar with open-in-new-tab and copy-HTML buttons.

### Port forwarding

* Only explicitly allowed ports.
* Default targets should be loopback only:

```text
127.0.0.1:PORT
localhost:PORT
[::1]:PORT
```

No arbitrary host/port proxying from browser.

---

## Health Requirements

Frontend must show:

```text
Hub status
Agent status
Last seen
RTT
Inflight requests
Resource revision
Pending config
Last config error
Current request state
```

Request states should include:

```text
idle
loading
streaming
slow_but_progressing
stalled
cancelled
failed
done
```

Resource update states should include:

```text
editing
validating
pending_agent
applying
applied
rejected
failed
```

Hub should expose:

```http
GET /api/health
```

---

## Protocol Rules

Browser to Hub:

```text
HTTPS REST
Range requests
Streaming responses
Resource management APIs
SSE event stream
```

Hub to Agent:

```text
WSS control channel
WSS data channel
```

Do not send large file data over the same channel as heartbeat/control messages.

Every request should support:

```text
req_id
cancel
progress
error
done
```

Large transfers should support:

```text
range
offset
chunk sequence
backpressure
bounded in-flight bytes
```

---

## MVP Build Order

Build in this order:

1. ~~Rust workspace and TypeScript frontend skeleton.~~ DONE
2. ~~Hub static frontend serving.~~ DONE
3. ~~Username/password login with bcrypt validation and cookie session.~~ DONE
4. ~~Agent outbound connection and authentication (bcrypt token).~~ DONE
5. ~~Agent registry and health.~~ DONE
6. ~~Frontend backend list and health panel.~~ DONE
7. ~~Frontend Agent Settings page.~~ DONE
8. ~~Frontend-managed roots.~~ DONE
9. ~~Agent root validation and persistence.~~ DONE
10. ~~File list/stat/range-read.~~ DONE
11. ~~File browser UI with glob/regex filter and refresh.~~ DONE
12. ~~Markdown/code/image/PDF preview.~~ DONE
13. ~~Sensitive path denylist.~~ DONE
14. ~~Request cancellation and progress states.~~ DONE
15. ~~System monitoring (CPU, memory, top processes).~~ DONE
16. Frontend-managed ports.
17. Basic HTTP/WebSocket port forwarding.
18. Offline Agent pending resource updates.
19. Reconnect hardening and no-freeze polish.

Do not start with advanced previews, plugin systems, or complex user management.

---

## Repo Layout

```text
filebox/
  CLAUDE.md
  Cargo.toml               # Rust workspace config
  Cargo.lock
  README.md
  crates/
    protocol/
      src/
        lib.rs
        message.rs          # WebSocket message types
        agent.rs            # Agent identity and status types (AgentInfo, AgentStatus)
        resources.rs        # Resource definitions (roots, ports)
        denylist.rs         # Sensitive file denylist
    hub/
      src/
        main.rs             # Entry point, Axum server
        config.rs           # hub.json loading
        routes.rs           # API route handlers
        state.rs            # Shared app state
        ws.rs               # WebSocket agent connections
        auth.rs             # bcrypt auth, session cookies
        agent_registry.rs   # Agent tracking (online/offline)
        events.rs           # SSE event stream
        fs_proxy.rs         # File list/stat/read proxy
        health.rs           # Health API
    agent/
      src/
        main.rs             # Entry point, reconnect loop
        config.rs           # agent.toml + env var loading
        config_store.rs     # Local persistence (roots, ports, id)
        connection.rs       # WebSocket connection to Hub
        resources.rs        # Resource validation and application
        fs.rs               # File operations (list, stat, read)
        sysinfo.rs          # System stats (CPU, memory, processes)
  frontend/
    package.json
    index.html
    vite.config.ts
    src/
      main.tsx              # Entry point
      App.tsx               # Layout, sidebar, routing, toasts
      index.css             # Global styles, markdown, scrollbar
      theme.ts              # Design tokens (colors, radius, shadow, font)
      api/
        client.ts           # API client (fetch wrapper)
      state/
        session.ts          # Login state, token management
        events.ts           # SSE event handling
        health.ts           # Health data polling
        useIsMobile.ts      # Responsive breakpoint hook
      components/
        Login.tsx           # Login form
        BackendList.tsx     # Agent sidebar list
        FileBrowser.tsx     # File table with SVG icons
        PreviewPane.tsx     # All preview types + LoadingOverlay
        AgentSettings.tsx   # Agent config + root management
        RootManager.tsx     # Root add/remove/enable UI
        HealthPanel.tsx     # Health status display
        SystemStats.tsx     # CPU/memory gauges, process table
  scripts/
    serve_at_server.sh      # Rootless Hub install script
    serve_at_client.sh      # Rootless Agent install script
    README.md               # Install script documentation
```

Key modules:

```text
hub/auth              - bcrypt password/token validation, session cookies
hub/agent_registry    - Agent lifecycle tracking, online/offline/slow
hub/events            - SSE broadcast to connected browsers
hub/fs_proxy          - Proxy file operations to agents
hub/health            - Health status aggregation

agent/config_store    - Persist agent_id, roots, ports, resource revision
agent/resources       - Validate and atomically apply resource updates
agent/fs              - Read-only file operations with path safety
agent/sysinfo         - CPU, memory, top processes via sysinfo crate
```

---

## Implementation Patterns

### LoadingOverlay and Slow Detection

Long-running previews (images, PDFs) use a slow loading detection pattern:

```tsx
const [slow, setSlow] = useState(false);
useEffect(() => {
  const t = setTimeout(() => setSlow(true), 8000);
  return () => clearTimeout(t);
}, [src]);
```

The `LoadingOverlay` component shows a spinner and optional slow warning message. It does not force cancel -- the user can still wait or cancel manually.

### useMounted Hook

Prevents state updates after component unmount:

```tsx
const useMounted = () => {
  const ref = useRef(true);
  useEffect(() => { return () => { ref.current = false; }; }, []);
  return ref;
};
```

### Key-Based Forced Remount

PreviewPane uses `key={`${preview.root}:${preview.path}`}` to force a clean remount when switching files, preventing stale state from previous previews.

### Custom SVG Icons

FileBrowser uses inline SVG icon components (16x16, stroke-based, slate-colored) instead of emoji:

* `IconFolder` -- folder outline
* `IconFile` -- document outline
* `IconSymlink` -- arrow/chain link
* `IconUpDir` -- up arrow for parent directory

### Flex Overflow for Long Paths

RootManager handles long directory paths with flex overflow:

```tsx
// Container
itemInfo: { flex: 1, minWidth: 0 }
// Path text
rootPath: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
// Buttons never shrink
actions: { flexShrink: 0, marginLeft: 12 }
```

---

## Deployment

### Rootless Install Scripts

Two interactive scripts handle configuration, build, and installation without root:

```bash
# Server (Hub)
./scripts/serve_at_server.sh
# -> installs to ~/filebox/

# Client (Agent)
./scripts/serve_at_client.sh
# -> installs to ~/filebox-agent/
```

See `scripts/README.md` for full documentation.

### Manual Build

```bash
# Frontend
cd frontend && npm install && npm run build && cd ..

# Backend
cargo build --release
```

### Running

```bash
# Hub
FILEBOX_CONFIG_PATH=~/filebox/config/hub.json ~/filebox/bin/hub

# Agent
~/filebox-agent/agent
```

---

## Implementation Rules

1. Build the MVP above before adding extras.
2. Prefer frontend management over CLI.
3. CLI must not be required for normal daily work.
4. Keep bootstrap config minimal.
5. Do not add write features.
6. Do not add shell or command execution.
7. Do not add arbitrary network proxying.
8. Do not trust browser paths.
9. Do not trust frontend resource changes without Hub permission checks and Agent validation.
10. Do not read large files fully into memory.
11. Do not render huge files fully in browser.
12. Do not let large transfers block control messages.
13. Do not create infinite queues.
14. Do not create infinite buffers.
15. Do not show infinite loading UI.
16. Support cancellation for long operations.
17. Expose progress for slow operations.
18. Distinguish long-running from stalled.
19. Allow large files to run while progress continues.
20. Mark stalled only when progress stops.
21. Make Agent reconnect forever.
22. Persist Agent identity.
23. Persist accepted runtime resources.
24. Keep Agent token separate from user session.
25. Keep frontend hosted by Hub.
26. Fail clearly, not silently.
27. Default-deny privacy-sensitive files.
28. Bad resource updates must never destroy last known good Agent state.
29. Dynamic resource changes must not create duplicate backends.
30. Security and stability beat feature breadth.
31. No emojis in frontend -- use SVG icons.
32. All UI tokens come from theme.ts -- no hardcoded colors.
