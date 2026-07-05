#!/bin/sh
# fix-tailscale.sh — Restart the Tailscale daemon inside an Akash container.
#
# Use this when tailscaled has become unresponsive or disconnected from the
# Headscale coordination server. It removes the stale Unix socket and starts
# a fresh tailscaled process that reuses the existing state file (preserving
# the node identity and stable Tailscale IP).
#
# Prerequisites:
#   - Must be run inside the Akash container (via SSH or Akash shell)
#   - HEADSCALE_URL and TS_AUTHKEY env vars must be set (they are in the SDL)
#
# IMPORTANT: Do NOT uncomment the tailscaled.state removal line unless you
# want a completely fresh registration. Deleting the state file causes
# Headscale to assign a new IP, which requires updating persistent_peers
# and TMKMS config on all other nodes.
#
# Usage:
#   sh /path/to/fix-tailscale.sh
#   # or from the Akash shell:
#   sh fix-tailscale.sh

TS_STATE_DIR="${TS_STATE_DIR:-/root/.sparkdream/tailscale}"
TS_SOCKET="${TS_STATE_DIR}/tailscaled.sock"

# Remove stale socket (safe — just a Unix socket file, not identity)
rm -f "$TS_SOCKET"

# Uncomment ONLY if you need a full re-registration (new IP will be assigned):
#rm -f "${TS_STATE_DIR}/tailscaled.state"

tailscaled --tun=userspace-networking \
  --state="${TS_STATE_DIR}/tailscaled.state" \
  --socket="${TS_SOCKET}" \
  &>/var/log/tailscaled.log &

sleep 5

tailscale --socket="$TS_SOCKET" up \
  --login-server="$HEADSCALE_URL" \
  --authkey="$TS_AUTHKEY" \
  --hostname="${TS_HOSTNAME:-validator}" \
  --accept-dns=false

tailscale --socket="$TS_SOCKET" status
