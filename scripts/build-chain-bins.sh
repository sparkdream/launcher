#!/usr/bin/env bash
# Build the devnet, testnet and mainnet sparkdreamd at the vendored chain
# version into .chain-bins/<version>/, where the conductor tests pick them up
# (apps/conductor/test/chain-bins.ts).
#
# The chain's parameter floors are build-tagged (since v1.0.56), so each
# network's reference genesis validates only under that network's build, and
# the test build a plain `make install` produces refuses all three.
#
# Usage: scripts/build-chain-bins.sh [path-to-chain-repo]
set -euo pipefail

CHAIN_REPO="${1:-${SPARKDREAM_CHAIN_REPO:-$HOME/cosmos/sparkdream/sparkdream}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INFO="$ROOT/packages/launch-spec/src/vendor-info.ts"
VERSION="$(sed -n 's/^export const VENDORED_CHAIN_VERSION = "\(.*\)";$/\1/p' "$INFO")"
COMMIT="$(sed -n 's/^export const VENDORED_CHAIN_COMMIT = "\([0-9a-f]*\).*";$/\1/p' "$INFO")"
OUT="$ROOT/.chain-bins/$VERSION"

if [ -z "$VERSION" ] || [ -z "$COMMIT" ]; then
  echo "error: cannot read the vendored version and commit from $INFO" >&2
  exit 1
fi
if ! git -C "$CHAIN_REPO" cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
  echo "error: $CHAIN_REPO has no commit $COMMIT (the vendored $VERSION): pass the chain repo path, or fetch it" >&2
  exit 1
fi

# build the vendored commit itself, not whatever the chain repo has checked out
SRC="$(mktemp -d)"
trap 'rm -rf "$SRC"' EXIT
git -C "$CHAIN_REPO" archive "$COMMIT" | tar -x -C "$SRC"

mkdir -p "$OUT"
for net in devnet testnet mainnet; do
  echo "building sparkdreamd $VERSION ($net) at ${COMMIT:0:12}"
  (cd "$SRC" && go build -mod=readonly -tags "$net" -ldflags "\
    -X github.com/cosmos/cosmos-sdk/version.Name=sparkdream \
    -X github.com/cosmos/cosmos-sdk/version.AppName=sparkdreamd \
    -X github.com/cosmos/cosmos-sdk/version.Version=$VERSION \
    -X github.com/cosmos/cosmos-sdk/version.Commit=$COMMIT \
    -X github.com/cosmos/cosmos-sdk/version.BuildTags=$net" \
    -o "$OUT/sparkdreamd-$net" ./cmd/sparkdreamd)
done
echo "wrote $OUT"
