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
import { readNtfySecrets } from "../src/components/ntfy.js";
import { alertSettings, setAlertSettings } from "../src/incidents.js";
import bcrypt from "bcryptjs";
import { fakeServices, FakeSigner } from "./fakes.js";
import type { Assignments } from "../src/steps/phase-bcd.js";
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

describe("battle royale game", () => {
  it("renders the game server on its domain, with its leaderboard on a persistent volume", () => {
    const s = servicesSpec();
    (s.topology.components as any).battle = { enabled: true, domain: "battle.zenith.example" };
    const spec = withDefaults(s as any);
    expect(validateSpec(spec).errors).toEqual([]);
    expect(spec.images.battle).toMatch(/^sparkdreamnft\/battle-royale:v/);
    const out = descriptorFor("battle")!.render({
      spec,
      component: { key: "battle", image: spec.images.battle, domain: "battle.zenith.example" },
    } as any) as any;
    expect(out.battle.service).toEqual({
      image: spec.images.battle,
      expose: [{ port: 2567, as: 80, accept: ["battle.zenith.example"], to: [{ global: true }] }],
      params: { storage: { data: { mount: "/app/data", readOnly: false } } },
    });
    expect(out.battle.resources.storage[1]).toMatchObject({ name: "data", attributes: { persistent: true } });
    (s.topology.components as any).battle = { enabled: true };
    expect(validateSpec(withDefaults(s as any)).errors.map((e) => e.path)).toContain("topology.components.battle.domain");
  });

  it("is added to a running services fleet", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const signer = new FakeSigner();
    const s = servicesSpec();
    db.createLaunch("svc", JSON.stringify(s), "akash1owner");
    expect((await runWithSigner(db, "svc", s, work, allSteps(s), services, signer)).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("svc");

    fleet.requestAddComponent(db.getLaunch("svc")!, "battle", { domain: "battle.zenith.example" });
    const stored = JSON.parse(db.getLaunch("svc")!.spec_json) as LaunchSpec;
    expect(stored.topology.components.battle).toMatchObject({ enabled: true, domain: "battle.zenith.example" });
    expect(stored.images.battle).toMatch(/^sparkdreamnft\/battle-royale:v/);
    const done = await runWithSigner(
      db, "svc", stored, work,
      [...buildPreLaunchOpSteps(db, "svc"), ...allSteps(stored), ...buildOpSteps(db, "svc")],
      services, signer,
    );
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
    expect(db.listFleetOps("svc").find((o) => o.kind === "add-component")!.status).toBe("done");
    const rows = db.listFleetComponents("svc").filter((c) => c.state !== "closed");
    expect(rows.map((c) => c.key).sort()).toEqual(["battle", "mastodon"]);
    db.close();
  }, 120_000);
});

describe("alerts server (ntfy)", () => {
  it("renders stateless logins: the phone reads the topic, the launcher's token only writes it", () => {
    const s = servicesSpec();
    (s.topology.components as any).ntfy = { enabled: true, domain: "ntfy.zenith.example" };
    const spec = withDefaults(s as any);
    expect(validateSpec(spec).errors).toEqual([]);
    expect(spec.images.ntfy).toMatch(/^binwiederhier\/ntfy:v2\./);
    const secretsDir = path.join(tmp(), "secrets");
    const render = () =>
      descriptorFor("ntfy")!.render({
        spec,
        component: { key: "ntfy", image: spec.images.ntfy, domain: "ntfy.zenith.example" },
        secretsDir,
      } as any) as any;
    const out = render();
    const env: string[] = out.ntfy.service.env;
    const secrets = readNtfySecrets(secretsDir)!;
    expect(out.ntfy.service.args).toEqual(["serve"]);
    expect(env).toContain("NTFY_BASE_URL=https://ntfy.zenith.example");
    expect(env).toContain("NTFY_AUTH_DEFAULT_ACCESS=deny-all");
    expect(env).toContain(`NTFY_AUTH_ACCESS=phone:sparkdream-alerts:ro,launcher:sparkdream-alerts:wo`);
    expect(env).toContain(`NTFY_AUTH_TOKENS=launcher:${secrets.launcherToken}:sparkdream launcher`);
    expect(secrets.launcherToken).toMatch(/^tk_[a-z0-9]{29}$/);
    // a hash, never the password, and the same on every render (no drift)
    expect(env.join("\n")).not.toContain(secrets.phonePassword);
    expect(bcrypt.compareSync(secrets.phonePassword, secrets.phoneHash)).toBe(true);
    expect(render().ntfy.service.env).toEqual(env);
    // a domain is required, as for every public kind
    (s.topology.components as any).ntfy = { enabled: true };
    expect(validateSpec(withDefaults(s as any)).errors.map((e) => e.path)).toContain("topology.components.ntfy.domain");
  });

  it("is added to a services fleet, takes over the launcher's alerts, and shows the phone login", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const signer = new FakeSigner();
    const s = servicesSpec();
    db.createLaunch("svc", JSON.stringify(s), "akash1owner");
    expect((await runWithSigner(db, "svc", s, work, allSteps(s), services, signer)).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("svc");

    fleet.requestAddComponent(db.getLaunch("svc")!, "ntfy", { domain: "ntfy.zenith.example" });
    const stored = JSON.parse(db.getLaunch("svc")!.spec_json) as LaunchSpec;
    const done = await runWithSigner(
      db, "svc", stored, work,
      [...buildPreLaunchOpSteps(db, "svc"), ...allSteps(stored), ...buildOpSteps(db, "svc")],
      services, signer,
    );
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
    const secrets = readNtfySecrets(launchDirs(work, "svc").secrets)!;
    expect(alertSettings(db).ntfy).toEqual({ server: "https://ntfy.zenith.example", topic: "sparkdream-alerts", token: secrets.launcherToken });
    const launch = db.getLaunch("svc")!;
    const login = fleet.accounts(launch).find((a) => a.name === "ntfy-login");
    expect(login).toMatchObject({ address: "phone @ https://ntfy.zenith.example", hasMnemonic: true });
    expect(fleet.mnemonic(launch, "ntfy-login")).toBe(secrets.phonePassword);
    db.close();
  }, 120_000);

  it("keeps off the wallet's avoided providers, as a relaunch does", async () => {
    const add = async (avoid?: string) => {
      const work = tmp();
      const db = new ConductorDb(path.join(work, "state.db"));
      const services = fakeServices();
      const signer = new FakeSigner();
      const s = servicesSpec();
      db.createLaunch("svc", JSON.stringify(s), "akash1owner");
      expect((await runWithSigner(db, "svc", s, work, allSteps(s), services, signer)).status).toBe("completed");
      const fleet = new FleetService(db, services, work);
      fleet.materialize("svc");
      if (avoid) fleet.setProviderPref("akash1owner", avoid, "avoid");
      fleet.requestAddComponent(db.getLaunch("svc")!, "ntfy", { domain: "ntfy.zenith.example" });
      const stored = JSON.parse(db.getLaunch("svc")!.spec_json) as LaunchSpec;
      const done = await runWithSigner(
        db, "svc", stored, work,
        [...buildPreLaunchOpSteps(db, "svc"), ...allSteps(stored), ...buildOpSteps(db, "svc")],
        services, signer,
      );
      expect(done.status).toBe("completed");
      const provider = db.listFleetComponents("svc").find((c) => c.key === "ntfy")!.provider;
      db.close();
      return provider;
    };
    const usual = await add();
    expect(await add(usual)).not.toBe(usual);
  }, 240_000);

  it("moves off a provider whose ingress serves nothing, with no resume, and avoids it", async () => {
    const world = async () => {
      const work = tmp();
      const db = new ConductorDb(path.join(work, "state.db"));
      const services = fakeServices();
      const signer = new FakeSigner();
      const s = servicesSpec();
      db.createLaunch("svc", JSON.stringify(s), "akash1owner");
      expect((await runWithSigner(db, "svc", s, work, allSteps(s), services, signer)).status).toBe("completed");
      const fleet = new FleetService(db, services, work);
      fleet.materialize("svc");
      // DNS that works once set: the domain answers when its record points at
      // an ingress that serves (a broken one stays dark however it is pointed)
      services.dns = {
        async pointCname(name, target) {
          if ([...services.rpc.darkUrls].some((d) => target.includes(d))) services.rpc.darkUrls.add(name);
          else services.rpc.darkUrls.delete(name);
          return true;
        },
      };
      const drive = () => {
        const stored = JSON.parse(db.getLaunch("svc")!.spec_json) as LaunchSpec;
        return runWithSigner(db, "svc", stored, work, [...buildPreLaunchOpSteps(db, "svc"), ...allSteps(stored), ...buildOpSteps(db, "svc")], services, signer);
      };
      return { db, services, fleet, drive };
    };
    // where an add lands with nothing in the way
    const first = await world();
    first.fleet.requestAddComponent(first.db.getLaunch("svc")!, "ntfy", { domain: "ntfy.zenith.example" });
    expect((await first.drive()).status).toBe("completed");
    const usual = first.db.listFleetComponents("svc").find((c) => c.key === "ntfy")!;
    const usualHost = new URL(usual.host_uri).hostname;

    // that provider's ingress routes nowhere: its own hostname 404s too
    const w = await world();
    w.services.rpc.darkUrls.add("ntfy.zenith.example");
    w.services.rpc.darkUrls.add(`fake.ingress.${usualHost}`);
    // the record a pointCname makes names the generated host: dark here
    w.fleet.requestAddComponent(w.db.getLaunch("svc")!, "ntfy", { domain: "ntfy.zenith.example" });
    const done = await w.drive();
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
    const row = w.db.listFleetComponents("svc").find((c) => c.key === "ntfy")!;
    expect(row.state).toBe("active");
    expect(row.provider).not.toBe(usual.provider);
    expect(w.fleet.providerPrefs("akash1owner").avoid).toContain(usual.provider);
    const op = w.db.listFleetOps("svc").find((o) => o.kind === "add-component")!;
    expect(op.status).toBe("done");
    expect(JSON.parse(op.params_json).ingressReplacements).toBe(1);
    first.db.close();
    w.db.close();
  }, 240_000);

  it("a launch re-places a component whose provider's ingress serves nothing", async () => {
    const launch = async (broken?: string) => {
      const work = tmp();
      const db = new ConductorDb(path.join(work, "state.db"));
      const services = fakeServices();
      const s = servicesSpec();
      (s.topology.components as any).hub = { enabled: true, domain: "zenith.example" };
      if (broken) {
        services.rpc.darkUrls.add("//zenith.example/");
        services.rpc.darkUrls.add(`fake.ingress.${broken}`);
      }
      services.dns = {
        async pointCname(name, target) {
          if ([...services.rpc.darkUrls].some((d) => target.includes(d))) return true;
          services.rpc.darkUrls.delete(`//${name}/`);
          return true;
        },
      };
      // a closed deployment has no lease at its provider any more
      const signer = new FakeSigner();
      const sign = signer.sign.bind(signer);
      signer.sign = async (msgs) => {
        for (const m of msgs) if (m.typeUrl.endsWith("MsgCloseDeployment")) services.provider.leaselessDseqs.add((m.value as any).id.dseq);
        return sign(msgs);
      };
      db.createLaunch("svc", JSON.stringify(s), "akash1owner");
      const res = await runWithSigner(db, "svc", s, work, allSteps(s), services, signer);
      const hub = db.stepOutput<Assignments>("svc", "collect-bids")!.perNode.hub!;
      const avoid = db.providerPrefs("akash1owner").avoid;
      db.close();
      return { res, hub, avoid };
    };
    const usual = await launch();
    expect(usual.res.status).toBe("completed");
    const moved = await launch(new URL(usual.hub.hostUri).hostname);
    expect(moved.res.status).toBe("completed");
    expect(moved.hub.provider).not.toBe(usual.hub.provider);
    expect(moved.avoid).toContain(usual.hub.provider);
  }, 240_000);

  it("leaves alerts that already go elsewhere alone", async () => {
    const db = new ConductorDb(path.join(tmp(), "state.db"));
    setAlertSettings(db, { ntfy: { server: "https://ntfy.sh", topic: "mine" } });
    const s = servicesSpec();
    (s.topology.components as any).ntfy = { enabled: true, domain: "ntfy.zenith.example" };
    const spec = withDefaults(s as any);
    const step = descriptorFor("ntfy")!.configureSteps!((n) => n, spec)[0]!;
    await step.run({ db, spec, dirs: launchDirs(tmp(), "x"), log: () => {} } as any);
    expect(alertSettings(db).ntfy).toEqual({ server: "https://ntfy.sh", topic: "mine" });
    db.close();
  });
});

describe("the add dialog's options", () => {
  it("lists the kinds a services fleet can still add, each with an estimate, its version and its steps", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const s = servicesSpec();
    db.createLaunch("svc", JSON.stringify(s), "akash1owner");
    expect((await runWithSigner(db, "svc", s, work, allSteps(s), services, new FakeSigner())).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("svc");
    const o = await fleet.addOptions(db.getLaunch("svc")!);
    // mastodon runs already; no nodes in a services fleet, so no sentry
    expect(o.kinds.map((k) => k.key).sort()).toEqual(["battle", "hub", "ntfy"]);
    expect(o.sentry).toBeUndefined();
    const ntfy = o.kinds.find((k) => k.key === "ntfy")!;
    expect(ntfy).toMatchObject({ label: "Alerts (ntfy)", needsDomain: true, signatures: 2, version: "v2.28.0" });
    expect(ntfy.lowUsd).toBeGreaterThan(0);
    expect(ntfy.highUsd).toBeGreaterThan(ntfy.lowUsd!);
    expect(ntfy.steps).toHaveLength(4);
    db.close();
  }, 120_000);
});

describe("adding a component with a hand-picked bid", () => {
  it("parks at its lease with every bid, then leases the pick", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const signer = new FakeSigner();
    const s = servicesSpec();
    db.createLaunch("svc", JSON.stringify(s), "akash1owner");
    expect((await runWithSigner(db, "svc", s, work, allSteps(s), services, signer)).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("svc");
    const opId = fleet.requestAddComponent(db.getLaunch("svc")!, "hub", { domain: "zenith.example", manualBid: true });
    const drive = () => {
      const stored = JSON.parse(db.getLaunch("svc")!.spec_json) as LaunchSpec;
      return runWithSigner(db, "svc", stored, work, [...buildPreLaunchOpSteps(db, "svc"), ...allSteps(stored), ...buildOpSteps(db, "svc")], services, signer);
    };
    const parked = await drive();
    expect(parked.status).toBe("awaiting-user");
    expect(parked.failedStep).toBe(`op${opId}:lease`);
    const offers = JSON.parse(db.listFleetOps("svc").find((o) => o.id === opId)!.params_json).offeredBids;
    expect(offers.bids.length).toBeGreaterThan(1);
    const pick = offers.bids.at(-1).provider;
    fleet.chooseBid(db.getLaunch("svc")!, opId, pick);
    expect((await drive()).status).toBe("completed");
    expect(db.listFleetComponents("svc").find((c) => c.key === "hub")!.provider).toBe(pick);
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
    // a fleet never lists its own wallet; a chain fleet shares too (other
    // wallets' relayers may then relay to it), and can stop sharing
    expect(fleet.setSharing(db.getLaunch("fl")!, [TESTNET])).toEqual([TESTNET]);
    expect(JSON.parse(db.getLaunch("fl")!.spec_json).sharing).toEqual({ wallets: [TESTNET] });
    expect(fleet.setSharing(db.getLaunch("fl")!, [])).toEqual([]);
    expect(JSON.parse(db.getLaunch("fl")!.spec_json).sharing).toBeUndefined();
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

