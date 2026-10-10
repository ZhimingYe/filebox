# filebox neo frontend (experimental)

Browser-only multi-panel shell for filebox, served at **`/neo`**.

This package is an **independent** Vite + React + TypeScript app. It does
**not** replace `frontend/` (the classic SPA at `/`). Desktop browser only
for now — no Electron / desktop shell.

## Scope (first spike)

- dockview layout with **File tree** and **Preview** panel placeholders
- Hub static routing under `/neo` and `/neo/`
- Same-origin Hub probe via `/api/health` (works when Hub serves the build,
  or when `npm run dev` proxies to a local Hub)

Later spikes will mount real FileBrowser / PreviewWorkspace components,
reuse existing stores/APIs, and honor the #86 pin contract
(`MAX_DOM_PARKED=3`, active mount + park/registry). Same-origin popout via
dockview is planned.

## Gate criteria (when real preview lands)

- Dual PDF memory ≤ 1.3× classic baseline
- Tab visible ≤ 100ms
- Park restore ≤ 200ms

## Develop

```bash
# Terminal A — Hub (from repo root, classic dist still required for /)
cd frontend && npm run build && cd ..
FILEBOX_DEV_MODE=1 FILEBOX_FRONTEND_DIR="$(pwd)/frontend/dist" \
  FILEBOX_NEO_FRONTEND_DIR="$(pwd)/neo_frontend/dist" \
  cargo run -p filebox-hub

# Terminal B — neo (Vite on :5174, proxies /api and /ws)
cd neo_frontend && npm install && npm run dev
# open http://localhost:5174/neo/
```

Or build neo and let Hub serve it:

```bash
cd neo_frontend && npm install && npm run build
# Hub finds neo_frontend/dist next to frontend/dist, or set FILEBOX_NEO_FRONTEND_DIR
# open http://127.0.0.1:3000/neo/
```

## Build

```bash
npm install
npm run build   # writes dist/ with base /neo/
```
