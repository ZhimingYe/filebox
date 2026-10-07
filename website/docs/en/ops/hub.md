# Hub config & HTTPS

The Hub is the only central service both browsers and Agents must reach. Always put TLS termination in front in production.

## Quick recap

1. `./bin/hub --init-config` → writes `config/hub.json`, **prints the Agent token once**  
2. Reverse-proxy terminates TLS and forwards WebSockets (below)  
3. Agent Hub URL uses `https://filebox.example.com`  
4. `./bin/hub --update` upgrades in place  

Full install steps: [Install Hub](/en/guide/install-hub).

## Config fields

| Field | Meaning | Default |
|-------|---------|---------|
| `listen_addr` | Listen address | `0.0.0.0:3000` |
| `agent_token_hash` | bcrypt hash of the Agent token | set at init |
| `users` | Login accounts | set at init |

Env vars: `FILEBOX_DEV_MODE`, `FILEBOX_LISTEN_ADDR`, `FILEBOX_FRONTEND_DIR`, `FILEBOX_CONFIG_PATH`, `FILEBOX_TRUST_XFF`.

## HTTPS and WebSocket

The Hub process itself is HTTP. Minimal nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_cache off;
}
```

Without WebSocket upgrade, Agents vanish from the sidebar or flap constantly.

For local development, `FILEBOX_ALLOW_INSECURE_HUB=1` lets Agents use `http://` — **never** in production.

## Health check

```bash
curl -s https://filebox.example.com/api/health
```

UI: click sidebar **v2.x.x** for About / Diagnostics (Hub status, uptime, Agents).

![About / Diagnostics](/screenshots/07-health.png)

## Login audit

Sidebar **Audit**: success / failure / rate-limit and logout events in a rolling JSONL next to the Hub (~2000 entries). Does not depend on the selected Agent.

![Audit](/screenshots/12-audit.png)

## Updates

```bash
./bin/hub --update
```
