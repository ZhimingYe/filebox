# filebox neo frontend (experimental)

Browser-only multi-panel shell for filebox, served at **`/neo`**.

Independent Vite + React + TypeScript app. Does **not** replace `frontend/`
(classic SPA at `/`). Browser only — no Electron / desktop shell.

## Current spike

- dockview layout: File tree + Preview (add more Preview panels from the top bar)
- Hub listing via `/api/agents` + `/api/fs/list` (same-origin session)
- Preview host eats **#86 pin contract**: stable-keyed active/park mounts + `dom-park`
  (`MAX_DOM_PARKED=3`, `keepAliveParkStyle`, no `visibility` hide; park must not remount)
- PDF bodies: CSRF fetch → blob: URL iframe (Hub raw is X-Frame-Options: DENY; preview sessions are HTML/ipynb only); other types stubbed
- Unit tests for `previewKeepAlive` park selection

## Gate criteria (dual PDF)

- Dual PDF memory ≤ 1.3× classic baseline
- Tab visible ≤ 100ms
- Park restore ≤ 200ms
- Fail gate → do not expand Monaco / charts / CSV

## Develop

```bash
# Terminal A — Hub
cd frontend && npm run build && cd ..
cd neo_frontend && npm run build && cd ..
FILEBOX_DEV_MODE=1 FILEBOX_FRONTEND_DIR="$(pwd)/frontend/dist" \
  FILEBOX_NEO_FRONTEND_DIR="$(pwd)/neo_frontend/dist" \
  cargo run -p filebox-hub

# Terminal B — neo Vite (:5174 proxies /api)
cd neo_frontend && npm install && npm run dev
# open http://localhost:5174/neo/  (log in via Classic / first if needed)
```

## Test / build

```bash
npm install
npm test
npm run build
```
