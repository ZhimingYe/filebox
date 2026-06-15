#!/usr/bin/env bash
#
# Filebox Agent - Install from GitHub Release (no Rust toolchain needed).
#
# Downloads the pre-built static musl x86_64 tarball, extracts it, and runs
# the same interactive config flow as serve_at_client.sh (hub URL, agent
# token, name, data dir).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ZhimingYe/filebox/main/scripts/install_agent.sh | bash
#   curl -fsSL ... | bash -s -- --version v0.2.0 --hub https://hub.example.com --token xxx
#   bash install_agent.sh --version 0.2.0 --install-dir /opt/filebox-agent
#
# Supported target: Linux x86_64 (musl static binary). Other platforms
# fall back to build-from-source via serve_at_client.sh.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

REPO="ZhimingYe/filebox"
VERSION=""
INSTALL_DIR="${FILEBOX_INSTALL_DIR:-$HOME/filebox-agent}"
# Optional non-interactive flags:
OPT_HUB=""
OPT_TOKEN=""
OPT_NAME=""

info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

confirm() {
    read -rp "$1 [y/N] " response
    case "$response" in
        [yY][eE][sS]|[yY]) return 0 ;;
        *) return 1 ;;
    esac
}

# ── Parse args ────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            VERSION="$2"; shift 2 ;;
        --install-dir)
            INSTALL_DIR="$2"; shift 2 ;;
        --hub)
            OPT_HUB="$2"; shift 2 ;;
        --token)
            OPT_TOKEN="$2"; shift 2 ;;
        --name)
            OPT_NAME="$2"; shift 2 ;;
        --help|-h)
            cat <<EOF
Usage: $0 [options]
  --version <v>          Specific release version. Default: latest.
  --install-dir <path>   Install directory. Default: \$HOME/filebox-agent
                          (override with \$FILEBOX_INSTALL_DIR).
  --hub <url>            Hub URL (skip interactive prompt).
  --token <token>        Agent token (skip interactive prompt).
  --name <name>          Agent display name (skip interactive prompt).
EOF
            exit 0 ;;
        *)
            error "Unknown arg: $1 (try --help)" ;;
    esac
done

# ── Platform check ───────────────────────────────────────────────────────
OS=$(uname -s)
ARCH=$(uname -m)
if [[ "$OS" != "Linux" ]] || [[ "$ARCH" != "x86_64" ]]; then
    error "Unsupported platform: $OS/$ARCH. This installer ships Linux x86_64 (musl) only. Use scripts/serve_at_client.sh to build from source."
fi

command -v curl >/dev/null || error "Missing: curl"
command -v tar >/dev/null  || error "Missing: tar"

# ── Resolve version ──────────────────────────────────────────────────────
if [[ -z "$VERSION" ]]; then
    info "Looking up latest release..."
    VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | python3 -c "import sys, json; print(json.load(sys.stdin)['tag_name'])")
fi
VERSION="${VERSION#v}"
info "Installing filebox agent v${VERSION}"

# ── Download ─────────────────────────────────────────────────────────────
TARBALL="filebox-agent-${VERSION}-x86_64-musl.tar.gz"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${TARBALL}"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

info "Downloading ${URL}..."
curl -fsSL -o "$TMPDIR/$TARBALL" "$URL" \
    || error "Download failed. Check that v${VERSION} exists on the releases page."

SUMS_URL="https://github.com/${REPO}/releases/download/v${VERSION}/SHA256SUMS.txt"
if curl -fsSL -o "$TMPDIR/SHA256SUMS.txt" "$SUMS_URL" 2>/dev/null; then
    info "Verifying checksum..."
    (cd "$TMPDIR" && sha256sum -c --ignore-missing SHA256SUMS.txt 2>&1 | grep -q "OK.*$TARBALL") \
        || error "Checksum verification failed for $TARBALL"
else
    warn "No SHA256SUMS.txt at this release; skipping checksum verification."
fi

info "Extracting..."
tar -xzf "$TMPDIR/$TARBALL" -C "$TMPDIR"
STAGE_DIR="$TMPDIR/filebox-agent-${VERSION}-x86_64-musl"
[[ -f "$STAGE_DIR/agent" ]] || error "Tarball missing agent binary"

# ── Interactive config (or apply flags) ──────────────────────────────────
collect_config() {
    info "Configuring Filebox Agent"
    echo ""

    # Hub URL
    if [[ -n "$OPT_HUB" ]]; then
        hub_url="$OPT_HUB"
    else
        while true; do
            read -rp "Hub server URL (e.g. https://filebox.example.com): " hub_url
            hub_url="${hub_url%/}"
            if [[ "$hub_url" =~ ^https?:// ]] || [[ "$hub_url" =~ ^wss?:// ]]; then
                break
            fi
            warn "URL must start with http://, https://, ws://, or wss://"
        done
    fi

    # Token
    if [[ -n "$OPT_TOKEN" ]]; then
        agent_token="$OPT_TOKEN"
    else
        while true; do
            read -rp "Agent token: " agent_token
            [[ -n "$agent_token" ]] && break
            warn "Token cannot be empty"
        done
    fi

    # Name
    if [[ -n "$OPT_NAME" ]]; then
        agent_name="$OPT_NAME"
    else
        read -rp "Agent name [$(hostname)]: " agent_name
        agent_name=${agent_name:-$(hostname)}
    fi

    # Data dir
    DATA_DIR="${INSTALL_DIR}/data"

    echo ""
    info "Configuration summary:"
    echo "  Hub URL:     $hub_url"
    echo "  Token:       $agent_token"
    echo "  Name:        $agent_name"
    echo "  Data dir:    $DATA_DIR"
    echo "  Install dir: $INSTALL_DIR"
    echo ""
    confirm "Proceed?" || error "Cancelled"
}

generate_config() {
    mkdir -p "$INSTALL_DIR" "$DATA_DIR"
    CONFIG_FILE="$INSTALL_DIR/agent.toml"
    cat > "$CONFIG_FILE" <<EOF
hub = "${hub_url}"
token = "${agent_token}"
name = "${agent_name}"
data_dir = "${DATA_DIR}"
EOF
    chmod 600 "$CONFIG_FILE"
    success "Config generated: $CONFIG_FILE"
}

install_files() {
    info "Installing to ${INSTALL_DIR}..."
    cp "$STAGE_DIR/agent" "$INSTALL_DIR/agent"
    chmod +x "$INSTALL_DIR/agent"
    success "Files installed"
}

print_summary() {
    echo ""
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Filebox Agent v${VERSION} installed!${NC}"
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  Install dir: ${INSTALL_DIR}"
    echo "  Config file: ${INSTALL_DIR}/agent.toml"
    echo ""
    echo "  Hub URL:     ${hub_url}"
    echo "  Agent name:  ${agent_name}"
    echo ""
    echo "  To run:"
    echo "    ${INSTALL_DIR}/agent"
    echo ""
    echo "  Background:"
    echo "    RUST_LOG=info nohup ${INSTALL_DIR}/agent > ${INSTALL_DIR}/agent.log 2>&1 &"
    echo ""
    echo "  Optional tuning (HPC with many processes):"
    echo "    FILEBOX_AGENT_STATS_TTL_SECS=30 ${INSTALL_DIR}/agent"
    echo ""
    echo "  Add root directories from the Hub frontend (Agent → Settings)."
    echo ""
}

# ── Run ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║ Filebox Agent - Release Installer      ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

if [[ -d "$INSTALL_DIR" ]]; then
    warn "Existing Filebox Agent installation detected at $INSTALL_DIR"
    confirm "Overwrite?" || error "Cancelled"
fi

collect_config
generate_config
install_files
print_summary
