#!/usr/bin/env bash
#
# Filebox Agent - Rootless install script
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

INSTALL_DIR="${FILEBOX_INSTALL_DIR:-$HOME/filebox-agent}"
CONFIG_FILE="$INSTALL_DIR/agent.toml"
DATA_DIR="$INSTALL_DIR/data"

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

check_dependencies() {
    info "Checking dependencies..."
    command -v cargo &>/dev/null \
        || error "Missing: Rust (cargo) — install from https://rustup.rs"
    success "All dependencies satisfied"
}

collect_config() {
    info "Configuring Filebox Agent"
    echo ""

    # Hub URL
    while true; do
        read -rp "Hub server URL (e.g. https://filebox.example.com): " hub_url
        hub_url="${hub_url%/}"
        if [[ "$hub_url" =~ ^https?:// ]]; then
            break
        fi
        warn "URL must start with http:// or https://"
    done

    # Token
    while true; do
        read -rp "Agent token: " agent_token
        [[ -n "$agent_token" ]] && break
        warn "Token cannot be empty"
    done

    # Name
    read -rp "Agent name [$(hostname)]: " agent_name
    agent_name=${agent_name:-$(hostname)}

    # Data dir
    read -rp "Data directory [${DATA_DIR}]: " custom_data_dir
    [[ -n "$custom_data_dir" ]] && DATA_DIR="$custom_data_dir"

    echo ""
    info "Configuration summary:"
    echo "  Hub URL:     $hub_url"
    echo "  Token:       $agent_token"
    echo "  Name:        $agent_name"
    echo "  Data dir:    $DATA_DIR"
    echo ""
    confirm "Proceed?" || error "Cancelled"
}

generate_config() {
    info "Generating config file..."
    mkdir -p "$INSTALL_DIR"

    cat > "$CONFIG_FILE" <<EOF
hub = "${hub_url}"
token = "${agent_token}"
name = "${agent_name}"
data_dir = "${DATA_DIR}"
EOF

    # Restrict permissions: agent.toml contains the agent token
    chmod 600 "$CONFIG_FILE"

    success "Config generated: $CONFIG_FILE"
}

get_binary() {
    build_binary
}

build_binary() {
    info "Compiling agent (may take a few minutes)..."
    cd "$PROJECT_DIR"
    cargo build --release --bin agent || error "Cargo build failed"
    [[ -f "$PROJECT_DIR/target/release/agent" ]] || error "Agent binary not found after build"

    cp "$PROJECT_DIR/target/release/agent" "$INSTALL_DIR/agent"
    chmod +x "$INSTALL_DIR/agent"
    success "Build complete"
}

install_files() {
    info "Installing to $INSTALL_DIR..."
    mkdir -p "$INSTALL_DIR" "$DATA_DIR"

    [[ -f "$INSTALL_DIR/agent" ]] || error "Agent binary not found. Download or build step may have failed."

    success "Files installed"
}

print_summary() {
    echo ""
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Filebox Agent installation complete!${NC}"
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  Install dir: ${INSTALL_DIR}"
    echo "  Config file: ${CONFIG_FILE}"
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
    echo "  Add root directories:"
    echo "    1. Open the Hub frontend"
    echo "    2. Select this Agent"
    echo "    3. Go to Settings"
    echo "    4. Add directories to browse"
    echo ""
}

main() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║ Filebox Agent - Rootless Install Script║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
    echo ""

    # Refuse if install dir would be the same as the source dir
    if [[ "$INSTALL_DIR" == "$PROJECT_DIR" ]]; then
        error "INSTALL_DIR ($INSTALL_DIR) is the same as the source directory ($PROJECT_DIR).
Set FILEBOX_INSTALL_DIR to a different path, or clone the source elsewhere."
    fi

    if [[ -d "$INSTALL_DIR" ]]; then
        warn "Existing Filebox Agent installation detected at $INSTALL_DIR"
        confirm "Overwrite?" || error "Cancelled"
    fi

    check_dependencies
    collect_config
    generate_config
    get_binary
    install_files
    print_summary
}

main "$@"
