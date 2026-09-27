import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";
import { serviceComponents, testnetSpec, validateSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { allSteps } from "../src/index.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps } from "../src/fleet-ops.js";
import { renderComponentSdl } from "../src/render-component-sdl.js";
import { placeholder } from "../src/steps/phase-a.js";
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
    // no relay: written to disk, and validation says sign-ups cannot confirm
    const bare = spec({ enabled: true, domain: DOMAIN, owner });
    expect(envOf(render(bare, tmp())).get("SMTP_DELIVERY_METHOD")).toBe("file");
    expect(validateSpec(bare).warnings.map((w) => w.path)).toContain("topology.components.mastodon.smtp");

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
    expect(out).toMatchObject({ owner: `@admin@${DOMAIN}`, created: true, registrations: "approved" });
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
