# Changelog

All notable changes to Filebox are listed here. Dates are UTC.

## Unreleased

### Added
- **Address bar** with auto-complete, breadcrumb navigation, full-path paste support, and pencil edit button
- **Path memory** — switching between roots or agents now remembers and restores the last visited path for each agent+root combination
- **Filename alignment toggle** — toolbar button to switch between left-align and right-align filenames, making the varying suffix of long AI-generated filenames visible without scrolling

### Fixed
- Dev-mode cookies (`FILEBOX_DEV_MODE=1`) — `Secure` flag no longer breaks HTTP localhost sessions
- Race condition on agent switch — stale API responses from the old agent can no longer overwrite correct data from the new agent
- Polling-induced layout jumping — health polling previously created new array references every 5 seconds, triggering spurious directory reloads; now only updates state when data actually changes

---

## v0.4.0 — 2026-06-19

### Security
- Harden HTML preview resource access — sandboxed preview sessions with TTL, per-session request/byte limits, and directory-scoped bearer tokens
- Harden file access and session security — stricter path canonicalization, symlink escape detection, expanded sensitive-file denylist

### Added
- Agent guidance — contextual hints in the agent settings panel

### Changed
- Collapsible sidebar for more preview space
- TIFF image preview support
- Shared large-file gate across all preview types (consistent slow-detection + loading overlay)
- Custom symlink icon to distinguish links from regular files

---

## v0.3.1 — 2026-06-17

### Changed
- Cache-Control headers for static assets (better reload behavior)
- Version number displayed in the UI
- Mobile settings panel improvements

---

## v0.3.0 — 2026-06-16

### Changed
- **Large-file preview overhaul** — streaming text chunks, cancel button, PDF virtualized pages
- Preview pane no longer force-downloads large files; instead shows a progressive loading experience

---

## v0.2.7 — 2026-06-16

### Fixed
- Mobile column header misaligned with row content

---

## v0.2.6 — 2026-06-16

### Fixed
- PDF preview loading overlay escaping its container bounds

---

## v0.2.5 — 2026-06-16

### Fixed
- Pin `pdfjs-dist` to 5.4.296 to match `react-pdf`'s expected version (fixes PDF rendering on some browsers)

---

## v0.2.4 — 2026-06-16

### Added
- File name tooltip on hover in file list rows

### Changed
- Replace iframe PDF preview with PDF.js for cross-browser support (including mobile browsers without native PDF viewers)
- Split preview components into lazy-loaded chunks; vendor chunks cached independently — initial JS reduced 14x
- Remove legacy install scripts; install flow now points to GitHub Releases

### Fixed
- Mobile file row: modified date was being squeezed out on narrow screens

---

## v0.2.3 — 2026-06-16

### Added
- `gen_config.sh` — prints `hub.json` or `agent.toml` to stdout using `openssl` + `mkpasswd` (no Python dependency)

### Changed
- **Reconnect hardening** — agent now survives 24h+ hub outages with exponential backoff, jitter, and stable-connection threshold reset
- Hub abort-on-reregister: new WS connection for the same agent cleanly replaces the old one
- `same_channel` ownership check prevents stale connections from clobbering fresh ones
- Preserve FileBrowser navigation state across mobile preview toggle

### Fixed
- Reconnect race that broke agent registration after TCP drop
- Several reconnect edge cases found in code review

---

## v0.2.2 — 2026-06-15

### Fixed
- Release CI: static-link check inverted to fail only on explicit dynamic linkage

---

## v0.2.1 — 2026-06-15

### Fixed
- Release CI: use `file(1)` instead of `ldd` for static-link verification (more portable)

---

## v0.2.0 — 2026-06-15

Initial public release.

### Core
- **Hub** (Rust + Axum + Tokio) — serves frontend, manages agents, proxies file operations
- **Agent** (Rust + Tokio) — connects outbound to hub via WebSocket, serves local files + sysinfo
- **Frontend** (React + TypeScript + Vite) — file browser, preview pane, system stats, agent settings

### Preview
- Markdown (rendered + sanitized), Code (syntax-highlighted), PDF (react-pdf), Image (large-file aware), HTML (sandboxed blob URL), CSV (table)

### Security
- bcrypt password hashing, HttpOnly + SameSite=Strict session cookies, per-IP login rate limiting
- Path safety: canonicalization, symlink escape detection, sensitive-file denylist (`.env`, `.ssh`, credentials, private keys)
- Read-only by design — no writes, no shell, no arbitrary proxying

### Infrastructure
- GitHub Actions release pipeline: `v*` tag → musl Linux x86_64 tarballs + SHA256SUMS
- `scripts/release.sh` — version bump + commit + tag + push
- `scripts/gen_config.sh` — config generation
