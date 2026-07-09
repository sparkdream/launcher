#!/bin/sh
# Launcher entrypoint (§2 dual-mode). With LITESTREAM_REPLICA_URL set (Akash
# mode, same pattern as headscale), the SQLite state db is restored from and
# continuously replicated to S3 so launcher state survives provider migration.
set -eu

DB="${DATA_DIR:-/app/data}/state.db"
mkdir -p "$(dirname "$DB")"

if [ -n "${LITESTREAM_REPLICA_URL:-}" ] && command -v litestream >/dev/null 2>&1; then
  if [ ! -f "$DB" ]; then
    echo "restoring launcher state from ${LITESTREAM_REPLICA_URL}..."
    litestream restore -if-replica-exists -o "$DB" "$LITESTREAM_REPLICA_URL" || true
  fi
  exec litestream replicate \
    -exec "node /app/apps/conductor/dist/main.js" \
    "$DB" "$LITESTREAM_REPLICA_URL"
fi

exec node /app/apps/conductor/dist/main.js
