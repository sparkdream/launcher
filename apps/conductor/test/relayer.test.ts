import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { chainId, testnetSpec, validateSpec, type LaunchSpec, type RelayerPath } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { allSteps } from "../src/index.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps } from "../src/fleet-ops.js";
import {
  relayerTunnels,
  relayPlan,
  renderHermesConfig,
  renderRelayManifest,
  resolveRelayFleet,
  suggestedTopUp,
  type RelayChannel,
} from "../src/relayer.js";
import { relayerStatePath, type RelayerLinkOutput } from "../src/steps/relayer-link.js";
import { fakeServices, FakeSigner } from "./fakes.js";
import { chainStub, withStub } from "./chain-stub.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-relayer-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const osmosis: RelayerPath = {
  id: "osmo",
  kind: "transfer",
  counterparty: {
    chainId: "osmo-test-5",
    rpc: "https://rpc.osmotest5.example",
    grpc: "http://grpc.osmotest5.example:9090",
    bech32Prefix: "osmo",
    gasDenom: "uosmo",
    gasPrice: 0.025,
    hdPath: "m/44'/118'/0'/0/0",
  },
};

const osmosisMarket: RelayerPath = {
  ...osmosis,
  counterparty: {
    ...osmosis.counterparty,
    gasPrice: 0.0025,
    dynamicGasPrice: { multiplier: 1.2, max: 0.1 },
    eventSource: "pull",
    gasMultiplier: 1.5,
  } as RelayerPath["counterparty"],
};

function spec(name: string, headscale: Record<string, unknown>, paths: RelayerPath[] = []): LaunchSpec {
  return testnetSpec({
    network: { name, type: "testnet", bech32Prefix: "sprkdrm" },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: {
        explorer: { enabled: false },
        frontend: { enabled: false },
        hub: { enabled: false },
        ...(paths.length ? { relayer: { enabled: true, paths } } : {}),
      },
      headscale,
    },
  });
}

async function launch(db: ConductorDb, work: string, services: ReturnType<typeof fakeServices>, id: string, s: LaunchSpec) {
  db.createLaunch(id, JSON.stringify(s), "akash1owner");
  return runWithSigner(db, id, s, work, allSteps(), services, new FakeSigner());
}

/** The forwarded RPC the conductor reaches a node through (fake provider). */
async function nodeRpcUrlFor(services: ReturnType<typeof fakeServices>, row: { host_uri: string; dseq: string }): Promise<string> {
  const status = (await services.provider.leaseStatus({} as never, row.host_uri, row.dseq, 1, 1)) as any;
  for (const list of Object.values(status?.forwarded_ports ?? {}) as any[]) {
    for (const fp of list) if (fp.port === 26657) return `http://${fp.host}:${fp.externalPort}`;
  }
  throw new Error("no forwarded RPC");
}

function explain(db: ConductorDb, id: string): string {
  const step = db.listSteps(id).find((x) => x.status !== "done");
  return `${step?.name}: ${step?.error}`;
}

describe("relayer rendering", () => {
  it("tunnels this fleet's sentry-0 first, then each fleet counterparty on the next ports", () => {
    const s = spec("sparkdream", { domain: "hs.example" }, [
      osmosis,
      { id: "fed", kind: "federation", counterparty: { fleet: "fleet-b" } },
      { id: "xfer-b", kind: "transfer", counterparty: { fleet: "fleet-b" } },
    ]);
    expect(relayerTunnels(s)).toEqual([
      { local: 9090, remote: 9090, peer: "sentry-0" },
      { local: 26657, remote: 26657, peer: "sentry-0" },
      // one fleet, two paths: one tunnel pair
      { local: 9091, remote: 9090, peer: "sentry-0@fleet-b" },
      { local: 26658, remote: 26657, peer: "sentry-0@fleet-b" },
    ]);
  });

  it("renders a filter that admits each path's port before bringup and pins it after", () => {
    const db = new ConductorDb(path.join(tmp(), "state.db"));
    const s = spec("sparkdream", { domain: "hs.example" }, [osmosis]);
    const plan = relayPlan(db, "self", s);
    expect(plan.chains.map((c) => c.chainId)).toEqual([expect.stringMatching(/^sparkdream/), "osmo-test-5"]);
    expect(plan.paths).toEqual([
      expect.objectContaining({ id: "osmo", port: "transfer", version: "ics20-1", b: "osmo-test-5" }),
    ]);

    const before = renderHermesConfig(plan);
    expect(before).toContain("grpc_addr = 'http://127.0.0.1:9090'");
    expect(before).toContain("grpc_addr = 'http://grpc.osmotest5.example:9090'");
    expect(before).toContain("url = 'wss://rpc.osmotest5.example/websocket'");
    expect(before).toContain("list = [['transfer', '*']]");
    // gas price is always a TOML float (Hermes reads f64)
    expect(before).toMatch(/gas_price = \{ price = [0-9]+\.[0-9]+, denom = 'uosmo' \}/);
    expect(before).not.toMatch(/price = [0-9]+,/);
    // no trusting_period for chains that did not set one: Hermes derives it
    expect(before).not.toContain("trusting_period");
    // fixed price, push events and the 2.5 margin unless the counterparty says otherwise
    expect(before).not.toContain("dynamic_gas_price");
    expect(before).not.toContain("mode = 'pull'");
    expect(before.match(/gas_multiplier = 2\.5/g)).toHaveLength(2);

    const channels: RelayChannel[] = [
      {
        id: "osmo",
        port: "transfer",
        version: "ics20-1",
        a: { chain: plan.chains[0]!.chainId, client: "c", connection: "x", channel: "channel-3" },
        b: { chain: "osmo-test-5", client: "c", connection: "x", channel: "channel-812" },
      },
    ];
    const after = renderHermesConfig(plan, channels);
    expect(after).toContain("list = [['transfer', 'channel-3']]");
    expect(after).toContain("list = [['transfer', 'channel-812']]");
    expect(after).not.toContain("'*'");

    expect(JSON.parse(renderRelayManifest(plan))).toEqual({
      chains: [
        { id: plan.chains[0]!.chainId, hd_path: "m/44'/118'/0'/0/0" },
        { id: "osmo-test-5", hd_path: "m/44'/118'/0'/0/0" },
      ],
      paths: [{ id: "osmo", a: plan.chains[0]!.chainId, b: "osmo-test-5", port: "transfer", version: "ics20-1", order: "unordered" }],
    });
    db.close();
  });
});

/** An IBC Hermes to validate rendered configs with ($HERMES, else the
 *  one on PATH), or null. The name is checked: on some machines `hermes`
 *  is an unrelated program. */
function ibcHermes(): string | null {
  const bin = process.env.HERMES ?? "hermes";
  try {
    const v = execFileSync(bin, ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return /^hermes 1\./m.test(v) ? bin : null;
  } catch {
    return null;
  }
}

describe("relayer on a fee-market chain", () => {
  it("follows the fee market, polls instead of the websocket, and takes its own gas margin", () => {
    const db = new ConductorDb(path.join(tmp(), "state.db"));
    const plan = relayPlan(db, "self", spec("sparkdream", { domain: "hs.example" }, [osmosisMarket]));
    const text = renderHermesConfig(plan);
    const [own, osmo] = text.split("[[chains]]").slice(1);
    expect(osmo).toContain("dynamic_gas_price = { enabled = true, multiplier = 1.2, max = 0.1 }");
    expect(osmo).toContain("gas_price = { price = 0.0025, denom = 'uosmo' }");
    expect(osmo).toContain("event_source = { mode = 'pull', interval = '1s', max_retries = 4 }");
    expect(osmo).toContain("gas_multiplier = 1.5");
    // this fleet's chain keeps its fixed price, the websocket and 2.5
    expect(own).not.toContain("dynamic_gas_price");
    expect(own).toContain("event_source = { mode = 'push', url = 'ws://127.0.0.1:26657/websocket'");
    expect(own).toContain("gas_multiplier = 2.5");
    db.close();
  });

  it("asks for a top-up at the dynamic price's max, still under the cap", () => {
    // 1000 txs x 300k gas: 750000 at the fixed 0.0025, 30000000 at max 0.1
    expect(suggestedTopUp({ gasPrice: 0.0025 }, undefined)).toBe(750_000n);
    expect(suggestedTopUp({ gasPrice: 0.0025, dynamicGasPrice: { multiplier: 1.1, max: 0.1 } }, undefined)).toBe(30_000_000n);
    expect(suggestedTopUp({ gasPrice: 0.0025, dynamicGasPrice: { multiplier: 1.1, max: 0.1 } }, 5_000_000n)).toBe(5_000_000n);
  });
});

describe("relayer config against a real Hermes", () => {
  const hermes = ibcHermes();
  it.skipIf(!hermes)("hermes config validate accepts the rendered config, before and after pinning", () => {
    const dir = tmp();
    const db = new ConductorDb(path.join(dir, "state.db"));
    const plan = relayPlan(db, "self", spec("sparkdream", { domain: "hs.example" }, [osmosis]));
    const pinned: RelayChannel[] = [
      {
        id: "osmo",
        port: "transfer",
        version: "ics20-1",
        a: { chain: plan.chains[0]!.chainId, client: "c", connection: "x", channel: "channel-0" },
        b: { chain: "osmo-test-5", client: "c", connection: "x", channel: "channel-9" },
      },
    ];
    for (const [name, text] of [
      ["open.toml", renderHermesConfig(plan)],
      ["pinned.toml", renderHermesConfig(plan, pinned)],
      ["market.toml", renderHermesConfig(relayPlan(db, "self", spec("sparkdream", { domain: "hs.example" }, [osmosisMarket])))],
    ] as const) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text);
      // throws (non-zero exit) on an invalid config, with Hermes' reason
      const out = execFileSync(hermes!, ["--config", file, "config", "validate"], { encoding: "utf8" });
      expect(out).toContain("configuration is valid");
    }
    db.close();
  });
});

describe("relayer launch", () => {
  it("deploys in the node batch, funds its key in genesis, opens the sentry's gRPC, and links", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const s = spec("sparkdream", { domain: "hs.example" }, [osmosis]);
    const result = await launch(db, work, services, "fl", s);
    if (result.status !== "completed") throw new Error(explain(db, "fl"));

    // genesis funds the relayer's own-chain key
    const keys = db.stepOutput<{ accounts: Record<string, string> }>("fl", "generate-keys")!;
    const relayerAddr = keys.accounts.relayer!;
    expect(relayerAddr).toMatch(/^sprkdrm1/);
    const genesis = JSON.parse(
      fs.readFileSync(path.join(work, "launches", "fl", "nodes", "val-0", "config", "genesis.json"), "utf8"),
    );
    expect(genesis.app_state.bank.balances.some((b: any) => b.address === relayerAddr)).toBe(true);

    // the sentry's bundle serves gRPC beyond localhost for the relayer's tunnel
    const app = fs.readFileSync(path.join(work, "launches", "fl", "nodes", "sentry-0", "config", "app.toml"), "utf8");
    expect(app).toContain('address = "0.0.0.0:9090"');

    // linked: channels recorded, hermes config pinned to them, ready marker set
    const state = JSON.parse(fs.readFileSync(relayerStatePath(work, "fl"), "utf8")) as RelayerLinkOutput;
    expect(state.channels).toHaveLength(1);
    expect(state.chains.map((c) => c.address)).toEqual([relayerAddr, expect.stringMatching(/^osmo1/)]);
    new FleetService(db, services, work).materialize("fl");
    const row = db.listFleetComponents("fl").find((c) => c.key === "relayer")!;
    const id = `${row.ssh_host}:${row.ssh_port}`;
    expect(services.ssh.files.get(`${id}|/data/relayer/config.toml`)).toContain("['transfer', 'channel-0']");
    expect(services.ssh.relayerReady.has(id)).toBe(true);
    // mnemonics were uploaded for both chains (bringup deletes them there)
    expect(services.ssh.files.has(`${id}|/data/relayer/mnemonics/osmo-test-5.mnemonic`)).toBe(true);
    // the relayer's SDL tunnels resolved to sentry-0's tailnet IP at persist
    const sdl = fs.readFileSync(path.join(work, "launches", "fl", "sdl", "relayer.yaml"), "utf8");
    expect(sdl).not.toContain("{{");
    db.close();
  }, 120_000);

  it("pauses with the address and a capped amount to fund when a counterparty key cannot pay gas, then links", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    services.ssh.unfundedChains.add("osmo-test-5");
    const capped: RelayerPath = { ...osmosis, counterparty: { ...osmosis.counterparty, maxBalance: "2000000" } as any };
    const s = spec("sparkdream", { domain: "hs.example" }, [capped]);
    const paused = await launch(db, work, services, "fl", s);
    expect(paused.status).toBe("awaiting-user");
    // ~1000 relay txs of gas would be 7500000 uosmo: the cap wins
    expect(paused.reason).toMatch(/osmo-test-5: send about 2000000 uosmo to osmo1[0-9a-z]+ \(cap 2000000\)/);
    expect(paused.reason).toMatch(/sits on the relayer's provider/);
    expect(services.ssh.relayOpens).toBe(0);

    services.ssh.unfundedChains.clear();
    const done = await runWithSigner(db, "fl", s, work, allSteps(), services, new FakeSigner());
    if (done.status !== "completed") throw new Error(explain(db, "fl"));
    expect(services.ssh.relayOpens).toBe(1);
    // the fleet panel gets each key's balance against its cap
    const state = JSON.parse(fs.readFileSync(relayerStatePath(work, "fl"), "utf8")) as RelayerLinkOutput;
    expect(state.chains[0]).toMatchObject({ balance: "1000000", cap: "100000000" });
    expect(state.chains[1]).toMatchObject({ chainId: "osmo-test-5", cap: "2000000" });
    db.close();
  }, 120_000);

  it("asks for a small amount, not about 0, on a chain whose gas is free", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const s = spec("sparkdream", { domain: "hs.example" }, [osmosis]);
    s.token.minGasPrice = "0";
    services.ssh.unfundedChains.add(chainId(s));
    const paused = await launch(db, work, services, "fl", s);
    expect(paused.status).toBe("awaiting-user");
    expect(paused.reason).toContain(`${chainId(s)}: send a small amount of ${s.token.baseDenom} to sprkdrm1`);
    expect(paused.reason).toMatch(/gas is free there, but the key needs an account with a balance/);
    expect(paused.reason).not.toMatch(/about 0 /);
    db.close();
  }, 120_000);

  it("refuses a genesis balance above the relayer's cap, and warns that the key is hot", () => {
    const over = spec("sparkdream", { domain: "hs.example" }, [osmosis]);
    over.topology.components.relayer!.genesisBalance = "500000000";
    const res = validateSpec(over);
    expect(res.errors.map((e) => e.path)).toContain("topology.components.relayer.genesisBalance");
    const ok = validateSpec(spec("sparkdream", { domain: "hs.example" }, [osmosis]));
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.find((w) => w.path === "topology.components.relayer")?.message).toMatch(/hot key/);
  });
});

describe("relayer day-2", () => {
  it("reports hermes' own state, and a chain reset queues a relink behind it", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const s = spec("sparkdream", { domain: "hs.example" }, [osmosis]);
    const result = await launch(db, work, services, "fl", s);
    if (result.status !== "completed") throw new Error(explain(db, "fl"));
    const fleet = new FleetService(db, services, work);
    fleet.materialize("fl");

    const { relayer: descriptor } = await import("../src/components/relayer.js");
    const probe = descriptor.probe!;
    expect(probe.verdict("relaying\n")).toEqual({ healthy: true, detail: "hermes relaying" });
    expect(probe.verdict("unlinked")).toMatchObject({ healthy: true });
    expect(probe.verdict("down")).toMatchObject({ healthy: false });

    const opId = await fleet.requestChainReset(db.getLaunch("fl")!, JSON.parse(db.getLaunch("fl")!.spec_json));
    const ops = db.listFleetOps("fl", "active");
    expect(ops.map((o) => o.kind)).toEqual(["reset-chain", "relink"]);
    expect(ops[0]!.id).toBe(opId);
    db.close();
  }, 120_000);
});

describe("relayer between two fleets", () => {
  it("adds a relayer to a sister fleet on the shared mesh: its sentry serves gRPC, tunnels aim at it", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const fleet = new FleetService(db, services, work);

    const specA = spec("sparkdream", { domain: "hs.example" });
    const a = await launch(db, work, services, "fleet-a", specA);
    if (a.status !== "completed") throw new Error(explain(db, "fleet-a"));
    fleet.materialize("fleet-a");
    const specB = spec("sparkdreamtwo", { reuseFleet: "fleet-a", domain: "hs.example" });
    const b = await launch(db, work, services, "fleet-b", specB);
    if (b.status !== "completed") throw new Error(explain(db, "fleet-b"));
    fleet.materialize("fleet-b");

    // B adds a relayer with a federation + transfer path to A, by name
    fleet.requestAddComponent(db.getLaunch("fleet-b")!, "relayer", {
      paths: [
        { id: "fed-a", kind: "federation", counterparty: { fleet: "sparkdream" } },
        { id: "xfer-a", kind: "transfer", counterparty: { fleet: "sparkdream" } },
      ],
    });
    const stored = JSON.parse(db.getLaunch("fleet-b")!.spec_json) as LaunchSpec;
    // the name resolved to the launch id, which keys tunnels and funding
    expect(stored.topology.components.relayer!.paths.map((p) => p.counterparty)).toEqual([
      { fleet: "fleet-a" },
      { fleet: "fleet-a" },
    ]);
    const ops = [...buildPreLaunchOpSteps(db, "fleet-b"), ...allSteps(), ...buildOpSteps(db, "fleet-b")];
    // the peer link signs on both chains through the chain CLI: a stub chain
    const chain = chainStub();
    const done = await withStub(chain, () => runWithSigner(db, "fleet-b", specB, work, ops, services, new FakeSigner()));
    if (done.status !== "completed") throw new Error(explain(db, "fleet-b"));
    expect(db.listFleetOps("fleet-b").find((o) => o.kind === "add-component")!.status).toBe("done");

    // A's sentry was opened for the relayer (gRPC on all interfaces) and bounced
    const sentryA = db.listFleetComponents("fleet-a").find((c) => c.key === "sentry-0")!;
    const aId = `${sentryA.ssh_host}:${sentryA.ssh_port}`;
    expect(services.ssh.appToml.get(aId)).toContain('address = "0.0.0.0:9090"');
    expect(services.ssh.execLog.some((e) => e.target === aId && /pkill -x sparkdreamd/.test(e.command))).toBe(true);

    // the relayer tunnels to A's sentry at its live tailnet IP
    const sdl = fs.readFileSync(path.join(work, "launches", "fleet-b", "sdl", "relayer.yaml"), "utf8");
    expect(sdl).toContain(`9091:${sentryA.tailnet_ip}:9090`);
    expect(sdl).toContain(`26658:${sentryA.tailnet_ip}:26657`);

    // two paths, one counterparty: both channels recorded, filter pinned per port
    const state = fleet.relayerState(db.getLaunch("fleet-b")!)!;
    expect(state.channels.map((c) => [c.id, c.port])).toEqual([
      ["fed-a", "federation"],
      ["xfer-a", "transfer"],
    ]);
    const relayer = db.listFleetComponents("fleet-b").find((c) => c.key === "relayer")!;
    const config = services.ssh.files.get(`${relayer.ssh_host}:${relayer.ssh_port}|/data/relayer/config.toml`)!;
    expect(config).toContain("['federation', 'channel-0'], ['transfer', 'channel-1']");
    // federation: each chain registered the other on the relayer's channels,
    // with the transfer channel for voucher metadata, and activated it
    const chains = Object.values(chain.state().chains);
    const peerOn = (id: string) => chains.map((c) => c.peers[id]).find(Boolean);
    const aOnB = peerOn(chainId(specA))!;
    const bOnA = peerOn(chainId(specB))!;
    expect(aOnB).toMatchObject({ status: "PEER_STATUS_ACTIVE", ibc_channel_id: "channel-0", ibc_transfer_channel_id: "channel-1" });
    expect(bOnA).toMatchObject({ status: "PEER_STATUS_ACTIVE", ibc_channel_id: "channel-0", ibc_transfer_channel_id: "channel-1" });
    // each side signed with its own fleet's launcher-held founder key
    expect(new Set(chain.state().log.map((l) => l.from))).toEqual(new Set(["acct-founder"]));
    expect(new Set(chain.state().log.map((l) => l.node)).size).toBe(2);
    expect(state.peers?.map((p) => p.status)).toEqual(["PEER_STATUS_ACTIVE", "PEER_STATUS_ACTIVE"]);

    // the relayer's account is listed with the fleet's generated accounts
    expect(fleet.accounts(db.getLaunch("fleet-b")!).find((x) => x.name === "relayer")).toMatchObject({
      hasMnemonic: true,
    });

    // A moves its sentry: the relayer in fleet B is re-aimed at the new
    // tailnet IP, and the fresh sentry keeps serving gRPC for it
    const launchA = db.getLaunch("fleet-a")!;
    await fleet.requestRelaunch(launchA, sentryA);
    services.api.leaseStates.set(sentryA.dseq, "closed");
    services.ssh.failHosts.add(aId);
    const moved = await runWithSigner(
      db,
      "fleet-a",
      specA,
      work,
      [...buildPreLaunchOpSteps(db, "fleet-a"), ...allSteps(), ...buildOpSteps(db, "fleet-a")],
      services,
      new FakeSigner(),
    );
    if (moved.status !== "completed") throw new Error(explain(db, "fleet-a"));
    const sentryA2 = db.listFleetComponents("fleet-a").find((c) => c.key === "sentry-0")!;
    expect(sentryA2.tailnet_ip).not.toBe(sentryA.tailnet_ip);
    const sdl2 = fs.readFileSync(path.join(work, "launches", "fleet-b", "sdl", "relayer.yaml"), "utf8");
    expect(sdl2).toContain(`9091:${sentryA2.tailnet_ip}:9090`);
    expect(sdl2).not.toContain(`${sentryA.tailnet_ip}:`);
    expect(services.ssh.appToml.get(`${sentryA2.ssh_host}:${sentryA2.ssh_port}`)).toContain('address = "0.0.0.0:9090"');

    // relink reuses every open channel: nothing reopened, hermes restarted
    const opens = services.ssh.relayOpens;
    fleet.requestRelink(db.getLaunch("fleet-b")!);
    // fleet A's sentry moved above, and its RPC with it; the chain did not
    const aNode = Object.entries(chain.state().chains).find(([, c]) => c.peers[chainId(specB)])![0];
    const aRpc = await nodeRpcUrlFor(services, sentryA2);
    chain.edit((st) => (st.aliases = { [aRpc]: aNode }));
    const txsBefore = chain.state().log.length;
    const relinked = await withStub(chain, () =>
      runWithSigner(
        db,
        "fleet-b",
        specB,
        work,
        [...buildPreLaunchOpSteps(db, "fleet-b"), ...allSteps(), ...buildOpSteps(db, "fleet-b")],
        services,
        new FakeSigner(),
      ),
    );
    // peers already active: the relink's peer pass sends nothing
    expect(chain.state().log).toHaveLength(txsBefore);
    expect(relinked.status).toBe("completed");
    expect(services.ssh.relayOpens).toBe(opens);
    expect(
      services.ssh.execLog.some(
        (e) => e.target === `${relayer.ssh_host}:${relayer.ssh_port}` && e.command.includes("kill 1"),
      ),
    ).toBe(true);
    db.close();
  }, 180_000);

  it("changes a running relayer's paths: a new fleet counterparty retunnels in place, an endpoint change only relinks", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const fleet = new FleetService(db, services, work);
    const specA = spec("sparkdream", { domain: "hs.example" });
    const a = await launch(db, work, services, "fleet-a", specA);
    if (a.status !== "completed") throw new Error(explain(db, "fleet-a"));
    fleet.materialize("fleet-a");
    const specB = spec("sparkdreamtwo", { reuseFleet: "fleet-a", domain: "hs.example" }, [osmosis]);
    const b = await launch(db, work, services, "fleet-b", specB);
    if (b.status !== "completed") throw new Error(explain(db, "fleet-b"));
    fleet.materialize("fleet-b");
    const relayer = db.listFleetComponents("fleet-b").find((c) => c.key === "relayer")!;
    const sentryA = db.listFleetComponents("fleet-a").find((c) => c.key === "sentry-0")!;
    const run = async () => {
      const signer = new FakeSigner();
      const res = await runWithSigner(
        db,
        "fleet-b",
        specB,
        work,
        [...buildPreLaunchOpSteps(db, "fleet-b"), ...allSteps(), ...buildOpSteps(db, "fleet-b")],
        services,
        signer,
      );
      if (res.status !== "completed") throw new Error(explain(db, "fleet-b"));
      return signer.signed.flat().map((m) => m.typeUrl);
    };

    // add a transfer path to fleet A, by name: a new tunnel, one update tx
    const xferA: RelayerPath = { id: "xfer-a", kind: "transfer", counterparty: { fleet: "sparkdream" } };
    fleet.requestRelayerPaths(db.getLaunch("fleet-b")!, [osmosis, xferA]);
    expect(JSON.parse(db.listFleetOps("fleet-b", "active")[0]!.params_json)).toEqual({ retunnel: true });
    const stored = JSON.parse(db.getLaunch("fleet-b")!.spec_json) as LaunchSpec;
    expect(stored.topology.components.relayer!.paths[1]!.counterparty).toEqual({ fleet: "fleet-a" });
    expect(() => fleet.requestRelayerPaths(db.getLaunch("fleet-b")!, [osmosis])).toThrow(/busy with a relayer-paths op/);
    const opens = services.ssh.relayOpens;
    const signed = await run();
    expect(signed.filter((t) => /MsgUpdateDeployment/.test(t))).toHaveLength(1);
    const sdl = fs.readFileSync(path.join(work, "launches", "fleet-b", "sdl", "relayer.yaml"), "utf8");
    expect(sdl).toContain(`TS_TUNNEL_3=9091:${sentryA.tailnet_ip}:9090`);
    expect(sdl).toContain(`TS_TUNNEL_4=26658:${sentryA.tailnet_ip}:26657`);
    // A's sentry opened its gRPC for the tunnel; the new channel opened
    const aId = `${sentryA.ssh_host}:${sentryA.ssh_port}`;
    expect(services.ssh.appToml.get(aId)).toContain('address = "0.0.0.0:9090"');
    expect(services.ssh.relayOpens).toBeGreaterThan(opens);
    const state = fleet.relayerState(db.getLaunch("fleet-b")!)!;
    expect(state.channels.map((c) => c.id)).toEqual(["osmo", "xfer-a"]);
    expect(db.listFleetOps("fleet-b").find((o) => o.kind === "relayer-paths")!.status).toBe("done");

    // drop the Osmosis path: same tunnels, so no signature, just a relink
    fleet.requestRelayerPaths(db.getLaunch("fleet-b")!, [xferA]);
    expect(JSON.parse(db.listFleetOps("fleet-b", "active")[0]!.params_json)).toEqual({ retunnel: false });
    expect(await run()).toEqual([]);
    const config = services.ssh.files.get(`${relayer.ssh_host}:${relayer.ssh_port}|/data/relayer/config.toml`)!;
    expect(config).not.toContain("osmo-test-5");
    expect(fleet.relayerState(db.getLaunch("fleet-b")!)!.channels.map((c) => c.id)).toEqual(["xfer-a"]);
    db.close();
  }, 180_000);

  it("refuses a counterparty fleet it could not reach", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const specA = spec("sparkdream", { domain: "hs.example" });
    const a = await launch(db, work, services, "fleet-a", specA);
    if (a.status !== "completed") throw new Error(explain(db, "fleet-a"));
    new FleetService(db, services, work).materialize("fleet-a");

    // its own mesh: A's sentry gRPC is not on this tailnet
    const alone = spec("sparkdreamtwo", { domain: "hs2.example" });
    expect(() => resolveRelayFleet(db, alone, "akash1owner", "sparkdream")).toThrow(/different mesh/);
    // somebody else's fleet
    const shared = spec("sparkdreamtwo", { reuseFleet: "fleet-a", domain: "hs.example" });
    expect(() => resolveRelayFleet(db, shared, "akash1other", "fleet-a")).toThrow(/different wallet/);
    expect(() => resolveRelayFleet(db, shared, "akash1owner", "nope")).toThrow(/no such fleet/);
    expect(resolveRelayFleet(db, shared, "akash1owner", "sparkdream")).toBe("fleet-a");
    db.close();
  }, 120_000);
});
