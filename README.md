# filebox

**Browse the files on any server from one secure web page.**

<p align="center">
  <a href="https://zhimingye.github.io/filebox/">
    <img src=".github/assets/filebox-multitab-pdf.png" alt="filebox web UI: six preview tabs open (PDF report, figure, Python script, CSV, Markdown, PowerPoint); the active tab shows a multi-page PDF lab report with a correlation heatmap and a QC table" width="100%">
  </a>
</p>

filebox is a read-only remote file browser with system monitoring. Install a
small agent on each machine you want to reach, host the hub on a server you
control, and open a single URL — from your desktop or your phone, wherever
you are. Every machine is one click away, with no public IP on the target,
no port forwarding, and no SSH gymnastics. Optional Herdr integration also
lets you check and respond to coding agents running on those machines.

[![Release](https://img.shields.io/github/v/release/ZhimingYe/filebox?sort=semver)](https://github.com/ZhimingYe/filebox/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> **[Documentation →](https://zhimingye.github.io/filebox/)** — install,
> connect, and use every feature, with screenshots of the real UI.
>
> **[中文文档 →](https://zhimingye.github.io/filebox/zh/)** — 安装、连接、浏览、多标签预览、搜索、合集、传输与 Herdr。

## Why filebox

Most coding agents are built for software developers. filebox is built for
the people those agents tend to overlook: researchers and analysts who need
to *see* their results — the figures, the PDFs, the logs — to be confident
the results are right. While the tooling world drifts toward hosted,
editor-centric workflows, research still lives on self-hosted servers, where
results are files. filebox gives that world a dependable front door — one
click away from any browser, laptop, phone, or tablet — so a result can be
checked from the lab bench, the conference hall, or the train home.

## How it works

```text
Browser ──HTTPS──▶ Hub ◀──WSS (outbound)── Agent ──▶ local files
```

- **Web app** — the browser interface you use to browse, search, and monitor.
- **Hub** — one central server that authenticates users, serves the web app,
  and routes every request to the right machine.
- **Agent** — a small daemon installed on each machine whose files you want
  to reach.

Agents always connect **outward** to the hub. The machines you want to reach
need no inbound ports and no public address — only the hub has to be
reachable. When a machine comes back after an outage, its agent reconnects
on its own, with no duplicate entries and no lost configuration.

## Features

### File browsing

- Smooth file lists even in very large directories
- Directory tree and breadcrumb address bar with paste-and-go and autocomplete
- Filter by filename pattern or modification date
- File-type badges and recently-changed highlighting
- Remembers your place — positions survive a page refresh
- Pin folders you use often for one-click access
- Click a preview's path to open its containing folder in Files or reveal it
  in Explorer; from Collections, this switches to Files

### Search

- Find by file name, or search file contents with regular expressions
- Scope a search to a folder, filter by extension, skip noise folders such
  as `node_modules` or `venv`
- Live progress with cancel — safe on very large trees

### Collections

- Save named lists of files from any of a machine's folders
- View items side by side, remove them, or jump to their original location
- Stored on the machine; nothing is moved or copied — they are virtual references

### Preview

- Multi-tab workspace with keyboard shortcuts
- Markdown, code (find, wrap, syntax highlighting), PDF, images (zoom and
  pan, including TIFF), HTML in a sandboxed session, and CSV tables
- Quarto (`.qmd`) and R Markdown (`.rmd`, `.rmarkdown`) open as read-only
  Monaco source with front-matter and code-chunk highlighting, not executed
  or rendered reports; ordinary `.md` stays rendered
- Jupyter notebooks (`.ipynb`) open as Hub-sanitized, sandboxed HTML: Markdown,
  code, text/error output and supported images; no kernel execution, widgets,
  arbitrary HTML outputs or notebook JavaScript. Large outputs are reduced,
  truncated or omitted with a note
- HTML supports relative links, fragments and self-contained Quarto/Pandoc
  `data:` styles/scripts inside its sandbox, with Source and new-window views;
  parent-directory traversal is blocked and documents over 64 MiB are refused
- Optional Office conversion: Word and PowerPoint open as PDF, spreadsheets
  as per-sheet CSV
- Pin preview tabs to preserve viewer state across switches. Up to three
  inactive heavy previews (HTML/notebooks, PDF, Office) stay mounted offscreen;
  excess heavy tabs may reload and lose live state. Images, code, Markdown and
  CSV restore saved viewer state instead; unpinned inactive previews unmount
- Oversized files ask before loading instead of freezing the browser

### Herdr coding-agent controls (optional)

- Select a backend's **Herdr** view to list coding windows, search/filter by
  name, kind, folder, pane or status, read output snapshots, send prompts, and
  answer with allowlisted keys. This is not a general-purpose remote shell
- Requires the Herdr CLI and its running server on the **Agent machine**;
  compatibility is checked against **Herdr v0.9.5**, with matching CLI/server
  versions. Filebox calls the CLI directly, without a shell
- Status checks run every 30 seconds while the page is open; selected-window
  output refreshes every minute unless disabled per window. Manual refresh,
  snapshot time, Copy, wrapping and local Latest scrolling are available;
  refreshing or opening the keyboard does not send remote input
- Per-pane drafts survive failed sends. Enter adds a newline; Ctrl/Cmd+Enter
  or Send submits (up to 32 KiB UTF-8). Optional wait mode waits up to 60 seconds
  after submission; Stop waiting cancels Filebox's request, not work already
  accepted by Herdr, and never resubmits it
- Keys has searchable profiles for pi, Claude Code and Codex; detection can be
  corrected manually. Unsupported bindings show an error rather than silently
  succeeding. See [the shortcut guide](docs/herdr-shortcuts.md)
- Input-needed and repeated unknown/error reminders also appear in other
  views, without navigating or sending input automatically. Dismissal quiets
  the current episode. Monitoring requires an open page and Herdr detection
  may miss questions; it is not a guaranteed notification service. Stopped or
  unavailable Herdr clears reminders quietly rather than reporting a failure

When the CLI is missing, Herdr shows optional onboarding and setup guidance.
Follow the [official installation guide](https://herdr.ink), install it on
the Agent's PATH and use **Check installation**, or set
`FILEBOX_AGENT_HERDR` to its executable and restart the Agent. Changing the
process PATH also requires a restart.

The **Herdr integration** switch in Agent Settings is per backend, shared
across browsers, and persisted as `herdr_enabled` (default `true`) in the
existing `agent_state.json`, **not** `agent.toml`. Changes apply immediately
after the Agent confirms the save. Turning it off stops Filebox's controls and
monitoring, not Herdr or its coding agents. Offline backends cannot save; older
Agents need an upgrade for this switch. An explicit
`FILEBOX_AGENT_HERDR_ENABLED` value overrides the saved preference and locks
the web switch: `0`/`false` disables, `1`/`true` enables, invalid values disable
(boolean words are case-insensitive). Unset it and restart to use the web switch.

Prompts require Hub-side LLM security review by default; missing configuration
or provider failure refuses submission, while status/reads/keys still work.
The provider receives the prompt **and recent window context fetched by the
Hub**. Review is configured only in `hub.json`, not the web UI; the explicit
startup opt-out and all provider fields are documented in
[Herdr compatibility and prompt review](docs/herdr-compatibility.md).
Review is defense in depth, not a sandbox for the coding agent's shell access.

### System monitoring

- CPU, memory, and load overview
- Per-user resource share
- Process table with per-process details

### Security

- Browsing is read-only. Transfer writes only to its dedicated scratch folder;
  the separate Herdr integration permits whitelisted coding-agent operations.
- Herdr prompts must pass a Hub-side LLM security review (file-configured;
  fail-closed by default, with an explicit startup-only opt-out) before they
  reach the coding agent
- Per-user logins; a separate token authenticates each machine
- Sensitive files (credentials, private keys, shell history, `.env`, and
  more) are denied by default, even inside allowed folders
- Browsing is strictly confined to the folders you allow — symlinks,
  `..`, and other escape routes are blocked
- Session/CSRF cookie names have an opaque suffix derived from the Agent-token
  hash and Hub listen port, so multiple Hubs on one host do not overwrite each
  other's cookies. Changing either requires signing in again; old unsuffixed
  cookies are not accepted. Reverse proxies should preserve cookie names

### Operations

- Works on phones and tablets — browse, search, and monitor from anywhere,
  not just at your desk
- Live status feed with request progress and cancellation
- Agents reconnect automatically after outages — identity persists, no duplicates
- Bounded, separate response queues keep directory requests, heartbeats and
  cancellation responsive during slow transfers; congestion has visible errors
  rather than unlimited buffering. Update the Agent as well as the Hub/UI
- One-command in-place updates

### Temp files

- **Transfer** view: drag small files onto the page and the agent stores them
  in one dedicated scratch folder — Filebox's only file-upload write path.
  Per-file and total quotas, no overwrites, one-click cleanup, and the folder
  is never browsable as a normal root.
- Paste screenshots or copied images with Ctrl/Cmd+V while in Transfer;
  editable inputs keep normal paste behavior. Images with unusable filenames
  receive timestamped names and use the same upload limits as dropped files

## Markdown math

Markdown previews render math locally with KaTeX (no CDN). Supported forms:
`$...$`, `$$...$$` (inline or multiline), `\(...\)`, `\[...\]`, GitHub's
`` $`...`$ ``, and fenced `math`, `latex`, `tex`, or `katex` blocks.
Standalone `math`, `displaymath`, `equation`, `align`, `alignat`, `gather`,
`aligned`, and `gathered` LaTeX environments are recognized, including starred
variants where supported. Matrices, cases, and other KaTeX-supported commands
work inside math delimiters.

Ordinary code spans/blocks remain literal. Single-dollar inline math must not
start/end with whitespace or end immediately before a digit, to avoid common
currency ambiguities; escape literal dollars as `\$`. Use double dollars or
LaTeX delimiters for display math. Wide display formulas scroll horizontally.
Unsupported/invalid TeX stays readable rather than breaking the preview; this
is KaTeX compatibility, not a full LaTeX engine with arbitrary packages.

## Quick Start

The hub lives on a central server you control — a small VPS, an internal
machine, or a container. Agents go on the machines whose files you want to
reach. Browsers only ever talk to the hub.

### Step 1 — Deploy the hub on a central server

Download the latest
[release](https://github.com/ZhimingYe/filebox/releases/latest)
(`filebox-hub-<version>-x86_64-musl.tar.gz`), extract it, and start:

```bash
tar xzf filebox-hub-*-x86_64-musl.tar.gz
cd filebox-hub-*
./bin/hub --init-config     # creates config/hub.json; prints the agent token once
./bin/hub                   # listens on :3000 by default
```

`--init-config` walks you through the listen address, admin credentials, and
the agent token (stored hashed, printed once). The hub serves the web app
itself, so the URL is all your users need.

**HTTPS in production.** Put the hub behind a reverse proxy that terminates
TLS — nginx, Caddy, or Traefik all work. Example nginx server block:

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

        # WebSocket (agent connections) and live status updates
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_cache off;
    }
}
```

HTTPS is what keeps the agent token private in transit, so always terminate
TLS in production.

### Step 2 — Deploy agents on your machines

On each machine, download
`filebox-agent-<version>-x86_64-musl.tar.gz`, extract, and start:

```bash
tar xzf filebox-agent-*-x86_64-musl.tar.gz
cd filebox-agent-*
./agent --init-config      # paste the token printed by the hub
./agent
```

Or configure with environment variables (handy for systemd or containers):

```bash
export FILEBOX_AGENT_HUB="https://filebox.example.com"
export FILEBOX_AGENT_TOKEN="the-token-from-step-1"
export FILEBOX_AGENT_NAME="web-01"
export FILEBOX_AGENT_DATA_DIR="/var/lib/filebox"
./agent
```

That's it — the agent dials out to the hub and appears in the sidebar. No
inbound ports to open on the firewall.

### Step 3 — Log in and browse

Open `https://filebox.example.com` in any browser — desktop, phone, or
tablet — log in, pick a machine, and add the folders you want to expose
(Settings → Add Root). Files, search, collections, and monitoring all work
from there, whether you are at your desk or on the go.

### Updating

```bash
./bin/hub --update    # downloads the latest release, verifies checksums,
./agent --update      # and replaces the install in place
```

### Building from source

```bash
git clone https://github.com/ZhimingYe/filebox.git
cd filebox && cd frontend && npm install && npm run build && cd ..
cargo build --release
```

Most users never need this — see [`docs/`](docs/) for development details.

## Configuration reference

### Hub (`config/hub.json`, created by `--init-config`)

| Field | Description | Default |
|-------|-------------|---------|
| `listen_addr` | Address the hub listens on | `0.0.0.0:3000` |
| `agent_token_hash` | Hash of the agent token (set during init) | required |
| `users` | Login accounts | required |
| `herdr_prompt_review` | LLM security review for Herdr prompts (`protocol`: `chat_completions` / `responses` / `messages`; `base_url`, HTTPS required except loopback; `model`; `api_key` or `api_key_env`; `timeout_secs`, max 60). File-only, no web setting. While review is on, prompts are rejected if this is missing or the review fails. See [docs/herdr-compatibility.md](docs/herdr-compatibility.md). | unset (prompts rejected) |

| Environment variable | Description | Default |
|---------------------|-------------|---------|
| `FILEBOX_HUB_HERDR_PROMPT_REVIEW_ENABLED` | Read once at Hub startup. `0` / `false` turns Herdr prompt review off (prompts are forwarded unreviewed). Unset, `1`, `true`, or an invalid value keeps review on and mandatory. | `1` |

### Agent (`agent.toml`, created by `--init-config`)

| Field | Environment variable | Description | Default |
|-------|---------------------|-------------|---------|
| `hub` | `FILEBOX_AGENT_HUB` | Hub URL (`https://` or `wss://`) | required |
| `token` | `FILEBOX_AGENT_TOKEN` | Agent token | required |
| `name` | `FILEBOX_AGENT_NAME` | Name shown in the sidebar | `default-agent` |
| `data_dir` | `FILEBOX_AGENT_DATA_DIR` | Where the agent keeps its state | system data dir + `filebox` |
| — | `FILEBOX_AGENT_CONFIG` | Agent TOML file to load; environment values override TOML | `./agent.toml` |
| — | `FILEBOX_AGENT_HERDR_ENABLED` | Startup override: `0`/`false` disables discovery, probing and commands; `1`/`true` enables and locks the web switch. Invalid values disable. Restart after changing | unset (saved `herdr_enabled`, initially `true`) |
| — | `FILEBOX_AGENT_HERDR` | Explicit Herdr executable path; cannot override `FILEBOX_AGENT_HERDR_ENABLED=0` | search `PATH` |
| — | `FILEBOX_AGENT_SOFFICE` | Path to `soffice` (enables Office preview) | unset |
| — | `FILEBOX_AGENT_SOFFICE_DIR` | Directory containing `soffice` | unset |

Herdr's `herdr_enabled` is Agent-owned persisted state, not a TOML bootstrap
field. Do not put it in `agent.toml`; use Agent Settings or the startup override.

## Office preview (optional)

Word and PowerPoint files open in the PDF viewer after the **agent** converts
them with LibreOffice. Spreadsheets (`xls`/`xlsx`/`xlsm`/`ods`) are exported
as one CSV per worksheet and use the CSV viewer. The hub never runs
LibreOffice; the agent never bundles it.

- **Headless only** — conversion always runs `soffice --headless`; no GUI or
  display server required.
- **Rootless-friendly** — install under your home directory and point the
  agent at that binary; no system packages or `sudo` needed.
- **Opt-in** — without a working `soffice`, the UI simply stays download-only
  for Office files. A browser setting can also turn conversion off.

### 1. Install LibreOffice rootless (no sudo)

Pick the tarball that matches the agent host and extract it **into your home
directory** — do not install system-wide.

**Debian / Ubuntu-style** (deb packages):

```bash
VERSION=26.2.5
PREFIX="$HOME/opt/libreoffice"
mkdir -p /tmp/lo-dl "$PREFIX" && cd /tmp/lo-dl
curl -L -O \
  "https://download.documentfoundation.org/libreoffice/stable/${VERSION}/deb/x86_64/LibreOffice_${VERSION}_Linux_x86-64_deb.tar.gz"
tar -xzf "LibreOffice_${VERSION}_Linux_x86-64_deb.tar.gz"
cd LibreOffice_*_Linux_x86-64_deb/DEBS
for deb in *.deb; do dpkg-deb -x "$deb" "$PREFIX"; done
```

**Rocky / RHEL-style** (rpm packages):

```bash
VERSION=26.2.5
PREFIX="$HOME/opt/libreoffice"
mkdir -p /tmp/lo-dl "$PREFIX" && cd /tmp/lo-dl
curl -L -O \
  "https://download.documentfoundation.org/libreoffice/stable/${VERSION}/rpm/x86_64/LibreOffice_${VERSION}_Linux_x86-64_rpm.tar.gz"
tar -xzf "LibreOffice_${VERSION}_Linux_x86-64_rpm.tar.gz"
cd LibreOffice_*_Linux_x86-64_rpm/RPMS
for rpm in *.rpm; do rpm2cpio "$rpm" | (cd "$PREFIX" && cpio -idm); done
```

Bump `VERSION` to whatever is current on
[Document Foundation downloads](https://www.libreoffice.org/download/download-libreoffice/).

### 2. Point the agent at `soffice`

```bash
export FILEBOX_AGENT_SOFFICE="$HOME/opt/libreoffice/opt/libreoffice26.2/program/soffice"
# Or: export FILEBOX_AGENT_SOFFICE_DIR="$HOME/opt/libreoffice/opt/libreoffice26.2/program"
```

Optional limits (defaults shown; the cache must fit at least one complete
converted file):

```bash
# FILEBOX_AGENT_OFFICE_TIMEOUT_SECS=120
# FILEBOX_AGENT_OFFICE_MAX_SRC_BYTES=536870912     # 512 MiB
# FILEBOX_AGENT_OFFICE_MAX_PDF_BYTES=1073741824    # 1 GiB combined derived output
# FILEBOX_AGENT_OFFICE_MAX_LOG_BYTES=8388608       # 8 MiB
# FILEBOX_AGENT_OFFICE_MAX_MEMORY_BYTES=2147483648 # 2 GiB resident memory (Linux)
# FILEBOX_AGENT_OFFICE_CACHE_BYTES=1073741824      # 1 GiB on-disk preview cache
```

Restart the agent after configuring. Conversion runs per request with
progress and cancel; a malformed or truncated result is discarded and
converted again rather than served from cache. If LibreOffice is later
removed, Office preview fails cleanly and file browsing keeps working.

### 3. Verify

```bash
# On the agent host
"$FILEBOX_AGENT_SOFFICE" --headless --version
```

For local bring-up notes, see
[`docs/local-debugging.md`](docs/local-debugging.md).

## Usage

### Add a root directory

1. Log in and select a machine in the sidebar
2. Open Settings → Add Root
3. Enter an absolute path (or `~/…` for a path under the machine's home)
4. Save — invalid paths are rejected without touching existing settings

### Browse files

Navigate with the tree, address bar, or folder clicks; click a file to
preview it (multi-tab on desktop). Use the filename and date filters as
needed, and pin frequently used folders from the sidebar.

### Use collections

Open Collections to create a named list, or add files to one directly from
the file list. Open a collection to preview its items, remove them, or open
a file's location in Files.

### Search a workspace

Open Search, choose Files (file names) or Content (text inside files), pick
a root and optional folder, and click a hit to open its parent folder.
Ignore lists and depth limits are set in the UI and applied per request.

### Monitor a machine

Open Stats to see CPU, memory, and load; the Users tab breaks usage down per
account; the Processes tab lists running processes with details.

On shared many-core hosts, the Agent uses two Tokio async workers rather
than one per CPU. System monitoring scans processes serially on a blocking
worker, without an all-core Rayon pool. Cached stats remain available while
a refresh runs; concurrent cold requests share the first snapshot. Refreshes
are demand-driven (default TTL 60 seconds, `FILEBOX_AGENT_STATS_TTL_SECS`).

This bounds scheduler and monitoring parallelism, not the whole process's CPU
quota: file I/O and child programs have separate concurrency.
The Agent does not pin CPUs or alter child-process priorities. Keeping blocking
I/O separate lets heartbeats and cancellation run during slow work; a fully
saturated host can still delay them. For strict CPU isolation, configure a
cpuset/cgroup through your host administrator or job scheduler.

### Sensitive file protection

The following kinds of files are denied by default (abbreviated):

```text
.git/  .ssh/  .gnupg/  .aws/  .kube/
.env*  *.pem  *.key  id_*  credentials*.json  *.sqlite*
...
```

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
