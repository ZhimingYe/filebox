# Agent config & updates

Install an Agent on every host you want to browse; it dials out to the Hub. Install steps: [Install Agent](/en/guide/install-agent).

## State and config

- Config file: `agent.toml` (created by `--init-config`, mode 0600).
- State directory defaults under the system data dir as `filebox` (override with `FILEBOX_AGENT_DATA_DIR`).
- Roots, pins, and collections are pushed from the UI and persisted; bad updates do not wipe the last good config.
- After disconnects it reconnects indefinitely with a stable identity — no duplicate sidebar entries.
- Multiple instances must use different `FILEBOX_AGENT_DATA_DIR` values.

## Environment variables

| Variable | Meaning |
|----------|---------|
| `FILEBOX_AGENT_HUB` | Hub URL (`https://` / `wss://`) |
| `FILEBOX_AGENT_TOKEN` | Agent token |
| `FILEBOX_AGENT_NAME` | Sidebar display name |
| `FILEBOX_AGENT_DATA_DIR` | State directory |
| `FILEBOX_ALLOW_INSECURE_HUB` | Allow plaintext Hub (dev only) |
| `FILEBOX_AGENT_SOFFICE` / `_DIR` | LibreOffice (optional) |
| `FILEBOX_AGENT_TERMINAL_TOTP_SECRET` | Terminal 2FA (optional) |
| `FILEBOX_AGENT_STATS_TTL_SECS` | sysinfo cache TTL (default 60) |
| `FILEBOX_AGENT_DIR_CACHE_RESTAT_COOLDOWN_MS` | Directory cache re-stat cooldown |

Office-related limits: [Office preview](./office).

## Updates

```bash
./agent --update
```

Verifies checksums and replaces in place. Prefer upgrading with Hub and frontend major versions together.

## Optional capability switches

| Capability | Where to configure |
|------------|--------------------|
| Office preview | [Office preview](./office) |
| Terminal 2FA | `./agent --setup-terminal-2fa` or env — see [Terminal](/en/features/terminal) |
| Transfer | Capability `temp_upload`; rules in [Transfer](/en/features/transfer) |

Confirm connection status and enabled roots in UI **Settings**:

![Settings](/screenshots/11-settings.png)
