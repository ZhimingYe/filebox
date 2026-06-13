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
2. Login with a sessionKey.
3. See connected Agents.
4. Add allowed folders from the frontend.
5. Browse those folders read-only.
6. Preview Markdown, code, PDF, and images.
7. Add allowed local HTTP ports from the frontend.
8. Open those allowed ports through the Hub.
9. See health status for Hub, Agents, requests, and config updates.
10. Continue working after Agent disconnects/reconnects.

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

## Components to Implement

### 1. Frontend

Use TypeScript.

Suggested stack:

* Vite.
* React or Preact.
* PDF.js.
* Markdown renderer with sanitization.
* Code highlighter with size limits.
* Virtualized file list.

Required pages/components:

```text
Login
BackendList
FileBrowser
PreviewPane
MarkdownPreview
CodePreview
PdfPreview
ImagePreview
PortTunnel
HealthPanel
AgentSettings
RootManager
PortManager
```

Frontend must support:

* sessionKey exchange.
* Cookie-based session after login.
* Backend/Agent list.
* File browsing.
* File preview.
* Health display.
* Agent settings.
* Root management.
* Port management.
* Config update status.
* Request cancel/retry.
* Denied sensitive path state.

---

### 2. Hub

Use Rust.

Suggested stack:

* Tokio.
* Axum.
* SQLite.
* rustls or reverse-proxy TLS.
* WebSocket.

Hub must:

* Serve frontend static files.
* Exchange sessionKey for secure session cookie.
* Authenticate browser sessions.
* Authenticate Agents.
* Track Agent online/offline/slow state.
* Store Agent registry.
* Store latest Agent resource state.
* Store pending resource updates for offline Agents.
* Proxy file list/stat/range-read requests.
* Proxy preview requests.
* Proxy allowed local HTTP/WebSocket ports.
* Expose health API.
* Enforce permissions.
* Enforce limits.
* Never queue infinitely.

Core Hub APIs:

```http
POST   /api/session/exchange
GET    /api/health
GET    /api/agents
GET    /api/agents/{agent_id}/resources

POST   /api/agents/{agent_id}/roots
PATCH  /api/agents/{agent_id}/roots/{root_name}
DELETE /api/agents/{agent_id}/roots/{root_name}

POST   /api/agents/{agent_id}/ports
PATCH  /api/agents/{agent_id}/ports/{port_name}
DELETE /api/agents/{agent_id}/ports/{port_name}

GET    /api/fs/list
GET    /api/fs/stat
GET    /api/file/raw
POST   /api/serve-dir
GET    /api/tunnel/{agent_id}/{port_name}/...
```

---

### 3. Agent

Use Rust.

Agent bootstrap config should be minimal:

```toml
hub = "https://fileview.example.com"
token = "agent_xxx"
```

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

### PDF

* Use PDF.js.
* Support range requests.
* Do not force full download.
* Fall back to page raster preview later if needed.

### Images

* Support large images, including 30MB+ files.
* Do not judge only by file size.
* Consider dimensions and decoded memory.
* Use downscaled/compressed preview when needed.
* Show progress for expensive previews.

### Webpage preview

* Use temporary serve-dir sessions.
* Serve only inside selected allowed root/directory.
* Use sandboxed iframe.
* Prevent directory escape.

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
Optional SSE
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

1. Rust workspace and TypeScript frontend skeleton.
2. Hub static frontend serving.
3. sessionKey exchange and cookie session.
4. Agent outbound connection and authentication.
5. Agent registry and health.
6. Frontend backend list and health panel.
7. Frontend Agent Settings page.
8. Frontend-managed roots.
9. Agent root validation and persistence.
10. File list/stat/range-read.
11. File browser UI.
12. Markdown/code/image/PDF preview.
13. Sensitive path denylist.
14. Request cancellation and progress states.
15. Frontend-managed ports.
16. Basic HTTP/WebSocket port forwarding.
17. Offline Agent pending resource updates.
18. Reconnect hardening and no-freeze polish.

Do not start with advanced previews, plugin systems, or complex user management.

---

## Suggested Repo Layout

```text
fileview/
  CLAUDE.md
  Cargo.toml
  crates/
    protocol/
    hub/
    agent/
  frontend/
    package.json
    vite.config.ts
    src/
      api/
      state/
      components/
```

Important modules:

```text
hub/auth
hub/agent_registry
hub/resources
hub/fs_proxy
hub/health
hub/tunnel
hub/serve_dir

agent/bootstrap
agent/config_store
agent/reconnect
agent/resources
agent/fs
agent/preview
agent/tunnel
agent/health
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

