# filebox Frontend

Read-only remote file browser UI built with React, TypeScript, and Vite.
Served by the Hub from `frontend/dist` in production; Vite proxies API
requests to `http://localhost:3000` in development.

## Features

- **Authentication** — username/password login (session cookie)
- **File browser** — virtualized list, directory tree, address bar, glob/regex + date filters, path memory, pinned folders
- **Workspace Search** — Files (fd-like) and Content (rg-like) modes; progress + cancel
- **Virtual collections** — per-agent file groups across roots; Collections workspace + CollectionPicker
- **Multi-tab preview** — Markdown, Monaco code, PDF, image (zoom/pan), HTML, CSV; tab jump / bulk close; error boundary isolation
- **System monitoring** — Overview / Users / Processes tabs
- **Agent settings** — add/remove/enable/disable roots (including `~/…` home paths)
- **Health** — hub/agent status via polling + SSE
- **Responsive layout** — mobile drawer; Files and Collections share a split workspace on desktop

Design tokens live in `src/theme.ts` (white/slate surfaces, indigo accent).
Inline styles only — no CSS modules or Tailwind. Custom 16×16 SVG icons; no emojis.

## Tech Stack

- React 19 + TypeScript + Vite 8
- `react-window` for virtualized lists
- Monaco Editor (`@monaco-editor/react`) for read-only code preview
- `react-markdown` for Markdown
- `react-pdf` / `pdfjs-dist` for PDF
- Lazy-loaded heavy preview chunks; Vite `manualChunks` covers react /
  markdown / tiff vendors — **not** Monaco (keep it behind `TextPreview`)

## Project Structure

```text
src/
  api/client.ts              # fetch wrapper + types
  hooks/usePreviewTabs.ts    # multi-tab preview state
  monacoSetup.ts             # Monaco workers/theme (with TextPreview chunk)
  state/
    session.ts               # login / logout
    events.ts                # SSE (agents, roots, collections, progress)
    health.ts                # health polling
    useIsMobile.ts           # breakpoint hook
  components/
    Login.tsx
    BackendList.tsx          # agent sidebar
    FileBrowser.tsx
    FileEntryList.tsx        # shared list (Files + Collections)
    fileListShared.tsx       # grid columns, icons, row chrome
    WorkspaceSearch.tsx      # fd/rg-like search UI
    DirectoryTree.tsx
    AddressBar.tsx
    DateFilterControl.tsx
    PinnedFolders.tsx
    CollectionsView.tsx
    CollectionPicker.tsx
    WorkspaceSplit.tsx
    PreviewWorkspace.tsx     # tabs + jump / bulk close
    PreviewPane.tsx          # memoized dispatcher
    previewShared.tsx
    PreviewErrorBoundary.tsx
    {Markdown,Text,Pdf,Html,Csv,Image}Preview.tsx
    AgentSettings.tsx
    RootManager.tsx
    SystemStats.tsx
    HealthPanel.tsx
    AboutDialog.tsx
    NoAgentSelected.tsx
    icons.tsx
  App.tsx
  theme.ts
  main.tsx
  index.css
```

## Development

```bash
npm install
npm run dev
```

The Vite dev server proxies `/api`, `/ws`, and related Hub routes to
`http://localhost:3000`. You still need a running Hub (and usually an Agent);
there is no mock backend. For bring-up traps and curl probes, see
[`docs/local-debugging.md`](../docs/local-debugging.md).

## Building

```bash
npm run build
```

Output goes to `dist/`. The Hub serves these static files via `ServeDir`
(reads from disk at request time — rebuild frontend, hard-refresh browser;
no Hub restart required for UI-only changes).

## API Endpoints (used by the UI)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/session/exchange` | POST | Login |
| `/api/session/logout` | POST | Logout |
| `/api/health` | GET | Public hub health |
| `/api/agents` | GET | List agents |
| `/api/agents/:id` | GET | Agent detail (roots, collections, …) |
| `/api/agents/:id/resources` | GET / PUT | Resource snapshot / full replace |
| `/api/agents/:id/roots` | POST | Add root |
| `/api/agents/:id/roots/:name` | PATCH / DELETE | Update / remove root |
| `/api/agents/:id/collections` | POST | Create collection (optional initial item) |
| `/api/agents/:id/collections/:name` | PATCH / DELETE | Rename / add / remove items / delete |
| `/api/agents/:id/workspace-search` | POST | Workspace Search (find / content) |
| `/api/agents/:id/sys-stats` | GET | System stats |
| `/api/events` | GET | SSE stream |
| `/api/fs/list` | GET | Directory listing |
| `/api/fs/stat` | GET | File metadata |
| `/api/file/raw` | GET | File bytes (streaming) |
| `/api/preview/sessions` | POST | HTML preview session token |
| `/api/preview/:token/*` | GET | HTML relative asset fetch |
| `/api/cancel` | POST | Cancel in-flight request |

## Mobile Support

Below 768px the UI uses:
- Hamburger drawer for sidebar navigation
- Full-screen browser or preview (not side-by-side)
- Touch-friendly controls
- Horizontally scrollable dense tables (e.g. processes)
