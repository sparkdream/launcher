import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readSecretFile, writeSecretFile } from "../secrets.js";

/** Master-keyring name (and mnemonics.json entry) of the scanner operator,
 *  the account that bonds as the chain's content-scanner. */
export const SCANNER_OPERATOR = "scanner-operator";

const ADDRESS_FILE = "scanner-operator.address";
const SECRETS_FILE = "scanner.json";

/** The scanner operator's address, as recorded when its key was made. Not
 *  secret: the scanner's CS_GRANTER. */
export function readScannerOperatorAddress(secretsDir: string): string | undefined {
  const file = path.join(secretsDir, ADDRESS_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() || undefined : undefined;
}

export function writeScannerOperatorAddress(secretsDir: string, address: string): void {
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(secretsDir, ADDRESS_FILE), `${address}\n`);
}

/**
 * The scanner's ed25519 verdict signing key, as contentscan keygen writes it
 * (a base64 32-byte seed): made once per launch and kept with its secrets,
 * so a move or relaunch signs with the key the operator metadata publishes.
 */
export function ensureVerdictSeed(secretsDir: string): string {
  const file = path.join(secretsDir, SECRETS_FILE);
  const stored = fs.existsSync(file) ? (JSON.parse(readSecretFile(file)) as { verdictSeed?: string }) : {};
  if (stored.verdictSeed) return stored.verdictSeed;
  const verdictSeed = crypto.randomBytes(32).toString("base64");
  writeSecretFile(file, JSON.stringify({ ...stored, verdictSeed }, null, 2));
  return verdictSeed;
}

/** The base64 ed25519 public key of a verdict seed (operator metadata). */
export function verdictPublicKey(seedB64: string): string {
  const seed = Buffer.from(seedB64, "base64");
  // PKCS#8 wrapping of a raw ed25519 seed (RFC 8410)
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const pub = crypto.createPublicKey(crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
  return pub.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
}
