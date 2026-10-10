# Install Hub

The Hub runs on a central host you control (small VPS, LAN box, or container). Browsers and Agents connect only to it; the Hub ships frontend static assets, so users remember one URL.

## Prerequisites

- Linux x86_64 (release builds are musl-static and run on most distros)
- An address browsers can reach (prepare TLS certificates for production)
- Outbound path for Agents to reach Hub on 443 (or your reverse-proxy port)

## Install

```bash
# Download from https://github.com/ZhimingYe/filebox/releases/latest
tar xzf filebox-hub-*-x86_64-musl.tar.gz
cd filebox-hub-*
./bin/hub --init-config
./bin/hub
```

`--init-config` walks you through:

1. **Listen address** (default `0.0.0.0:3000`)
2. **Admin username / password**
3. **Agent token** (plaintext printed once; config stores only a bcrypt hash)

It writes:

- `config/hub.json` — runtime config
- Frontend assets already live in the package `frontend/dist/`; Hub serves them on start

Save the Agent token to a password manager or Agent config immediately; plaintext cannot be recovered from the Hub later.

## Key config fields

| Field | Meaning | Default |
|-------|---------|---------|
| `listen_addr` | Listen address | `0.0.0.0:3000` |
| `agent_token_hash` | Hash of the Agent token | set at init |
| `users` | Login accounts | set at init |

Environment variables can override some behavior (common in development):

| Variable | Effect |
|----------|--------|
| `FILEBOX_DEV_MODE=1` | Insecure local defaults: `admin` / `dev-password`, token `dev-token`, bind `127.0.0.1` |
| `FILEBOX_LISTEN_ADDR` | Override listen address |
| `FILEBOX_FRONTEND_DIR` | Absolute path to `frontend/dist` |
| `FILEBOX_CONFIG_PATH` | Path to `hub.json` |
| `FILEBOX_TRUST_XFF` | Trust `X-Forwarded-For` (login rate-limit IP) |

## HTTPS (required in production)

Hub itself speaks plain HTTP; terminate TLS with a reverse proxy. The Agent’s Hub URL must be `https://` / `wss://` (unless you explicitly set `FILEBOX_ALLOW_INSECURE_HUB=1`, local development only).

HTTPS protects the Agent token in transit — always terminate TLS in production.

### nginx example

```nginx
server {
    listen 443 ssl;
    server_name filebox.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket (Agent connections) and live status
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_cache off;
    }
}
```

Checklist:

- `proxy_http_version 1.1` + `Upgrade` / `Connection` (Agent WebSocket)
- `proxy_buffering off` (live status)
- Caddy / Traefik also work if they upgrade WebSockets the same way

Without WebSocket upgrade, Agents vanish from the sidebar or flap constantly.

## systemd example (optional)

```ini
[Unit]
Description=filebox Hub
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/filebox-hub
ExecStart=/opt/filebox-hub/bin/hub
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## Verify the Hub is up

```bash
curl -s http://127.0.0.1:3000/api/health
# {"hub":{"status":"ok","uptime_sec":…,"version":"2.2.0"}}
```

Open the Hub URL in a browser — you should see the login page:

![Login page](/screenshots/09-login.png)

Click the version number at the bottom of the sidebar for About / Diagnostics (Hub status, Agent list):

![About / Health](/screenshots/07-health.png)

## Login audit

Sidebar **Audit** records success / failure / rate-limit and logout events; logs are a rolling JSONL next to the Hub (~2000 entries).

![Audit](/screenshots/12-audit.png)

## Updates

```bash
./bin/hub --update
```

Downloads the latest release, verifies checksums, and replaces in place. Prefer upgrading Hub / Agent / frontend major versions together.

Next: [Install Agent](./install-agent)
