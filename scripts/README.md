# Filebox Install Scripts

Rootless install scripts. No root required. All files go into user directories.

Scripts only handle configuration, build, and installation. How you run the services is up to you.

## Quick Start

### Server (Hub)

```bash
cd filebox
chmod +x scripts/serve_at_server.sh
./scripts/serve_at_server.sh
```

The script walks you through:
- Listen port
- Admin username and password
- Agent token generation
- Auto build and install

### Client (Agent)

On the machine you want to access:

```bash
cd filebox
chmod +x scripts/serve_at_client.sh
./scripts/serve_at_client.sh
```

The script walks you through:
- Hub server URL
- Agent token
- Agent name
- Install method (download or build)

## System Requirements

### Server
- Linux (x86_64 or aarch64)
- Rust >= 1.75
- Node.js >= 18
- Python 3 + bcrypt module
- ~2GB disk space (for compilation)

### Client
- Linux (x86_64 or aarch64)
- No extra dependencies (with prebuilt binary)
- Or same toolchain as server (for local build)

## Install Locations

```
Server:
~/filebox/
├── bin/hub              # Hub binary
├── frontend/dist/       # Frontend static files
├── config/hub.json      # Configuration
└── logs/                # Log directory

Client:
~/filebox-agent/
├── agent                # Agent binary
├── agent.toml           # Configuration
└── data/                # Persistent data
```

## Running

After installation, start services manually:

```bash
# Hub (auto-discovers config/hub.json next to the binary)
~/filebox/bin/hub

# Agent
~/filebox-agent/agent
```

Run in background:

```bash
# Hub
nohup ~/filebox/bin/hub > ~/filebox/logs/hub.log 2>&1 &

# Agent
nohup ~/filebox-agent/agent &
```

Capture logs to a file:

```bash
~/filebox/bin/hub > ~/filebox/logs/hub.log 2>&1 &
tail -f ~/filebox/logs/hub.log
```

## Configuration Files

### Hub (hub.json)

```json
{
  "listen_addr": "0.0.0.0:3000",
  "agent_token_hash": "$2b$12$...",
  "users": [
    { "username": "admin", "password_hash": "$2b$12$..." }
  ]
}
```

### Agent (agent.toml)

```toml
hub = "https://filebox.example.com"
token = "your-agent-token"
name = "My Server"
data_dir = "/home/user/filebox-agent/data"
```

Environment variable overrides:
- `FILEBOX_AGENT_HUB`
- `FILEBOX_AGENT_TOKEN`
- `FILEBOX_AGENT_NAME`
- `FILEBOX_AGENT_DATA_DIR`

## Uninstall

```bash
# Server
rm -rf ~/filebox

# Client
rm -rf ~/filebox-agent
```

## FAQ

### Q: How do I change the configuration?

Edit the config file directly, then restart the process.

### Q: Agent cannot connect to Hub?

1. Check the Hub URL is correct
2. Check the token matches
3. Check network connectivity
4. Check Agent stdout/stderr

### Q: How do I add multiple users?

Edit `hub.json` and add entries to the `users` array:

```json
{
  "users": [
    { "username": "admin", "password_hash": "..." },
    { "username": "user2", "password_hash": "..." }
  ]
}
```

### Q: How do I set up Nginx as a reverse proxy?

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

## Security

1. **Use HTTPS**: Nginx + Let's Encrypt in production
2. **Strong passwords**: Use strong passwords and rotate regularly
3. **Firewall**: Only open necessary ports
4. **Updates**: Keep up to date with the latest release
