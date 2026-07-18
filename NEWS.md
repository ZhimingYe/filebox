# Changelog

All notable changes to filebox are listed here. Dates are UTC.

## Unreleased

### Added
- **Workspace Search** — sidebar Search view with fd-like Files mode (filename substring) and rg-like Content mode (case-insensitive regex + context). Scoped to one root and optional folder; optional extension filter. In-process on the agent (`ignore` + `regex`); path-safe, no symlink follow, denylist-aware. Progress via SSE, cancelable, one concurrent search per agent, scan/result caps for high-load trees. Gated by `capabilities.workspace_search`.
- **Workspace Search ignore + depth** — UI fields for folder names to skip (`renv`, `venv`, `node_modules`, … by default) and max directory depth. Sent per request; prefs saved per backend in the browser. No agent.toml required.
- **Workspace Search results UX** — virtualized hit list (`react-window`) plus a static “Filter results” box over path/context (client-side only; does not re-query the agent).
- **Monaco code preview** — read-only Monaco Editor replaces Prism / `react-syntax-highlighter` for code files (Find, wrap, syntax highlight). Lazy-loaded; not placed in Vite `manualChunks` so the ~4MB editor is not preloaded on every page.

### Changed
- **Image preview** — flex stage fits tall images; wheel / pinch zoom and pointer pan; dimension downscale caps (max edge 8192, ~16M pixels); `ImagePreview` is now lazy-loaded like other heavy viewers.
- **Login** — removed the misleading `admin` username placeholder; credentials must still be typed explicitly.

### Security
- **Dependency CVEs** — bcrypt 0.19.1 → 0.19.2 (RUSTSEC-2026-0199 panic-DoS); crossbeam-epoch 0.9.18 → 0.9.20 (RUSTSEC-2026-0204); npm `dompurify` overridden to 3.4.12 (Monaco transitive XSS advisories).
- **Workspace Search content open** — content mode now uses the same openat + `O_NOFOLLOW` chain as file reads, closing an intermediate-symlink TOCTOU gap.
- **Denylist expanded** — `shadow`/`gshadow`/`sudoers`, `.pgpass`/`.htpasswd`, `credentials.csv`/`credentials.txt`, `secrets.y{a,}ml`/`secrets.toml`, `*.tfstate`, `*.kdbx`, and related cloud credential filenames.
- **Path validators** — pin/collection paths reject `\`; Hub WS debug logs no longer print raw post-auth frames (avoids token leakage).

---

## v0.9.0 — 2026-07-16

### Added
- **Virtual collections** — per-agent named lists of file references that may span multiple roots. Create / delete collections, add or remove items, and browse them in a dedicated Collections workspace. Files can be added from the file browser via the CollectionPicker (including atomic create+add). Collections persist on the agent in `agent_state.json` with an independent `collections_revision`; offline edits coalesce into a pending update and apply on reconnect. Legacy agents without the capability receive `400 unsupported_feature`.
- **Shared file-list workspace** — Files and Collections share `FileEntryList` / `WorkspaceSplit`, with adaptive CSS-grid columns that protect name / date / size widths in narrow split panels.

### Changed
- **Lowercase brand** — UI copy uses "filebox" consistently.

### Fixed
- CollectionPicker floating popup positioning and styling.
- Collections reject / pending state, metadata refresh loop, and narrow-layout crushing of the filename column.
- File-list header/row column alignment, including cross-year and pre-2000 date widths.

---

## v0.8.9 — 2026-07-15

### Added
- **Built-in configuration setup** — `hub --init-config` creates `config/hub.json` with an internally generated agent token and bcrypt hashes; `agent --init-config` creates `agent.toml`. Both support `--output` and `--force`, create private `0600` files, and require no external bcrypt, OpenSSL, Python, or shell helper. The old `scripts/gen_config.sh` path is retired.
- **Home-path roots** — root paths may be `~` or `~/…`; the agent expands them against its own `$HOME` and rejects escapes such as `~/../…`.
- **Modification-date filter** — presets (today, yesterday, 7d / 30d / 90d / 365d) plus custom after/before dates in the file browser.
- **Preview tab polish** — tab-jump dropdown among open tabs; context-menu bulk close (this tab / left / right / all); `PreviewErrorBoundary` isolates viewer crashes; missing files surface as local retryable preview errors.
- **Recently modified highlight** — file rows accent the modified date when mtime is within the last 15 minutes.

### Changed
- **Shorter installation flow** — README and release-package instructions use the downloaded Rust binaries directly for configuration.
- Agent settings UI polish; denser mobile folder tree; sidebar collapse animation without main-column jank.

### Fixed
- Home-path traversal / expansion edge cases, hub–agent apply race, and file-list layout bugs.
- **Preview keyboard navigation** — Left/Right moves through files in the current directory (or collection) and replaces the active preview; it no longer cycles only the open tab strip.

---

## v0.8.0 — 2026-07-11

### Changed
- **Denser desktop sidebar** — reduced the expanded sidebar from 200px to 176px and the collapsed rail from 56px to 48px, with tighter desktop-only spacing for agents, navigation, pinned folders, and footer controls. The mobile drawer keeps its existing 280px touch layout.
- **File-row copy placement** — the per-row copy button now sits at the trailing edge of the filename column while the modified-date and size columns retain protected, non-shrinking widths.

### Fixed
- **Preview tab keyboard navigation** — Left/Right now cycle only through previews that are already open, preventing keyboard navigation from creating or switching to nonexistent tabs.
- **Unavailable-root updates** — a previously configured root that disappears can still be disabled or deleted, but cannot be re-enabled until it resolves to a directory again; newly added invalid roots remain atomically rejected.
- **Mobile process names and states** — the process table now gives PID, user, process name, and state stable mobile widths, with later metrics available by horizontal scrolling instead of collapsing names to a single character.
- **Process table alignment** — headers and virtualized rows share the same box model and account for the platform scrollbar width, keeping every column aligned across desktop, mobile, and user-filtered views.

---

## v0.7.0 — 2026-07-10

### Added
- **Multi-tab preview workspace** — open multiple file previews, switch and close tabs, navigate to the previous or next file with the arrow keys, and close the active preview with Escape. Only the active preview body is mounted, keeping heavy preview resources bounded.
- **Manual in-place updates** — Hub and Agent now support `--update`, downloading the matching Linux release, verifying `SHA256SUMS.txt`, refusing downgrades by default, and accepting HTTPS release mirrors.
- **File-type badges and resizable directory tree** — file rows show category-colored extension badges, and the desktop directory tree can be resized and reset with its width persisted locally.

### Changed
- **HTML preview diagnostics** — detects missing charset declarations and non-standard HTML structure, can inject `<meta charset="utf-8">` automatically, and exposes source/preview controls.
- **File browser polish** — refreshed the shared visual tokens, date formatting, directory navigation controls, and file-list presentation for denser desktop browsing.
- **Root configuration validation** — newly added or changed roots must resolve to directories, while previously configured roots that disappear remain editable so they can be disabled, deleted, or repaired without blocking atomic updates.

### Security
- **Path-resolution hardening** — canonicalizes the root before resolving targets, keeps containment checks explicit, and returns distinct errors for unknown roots, inaccessible roots, missing paths, and path escapes.

### Fixed
- **Preview keyboard navigation** — arrow-key navigation now moves through files in the current directory instead of cycling unrelated open tabs.

---

## v0.5.0 — 2026-07-03

### Added
- **System monitor rework** — rewritten sysinfo collector safe for HPC boxes (10k+ PIDs, terabyte memory). Uses `ProcessRefreshKind::without_tasks()` to skip the O(procs × threads) `/proc` recursion that froze 1 TB machines; sysinfo `multithread` feature for parallel scanning; single-pass aggregation into per-process, per-user, and global totals; O(N) quickselect for top-k instead of full sort; `Users::refresh()` throttled to 5 min. TTL-cached `StatsCache` with fresh/stale/cold states and CAS de-dup so readers never block the producer.
- **Per-user & per-process UI** — three-tab SystemStats (Overview / Users / Processes). Processes tab: `react-window` virtualization, row → detail panel with full command + metric chips, filter by uid, hide-kthreads toggle, display limit 50/100/200/500 persisted to localStorage. Users tab: per-user CPU/memory share bars + sortable table with node-share %.
- **About dialog** — click the version number in the sidebar footer to open an "About filebox" dialog (version, dev/production hint, homepage link).
- **Pinned Folders** — per-root pinned-folders section in the sidebar. Collapsed sidebar shows a single Pinned entry with a count badge (popover). Pin/unpin via single-item atomic PATCH deltas; bounded, abortable, TTL-cached existence probe.
- **License attribution** — NOTICE + NOTICE.csv manifests (282 Rust crates, 138 npm production packages; all permissive). `scripts/gen_notice.sh` reproduces them.

### Changed
- **Process cap raised** to 500 (`TOP_PROCESSES`), backed by real data; payload stays under the 1 MB limit.
- **Users-tab CPU share math fixed** — denominator was `cpu_usage_percent` (node-normalized) but each user's `cpu_usage` is a raw per-core sum that can exceed 100, producing impossible values like "533% of node". Now normalized against the sum of all users so shares stay in [0, 100] and sum to 100%. Bar color decoupled from share (color by absolute load, width by share). Relabeled "CPU·node"/"%node" → "CPU share"/"% of RAM".

### Security
- **Dependency vulnerabilities patched** — anyhow 1.0.102 → 1.0.103 (RUSTSEC-2026-0190, soundness); quinn-proto 0.11.14 → 0.11.15 (RUSTSEC-2026-0185, CVSS 7.5 DoS). Frontend: 0 vulnerabilities across 138 production deps.
- **Resource-update path hardened** — offline pin deltas now chain onto the existing pending update instead of overwriting each other; `patchRoot` rejects on `ok===false`/`state===rejected` so a rejected apply surfaces as an error; capability gate returns `400 unsupported_feature` for pin ops against legacy agents; `pending_update` survives re-register; pending responses cleaned up on send failure.

### Fixed
- **PDF preview flicker/jump loop** — while a visible page's canvas was still loading, `height:auto` collapsed the wrap to the spinner's ~20 px, shifting total document height, toggling the scrollbar, changing `contentRect.width`, and re-rendering every page in a self-sustaining loop. Fixed with `scrollbar-gutter: stable` (stable `contentRect.width`) + `minHeight: placeholderHeight` on page wraps (prevents collapse while loading).
- **github-pages workflow trigger** — `pages.yml` was triggering on `v*` tags, but the `github-pages` environment's deployment-branch rule only permits the `gh-pages` branch, so tag-triggered runs were rejected before any step executed. Reverted to `gh-pages` branch push + `workflow_dispatch`.

---

## v0.4.5 — 2026-06-21

### Added
- **Address bar** with auto-complete, breadcrumb navigation, full-path paste support, and pencil edit button
- **Path memory** — switching between roots or agents now remembers and restores the last visited path for each agent+root combination
- **Filename alignment toggle** — toolbar button to switch between left-align and right-align filenames, making the varying suffix of long AI-generated filenames visible without scrolling
- **Filename font toggle** — toolbar button to switch filenames between sans-serif (default) and a screen-optimized serif (Georgia stack). Serif shapes read more distinctly than sans when fatigued, helping tell similar filenames apart. Affects filenames only; dates/sizes stay sans. Preference persisted in localStorage.
- **Copy-address toolbar button** — copies the full server-side path of the directory currently being viewed (root `path_display` + current path). Disabled until a root is selected.
- **Custom root-selector dropdown** — replaced the native `<select>` root picker with a hand-rolled dropdown whose panel shows each root's server path under its name. Themed inline to match the toolbar, closes on click-outside / Escape, and adapts to mobile (toolbar wraps, trigger spans the row, panel right-pins so it never overflows the viewport).
- **`.Rprofile` / `.Renviron` preview** — these R dotfiles have no real extension; they now preview as R source with syntax highlighting.

### Changed
- **Filename readability** — filenames bumped from 13px Regular to 14px Medium (500). The heavier weight resolves confusable glyph pairs (I/l/1, O/0/o) that made names blur together. Row height unchanged (stays compact).
- **Per-row Copy button copies the full path** — it previously copied only the bare filename; it now copies the full path (directory + filename) and shows a clipboard / checkmark glyph instead of text, matching the toolbar copy button.
- **Refresh button uses an SVG icon** — the ↻ text character is replaced with an SVG glyph so it renders consistently across fonts and platforms, matching the other toolbar icons.

### Fixed
- Dev-mode cookies (`FILEBOX_DEV_MODE=1`) — `Secure` flag no longer breaks HTTP localhost sessions
- Login response no longer wipes the session it just set — `/api/session/exchange` previously appended a second `filebox_session=; Max-Age=0; Secure` Set-Cookie on the login response, which cleared the valid session cookie immediately, leaving every subsequent `/api/*` request unauthenticated (manifested as "No agents connected" right after a successful login). Removed the stray clear; login now emits a single Set-Cookie.
- HSTS only sent over TLS — the hub previously emitted `Strict-Transport-Security` unconditionally, including on plaintext HTTP, which poisoned browsers into force-upgrading `http://` to `https://` against a hub that only listens on plain HTTP. HSTS is now gated on the request actually arriving over TLS (direct `https` or `X-Forwarded-Proto: https`). Production behind nginx is unaffected.
- Race condition on agent switch — stale API responses from the old agent can no longer overwrite correct data from the new agent
- Polling-induced layout jumping — health polling previously created new array references every 5 seconds, triggering spurious directory reloads; now only updates state when data actually changes
- Filename right-align actually keeps the suffix — the toggle previously only set `text-align:right`, which still clipped the suffix; it now uses RTL direction + bidi-isolated text so long filenames show `…suffix` (e.g. `…_REWIND_A_1708.md`). Also: new align-edge icon glyph, Copy/denied controls stay anchored, preference persisted in localStorage
- Settings page overflow at narrow widths and high browser zoom — the agent settings header and root manager rows no longer push past the container; flex children gained `minWidth: 0` and the meta / add-rows wrap.
- Border turns black after focus — the root-selector trigger and the filter input used the `border` shorthand in their base style but a `borderColor` longhand in their override, so React's style-diff cleared `borderColor` on close and fell back to `currentColor` (near-black). Both now use border longhands.

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
