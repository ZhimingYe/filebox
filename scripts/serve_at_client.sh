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

INSTALL_DIR="$HOME/filebox-agent"
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

collect_config() {
    info "Configuring Filebox Agent"
    echo ""

    while true; do
        read -rp "Hub server URL (e.g. https://filebox.example.com): " hub_url
        if [[ -n "$hub_url" ]]; then
            hub_url="${hub_url%/}"
            break
        fi
        warn "Hub URL cannot be empty"
    done

    while true; do
        read -rp "Agent token: " agent_token
        [[ -n "$agent_token" ]] && break
        warn "Token cannot be empty"
    done

    read -rp "Agent name [$(hostname)]: " agent_name
    agent_name=${agent_name:-$(hostname)}

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

    success "Config generated: $CONFIG_FILE"
}

get_binary() {
    info "Getting Agent binary..."

    echo ""
    echo "  Choose install method:"
    echo "  1) Download prebuilt from Hub (recommended)"
    echo "  2) Build locally (requires Rust toolchain)"
    echo ""
    read -rp "Select [1]: " choice
    choice=${choice:-1}

    case "$choice" in
        1) download_binary ;;
        2) build_binary ;;
        *) error "Invalid choice" ;;
    esac
}

download_binary() {
    info "Downloading Agent from Hub..."

    local arch
    arch=$(uname -m)
    case "$arch" in
        x86_64)  arch="x86_64" ;;
        aarch64) arch="aarch64" ;;
        *)       error "Unsupported architecture: $arch" ;;
    esac

    local os="unknown-linux-gnu"
    local url="${hub_url}/downloads/agent-${arch}-${os}"
    local temp_file="/tmp/filebox-agent-$$"

    info "Downloading: $url"
    if command -v curl &>/dev/null; then
        curl -fsSL "$url" -o "$temp_file" || error "Download failed"
    elif command -v wget &>/dev/null; then
        wget -q "$url" -O "$temp_file" || error "Download failed"
    else
        error "Need curl or wget"
    fi

    chmod +x "$temp_file"
    mv "$temp_file" "$INSTALL_DIR/agent"
    success "Download complete"
}

build_binary() {
    info "Building Agent locally..."

    command -v cargo &>/dev/null || error "Need Rust toolchain (cargo)"

    local project_dir
    project_dir=$(cd "$(dirname "$0")/.." && pwd)
    cd "$project_dir"

    info "Compiling (may take a few minutes)..."
    cargo build --release --bin agent 2>&1 | tail -3

    cp "$project_dir/target/release/agent" "$INSTALL_DIR/agent"
    chmod +x "$INSTALL_DIR/agent"
    success "Build complete"
}

install_files() {
    info "Installing to $INSTALL_DIR..."
    mkdir -p "$INSTALL_DIR" "$DATA_DIR"
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
    echo "    nohup ${INSTALL_DIR}/agent &"
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

    if [[ -d "$INSTALL_DIR" ]]; then
        warn "Existing Filebox Agent installation detected"
        confirm "Overwrite?" || error "Cancelled"
    fi

    collect_config
    generate_config
    get_binary
    install_files
    print_summary
}

main "$@"
