#!/bin/bash
# Seed the S3 replica from an existing local Headscale db.sqlite.
# Runs `litestream replicate` for ~30s to write the initial encrypted snapshot,
# then stops. After this, deploy headscale.sdl.yaml on Akash and the new
# container will restore from the seeded snapshot when it sees an empty PVC.
#
# Usage:
#   # populate env vars (same values as in headscale.sdl.yaml)
#   export LITESTREAM_S3_ENDPOINT=...
#   export LITESTREAM_S3_BUCKET=...
#   export LITESTREAM_S3_PATH=archive
#   export LITESTREAM_S3_REGION=...
#   export LITESTREAM_S3_ACCESS_KEY_ID=...
#   export LITESTREAM_S3_SECRET_ACCESS_KEY=...
#   export AGE_RECIPIENT=age1...
#   export AGE_IDENTITY=AGE-SECRET-KEY-1...
#
#   ./deploy/mesh/seed-replica.sh /path/to/recovered/db.sqlite
#
# Requires: litestream (>=0.3.13), sqlite3.
#   apt:  apt install sqlite3 && curl ... # see Dockerfile-headscale-alpine for litestream URL
#   brew: brew install litestream sqlite

set -euo pipefail

DB_PATH="${1:-}"
if [ -z "$DB_PATH" ] || [ ! -f "$DB_PATH" ]; then
  echo "usage: $0 /path/to/db.sqlite" >&2
  exit 1
fi
DB_ABS=$(realpath "$DB_PATH")

for var in LITESTREAM_S3_ENDPOINT LITESTREAM_S3_BUCKET LITESTREAM_S3_PATH \
           LITESTREAM_S3_REGION LITESTREAM_S3_ACCESS_KEY_ID \
           LITESTREAM_S3_SECRET_ACCESS_KEY AGE_RECIPIENT AGE_IDENTITY; do
  if [ -z "${!var:-}" ]; then
    echo "error: \$$var is not set" >&2
    exit 1
  fi
done

command -v litestream >/dev/null || { echo "error: litestream not in PATH" >&2; exit 1; }
command -v sqlite3   >/dev/null  || { echo "error: sqlite3 not in PATH"   >&2; exit 1; }
command -v age       >/dev/null  || { echo "error: age not in PATH (apt install age / brew install age)"   >&2; exit 1; }
command -v s5cmd     >/dev/null  || { echo "error: s5cmd not in PATH (github.com/peak/s5cmd releases)"     >&2; exit 1; }

echo "==> Checkpointing any WAL frames into main DB..."
# wal_checkpoint(TRUNCATE) returns "busy|log|checkpointed". A non-zero busy
# means SQLite refused to fully merge the WAL — typically because the WAL
# header doesn't match the main DB (e.g. tarball captured while headscale was
# writing, leaving an inconsistent on-disk state). If we ignore this and seed
# anyway, the bucket holds a schema-less DB and restore looks fine until
# headscale crashes on startup with "schema failed to validate" — which is
# exactly what this guard is here to prevent.
checkpoint_result=$(sqlite3 "$DB_ABS" "PRAGMA wal_checkpoint(TRUNCATE);")
checkpoint_busy=$(echo "$checkpoint_result" | cut -d'|' -f1)
if [ "$checkpoint_busy" != "0" ]; then
  echo "error: wal_checkpoint(TRUNCATE) returned busy=$checkpoint_busy (full result: $checkpoint_result)" >&2
  echo "       The WAL could not be fully merged into the main DB. The source tarball was" >&2
  echo "       probably captured while headscale was writing, so db.sqlite-wal is out of" >&2
  echo "       sync with db.sqlite. Recover with sqlite3's .recover, then re-run:" >&2
  echo "         sqlite3 \"$DB_ABS\" .recover > /tmp/recovered.sql" >&2
  echo "         sqlite3 /tmp/recovered.sqlite < /tmp/recovered.sql" >&2
  echo "         $0 /tmp/recovered.sqlite" >&2
  exit 1
fi

echo "==> Verifying DB integrity..."
result=$(sqlite3 "$DB_ABS" "PRAGMA integrity_check;")
if [ "$result" != "ok" ]; then
  echo "error: integrity_check failed: $result" >&2
  exit 1
fi

echo "==> Verifying DB has user tables (catch silently-empty seeds)..."
# integrity_check passes on an empty DB, and litestream will happily ship that
# empty file. Refuse to seed unless there's at least one non-sqlite_* table.
table_count=$(sqlite3 "$DB_ABS" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
if [ "$table_count" -eq 0 ]; then
  echo "error: DB at $DB_ABS contains zero user tables — refusing to seed an empty replica." >&2
  echo "       sqlite_master is empty after checkpoint. If the data was in db.sqlite-wal" >&2
  echo "       and the WAL was inconsistent (silently ignored by SQLite), recover with:" >&2
  echo "         sqlite3 \"$DB_ABS\" .recover > /tmp/recovered.sql" >&2
  echo "         sqlite3 /tmp/recovered.sqlite < /tmp/recovered.sql" >&2
  echo "         sqlite3 /tmp/recovered.sqlite .tables   # confirm real tables now" >&2
  echo "         $0 /tmp/recovered.sqlite" >&2
  exit 1
fi
echo "    integrity: ok, $table_count user tables ($(sqlite3 "$DB_ABS" "SELECT group_concat(name, ', ') FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"))"
echo "    file size: $(stat -c %s "$DB_ABS" 2>/dev/null || stat -f %z "$DB_ABS") bytes"

# Headscale-shaped sanity check: list users + nodes so you can eyeball that the
# DB you're about to ship actually contains the mesh you expect. Quiet if the
# DB isn't headscale-shaped (no `nodes` table), since seed-replica is generic-
# enough to seed any sqlite DB into litestream.
has_nodes=$(sqlite3 "$DB_ABS" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='nodes';")
if [ "$has_nodes" = "1" ]; then
  user_count=$(sqlite3 "$DB_ABS" "SELECT count(*) FROM users WHERE deleted_at IS NULL;" 2>/dev/null || echo "?")
  node_count=$(sqlite3 "$DB_ABS" "SELECT count(*) FROM nodes WHERE deleted_at IS NULL;" 2>/dev/null || echo "?")
  preauth_count=$(sqlite3 "$DB_ABS" "SELECT count(*) FROM pre_auth_keys WHERE used=0 AND (expiration IS NULL OR expiration > datetime('now'));" 2>/dev/null || echo "?")
  echo
  echo "==> Headscale state in DB:"
  echo "    users: $user_count    nodes: $node_count    active pre-auth keys: $preauth_count"
  if [ "$node_count" != "0" ] && [ "$node_count" != "?" ]; then
    echo
    echo "    nodes (hostname / user / ipv4 / last_seen):"
    sqlite3 -separator '  ' "$DB_ABS" \
      "SELECT '      ' || COALESCE(n.given_name, n.hostname, '<unnamed>'),
              COALESCE(u.name, '<no-user>'),
              COALESCE(n.ipv4, '-'),
              COALESCE(datetime(n.last_seen), 'never')
       FROM nodes n LEFT JOIN users u ON n.user_id = u.id
       WHERE n.deleted_at IS NULL
       ORDER BY n.hostname;" 2>/dev/null || echo "      (query failed — schema may differ from expected headscale layout)"
  fi
  if [ "$node_count" = "0" ]; then
    echo
    echo "    WARNING: zero nodes in the DB. If you expected to recover an existing tailnet,"
    echo "             this is probably the wrong source DB. Aborting now would be safer than"
    echo "             overwriting your bucket with an empty mesh — Ctrl-C in the next 10s if so."
    sleep 10
  fi
fi

# Build a temp config that points at the local DB but mirrors the deployed one.
SCRIPT_DIR=$(dirname "$(realpath "$0")")
CONFIG=$(mktemp /tmp/litestream-seed-XXXXXX.yml)
trap 'rm -f "$CONFIG"' EXIT
sed "s|/var/lib/headscale/db.sqlite|$DB_ABS|" "$SCRIPT_DIR/litestream.yml" > "$CONFIG"

echo "==> Running litestream replicate for 30s to upload initial encrypted snapshot..."
timeout --preserve-status 30s litestream replicate -config "$CONFIG" || true

echo
echo "==> Snapshots now in bucket:"
litestream snapshots -config "$CONFIG" "$DB_ABS"

echo
echo "==> Generations:"
litestream generations -config "$CONFIG" "$DB_ABS"

# Litestream only replicates the SQLite DB. The static keys (noise + DERP) live
# alongside it as flat files and would otherwise be regenerated on first boot,
# breaking every existing client. Bundle them into an age-encrypted tarball
# and upload to the same bucket so the entrypoint can pull them on cold start.
DB_DIR=$(dirname "$DB_ABS")
STATE_FILES=""
for f in noise_private.key derp_server_private.key; do
  if [ -f "$DB_DIR/$f" ]; then
    STATE_FILES="$STATE_FILES $f"
  fi
done

echo
if [ -z "$STATE_FILES" ]; then
  echo "==> WARNING: no noise_private.key / derp_server_private.key found in $DB_DIR"
  echo "    The deployed container will mint fresh ones and EVERY existing client will reject"
  echo "    the control plane. Re-run this script against a directory that contains them."
else
  STATE_ARCHIVE=$(mktemp /tmp/headscale-state-XXXXXX.tar.age)
  trap 'rm -f "$CONFIG" "$STATE_ARCHIVE"' EXIT
  echo "==> Encrypting static keys ($STATE_FILES ) with AGE_RECIPIENT..."
  # shellcheck disable=SC2086  # $STATE_FILES is a space-separated list of safe filenames
  tar -C "$DB_DIR" -czf - $STATE_FILES | age -r "$AGE_RECIPIENT" -o "$STATE_ARCHIVE"
  echo "    archive size: $(stat -c %s "$STATE_ARCHIVE" 2>/dev/null || stat -f %z "$STATE_ARCHIVE") bytes"

  ARCHIVE_KEY="$LITESTREAM_S3_PATH/state-keys.tar.age"
  echo "==> Uploading to s3://$LITESTREAM_S3_BUCKET/$ARCHIVE_KEY ..."
  AWS_ACCESS_KEY_ID="$LITESTREAM_S3_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$LITESTREAM_S3_SECRET_ACCESS_KEY" \
  s5cmd --endpoint-url "$LITESTREAM_S3_ENDPOINT" \
        cp "$STATE_ARCHIVE" "s3://$LITESTREAM_S3_BUCKET/$ARCHIVE_KEY"
  echo "    upload complete."
fi

echo
echo "==> Seed complete. If at least one snapshot is listed above AND the static-keys"
echo "    upload succeeded, your bucket holds everything needed to revive headscale"
echo "    with the same identity. Deploy headscale.sdl.yaml on Akash; the container's"
echo "    entrypoint will detect an empty PVC, restore the SQLite DB, and decrypt"
echo "    state-keys.tar.age back into /var/lib/headscale before headscale starts."
