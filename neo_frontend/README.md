# filebox neo frontend

Browser-only dockview shell for the next-generation filebox UI. Sibling of
classic `frontend/` — does **not** replace it. Long-lived work lands on the
`filebox-neo` branch; **do not merge to `main`** until explicitly signed off.

## What this PR / spike includes

- Vite + React + TypeScript app with `base: '/neo/'`
- Dockview layout: **Files** (classic `FileBrowser` / `DirectoryTree`) + **Preview**
  (classic `PreviewPane` viewers, multi-tab via dockview)
- Vite alias `@classic` → `../frontend/src` (classic sources imported in-place;
  React deduped so hooks share one copy)
- Classic session / CSRF (`ensureCookieSuffix`, `withCsrf`, login PoW) for `/neo/`
- Open-file bridge: `filebox-neo:open-file` → `openFileInDock` (activate / fill
  empty / new preview tab)
- Same-origin popout stub at `/neo/popout.html`
- Hub serves `neo_frontend/dist` under `/neo`

## What is intentionally NOT included

- Mobile layout (desktop dock only for now)
- Preview viewer DOM park / zoom-scroll restore across full page reload
  (tab paths + pin flags persist; #86 keep-alive still works within a session)

## Classic reuse

| Classic module | Status |
| --- | --- |
| `api/client.ts`, `api/retry.ts` | **Reused** via `@classic` |
| `state/session.ts`, `health.ts`, `navPersistence.ts` | **Reused** |
| `components/Login.tsx`, `lib/pow.ts` | **Reused** (neo session gate) |
| `components/FileBrowser.tsx`, `DirectoryTree.tsx`, file list | **Reused** in Files panel |
| `components/PreviewPane.tsx` + `*Preview.tsx` | **Reused** in Preview panel |
| `PreviewWorkspace` / `usePreviewTabs` / `previewKeepAlive` | **Reused** (#86 pin/park) |
| `CollectionPicker` | **Reused** (Files / Explorer hover → App overlay) |
| `ExplorerView` | **Reused** as Explorer dock panel |
| `BackendList` | **Reused** in NeoSidebar agent picker |
| `theme.ts` / icons | **Reused** (neo keeps a small chrome mirror) |
| `App.tsx` shell / `WorkspaceSplit` | **Rewritten** as dockview shell |

## Classic chrome (desktop)

Topbar opens dock panels / overlays by reusing classic components via `@classic`:

| Entry | Classic module | Mount |
| --- | --- | --- |
| Search | `WorkspaceSearch` via thin `NeoSearchFloat` | Floating overlay (no classic window chrome) |
| Collections | `CollectionsView` | Dock panel |
| Transfer | `TempTransferView` | Dock panel |
| Terminal | `TerminalView` | Dock panel |
| Settings | `AgentSettings` | Dock panel |
| Stats | `SystemStats` | Dock panel |
| Audit | `LoginAudit` | Dock panel |
| About | `AboutDialog` | Modal (version chip) |

Mobile drawer / bottom sheet search are intentionally skipped.

### Desktop chrome extras

- Left **NeoSidebar**: classic `BackendList` agent picker + `PinnedFolders` (only place pins appear) + chrome nav (collapsible)
- **Files** dock: classic `FileBrowser` tree + list only (no duplicate pinned column)
- **Explorer** dock: classic `ExplorerView`, browse position shared with Files via `browsePos`
- **CollectionPicker** from Files / Explorer row actions
- App-wide drag-drop → Transfer (`uploadRequest` handoff + overlay)
- SSE progress toasts + new-version toast (shared dismiss key with classic)
- Dockview layout persist (`filebox.neo.dockLayout.v1`) + best-effort preview tabs/pins (`filebox.neo.previewTabs.v1`)


## Preview dock (this track)

- Each preview dock panel hosts classic `usePreviewTabs` + `PreviewWorkspace` via `@classic`
- #86 pin / DOM keep-alive park (HTML/PDF/Office) / ViewerStateRegistry (image/Monaco/md/CSV)
- Default open adds/activates a classic tab in the **focused** PreviewWorkspace; **New Preview** adds an empty dock panel for splits/popout
- `filebox-neo:open-file` → `openFileInDock`; `filebox-neo:agent-selected` drops foreign docks
- `filebox-neo:reveal-in-browser` from PreviewWorkspace path click → Files `applyNav`
- Same-origin **Pop out** → dockview `addPopoutGroup` + `/neo/popout.html`

## Dev

```bash
# Terminal A — hub
cd frontend && npm run build && cd ..
cargo run -p filebox-hub

# Terminal B — neo Vite (proxies /api and /ws to :3000)
cd neo_frontend
npm install
npm run build   # must succeed
npm run dev
# open http://localhost:5174/neo/
# Log in → pick agent in Files → browse tree/list → click a file → Preview tab
```

## Production-like (hub serves built neo)

```bash
cd neo_frontend && npm install && npm run build && cd ..
# optional: FILEBOX_NEO_FRONTEND_DIR="$(pwd)/neo_frontend/dist"
cargo run -p filebox-hub
# open http://localhost:3000/neo/
```

Release packaging copies `neo_frontend/dist` → `$STAGE/frontend/neo/`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite on :5174 with `/neo/` base |
| `npm run build` | `tsc -b && vite build` → `dist/` |
| `npm run preview` | Preview the production build |
