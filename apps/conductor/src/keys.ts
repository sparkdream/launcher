import { generateKeyPairSync } from "node:crypto";

export interface SshKeypair {
  /** PKCS8 PEM — accepted by ssh2 for client auth. */
  privateKeyPem: string;
  /** authorized_keys line, ready for the SDL's SSH_PUBLIC_KEY env. */
  publicKeyOpenssh: string;
}

/** Ephemeral per-launch ed25519 SSH keypair (§3). */
export function generateSshKeypair(comment = "sparkdream-launcher"): SshKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 32); // ed25519 SPKI = fixed prefix + 32-byte key

  const type = Buffer.from("ssh-ed25519");
  const wire = Buffer.concat([u32(type.length), type, u32(raw.length), raw]);
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyOpenssh: `ssh-ed25519 ${wire.toString("base64")} ${comment}`,
  };
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

export interface AgeKeypair {
  /** age1... recipient (public). */
  recipient: string;
  /** AGE-SECRET-KEY-1... identity (private). */
  identity: string;
}

/** X25519 age keypair for headscale backup encryption (§3). */
export function generateAgeKeypair(): AgeKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const rawPriv = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  return {
    recipient: bech32("age", rawPub),
    identity: bech32("age-secret-key-", rawPriv).toUpperCase(),
  };
}

// --- minimal BIP-173 bech32 encoder (age keys are plain bech32) ---

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32(hrp: string, data: Buffer): string {
  const words = convertBits(data, 8, 5);
  const checksum = createChecksum(hrp, words);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

function convertBits(data: Buffer, from: number, to: number): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const b of data) {
    acc = (acc << from) | b;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & ((1 << to) - 1));
    }
  }
  if (bits > 0) out.push((acc << (to - bits)) & ((1 << to) - 1));
  return out;
}

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function createChecksum(hrp: string, words: number[]): number[] {
  const values = [...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}
