import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";
import { defaultLoginDomain, profiles, serviceComponents, testnetSpec, validateSpec, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { allSteps } from "../src/index.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps } from "../src/fleet-ops.js";
import { renderComponentSdl } from "../src/render-component-sdl.js";
import { buildServer } from "../src/server.js";
import { placeholder } from "../src/steps/phase-a.js";
import { serviceIngressHost } from "../src/steps/phase-ef.js";
import { readMastodonSecrets, stashSmtpPassword, writeBridgeOperatorAddress } from "../src/components/mastodon-secrets.js";
import { writeSecretFile } from "../src/secrets.js";
import { fakeServices, FakeSigner } from "./fakes.js";
import { chainStub, withStub } from "./chain-stub.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-mastodon-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const DOMAIN = "social.phoenix.example";
/** The default sign-in domain: the instance's, same depth. */
const LOGIN_DOMAIN = "social-login.phoenix.example";

function spec(mastodon?: Record<string, unknown>, extra: Record<string, unknown> = {}): LaunchSpec {
  return testnetSpec({
    network: { name: "phoenix", type: "testnet", bech32Prefix: "sprkdrm" },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: {
        explorer: { enabled: false },
        frontend: { enabled: false },
        hub: { enabled: false },
        ...(mastodon ? { mastodon } : {}),
      },
      headscale: { domain: "hs.phoenix.example" },
      ...extra,
    },
  });
}

const owner = { username: "admin", email: "admin@phoenix.example" };
/** Images from the first release carrying wallet sign-in (the profile
 *  default may predate it; validation refuses those). */
const LOGIN_IMAGES = { sdap: "sparkdreamnft/sdap:v1.0.46", mastodon: "sparkdreamnft/mastodon:v1.0.46" };
const withLoginImages = (s: LaunchSpec): LaunchSpec => ({ ...s, images: { ...s.images, ...LOGIN_IMAGES } });
/** Images from the release before it. */
const withOldImages = (s: LaunchSpec): LaunchSpec => ({
  ...s,
  images: { ...s.images, sdap: "sparkdreamnft/sdap:v1.0.45", mastodon: "sparkdreamnft/mastodon:v1.0.45" },
});
const publicEndpoints = { publicEndpoints: { api: "api.phoenix.example", rpc: "rpc.phoenix.example" } };

describe("mastodon spec", () => {
  it("validates: owner required, bridge needs the public api, streaming domain counts as an ingress", () => {
    expect(validateSpec(spec({ enabled: true, domain: DOMAIN, owner })).errors).toEqual([]);
    expect(validateSpec(spec({ enabled: true, domain: DOMAIN })).errors.map((e) => e.path)).toContain(
      "topology.components.mastodon.owner",
    );
    const noApi = validateSpec(spec({ enabled: true, domain: DOMAIN, owner, bridge: { enabled: true } }));
    expect(noApi.errors.map((e) => e.path)).toContain("topology.publicEndpoints.api");
    const clash = validateSpec(
      spec({ enabled: true, domain: DOMAIN, owner }, { publicEndpoints: { api: `streaming.${DOMAIN}` } }),
    );
    expect(clash.errors.some((e) => /already used/.test(e.message))).toBe(true);
  });
});

/** A secrets dir holding the bridge operator's address, as generate-keys leaves it. */
function writeOperator(dir: string): string {
  writeBridgeOperatorAddress(path.join(dir, "secrets"), "sprkdrm1operator");
  return dir;
}

describe("mastodon SDL", () => {
  function render(s: LaunchSpec, dir: string) {
    const component = serviceComponents(s).find((c) => c.key === "mastodon")!;
    const out = path.join(dir, "mastodon.yaml");
    renderComponentSdl({ spec: s, component, sshPublicKey: "ssh-ed25519 AAAA", outPath: out, placeholder, secretsDir: path.join(dir, "secrets") });
    return yaml.load(fs.readFileSync(out, "utf8")) as any;
  }

  it("runs web+sidekiq, streaming, postgres and redis in one deployment, secrets kept across renders", () => {
    const dir = tmp();
    const s = spec({ enabled: true, domain: DOMAIN, owner });
    const doc = render(s, dir);
    expect(Object.keys(doc.services).sort()).toEqual(["db", "mastodon", "redis", "streaming"]);
    expect(doc.services.mastodon.expose[0]).toMatchObject({ port: 3000, as: 80, accept: [DOMAIN] });
    expect(doc.services.streaming.expose[0]).toMatchObject({ port: 4000, accept: [`streaming.${DOMAIN}`] });
    // postgres and redis only for the two mastodon services, never global
    expect(doc.services.db.expose[0].to).toEqual([{ service: "mastodon" }, { service: "streaming" }]);
    expect(doc.services.redis.expose[0].to).toEqual([{ service: "mastodon" }, { service: "streaming" }]);
    const env = new Map((doc.services.mastodon.env as string[]).map((e) => e.split(/=(.*)/s).slice(0, 2) as [string, string]));
    expect(env.get("LOCAL_DOMAIN")).toBe(DOMAIN);
    expect(env.get("SPARKDREAM_ASSUME_SSL")).toBe("true");
    expect(env.get("AUTHORIZED_FETCH")).toBe("false");
    expect(env.get("STREAMING_API_BASE_URL")).toBe(`wss://streaming.${DOMAIN}`);
    // VAPID public key: uncompressed P-256 point, urlsafe base64
    expect(Buffer.from(env.get("VAPID_PUBLIC_KEY")!, "base64url")).toHaveLength(65);
    expect(doc.services.db.env).toContain(`POSTGRES_PASSWORD=${env.get("DB_PASS")}`);
    // media on the volume, postgres data in a subdirectory of its volume
    expect(doc.services.mastodon.params.storage.media.mount).toBe("/opt/mastodon/public/system");
    expect(doc.services.db.env).toContain("PGDATA=/var/lib/postgresql/data/pgdata");

    // a second render (relaunch, upgrade) must not rotate a single secret
    const again = render(s, dir);
    expect(again.services.mastodon.env).toEqual(doc.services.mastodon.env);
    expect(readMastodonSecrets(path.join(dir, "secrets"))!.SECRET_KEY_BASE).toBe(env.get("SECRET_KEY_BASE"));
  });

  it("sizes small by default (one puma worker), standard on request", () => {
    const envOf = (doc: any, svc: string) => new Map((doc.services[svc].env as string[]).map((e) => e.split(/=(.*)/s).slice(0, 2) as [string, string]));
    const cpu = (doc: any) =>
      Object.values(doc.profiles.compute as Record<string, any>).reduce((n: number, p: any) => n + Number(p.resources.cpu.units), 0);

    const small = render(spec({ enabled: true, domain: DOMAIN, owner, bridge: { enabled: true } }, publicEndpoints), writeOperator(tmp()));
    expect(small.profiles.compute.mastodon.resources).toMatchObject({ cpu: { units: 1 }, memory: { size: "2Gi" } });
    expect(small.profiles.compute.db.resources.memory.size).toBe("1Gi");
    expect(cpu(small)).toBeCloseTo(2.1, 5);
    const media = small.profiles.compute.mastodon.resources.storage.find((v: any) => v.name === "media");
    expect(media.size).toBe("10Gi");
    const env = envOf(small, "mastodon");
    expect(env.get("WEB_CONCURRENCY")).toBe("1");
    expect(env.get("MALLOC_ARENA_MAX")).toBe("2");

    const standard = render(spec({ enabled: true, domain: DOMAIN, owner, size: "standard", bridge: { enabled: true } }, publicEndpoints), writeOperator(tmp()));
    expect(standard.profiles.compute.mastodon.resources).toMatchObject({ cpu: { units: 2 }, memory: { size: "4Gi" } });
    expect(cpu(standard)).toBeCloseTo(4.25, 5);
    expect(envOf(standard, "mastodon").has("WEB_CONCURRENCY")).toBe(false);
  });

  it("sends mail through the SMTP relay when one is set, with the password from the secret store", () => {
    const envOf = (doc: any) => new Map((doc.services.mastodon.env as string[]).map((e) => e.split(/=(.*)/s).slice(0, 2) as [string, string]));
    // no relay: written to disk. With the default registrations (none)
    // nobody signs up, so validation is quiet; once sign-ups are allowed it
    // says they cannot confirm
    const bare = spec({ enabled: true, domain: DOMAIN, owner });
    expect(envOf(render(bare, tmp())).get("SMTP_DELIVERY_METHOD")).toBe("file");
    expect(validateSpec(bare).warnings.map((w) => w.path)).not.toContain("topology.components.mastodon.smtp");
    const signups = spec({ enabled: true, domain: DOMAIN, owner, registrations: "approved" });
    expect(validateSpec(signups).warnings.map((w) => w.path)).toContain("topology.components.mastodon.smtp");

    const dir = tmp();
    const s = spec({
      enabled: true,
      domain: DOMAIN,
      owner,
      smtp: { server: "smtp.relay.example", login: "apikey", password: "s3cret-relay-pass", fromAddress: "Phoenix <notifications@phoenix.example>" },
    });
    // what adding the component does before storing the spec
    stashSmtpPassword(path.join(dir, "secrets"), s);
    expect(JSON.stringify(s)).not.toContain("s3cret-relay-pass");
    expect(readMastodonSecrets(path.join(dir, "secrets"))!.smtpPassword).toBe("s3cret-relay-pass");
    const env = envOf(render(s, dir));
    expect(env.get("SMTP_DELIVERY_METHOD")).toBe("smtp");
    expect(env.get("SMTP_SERVER")).toBe("smtp.relay.example");
    expect(env.get("SMTP_PORT")).toBe("587");
    expect(env.get("SMTP_LOGIN")).toBe("apikey");
    expect(env.get("SMTP_PASSWORD")).toBe("s3cret-relay-pass");
    expect(env.get("SMTP_FROM_ADDRESS")).toBe("Phoenix <notifications@phoenix.example>");
    expect(env.get("SMTP_ENABLE_STARTTLS")).toBe("always");

    const implicit = spec({ enabled: true, domain: DOMAIN, owner, smtp: { server: "smtp.relay.example", port: 465, security: "tls", fromAddress: "n@phoenix.example" } });
    const tls = envOf(render(implicit, tmp()));
    expect(tls.get("SMTP_TLS")).toBe("true");
    expect(tls.get("SMTP_PORT")).toBe("465");
    expect(tls.has("SMTP_PASSWORD")).toBe(false);
    expect(validateSpec(spec({ enabled: true, domain: DOMAIN, owner, smtp: { server: "x", fromAddress: "nobody" } })).errors.map((e) => e.path)).toContain(
      "topology.components.mastodon.smtp.fromAddress",
    );
  });

  it("with the bridge, sdapbridge idles on a pending token and signs through a session key, never the operator's", () => {
    const dir = tmp();
    const operatorMnemonic = "word ".repeat(24).trim();
    fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
    writeSecretFile(path.join(dir, "secrets", "mnemonics.json"), JSON.stringify({ "bridge-operator": operatorMnemonic }));
    writeBridgeOperatorAddress(path.join(dir, "secrets"), "sprkdrm1operator");
    const doc = render(spec({ enabled: true, domain: DOMAIN, owner, bridge: { enabled: true } }, publicEndpoints), dir);
    const bridge = doc.services.bridge;
    expect(bridge.image).toContain("sparkdreamnft/sdap:");
    expect(bridge.env).toEqual(
      expect.arrayContaining([
        `MASTODON_URL=https://${DOMAIN}`,
        "MASTODON_TOKEN=pending",
        `SDA_PEER_IDS=${DOMAIN}`,
        "SDA_LCD=https://api.phoenix.example",
        "SDA_CONSENT=opt-in",
        "SDA_SESSION_KEY_FILE=/data/session-key",
        "SDA_GRANTER=sprkdrm1operator",
      ]),
    );
    // the operator's key controls the service bond: it stays launcher-side
    expect(JSON.stringify(doc)).not.toContain(operatorMnemonic);
    expect((bridge.env as string[]).some((e) => e.startsWith("SDA_MNEMONIC="))).toBe(false);
    // args only: the image's entrypoint readies /data, then drops privileges
    expect(bridge.command).toBeUndefined();
    expect(bridge.args.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(bridge.args[2]).toContain('"$MASTODON_TOKEN" = "pending"');
    expect(bridge.expose).toBeUndefined();
  });
});

async function launch(s: LaunchSpec) {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const services = fakeServices();
  db.createLaunch("fl", JSON.stringify(s), "akash1owner");
  const signer = new FakeSigner();
  const result = await runWithSigner(db, "fl", s, work, allSteps(), services, signer);
  return { work, db, services, signer, result, fleet: new FleetService(db, services, work) };
}

describe("mastodon launch", () => {
  it("deploys in the node batch, creates the owner once and keeps its password for the accounts panel", async () => {
    const w = await launch(spec({ enabled: true, domain: DOMAIN, owner }));
    expect(w.result.status).toBe("completed");
    expect(w.signer.signed).toHaveLength(6);
    const out = w.db.stepOutput<any>("fl", "configure-mastodon")!;
    expect(out).toMatchObject({ owner: `@admin@${DOMAIN}`, created: true, registrations: "none" });
    const launchRow = w.db.getLaunch("fl")!;
    const acct = w.fleet.accounts(launchRow).find((a) => a.name === "mastodon-owner")!;
    expect(acct).toMatchObject({ address: `@admin@${DOMAIN}`, hasMnemonic: true });
    expect(w.fleet.mnemonic(launchRow, "mastodon-owner")).toMatch(/^pw-admin-/);
    // both ingress domains were probed on their health paths
    expect(w.db.stepOutput<any>("fl", "verify-chain")).toBeTruthy();
  }, 120_000);

  it("pauses with DNS guidance for a dark streaming domain", async () => {
    const s = spec({ enabled: true, domain: DOMAIN, owner });
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    services.rpc.darkUrls.add(`streaming.${DOMAIN}`);
    db.createLaunch("fl", JSON.stringify(s), "akash1owner");
    const paused = await runWithSigner(db, "fl", s, work, allSteps(), services, new FakeSigner());
    expect(paused.status).toBe("awaiting-user");
    expect(paused.reason).toContain(`streaming.${DOMAIN}`);
  }, 120_000);
});

describe("mastodon bridge", () => {
  it("added to a running fleet: peer activated, operator funded and bonded, token delivered", async () => {
    const base = spec(undefined, publicEndpoints);
    const w = await launch(base);
    expect(w.result.status).toBe("completed");
    w.fleet.materialize("fl");
    w.fleet.requestAddComponent(w.db.getLaunch("fl")!, "mastodon", {
      domain: DOMAIN,
      settings: { owner, bridge: { enabled: true } },
    });
    const chain = chainStub();
    const drive = () =>
      withStub(chain, () =>
        runWithSigner(
          w.db, "fl", base, w.work,
          [...buildPreLaunchOpSteps(w.db, "fl"), ...allSteps(), ...buildOpSteps(w.db, "fl")],
          w.services, w.signer,
        ),
      );

    // the operator key was made for this add, so nothing funded it yet
    const paused = await drive();
    expect(paused.status).toBe("awaiting-user");
    const operator = /fund the bridge operator (\S+) with/.exec(paused.reason ?? "")?.[1];
    expect(operator).toMatch(/^sprkdrm1/);
    // the instance is already an ACTIVE ActivityPub peer, activated by the founder
    const onChain = Object.values(chain.state().chains)[0]!;
    expect(onChain.peers[DOMAIN]).toMatchObject({ type: "PEER_TYPE_ACTIVITYPUB", status: "PEER_STATUS_ACTIVE" });
    expect(onChain.policies[DOMAIN]).toMatchObject({ inbound_content_types: ["blog_post", "blog_reply"] });

    chain.edit((st) => (st.balances = { [operator!]: { [base.token.baseDenom]: "2000000000" } }));
    const signedBefore = w.signer.signed.length;
    const done = await drive();
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");

    // bonded by the operator's own key, for the instance's peer
    const binding = Object.values(chain.state().chains)[0]!.bindings![`${operator}/${DOMAIN}`]!;
    expect(binding).toMatchObject({ signer: "bridge-operator", stake: "1000000000", endpoint: `https://${DOMAIN}` });
    // the token reached the bridge service in one deployment update
    const sdl = yaml.load(fs.readFileSync(path.join(w.work, "launches", "fl", "sdl", "mastodon.yaml"), "utf8")) as any;
    const mastodonRow = w.db.listFleetComponents("fl").find((c) => c.key === "mastodon")!;
    expect(sdl.services.bridge.env).toContain(`MASTODON_TOKEN=token-${mastodonRow.dseq}`);
    const updates = w.signer.signed
      .slice(signedBefore)
      .filter((tx) => tx.some((m) => m.typeUrl.includes("MsgUpdateDeployment")));
    expect(updates).toHaveLength(1);
    expect(w.db.listFleetOps("fl").find((o) => o.kind === "add-component")!.status).toBe("done");
  }, 180_000);
});

describe("mastodon resize", () => {
  it("moves the instance to a smaller deployment with its database and media, on the same provider", async () => {
    const s = spec({ enabled: true, domain: DOMAIN, owner, size: "standard" });
    const w = await launch(s);
    expect(w.result.status).toBe("completed");
    w.fleet.materialize("fl");
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "mastodon")!;
    // an instance with an owner account, a bridge token and uploaded media
    w.services.provider.mastodon.get(before.dseq)!.token = "token-original";
    w.services.provider.mastodonMedia.set(before.dseq, Buffer.from("avatars and attachments ".repeat(5000)));
    const password = w.fleet.mnemonic(w.db.getLaunch("fl")!, "mastodon-owner");

    // a plain relaunch warns that it would leave the data behind
    expect(w.fleet.relaunchWarnings(w.db.getLaunch("fl")!, before).join(" ")).toMatch(/EMPTY volumes.*use resize/);

    const opId = await w.fleet.requestMastodonResize(w.db.getLaunch("fl")!, before, "small");
    await expect(w.fleet.requestMastodonResize(w.db.getLaunch("fl")!, before, "small")).rejects.toThrow(/already being moved/);
    const signedBefore = w.signer.signed.length;
    const done = await runWithSigner(
      w.db, "fl", s, w.work,
      [...buildPreLaunchOpSteps(w.db, "fl"), ...allSteps(), ...buildOpSteps(w.db, "fl")],
      w.services, w.signer,
    );
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");

    // a new deployment, at the new size, where the old one ran
    const after = w.db.listFleetComponents("fl").find((c) => c.key === "mastodon")!;
    expect(after.dseq).not.toBe(before.dseq);
    expect(after.provider).toBe(before.provider);
    const sdl = yaml.load(fs.readFileSync(path.join(w.work, "launches", "fl", "sdl", "mastodon.yaml"), "utf8")) as any;
    expect(sdl.profiles.compute.mastodon.resources.memory.size).toBe("2Gi");
    expect(JSON.parse(w.db.getLaunch("fl")!.spec_json).topology.components.mastodon.size).toBe("small");
    const txs = w.signer.signed.slice(signedBefore).flat().map((m) => m.typeUrl.split(".").pop());
    expect(txs).toEqual(expect.arrayContaining(["MsgCloseDeployment", "MsgCreateDeployment", "MsgCreateLease"]));

    // the data came along: same accounts and token, so no second owner, and the media
    const moved = w.services.provider.mastodon.get(after.dseq)!;
    expect([...moved.accounts]).toContain("admin");
    expect(moved.token).toBe("token-original");
    expect(w.db.stepOutput<any>("fl", `op${opId}:configure-mastodon`)).toMatchObject({ created: false });
    expect(w.fleet.mnemonic(w.db.getLaunch("fl")!, "mastodon-owner")).toBe(password);
    expect(w.services.provider.mastodonMedia.get(after.dseq)).toEqual(w.services.provider.mastodonMedia.get(before.dseq));

    // the backup stays with the launcher, encrypted like the other secrets
    const backup = w.db.stepOutput<any>("fl", `op${opId}:backup`)!;
    expect(backup).toMatchObject({ dseq: before.dseq, media: { bytes: 120000 } });
    expect(fs.existsSync(path.join(backup.dir, "db.dump"))).toBe(true);
    expect(w.db.stepOutput<any>("fl", `op${opId}:restore`)).toMatchObject({ restoredFrom: before.dseq, accounts: 1 });
  }, 180_000);
});

describe("mastodon wallet sign-in", () => {
  const walletLogin = { enabled: true, minTrustLevel: "provisional" };
  const envOf = (doc: any, svc: string) =>
    new Map((doc.services[svc].env as string[]).map((e) => e.split(/=(.*)/s).slice(0, 2) as [string, string]));
  function render(s: LaunchSpec, dir: string) {
    const component = serviceComponents(s).find((c) => c.key === "mastodon")!;
    const out = path.join(dir, "mastodon.yaml");
    renderComponentSdl({ spec: s, component, sshPublicKey: "ssh-ed25519 AAAA", outPath: out, placeholder, secretsDir: path.join(dir, "secrets") });
    return yaml.load(fs.readFileSync(out, "utf8")) as any;
  }

  it("validates: the chain's public api and rpc, and a sign-in domain of its own", () => {
    expect(validateSpec(withLoginImages(spec({ enabled: true, domain: DOMAIN, owner, walletLogin }, publicEndpoints))).errors).toEqual([]);
    // images from before sign-in are refused, before anything is deployed
    const old = validateSpec(withOldImages(spec({ enabled: true, domain: DOMAIN, owner, walletLogin }, publicEndpoints)));
    expect(old.errors.filter((e) => /predates wallet sign-in/.test(e.message)).map((e) => e.path).sort()).toEqual([
      "images.mastodon",
      "images.sdap",
    ]);
    const unversioned = { ...spec({ enabled: true, domain: DOMAIN, owner, walletLogin }, publicEndpoints) };
    unversioned.images = { ...unversioned.images, sdap: "sparkdreamnft/sdap:dev", mastodon: "sparkdreamnft/mastodon:dev" };
    expect(validateSpec(unversioned).errors).toEqual([]);
    const noEndpoints = validateSpec(withLoginImages(spec({ enabled: true, domain: DOMAIN, owner, walletLogin })));
    expect(noEndpoints.errors.map((e) => e.path)).toContain("topology.publicEndpoints");
    const own = validateSpec(
      withLoginImages(spec({ enabled: true, domain: DOMAIN, owner, walletLogin: { ...walletLogin, domain: DOMAIN } }, publicEndpoints)),
    );
    expect(own.errors.map((e) => e.path)).toContain("topology.components.mastodon.walletLogin.domain");
    const clash = validateSpec(
      withLoginImages(spec({ enabled: true, domain: DOMAIN, owner, walletLogin }, { publicEndpoints: { api: `${LOGIN_DOMAIN}`, rpc: "rpc.phoenix.example" } })),
    );
    expect(clash.errors.some((e) => /already used/.test(e.message))).toBe(true);
  });

  it("names each domain's own service ingress as its CNAME target", () => {
    // a Mastodon lease status: every exposed service has its own generated host
    const status = {
      services: {
        db: { available: 1, total: 1 },
        login: { uris: ["lfldikk.ingress.akash-palmito.org", "mstdn-login.sparkdream.io"] },
        mastodon: { uris: ["hli9vve.ingress.akash-palmito.org", "mstdn.sparkdream.io"] },
        streaming: { uris: ["4vlki6s.ingress.akash-palmito.org", "mstdn-streaming.sparkdream.io"] },
      },
    };
    expect(serviceIngressHost(status, "mstdn.sparkdream.io")).toBe("hli9vve.ingress.akash-palmito.org");
    expect(serviceIngressHost(status, "mstdn-streaming.sparkdream.io")).toBe("4vlki6s.ingress.akash-palmito.org");
    expect(serviceIngressHost(status, "mstdn-login.sparkdream.io")).toBe("lfldikk.ingress.akash-palmito.org");
    // a domain no service lists yet: a one-service deployment's host
    expect(serviceIngressHost({ services: { hub: { uris: ["abc.ingress.p.org"] } } }, "hub.example.io")).toBe("abc.ingress.p.org");
  });

  it("defaults the sign-in domain to the instance's depth, and warns about a deeper one", () => {
    expect(defaultLoginDomain("mstdn.sparkdream.io")).toBe("mstdn-login.sparkdream.io");
    expect(defaultLoginDomain(DOMAIN)).toBe(LOGIN_DOMAIN);
    expect(defaultLoginDomain("sparkdream.io")).toBe("login.sparkdream.io");
    const deeper = validateSpec(
      withLoginImages(spec({ enabled: true, domain: DOMAIN, owner, walletLogin: { ...walletLogin, domain: `login.${DOMAIN}` } }, publicEndpoints)),
    );
    expect(deeper.errors).toEqual([]);
    expect(deeper.warnings.find((w) => w.path === "topology.components.mastodon.walletLogin.domain")?.message).toMatch(
      new RegExp(`deeper.*${LOGIN_DOMAIN.replace(/\./g, "\\.")}`),
    );
    const same = validateSpec(withLoginImages(spec({ enabled: true, domain: DOMAIN, owner, walletLogin }, publicEndpoints)));
    expect(same.warnings.map((w) => w.path)).not.toContain("topology.components.mastodon.walletLogin.domain");
  });

  it("runs sdaplogin on its own ingress and points Mastodon's OIDC client at it, secrets kept across renders", () => {
    const dir = tmp();
    const s = spec({ enabled: true, domain: DOMAIN, owner, walletLogin }, publicEndpoints);
    const doc = render(s, dir);
    expect(Object.keys(doc.services).sort()).toEqual(["db", "login", "mastodon", "redis", "streaming"]);
    const login = doc.services.login;
    expect(login.image).toBe(s.images.sdap);
    expect(login.args).toEqual(["sdaplogin"]);
    expect(login.expose).toEqual([{ port: 8080, as: 80, accept: [`${LOGIN_DOMAIN}`], to: [{ global: true }] }]);

    const lenv = envOf(doc, "login");
    const menv = envOf(doc, "mastodon");
    expect(lenv.get("LOGIN_ISSUER")).toBe(`https://${LOGIN_DOMAIN}`);
    expect(menv.get("OIDC_ISSUER")).toBe(lenv.get("LOGIN_ISSUER"));
    expect(menv.get("OIDC_CLIENT_ID")).toBe(lenv.get("LOGIN_CLIENT_ID"));
    expect(menv.get("OIDC_CLIENT_SECRET")).toBe(lenv.get("LOGIN_CLIENT_SECRET"));
    expect(menv.get("OIDC_REDIRECT_URI")).toBe(`https://${DOMAIN}/auth/auth/openid_connect/callback`);
    expect(lenv.get("LOGIN_REDIRECT_URI")).toBe(menv.get("OIDC_REDIRECT_URI"));
    expect(lenv.get("LOGIN_CHAINS_URL")).toBe(`https://${DOMAIN}/sparkdream/login-chains.json`);
    expect(menv.get("SPARKDREAM_WALLET_LOGIN")).toBe("true");
    expect(menv.get("SPARKDREAM_LOGIN_URL")).toBe(`https://${LOGIN_DOMAIN}`);
    expect(menv.get("OIDC_UID_FIELD")).toBe("sub");
    expect(menv.get("OIDC_SECURITY_ASSUME_EMAIL_IS_VERIFIED")).toBe("true");
    // the streaming server shares the base env, not the sign-in client
    expect(envOf(doc, "streaming").has("OIDC_CLIENT_SECRET")).toBe(false);
    // the signing key is an RSA private key, on one line
    const key = crypto.createPrivateKey({ key: Buffer.from(lenv.get("LOGIN_SIGNING_KEY")!, "base64"), format: "der", type: "pkcs8" });
    expect(key.asymmetricKeyType).toBe("rsa");

    const again = render(s, dir);
    expect(again.services.login.env).toEqual(login.env);
    expect(again.services.mastodon.env).toEqual(doc.services.mastodon.env);
  });

  it("adds the sign-in secrets to an instance made before them, keeping the rest", () => {
    const dir = tmp();
    const before = render(spec({ enabled: true, domain: DOMAIN, owner }, publicEndpoints), dir);
    expect(before.services.login).toBeUndefined();
    expect(readMastodonSecrets(path.join(dir, "secrets"))!.loginClientSecret).toBeUndefined();
    const after = render(spec({ enabled: true, domain: DOMAIN, owner, walletLogin }, publicEndpoints), dir);
    expect(envOf(after, "mastodon").get("SECRET_KEY_BASE")).toBe(envOf(before, "mastodon").get("SECRET_KEY_BASE"));
    expect(readMastodonSecrets(path.join(dir, "secrets"))!.loginClientSecret).toBe(envOf(after, "login").get("LOGIN_CLIENT_SECRET"));
  });

  it("offers the fleet's own chain at sign-in once configured", async () => {
    const w = await launch(withLoginImages(spec({ enabled: true, domain: DOMAIN, owner, walletLogin }, publicEndpoints)));
    expect(w.result.status).toBe("completed");
    expect(w.db.stepOutput<any>("fl", "configure-mastodon")).toMatchObject({ loginChains: 1 });
    const inst = [...w.services.provider.mastodon.values()][0]!;
    expect(inst.loginChains).toEqual({
      fl: expect.objectContaining({
        chainId: expect.stringMatching(/^phoenix-/),
        rest: "https://api.phoenix.example",
        rpc: "https://rpc.phoenix.example",
        bech32Prefix: "sprkdrm",
        minTrustLevel: "TRUST_LEVEL_PROVISIONAL",
      }),
    });
  }, 120_000);
});

describe("mastodon settings", () => {
  const runOps = (w: Awaited<ReturnType<typeof launch>>, s: LaunchSpec) =>
    runWithSigner(w.db, "fl", s, w.work, [...buildPreLaunchOpSteps(w.db, "fl"), ...allSteps(), ...buildOpSteps(w.db, "fl")], w.services, w.signer);

  it("applies registrations and the sign-in trust floor in place, with no signature", async () => {
    const s = withLoginImages(spec({ enabled: true, domain: DOMAIN, owner, walletLogin: { enabled: true } }, publicEndpoints));
    const w = await launch(s);
    expect(w.result.status).toBe("completed");
    w.fleet.materialize("fl");
    const row = w.db.listFleetComponents("fl").find((c) => c.key === "mastodon")!;
    const settings = { registrations: "approved" as const, walletLogin: { minTrustLevel: "established" } };
    expect(w.fleet.mastodonSettingsMove(w.db.getLaunch("fl")!, settings)).toBe(false);
    const { opId, move } = w.fleet.requestMastodonSettings(w.db.getLaunch("fl")!, row, settings);
    expect(move).toBe(false);
    const signedBefore = w.signer.signed.length;
    const done = await runOps(w, s);
    expect(done.reason ?? "").toBe("");
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    expect(w.signer.signed.length).toBe(signedBefore);

    const inst = w.services.provider.mastodon.get(row.dseq)!;
    expect(inst.registrations).toBe("approved");
    expect(inst.loginChains!.fl.minTrustLevel).toBe("TRUST_LEVEL_ESTABLISHED");
    const stored = JSON.parse(w.db.getLaunch("fl")!.spec_json).topology.components.mastodon;
    expect(stored).toMatchObject({ registrations: "approved", walletLogin: { enabled: true, minTrustLevel: "established" } });

    // a setting the spec refuses changes nothing
    expect(() => w.fleet.requestMastodonSettings(w.db.getLaunch("fl")!, row, { walletLogin: { minTrustLevel: "elder" } })).toThrow(
      /minTrustLevel/,
    );
  }, 180_000);

  it("added to a fleet launched on older images, with sign-in on: runs the current release", async () => {
    const base = withOldImages(spec(undefined, publicEndpoints));
    const w = await launch(base);
    expect(w.result.status).toBe("completed");
    w.fleet.materialize("fl");
    const explorerBefore = JSON.parse(w.db.getLaunch("fl")!.spec_json).images.explorer;
    w.fleet.requestAddComponent(w.db.getLaunch("fl")!, "mastodon", {
      domain: DOMAIN,
      settings: { owner, walletLogin: { enabled: true } },
    });
    const images = JSON.parse(w.db.getLaunch("fl")!.spec_json).images;
    // the new deployment's images: the profile's, not the launch's v1.0.45
    expect(images.mastodon).toBe(profiles.testnet.images.mastodon);
    expect(images.sdap).toBe(profiles.testnet.images.sdap);
    // what it does not run is left as it was
    expect(images.explorer).toBe(explorerBefore);
  }, 180_000);

  it("a removed Mastodon's finished add op does not grow steps when a later op drives the fleet", async () => {
    const base = spec(undefined, publicEndpoints);
    const w = await launch(base);
    expect(w.result.status).toBe("completed");
    w.fleet.materialize("fl");
    const addOp = w.fleet.requestAddComponent(w.db.getLaunch("fl")!, "mastodon", { domain: DOMAIN, settings: { owner } });
    expect((await runOps(w, base)).status).toBe("completed");
    expect(w.db.listFleetOps("fl").find((o) => o.id === addOp)!.status).toBe("done");

    // closed and removed: the spec no longer runs Mastodon
    w.db.setComponentState("fl", "mastodon", "closed");
    w.fleet.removeComponent(w.db.getLaunch("fl")!, "mastodon");
    const rebuilt = buildOpSteps(w.db, "fl").map((st) => st.name).filter((n) => n.startsWith(`op${addOp}:`));
    const ran = new Set(w.db.listSteps("fl").filter((st) => st.status === "done").map((st) => st.name));
    expect(rebuilt.length).toBeGreaterThan(0);
    expect(rebuilt.filter((n) => !ran.has(n))).toEqual([]);

    // what the old launcher left behind: that phantom step, failed
    w.db.stepStarted("fl", `op${addOp}:configure`);
    w.db.stepFailed("fl", `op${addOp}:configure`, "fleet component mastodon not found");

    // a later op drives the fleet to completion (was: "fleet component mastodon not found")
    const later = w.db.createFleetOp("fl", "reconfigure", { keys: [] });
    const s = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));
    const done = await runOps(w, s);
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
    expect(w.db.listFleetOps("fl").find((o) => o.id === later)!.status).toBe("done");
    // and the stale failure is gone, not left on the panel
    expect(w.db.getStep("fl", `op${addOp}:configure`)).toBeUndefined();
    expect(w.db.listSteps("fl").filter((st) => st.status === "error")).toEqual([]);
  }, 180_000);

  it("Retry on a completed launch clears a failure left by a step no longer in the plan", async () => {
    const w = await launch(spec(undefined, publicEndpoints));
    expect(w.result.status).toBe("completed");
    // the row the old launcher left (a finished op's phantom step)
    w.db.stepStarted("fl", "op200:configure");
    w.db.stepFailed("fl", "op200:configure", "fleet component mastodon not found");
    const app = buildServer({ db: w.db, services: w.services, workRoot: w.work, steps: allSteps(), monitorIntervalMs: 0 });
    const res = await app.inject({ method: "POST", url: "/api/launches/fl/resume?owner=akash1owner" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "completed" });
    expect(w.db.getStep("fl", "op200:configure")).toBeUndefined();
    expect(w.db.getLaunch("fl")!.status).toBe("completed");
    await app.close();
  }, 180_000);

  it("asks before a move, and refuses an empty change", async () => {
    const w = await launch(withLoginImages(spec({ enabled: true, domain: DOMAIN, owner }, publicEndpoints)));
    const app = buildServer({ db: w.db, services: w.services, workRoot: w.work, steps: allSteps(), monitorIntervalMs: 0 });
    await app.inject({ method: "GET", url: "/api/fleet?owner=akash1owner" });
    const row = w.db.listFleetComponents("fl").find((c) => c.key === "mastodon")!;
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: `/api/fleet/fl/${row.dseq}/actions`, payload: { action: "mastodon-settings", ...payload } });

    const empty = await post({});
    expect(empty.statusCode).toBe(400);
    const unconfirmed = await post({ walletLogin: { enabled: true } });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json()).toMatchObject({ confirmPrompt: expect.stringMatching(/new deployment/) });
    expect(unconfirmed.json().warnings.join(" ")).toMatch(/goes down/);
    // nothing was queued or written
    expect(w.db.listFleetOps("fl", "active")).toEqual([]);
    expect(JSON.parse(w.db.getLaunch("fl")!.spec_json).topology.components.mastodon.walletLogin).toBeUndefined();
    await app.close();
  }, 180_000);

  it("moves the sign-in domain in place: one deployment update, then its DNS gate", async () => {
    const s = withLoginImages(spec({ enabled: true, domain: DOMAIN, owner, walletLogin: { enabled: true } }, publicEndpoints));
    const w = await launch(s);
    expect(w.result.status).toBe("completed");
    w.fleet.materialize("fl");
    const row = w.db.listFleetComponents("fl").find((c) => c.key === "mastodon")!;
    const sdlFile = path.join(w.work, "launches", "fl", "sdl", "mastodon.yaml");
    const sdlNow = () => yaml.load(fs.readFileSync(sdlFile, "utf8")) as any;
    const envOf = (doc: any, svc: string) =>
      new Map((doc.services[svc].env as string[]).map((e) => e.split(/=(.*)/s).slice(0, 2) as [string, string]));
    expect(sdlNow().services.login.expose[0].accept).toEqual([LOGIN_DOMAIN]);

    const NEW = "phoenix-signin.example";
    const settings = { walletLogin: { domain: NEW } };
    expect(w.fleet.mastodonSettingsMove(w.db.getLaunch("fl")!, settings)).toBe(false);
    const { move } = w.fleet.requestMastodonSettings(w.db.getLaunch("fl")!, row, settings);
    expect(move).toBe(false);
    const signedBefore = w.signer.signed.length;
    // the new name has no DNS record yet: the retarget pauses with its target
    w.services.rpc.darkUrls.add(NEW);
    const paused = await runOps(w, s);
    expect(paused.status).toBe("awaiting-user");
    expect(paused.reason).toContain(NEW);
    expect(paused.reason).toContain(`${NEW} → CNAME`);
    w.services.rpc.darkUrls.delete(NEW);
    const done = await runOps(w, s);
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");

    // the same deployment, one update: the login service's name and the issuer everywhere
    expect(w.db.listFleetComponents("fl").find((c) => c.key === "mastodon")!.dseq).toBe(row.dseq);
    const txs = w.signer.signed.slice(signedBefore).flat().map((m) => m.typeUrl.split(".").pop());
    expect(txs).toEqual(["MsgUpdateDeployment"]);
    const doc = sdlNow();
    expect(doc.services.login.expose[0].accept).toEqual([NEW]);
    expect(doc.services.mastodon.expose[0].accept).toEqual([DOMAIN]);
    expect(envOf(doc, "login").get("LOGIN_ISSUER")).toBe(`https://${NEW}`);
    expect(envOf(doc, "mastodon").get("OIDC_ISSUER")).toBe(`https://${NEW}`);
    expect(envOf(doc, "mastodon").get("SPARKDREAM_LOGIN_URL")).toBe(`https://${NEW}`);
    // the rest of the env is the deployment's own, untouched
    expect(envOf(doc, "login").get("LOGIN_CLIENT_SECRET")).toBe(envOf(doc, "mastodon").get("OIDC_CLIENT_SECRET"));
    expect(JSON.parse(w.db.getLaunch("fl")!.spec_json).topology.components.mastodon.walletLogin.domain).toBe(NEW);

    // a deployment rendered under an older default (login.<domain>, a level
    // deeper) is reconciled to what the spec now names, with no domain given
    const legacy = sdlNow();
    legacy.services.login.expose[0].accept = [`login.${DOMAIN}`];
    fs.writeFileSync(sdlFile, yaml.dump(legacy));
    const stored = JSON.parse(w.db.getLaunch("fl")!.spec_json);
    delete stored.topology.components.mastodon.walletLogin.domain;
    w.db.setLaunchSpec("fl", JSON.stringify(stored));
    w.fleet.requestMastodonSettings(w.db.getLaunch("fl")!, row, { walletLogin: { enabled: true } });
    expect((await runOps(w, s)).status).toBe("completed");
    expect(sdlNow().services.login.expose[0].accept).toEqual([LOGIN_DOMAIN]);
  }, 180_000);

  it("turning wallet sign-in on moves the instance to a deployment with the login service, data and all", async () => {
    const s = withOldImages(spec({ enabled: true, domain: DOMAIN, owner }, publicEndpoints));
    const w = await launch(s);
    expect(w.result.status).toBe("completed");
    w.fleet.materialize("fl");
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "mastodon")!;
    w.services.provider.mastodon.get(before.dseq)!.token = "token-original";
    const on = { walletLogin: { enabled: true } };
    const sdlNow = () => yaml.load(fs.readFileSync(path.join(w.work, "launches", "fl", "sdl", "mastodon.yaml"), "utf8")) as any;

    // the launch's images predate sign-in: refused until they are upgraded
    expect(() => w.fleet.requestMastodonSettings(w.db.getLaunch("fl")!, before, on)).toThrow(/predates wallet sign-in/);
    // sdap first: no service runs it here (no bridge), so the upgrade only
    // records it, and must not put it in place of Mastodon's web image
    const webImage = sdlNow().services.mastodon.image;
    w.fleet.requestUpgrade(w.db.getLaunch("fl")!, ["mastodon"], LOGIN_IMAGES.sdap);
    const signedBeforeSdap = w.signer.signed.length;
    expect((await runOps(w, s)).status).toBe("completed");
    expect(sdlNow().services.mastodon.image).toBe(webImage);
    expect(w.signer.signed.length).toBe(signedBeforeSdap);
    expect(JSON.parse(w.db.getLaunch("fl")!.spec_json).images.sdap).toBe(LOGIN_IMAGES.sdap);
    w.fleet.requestUpgrade(w.db.getLaunch("fl")!, ["mastodon"], LOGIN_IMAGES.mastodon);
    expect((await runOps(w, s)).status).toBe("completed");
    expect(sdlNow().services.mastodon.image).toBe(LOGIN_IMAGES.mastodon);

    expect(w.fleet.mastodonSettingsMove(w.db.getLaunch("fl")!, on)).toBe(true);
    const { opId, move } = w.fleet.requestMastodonSettings(w.db.getLaunch("fl")!, before, on);
    expect(move).toBe(true);
    // the spec takes sign-in only once the new deployment holds the data
    expect(JSON.parse(w.db.getLaunch("fl")!.spec_json).topology.components.mastodon.walletLogin).toBeUndefined();
    expect(() => w.fleet.requestMastodonSettings(w.db.getLaunch("fl")!, before, on)).toThrow(/already being moved/);

    // same provider, so the instance's own domains still answer, but nothing
    // points at the new login domain yet: the move pauses with its target
    w.services.rpc.darkUrls.add(`${LOGIN_DOMAIN}`);
    const paused = await runOps(w, s);
    expect(paused.status).toBe("awaiting-user");
    expect(paused.reason).toContain(`${LOGIN_DOMAIN} → CNAME`);
    expect(paused.reason).not.toContain(`streaming.${DOMAIN}`);
    w.services.rpc.darkUrls.delete(`${LOGIN_DOMAIN}`);

    const done = await runOps(w, s);
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");

    const after = w.db.listFleetComponents("fl").find((c) => c.key === "mastodon")!;
    expect(after.dseq).not.toBe(before.dseq);
    const sdl = yaml.load(fs.readFileSync(path.join(w.work, "launches", "fl", "sdl", "mastodon.yaml"), "utf8")) as any;
    expect(Object.keys(sdl.services)).toContain("login");
    expect(sdl.services.login.image).toBe(LOGIN_IMAGES.sdap);
    expect(sdl.services.mastodon.image).toBe(LOGIN_IMAGES.mastodon);
    expect(sdl.profiles.compute.mastodon.resources.memory.size).toBe("2Gi"); // the size it had
    expect(JSON.parse(w.db.getLaunch("fl")!.spec_json).topology.components.mastodon.walletLogin).toMatchObject({ enabled: true });
    const moved = w.services.provider.mastodon.get(after.dseq)!;
    expect(moved.token).toBe("token-original");
    expect(Object.keys(moved.loginChains ?? {})).toEqual(["fl"]);
  }, 180_000);
});
