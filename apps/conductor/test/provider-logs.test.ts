import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { OpensslCertProvider } from "../src/adapters.js";
import { ProviderClient } from "../src/akash/client.js";

/**
 * A stand-in for the provider's gateway, faithful on the one point this
 * suite is about: `/lease/.../logs` is a websocket endpoint, and a request
 * that arrives without an upgrade gets gorilla's bodyless `400 Bad Request`.
 * Live (2026-08-25) that 400 was every halt-wait probe's answer, read as
 * "unreadable, keep polling" — so a devnet that had halted at 25000 an hour
 * earlier sat in halt-wait with no node ever observed halting.
 */
class FakeProviderGateway {
  readonly requested: string[] = [];
  private server!: https.Server;
  private wss!: WebSocketServer;
  private lines: string[] = [];
  /** end the stream the way real providers do: no close frame, just a drop */
  private hangUp = false;

  async start(): Promise<string> {
    const { certPem, keyPem } = await new OpensslCertProvider().generate("akash1provider");
    this.server = https.createServer(
      { cert: certPem, key: keyPem, requestCert: true, rejectUnauthorized: false },
      (req, res) => {
        this.requested.push(req.url!);
        res.writeHead(400);
        res.end("Bad Request\n");
      },
    );
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      this.requested.push(req.url!);
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        // end only once the tail is actually on the wire — a drop mid-flush
        // would be testing this fake's timing rather than the client
        let pending = this.lines.length;
        const end = () => (this.hangUp ? socket.destroy() : ws.close());
        if (pending === 0) end();
        for (const line of this.lines) {
          ws.send(line, () => {
            if (--pending === 0) end();
          });
        }
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `https://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  serves(lines: string[], opts: { hangUp?: boolean } = {}): void {
    this.lines = lines;
    this.hangUp = opts.hangUp ?? false;
  }

  async stop(): Promise<void> {
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe("provider lease logs", () => {
  const gateway = new FakeProviderGateway();
  let hostUri = "";
  let client: ProviderClient;

  beforeAll(async () => {
    hostUri = await gateway.start();
    const { certPem, keyPem } = await new OpensslCertProvider().generate("akash1owner");
    client = new ProviderClient({ certPem, keyPem });
  }, 30_000);

  afterAll(() => gateway.stop());

  it("reads the tail over the websocket, not as a REST GET", async () => {
    gateway.serves([
      JSON.stringify({ name: "sparkdreamd-0", message: "INF committed state height=24999" }),
      JSON.stringify({ name: "sparkdreamd-0", message: "ERR halt per configuration height 25000 time 0" }),
    ]);
    const logs = await client.leaseLogs(hostUri, "1234", 1, 1, 500);
    expect(logs.split("\n")).toEqual([
      "[sparkdreamd] INF committed state height=24999",
      "[sparkdreamd] ERR halt per configuration height 25000 time 0",
    ]);
    // a GET would have been answered with the 400 above and thrown
    expect(gateway.requested).toEqual(["/lease/1234/1/1/logs?follow=false&tail=500"]);
  });

  it("treats a dropped connection as the end of the tail", async () => {
    gateway.serves([JSON.stringify({ name: "sparkdreamd-0", message: "INF starting node" })], {
      hangUp: true,
    });
    await expect(client.leaseLogs(hostUri, "1234", 1, 1, 10)).resolves.toBe(
      "[sparkdreamd] INF starting node",
    );
  });

  it("passes through a frame that is not a log entry", async () => {
    gateway.serves(["upstream error: no replicas"]);
    await expect(client.leaseLogs(hostUri, "1234", 1, 1, 10)).resolves.toBe(
      "upstream error: no replicas",
    );
  });
});
