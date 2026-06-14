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
    # Check download tools
    if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
        error "Need curl or wget to download. Install one and retry."
    fi

    local arch
    arch=$(uname -m)
    case "$arch" in
        x86_64)  arch="x86_64" ;;
        aarch64) arch="aarch64" ;;
        arm64)   arch="aarch64" ;;  # macOS Apple Silicon
        *)       error "Unsupported architecture: $arch" ;;
    esac

    local os
    case "$(uname -s)" in
        Linux*)  os="unknown-linux-gnu" ;;
        Darwin*) os="apple-darwin" ;;
        *)       error "Unsupported OS: $(uname -s)" ;;
    esac

    local url="${hub_url}/downloads/agent-${arch}-${os}"
    local temp_file
    temp_file=$(mktemp /tmp/filebox-agent-XXXXXX)

    info "Downloading: $url"
    if command -v curl &>/dev/null; then
        curl -fsSL "$url" -o "$temp_file" || { rm -f "$temp_file"; error "Download failed (curl)"; }
    else
        wget -q "$url" -O "$temp_file" || { rm -f "$temp_file"; error "Download failed (wget)"; }
    fi

    # Basic sanity check — file should be non-empty and executable-looking
    if [[ ! -s "$temp_file" ]]; then
        rm -f "$temp_file"
        error "Downloaded file is empty. Check the Hub URL and try again."
    fi

    chmod +x "$temp_file"
    mv "$temp_file" "$INSTALL_DIR/agent"
    success "Download complete"
}

build_binary() {
    command -v cargo &>/dev/null || error "Need Rust toolchain (cargo). Install from https://rustup.rs"

    cd "$PROJECT_DIR"

    info "Compiling agent (may take a few minutes)..."
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
    echo "    nohup ${INSTALL_DIR}/agent > ${INSTALL_DIR}/agent.log 2>&1 &"
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
        warn "Existing Filebox Agent installation detected at $INSTALL_DIR"
        confirm "Overwrite?" || error "Cancelled"
    fi

    collect_config
    generate_config
    get_binary
    install_files
    print_summary
}

main "$@"
