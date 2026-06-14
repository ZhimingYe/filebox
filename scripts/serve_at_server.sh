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

INSTALL_DIR="$HOME/filebox"
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
    if command -v python3 &>/dev/null; then
        python3 -c "
import bcrypt, sys
p = sys.argv[1].encode('utf-8')
print(bcrypt.hashpw(p, bcrypt.gensalt(rounds=12)).decode('utf-8'))
" "$input"
    elif command -v htpasswd &>/dev/null; then
        htpasswd -nbBC 12 "" "$input" | cut -d: -f2
    else
        error "Need python3+bcrypt or htpasswd to generate password hashes"
    fi
}

check_dependencies() {
    info "Checking dependencies..."
    local missing=()

    command -v cargo &>/dev/null || missing+=("Rust (cargo)")

    if command -v node &>/dev/null; then
        local vn
        vn=$(node -v | sed 's/v//' | cut -d. -f1)
        [[ "$vn" -lt 18 ]] && missing+=("Node.js >= 18 (found: $(node -v))")
    else
        missing+=("Node.js")
    fi

    command -v npm &>/dev/null || missing+=("npm")
    command -v python3 &>/dev/null || missing+=("Python 3")

    if ! python3 -c "import bcrypt" 2>/dev/null; then
        warn "Python bcrypt module not found, attempting install..."
        pip3 install --user bcrypt 2>/dev/null || error "Cannot install bcrypt. Run: pip3 install bcrypt"
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        error "Missing dependencies:\n$(printf '  - %s\n' "${missing[@]}")"
    fi
    success "All dependencies satisfied"
}

collect_config() {
    info "Configuring Filebox Hub"
    echo ""

    read -rp "Listen port [3000]: " listen_port
    listen_port=${listen_port:-3000}

    read -rp "Admin username [admin]: " admin_user
    admin_user=${admin_user:-admin}

    while true; do
        read -rs -p "Admin password: " admin_pass; echo ""
        read -rs -p "Confirm password: " admin_pass2; echo ""
        [[ "$admin_pass" == "$admin_pass2" ]] && break
        warn "Passwords do not match, try again"
    done
    [[ -z "$admin_pass" ]] && error "Password cannot be empty"

    echo ""
    if confirm "Auto-generate agent token? (recommended)"; then
        agent_token=$(generate_token)
        info "Generated token: $agent_token"
    else
        read -rp "Enter agent token: " agent_token
    fi
    [[ -z "$agent_token" ]] && error "Token cannot be empty"

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

    cat > "$CONFIG_DIR/hub.json" <<EOF
{
  "listen_addr": "0.0.0.0:${listen_port}",
  "agent_token_hash": "${token_hash}",
  "users": [
    { "username": "${admin_user}", "password_hash": "${pass_hash}" }
  ]
}
EOF

    success "Config generated: $CONFIG_DIR/hub.json"
}

build_project() {
    info "Building project..."
    local project_dir
    project_dir=$(cd "$(dirname "$0")/.." && pwd)
    cd "$project_dir"

    info "Building frontend..."
    cd frontend
    npm install --no-fund --no-audit 2>&1 | tail -1
    npm run build 2>&1 | tail -3
    cd ..

    info "Building backend (may take a few minutes)..."
    cargo build --release 2>&1 | tail -3

    success "Build complete"
}

install_files() {
    info "Installing to $INSTALL_DIR..."
    local project_dir
    project_dir=$(cd "$(dirname "$0")/.." && pwd)

    mkdir -p "$INSTALL_DIR/bin" "$FRONTEND_DIR" "$LOG_DIR"

    cp "$project_dir/target/release/hub" "$INSTALL_DIR/bin/"
    chmod +x "$INSTALL_DIR/bin/hub"

    cp -r "$project_dir/frontend/dist" "$FRONTEND_DIR/"

    success "Files installed"
}

print_summary() {
    echo ""
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Filebox Hub installation complete!${NC}"
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  Install dir: ${INSTALL_DIR}"
    echo "  Config file: ${CONFIG_DIR}/hub.json"
    echo "  Frontend:    ${FRONTEND_DIR}/dist/"
    echo ""
    echo "  Admin user:  ${admin_user}"
    echo "  Agent token: ${agent_token}"
    echo ""
    echo "  To run:"
    echo "    FILEBOX_CONFIG_PATH=${CONFIG_DIR}/hub.json ${INSTALL_DIR}/bin/hub"
    echo ""
    echo "  Background:"
    echo "    FILEBOX_CONFIG_PATH=${CONFIG_DIR}/hub.json nohup ${INSTALL_DIR}/bin/hub &"
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

    if [[ -d "$INSTALL_DIR" ]]; then
        warn "Existing Filebox Hub installation detected"
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
