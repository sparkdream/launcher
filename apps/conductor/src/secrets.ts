import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Secret-at-rest encryption (M6, §2): when LAUNCHER_SECRET is set (Akash
 * mode), secret files are AES-256-GCM encrypted with a scrypt-derived key.
 * This protects the litestream replica and casual disk access; it does NOT
 * protect against a malicious provider reading container memory (§2 states
 * this openly — mainnet launches belong on a local launcher).
 *
 * Files are self-describing: encrypted ones carry a magic prefix, so a
 * plaintext workdir keeps working after LAUNCHER_SECRET is introduced.
 */

const MAGIC = Buffer.from("SDLSEC1\n");

function derivedKey(): Buffer | null {
  const secret = process.env.LAUNCHER_SECRET;
  if (!secret) return null;
  return crypto.scryptSync(secret, "sparkdream-launcher-v1", 32);
}

export function writeSecretFile(filePath: string, content: string | Buffer): void {
  const key = derivedKey();
  const data = typeof content === "string" ? Buffer.from(content) : content;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!key) {
    fs.writeFileSync(filePath, data, { mode: 0o600 });
    return;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  fs.writeFileSync(filePath, Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]), {
    mode: 0o600,
  });
}

export function readSecretFile(filePath: string): string {
  return readSecretBuffer(filePath).toString("utf8");
}

export function readSecretBuffer(filePath: string): Buffer {
  const raw = fs.readFileSync(filePath);
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) return raw; // plaintext
  const key = derivedKey();
  if (!key) {
    throw new Error(`${filePath} is encrypted but LAUNCHER_SECRET is not set`);
  }
  const iv = raw.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = raw.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const ciphertext = raw.subarray(MAGIC.length + 28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function isEncryptedFile(filePath: string): boolean {
  const fd = fs.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(MAGIC.length);
    fs.readSync(fd, head, 0, MAGIC.length, 0);
    return head.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

function copySecretsTree(srcDir: string, dstDir: string, copyFile: (src: string, dst: string) => void): void {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, entry);
    if (fs.statSync(src).isDirectory()) {
      copySecretsTree(src, path.join(dstDir, entry), copyFile);
    } else {
      copyFile(src, path.join(dstDir, entry));
    }
  }
}

/** Copy a secrets dir decrypting each file (fleet bundle export). */
export function copySecretsDecrypted(srcDir: string, dstDir: string): void {
  copySecretsTree(srcDir, dstDir, (src, dst) =>
    fs.writeFileSync(dst, readSecretBuffer(src), { mode: 0o600 }),
  );
}

/** Copy a plaintext secrets dir applying this instance's encryption (import). */
export function copySecretsEncrypted(srcDir: string, dstDir: string): void {
  copySecretsTree(srcDir, dstDir, (src, dst) => writeSecretFile(dst, fs.readFileSync(src)));
}
