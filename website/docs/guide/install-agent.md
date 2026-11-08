# Install Agent

Install an Agent on every machine you want to browse. It dials out to the Hub — no public IP or inbound ports required.

## Install

```bash
tar xzf filebox-agent-*-x86_64-musl.tar.gz
cd filebox-agent-*
./agent --init-config
./agent
```

`--init-config` creates `agent.toml` (mode 0600) and asks you to:

1. Paste the **token** printed by Hub `--init-config`
2. Enter the Hub URL (production: `https://filebox.example.com`)
3. Set display name, data directory, etc.

## Environment variables (optional)

Useful for systemd, containers, or orchestration:

| Variable | Meaning |
|----------|---------|
| `FILEBOX_AGENT_HUB` | Hub URL (`https://` or `wss://`) |
| `FILEBOX_AGENT_TOKEN` | Token printed at Hub init |
| `FILEBOX_AGENT_NAME` | Sidebar display name (default `default-agent`) |
| `FILEBOX_AGENT_DATA_DIR` | State directory (roots, collections, temp transfer, agent_id, …) |
| `FILEBOX_AGENT_TRUSTED_PORTS` | Agent-local Web forwarding trust: ports/ranges such as `3080,8888,9000-9010`; empty/unset denies all. Overrides `agent.toml` `trusted_ports`; restart to apply. See [trusted ports](/ops/agent#trusted-web-ports) |
| `FILEBOX_AGENT_AI_AGENTS_ENABLED` | Enable or disable AI Agents on this Agent |
| `FILEBOX_AGENT_AI_AGENTS_BACKEND` | Lock AI Agents to a backend kind |
| `FILEBOX_ALLOW_INSECURE_HUB` | Allow plaintext `ws://` / `http://` (dev only) |
| `FILEBOX_AGENT_SOFFICE` | Path to LibreOffice `soffice` (optional Office preview) |
| `FILEBOX_AGENT_SOFFICE_DIR` | Directory containing `soffice` |

Example:

```bash
export FILEBOX_AGENT_HUB="https://filebox.example.com"
export FILEBOX_AGENT_TOKEN="the-token-from-hub"
export FILEBOX_AGENT_NAME="web-01"
export FILEBOX_AGENT_DATA_DIR="/var/lib/filebox"
./agent
```

Local plaintext Hub for development:

```bash
FILEBOX_AGENT_HUB="ws://127.0.0.1:3000" \
FILEBOX_AGENT_TOKEN="dev-token" \
FILEBOX_AGENT_NAME="lab-server" \
FILEBOX_ALLOW_INSECURE_HUB=1 \
FILEBOX_AGENT_DATA_DIR="/tmp/fbx-agent-data" \
./agent
```

## After connecting

1. Open the Hub, log in, and confirm the machine appears under sidebar **Agents** (green Online, latency, root count).
2. You still need **Settings → Add Root** in the UI before anything is browsable. See [First login & add roots](./first-login).

![Settings: connected Agent and roots](/screenshots/11-settings.png)

After disconnects the Agent reconnects indefinitely; `agent_id` persists in the data directory so the sidebar does not gain duplicates.

> Do not run two Agent processes against the same data directory — they will fight over one identity. Give each Agent its own `FILEBOX_AGENT_DATA_DIR`.

## Optional capabilities

| Capability | How to enable |
|------------|---------------|
| Office preview | Install LibreOffice and set `FILEBOX_AGENT_SOFFICE` — see [Office preview](/ops/office) |
| Transfer | Capability `temp_upload` (on by default in current releases); writes only to a dedicated scratch dir |
| Ports | Set Agent `trusted_ports` / `FILEBOX_AGENT_TRUSTED_PORTS`; denies all by default. `all` is allowed but not recommended. Disable the feature entirely with `FILEBOX_AGENT_PORT_FORWARD=off` |

With Office enabled, Settings shows the Office preview toggle.

## systemd example (optional)

```ini
[Unit]
Description=filebox Agent
After=network.target

[Service]
Type=simple
Environment=FILEBOX_AGENT_HUB=https://filebox.example.com
Environment=FILEBOX_AGENT_TOKEN=REPLACE_ME
Environment=FILEBOX_AGENT_NAME=hpc-node-01
Environment=FILEBOX_AGENT_DATA_DIR=/var/lib/filebox
ExecStart=/opt/filebox-agent/agent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Updates

```bash
./agent --update
```

Verifies checksums and replaces in place. Prefer upgrading Hub / Agent / frontend major versions together; protocol capabilities expect aligned versions (see release notes).

More ops detail: [Agent config & updates](/ops/agent)
