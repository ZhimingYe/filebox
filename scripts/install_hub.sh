#!/usr/bin/env bash
#
# Filebox Hub - Install from GitHub Release (no Rust toolchain needed).
#
# Downloads the pre-built static musl x86_64 tarball, extracts it, and runs
# the same interactive config flow as serve_at_server.sh (port, admin user,
# bcrypt-hashed password, agent token).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ZhimingYe/filebox/main/scripts/install_hub.sh | bash
#   curl -fsSL ... | bash -s -- --version v0.2.0
#   bash install_hub.sh --version 0.2.0 --install-dir /opt/filebox
#
# Supported target: Linux x86_64 (musl static binary). Other platforms
# fall back to build-from-source via serve_at_server.sh.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

REPO="ZhimingYe/filebox"
VERSION=""
INSTALL_DIR="${FILEBOX_INSTALL_DIR:-$HOME/.local/share/filebox}"

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
        --help|-h)
            cat <<EOF
Usage: $0 [options]
  --version <v>          Specific release version (e.g. v0.2.0 or 0.2.0).
                          Default: latest.
  --install-dir <path>   Install directory. Default: \$HOME/.local/share/filebox
                          (override with \$FILEBOX_INSTALL_DIR).
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
    error "Unsupported platform: $OS/$ARCH. This installer ships Linux x86_64 (musl) only. Use scripts/serve_at_server.sh to build from source."
fi

command -v curl >/dev/null   || error "Missing: curl"
command -v tar >/dev/null    || error "Missing: tar"
command -v python3 >/dev/null || error "Missing: python3 (needed for bcrypt hashing)"

# ── Resolve version ──────────────────────────────────────────────────────
if [[ -z "$VERSION" ]]; then
    info "Looking up latest release..."
    VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | python3 -c "import sys, json; print(json.load(sys.stdin)['tag_name'])")
fi
VERSION="${VERSION#v}"
info "Installing filebox hub v${VERSION}"

# ── Download ─────────────────────────────────────────────────────────────
TARBALL="filebox-hub-${VERSION}-x86_64-musl.tar.gz"
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
STAGE_DIR="$TMPDIR/filebox-hub-${VERSION}-x86_64-musl"
[[ -f "$STAGE_DIR/bin/hub" ]] || error "Tarball missing bin/hub"
[[ -d "$STAGE_DIR/frontend/dist" ]] || error "Tarball missing frontend/dist"

# ── Interactive config ───────────────────────────────────────────────────
collect_config() {
    info "Configuring Filebox Hub"
    echo ""

    # Port
    while true; do
        read -rp "Listen port [3000]: " listen_port
        listen_port=${listen_port:-3000}
        if [[ "$listen_port" =~ ^[0-9]+$ ]] && (( listen_port >= 1 && listen_port <= 65535 )); then
            break
        fi
        warn "Port must be a number between 1 and 65535"
    done

    # Username
    read -rp "Admin username [admin]: " admin_user
    admin_user=${admin_user:-admin}
    [[ -z "$admin_user" ]] && error "Username cannot be empty"

    # Password
    while true; do
        read -rs -p "Admin password: " admin_pass; echo ""
        [[ -z "$admin_pass" ]] && { warn "Password cannot be empty"; continue; }
        read -rs -p "Confirm password: " admin_pass2; echo ""
        [[ "$admin_pass" == "$admin_pass2" ]] && break
        warn "Passwords do not match, try again"
    done

    # Agent token
    echo ""
    if confirm "Auto-generate agent token? (recommended)"; then
        agent_token=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
    else
        while true; do
            read -rp "Enter agent token: " agent_token
            [[ -n "$agent_token" ]] && break
            warn "Token cannot be empty"
        done
    fi

    echo ""
    info "Configuration summary:"
    echo "  Install dir:  ${INSTALL_DIR}"
    echo "  Listen port:  ${listen_port}"
    echo "  Admin user:   ${admin_user}"
    echo "  Token:        ${agent_token}"
    echo ""
    confirm "Proceed?" || error "Cancelled"
}

generate_bcrypt() {
    local input="$1"
    local hash
    if hash=$(python3 -c "
import bcrypt, sys
p = sys.argv[1].encode('utf-8')
print(bcrypt.hashpw(p, bcrypt.gensalt(rounds=12)).decode('utf-8'))
" "$input" 2>&1); then
        echo "$hash"
    else
        error "Failed to generate bcrypt hash: $hash"
    fi
}

generate_config() {
    info "Generating password hashes (may take a few seconds)..."
    local pass_hash token_hash
    pass_hash=$(generate_bcrypt "$admin_pass")
    token_hash=$(generate_bcrypt "$agent_token")

    [[ "$pass_hash" =~ ^\$2[aby]\$ ]] || error "Password hash does not look like bcrypt: $pass_hash"
    [[ "$token_hash" =~ ^\$2[aby]\$ ]] || error "Token hash does not look like bcrypt: $token_hash"

    CONFIG_DIR="$INSTALL_DIR/config"
    LOG_DIR="$INSTALL_DIR/logs"
    FRONTEND_DIR="$INSTALL_DIR/frontend"
    mkdir -p "$CONFIG_DIR" "$LOG_DIR" "$FRONTEND_DIR"

    cat > "$CONFIG_DIR/hub.json" <<EOF
{
  "listen_addr": "0.0.0.0:${listen_port}",
  "agent_token_hash": "${token_hash}",
  "users": [
    { "username": "${admin_user}", "password_hash": "${pass_hash}" }
  ]
}
EOF

    # Validate JSON
    python3 -c "import json; json.load(open('$CONFIG_DIR/hub.json'))" 2>/dev/null \
        || error "Generated hub.json is not valid JSON"

    chmod 600 "$CONFIG_DIR/hub.json"
    success "Config generated: $CONFIG_DIR/hub.json"
}

install_files() {
    info "Installing to ${INSTALL_DIR}..."
    mkdir -p "$INSTALL_DIR/bin"

    # Clean old frontend (must not be the source we're about to copy from)
    if [[ -d "$FRONTEND_DIR/dist" ]]; then
        rm -rf "$FRONTEND_DIR/dist"
    fi

    cp "$STAGE_DIR/bin/hub" "$INSTALL_DIR/bin/hub"
    chmod +x "$INSTALL_DIR/bin/hub"
    cp -r "$STAGE_DIR/frontend/dist" "$FRONTEND_DIR/"

    [[ -f "$INSTALL_DIR/bin/hub" ]] || error "Binary not installed correctly"
    [[ -f "$FRONTEND_DIR/dist/index.html" ]] || error "Frontend not installed correctly"

    success "Files installed"
}

print_summary() {
    echo ""
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Filebox Hub v${VERSION} installed!${NC}"
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  Install dir:  ${INSTALL_DIR}"
    echo "  Binary:       ${INSTALL_DIR}/bin/hub"
    echo "  Frontend:     ${FRONTEND_DIR}/dist"
    echo "  Config file:  ${INSTALL_DIR}/config/hub.json"
    echo "  Logs dir:     ${INSTALL_DIR}/logs"
    echo ""
    echo "  Admin user:   ${admin_user}"
    echo "  Agent token:  ${agent_token}"
    echo ""
    echo "  To run:"
    echo "    ${INSTALL_DIR}/bin/hub"
    echo ""
    echo "  Background:"
    echo "    RUST_LOG=info nohup ${INSTALL_DIR}/bin/hub > ${INSTALL_DIR}/logs/hub.log 2>&1 &"
    echo ""
    echo "  Configure your Agent (on the agent host) with this token."
    echo ""
    echo -e "${YELLOW}  Save the agent token -- you will need it when setting up Agents.${NC}"
    echo ""
}

# ── Run ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Filebox Hub - Release Installer       ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

if [[ -d "$INSTALL_DIR" ]]; then
    warn "Existing Filebox Hub installation detected at $INSTALL_DIR"
    confirm "Overwrite?" || error "Cancelled"
fi

collect_config
generate_config
install_files
print_summary
