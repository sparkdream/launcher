import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Ssh2Runner } from "../src/adapters.js";
import { generateSshKeypair } from "../src/keys.js";
import type { SshTarget } from "../src/services.js";

/** In-memory "container": applies the fallback's sh -c commands. */
function stubShell() {
  const files = new Map<string, string>();
  const calls: string[] = [];
  return {
    files,
    calls,
    client: {
      async shellExec(_h: string, _d: string, _g: number, _o: number, _s: string, cmd: string[]) {
        const script = cmd[2]!;
        calls.push(script);
        let m;
        if ((m = /^printf '%s' '([^']*)' (>>?) (\S+)$/.exec(script))) {
          const prev = m[2] === ">>" ? (files.get(m[3]!) ?? "") : "";
          files.set(m[3]!, prev + m[1]!);
          return { stdout: "", stderr: "" };
        }
        if ((m = /^base64 -d (\S+) > (\S+) && rm \S+$/.exec(script))) {
          files.set(m[2]!, Buffer.from(files.get(m[1]!) ?? "", "base64").toString("latin1"));
          files.delete(m[1]!);
          return { stdout: "", stderr: "" };
        }
        if ((m = /^base64 (\S+)$/.exec(script))) {
          return { stdout: Buffer.from(files.get(m[1]!) ?? "", "latin1").toString("base64"), stderr: "" };
        }
        return { stdout: `ran:${script}`, stderr: "" };
      },
    },
  };
}

function deadTarget(): SshTarget {
  return {
    host: "127.0.0.1",
    port: 1, // nothing listens — instant ECONNREFUSED
    user: "root",
    privateKeyPem: generateSshKeypair().privateKeyPem,
    shellFallback: {
      creds: { certPem: "c", keyPem: "k" },
      hostUri: "https://provider:8443",
      dseq: "1",
      gseq: 1,
      oseq: 1,
      service: "sparkdreamd",
    },
  };
}

describe("lease-shell SSH fallback", () => {
  it("reroutes exec when the forwarded port refuses connections", async () => {
    const stub = stubShell();
    const runner = new Ssh2Runner(() => stub.client);
    const r = await runner.exec(deadTarget(), "echo hi");
    expect(r.stdout).toBe("ran:echo hi");
  });

  it("uploads via chunked base64 and reassembles the exact bytes", async () => {
    const stub = stubShell();
    const runner = new Ssh2Runner(() => stub.client);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sshfb-")), "data.bin");
    const payload = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
    fs.writeFileSync(tmp, payload);
    await runner.upload(deadTarget(), tmp, "/tmp/data.bin");
    expect(Buffer.from(stub.files.get("/tmp/data.bin")!, "latin1").equals(payload)).toBe(true);
    // multiple chunks were needed (base64 of 300KB > one 200k chunk)
    expect(stub.calls.filter((c) => c.startsWith("printf")).length).toBeGreaterThan(1);
  });

  it("downloads via base64", async () => {
    const stub = stubShell();
    stub.files.set("/remote/x", "hello-bytes");
    const runner = new Ssh2Runner(() => stub.client);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sshfb-")), "out.bin");
    await runner.download(deadTarget(), "/remote/x", tmp);
    expect(fs.readFileSync(tmp, "latin1")).toBe("hello-bytes");
  });

  it("does not mask auth failures with the fallback", async () => {
    const stub = stubShell();
    const runner = new Ssh2Runner(() => stub.client);
    const target = { ...deadTarget(), privateKeyPem: "not-a-key" };
    // key parse error is not a connect failure — must surface, not fall back
    await expect(runner.exec(target, "true")).rejects.toThrow(/key|format|parse|connect/i);
    expect(stub.calls.length).toBe(0);
  });
});
