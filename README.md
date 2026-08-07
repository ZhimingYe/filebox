# filebox

**Browse the files on any server from one secure web page.**

filebox is a read-only remote file browser with system monitoring. Install a
small agent on each machine you want to reach, host the hub on a server you
control, and open a single URL — every machine is one click away, with no
VPN, no public IP on the target, no port forwarding, and no SSH gymnastics.

[![Release](https://img.shields.io/github/v/release/ZhimingYe/filebox?sort=semver)](https://github.com/ZhimingYe/filebox/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **[Live demo and product tour →](https://zhimingye.github.io/filebox/)** —
> interactive walkthrough of the interface and deployment.

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
- Optional Office conversion: Word and PowerPoint open as PDF, spreadsheets
  as per-sheet CSV
- Oversized files ask before loading instead of freezing the browser

### System monitoring

- CPU, memory, and load overview
- Per-user resource share
- Process table with per-process details

### Security

- Read-only by design: browsing can never modify or delete anything
- Per-user logins; a separate token authenticates each machine
- Sensitive files (credentials, private keys, shell history, `.env`, and
  more) are denied by default, even inside allowed folders
- Browsing is strictly confined to the folders you allow — symlinks,
  `..`, and other escape routes are blocked

### Operations

- Works well on phones
- Live status feed with request progress and cancellation
- Agents reconnect automatically after outages — identity persists, no duplicates
- One-command in-place updates

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

Open `https://filebox.example.com`, log in, pick a machine, and add the
folders you want to expose (Settings → Add Root). Files, search, collections,
and monitoring all work from there.

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

### Agent (`agent.toml`, created by `--init-config`)

| Field | Environment variable | Description | Default |
|-------|---------------------|-------------|---------|
| `hub` | `FILEBOX_AGENT_HUB` | Hub URL (`https://` or `wss://`) | required |
| `token` | `FILEBOX_AGENT_TOKEN` | Agent token | required |
| `name` | `FILEBOX_AGENT_NAME` | Name shown in the sidebar | `default-agent` |
| `data_dir` | `FILEBOX_AGENT_DATA_DIR` | Where the agent keeps its state | system data dir + `filebox` |
| — | `FILEBOX_AGENT_SOFFICE` | Path to `soffice` (enables Office preview) | unset |
| — | `FILEBOX_AGENT_SOFFICE_DIR` | Directory containing `soffice` | unset |

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

### Sensitive file protection

The following kinds of files are denied by default (abbreviated):

```text
.git/  .ssh/  .gnupg/  .aws/  .kube/
.env*  *.pem  *.key  id_*  credentials*.json  *.sqlite*
...
```

## License

[MIT](LICENSE)
