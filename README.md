# filebox

A minimal, secure, read-only remote file browser.

> **[Live site →](https://zhimingye.github.io/filebox/)** — interactive product
> tour, architecture diagram, and install walkthrough.

## Overview

filebox is a read-only remote file browsing system that lets you access files on remote servers through a web browser. It consists of three parts:

- **Frontend**: Web UI for browsing files, searching workspaces, collections, and managing servers
- **Hub**: Central server handling authentication and request routing
- **Agent**: Daemon running on remote servers, providing file access

```text
Browser ──HTTPS──▶ Hub ◀──WSS── Agent ──▶ local files
```

Agents connect outward to the Hub. No public IPs, port mapping, or VPN required.

Current release: **v0.9.0**. See [NEWS.md](NEWS.md) for the full changelog.

## Features

### File Browsing
- Virtualized file list with adaptive column widths
- Resizable directory tree
- Address bar (breadcrumbs, paste path, autocomplete)
- Glob/regex filename filter and modification-date filter
- File-type badges; recently modified highlighting
- Filename alignment and font toggles
- Path memory per agent + root
- One-click refresh

### Virtual Collections
- Per-agent named lists of files across roots
- Collections workspace with shared preview pane
- Add files from the browser via CollectionPicker
- Persisted on the agent; offline edits apply on reconnect

### Workspace Search
- Files mode (fd-like filename substring) and Content mode (rg-like regex)
- Scoped to one root + optional folder; optional extension filter
- Progress, cancel, and high-load caps (no system `fd`/`rg` required)

### File Preview
- Multi-tab preview workspace (tab jump, bulk close, Esc to close)
- Markdown rendering
- Read-only Monaco code editor (Find, wrap, syntax highlight)
- PDF reader; image viewer with zoom/pan (including TIFF)
- HTML preview (sandboxed session for relative assets)
- CSV table view
- Optional Office preview (Word / PowerPoint as PDF; spreadsheets as per-sheet CSV)
- Binary / inaccessible file handling with isolated error UI

### Roots & Pins
- Dynamic root allowlist managed from the UI
- Home-path roots (`~/…`) expanded on the agent
- Per-root pinned folders in the sidebar

### System Monitoring
- Overview: CPU, memory/swap, load
- Per-user share breakdown
- Virtualized process table with detail panel

### Security
- Username/password authentication (bcrypt)
- Agent token authentication (bcrypt)
- CSRF synchronizer token (`X-CSRF-Token` header) on session APIs; short-lived GET access tokens for downloads / SSE
- Sensitive files denied by default
- Read-only access
- Path safety checks (canonicalize, symlink escape, denylist)

### Operations
- Responsive mobile layout
- Automatic agent reconnection
- Real-time status updates (SSE)
- Request progress and cancellation
- Built-in `--init-config` and in-place `--update`

## Quick Start

### Option 1: Pre-built Release (Recommended)

Pre-built static Linux x86_64 (musl) binaries are published on the
[Releases page](https://github.com/ZhimingYe/filebox/releases/latest).

```bash
# 1. Download the matching tarball from the latest release page:
#    filebox-hub-<version>-x86_64-musl.tar.gz     (Hub machine)
#    filebox-agent-<version>-x86_64-musl.tar.gz   (Agent machine)

# 2. Extract
tar xzf filebox-hub-*-x86_64-musl.tar.gz     # Hub
tar xzf filebox-agent-*-x86_64-musl.tar.gz   # Agent

# 3. On the Hub machine
(
  cd filebox-hub-*
  ./bin/hub --init-config       # creates config/hub.json
  ./bin/hub
)

# 4. On each Agent machine (paste the token printed by the Hub)
(
  cd filebox-agent-*
  ./agent --init-config         # creates agent.toml
  ./agent
)
```

Manual in-place update on Linux x86_64 release installs:

```bash
# Default: GitHub latest release
filebox-hub-*/bin/hub --update
filebox-agent-*/agent --update

# Custom release mirror / accelerator
filebox-hub-*/bin/hub --update \
  --update-base-url https://your-mirror.example.com/filebox/releases/latest/download
filebox-agent-*/agent --update \
  --update-base-url https://your-mirror.example.com/filebox/releases/latest/download

# Plain HTTP mirrors are rejected by default. Only override this on a trusted network.
filebox-hub-*/bin/hub --update \
  --update-base-url http://your-mirror.example.com/filebox/releases/latest/download \
  --allow-insecure-update
```

`--update` downloads `SHA256SUMS.txt` plus the matching release tarball,
verifies the checksum, and replaces the local install in place. The custom
base URL must expose the same files as the GitHub Release download directory.
Downgrades are also refused by default; use `--allow-downgrade` only when you
intentionally want to roll back to an older release.

The Hub generator hashes the admin password and agent token internally and
prints the generated agent token once. Paste that token into the Agent
generator when prompted. Existing files are never overwritten unless you add
`--force`; use `--output <path>` for a custom location.

### Option 2: Build From Source

```bash
# Clone
git clone https://github.com/ZhimingYe/filebox.git
cd filebox

# Build frontend
cd frontend
npm install
npm run build
cd ..

# Build backend
cargo build --release
```

Rust crate layout and architecture: [`crates/README.md`](crates/README.md).

### Configure Hub

```bash
./target/release/hub --init-config
```

This creates `config/hub.json`, prompts for the listen address and admin
credentials, generates a random agent token by default, and performs bcrypt
hashing inside the Rust binary. Save the displayed agent token for the next
step.

### Configure Agent

```bash
./target/release/agent --init-config
```

This creates `agent.toml`; paste the token printed by the Hub generator when
prompted.

Or use environment variables:

```bash
export FILEBOX_AGENT_HUB="https://your-hub-domain.com"
export FILEBOX_AGENT_TOKEN="your-agent-token"
export FILEBOX_AGENT_NAME="My Server"
export FILEBOX_AGENT_DATA_DIR="/var/lib/filebox"
```

Agents require `https://` or `wss://` hub URLs by default so the agent token
is not sent in plaintext. For local development against a plaintext hub only,
start the agent with `FILEBOX_ALLOW_INSECURE_HUB=1`.

### Start Services

```bash
# Start Hub
./target/release/hub

# Start Agent
./target/release/agent
```

Source builds can also invoke `--update`, but the updater always installs the
published Linux x86_64 release artifacts in place. On non-Linux development
machines, `--update` exits with a clear unsupported-platform error instead of
attempting a replacement.

### Access the Frontend

Open `http://localhost:3000` in a browser and log in with the configured credentials.

## Configuration Reference

### Hub Configuration (hub.json)

| Field | Description | Default |
|-------|-------------|---------|
| `listen_addr` | Listen address | `0.0.0.0:3000` |
| `agent_token_hash` | bcrypt hash of the agent auth token | Required |
| `users` | User list | Required |

### Agent Configuration (agent.toml)

| Field | Env Var | Description | Default |
|-------|---------|-------------|---------|
| `hub` | `FILEBOX_AGENT_HUB` | Hub server URL (`https://` or `wss://` by default) | Required |
| `token` | `FILEBOX_AGENT_TOKEN` | Agent auth token | Required |
| `name` | `FILEBOX_AGENT_NAME` | Agent display name | `default-agent` |
| `data_dir` | `FILEBOX_AGENT_DATA_DIR` | Data storage directory | OS local data directory + `filebox` |
| — | `FILEBOX_AGENT_SOFFICE` | Absolute path to `soffice` (enables Office preview) | unset |
| — | `FILEBOX_AGENT_SOFFICE_DIR` | Directory containing `soffice` / `program/soffice` | unset |

Office preview is optional. See [Office preview](#office-preview-optional-libreoffice) below.

## Office preview (optional LibreOffice)

Word and PowerPoint files open in the existing PDF viewer after the **agent**
converts them with LibreOffice. Spreadsheets (`xls`/`xlsx`/`xlsm`/`ods`) are
exported as one UTF-8 CSV per worksheet and use the existing CSV viewer. The
Hub never runs LibreOffice; the agent never bundles it.

- **Headless only** — filebox always invokes `soffice --headless` (no GUI,
  no display server required).
- **Rootless-friendly** — install under `$HOME` and point the agent at that
  binary; no `sudo apt` / system package needed.
- **Opt-in** — without a working `soffice`, the agent simply omits
  `capabilities.office_pdf_preview` and the UI stays download-only. In the
  browser, Settings → **Office preview** can also turn conversion off
  without uninstalling LibreOffice.

### 1. Install LibreOffice rootless (no sudo)

Pick the tarball that matches the agent host. Extract **into your home
directory** — do not install system-wide.

**Debian / Ubuntu-style** (deb packages inside the official tarball):

```bash
VERSION=26.2.5
PREFIX="$HOME/opt/libreoffice"
mkdir -p /tmp/lo-dl "$PREFIX" && cd /tmp/lo-dl
curl -L -O \
  "https://download.documentfoundation.org/libreoffice/stable/${VERSION}/deb/x86_64/LibreOffice_${VERSION}_Linux_x86-64_deb.tar.gz"
tar -xzf "LibreOffice_${VERSION}_Linux_x86-64_deb.tar.gz"
cd LibreOffice_*_Linux_x86-64_deb/DEBS
for deb in *.deb; do dpkg-deb -x "$deb" "$PREFIX"; done
```

**Rocky / RHEL-style** (rpm packages):

```bash
VERSION=26.2.5
PREFIX="$HOME/opt/libreoffice"
mkdir -p /tmp/lo-dl "$PREFIX" && cd /tmp/lo-dl
curl -L -O \
  "https://download.documentfoundation.org/libreoffice/stable/${VERSION}/rpm/x86_64/LibreOffice_${VERSION}_Linux_x86-64_rpm.tar.gz"
tar -xzf "LibreOffice_${VERSION}_Linux_x86-64_rpm.tar.gz"
cd LibreOffice_*_Linux_x86-64_rpm/RPMS
for rpm in *.rpm; do rpm2cpio "$rpm" | (cd "$PREFIX" && cpio -idm); done
```

Find and probe the binary (must print a LibreOffice version line):

```bash
SOFFICE="$(ls -d "$PREFIX"/opt/libreoffice*/program/soffice | head -1)"
"$SOFFICE" --headless --version
# e.g. LibreOffice 26.2.5.2 …
```

Bump `VERSION` to whatever is current on
[Document Foundation downloads](https://www.libreoffice.org/download/download-libreoffice/).

### 2. Point the agent at `soffice`

Prefer an absolute path:

```bash
export FILEBOX_AGENT_SOFFICE="$HOME/opt/libreoffice/opt/libreoffice26.2/program/soffice"
# Or: export FILEBOX_AGENT_SOFFICE_DIR="$HOME/opt/libreoffice/opt/libreoffice26.2/program"
```

Optional limits (defaults shown):

```bash
# FILEBOX_AGENT_OFFICE_TIMEOUT_SECS=120
# FILEBOX_AGENT_OFFICE_MAX_SRC_BYTES=536870912     # 512 MiB
# FILEBOX_AGENT_OFFICE_MAX_PDF_BYTES=1073741824    # 1 GiB combined derived output
# FILEBOX_AGENT_OFFICE_MAX_LOG_BYTES=8388608       # 8 MiB
# FILEBOX_AGENT_OFFICE_MAX_MEMORY_BYTES=2147483648 # 2 GiB resident memory (Linux)
# FILEBOX_AGENT_OFFICE_CACHE_BYTES=1073741824      # 1 GiB on-disk preview cache
```

The cache budget counts derived files, metadata, manifests, and empty-file
entries, and must be large enough for one complete converted preview. If an
output cannot fit, the request fails safely with `office_cache_too_small`
instead of reporting success for an immediately evicted file. On Linux the
memory limit is checked against the converting process tree's resident memory
only while a preview request is active. It deliberately does not use
`RLIMIT_AS`: LibreOffice Impress can reserve several GiB of virtual address
space while using far less physical memory. Other platforms retain the
portable file-size, descriptor, CPU, timeout, and process-group limits.

PDF output is structurally validated before it enters the cache. A malformed
or truncated cached PDF is discarded automatically; if browser PDF decoding
still fails, **Retry** forces one clean conversion instead of returning the
same cached artifact.

Restart the agent. On a successful probe it advertises
`office_pdf_preview: true` (the capability name is retained for compatibility).
Derived files are cached at `/.filebox/office-cache/<key>.(pdf|csv)`. PDF
outputs use the PDF viewer. Worksheet CSVs use the existing CSV viewer: files
from 2 MiB through 15 MiB require confirmation, while files larger than 15 MiB
stay download-only. Progress is cancelable; a second convert while one is
running returns busy.

The agent does not poll or periodically monitor LibreOffice. It validates the
configured binary at startup and otherwise reacts only to preview requests. If
LibreOffice is later removed or becomes non-executable, that request returns a
stable, retryable `office_unavailable` error. Other conversion failures use
stable Office-specific errors; the original download remains available, and
file browsing plus unrelated previews continue normally.

### 3. Verify

```bash
# On the agent host
"$FILEBOX_AGENT_SOFFICE" --headless --version

# In the Hub UI: agent detail / API should show
# capabilities.office_pdf_preview == true
```

For local bring-up notes and an automated fake-soffice e2e script, see
[`docs/local-debugging.md`](docs/local-debugging.md) §8.

## Usage

### Adding Root Directories

1. Log in to the frontend
2. Select an Agent in the sidebar
3. Open Settings
4. Add a root (absolute path, or `~/…` for a path under the agent's home)
5. Save

The Agent validates the path and applies it immediately. Invalid new roots
are rejected without destroying the last known-good configuration.

### Browsing Files

1. Select an Agent
2. Open Files
3. Navigate with the tree, address bar, or folder clicks
4. Click files to preview (multi-tab on desktop)
5. Use the filename filter and date filter as needed
6. Pin frequently used folders from the sidebar

### Collections

1. Select an Agent
2. Open Collections to create a named collection
3. Or from Files, use the row action to add a file to an existing or new collection
4. Open a collection to preview its files; remove items or open a file's location in Files

Collections are stored on the agent and survive reconnects. They do not move
or copy files on disk — they are virtual references only.

### Workspace Search

1. Select an Agent
2. Open Search
3. Choose Files (filename) or Content (regex in file bodies)
4. Pick a root and optional folder; optionally filter by extensions,
   ignore folder names, and max directory depth
5. Click a hit to open its parent folder in Files

Search runs on the agent with progress and cancel. Ignore / depth are
set in the UI and sent with each request (browser-local defaults).
Legacy agents without the capability show an unsupported message.

### System Monitoring

1. Select an Agent
2. Open Stats
3. Use Overview / Users / Processes tabs
4. Data is TTL-cached on the agent (default 60s)

### Sensitive File Protection

The following files/directories are denied by default (abbreviated):

```text
.git/  .ssh/  .gnupg/  .aws/  .kube/
.env*  *.pem  *.key  id_*  credentials*.json  *.sqlite*
...
```

Full list in `crates/protocol/src/denylist.rs`.

## Deployment

### Rootless Deployment (Recommended)

filebox is designed to run fully rootless:

```bash
# Download pre-built tarballs from the Releases page, then extract into
# a user-owned directory — no root, no system service files needed.

mkdir -p ~/filebox/bin
tar xzf filebox-hub-*-x86_64-musl.tar.gz -C ~/filebox --strip-components=1
~/filebox/bin/hub
```

Then run directly or with your preferred process manager.

### Nginx Reverse Proxy

```nginx
server {
    listen 443 ssl;
    server_name filebox.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # SSE
        proxy_buffering off;
        proxy_cache off;
    }
}
```

## License

[MIT](LICENSE)
