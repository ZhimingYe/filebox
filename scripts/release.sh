#!/usr/bin/env bash
#
# Release helper. Bumps workspace version, commits, tags v{version}, pushes.
# Pushing the tag triggers .github/workflows/release.yml, which builds the
# musl binaries and publishes a GitHub Release.
#
# Usage:
#   scripts/release.sh v0.2.0
#   scripts/release.sh 0.2.0
#
# Requirements:
#   - clean working tree (no uncommitted changes)
#   - on main branch
#   - push access to origin

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <version>   (e.g., v0.2.0 or 0.2.0)"
    exit 1
fi

VERSION="${1#v}"  # strip leading v
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
    error "Invalid semver: '$VERSION' (expected X.Y.Z)"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Sanity checks
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[[ "$BRANCH" == "main" ]] || error "Not on main (currently on $BRANCH). Switch first."

if ! git diff --quiet || ! git diff --cached --quiet; then
    error "Working tree has uncommitted changes. Commit or stash first."
fi

CURRENT=$(awk '/^\[workspace\.package\]/{f=1} f&&/^version = /{gsub(/[" ]/,"",$3); print $3; exit}' Cargo.toml)
if [[ "$CURRENT" == "$VERSION" ]]; then
    warn "Cargo.toml already at v$VERSION"
fi

REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
[[ -n "$REMOTE" ]] || error "No 'origin' remote configured."

echo ""
info "Release plan:"
echo "  Current version: v${CURRENT}"
echo "  Target version:  v${VERSION}"
echo "  Remote:          ${REMOTE}"
echo "  Branch:          ${BRANCH}"
echo ""
read -rp "Proceed? [y/N] " response
case "$response" in
    [yY][eE][sS]|[yY]) ;;
    *) error "Cancelled" ;;
esac

# Bump [workspace.package] version. Use awk with section tracking so we only
# touch the version line under [workspace.package], not the many version =
# lines under [workspace.dependencies].
info "Bumping Cargo.toml..."
awk -v ver="$VERSION" '
    /^\[workspace\.package\]/ { in_pkg = 1; print; next }
    /^\[/                      { in_pkg = 0 }
    in_pkg && /^version = /    { print "version = \"" ver "\""; next }
    { print }
' Cargo.toml > Cargo.toml.new
mv Cargo.toml.new Cargo.toml

# Verify the bump took effect.
NEW=$(awk '/^\[workspace\.package\]/{f=1} f&&/^version = /{gsub(/[" ]/,"",$3); print $3; exit}' Cargo.toml)
[[ "$NEW" == "$VERSION" ]] || error "Bump failed: Cargo.toml reports v$NEW"

# Refresh Cargo.lock for the new workspace member versions. cargo check is the
# most reliable way; it's fast on a warm cache.
info "Updating Cargo.lock..."
cargo check --quiet --workspace 2>&1 | tail -3 || error "cargo check failed"

info "Committing..."
git add Cargo.toml Cargo.lock
git commit -m "Release v${VERSION}" >/dev/null

info "Tagging v${VERSION}..."
git tag "v${VERSION}"

info "Pushing main and tag..."
git push origin main
git push origin "v${VERSION}"

echo ""
echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  v${VERSION} pushed.${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Build status:"
echo "    https://github.com/ZhimingYe/filebox/actions"
echo ""
echo "  Release (once build completes):"
echo "    https://github.com/ZhimingYe/filebox/releases/tag/v${VERSION}"
echo ""
echo "  Install on target machines:"
echo "    curl -fsSL https://raw.githubusercontent.com/ZhimingYe/filebox/main/scripts/install_hub.sh   | bash"
echo "    curl -fsSL https://raw.githubusercontent.com/ZhimingYe/filebox/main/scripts/install_agent.sh | bash"
echo ""
