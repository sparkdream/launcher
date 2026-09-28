import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";
import { bridgeAccount, testnetSpec, validateSpec, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { launchDirs, runWithSigner } from "../src/engine.js";
import { allSteps } from "../src/index.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps } from "../src/fleet-ops.js";
import { descriptorFor } from "../src/components/index.js";
import { readSessions } from "../src/sessions.js";
import { buildServer } from "../src/server.js";
import { readMastodonSecrets, updateMastodonSecrets } from "../src/components/mastodon-secrets.js";
import { fakeServices, FakeSigner } from "./fakes.js";
import { chainStub, withStub } from "./chain-stub.js";

/**
 * A services fleet (spec.kind "services"): a Mastodon with no chain of its
 * own, linked to a chain fleet by that fleet's standalone bridge.
 */

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-services-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const DOMAIN = "social.zenith.example";
const owner = { username: "admin", email: "admin@zenith.example" };
const off = { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } };
/** Images from the first release carrying wallet sign-in. */
const LOGIN_IMAGES = { sdap: "sparkdreamnft/sdap:v1.0.46", mastodon: "sparkdreamnft/mastodon:v1.0.46" };

function servicesSpec(): LaunchSpec {
  return testnetSpec({
    kind: "services",
    network: { name: "zenith-commons", type: "testnet", bech32Prefix: "sprkdrm" },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: { ...off, mastodon: { enabled: true, domain: DOMAIN, owner } },
      headscale: {},
    },
  } as any);
}

function chainSpec(): LaunchSpec {
  return testnetSpec({
    network: { name: "phoenix", type: "devnet", bech32Prefix: "sprkdrm" },
    accounts: {
      initial: [
        { name: "founder", generate: true, amount: "1000000000000", member: true, council: { founder: true } },
        { name: "vera", generate: true, amount: "10000000000", member: { trustLevel: "established", dreamBalance: "1000000000" } },
      ],
      validatorSelfDelegation: "1000000000000",
    },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: off,
      publicEndpoints: { api: "api.phoenix.example", rpc: "rpc.phoenix.example" },
      headscale: { domain: "hs.phoenix.example" },
    },
  } as any);
}

describe("services fleet", () => {
  it("validates as a fleet of shared components only", () => {
    expect(validateSpec(servicesSpec()).errors).toEqual([]);
    const withExplorer = servicesSpec();
    (withExplorer.topology.components as any).explorer = { enabled: true, domain: "explorer.zenith.example" };
    expect(validateSpec(withExplorer).errors.map((e) => e.path)).toContain("topology.components.explorer");
    const withBridge = servicesSpec();
    withBridge.topology.components.mastodon!.bridge = { enabled: true } as any;
    expect(validateSpec(withExplorer).errors.length).toBeGreaterThan(0);
    expect(validateSpec(withDefaults(withBridge as any)).errors.map((e) => e.path)).toContain("topology.components.mastodon.bridge");
  });

  it("is priced for its components only: no validator, sentry or headscale", async () => {
    const { estimateLaunchCost } = await import("../src/estimate.js");
    expect(estimateLaunchCost(servicesSpec()).perRole.map((r) => r.role)).toEqual(["mastodon"]);
  });

  it("launches its Mastodon with no nodes, no mesh and no chain, and refuses chain actions", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const s = servicesSpec();
    db.createLaunch("svc", JSON.stringify(s), "akash1owner");
    const result = await runWithSigner(db, "svc", s, work, allSteps(s), services, new FakeSigner());
    expect(result.reason ?? "").toBe("");
    expect(result.status).toBe("completed");
    // no chain-launch step ran
    const names = db.listSteps("svc").map((x) => x.name);
    expect(names).not.toContain("build-genesis");
    expect(names).not.toContain("deploy-headscale");
    expect(names).toContain("verify-services");
    expect(db.stepOutput<any>("svc", "configure-mastodon")).toMatchObject({ owner: `@admin@${DOMAIN}`, created: true });

    const fleet = new FleetService(db, services, work);
    fleet.materialize("svc");
    expect(db.listFleetComponents("svc").map((c) => c.key)).toEqual(["mastodon"]);
    const view = await fleet.fleetForOwner("akash1owner");
    expect(view.fleets[0]).toMatchObject({ kind: "services", name: "zenith-commons" });
    await fleet.tick("svc");
    expect(() => fleet.requestChainReset(db.getLaunch("svc")!, s)).toThrow(/no chain to reset/);
    expect(() => fleet.requestHaltUpgrade(db.getLaunch("svc")!, "x:y", 10)).toThrow(/no chain/);
    db.close();
  }, 120_000);
});

describe("landing page hub", () => {
  it("renders a static site on its domain, with no env and nothing chain-specific", () => {
    const s = servicesSpec();
    (s.topology.components as any).hub = { enabled: true, domain: "zenith.example" };
    const spec = withDefaults(s as any);
    expect(validateSpec(spec).errors).toEqual([]);
    expect(spec.images.hub).toMatch(/^sparkdreamnft\/hub:/);
    const out = descriptorFor("hub")!.render({
      spec,
      component: { key: "hub", image: spec.images.hub, domain: "zenith.example" },
    } as any) as any;
    expect(out.hub.service).toEqual({
      image: spec.images.hub,
      expose: [{ port: 80, as: 80, accept: ["zenith.example"], to: [{ global: true }] }],
    });
    // a domain is required, as for every public kind
    (s.topology.components as any).hub = { enabled: true };
    expect(validateSpec(withDefaults(s as any)).errors.map((e) => e.path)).toContain("topology.components.hub.domain");
  });

  it("is added to a running services fleet beside its Mastodon", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const signer = new FakeSigner();
    const s = servicesSpec();
    db.createLaunch("svc", JSON.stringify(s), "akash1owner");
    expect((await runWithSigner(db, "svc", s, work, allSteps(s), services, signer)).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("svc");

    fleet.requestAddComponent(db.getLaunch("svc")!, "hub", { domain: "zenith.example" });
    const stored = JSON.parse(db.getLaunch("svc")!.spec_json) as LaunchSpec;
    expect(stored.topology.components.hub).toMatchObject({ enabled: true, domain: "zenith.example" });
    const done = await runWithSigner(
      db, "svc", stored, work,
      [...buildPreLaunchOpSteps(db, "svc"), ...allSteps(stored), ...buildOpSteps(db, "svc")],
      services, signer,
    );
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
    expect(db.listFleetOps("svc").find((o) => o.kind === "add-component")!.status).toBe("done");
    const rows = db.listFleetComponents("svc").filter((c) => c.state !== "closed");
    expect(rows.map((c) => c.key).sort()).toEqual(["hub", "mastodon"]);
    db.close();
  }, 120_000);
});

describe("re-placing a services fleet's Mastodon mid-launch", () => {
  it("parks with the bids at its DNS pause, leases the pick, and re-runs the domain check and setup", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const signer = new FakeSigner();
    const s = servicesSpec();
    db.createLaunch("svc", JSON.stringify(s), "akash1owner");
    // the instance's domain is not pointed anywhere yet: the launch waits on DNS
    services.rpc.darkUrls.add(DOMAIN);
    const paused = await runWithSigner(db, "svc", s, work, allSteps(s), services, signer);
    expect(paused.status).toBe("awaiting-user");
    expect(db.getStep("svc", "verify-services")?.status).toBe("waiting");

    const fleet = new FleetService(db, services, work);
    fleet.materialize("svc");
    const mastodon = db.listFleetComponents("svc").find((c) => c.key === "mastodon")!;
    services.provider.leaselessDseqs.add(mastodon.dseq);
    (services.api as any).leaseStates.set(mastodon.dseq, "closed");
    db.requestBidPick("svc", "mastodon");
    await fleet.requestReplace(db.getLaunch("svc")!, mastodon);

    const parked = await runWithSigner(db, "svc", s, work, allSteps(s), services, signer);
    expect(parked.status).toBe("awaiting-user");
    const bids = JSON.parse(db.getBidPick("svc", "mastodon")!.offers_json!) as Array<{ provider: string }>;
    const pick = bids.find((b) => b.provider !== mastodon.provider)!;
    db.setBidPick("svc", "mastodon", pick.provider);
    services.rpc.darkUrls.delete(DOMAIN);

    const done = await runWithSigner(db, "svc", s, work, allSteps(s), services, signer);
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
    const assignments = db.stepOutput<any>("svc", "collect-bids")!;
    expect(assignments.perNode.mastodon.provider).toBe(pick.provider);
    expect(db.stepOutput<any>("svc", "create-deployments")!.perNode.mastodon.dseq).not.toBe(mastodon.dseq);
    expect(db.getStep("svc", "verify-services")?.status).toBe("done");
    // the new instance got its owner
    expect(db.stepOutput<any>("svc", "configure-mastodon")).toMatchObject({ owner: `@admin@${DOMAIN}` });
    // no chain step was touched along the way
    expect(db.listSteps("svc").map((x) => x.name)).not.toContain("upload-node-data");
    db.close();
  }, 180_000);
});

describe("standalone bridge", () => {
  it("names its account by the network it anchors to", () => {
    const c = chainSpec();
    expect(bridgeAccount(c)).toBe("bridgedev");
    expect(bridgeAccount({ ...c, network: { ...c.network, type: "testnet" } })).toBe("bridgetest");
    expect(bridgeAccount({ ...c, network: { ...c.network, type: "mainnet" } })).toBe("bridge");
  });

  it("links a chain fleet to the services fleet's Mastodon, keeps the verifier off its host, and holds the services fleet up", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const chain = chainStub();
    const svc = servicesSpec();
    db.createLaunch("svc", JSON.stringify(svc), "akash1owner");
    expect((await runWithSigner(db, "svc", svc, work, allSteps(svc), services, new FakeSigner())).status).toBe("completed");
    const c = chainSpec();
    chain.edit((st) => (st.defaultBalances = { [c.token.baseDenom]: "2000000000" }));
    db.createLaunch("fl", JSON.stringify(c), "akash1owner");
    const launched = await withStub(chain, () => runWithSigner(db, "fl", c, work, allSteps(c), services, new FakeSigner()));
    expect(launched.reason ?? "").toBe("");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("svc");
    fleet.materialize("fl");

    // added by the services fleet's name: resolved to its id and domain
    fleet.requestAddComponent(db.getLaunch("fl")!, "bridge", { settings: { target: { fleet: "zenith-commons" } } });
    const stored = JSON.parse(db.getLaunch("fl")!.spec_json);
    expect(stored.topology.components.bridge.target).toEqual({ fleet: "svc", domain: DOMAIN });
    const spec = withDefaults(stored);
    const run = () =>
      withStub(chain, () =>
        runWithSigner(db, "fl", spec, work, [...buildPreLaunchOpSteps(db, "fl"), ...allSteps(spec), ...buildOpSteps(db, "fl")], services, new FakeSigner()),
      );
    // the bridge restarts on its token's deployment update just before its
    // session key is written: lease-shell has no replica for a while
    services.provider.sessionKeyNotReady = 2;
    const done = await run();
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
    expect(services.provider.sessionKeyNotReady).toBe(0);

    // the chain side: the instance as a peer, the operator bonded for it
    const operator = fs.readFileSync(path.join(launchDirs(work, "fl").secrets, "bridge-operator.address"), "utf8").trim();
    const node = Object.values(chain.state().chains).find((x) => x.peers?.[DOMAIN])!;
    expect(node.peers[DOMAIN]).toMatchObject({ type: "PEER_TYPE_ACTIVITYPUB", status: "PEER_STATUS_ACTIVE" });
    expect(node.bindings![`${operator}/${DOMAIN}`]).toMatchObject({ signer: "bridge-operator" });
    // the Mastodon side: @bridgedev made on the services fleet's instance
    const mastodonRow = db.listFleetComponents("svc").find((x) => x.key === "mastodon")!;
    expect([...services.provider.mastodon.get(mastodonRow.dseq)!.accounts]).toContain("bridgedev");
    // the bridge's own deployment points at that instance and holds the token
    const sdl = yaml.load(fs.readFileSync(path.join(work, "launches", "fl", "sdl", "bridge.yaml"), "utf8")) as any;
    expect(sdl.services.bridge.env).toEqual(
      expect.arrayContaining([
        `MASTODON_URL=https://${DOMAIN}`,
        `MASTODON_TOKEN=token-${mastodonRow.dseq}`,
        `SDA_PEER_IDS=${DOMAIN}`,
        `SDA_GRANTER=${operator}`,
        "SDA_LCD=https://api.phoenix.example",
      ]),
    );
    expect(sdl.services.bridge.expose).toEqual([{ port: 8080, as: 8080, proto: "tcp", to: [{ global: true }] }]);
    // its session key, from the operator, delivered to the bridge deployment
    const session = readSessions(launchDirs(work, "fl").secrets).bridge!;
    const bridgeRow = db.listFleetComponents("fl").find((x) => x.key === "bridge")!;
    expect(session.granter).toBe(operator);
    expect(services.provider.sessionKeys.get(`${bridgeRow.dseq}/bridge`)).toBe(session.mnemonic);

    // a verifier of this chain keeps off the services fleet's Mastodon host
    const withVerifier = withDefaults({ ...stored, topology: { ...stored.topology, components: { ...stored.topology.components, verifier: { enabled: true, account: "vera" } } } });
    const avoid = descriptorFor("verifier")!.avoidProviders!({ db, launchId: "fl", spec: withVerifier, assigned: {} });
    expect(avoid).toEqual([mastodonRow.provider]);

    // the services fleet cannot be shut down under a live bridge
    await expect(fleet.requestShutdown(db.getLaunch("svc")!)).rejects.toThrow(/close their bridge components first/);
    expect(fleet.closeWarnings(db.getLaunch("svc")!, mastodonRow).join(" ")).toMatch(/phoenix bridge this instance/);
    db.close();
  }, 300_000);
});

describe("wallet sign-in on a services fleet", () => {
  it("offers every chain whose bridge links the instance, and drops one when its bridge closes", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const chain = chainStub();
    const svc = withDefaults({
      ...JSON.parse(JSON.stringify(servicesSpec())),
      images: { ...servicesSpec().images, ...LOGIN_IMAGES },
      topology: {
        ...servicesSpec().topology,
        components: { ...off, mastodon: { enabled: true, domain: DOMAIN, owner, walletLogin: { enabled: true } } },
      },
    });
    expect(validateSpec(svc).errors).toEqual([]);
    db.createLaunch("svc", JSON.stringify(svc), "akash1owner");
    expect((await runWithSigner(db, "svc", svc, work, allSteps(svc), services, new FakeSigner())).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("svc");
    const mastodonRow = db.listFleetComponents("svc").find((x) => x.key === "mastodon")!;
    const offered = () => Object.keys(services.provider.mastodon.get(mastodonRow.dseq)!.loginChains ?? {}).sort();
    // no chain links it yet: configure synced an empty list
    expect(services.provider.mastodon.get(mastodonRow.dseq)!.loginChains).toEqual({});

    // two chain fleets, each linking the instance with a standalone bridge
    const chains = { fl: chainSpec(), fl2: chainSpec() };
    chains.fl2 = withDefaults({
      ...JSON.parse(JSON.stringify(chains.fl2)),
      network: { ...chains.fl2.network, name: "aurora" },
      topology: { ...chains.fl2.topology, publicEndpoints: { api: "api.aurora.example", rpc: "rpc.aurora.example" }, headscale: { domain: "hs.aurora.example" } },
    });
    for (const [id, c] of Object.entries(chains)) {
      chain.edit((st) => (st.defaultBalances = { [c.token.baseDenom]: "2000000000" }));
      db.createLaunch(id, JSON.stringify(c), "akash1owner");
      const launched = await withStub(chain, () => runWithSigner(db, id, c, work, allSteps(c), services, new FakeSigner()));
      expect(launched.reason ?? "").toBe("");
      fleet.materialize(id);
      fleet.requestAddComponent(db.getLaunch(id)!, "bridge", { settings: { target: { fleet: "svc" } } });
      const spec = withDefaults(JSON.parse(db.getLaunch(id)!.spec_json));
      const done = await withStub(chain, () =>
        runWithSigner(db, id, spec, work, [...buildPreLaunchOpSteps(db, id), ...allSteps(spec), ...buildOpSteps(db, id)], services, new FakeSigner()),
      );
      expect(done.reason ?? "").toBe("");
    }
    expect(offered()).toEqual(["fl", "fl2"]);
    const entry = services.provider.mastodon.get(mastodonRow.dseq)!.loginChains!.fl2;
    expect(entry).toMatchObject({ rest: "https://api.aurora.example", rpc: "https://rpc.aurora.example", minTrustLevel: "TRUST_LEVEL_NEW" });

    // phoenix closes its bridge: once the close settles, the instance re-syncs without it
    const bridgeRow = db.listFleetComponents("fl").find((x) => x.key === "bridge")!;
    fleet.requestClose(db.getLaunch("fl")!, bridgeRow);
    db.setPendingTxSigned("fl", `fleet:close:${bridgeRow.dseq}`, "CD".repeat(32));
    expect(await fleet.settleFleetTxs("fl")).toEqual(["svc"]);
    const resynced = await runWithSigner(db, "svc", svc, work, buildOpSteps(db, "svc"), services, new FakeSigner());
    expect(resynced.reason ?? "").toBe("");
    expect(offered()).toEqual(["fl2"]);
    db.close();
  }, 400_000);
});

describe("mastodon settings on a services fleet", () => {
  it("turns wallet sign-in on by moving the instance, with no chain to offer until one links it", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const svc = withDefaults({ ...JSON.parse(JSON.stringify(servicesSpec())), images: { ...servicesSpec().images, ...LOGIN_IMAGES } });
    db.createLaunch("svc", JSON.stringify(svc), "akash1owner");
    expect((await runWithSigner(db, "svc", svc, work, allSteps(svc), services, new FakeSigner())).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("svc");
    const before = db.listFleetComponents("svc").find((x) => x.key === "mastodon")!;

    const { move } = fleet.requestMastodonSettings(db.getLaunch("svc")!, before, { walletLogin: { enabled: true } });
    expect(move).toBe(true);
    const done = await runWithSigner(
      db, "svc", svc, work, [...buildPreLaunchOpSteps(db, "svc"), ...allSteps(svc), ...buildOpSteps(db, "svc")], services, new FakeSigner(),
    );
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
    const after = db.listFleetComponents("svc").find((x) => x.key === "mastodon")!;
    expect(after.dseq).not.toBe(before.dseq);
    const sdl = yaml.load(fs.readFileSync(path.join(work, "launches", "svc", "sdl", "mastodon.yaml"), "utf8")) as any;
    expect(Object.keys(sdl.services)).toContain("login");
    // a services fleet has no chain of its own: nothing to offer until one links it
    expect(services.provider.mastodon.get(after.dseq)!.loginChains).toEqual({});
    db.close();
  }, 300_000);
});

describe("a second Mastodon on an existing instance's domain", () => {
  it("is refused, pointing at the bridge component", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const chain = chainStub();
    const svc = servicesSpec();
    db.createLaunch("svc", JSON.stringify(svc), "akash1owner");
    expect((await runWithSigner(db, "svc", svc, work, allSteps(svc), services, new FakeSigner())).status).toBe("completed");
    const c = chainSpec();
    db.createLaunch("fl", JSON.stringify(c), "akash1owner");
    expect((await withStub(chain, () => runWithSigner(db, "fl", c, work, allSteps(c), services, new FakeSigner()))).reason ?? "").toBe("");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("fl");

    expect(() => fleet.requestAddComponent(db.getLaunch("fl")!, "mastodon", { domain: DOMAIN, settings: { owner } })).toThrow(
      /already served by fleet "zenith-commons".*add a bridge component targeting "zenith-commons"/,
    );
    // nothing was queued or written
    expect(db.listFleetOps("fl", "active")).toEqual([]);
    expect(JSON.parse(db.getLaunch("fl")!.spec_json).topology.components.mastodon?.enabled ?? false).toBe(false);
    // another wallet's instance, not shared with this one: no bridge to suggest
    const foreign = JSON.parse(JSON.stringify(servicesSpec()));
    foreign.network.name = "aurora-commons";
    foreign.topology.components.mastodon.domain = "social.aurora.example";
    db.createLaunch("foreign", JSON.stringify(foreign), "akash1otherwallet");
    expect(() =>
      fleet.requestAddComponent(db.getLaunch("fl")!, "mastodon", { domain: "social.aurora.example", settings: { owner } }),
    ).toThrow(/another wallet's Mastodon on this launcher: choose a domain/);
    // an instance of its own, on its own domain, is still fine
    expect(() => fleet.requestAddComponent(db.getLaunch("fl")!, "mastodon", { domain: "social.phoenix.example", settings: { owner } })).not.toThrow();
    db.close();
  }, 300_000);
});

describe("services spec builder", () => {
  it("drafts a services fleet from a fleet's Mastodon settings, and copies its SMTP password at creation", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const app = buildServer({ db, workRoot: work, steps: allSteps(), services: fakeServices() });
    // a chain fleet whose (closed, removed) Mastodon left its settings behind
    const src = chainSpec();
    (src.topology.components as any).mastodon = {
      enabled: false,
      domain: "mastodon.phoenix.example",
      owner,
      size: "small",
      registrations: "approved",
      smtp: { server: "smtp.relay.example", port: 587, login: "apikey", fromAddress: "Mastodon <n@phoenix.example>", security: "starttls", authMethod: "plain" },
      bridge: { enabled: true },
    };
    db.createLaunch("src", JSON.stringify(src), "akash1owner");
    updateMastodonSecrets(launchDirs(work, "src").secrets, { smtpPassword: "relay-secret" });

    const draft = await app.inject({
      method: "GET",
      url: "/api/fleet/src/services-spec?name=zenith-commons&domain=mstdn.zenith.example&streamingDomain=mstdn-streaming.zenith.example",
      headers: { "x-launcher-owner": "akash1owner" },
    });
    expect(draft.statusCode).toBe(200);
    const body = draft.json() as { spec: any; notes: string[]; issues: Array<{ warning?: boolean; message: string }> };
    expect(body.issues.filter((i) => !i.warning)).toEqual([]);
    expect(body.spec).toMatchObject({
      kind: "services",
      network: { name: "zenith-commons" },
      topology: { components: { mastodon: { enabled: true, domain: "mstdn.zenith.example", streamingDomain: "mstdn-streaming.zenith.example", owner } } },
    });
    expect(body.spec.topology.components.mastodon.bridge).toBeUndefined();
    expect(body.spec.topology.components.mastodon.smtp).toMatchObject({ server: "smtp.relay.example", passwordFromFleet: "src" });
    expect(JSON.stringify(body)).not.toContain("relay-secret");

    const created = await app.inject({ method: "POST", url: "/api/launches", payload: { spec: body.spec, owner: "akash1owner" } });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };
    expect(readMastodonSecrets(launchDirs(work, id).secrets)?.smtpPassword).toBe("relay-secret");
    const stored = db.getLaunch(id)!.spec_json;
    expect(stored).not.toContain("relay-secret");
    expect(stored).not.toContain("passwordFromFleet");
    db.close();
  }, 120_000);
});

describe("new services fleet from scratch", () => {
  it("drafts a services fleet from a few answers, with nothing chain-shaped to fill in", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const app = buildServer({ db, workRoot: work, steps: allSteps(), services: fakeServices() });
    expect((await app.inject({ method: "POST", url: "/api/services-spec", payload: { name: "x" } })).statusCode).toBe(400);
    const draft = await app.inject({
      method: "POST",
      url: "/api/services-spec",
      payload: { name: "zenith-commons", domain: "mstdn.zenith.example", streamingDomain: "mstdn-streaming.zenith.example", owner, size: "small" },
    });
    expect(draft.statusCode).toBe(200);
    const body = draft.json() as { spec: any; notes: string[]; issues: Array<{ warning?: boolean }> };
    expect(body.issues.filter((i) => !i.warning)).toEqual([]);
    // only what a services fleet is about: no token, accounts or nodes
    expect(Object.keys(body.spec).sort()).toEqual(["kind", "network", "topology", "version"]);
    expect(body.spec.network).toEqual({ name: "zenith-commons" });
    expect(body.spec.topology).toEqual({
      components: {
        mastodon: {
          enabled: true,
          domain: "mstdn.zenith.example",
          streamingDomain: "mstdn-streaming.zenith.example",
          owner,
          registrations: "none",
          size: "small",
        },
      },
    });
    // nobody signs up by default, so a missing relay is not worth a note
    expect(body.notes.join(" ")).not.toMatch(/no SMTP relay/);
    const created = await app.inject({ method: "POST", url: "/api/launches", payload: { spec: body.spec, owner: "akash1owner" } });
    expect(created.statusCode).toBe(201);
    db.close();
  });
});

describe("sharing a services fleet with other wallets", () => {
  it("lets a listed wallet's chain fleet link a bridge and copy the SMTP password, and no other", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    // the services fleet is the testnet wallet's; the chain fleet the devnet one's
    const TESTNET = "akash1qyqszqgpqyqszqgpqyqszqgpqyqszqgplgve5x";
    const DEVNET = "akash1qgpqyqszqgpqyqszqgpqyqszqgpqyqszxj9fqq";
    const svc = servicesSpec();
    db.createLaunch("svc", JSON.stringify(svc), TESTNET);
    expect((await runWithSigner(db, "svc", svc, work, allSteps(svc), services, new FakeSigner())).status).toBe("completed");
    updateMastodonSecrets(launchDirs(work, "svc").secrets, { smtpPassword: "relay-secret" });
    const c = chainSpec();
    db.createLaunch("fl", JSON.stringify(c), DEVNET);
    expect((await withStub(chainStub(), () => runWithSigner(db, "fl", c, work, allSteps(c), services, new FakeSigner()))).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("svc");
    fleet.materialize("fl");

    const add = () => fleet.requestAddComponent(db.getLaunch("fl")!, "bridge", { settings: { target: { fleet: "zenith-commons" } } });
    expect(add).toThrow(/does not share it with this one/);
    // only a services fleet shares, and not with its own wallet
    expect(() => fleet.setSharing(db.getLaunch("fl")!, [TESTNET])).toThrow(/only a services fleet/);
    expect(fleet.setSharing(db.getLaunch("svc")!, [DEVNET, TESTNET])).toEqual([DEVNET]);
    expect(JSON.parse(db.getLaunch("svc")!.spec_json).sharing).toEqual({ wallets: [DEVNET] });

    add();
    expect(JSON.parse(db.getLaunch("fl")!.spec_json).topology.components.bridge.target).toEqual({ fleet: "svc", domain: DOMAIN });

    // the SMTP password follows the same rule
    const { resolveSmtpPasswordSource } = await import("../src/services-spec.js");
    const spec = withDefaults({ ...servicesSpec(), topology: { ...servicesSpec().topology, components: { ...servicesSpec().topology.components, mastodon: { enabled: true, domain: "b.zenith.example", owner, smtp: { server: "s", fromAddress: "a@b.c", passwordFromFleet: "svc" } } } } } as any);
    resolveSmtpPasswordSource(db, work, DEVNET, spec);
    expect((spec.topology.components.mastodon!.smtp as any).password).toBe("relay-secret");
    fleet.setSharing(db.getLaunch("svc")!, []);
    expect(JSON.parse(db.getLaunch("svc")!.spec_json).sharing).toBeUndefined();
    const again = withDefaults({ ...servicesSpec(), topology: { ...servicesSpec().topology, components: { ...servicesSpec().topology.components, mastodon: { enabled: true, domain: "b.zenith.example", owner, smtp: { server: "s", fromAddress: "a@b.c", passwordFromFleet: "svc" } } } } } as any);
    expect(() => resolveSmtpPasswordSource(db, work, DEVNET, again)).toThrow(/does not share it/);
    db.close();
  }, 300_000);
});

