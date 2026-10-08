#!/bin/bash
# ------------------------------------------------------------------
# Container CMD for the Hermes relayer image.
#
# Waits until the launcher has uploaded a config and finished
# relayer-bringup (which touches $RELAYER_DIR/ready), then execs
# `hermes start`. Because the marker lives on the persistent /data
# volume, a container restart goes straight back to relaying without
# anyone SSHing in.
#
# Until then the container stays up with sshd + tailscale running (the
# entrypoint started them), so the launcher can reach it to upload.
# ------------------------------------------------------------------
set -euo pipefail

RELAYER_DIR="${RELAYER_DIR:-/data/relayer}"
CONFIG="$RELAYER_DIR/config.toml"

waited=0
until [ -f "$RELAYER_DIR/ready" ] && [ -f "$CONFIG" ]; do
    if [ $((waited % 300)) -eq 0 ]; then
        echo "relayer-run: waiting for $RELAYER_DIR/ready (run relayer-bringup first)"
    fi
    sleep 5
    waited=$((waited + 5))
done

echo "relayer-run: starting hermes with $CONFIG"
# Not exec: as the container's PID 1, hermes would ignore SIGTERM (the kernel
# drops signals PID 1 installs no handler for, and hermes installs none), so
# the launcher's `kill 1` after a relink did nothing and hermes kept relaying
# on the old config. Bash stays PID 1, forwards the signal and exits, and the
# container restart starts hermes on the new config.
hermes --config "$CONFIG" start &
child=$!
trap 'kill -TERM "$child" 2>/dev/null; wait "$child"; exit 143' TERM INT
wait "$child"
