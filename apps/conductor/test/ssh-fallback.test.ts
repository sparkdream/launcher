import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Server } from "ssh2";
import { Ssh2Runner } from "../src/adapters.js";
import type { StepCtx } from "../src/engine.js";
import { awaitContainer } from "../src/fleet-ops.js";
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

/**
 * A target whose SSH connect cannot succeed, reached the same way on every
 * machine. The port is not the mechanism: a closed port refuses on one host,
 * blackholes on another, and under WSL2's loopback actually accepts, so
 * relying on it made these tests pass or hang by environment. readyTimeoutMs
 * bounds the handshake instead — whatever the socket does, ssh2 gives up
 * inside it with "Timed out while waiting for handshake", which the runner
 * classifies as a connect failure and hands to the lease-shell fallback.
 */
function deadTarget(): SshTarget {
  return {
    host: "127.0.0.1",
    port: 1,
    readyTimeoutMs: 150,
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
    // multiple chunks were needed (base64 of 300KB > one chunk)
    expect(stub.calls.filter((c) => c.startsWith("printf")).length).toBeGreaterThan(1);
    // each command is one argument to sh -c, which Linux caps at 128 KiB
    expect(Math.max(...stub.calls.map((c) => c.length))).toBeLessThan(131_072);
  });

  it("names a failed command by its start, not the file an upload carries in it", async () => {
    const failing = {
      async shellExec(): Promise<{ stdout: string; stderr: string }> {
        throw new Error("lease shell: no active replicas for service");
      },
    };
    const runner = new Ssh2Runner(() => failing);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sshfb-")), "data.bin");
    fs.writeFileSync(tmp, Buffer.alloc(27_000, 7));
    const error = await runner.upload(deadTarget(), tmp, "/tmp/data.bin").catch((e) => String(e));
    expect(error).toMatch(/via lease-shell\): printf '%s' '/);
    expect(error).toMatch(/more characters\)\nError: lease shell: no active replicas for service$/);
    expect(error.length).toBeLessThan(400);
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

  it("retries transient lease-shell gateway 5xx handshakes", async () => {
    const stub = stubShell();
    let failures = 2;
    const flaky = {
      async shellExec(...args: Parameters<typeof stub.client.shellExec>) {
        if (failures-- > 0) throw new Error("Unexpected server response: 500");
        return stub.client.shellExec(...args);
      },
    };
    const runner = new Ssh2Runner(() => flaky);
    const r = await runner.exec(deadTarget(), "echo hi");
    expect(r.stdout).toBe("ran:echo hi");
  }, 30_000);

  it("quick polls make a single attempt even on transient errors", async () => {
    let attempts = 0;
    const flaky = {
      async shellExec(): Promise<{ stdout: string; stderr: string }> {
        attempts++;
        throw new Error("Unexpected server response: 500");
      },
    };
    const runner = new Ssh2Runner(() => flaky);
    await expect(runner.exec(deadTarget(), "pgrep -x sparkdreamd", { quick: true })).rejects.toThrow(
      /via lease-shell/,
    );
    expect(attempts).toBe(1);
  });

  it("reroutes exec when the endpoint answers the handshake and then goes quiet", async () => {
    // the live shape (2026-08-28): a forwarded port that still accepts TCP
    // and completes an SSH handshake, but whose command stream never
    // answers. It is not a connect failure, so the fallback used to sit it
    // out and throw — leaving the one path that could still reach the node,
    // the one console-air uses, untried, and holding a reset's resume for
    // its whole poll budget while the chain was producing blocks
    const hostKey = generateSshKeypair().privateKeyPem;
    const server = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on("authentication", (a) => a.accept());
      client.on("ready", () => {
        client.on("session", (accept) => {
          accept().on("exec", () => {
            /* accepts the command and never answers it */
          });
        });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const stub = stubShell();
      const runner = new Ssh2Runner(() => stub.client);
      const target = { ...deadTarget(), port };
      const r = await runner.exec(target, "pgrep -x sparkdreamd", { timeoutMs: 300 });
      expect(r.stdout).toBe("ran:pgrep -x sparkdreamd");
    } finally {
      server.close();
    }
  }, 30_000);

  it("reroutes exec when the endpoint sends its banner and then closes", async () => {
    // the live shape (2026-09-25): a re-created container's forwarded port
    // answers with an SSH version line and drops the socket. ssh2 raises no
    // error for that and clears its own readyTimeout, so the probe never
    // settled and held a reset's start step with no timer left to end it
    const server = net.createServer((s) => {
      s.on("error", () => {}); // the client resets it after the close
      s.write("SSH-2.0-OpenSSH_9.6\r\n");
      setTimeout(() => s.end(), 50);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const stub = stubShell();
      const runner = new Ssh2Runner(() => stub.client);
      const target = { ...deadTarget(), port, readyTimeoutMs: 10_000 };
      const r = await runner.exec(target, "pgrep -x sparkdreamd", { quick: true });
      expect(r.stdout).toBe("ran:pgrep -x sparkdreamd");
    } finally {
      server.close();
    }
  }, 5_000);

  it("does not retry command failures, only handshake errors", async () => {
    let attempts = 0;
    const failing = {
      async shellExec(): Promise<{ stdout: string; stderr: string }> {
        attempts++;
        throw new Error("command terminated with exit code 1");
      },
    };
    const runner = new Ssh2Runner(() => failing);
    await expect(runner.exec(deadTarget(), "false")).rejects.toThrow(/via lease-shell/);
    expect(attempts).toBe(1);
  });
});

describe("waiting for a fresh container before the first upload (quanglong relaunches)", () => {
  /** A container whose SSH answers from check `sshFrom` and whose provider shell answers from `shellFrom`. */
  function world(sshFrom: number, shellFrom: number) {
    const state = { checks: 0, sleeps: 0, logs: [] as string[] };
    const ctx = {
      log: (m: string) => state.logs.push(m),
      services: {
        sleep: async () => void state.sleeps++,
        ssh: {
          async exec(target: SshTarget) {
            if (!target.shellFallback) {
              if (++state.checks >= sshFrom) return { stdout: "", code: 0 };
              throw new Error("connect ECONNREFUSED 1.2.3.4:31537");
            }
            if (state.checks >= shellFrom) return { stdout: "", code: 0 };
            throw new Error("ssh exit 1 (via lease-shell): true\nError: lease shell: no active replicas for service");
          },
        },
      },
    } as unknown as StepCtx;
    return { ctx, state };
  }

  it("goes on at once when SSH answers", async () => {
    const { ctx, state } = world(1, 1);
    await awaitContainer(ctx, "sentry-1", deadTarget());
    expect(state.sleeps).toBe(0);
  });

  it("waits out an image pull, and for sshd even once the provider's shell answers", async () => {
    const { ctx, state } = world(10, 7);
    await awaitContainer(ctx, "sentry-1", deadTarget());
    expect(state.checks).toBe(10);
    expect(state.logs).toEqual(["sentry-1: waiting for its container to start"]);
  });

  it("settles for the provider's shell after a minute of it answering alone", async () => {
    const { ctx, state } = world(Infinity, 3);
    await awaitContainer(ctx, "sentry-1", deadTarget());
    expect(state.checks).toBe(15);
    expect(state.logs.at(-1)).toMatch(/SSH does not answer on its forwarded port \(connect ECONNREFUSED.*using the provider's shell/);
  });

  it("fails with a short reason when nothing ever answers", async () => {
    const { ctx } = world(Infinity, Infinity);
    await expect(awaitContainer(ctx, "sentry-1", deadTarget())).rejects.toThrow(
      /^sentry-1: its container took no command for 4 minutes after the manifest was sent \(Error: lease shell: no active replicas for service\)/,
    );
  });
});
