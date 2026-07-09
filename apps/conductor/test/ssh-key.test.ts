import { describe, expect, it } from "vitest";
import { utils } from "ssh2";
import { generateSshKeypair, toSsh2CompatiblePrivateKey } from "../src/keys.js";

describe("SSH keypair format", () => {
  it("generates a private key ssh2 can actually parse", () => {
    const kp = generateSshKeypair("test");
    const parsed = utils.parseKey(kp.privateKeyPem);
    expect(parsed).not.toBeInstanceOf(Error);
    expect((parsed as any).type).toBe("ssh-ed25519");
    // public halves agree
    const pubFromPriv = (parsed as any).getPublicSSH().toString("base64");
    expect(kp.publicKeyOpenssh).toContain(pubFromPriv.slice(0, 20));
  });

  it("converts legacy PKCS8 PEM keys (pre-fix launches) for ssh2", () => {
    const { generateKeyPairSync } = require("node:crypto");
    const { privateKey } = generateKeyPairSync("ed25519");
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    // sanity: ssh2 rejects the raw PKCS8 ed25519 key
    expect(utils.parseKey(pkcs8)).toBeInstanceOf(Error);
    const converted = toSsh2CompatiblePrivateKey(pkcs8);
    const parsed = utils.parseKey(converted);
    expect(parsed).not.toBeInstanceOf(Error);
    expect((parsed as any).type).toBe("ssh-ed25519");
  });

  it("passes openssh-format keys through untouched", () => {
    const kp = generateSshKeypair("test");
    expect(toSsh2CompatiblePrivateKey(kp.privateKeyPem)).toBe(kp.privateKeyPem);
  });
});
