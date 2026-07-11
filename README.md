# Filebox

A minimal, secure, read-only remote file browser.

> **[Live site →](https://zhimingye.github.io/filebox/)** — interactive product
> tour, architecture diagram, and install walkthrough.

## Overview

Filebox is a read-only remote file browsing system that lets you access files on remote servers through a web browser. It consists of three parts:

- **Frontend**: Web UI for browsing files and managing servers
- **Hub**: Central server handling authentication and request routing
- **Agent**: Daemon running on remote servers, providing file access

```text
Browser ──HTTPS──▶ Hub ◀──WSS── Agent ──▶ local files
```

Agents connect outward to the Hub. No public IPs, port mapping, or VPN required.

## Features

### File Browsing
- Virtualized file list for large directories
- Glob/regex filename filter
- File modification time sorting
- One-click refresh

### File Preview
- Markdown rendering
- Code highlighting with word-wrap toggle
- PDF reader
- Image viewer
- Binary file detection

### System Monitoring
- CPU usage
- Memory/Swap usage
- System load
- Top processes by memory

### Security
- Username/password authentication (bcrypt)
- Agent token authentication (bcrypt)
- Sensitive files denied by default
- Read-only access
- Path safety checks

### Other
- Responsive mobile layout
- Automatic Agent reconnection
- Real-time status updates (SSE)
- Request progress display
- Request cancellation

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
git clone <repository-url>
cd filebox

# Build frontend
cd frontend
npm install
npm run build
cd ..

# Build backend
cargo build --release
```

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

## Usage

### Adding Root Directories

1. Log in to the frontend
2. Select an Agent in the sidebar
3. Click "Settings"
4. Click "Add Root"
5. Enter a name and path for the root directory
6. Click "Save"

The Agent validates the path and applies it immediately.

### Browsing Files

1. Select an Agent
2. Click "Files"
3. Click folders to navigate
4. Click files to preview
5. Use the filter bar to search

### System Monitoring

1. Select an Agent
2. Click "Stats"
3. View CPU, memory, load, and process info
4. Data refreshes every 30 seconds

### Sensitive File Protection

The following files/directories are denied by default:

```text
.git/
.ssh/
.env
*.pem
*.key
id_rsa
credentials.json
...
```

Full list in `crates/protocol/src/denylist.rs`.

## Deployment

### Rootless Deployment (Recommended)

Filebox is designed to run fully rootless:

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
