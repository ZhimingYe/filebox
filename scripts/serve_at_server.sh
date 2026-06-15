#!/usr/bin/env bash
#
# Filebox Hub - Rootless install script
# Only handles config, build, and install. Running is up to you.
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

INSTALL_DIR="${FILEBOX_INSTALL_DIR:-$HOME/.local/share/filebox}"
CONFIG_DIR="$INSTALL_DIR/config"
LOG_DIR="$INSTALL_DIR/logs"
FRONTEND_DIR="$INSTALL_DIR/frontend"

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

confirm() {
    read -rp "$1 [y/N] " response
    case "$response" in
        [yY][eE][sS]|[yY]) return 0 ;;
        *) return 1 ;;
    esac
}

generate_token() {
    head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32
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

check_dependencies() {
    info "Checking dependencies..."
    local missing=()

    command -v cargo &>/dev/null || missing+=("Rust (cargo) — install from https://rustup.rs")

    if command -v node &>/dev/null; then
        local vn
        vn=$(node -v | sed 's/v//' | cut -d. -f1)
        [[ "$vn" -lt 18 ]] && missing+=("Node.js >= 18 (found: $(node -v))")
    else
        missing+=("Node.js >= 18 — install from https://nodejs.org")
    fi

    command -v npm &>/dev/null || missing+=("npm (usually bundled with Node.js)")

    if [[ ${#missing[@]} -gt 0 ]]; then
        error "Missing dependencies:\n$(printf '  - %s\n' "${missing[@]}")"
    fi

    # bcrypt — try import, install if missing, fail clearly if still missing
    if ! python3 -c "import bcrypt" 2>/dev/null; then
        info "Installing Python bcrypt module..."
        if pip3 install bcrypt 2>/dev/null; then
            success "bcrypt installed"
        elif pip3 install --user bcrypt 2>/dev/null; then
            success "bcrypt installed (user-local)"
        else
            error "Cannot install bcrypt. Run manually: pip3 install bcrypt"
        fi
    fi

    if ! python3 -c "import bcrypt" 2>/dev/null; then
        error "bcrypt module still not available after install. Run: pip3 install bcrypt"
    fi

    success "All dependencies satisfied"
}

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
        agent_token=$(generate_token)
    else
        while true; do
            read -rp "Enter agent token: " agent_token
            [[ -n "$agent_token" ]] && break
            warn "Token cannot be empty"
        done
    fi

    echo ""
    info "Configuration summary:"
    echo "  Listen port: $listen_port"
    echo "  Admin user:  $admin_user"
    echo "  Token:       $agent_token"
    echo ""
    confirm "Proceed?" || error "Cancelled"
}

generate_config() {
    info "Generating config file..."
    mkdir -p "$CONFIG_DIR"

    info "Generating password hashes (may take a few seconds)..."
    local pass_hash token_hash
    pass_hash=$(generate_bcrypt "$admin_pass")
    token_hash=$(generate_bcrypt "$agent_token")

    [[ -z "$pass_hash" ]] && error "Failed to generate password hash"
    [[ -z "$token_hash" ]] && error "Failed to generate token hash"

    # Verify hashes look like bcrypt
    [[ "$pass_hash" =~ ^\$2[aby]\$ ]] || error "Password hash does not look like bcrypt: $pass_hash"
    [[ "$token_hash" =~ ^\$2[aby]\$ ]] || error "Token hash does not look like bcrypt: $token_hash"

    cat > "$CONFIG_DIR/hub.json" <<EOF
{
  "listen_addr": "0.0.0.0:${listen_port}",
  "agent_token_hash": "${token_hash}",
  "users": [
    { "username": "${admin_user}", "password_hash": "${pass_hash}" }
  ]
}
EOF

    # Validate the JSON is parseable
    if command -v python3 &>/dev/null; then
        python3 -c "import json; json.load(open('$CONFIG_DIR/hub.json'))" 2>/dev/null \
            || error "Generated hub.json is not valid JSON"
    fi

    # Restrict permissions: hub.json contains password and token hashes
    chmod 600 "$CONFIG_DIR/hub.json"

    success "Config generated: $CONFIG_DIR/hub.json"
}

build_project() {
    info "Building project..."
    cd "$PROJECT_DIR"

    # Frontend
    info "Installing frontend dependencies..."
    (cd frontend && npm install --no-fund --no-audit) || error "npm install failed"
    info "Building frontend..."
    (cd frontend && npm run build) || error "Frontend build failed"
    [[ -d "frontend/dist" ]] || error "frontend/dist not found after build"

    # Backend
    info "Building backend (may take a few minutes)..."
    cargo build --release || error "Cargo build failed"
    [[ -f "target/release/hub" ]] || error "Hub binary not found after build"

    success "Build complete"
}

install_files() {
    info "Installing to $INSTALL_DIR..."

    # Clean old frontend if overwriting (must not be the source we're about to copy from)
    if [[ -d "$FRONTEND_DIR/dist" ]] && [[ "$FRONTEND_DIR" != "$PROJECT_DIR/frontend" ]]; then
        rm -rf "$FRONTEND_DIR/dist"
    fi

    mkdir -p "$INSTALL_DIR/bin" "$FRONTEND_DIR" "$LOG_DIR"

    cp "$PROJECT_DIR/target/release/hub" "$INSTALL_DIR/bin/hub"
    chmod +x "$INSTALL_DIR/bin/hub"

    # Copy frontend. Use source's basename to detect self-copy defensively.
    local src_dist="$PROJECT_DIR/frontend/dist"
    local dest_dist="$FRONTEND_DIR/dist"
    if [[ "$src_dist" == "$dest_dist" ]]; then
        error "Refusing to copy frontend/dist onto itself (source dir == install dir). Set FILEBOX_INSTALL_DIR to a different path."
    fi
    cp -r "$src_dist" "$FRONTEND_DIR/"

    # Verify install
    [[ -f "$INSTALL_DIR/bin/hub" ]] || error "Binary not installed correctly"
    [[ -f "$FRONTEND_DIR/dist/index.html" ]] || error "Frontend not installed correctly"

    info "Frontend path: $FRONTEND_DIR/dist"
    success "Files installed"
}

print_summary() {
    echo ""
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Filebox Hub installation complete!${NC}"
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  Install dir:  ${INSTALL_DIR}"
    echo "  Binary:       ${INSTALL_DIR}/bin/hub"
    echo "  Frontend:     ${FRONTEND_DIR}/dist"
    echo "  Config file:  ${CONFIG_DIR}/hub.json"
    echo "  Logs dir:     ${LOG_DIR}"
    echo ""
    echo "  Admin user:   ${admin_user}"
    echo "  Agent token:  ${agent_token}"
    echo ""
    echo "  To run:"
    echo "    ${INSTALL_DIR}/bin/hub"
    echo ""
    echo "  Background:"
    echo "    nohup ${INSTALL_DIR}/bin/hub > ${LOG_DIR}/hub.log 2>&1 &"
    echo ""
    echo "  Env vars (optional):"
    echo "    FILEBOX_CONFIG_PATH=<path>     Override config file location"
    echo "    FILEBOX_FRONTEND_DIR=<path>    Override frontend/dist location"
    echo "    FILEBOX_LISTEN_ADDR=<addr>     Override listen address"
    echo ""
    echo -e "${YELLOW}  Save the agent token -- you will need it when setting up Agents.${NC}"
    echo ""
}

main() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  Filebox Hub - Rootless Install Script ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
    echo ""

    # Refuse if install dir would be the same as the source dir (causes cp self-copy errors)
    if [[ "$INSTALL_DIR" == "$PROJECT_DIR" ]]; then
        error "INSTALL_DIR ($INSTALL_DIR) is the same as the source directory ($PROJECT_DIR).
This causes file copy failures. Pick a different install location:
    FILEBOX_INSTALL_DIR=\$HOME/.local/share/filebox ./scripts/serve_at_server.sh
Or clone the source elsewhere before running this script."
    fi

    if [[ -d "$INSTALL_DIR" ]]; then
        warn "Existing Filebox Hub installation detected at $INSTALL_DIR"
        confirm "Overwrite?" || error "Cancelled"
    fi

    check_dependencies
    collect_config
    generate_config
    build_project
    install_files
    print_summary
}

main "$@"
