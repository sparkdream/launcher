import fs from "node:fs";
import path from "node:path";
import { nodes } from "@sparkdream/launch-spec";
import { AwaitUser, type StepCtx, type StepDef } from "../engine.js";
import {
  accountDepositMsg,
  createCertificateMsg,
  createDeploymentMsg,
  createLeaseMsg,
  type Msg,
} from "../akash/messages.js";
import { pollBids } from "../akash/client.js";
import { selectProvider, type PolicyDecision } from "../akash/policy.js";
import { loadSdl, sdlArtifacts, sortedJson } from "../akash/sdl-groups.js";
import { vendorDir } from "../vendor.js";
import type { Certificate } from "../services.js";
import { placeholder } from "./phase-a.js";

/** Initial escrow deposit per pricing denom (M2 estimate-costs refines this). */
const DEFAULT_DEPOSIT: Record<string, string> = { uakt: "5000000", uact: "5000000" };

function owner(ctx: StepCtx): string {
  const launch = ctx.db.getLaunch(ctx.launchId);
  if (!launch?.owner) throw new Error("launch has no owner wallet address");
  return launch.owner;
}

function certPaths(ctx: StepCtx) {
  return {
    cert: path.join(ctx.dirs.secrets, "akash-cert.pem"),
    key: path.join(ctx.dirs.secrets, "akash-cert-key.pem"),
    pub: path.join(ctx.dirs.secrets, "akash-cert-pub.pem"),
  };
}

export function loadCert(ctx: StepCtx): Certificate {
  const p = certPaths(ctx);
  return {
    certPem: fs.readFileSync(p.cert, "utf8"),
    keyPem: fs.readFileSync(p.key, "utf8"),
    pubkeyPem: fs.readFileSync(p.pub, "utf8"),
  };
}

// --- Phase B ---

export const ensureCertificateStep: StepDef = {
  name: "ensure-certificate",
  async run(ctx) {
    const addr = owner(ctx);
    const p = certPaths(ctx);
    fs.mkdirSync(ctx.dirs.secrets, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(p.cert)) {
      const cert = await ctx.services.certs.generate(addr);
      fs.writeFileSync(p.cert, cert.certPem);
      fs.writeFileSync(p.key, cert.keyPem, { mode: 0o600 });
      fs.writeFileSync(p.pub, cert.pubkeyPem);
    }
    const cert = loadCert(ctx);
    const txHash = await ctx.requireTx("ensure-certificate", [
      createCertificateMsg(addr, cert.certPem, cert.pubkeyPem),
    ]);
    return { txHash };
  },
};

// --- Phase C ---

export interface HeadscaleOutput {
  dseq: string;
  provider: string;
  hostUri: string;
  price: string;
  sshHost: string;
  sshPort: number;
}

export const deployHeadscaleStep: StepDef = {
  name: "deploy-headscale",
  async run(ctx): Promise<HeadscaleOutput> {
    const addr = owner(ctx);
    const sdlPath = path.join(vendorDir(), "mesh", "headscale.sdl.yaml");
    const sdl = loadSdl(sdlPath);
    const artifacts = sdlArtifacts(sdl);

    // dseq derived from chain height (console-air pattern), pinned in the tx
    const dseq = String(await ctx.services.api.latestBlockHeight());
    const deposit = {
      denom: artifacts.pricingDenom,
      amount: DEFAULT_DEPOSIT[artifacts.pricingDenom] ?? "5000000",
    };
    await ctx.requireTx("deploy-headscale:deployment", [
      createDeploymentMsg({ owner: addr, dseq, groups: artifacts.groups, hash: artifacts.hash, deposit }),
    ]);

    const bids = await pollBids(ctx.services.api, addr, dseq, {
      sleep: ctx.services.sleep,
      minBids: 1,
    });
    const providers = await ctx.services.api.listProviders();
    const decision = selectProvider(bids, {
      policy: ctx.spec.providers.policy,
      chosenProviders: new Set(),
      requiredStorageClass: artifacts.requiredStorageClass,
      providers,
    });
    if (!decision.chosen) {
      throw new AwaitUser(
        "deploy-headscale",
        `no acceptable headscale bids: ${JSON.stringify(decision.rejected)}`,
      );
    }
    const bidId = decision.chosen.bid.bid_id;
    await ctx.requireTx("deploy-headscale:lease", [createLeaseMsg(bidId)]);

    const cert = loadCert(ctx);
    const info = providers.get(bidId.provider)!;
    await ctx.services.provider.sendManifest(cert, info.hostUri, dseq, sortedJson(artifacts.manifest));
    const status = await ctx.services.provider.leaseStatus(cert, info.hostUri, dseq, bidId.gseq, bidId.oseq);
    const ssh = extractForwardedPort(status, 2222);

    // DNS gate (§5 step 9): headscale must answer on its public domain
    const url = `https://${ctx.spec.topology.headscale.domain}/health`;
    if (!(await ctx.services.rpc.httpOk(url))) {
      throw new AwaitUser(
        "deploy-headscale",
        `headscale not reachable at ${url} — create the DNS A record to ${info.hostUri} ` +
          `(Cloudflare: SSL=Flexible, WebSockets on), then resume`,
      );
    }
    return {
      dseq,
      provider: bidId.provider,
      hostUri: info.hostUri,
      price: decision.chosen.bid.price.amount,
      sshHost: ssh.host,
      sshPort: ssh.port,
    };
  },
};

export interface PreauthKeys {
  perNode: Record<string, string>;
  home: string;
}

export const configureHeadscaleStep: StepDef = {
  name: "configure-headscale",
  async run(ctx): Promise<PreauthKeys> {
    const hs = ctx.output<HeadscaleOutput>("deploy-headscale");
    if (!hs) throw new Error("deploy-headscale output missing");
    const target = sshTarget(ctx, hs.sshHost, hs.sshPort);
    const domain = ctx.spec.topology.headscale.domain;

    await ctx.services.ssh.exec(
      target,
      `sed -i 's|^server_url:.*|server_url: https://${domain}|' /etc/headscale/config.yaml && kill 1`,
    );
    await ctx.services.ssh.exec(
      target,
      `headscale users create ${ctx.spec.network.name} 2>/dev/null || true`,
    );

    const mint = async (label: string) => {
      const res = await ctx.services.ssh.exec(
        target,
        `headscale preauthkeys create --user ${ctx.spec.network.name} --reusable --expiration 8760h --output json`,
      );
      const parsed = JSON.parse(res.stdout.trim());
      const key = typeof parsed === "string" ? parsed : parsed.key;
      if (!key) throw new Error(`no preauth key in output for ${label}`);
      return key as string;
    };

    const perNode: Record<string, string> = {};
    for (const node of nodes(ctx.spec)) perNode[node.key] = await mint(node.key);
    const home = await mint("home");
    return { perNode, home };
  },
};

export const seedHeadscaleBackupStep: StepDef = {
  name: "seed-headscale-backup",
  async run(ctx) {
    const backup = ctx.spec.topology.headscale.backup;
    if (!backup || ctx.spec.network.type === "devnet") return { skipped: true };
    const hs = ctx.output<HeadscaleOutput>("deploy-headscale")!;
    const target = sshTarget(ctx, hs.sshHost, hs.sshPort);
    const stage = path.join(ctx.dirs.root, "headscale-backup");
    fs.mkdirSync(stage, { recursive: true });
    // Port of seed-replica.sh: db + noise/DERP keys, validated before upload
    const check = await ctx.services.ssh.exec(
      target,
      `sqlite3 /var/lib/headscale/db.sqlite "SELECT count(*) FROM users"`,
    );
    if (Number(check.stdout.trim()) === 0) throw new Error("refusing to seed: headscale db has no users");
    for (const f of ["db.sqlite", "noise_private.key"]) {
      await ctx.services.ssh.download?.(target, `/var/lib/headscale/${f}`, path.join(stage, f));
    }
    const keys = ctx.output<{ ageRecipient: string }>("generate-keys")!;
    const out = path.join(ctx.dirs.secrets, "state-keys.tar.age");
    await ctx.services.encryptBackup(stage, keys.ageRecipient, out);
    return { archive: out, uploaded: false /* S3 upload lands with M3 credentials wiring */ };
  },
};

// --- Phase D ---

export interface DeploymentPlan {
  perNode: Record<
    string,
    { dseq: string; manifestPath: string; requiredStorageClass?: string | undefined }
  >;
}

export const createDeploymentsStep: StepDef = {
  name: "create-deployments",
  async run(ctx): Promise<DeploymentPlan> {
    const addr = owner(ctx);
    const preauth = ctx.output<PreauthKeys>("configure-headscale");
    if (!preauth) throw new Error("configure-headscale output missing");

    const height = await ctx.services.api.latestBlockHeight();
    const msgs: Msg[] = [];
    const perNode: DeploymentPlan["perNode"] = {};
    let offset = 0;
    for (const node of nodes(ctx.spec)) {
      // inject the real preauth key over the Phase A placeholder
      const sdlPath = path.join(ctx.dirs.sdl, `${node.key}.yaml`);
      const rendered = fs
        .readFileSync(sdlPath, "utf8")
        .replace(placeholder.tsAuthkey(node.key), preauth.perNode[node.key]!);
      fs.writeFileSync(sdlPath, rendered);

      const artifacts = sdlArtifacts(loadSdl(sdlPath));
      const dseq = String(height + offset++); // distinct dseq per deployment, one batched tx
      const manifestPath = path.join(ctx.dirs.sdl, `${node.key}.manifest.json`);
      fs.writeFileSync(manifestPath, sortedJson(artifacts.manifest));
      perNode[node.key] = { dseq, manifestPath, requiredStorageClass: artifacts.requiredStorageClass };
      msgs.push(
        createDeploymentMsg({
          owner: addr,
          dseq,
          groups: artifacts.groups,
          hash: artifacts.hash,
          deposit: {
            denom: artifacts.pricingDenom,
            amount: DEFAULT_DEPOSIT[artifacts.pricingDenom] ?? "5000000",
          },
        }),
      );
    }
    // §5 step 12 caveat: batching unproven — chunk fallback decided in M2 devnet spike
    await ctx.requireTx("create-deployments", msgs);
    return { perNode };
  },
};

export interface Assignments {
  perNode: Record<
    string,
    { provider: string; hostUri: string; price: string; gseq: number; oseq: number; decision: PolicyDecision }
  >;
}

export const collectBidsStep: StepDef = {
  name: "collect-bids",
  async run(ctx): Promise<Assignments> {
    const addr = owner(ctx);
    const plan = ctx.output<DeploymentPlan>("create-deployments")!;
    const hs = ctx.output<HeadscaleOutput>("deploy-headscale")!;
    const providers = await ctx.services.api.listProviders();

    const chosen = new Set<string>([hs.provider]);
    const perNode: Assignments["perNode"] = {};
    for (const [key, entry] of Object.entries(plan.perNode)) {
      const bids = await pollBids(ctx.services.api, addr, entry.dseq, {
        sleep: ctx.services.sleep,
        minBids: 1,
      });
      const decision = selectProvider(bids, {
        policy: ctx.spec.providers.policy,
        chosenProviders: chosen,
        requiredStorageClass: entry.requiredStorageClass,
        providers,
      });
      if (!decision.chosen) {
        throw new AwaitUser(
          "collect-bids",
          `no acceptable bids for ${key}: ${JSON.stringify(decision.rejected)}`,
        );
      }
      const bid = decision.chosen.bid;
      chosen.add(bid.bid_id.provider);
      perNode[key] = {
        provider: bid.bid_id.provider,
        hostUri: providers.get(bid.bid_id.provider)!.hostUri,
        price: bid.price.amount,
        gseq: bid.bid_id.gseq,
        oseq: bid.bid_id.oseq,
        decision,
      };
    }
    return { perNode };
  },
};

export const createLeasesStep: StepDef = {
  name: "create-leases",
  async run(ctx) {
    const addr = owner(ctx);
    const plan = ctx.output<DeploymentPlan>("create-deployments")!;
    const assignments = ctx.output<Assignments>("collect-bids")!;
    const msgs = Object.entries(assignments.perNode).map(([key, a]) =>
      createLeaseMsg({
        owner: addr,
        dseq: plan.perNode[key]!.dseq,
        gseq: a.gseq,
        oseq: a.oseq,
        provider: a.provider,
      }),
    );
    const txHash = await ctx.requireTx("create-leases", msgs);
    return { txHash };
  },
};

export interface SshEndpoints {
  perNode: Record<string, { host: string; port: number }>;
}

export const sendManifestsStep: StepDef = {
  name: "send-manifests",
  async run(ctx): Promise<SshEndpoints> {
    const plan = ctx.output<DeploymentPlan>("create-deployments")!;
    const assignments = ctx.output<Assignments>("collect-bids")!;
    const cert = loadCert(ctx);
    const perNode: SshEndpoints["perNode"] = {};
    for (const [key, entry] of Object.entries(plan.perNode)) {
      const a = assignments.perNode[key]!;
      const manifest = fs.readFileSync(entry.manifestPath, "utf8");
      await ctx.services.provider.sendManifest(cert, a.hostUri, entry.dseq, manifest);
      const status = await ctx.services.provider.leaseStatus(cert, a.hostUri, entry.dseq, a.gseq, a.oseq);
      perNode[key] = extractForwardedPort(status, 2222);
    }
    return { perNode };
  },
};

// --- shared helpers ---

export function sshTarget(ctx: StepCtx, host: string, port: number) {
  return {
    host,
    port,
    user: "root",
    privateKeyPem: fs.readFileSync(path.join(ctx.dirs.secrets, "ssh_ed25519.pem"), "utf8"),
  };
}

/** Pull a forwarded port mapping out of a provider lease-status payload. */
export function extractForwardedPort(status: unknown, internalPort: number): { host: string; port: number } {
  const s = status as any;
  const lists: any[] = Object.values(s?.forwarded_ports ?? {});
  for (const list of lists) {
    for (const fp of list as any[]) {
      if (fp.port === internalPort) return { host: fp.host, port: fp.externalPort };
    }
  }
  throw new Error(`no forwarded port for ${internalPort} in lease status`);
}

export function phaseBCDSteps(): StepDef[] {
  return [
    ensureCertificateStep,
    deployHeadscaleStep,
    configureHeadscaleStep,
    seedHeadscaleBackupStep,
    createDeploymentsStep,
    collectBidsStep,
    createLeasesStep,
    sendManifestsStep,
  ];
}
