#!/bin/bash
# ------------------------------------------------------------------
# Open (or find) the IBC clients, connections and channels for every
# path in $RELAYER_DIR/relayer.json, and write their ids to
# $RELAYER_DIR/channels.json.
#
# This is the containerised, multi-path generalisation of
# deploy/relayer/bringup.sh. One Hermes process relays any number of
# paths; each path is one channel between two chains on one port:
#
#   {
#     "chains": [ {"id": "sparkdream-dev-1", "hd_path": "m/44'/118'/0'/0/0"}, ... ],
#     "paths":  [ {"id": "fed-test", "a": "sparkdream-dev-1", "b": "sparkdream-test-1",
#                  "port": "federation", "version": "federation-1", "order": "unordered"},
#                 {"id": "xfer-osmo", "a": "sparkdream-dev-1", "b": "osmo-test-5",
#                  "port": "transfer", "version": "ics20-1", "order": "unordered"} ]
#   }
#
# A transfer path and a federation path are the same thing to this
# script; only port and version differ. Two paths between the same pair
# of chains share one client pair and one connection, which is what
# x/federation expects (both channels ride one connection).
#
# Idempotent: `hermes create ...` is not, so every create is guarded by a
# query and skipped when an OPEN object already exists. Re-running after
# a transient failure, or after a container restart, reuses what is on
# chain rather than opening a second client/connection/channel.
#
# Keys: any $RELAYER_DIR/mnemonics/<chain-id>.mnemonic is imported into
# the Hermes key store (on the persistent volume) and then deleted, so
# the plaintext mnemonic does not outlive the import.
#
# Flags:
#   --keys-only  import waiting mnemonics and exit (run relayer-fundcheck
#                next: a key must be funded before it can open anything)
#   --start      touch $RELAYER_DIR/ready on success, so relayer-run execs
#                `hermes start`. Without it the caller can re-upload a config
#                pinned to the discovered channels first, then touch ready.
#
# Output: human-readable progress on stderr; channels.json on success.
# Exit non-zero on any failure, with the reason on stderr.
# ------------------------------------------------------------------
set -euo pipefail

RELAYER_DIR="${RELAYER_DIR:-/data/relayer}"
CONFIG="$RELAYER_DIR/config.toml"
MANIFEST="$RELAYER_DIR/relayer.json"
OUT="$RELAYER_DIR/channels.json"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
CREATE_TIMEOUT="${CREATE_TIMEOUT:-300}"
DEFAULT_HD_PATH="m/44'/118'/0'/0/0"

START=0
KEYS_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --start) START=1 ;;
        --keys-only) KEYS_ONLY=1 ;;
        *) echo "unknown flag: $arg" >&2; exit 2 ;;
    esac
done

log() { echo "$*" >&2; }
die() { echo "ERROR: $*" >&2; exit 1; }

[ -f "$CONFIG" ] || die "no hermes config at $CONFIG"
[ -f "$MANIFEST" ] || die "no path manifest at $MANIFEST"

hc() { hermes --config "$CONFIG" "$@"; }

# Run a hermes query with --json and print its .result. Hermes interleaves
# JSON log lines with the result line; the result is the one carrying
# "status". Prints nothing (and returns 1) on anything but success.
hj() {
    local line
    line=$(hermes --json --config "$CONFIG" "$@" 2>/dev/null \
        | jq -c 'select(type == "object" and has("status"))' 2>/dev/null | tail -1)
    [ -n "$line" ] || return 1
    [ "$(jq -r '.status' <<<"$line")" = "success" ] || return 1
    jq -c '.result' <<<"$line"
}

# Channel/connection ids are "<prefix>-<n>"; sort numerically so every run
# picks the same one when a duplicate from an earlier run exists (IBC
# objects cannot be deleted, so duplicates stay around but are ignored).
lowest() { sort -t- -k2,2n | head -1; }

# ------------------------------------------------------------------
# 0. Keys
# ------------------------------------------------------------------
if [ -d "$RELAYER_DIR/mnemonics" ]; then
    for f in "$RELAYER_DIR"/mnemonics/*.mnemonic; do
        [ -e "$f" ] || continue
        chain=$(basename "$f" .mnemonic)
        hd=$(jq -r --arg c "$chain" '.chains[] | select(.id == $c) | .hd_path // empty' "$MANIFEST")
        log "=== importing relayer key for $chain ==="
        hc keys add --chain "$chain" --mnemonic-file "$f" --hd-path "${hd:-$DEFAULT_HD_PATH}" --overwrite >&2 \
            || die "key import failed for $chain"
        rm -f "$f"
    done
fi
[ "$KEYS_ONLY" -eq 1 ] && exit 0

# ------------------------------------------------------------------
# 1. Health. An unreachable grpc_addr makes hermes hang forever with no
#    error, so the timeout is the only way to see it.
# ------------------------------------------------------------------
log "=== health check (timeout ${HEALTH_TIMEOUT}s) ==="
set +e
timeout "$HEALTH_TIMEOUT" hermes --config "$CONFIG" health-check >&2
rc=$?
set -e
if [ "$rc" -eq 124 ]; then
    die "health-check timed out: a grpc_addr is unreachable (hermes dials it forever). Check the mesh tunnels."
elif [ "$rc" -ne 0 ]; then
    die "health-check failed (exit $rc)"
fi

# ------------------------------------------------------------------
# Object lookups
# ------------------------------------------------------------------
# rpc_addr of chain $1 in the Hermes config.
rpc_of() {
    awk -v id="$1" '
        /^\[\[chains\]\]/ { here = 0 }
        /^id *=/ { v = $0; sub(/^id *= */, "", v); gsub(/['\''"]/, "", v); here = (v == id) }
        here && /^rpc_addr *=/ { v = $0; sub(/^rpc_addr *= */, "", v); gsub(/['\''"]/, "", v); print v; exit }
    ' "$CONFIG"
}

# Whether client $2 on $1 still tracks chain $3 as it is now. A chain reset
# keeps the chain id, so a client of the pre-reset chain matches $3 by id
# yet can never be updated again (2026-10-08: a reset devnet's relink reused
# Osmosis' client of the old chain and died on "missing trusted state
# smaller than target height"). Its latest trusted state must be a block
# the chain has now: a height it has reached, at the same time. Anything
# the check cannot read (a pruned height, an RPC hiccup) keeps the client,
# since a needless new client opens a second connection and channel.
client_is_current() {
    local host=$1 client=$2 ref=$3 h rpc tip cs_ts blk_ts
    h=$(hj query client state --chain "$host" --client "$client" \
        | jq -r '.latest_height.revision_height // empty') || return 0
    rpc=$(rpc_of "$ref")
    [ -n "$h" ] && [ -n "$rpc" ] || return 0
    tip=$(curl -fsS -m 15 "$rpc/status" | jq -r '.result.sync_info.latest_block_height // empty') || return 0
    [ -n "$tip" ] || return 0
    [ "$h" -le "$tip" ] || return 1
    cs_ts=$(hj query client consensus --chain "$host" --client "$client" --consensus-height "$h" \
        | jq -r '.timestamp // empty') || return 0
    blk_ts=$(curl -fsS -m 15 "$rpc/block?height=$h" | jq -r '.result.block.header.time // empty') || return 0
    [ -n "$cs_ts" ] && [ -n "$blk_ts" ] || return 0
    # same second: the two sides print different numbers of nanosecond digits
    [ "${cs_ts:0:19}" = "${blk_ts:0:19}" ]
}

# Lowest client on $1 tracking chain $2 as it is now (client_is_current).
find_client() {
    local c
    for c in $(hj query clients --host-chain "$1" --reference-chain "$2" --omit-chain-ids \
            | jq -r '.[]? | if type == "object" then (.client_id // .ClientId // empty) else . end' 2>/dev/null \
            | sort -t- -k2,2n); do
        if client_is_current "$1" "$c" "$2"; then
            echo "$c"
            return 0
        fi
        log "  ignoring $1/$c: it tracks an earlier $2 (the chain was reset since)"
    done
}

# Lowest OPEN connection on $1 over client $2 whose counterparty client is $3.
find_connection() {
    local chain=$1 client=$2 cp_client=$3 conn end
    for conn in $(hj query client connections --chain "$chain" --client "$client" | jq -r '.[]?' | sort -t- -k2,2n); do
        end=$(hj query connection end --chain "$chain" --connection "$conn") || continue
        if [ "$(jq -r '.state' <<<"$end")" = "Open" ] \
            && [ "$(jq -r '.counterparty.client_id' <<<"$end")" = "$cp_client" ]; then
            echo "$conn"
            return 0
        fi
    done
}

# Lowest OPEN channel on $1 over connection $2 bound to port $3 with version $4.
find_channel() {
    local chain=$1 conn=$2 port=$3 version=$4 ch end
    for ch in $(hj query connection channels --chain "$chain" --connection "$conn" \
            | jq -r --arg p "$port" '.[]? | select(.port_id == $p) | .channel_id' | sort -t- -k2,2n); do
        end=$(hj query channel end --chain "$chain" --port "$port" --channel "$ch") || continue
        if [ "$(jq -r '.state' <<<"$end")" = "Open" ] && [ "$(jq -r '.version' <<<"$end")" = "$version" ]; then
            echo "$ch"
            return 0
        fi
    done
}

create() {  # run a hermes create with a hard timeout, surface its tail on failure
    local out rc
    set +e
    out=$(timeout "$CREATE_TIMEOUT" hermes --config "$CONFIG" create "$@" 2>&1)
    rc=$?
    set -e
    echo "$out" | tail -5 >&2
    [ "$rc" -eq 0 ] || die "hermes create $* failed (exit $rc)"
}

# ------------------------------------------------------------------
# 2. Per path: clients -> connection -> channel
# ------------------------------------------------------------------
results="[]"
npaths=$(jq '.paths | length' "$MANIFEST")
for i in $(seq 0 $((npaths - 1))); do
    p=$(jq -c ".paths[$i]" "$MANIFEST")
    id=$(jq -r '.id' <<<"$p")
    a=$(jq -r '.a' <<<"$p")
    b=$(jq -r '.b' <<<"$p")
    port=$(jq -r '.port' <<<"$p")
    version=$(jq -r '.version' <<<"$p")
    order=$(jq -r '.order // "unordered"' <<<"$p")
    log ""
    log "=== path $id: $a <-> $b on $port ($version) ==="

    for pair in "$a $b" "$b $a"; do
        set -- $pair
        if [ -z "$(find_client "$1" "$2")" ]; then
            log "  creating client on $1 tracking $2"
            create client --host-chain "$1" --reference-chain "$2"
        fi
    done
    client_a=$(find_client "$a" "$b")
    client_b=$(find_client "$b" "$a")
    [ -n "$client_a" ] && [ -n "$client_b" ] || die "path $id: clients not found after create"
    log "  clients: $a/$client_a  $b/$client_b"

    conn_a=$(find_connection "$a" "$client_a" "$client_b")
    if [ -z "$conn_a" ]; then
        log "  creating connection"
        create connection --a-chain "$a" --a-client "$client_a" --b-client "$client_b"
        conn_a=$(find_connection "$a" "$client_a" "$client_b")
    fi
    [ -n "$conn_a" ] || die "path $id: no open connection after create"
    conn_b=$(find_connection "$b" "$client_b" "$client_a")
    [ -n "$conn_b" ] || die "path $id: connection $conn_a has no open counterparty on $b"
    log "  connections: $a/$conn_a  $b/$conn_b"

    chan_a=$(find_channel "$a" "$conn_a" "$port" "$version")
    if [ -z "$chan_a" ]; then
        log "  creating channel"
        create channel --a-chain "$a" --a-connection "$conn_a" \
            --a-port "$port" --b-port "$port" --channel-version "$version" --order "$order"
        chan_a=$(find_channel "$a" "$conn_a" "$port" "$version")
    fi
    [ -n "$chan_a" ] || die "path $id: no open $port channel after create"
    chan_b=$(hj query channel end --chain "$a" --port "$port" --channel "$chan_a" \
        | jq -r '.remote.channel_id // empty')
    [ -n "$chan_b" ] || die "path $id: channel $chan_a has no counterparty id"
    log "  channels: $a/$chan_a  $b/$chan_b"

    results=$(jq -c \
        --arg id "$id" --arg a "$a" --arg b "$b" --arg port "$port" --arg version "$version" \
        --arg ca "$client_a" --arg cb "$client_b" --arg na "$conn_a" --arg nb "$conn_b" \
        --arg ha "$chan_a" --arg hb "$chan_b" \
        '. + [{id: $id, port: $port, version: $version,
               a: {chain: $a, client: $ca, connection: $na, channel: $ha},
               b: {chain: $b, client: $cb, connection: $nb, channel: $hb}}]' <<<"$results")
done

jq . <<<"$results" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
log ""
log "=== wrote $OUT ==="
if [ "$START" -eq 1 ]; then
    touch "$RELAYER_DIR/ready"
    log "=== touched $RELAYER_DIR/ready: relayer-run will start hermes ==="
fi
cat "$OUT"
