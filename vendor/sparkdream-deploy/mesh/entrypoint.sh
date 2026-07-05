#!/bin/sh
set -e

CONFIG=/etc/headscale/config.yaml
DEFAULT_CONFIG=/opt/headscale/default-config.yaml
DB=/var/lib/headscale/db.sqlite
STATE_DIR=/var/lib/headscale
NOISE_KEY="$STATE_DIR/noise_private.key"
DERP_KEY="$STATE_DIR/derp_server_private.key"
STATE_ARCHIVE_NAME=state-keys.tar.age

if [ ! -f "$CONFIG" ]; then
  echo "==> No config found, copying default config..."
  cp "$DEFAULT_CONFIG" "$CONFIG"
  echo "==> Config written to $CONFIG"
  echo "==> IMPORTANT: Update server_url in $CONFIG with your Akash provider URI"
else
  echo "==> Existing config found, using it."
fi

mkdir -p /var/run/headscale "$STATE_DIR"

# Restore the static keys (noise + DERP) that litestream does NOT replicate.
# Without this, a fresh PVC means headscale mints new keys on first boot and
# every existing client rejects the control plane as "unknown server".
#
# Precedence (matches "Both" choice in design):
#   1) S3 archive: state-keys.tar.age fetched + age-decrypted + untarred
#   2) Env-var override: HEADSCALE_NOISE_PRIVATE_KEY / HEADSCALE_DERP_PRIVATE_KEY
#      written on top of whatever S3 produced. Set these only when you don't
#      want to seed the bucket.
restore_static_keys() {
  if [ -f "$NOISE_KEY" ] && [ -f "$DERP_KEY" ]; then
    echo "==> Static keys already present on PVC, skipping restore."
    return
  fi

  if [ -n "$LITESTREAM_S3_BUCKET" ] && [ -n "$LITESTREAM_S3_ACCESS_KEY_ID" ] && [ -n "$AGE_IDENTITY" ]; then
    ARCHIVE_KEY="${LITESTREAM_S3_PATH:-archive}/$STATE_ARCHIVE_NAME"
    echo "==> Attempting to restore static keys from s3://$LITESTREAM_S3_BUCKET/$ARCHIVE_KEY"
    ENC_TMP=$(mktemp /tmp/state-keys.tar.age.XXXXXX)
    DEC_TMP=$(mktemp /tmp/state-keys.tar.XXXXXX)
    AGE_KEY_FILE=$(mktemp /tmp/age-id.XXXXXX)
    chmod 600 "$AGE_KEY_FILE"
    printf '%s' "$AGE_IDENTITY" > "$AGE_KEY_FILE"
    if AWS_ACCESS_KEY_ID="$LITESTREAM_S3_ACCESS_KEY_ID" \
       AWS_SECRET_ACCESS_KEY="$LITESTREAM_S3_SECRET_ACCESS_KEY" \
       s5cmd --endpoint-url "$LITESTREAM_S3_ENDPOINT" \
             cp "s3://$LITESTREAM_S3_BUCKET/$ARCHIVE_KEY" "$ENC_TMP" 2>/dev/null; then
      if age -d -i "$AGE_KEY_FILE" -o "$DEC_TMP" "$ENC_TMP" 2>/dev/null \
         && tar -C "$STATE_DIR" -xzf "$DEC_TMP"; then
        chmod 600 "$NOISE_KEY" "$DERP_KEY" 2>/dev/null || true
        echo "==> Static keys restored from S3 archive."
      else
        echo "==> Failed to decrypt/extract static-keys archive (wrong AGE_IDENTITY?)"
      fi
    else
      echo "==> No static-keys archive in S3 (will fall through to env vars / fresh generation)."
    fi
    rm -f "$ENC_TMP" "$DEC_TMP" "$AGE_KEY_FILE"
  fi

  # Env-var overrides win over whatever S3 produced.
  if [ -n "$HEADSCALE_NOISE_PRIVATE_KEY" ]; then
    echo "==> Writing noise_private.key from HEADSCALE_NOISE_PRIVATE_KEY env."
    printf '%s' "$HEADSCALE_NOISE_PRIVATE_KEY" > "$NOISE_KEY"
    chmod 600 "$NOISE_KEY"
  fi
  if [ -n "$HEADSCALE_DERP_PRIVATE_KEY" ]; then
    echo "==> Writing derp_server_private.key from HEADSCALE_DERP_PRIVATE_KEY env."
    printf '%s' "$HEADSCALE_DERP_PRIVATE_KEY" > "$DERP_KEY"
    chmod 600 "$DERP_KEY"
  fi

  if [ ! -f "$NOISE_KEY" ] || [ ! -f "$DERP_KEY" ]; then
    echo "==> Static keys still missing — headscale will mint fresh ones. Existing clients WILL break."
  fi
}

restore_static_keys

# Litestream wraps headscale: every WAL frame is shipped to S3-compatible
# object storage. If the persistent volume is empty (new provider after
# disaster), the DB is restored from the replica before headscale starts.
# If LITESTREAM_S3_BUCKET is unset, we fall through and run headscale alone
# so the same image still works for local/dev deployments without backup.
if [ -n "$LITESTREAM_S3_BUCKET" ] && [ -n "$LITESTREAM_S3_ACCESS_KEY_ID" ]; then
  echo "==> Litestream enabled (bucket=$LITESTREAM_S3_BUCKET endpoint=$LITESTREAM_S3_ENDPOINT)"
  if [ ! -f "$DB" ]; then
    echo "==> No local DB found, attempting restore from replica..."
    if litestream restore -if-replica-exists -config /etc/litestream.yml "$DB"; then
      echo "==> Restore complete: $(stat -c %s "$DB" 2>/dev/null || echo 0) bytes"
    else
      echo "==> No replica found (or restore failed), starting fresh."
    fi
  else
    echo "==> Local DB already exists ($(stat -c %s "$DB") bytes), skipping restore."
  fi
  exec litestream replicate -exec "headscale serve" -config /etc/litestream.yml
else
  echo "==> Litestream disabled (LITESTREAM_S3_BUCKET unset). Running headscale standalone."
  exec headscale serve
fi
