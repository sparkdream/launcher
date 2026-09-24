import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpensslCertProvider } from "../src/adapters.js";
import { ProviderClient } from "../src/akash/client.js";

/**
 * A provider gateway that answers a manifest PUT with its headers and part
 * of a body, then drops the connection. Live (2026-09-24) that shape left a
 * reset-chain's manifest push pending forever: the response emitted neither
 * `end` nor a request `error`, and the socket's idle timeout had nothing
 * left to watch, so the op's start step spun long after the chain was up.
 */
describe("ProviderClient request", () => {
  let server: https.Server;
  let hostUri: string;
  let creds: { certPem: string; keyPem: string };
  let mode: "ok" | "drop" = "ok";

  beforeAll(async () => {
    const { certPem, keyPem } = await new OpensslCertProvider().generate("akash1provider");
    creds = await new OpensslCertProvider().generate("akash1owner");
    server = https.createServer(
      { cert: certPem, key: keyPem, requestCert: true, rejectUnauthorized: false },
      (req, res) => {
        req.resume();
        req.on("end", () => {
          if (mode === "ok") {
            res.writeHead(200);
            res.end("");
            return;
          }
          res.writeHead(200, { "Content-Length": "100" });
          res.write("partial", () => res.socket?.destroy());
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    hostUri = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = () => new ProviderClient(creds, { preSendDelayMs: 0, sleep: async () => {} });

  it("resolves a manifest PUT the provider answers in full", async () => {
    mode = "ok";
    await expect(client().sendManifest(hostUri, "1", "[]")).resolves.toBeUndefined();
  });

  it("rejects, rather than hanging, when the provider drops the response mid-body", async () => {
    mode = "drop";
    await expect(client().sendManifest(hostUri, "1", "[]")).rejects.toThrow(
      /closed before the response finished|aborted/,
    );
  }, 10_000);
});
