# filebox neo frontend

Browser-only dockview shell for the next-generation filebox UI. Sibling of
classic `frontend/` — does **not** replace it. Long-lived work lands on the
`filebox-neo` branch; **do not merge to `main`** until explicitly signed off.

## What this PR / spike includes

- Vite + React + TypeScript app with `base: '/neo/'`
- Empty **dockview** layout: file-tree placeholder + preview placeholder
- Same-origin popout stub at `/neo/popout.html` (for later `addPopoutGroup`)
- Thin `/api/health` probe to prove hub reachability
- Hub serves `neo_frontend/dist` under `/neo`

## What is intentionally NOT included

- PDF / HTML / Monaco / image / CSV / Markdown viewers
- Login, agent list, pins, collections, search, terminal
- Layout persistence / pin registry (#86 contract)

## Classic reuse plan

| Classic module | Plan |
| --- | --- |
| `frontend/src/theme.ts` | **Reuse** (mirrored subset now; later share via package/alias) |
| `frontend/src/api/client.ts` (CSRF, cookie suffix, `withCsrf`) | **Reuse** — TODO thin alias or shared package; stubbed health-only for now |
| `frontend/src/api/retry.ts` | **Reuse** when real FS/API calls arrive |
| `frontend/src/components/DirectoryTree.tsx`, `FileBrowser.tsx`, `FileEntryList.tsx`, `fileListShared.tsx` | **Reuse** behind dockview panels (adapt props; no rewrite unless dock constraints force it) |
| `frontend/src/components/icons.tsx` | **Reuse** |
| `frontend/src/components/PinnedFolders.tsx` + pin storage | **Reuse** against #86 pin-registry contract |
| `frontend/src/components/PreviewPane.tsx` + `*Preview.tsx` | **Reuse** inside preview dock tabs (later PRs) |
| `frontend/src/hooks/usePreviewTabs.ts` | Likely **rewrite** around dockview panel model |
| `frontend/src/components/WorkspaceSplit.tsx` | **Rewrite** — replaced by dockview grid |
| `frontend/src/App.tsx` shell / mobile drawer | **Rewrite** as neo shell + responsive dock layout |
| `frontend/src/state/session.ts`, `events.ts`, `health.ts` | **Reuse** with possible thin adapters |
| `frontend/src/monacoSetup.ts` | **Reuse** when Monaco panel lands |

## Dev

```bash
# Terminal A — hub (classic frontend optional)
cd frontend && npm run build && cd ..
cargo run -p filebox-hub

# Terminal B — neo Vite (proxies /api and /ws to :3000)
cd neo_frontend
npm install
npm run dev
# open http://localhost:5174/neo/
```

## Production-like (hub serves built neo)

```bash
cd neo_frontend && npm install && npm run build && cd ..
# optional override:
#   FILEBOX_NEO_FRONTEND_DIR="$(pwd)/neo_frontend/dist"
cargo run -p filebox-hub
# open http://localhost:3000/neo/
```

Release packaging copies `neo_frontend/dist` → `$STAGE/frontend/neo/` so the
hub find path `frontend/neo` (sibling of classic `frontend/dist`) resolves.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite on :5174 with `/neo/` base |
| `npm run build` | `tsc -b && vite build` → `dist/` |
| `npm run preview` | Preview the production build |
