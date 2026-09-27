import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LaunchSpec } from "@sparkdream/launch-spec";
import { readSecretFile, writeSecretFile } from "../secrets.js";

/**
 * The Mastodon instance's secrets, generated once per launch and kept in
 * secrets/mastodon.json (encrypted at rest with LAUNCHER_SECRET). They are
 * the equivalents of `rails secret`, `rake mastodon:webpush:generate_vapid_key`
 * and `rails db:encryption:init`, made here because the instance has to be
 * rendered before it can run anything. Losing them locks every account out
 * (encrypted columns, sessions, push subscriptions), so they are never
 * regenerated once written; the fleet bundle export carries them.
 */
export interface MastodonSecrets {
  SECRET_KEY_BASE: string;
  OTP_SECRET: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_PUBLIC_KEY: string;
  ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY: string;
  ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT: string;
  ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY: string;
  DB_PASS: string;
  /** The Owner account's generated password, once the instance created it. */
  ownerPassword?: string;
  /** The bridge's read-only API token, once issued. */
  bridgeToken?: string;
  /** mastodon.smtp's password, kept out of the spec. */
  smtpPassword?: string;
}

const FILE = "mastodon.json";

const alnum = (n: number) => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(n);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
};

/** urlsafe base64 with padding: what the webpush gem writes and reads. */
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

function generate(): MastodonSecrets {
  const vapid = crypto.createECDH("prime256v1");
  vapid.generateKeys();
  return {
    SECRET_KEY_BASE: crypto.randomBytes(64).toString("hex"),
    OTP_SECRET: crypto.randomBytes(64).toString("hex"),
    VAPID_PRIVATE_KEY: b64url(vapid.getPrivateKey()),
    // uncompressed point (65 bytes), as Webpush.generate_key produces
    VAPID_PUBLIC_KEY: b64url(vapid.getPublicKey()),
    ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY: alnum(32),
    ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT: alnum(32),
    ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY: alnum(32),
    DB_PASS: crypto.randomBytes(24).toString("hex"),
  };
}

export function readMastodonSecrets(secretsDir: string): MastodonSecrets | undefined {
  const file = path.join(secretsDir, FILE);
  return fs.existsSync(file) ? (JSON.parse(readSecretFile(file)) as MastodonSecrets) : undefined;
}

/** The launch's Mastodon secrets, generated on first use. */
export function ensureMastodonSecrets(secretsDir: string): MastodonSecrets {
  const existing = readMastodonSecrets(secretsDir);
  if (existing) return existing;
  const fresh = generate();
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  writeSecretFile(path.join(secretsDir, FILE), JSON.stringify(fresh, null, 2));
  return fresh;
}

/** Record something the running instance produced (owner password, token). */
export function updateMastodonSecrets(secretsDir: string, patch: Partial<MastodonSecrets>): MastodonSecrets {
  const next = { ...ensureMastodonSecrets(secretsDir), ...patch };
  writeSecretFile(path.join(secretsDir, FILE), JSON.stringify(next, null, 2));
  return next;
}

/** Master-keyring name (and mnemonics.json entry) of the bridge operator,
 *  the account that bonds for the instance's ActivityPub peer. */
export const BRIDGE_OPERATOR = "bridge-operator";

const OPERATOR_ADDRESS_FILE = "bridge-operator.address";

/** The bridge operator's address, as recorded when its key was made. Not
 *  secret: the bridge service's SDA_GRANTER. */
export function readBridgeOperatorAddress(secretsDir: string): string | undefined {
  const file = path.join(secretsDir, OPERATOR_ADDRESS_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() || undefined : undefined;
}

export function writeBridgeOperatorAddress(secretsDir: string, address: string): void {
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(secretsDir, OPERATOR_ADDRESS_FILE), `${address}\n`);
}
/** MASTODON_TOKEN until the configure step has issued the real one: the
 *  bridge service idles on it instead of crash-looping. */
export const BRIDGE_TOKEN_PENDING = "pending";

/**
 * Move mastodon.smtp.password out of a spec into the secret store, before
 * the spec is stored (specs are exported and shared; secrets are not).
 */
export function stashSmtpPassword(secretsDir: string, spec: LaunchSpec): void {
  const smtp = spec.topology.components.mastodon?.smtp;
  if (!smtp?.password) return;
  updateMastodonSecrets(secretsDir, { smtpPassword: smtp.password });
  delete smtp.password;
}
