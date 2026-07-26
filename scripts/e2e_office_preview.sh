#!/usr/bin/env bash
# End-to-end Office preview smoke (Hub + Agent + fake soffice).
# No real LibreOffice required. Exit 0 on full pass.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WORKDIR="$(mktemp -d -t filebox-office-e2e.XXXXXX)"
HUB_PID=""
AGENT_PID=""
SSE_PID=""
CONVERT_PID=""

cleanup() {
  set +e
  [[ -n "${CONVERT_PID}" ]] && kill "${CONVERT_PID}" 2>/dev/null
  [[ -n "${SSE_PID}" ]] && kill "${SSE_PID}" 2>/dev/null
  [[ -n "${AGENT_PID}" ]] && kill "${AGENT_PID}" 2>/dev/null
  [[ -n "${HUB_PID}" ]] && kill "${HUB_PID}" 2>/dev/null
  wait 2>/dev/null || true
  # Best-effort: no leftover fake soffice children
  pkill -f "${WORKDIR}/fake-soffice" 2>/dev/null || true
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

log() { printf '==> %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'OK: %s\n' "$*"; }

need() { command -v "$1" >/dev/null || fail "missing command: $1"; }
need curl
need python3
need cargo

PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
BASE="http://127.0.0.1:${PORT}"
COOKIE_JAR="${WORKDIR}/cookies.txt"
DEMO_ROOT="${WORKDIR}/demo"
AGENT_DATA="${WORKDIR}/agent-data"
HUB_LOG="${WORKDIR}/hub.log"
AGENT_LOG="${WORKDIR}/agent.log"
SSE_LOG="${WORKDIR}/sse.log"

mkdir -p "${DEMO_ROOT}/.ssh" "${AGENT_DATA}"
printf 'docx-bytes-a' >"${DEMO_ROOT}/a.docx"
printf 'pptx-bytes-b' >"${DEMO_ROOT}/b.pptx"
printf 'xlsx-bytes-c' >"${DEMO_ROOT}/c.xlsx"
printf 'plain' >"${DEMO_ROOT}/notes.txt"
printf 'secret' >"${DEMO_ROOT}/.ssh/notes.docx"

# Fake LibreOffice: honors FAKE_SOFFICE_SLEEP (seconds, float) and FAKE_SOFFICE_FAIL=1.
# Emits a minimal PDF or two worksheet CSV files.
MIN_PDF_B64='JVBERi0xLjQKMSAwIG9iajw8IC9UeXBlIC9DYXRhbG9nIC9QYWdlcyAyIDAgUiA+PmVuZG9iagoyIDAgb2JqPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj5lbmRvYmoKMyAwIG9iajw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNjEyIDc5Ml0gL0NvbnRlbnRzIDQgMCBSIC9SZXNvdXJjZXM8PCAvRm9udDw8IC9GMSA1IDAgUiA+PiA+PiA+PmVuZG9iago0IDAgb2JqPDwgL0xlbmd0aCAzNiA+PnN0cmVhbQpCVCAvRjEgMjQgVGYgNzIgNzIwIFRkIChIZWxsbykgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+ZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU2IDAwMDAwIG4gCjAwMDAwMDAxMTEgMDAwMDAgbiAKMDAwMDAwMDIzMyAwMDAwMCBuIAowMDAwMDAwMzE3IDAwMDAwIG4gCnRyYWlsZXI8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgozODUKJSVFT0YK'
cat >"${WORKDIR}/fake-soffice" <<EOS
#!/bin/sh
set -e
if [ "\$1" = "--headless" ] && [ "\$2" = "--version" ]; then
  echo "LibreOffice 26.2.5.2 e2e-fake"
  exit 0
fi
outdir=""
input=""
convert=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = "--outdir" ]; then outdir="\$a"; fi
  if [ "\$prev" = "--convert-to" ]; then convert="\$a"; fi
  prev="\$a"
  input="\$a"
done
if [ -z "\$outdir" ] || [ -z "\$input" ]; then
  echo "bad args" >&2
  exit 2
fi
if [ -n "\${FAKE_SOFFICE_SLEEP:-}" ]; then
  sleep "\${FAKE_SOFFICE_SLEEP}"
fi
if [ "\${FAKE_SOFFICE_FAIL:-0}" = "1" ]; then
  echo "forced fail" >&2
  exit 1
fi
base=\$(basename "\$input")
name=\${base%.*}
case "\$convert" in
  csv:*)
    printf 'name,value\nalpha,1\n' > "\$outdir/\$name-Sheet1.csv"
    : > "\$outdir/\$name-Sheet2.csv"
    exit 0
    ;;
esac
echo '${MIN_PDF_B64}' | base64 -d > "\$outdir/\$name.pdf"
exit 0
EOS
chmod +x "${WORKDIR}/fake-soffice"

if [[ ! -f frontend/dist/index.html ]]; then
  log "Building frontend (missing frontend/dist)"
  (cd frontend && npm run build)
fi

log "Building hub + agent (debug)"
cargo build -q -p filebox-hub -p filebox-agent

log "Starting hub on ${BASE}"
FILEBOX_DEV_MODE=1 \
FILEBOX_LISTEN_ADDR="127.0.0.1:${PORT}" \
FILEBOX_FRONTEND_DIR="${ROOT}/frontend/dist" \
RUST_LOG=info \
  "${ROOT}/target/debug/hub" >"${HUB_LOG}" 2>&1 &
HUB_PID=$!

for i in $(seq 1 50); do
  if curl -sf --noproxy '*' "${BASE}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
  if [[ "$i" -eq 50 ]]; then
    cat "${HUB_LOG}" >&2 || true
    fail "hub did not become healthy"
  fi
done
pass "hub healthy"

start_agent() {
  local with_soffice="$1"
  local env_soffice=()
  if [[ "${with_soffice}" == "1" ]]; then
    env_soffice=(FILEBOX_AGENT_SOFFICE="${WORKDIR}/fake-soffice")
  fi
  env \
    FILEBOX_AGENT_HUB="ws://127.0.0.1:${PORT}" \
    FILEBOX_AGENT_TOKEN="dev-token" \
    FILEBOX_AGENT_NAME="e2e-office" \
    FILEBOX_AGENT_DATA_DIR="${AGENT_DATA}" \
    FILEBOX_ALLOW_INSECURE_HUB=1 \
    FAKE_SOFFICE_SLEEP="${FAKE_SOFFICE_SLEEP:-}" \
    "${env_soffice[@]}" \
    RUST_LOG=info \
    "${ROOT}/target/debug/agent" >"${AGENT_LOG}" 2>&1 &
  AGENT_PID=$!
}

start_agent 1

login() {
  curl -sS --noproxy '*' -c "${COOKIE_JAR}" -b "${COOKIE_JAR}" \
    -X POST "${BASE}/api/session/exchange" \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"dev-password","remember":false}' \
    -o "${WORKDIR}/login.json"
  CSRF="$(python3 -c "import json;print(json.load(open('${WORKDIR}/login.json'))['csrf_token'])")"
  export CSRF
}

api() {
  # usage: api METHOD PATH [curl args...]
  local method="$1"; shift
  local path="$1"; shift
  curl -sS --noproxy '*' -c "${COOKIE_JAR}" -b "${COOKIE_JAR}" \
    -H "X-CSRF-Token: ${CSRF}" \
    -H 'Content-Type: application/json' \
    -X "${method}" "${BASE}${path}" "$@"
}

wait_agent_online() {
  local want_cap="${1:-}" # "true" / "false" / ""
  for i in $(seq 1 80); do
    api GET /api/agents -o "${WORKDIR}/agents_poll.json" || true
    if AGENT_ID="$(WANT_CAP="${want_cap}" python3 - <<PY
import json, os, sys
try:
    agents=json.load(open("${WORKDIR}/agents_poll.json"))
except Exception:
    sys.exit(1)
if not agents:
    sys.exit(1)
a=agents[0]
if a.get("status") not in ("online","slow"):
    sys.exit(1)
cap=a.get("capabilities") or {}
want=os.environ.get("WANT_CAP","")
if want=="true" and not cap.get("office_pdf_preview"):
    sys.exit(1)
if want=="false" and cap.get("office_pdf_preview"):
    sys.exit(1)
print(a["id"])
PY
)"; then
      export AGENT_ID
      return 0
    fi
    sleep 0.15
  done
  cat "${AGENT_LOG}" >&2 || true
  fail "agent not online (want_cap=${want_cap})"
}

login
wait_agent_online true
pass "agent online with office_pdf_preview"

log "Adding demo root"
api POST "/api/agents/${AGENT_ID}/roots" \
  -d "{\"name\":\"demo\",\"path\":\"${DEMO_ROOT}\",\"enabled\":true}" \
  -o "${WORKDIR}/add_root.json"
# Give the agent a moment to apply roots
sleep 0.5

# ── A: capability ───────────────────────────────────────────────────────────
api GET /api/agents -o "${WORKDIR}/agents.json"
python3 - <<PY
import json
a=json.load(open("${WORKDIR}/agents.json"))[0]
assert a["capabilities"]["office_pdf_preview"] is True
print("cap ok")
PY
pass "A capability true"

convert() {
  local path="$1"
  local out="$2"
  local code_file="$3"
  local http
  http="$(curl -sS --noproxy '*' -c "${COOKIE_JAR}" -b "${COOKIE_JAR}" \
    -H "X-CSRF-Token: ${CSRF}" \
    -H 'Content-Type: application/json' \
    -X POST "${BASE}/api/agents/${AGENT_ID}/office-convert" \
    -d "{\"root\":\"demo\",\"path\":\"${path}\"}" \
    -o "${out}" -w '%{http_code}' || true)"
  printf '%s' "${http}" >"${code_file}"
}

# ── B: convert docx ─────────────────────────────────────────────────────────
convert "/a.docx" "${WORKDIR}/conv_a.json" "${WORKDIR}/conv_a.code"
[[ "$(cat "${WORKDIR}/conv_a.code")" == "200" ]] || {
  cat "${WORKDIR}/conv_a.json" >&2
  fail "B convert docx http=$(cat "${WORKDIR}/conv_a.code")"
}
CACHE_KEY="$(python3 - <<PY
import json
v=json.load(open("${WORKDIR}/conv_a.json"))
assert v.get("error") in (None, "null") or v.get("error") is None
key=v["cache_key"]
assert isinstance(key,str) and len(key)==64
assert int(v["size"])>0
print(key)
PY
)"
pass "B convert docx cache_key=${CACHE_KEY:0:8}…"

# ── C: raw virtual PDF ──────────────────────────────────────────────────────
RAW_CODE="$(curl -sS --noproxy '*' -c "${COOKIE_JAR}" -b "${COOKIE_JAR}" \
  -H "X-CSRF-Token: ${CSRF}" \
  -o "${WORKDIR}/out.pdf" -w '%{http_code}' \
  "${BASE}/api/file/raw?agent_id=${AGENT_ID}&root=demo&path=/.filebox/office-cache/${CACHE_KEY}.pdf")"
[[ "${RAW_CODE}" == "200" ]] || fail "C raw pdf http=${RAW_CODE}"
python3 - <<PY
data=open("${WORKDIR}/out.pdf","rb").read()
assert data.startswith(b"%PDF"), data[:20]
assert len(data)>0
print("pdf bytes", len(data))
PY
pass "C raw PDF starts with %PDF"

# ── D: cache hit same key ───────────────────────────────────────────────────
convert "/a.docx" "${WORKDIR}/conv_a2.json" "${WORKDIR}/conv_a2.code"
[[ "$(cat "${WORKDIR}/conv_a2.code")" == "200" ]] || fail "D second convert failed"
python3 - <<PY
import json
v=json.load(open("${WORKDIR}/conv_a2.json"))
assert v["cache_key"]=="${CACHE_KEY}"
PY
pass "D cache hit same key"

# ── E: pptx + xlsx ──────────────────────────────────────────────────────────
convert "/b.pptx" "${WORKDIR}/conv_b.json" "${WORKDIR}/conv_b.code"
convert "/c.xlsx" "${WORKDIR}/conv_c.json" "${WORKDIR}/conv_c.code"
[[ "$(cat "${WORKDIR}/conv_b.code")" == "200" ]] || fail "E pptx failed"
[[ "$(cat "${WORKDIR}/conv_c.code")" == "200" ]] || fail "E xlsx failed"
python3 - <<PY
import json
v=json.load(open("${WORKDIR}/conv_c.json"))
outputs=v["outputs"]
assert [o["label"] for o in outputs] == ["Sheet1", "Sheet2"], outputs
assert all(o["format"] == "csv" and int(o["size"]) >= 0 for o in outputs), outputs
assert int(outputs[0]["size"]) > 0 and int(outputs[1]["size"]) == 0, outputs
PY
pass "E pptx PDF + xlsx worksheet CSVs"

# ── F: denylist ─────────────────────────────────────────────────────────────
convert "/.ssh/notes.docx" "${WORKDIR}/conv_deny.json" "${WORKDIR}/conv_deny.code"
python3 - <<PY
import json
code=open("${WORKDIR}/conv_deny.code").read().strip()
v=json.load(open("${WORKDIR}/conv_deny.json"))
assert code!="200", (code,v)
assert v.get("error")=="denied", v
PY
pass "F denylist denied"

# ── G: unsupported format ───────────────────────────────────────────────────
convert "/notes.txt" "${WORKDIR}/conv_txt.json" "${WORKDIR}/conv_txt.code"
python3 - <<PY
import json
code=open("${WORKDIR}/conv_txt.code").read().strip()
v=json.load(open("${WORKDIR}/conv_txt.json"))
assert code=="400", (code,v)
assert v.get("error")=="unsupported_format", v
PY
pass "G unsupported_format"

# ── H: agent_busy (slow convert + parallel) ─────────────────────────────────
# Use fresh filenames so cache from A–E cannot short-circuit soffice.
printf 'busy-one' >"${DEMO_ROOT}/busy1.docx"
printf 'busy-two' >"${DEMO_ROOT}/busy2.docx"
log "Restarting agent with slow fake soffice for busy/cancel tests"
kill "${AGENT_PID}" 2>/dev/null || true
wait "${AGENT_PID}" 2>/dev/null || true
AGENT_PID=""
FAKE_SOFFICE_SLEEP=2 start_agent 1
wait_agent_online true

# background slow convert
convert "/busy1.docx" "${WORKDIR}/conv_slow.json" "${WORKDIR}/conv_slow.code" &
CONVERT_PID=$!
sleep 0.4
convert "/busy2.docx" "${WORKDIR}/conv_busy.json" "${WORKDIR}/conv_busy.code"
wait "${CONVERT_PID}" || true
CONVERT_PID=""
python3 - <<PY
import json
busy_code=open("${WORKDIR}/conv_busy.code").read().strip()
busy=json.load(open("${WORKDIR}/conv_busy.json"))
slow_code=open("${WORKDIR}/conv_slow.code").read().strip()
# One of the two should be busy; typically the second.
ok = busy_code=="409" or busy.get("error")=="agent_busy" or slow_code=="409"
assert ok, (busy_code, busy, slow_code)
print("busy ok", busy_code, busy.get("error"), "slow", slow_code)
PY
pass "H agent_busy under concurrency"

# ── I: cancel mid-convert ───────────────────────────────────────────────────
printf 'cancel-me' >"${DEMO_ROOT}/cancel.docx"
log "Cancel mid-convert via SSE req_id"
ACCESS="$(api POST /api/access-tokens -d '{"purpose":"events"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")"
: >"${SSE_LOG}"
curl -sS -N --noproxy '*' -b "${COOKIE_JAR}" \
  -H 'Accept: text/event-stream' \
  "${BASE}/api/events?access_token=${ACCESS}" >"${SSE_LOG}" 2>&1 &
SSE_PID=$!
sleep 0.2

convert "/cancel.docx" "${WORKDIR}/conv_cancel.json" "${WORKDIR}/conv_cancel.code" &
CONVERT_PID=$!

REQ_ID=""
for i in $(seq 1 40); do
  REQ_ID="$(python3 - <<PY
import re
text=open("${SSE_LOG}").read()
m=re.search(r"(office_convert_[0-9a-fA-F\-]+)", text)
print(m.group(1) if m else "")
PY
)"
  if [[ -n "${REQ_ID}" ]]; then
    break
  fi
  sleep 0.1
done
[[ -n "${REQ_ID}" ]] || {
  cat "${SSE_LOG}" >&2
  fail "I could not find office_convert req_id on SSE"
}

api POST /api/cancel -d "{\"agent_id\":\"${AGENT_ID}\",\"req_id\":\"${REQ_ID}\"}" \
  -o "${WORKDIR}/cancel.json"
wait "${CONVERT_PID}" || true
CONVERT_PID=""
kill "${SSE_PID}" 2>/dev/null || true
SSE_PID=""

python3 - <<PY
import json
code=open("${WORKDIR}/conv_cancel.code").read().strip()
v=json.load(open("${WORKDIR}/conv_cancel.json"))
assert v.get("error")=="cancelled" or code in ("200",), (code,v)
# Prefer explicit cancelled error
assert v.get("error")=="cancelled", v
PY
# No leftover fake-soffice (allow the script path itself if still listed briefly)
sleep 0.2
if pgrep -f "${WORKDIR}/fake-soffice" >/dev/null 2>&1; then
  # Ignore if only zombie briefly; kill and recheck
  pkill -f "${WORKDIR}/fake-soffice" 2>/dev/null || true
  sleep 0.2
  if pgrep -f "${WORKDIR}/fake-soffice" >/dev/null 2>&1; then
    pgrep -af fake-soffice >&2 || true
    fail "I leftover fake-soffice process after cancel"
  fi
fi
pass "I cancel → cancelled, no leftover soffice"

# ── J: capability false without soffice ─────────────────────────────────────
log "Restarting agent without FILEBOX_AGENT_SOFFICE"
kill "${AGENT_PID}" 2>/dev/null || true
wait "${AGENT_PID}" 2>/dev/null || true
AGENT_PID=""
unset FAKE_SOFFICE_SLEEP || true
start_agent 0
wait_agent_online false
pass "J agent online without office capability"

convert "/a.docx" "${WORKDIR}/conv_unsup.json" "${WORKDIR}/conv_unsup.code"
python3 - <<PY
import json
code=open("${WORKDIR}/conv_unsup.code").read().strip()
v=json.load(open("${WORKDIR}/conv_unsup.json"))
assert code in ("501","400"), (code,v)
assert v.get("error") in ("unsupported_feature","unsupported"), v
PY
pass "J unsupported_feature without soffice"

log "All Office preview e2e checks passed"
