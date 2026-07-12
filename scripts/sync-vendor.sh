#!/usr/bin/env bash
# Sync deploy templates and SDLs from the chain repo into vendor/.
# Usage: scripts/sync-vendor.sh [path-to-chain-repo]
set -euo pipefail

CHAIN_REPO="${1:-${SPARKDREAM_CHAIN_REPO:-$HOME/cosmos/sparkdream/sparkdream}}"
SRC="$CHAIN_REPO/deploy/config"
MESH="$CHAIN_REPO/deploy/mesh"
DEST="$(cd "$(dirname "$0")/.." && pwd)/vendor/sparkdream-deploy"

if [ ! -d "$SRC/template" ]; then
  echo "error: $SRC/template not found — pass the chain repo path" >&2
  exit 1
fi

mkdir -p "$DEST"
rsync -a --delete \
  --include='template/***' \
  --include='network/' \
  --include='network/*/' \
  --include='network/*/chain.env' \
  --include='network/*/genesis.json' \
  --include='network/*/*.sdl.yaml' \
  --exclude='*' \
  "$SRC/" "$DEST/"
rsync -a --delete \
  --include='*.yaml' --include='*.yml' --include='*.sh' \
  --exclude='*' \
  "$MESH/" "$DEST/mesh/"

{
  echo "# Synced from the SparkDream chain repo — do not edit by hand."
  echo "# Source: deploy/config in the chain repo"
  echo "# Commit: $(git -C "$CHAIN_REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
} > "$DEST/SYNC_INFO"

echo "vendored into $DEST:"
find "$DEST" -type f | sort
