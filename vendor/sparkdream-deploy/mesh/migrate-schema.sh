#!/bin/bash
# Migrate a headscale SQLite DB into v0.28.0's canonical schema layout.
# Required when the DB was created by older GORM-only headscale (backtick
# identifiers, GORM-style column order with timestamps interleaved) and the
# v0.28.0 binary's atlas-based schema validator rejects it.
#
# Strategy: create a fresh DB with the exact CREATE TABLE statements atlas
# wants, attach the old DB, copy each table with a named-column INSERT.
# Named INSERTs are insensitive to column order, so the source/destination
# layouts can differ freely.
#
# Usage:  ./migrate-schema.sh <source.sqlite> [dest.sqlite]
# Output: dest defaults to source.migrated.sqlite

set -euo pipefail

SRC="${1:-}"
DST="${2:-${SRC%.sqlite}.migrated.sqlite}"

if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "usage: $0 <source.sqlite> [dest.sqlite]" >&2
  exit 1
fi

if [ -e "$DST" ]; then
  echo "error: destination $DST already exists — remove it first" >&2
  exit 1
fi

echo "==> Creating canonical schema at $DST..."
sqlite3 "$DST" <<'EOF'
CREATE TABLE users(
  id integer PRIMARY KEY AUTOINCREMENT,
  name text,
  display_name text,
  email text,
  provider_identifier text,
  provider text,
  profile_pic_url text,
  created_at datetime,
  updated_at datetime,
  deleted_at datetime
);
CREATE UNIQUE INDEX idx_name_no_provider_identifier ON users(name) WHERE provider_identifier IS NULL;
CREATE UNIQUE INDEX idx_name_provider_identifier ON users(name, provider_identifier);
CREATE UNIQUE INDEX idx_provider_identifier ON users(provider_identifier) WHERE provider_identifier IS NOT NULL;
CREATE INDEX idx_users_deleted_at ON users(deleted_at);

CREATE TABLE pre_auth_keys(
  id integer PRIMARY KEY AUTOINCREMENT,
  key text,
  prefix text,
  hash blob,
  user_id integer,
  reusable numeric,
  ephemeral numeric DEFAULT false,
  used numeric DEFAULT false,
  tags text,
  expiration datetime,
  created_at datetime,
  CONSTRAINT fk_pre_auth_keys_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_pre_auth_keys_prefix ON pre_auth_keys(prefix) WHERE prefix IS NOT NULL AND prefix != '';

CREATE TABLE api_keys(
  id integer PRIMARY KEY AUTOINCREMENT,
  prefix text,
  hash blob,
  expiration datetime,
  last_seen datetime,
  created_at datetime
);
CREATE UNIQUE INDEX idx_api_keys_prefix ON api_keys(prefix);

CREATE TABLE nodes(
  id integer PRIMARY KEY AUTOINCREMENT,
  machine_key text,
  node_key text,
  disco_key text,
  endpoints text,
  host_info text,
  ipv4 text,
  ipv6 text,
  hostname text,
  given_name varchar(63),
  user_id integer,
  register_method text,
  tags text,
  auth_key_id integer,
  last_seen datetime,
  expiry datetime,
  approved_routes text,
  created_at datetime,
  updated_at datetime,
  deleted_at datetime,
  CONSTRAINT fk_nodes_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_nodes_auth_key FOREIGN KEY(auth_key_id) REFERENCES pre_auth_keys(id)
);

CREATE TABLE policies(
  id integer PRIMARY KEY AUTOINCREMENT,
  data text,
  created_at datetime,
  updated_at datetime,
  deleted_at datetime
);
CREATE INDEX idx_policies_deleted_at ON policies(deleted_at);
EOF

echo "==> Copying data from $SRC via named-column INSERTs..."
# Order matters: users first (FK target for pre_auth_keys and nodes), then
# pre_auth_keys (FK target for nodes), then nodes. api_keys and policies have
# no FK dependencies on the others.
sqlite3 "$DST" <<EOF
PRAGMA foreign_keys = OFF;
ATTACH DATABASE '$SRC' AS old;

INSERT INTO users (id, name, display_name, email, provider_identifier, provider, profile_pic_url, created_at, updated_at, deleted_at)
  SELECT id, name, display_name, email, provider_identifier, provider, profile_pic_url, created_at, updated_at, deleted_at
  FROM old.users;

INSERT INTO pre_auth_keys (id, key, prefix, hash, user_id, reusable, ephemeral, used, tags, expiration, created_at)
  SELECT id, key, prefix, hash, user_id, reusable, ephemeral, used, tags, expiration, created_at
  FROM old.pre_auth_keys;

INSERT INTO api_keys (id, prefix, hash, expiration, last_seen, created_at)
  SELECT id, prefix, hash, expiration, last_seen, created_at
  FROM old.api_keys;

INSERT INTO nodes (id, machine_key, node_key, disco_key, endpoints, host_info, ipv4, ipv6, hostname, given_name, user_id, register_method, tags, auth_key_id, last_seen, expiry, approved_routes, created_at, updated_at, deleted_at)
  SELECT id, machine_key, node_key, disco_key, endpoints, host_info, ipv4, ipv6, hostname, given_name, user_id, register_method, tags, auth_key_id, last_seen, expiry, approved_routes, created_at, updated_at, deleted_at
  FROM old.nodes;

INSERT INTO policies (id, data, created_at, updated_at, deleted_at)
  SELECT id, data, created_at, updated_at, deleted_at
  FROM old.policies;

DETACH DATABASE old;
PRAGMA foreign_keys = ON;
EOF

echo "==> Verifying row counts..."
sqlite3 "$DST" <<'EOF'
SELECT 'users          ' || count(*) FROM users;
SELECT 'nodes          ' || count(*) FROM nodes;
SELECT 'pre_auth_keys  ' || count(*) FROM pre_auth_keys;
SELECT 'api_keys       ' || count(*) FROM api_keys;
SELECT 'policies       ' || count(*) FROM policies;
EOF

echo
echo "==> Done. Seed with:"
echo "    ./deploy/mesh/seed-replica.sh $DST"
