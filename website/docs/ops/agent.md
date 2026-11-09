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
| `FILEBOX_AGENT_TRUSTED_PORTS` | Agent-local trusted Web ports; overrides TOML `trusted_ports`, including an empty override (deny all); restart to apply |
| `FILEBOX_AGENT_AI_AGENTS_ENABLED` | Enable or disable AI Agents on this Agent |
| `FILEBOX_AGENT_AI_AGENTS_BACKEND` | Lock AI Agents to a backend kind |
| `FILEBOX_AGENT_HC` | Explicit hc executable path (experimental backend; otherwise searches PATH) |
| `FILEBOX_ALLOW_INSECURE_HUB` | Allow plaintext Hub (dev only) |
| `FILEBOX_AGENT_SOFFICE` / `_DIR` | LibreOffice (optional) |
| `FILEBOX_AGENT_STATS_TTL_SECS` | sysinfo cache TTL (default 60) |
| `FILEBOX_AGENT_DIR_CACHE_RESTAT_COOLDOWN_MS` | Directory cache re-stat cooldown |

Office-related limits: [Office preview](./office).

## Trusted Web ports

Web forwarding denies all ports by default. On the Agent machine, add a string to `agent.toml`:

```toml
trusted_ports = "3080,8888,9000-9010"
```

Or set `FILEBOX_AGENT_TRUSTED_PORTS="3080,8888,9000-9010"`. The environment overrides TOML, including an empty value. Restart the Agent after changes. Syntax is comma-separated decimal ports (1–65535) or inclusive ascending ranges; whitespace is accepted. Empty/unset denies all. Malformed values prevent startup. Case-insensitive `"all"` permits every loopback port, logs a warning, and is **not recommended**; prefer an explicit list. TOML arrays are not supported.

The policy stays Agent-local and is never advertised to the Hub. The Agent rejects untrusted desired forwards without replacing the saved list and refuses untrusted tunnel opens. Already-saved forwards remain in `agent_state.json`; Ports marks them **Not trusted by agent**, disables Open, and displays Agent rejection messages. The proxy returns 403 for untrusted forwards. Only each configured forward's trust flag is reported, not the allowed ports. Upgrade Agent and Hub together: legacy Agents cannot enforce this setting, and a missing trust flag is treated as untrusted by current Hubs.

Only forward trusted apps: they retain their local powers (including writing files or executing code) and share the Hub origin, so their scripts can call Filebox APIs as the signed-in user. `FILEBOX_AGENT_PORT_FORWARD=off` disables forwarding entirely.

## Experimental hc backend

Install [herdr-core](https://github.com/herdrdev/herdr-core#install) on the
Agent machine and make `hc` available to the Filebox Agent. Only local live
terminals explicitly labelled `fb=<name>` or `filebox=<name>` are included.
Choose the name shown in Filebox for each terminal:

```sh
hc run --bg --label fb=frontend -- claude
hc run --bg --label Filebox=backend -- claude
hc label t7 fb=review       # connect or rename an existing terminal
hc label t7 fb=             # remove this label to revoke access
```

Use the actual terminal address instead of `t7`, and your program instead
of `claude`, starting each terminal in its working directory. A labelled terminal
may run a coding agent, a shell or another program; Filebox does not classify it.
Label keys are
case-insensitive in Filebox (`fb`, `FB`, `filebox`, `Filebox`, `FILEBOX`); values
are user-chosen names, not fixed codes. Empty/blank values do not opt in.
The original `filebox=ai-agent` marker keeps the hc terminal name. If both keys
exist, `fb` supplies the display name. IDs remain visible and identify all
operations, even for duplicate or changed names. To revoke access, remove all
supported labels using their exact original capitalization, e.g.
`hc label t7 Filebox=` for `Filebox=backend`.

Select **hc (experimental)** in Agent Settings; automatic selection
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
