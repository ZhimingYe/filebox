#!/usr/bin/env bash
# Real LibreOffice E2E for complex PPTX (PR #37 Linux PowerPoint preview).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SOFFICE="${FILEBOX_AGENT_SOFFICE:-$HOME/opt/libreoffice/opt/libreoffice26.2/program/soffice}"
PPTX="${1:-$ROOT/testdata/complex-e2e.pptx}"
[[ -f "$PPTX" ]] || { echo "missing PPTX: $PPTX" >&2; exit 1; }
[[ -x "$SOFFICE" ]] || { echo "missing soffice: $SOFFICE" >&2; exit 1; }

WORKDIR="$(mktemp -d -t filebox-pptx-e2e.XXXXXX)"
HUB_PID=""
AGENT_PID=""
DEMO_ROOT="${WORKDIR}/demo"
AGENT_DATA="${WORKDIR}/agent-data"
COOKIE_JAR="${WORKDIR}/cookies.txt"
PORT="$(python3 - <<'PY'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()
PY
)"
BASE="http://127.0.0.1:${PORT}"

cleanup() {
  set +e
  [[ -n "${AGENT_PID}" ]] && kill "${AGENT_PID}" 2>/dev/null
  [[ -n "${HUB_PID}" ]] && kill "${HUB_PID}" 2>/dev/null
  wait 2>/dev/null || true
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

log() { printf '==> %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'OK: %s\n' "$*"; }

mkdir -p "${DEMO_ROOT}" "${AGENT_DATA}"
cp "$PPTX" "${DEMO_ROOT}/complex-e2e.pptx"

log "Starting hub on ${BASE}"
FILEBOX_DEV_MODE=1 \
FILEBOX_LISTEN_ADDR="127.0.0.1:${PORT}" \
FILEBOX_FRONTEND_DIR="${ROOT}/frontend/dist" \
RUST_LOG=info \
  "${ROOT}/target/debug/hub" >"${WORKDIR}/hub.log" 2>&1 &
HUB_PID=$!

for _ in $(seq 1 60); do
  curl -sf --noproxy '*' "${BASE}/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf --noproxy '*' "${BASE}/api/health" >/dev/null || fail "hub not healthy"

log "Starting agent with real LibreOffice"
FILEBOX_AGENT_HUB="ws://127.0.0.1:${PORT}" \
FILEBOX_AGENT_TOKEN="dev-token" \
FILEBOX_AGENT_NAME="pptx-e2e" \
FILEBOX_ALLOW_INSECURE_HUB=1 \
FILEBOX_AGENT_DATA_DIR="${AGENT_DATA}" \
FILEBOX_AGENT_SOFFICE="${SOFFICE}" \
  "${ROOT}/target/debug/agent" >"${WORKDIR}/agent.log" 2>&1 &
AGENT_PID=$!

sleep 2

# Login (solve the self-hosted proof-of-work challenge first; single-use per attempt)
POW_JSON="$(curl -sS --noproxy '*' "${BASE}/api/pow/challenge")"
POW_ID="$(printf '%s' "${POW_JSON}" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")"
POW_NONCE="$(printf '%s' "${POW_JSON}" | python3 -c "
import sys, json, hashlib
ch = json.load(sys.stdin)
prefix = f\"{ch['id']}:{ch['salt']}:\"
target = ch['difficulty']
nonce = 0
while True:
    digest = hashlib.sha256((prefix + str(nonce)).encode()).digest()
    if int.from_bytes(digest, 'big') >> (256 - target) == 0:
        break
    nonce += 1
print(nonce)")"
curl -sS --noproxy '*' -c "${COOKIE_JAR}" -b "${COOKIE_JAR}" \
  -X POST "${BASE}/api/session/exchange" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"dev-password\",\"remember\":false,\"pow_id\":\"${POW_ID}\",\"pow_nonce\":\"${POW_NONCE}\"}" \
  >"${WORKDIR}/login.json"
CSRF="$(python3 -c "import json; print(json.load(open('${WORKDIR}/login.json'))['csrf_token'])")"

# Wait for agent + capability
AGENT_ID=""
for _ in $(seq 1 40); do
  curl -sS --noproxy '*' -c "${COOKIE_JAR}" -b "${COOKIE_JAR}" \
    -H "X-CSRF-Token: ${CSRF}" "${BASE}/api/agents" >"${WORKDIR}/agents.json"
  AGENT_ID="$(python3 - <<PY
import json
agents = json.load(open("${WORKDIR}/agents.json"))
for a in agents:
    caps = (a.get("capabilities") or {})
    if caps.get("office_pdf_preview"):
        print(a["id"]); break
PY
)"
  [[ -n "${AGENT_ID}" ]] && break
  sleep 0.5
done
[[ -n "${AGENT_ID}" ]] || { tail -30 "${WORKDIR}/agent.log" >&2; fail "no agent with office_pdf_preview"; }
pass "Agent ${AGENT_ID} has office_pdf_preview"

# Add root
curl -sS --noproxy '*' -c "${COOKIE_JAR}" -b "${COOKIE_JAR}" \
  -H "X-CSRF-Token: ${CSRF}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE}/api/agents/${AGENT_ID}/roots" \
  -d "{\"name\":\"docs\",\"path\":\"${DEMO_ROOT}\",\"enabled\":true}" \
  >"${WORKDIR}/roots.json"
sleep 1

log "Converting complex PPTX via API (may take 30-120s)"
START=$(date +%s)
curl -sS --noproxy '*' -c "${COOKIE_JAR}" -b "${COOKIE_JAR}" \
  -H "X-CSRF-Token: ${CSRF}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE}/api/agents/${AGENT_ID}/office-convert" \
  -d '{"root":"docs","path":"/complex-e2e.pptx"}' \
  >"${WORKDIR}/convert.json"
END=$(date +%s)
python3 - <<PY
import json, sys
data = json.load(open("${WORKDIR}/convert.json"))
err = data.get("error")
if err:
    print(json.dumps(data, indent=2))
    sys.exit(1)
outputs = data.get("outputs") or []
if not outputs or outputs[0].get("format") != "pdf":
    print("unexpected outputs:", data)
    sys.exit(1)
print(f"convert ok in {${END}-${START}}s: cache_key={data['cache_key'][:16]}… pdf_size={outputs[0]['size']}")
open("${WORKDIR}/cache_key.txt","w").write(outputs[0]["cache_key"])
PY
pass "Office convert succeeded"

CACHE_KEY="$(cat "${WORKDIR}/cache_key.txt")"
PDF_PATH="${WORKDIR}/out.pdf"

log "Fetching derived PDF"
curl -sS --noproxy '*' -c "${COOKIE_JAR}" -b "${COOKIE_JAR}" \
  -H "X-CSRF-Token: ${CSRF}" \
  -o "${PDF_PATH}" \
  "${BASE}/api/file/raw?agent_id=${AGENT_ID}&root=docs&path=/.filebox/office-cache/${CACHE_KEY}.pdf"
[[ -s "${PDF_PATH}" ]] || fail "empty PDF download"
head -c 5 "${PDF_PATH}" | grep -q '%PDF-' || fail "not a PDF"
pass "PDF download valid header ($(wc -c < "${PDF_PATH}") bytes)"

log "Validating PDF structure (xref/trailer)"
python3 - "${PDF_PATH}" <<'PY'
import sys
path = sys.argv[1]
data = open(path, "rb").read()
if not data.startswith(b"%PDF-"):
    raise SystemExit("missing PDF header")
if b"startxref" not in data[-4096:] and b"startxref" not in data:
    raise SystemExit("missing startxref")
if b"%%EOF" not in data[-128:]:
    raise SystemExit("missing %%EOF trailer")
print(f"PDF structure OK ({len(data):,} bytes)")
PY
pass "PDF structure validation"

log "Cache hit on second convert"
curl -sS --noproxy '*' -c "${COOKIE_JAR}" -b "${COOKIE_JAR}" \
  -H "X-CSRF-Token: ${CSRF}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE}/api/agents/${AGENT_ID}/office-convert" \
  -d '{"root":"docs","path":"/complex-e2e.pptx"}' \
  >"${WORKDIR}/convert2.json"
python3 - <<PY
import json
d = json.load(open("${WORKDIR}/convert2.json"))
assert d.get("error") is None
assert d["cache_key"] == open("${WORKDIR}/cache_key.txt").read().strip()
print("cache hit confirmed")
PY
pass "Second convert returned same cache_key"

log "70 concurrent Range reads on derived PDF (access_token + session cookie)"
python3 - <<PY
import json, subprocess, sys, urllib.parse
base = "${BASE}"
agent = "${AGENT_ID}"
key = open("${WORKDIR}/cache_key.txt").read().strip()
path = f"/.filebox/office-cache/{key}.pdf"
csrf = "${CSRF}"
cookie_jar = "${COOKIE_JAR}"

def cookie_map() -> dict[str, str]:
    out: dict[str, str] = {}
    with open(cookie_jar) as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            cols = line.split("\t")
            if len(cols) >= 7:
                out[cols[5]] = cols[6].strip()
    return out

def mint_token() -> str:
    cookies = cookie_map()
    csrf_now = cookies.get("filebox_csrf", csrf)
    body = json.dumps({
        "purpose": "file_raw",
        "agent_id": agent,
        "root": "docs",
        "path": path,
    })
    out = subprocess.check_output(
        ["curl", "-sS", "--noproxy", "*", "-c", cookie_jar, "-b", cookie_jar,
         "-H", f"X-CSRF-Token: {csrf_now}", "-H", "Content-Type: application/json",
         "-X", "POST", f"{base}/api/access-tokens", "-d", body],
        text=True,
    )
    return json.loads(out)["token"]

reads = []
for i in range(70):
    token = mint_token()
    q = urllib.parse.urlencode({
        "agent_id": agent,
        "root": "docs",
        "path": path,
        "access_token": token,
    })
    reads.append(f"{base}/api/file/raw?{q}")

procs = []
for url in reads:
    p = subprocess.Popen(
        ["curl", "-sS", "-f", "--noproxy", "*", "-b", cookie_jar,
         "-H", "Range: bytes=0-1023", "-o", "/dev/null", url],
    )
    procs.append(p)
failed = sum(1 for p in procs if p.wait() != 0)
if failed:
    sys.exit(f"{failed} range reads failed")
print("70 concurrent Range reads OK")
PY
pass "70 concurrent PDF range reads"

log "Direct soffice headless convert sanity check"
SOFFICE_OUT="${WORKDIR}/direct"
mkdir -p "${SOFFICE_OUT}"
START=$(date +%s)
"${SOFFICE}" --headless --nologo --nofirststartwizard \
  --convert-to pdf --outdir "${SOFFICE_OUT}" "${PPTX}" \
  >"${WORKDIR}/soffice.log" 2>&1
END=$(date +%s)
DIRECT_PDF="${SOFFICE_OUT}/complex-e2e.pdf"
[[ -f "${DIRECT_PDF}" ]] || { cat "${WORKDIR}/soffice.log" >&2; fail "direct soffice convert failed"; }
pass "Direct soffice convert in $((END-START))s ($(wc -c < "${DIRECT_PDF}") bytes)"

log "All real LibreOffice PPTX E2E checks passed"
