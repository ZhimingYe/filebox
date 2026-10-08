# What is filebox

filebox is a **read-only remote file browser** for labs / HPC / self-hosted servers: install a small Agent on each machine, run a Hub on a host you control, open one HTTPS page in a browser, and you can browse files, preview plots and datasets, search workspaces, and check system load.

```text
Browser ──HTTPS──▶ Hub ◀──WSS (outbound)── Agent ──▶ local files
```

![filebox UI overview (live Hub + Agent)](/screenshots/00-sidebar-overview.png)

- **Browser**: talks only to the Hub, never directly to Agents.
- **Hub**: authenticates users, serves the frontend, routes requests to the right machine.
- **Agent**: runs on the target host and **dials out** to the Hub. The target needs no public IP, inbound ports, VPN, or port forwarding. After disconnects it reconnects automatically with a stable identity — no duplicate sidebar entries.

## Who it is for

Researchers, analysts, and data scientists whose results live as files on shared servers and who need to **glance at figures, tables, and logs** from a phone or laptop without `scp`-ing an entire archive for a quick look.

filebox is not a sync/drive product and not a full remote desktop — it is the “front door” to result files: open, preview, search, occasionally upload a small scratch file, or open a TOTP-protected terminal.

## What you can do (v2.1.0)

| Capability | Notes | Docs |
|------------|-------|------|
| **Files** | Smooth large listings, breadcrumbs, filters, pins, [multi-tab preview](/en/features/tabs) | [Browse files](/en/features/browse) |
| **Explorer** | Tree-style browsing; shares current location with Files | [Explorer](/en/features/explorer) |
| **Search** | Filename or content regex; floating panel / bottom sheet | [Search](/en/features/search) |
| **Collections** | Virtual file groups across directories — no copy, no move | [Collections](/en/features/collections) |
| **Transfer** | The only writable scratch upload folder (quota, no overwrite) | [Transfer](/en/features/transfer) |
| **Terminal** | Optional; Agent-local TOTP-gated interactive shell (**not sandboxed**) | [Terminal](/en/features/terminal) |
| **Settings** | Manage roots, Office preview toggle | [First login](/en/guide/first-login) |
| **System** | CPU / memory / load / per-user usage / process table | [System monitor](/en/features/stats) |
| **Audit** | Login audit (Hub-level; does not require a selected Agent) | [Hub ops](/en/ops/hub) |

## Default security boundaries

- Browse protocol is **read-only**: no remote edit, delete, or rename.
- Sensitive paths (`.ssh/`, `.env*`, `*.pem`, …) are denied by default even inside allowed roots.
- Browse is strictly confined to added roots; `..` and symlink escapes are blocked.
- Two explicit exceptions (capability / local config required):
  - **Transfer**: writes only into the Agent’s dedicated scratch directory.
  - **Terminal**: Agent-local TOTP-gated interactive shell (**not sandboxed** — anything the OS user can do).

See [Security & sensitive files](/en/features/security).

## Where to start

A newcomer can install and use end-to-end from these docs: start with [Quick start](./quick-start), then [Install Hub](./install-hub) → [Install Agent](./install-agent) → [First login & add roots](./first-login).
