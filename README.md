# Filebox

A minimal, secure, read-only remote file browser.

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
No Rust toolchain, no Node, no compilation needed on the target machine.

```bash
# 1. Download the matching tarball from the latest release page:
#    filebox-hub-<version>-x86_64-musl.tar.gz     (Hub machine)
#    filebox-agent-<version>-x86_64-musl.tar.gz   (Agent machine)

# 2. Extract
tar xzf filebox-hub-*-x86_64-musl.tar.gz     # Hub
tar xzf filebox-agent-*-x86_64-musl.tar.gz   # Agent

# 3. Generate config interactively (prints to stdout — redirect to file)
./scripts/gen_config.sh hub   > config/hub.json     # on Hub machine
./scripts/gen_config.sh agent > agent.toml          # on Agent machine

# 4. Run
filebox-hub-*/bin/hub          # Hub
filebox-agent-*/agent          # Agent
```

`gen_config.sh` only needs `openssl` (already on every Linux) and `mkpasswd`
(from the `whois` package, for bcrypt hashing). The tarball also bundles a
`hub.json.example` / `agent.toml.example` if you'd rather fill in values by
hand.

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

### 2. Configure Hub

Create a `hub.json` file:

```json
{
  "listen_addr": "0.0.0.0:3000",
  "agent_token_hash": "$2b$12$...",
  "users": [
    {
      "username": "admin",
      "password_hash": "$2b$12$..."
    }
  ]
}
```

Generate password hashes:

```bash
# Using bcrypt CLI or any bcrypt tool
# Agent token hash
echo -n "your-agent-token" | bcrypt-cli

# User password hash
echo -n "your-password" | bcrypt-cli
```

### 3. Configure Agent

Create an `agent.toml` file:

```toml
hub = "https://your-hub-domain.com"
token = "your-agent-token"
name = "My Server"
data_dir = "/var/lib/filebox"
```

Or use environment variables:

```bash
export FILEBOX_AGENT_HUB="https://your-hub-domain.com"
export FILEBOX_AGENT_TOKEN="your-agent-token"
export FILEBOX_AGENT_NAME="My Server"
export FILEBOX_AGENT_DATA_DIR="/var/lib/filebox"
```

### 4. Start Services

```bash
# Start Hub
./target/release/hub

# Start Agent
./target/release/agent
```

### 5. Access the Frontend

Open `http://localhost:3000` in a browser and log in with the configured credentials.

## Configuration Reference

### Hub Configuration (hub.json)

```json
{
  "listen_addr": "0.0.0.0:3000",
  "agent_token_hash": "$2b$12$...",
  "users": [
    {
      "username": "admin",
      "password_hash": "$2b$12$..."
    },
    {
      "username": "user1",
      "password_hash": "$2b$12$..."
    }
  ]
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `listen_addr` | Listen address | `0.0.0.0:3000` |
| `agent_token_hash` | bcrypt hash of the agent auth token | Required |
| `users` | User list | Required |

### Agent Configuration (agent.toml)

```toml
hub = "https://your-hub-domain.com"
token = "your-agent-token"
name = "My Server"
data_dir = "/var/lib/filebox"
```

| Field | Env Var | Description | Default |
|-------|---------|-------------|---------|
| `hub` | `FILEBOX_AGENT_HUB` | Hub server URL | Required |
| `token` | `FILEBOX_AGENT_TOKEN` | Agent auth token | Required |
| `name` | `FILEBOX_AGENT_NAME` | Agent display name | `unknown` |
| `data_dir` | `FILEBOX_AGENT_DATA_DIR` | Data storage directory | `./data` |

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
