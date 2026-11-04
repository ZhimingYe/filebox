# Agent config & updates

Install an Agent on every host you want to browse; it dials out to the Hub. Install steps: [Install Agent](/guide/install-agent).

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
| `FILEBOX_AGENT_AI_AGENTS_ENABLED` | Enable or disable AI Agents on this Agent |
| `FILEBOX_AGENT_AI_AGENTS_BACKEND` | Lock AI Agents to a backend kind |
| `FILEBOX_AGENT_HC` | Explicit hc executable path (experimental backend; otherwise searches PATH) |
| `FILEBOX_ALLOW_INSECURE_HUB` | Allow plaintext Hub (dev only) |
| `FILEBOX_AGENT_SOFFICE` / `_DIR` | LibreOffice (optional) |
| `FILEBOX_AGENT_STATS_TTL_SECS` | sysinfo cache TTL (default 60) |
| `FILEBOX_AGENT_DIR_CACHE_RESTAT_COOLDOWN_MS` | Directory cache re-stat cooldown |

Office-related limits: [Office preview](./office).

## Experimental hc backend

Install [herdr-core](https://github.com/herdrdev/herdr-core#install) on the
Agent machine and make `hc` available to the Filebox Agent. Only local live
terminals explicitly labelled `fb=1` or `filebox=ai-agent` are included:

```sh
hc run --bg --label fb=1 -- claude
hc label t7 fb=1            # opt in an existing coding-agent terminal
hc label t7 fb= filebox=     # revoke both supported opt-in labels
```

Use the actual terminal address instead of `t7`, and your coding agent instead
of `claude`. Select **hc (experimental)** in Agent Settings; automatic selection
still prefers Herdr when both are installed. `FILEBOX_AGENT_AI_AGENTS_BACKEND=hc`
locks the selection. hc uses the Agent process's hc session/config environment;
`hc connect` can start its local core automatically. Status requires the
program's OSC 7501 reports; otherwise it is Unknown. Prompt review remains
unchanged. Unlabelled, finished and remote-machine terminals are excluded.
Cancellation does not retract a prompt already accepted by hc; inspect output
before retrying. Tested with hc 0.1.17, API generation 1.

## Updates

```bash
./agent --update
```

Verifies checksums and replaces in place. Prefer upgrading with Hub and frontend major versions together.

## Optional capability switches

| Capability | Where to configure |
|------------|--------------------|
| Office preview | [Office preview](./office) |
| Transfer | Capability `temp_upload`; rules in [Transfer](/features/transfer) |

Confirm connection status and enabled roots in UI **Settings**:

![Settings](/screenshots/11-settings.png)
