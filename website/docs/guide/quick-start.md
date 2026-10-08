# Quick start

About four steps: download → init Hub → start Hub → init and connect Agent. Then log in in the browser, Add Root, and browse. Commands match the [README](https://github.com/ZhimingYe/filebox/blob/main/README.md).

![Sidebar and Files overview](/screenshots/00-sidebar-overview.png)

## 1. Download

Grab the latest musl static packages from [Releases](https://github.com/ZhimingYe/filebox/releases/latest) (docs align with **v2.1.0**):

- `filebox-hub-<ver>-x86_64-musl.tar.gz` — on a host you can expose over HTTPS
- `filebox-agent-<ver>-x86_64-musl.tar.gz` — on each backend host you want to browse

Most users do not need to build from source. To build from source:

```bash
git clone https://github.com/ZhimingYe/filebox.git
cd filebox && cd frontend && npm install && npm run build && cd ..
cargo build --release
```

## 2. Initialize and start Hub

```bash
tar xzf filebox-hub-*-x86_64-musl.tar.gz
cd filebox-hub-*
./bin/hub --init-config   # listen address, admin account, Agent token (printed once)
./bin/hub                 # default :3000, ships with frontend static assets
```

`--init-config` writes `config/hub.json` and **prints the Agent token once** (Hub stores only a bcrypt hash). Save the token immediately — you cannot recover plaintext from the Hub later.

In production put nginx / Caddy / Traefik in front to terminate TLS. See [Install Hub](./install-hub) and [Hub config & HTTPS](/ops/hub).

### Local dev shortcut (optional)

When you do not need `hub.json`, use development mode (local only):

```bash
FILEBOX_DEV_MODE=1 \
FILEBOX_FRONTEND_DIR="$(pwd)/frontend/dist" \
RUST_LOG=info ./bin/hub
# Login: admin / dev-password ; Agent token: dev-token
```

## 3. Initialize and start Agent

On each backend host:

```bash
tar xzf filebox-agent-*-x86_64-musl.tar.gz
cd filebox-agent-*
./agent --init-config     # paste Hub token, fill Hub URL (https://…)
./agent
```

Or use environment variables (systemd / containers):

```bash
export FILEBOX_AGENT_HUB="https://filebox.example.com"
export FILEBOX_AGENT_TOKEN="the-token-from-hub"
export FILEBOX_AGENT_NAME="hpc-node-01"
export FILEBOX_AGENT_DATA_DIR="/var/lib/filebox"
./agent
```

Plaintext `ws://` / `http://` Hub URLs also require `FILEBOX_ALLOW_INSECURE_HUB=1` (dev only).

The Agent is **outbound only**; open no inbound firewall holes for it. Once connected it appears in the sidebar.

## 4. Log in and add a root

1. Open the Hub URL in a browser (production `https://…`; dev `http://localhost:3000`).
2. The login page runs **PoW verification** first (wait until Verification shows Ready, then Continue).
3. Under sidebar **Agents**, select the connected machine.
4. **Settings → Add Root** with an absolute path or `~/…`.
5. Open **Files** and start browsing.

![Login page (with PoW Verification)](/screenshots/09-login.png)

![File browse](/screenshots/01-files-browse.png)

![Settings: connection and Workspace roots](/screenshots/11-settings.png)

## Next steps

| Goal | Read |
|------|------|
| Deeper Hub / HTTPS | [Install Hub](./install-hub) · [Hub ops](/ops/hub) |
| Multi-host Agents, env vars | [Install Agent](./install-agent) · [Agent ops](/ops/agent) |
| First login and views | [First login & add roots](./first-login) |
| Search / collections / transfer / terminal | [Feature tour](/features/browse) |
| Word / PPT / Excel preview | [Office preview](/ops/office) |
