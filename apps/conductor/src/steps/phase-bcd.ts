import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { nodes, statelessComponents } from "@sparkdream/launch-spec";
import { AwaitUser, type StepCtx, type StepDef } from "../engine.js";
import { sendMsg } from "@sparkdream/akash-tx";
import {
  accountDepositMsg,
  closeDeploymentMsg,
  createCertificateMsg,
  createDeploymentMsg,
  createLeaseMsg,
  TypeUrl,
  type Msg,
} from "../akash/messages.js";
import { feeCoin, feeConfig, launchFeeAmount } from "../fee.js";
import { PRICING_DENOM } from "../render-sdl.js";
import { pollBids } from "../akash/client.js";
import { selectProvider, type PolicyDecision } from "../akash/policy.js";
import { loadSdl, sdlArtifacts, sortedJson } from "../akash/sdl-groups.js";
import { vendorDir } from "../vendor.js";
import type { Certificate, SshTarget } from "../services.js";
import { placeholder } from "./phase-a.js";
import { readSecretFile, writeSecretFile } from "../secrets.js";
import { toSsh2CompatiblePrivateKey } from "../keys.js";

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
    keyPem: readSecretFile(p.key),
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
      writeSecretFile(p.key, cert.keyPem);
      fs.writeFileSync(p.pub, cert.pubkeyPem);
    } else {
      // self-heal pubkeys written before the "EC PUBLIC KEY" relabel fix in
      // OpensslCertProvider (x/cert rejects the standard SPKI label; the
      // key bytes are identical)
      const pub = fs.readFileSync(p.pub, "utf8");
      if (/(BEGIN|END) PUBLIC KEY/.test(pub)) {
        fs.writeFileSync(p.pub, pub.replace(/(BEGIN|END) PUBLIC KEY/g, "$1 EC PUBLIC KEY"));
      }
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
  gseq: number;
  oseq: number;
}

/** Resolve a headscale user's numeric id — preauthkeys --user rejects names. */
export async function headscaleUserId(
  ctx: StepCtx,
  hs: Pick<HeadscaleOutput, "hostUri" | "dseq" | "gseq" | "oseq">,
  name: string,
): Promise<string> {
  const res = await headscaleShell(ctx, hs, "headscale users list --output json");
  const users = JSON.parse(res.stdout.trim() || "[]");
  const user = (users as Array<{ id: number | string; name: string }>).find(
    (u) => u.name === name,
  );
  if (!user) throw new Error(`headscale user ${name} not found after create`);
  return String(user.id);
}

/**
 * Run a command inside the headscale container via the provider's
 * lease-shell — the headscale image has no sshd (its entrypoint execs
 * straight into litestream/headscale), so SSH is not an option there.
 */
function headscaleShell(
  ctx: StepCtx,
  hs: Pick<HeadscaleOutput, "hostUri" | "dseq" | "gseq" | "oseq">,
  script: string,
) {
  return ctx.services.provider.shellExec(
    loadCert(ctx),
    hs.hostUri,
    hs.dseq,
    hs.gseq,
    hs.oseq,
    "headscale",
    ["sh", "-c", script],
  );
}

/**
 * Template the vendored headscale SDL with the spec's real values — the
 * vendored file hardcodes an example `accept:` hostname and CHANGE_ME
 * litestream/age env placeholders (the manual flow edits these by hand).
 * Shared by the deploy step and the fleet SDL-download endpoint.
 */
export function templateHeadscaleSdl(
  spec: StepCtx["spec"],
  deps: { ageRecipient?: string | undefined; ageIdentity?: string | undefined } = {},
): ReturnType<typeof loadSdl> {
  const sdl = loadSdl(path.join(vendorDir(), "mesh", "headscale.sdl.yaml"));
  const domain = spec.topology.headscale.domain;
  const backup = spec.topology.headscale.backup;
  for (const svc of Object.values(sdl.services) as any[]) {
    for (const e of svc.expose ?? []) {
      if (e.accept) e.accept = [domain];
    }
    if (!svc.env) continue;
    if (!backup) {
      // no backup configured → drop the placeholder env entirely: the
      // entrypoint only runs headscale standalone when LITESTREAM_S3_BUCKET
      // is UNSET, and a literal "CHANGE_ME" bucket boots litestream against
      // a bogus endpoint — the container crash-loops and never turns ready
      svc.env = svc.env.filter((e: string) => !/^(LITESTREAM_|AGE_)/.test(e));
    } else {
      const secretEnv = backup.s3.secretRef.replace(/^env:/, "");
      const values: Record<string, string | undefined> = {
        LITESTREAM_S3_ENDPOINT: backup.s3.endpoint,
        LITESTREAM_S3_BUCKET: backup.s3.bucket,
        LITESTREAM_S3_REGION: backup.s3.region,
        LITESTREAM_S3_ACCESS_KEY_ID: backup.s3.accessKeyId,
        LITESTREAM_S3_SECRET_ACCESS_KEY: process.env[secretEnv],
        AGE_RECIPIENT: deps.ageRecipient,
        AGE_IDENTITY: deps.ageIdentity,
      };
      if (!values.LITESTREAM_S3_SECRET_ACCESS_KEY) {
        throw new Error(`headscale backup: ${backup.s3.secretRef} is not set in the environment`);
      }
      svc.env = svc.env.map((e: string) => {
        const key = e.split("=")[0]!;
        return values[key] ? `${key}=${values[key]}` : e;
      });
    }
  }
  return sdl;
}

export const deployHeadscaleStep: StepDef = {
  name: "deploy-headscale",
  async run(ctx): Promise<HeadscaleOutput> {
    const addr = owner(ctx);
    const domain = ctx.spec.topology.headscale.domain;
    const backup = ctx.spec.topology.headscale.backup;
    const sdl = templateHeadscaleSdl(ctx.spec, {
      ageRecipient: backup
        ? ctx.output<{ ageRecipient: string }>("generate-keys")!.ageRecipient
        : undefined,
      ageIdentity: backup
        ? readSecretFile(path.join(ctx.dirs.secrets, "age.txt"))
            .split("\n")
            .find((l) => l.startsWith("AGE-SECRET-KEY-"))
        : undefined,
    });
    // persist the rendered SDL beside the node SDLs (fleet SDL download)
    fs.mkdirSync(ctx.dirs.sdl, { recursive: true });
    fs.writeFileSync(path.join(ctx.dirs.sdl, "headscale.yaml"), yaml.dump(sdl, { lineWidth: 120 }));
    const artifacts = sdlArtifacts(sdl);

    const deposit = {
      denom: artifacts.pricingDenom,
      amount: DEFAULT_DEPOSIT[artifacts.pricingDenom] ?? "5000000",
    };

    const providers = await ctx.services.api.listProviders();
    let dseq!: string;
    let bidId!: { owner: string; dseq: string; gseq: number; oseq: number; provider: string };
    let price!: string;

    // close a dead order (refunding escrow) and forget its pinned dseq +
    // txs so the next pass redeploys fresh
    const redeploy = async (staleDseq: string, why: string) => {
      ctx.log(`headscale order ${staleDseq} ${why} — closing and redeploying`);
      // a provider-closed lease usually takes the whole deployment down with
      // it — MsgCloseDeployment on a closed deployment fails simulation, so
      // only ask for a close signature when there's something left to close
      if ((await ctx.services.api.deploymentInfo(addr, staleDseq))?.state === "active") {
        await ctx.requireTx(`deploy-headscale:close:${staleDseq}`, [closeDeploymentMsg(addr, staleDseq)]);
      } else {
        ctx.db.deletePendingTx(ctx.launchId, `deploy-headscale:close:${staleDseq}`);
      }
      clearPin(ctx, "headscale-dseq");
      ctx.db.deletePendingTx(ctx.launchId, "deploy-headscale:deployment");
      ctx.db.deletePendingTx(ctx.launchId, "deploy-headscale:lease");
    };

    const leaseRow = ctx.db.getPendingTx(ctx.launchId, "deploy-headscale:lease");
    let haveLease = Boolean(
      leaseRow && (leaseRow.status === "signed" || leaseRow.status === "confirmed"),
    );
    if (haveLease) {
      // A lease was already signed on a prior run — its bid IS the choice.
      // Don't re-poll bids: leasing flips the winner to "active" and closes
      // the rest, so a re-run would misread the order as dead (and the old
      // stale-order path would offer to close a LIVE deployment).
      dseq = await pinnedValue(ctx, "headscale-dseq", async () =>
        String(await ctx.services.api.latestBlockHeight()),
      );
      bidId = JSON.parse(leaseRow!.msgs_json)[0].value.bidId;
      // providers close leases whose manifest never arrives — that order is
      // dead (all bids spent), so start over
      const leaseState = await ctx.services.api.leaseState(addr, dseq, bidId.provider);
      if (leaseState === "closed") {
        await redeploy(dseq, "lease closed by the provider (manifest never accepted)");
        haveLease = false;
      } else {
        // drop any close erroneously enqueued by a pre-fix run against this dseq
        ctx.db.deletePendingTx(ctx.launchId, `deploy-headscale:close:${dseq}`);
        await ctx.requireTx("deploy-headscale:lease", [createLeaseMsg(bidId)]);
        const bids = await ctx.services.api.listBids(addr, dseq);
        price = bids.find((b) => b.bid.id.provider === bidId.provider)?.bid.price.amount ?? "0";
      }
    }
    if (!haveLease) {
      let bids;
      // Akash bids expire minutes after the order opens; the signing loop's
      // human latency can outlive them. A stale order (bids exist, none open
      // or active) never recovers — close it to refund the escrow and
      // redeploy fresh.
      for (let round = 0; ; round++) {
        // dseq derived from chain height (console-air pattern) — PINNED to the
        // workdir on first computation: this step re-runs after the signature
        // pause, and a recomputed dseq would diverge from the signed tx
        dseq = await pinnedValue(ctx, "headscale-dseq", async () =>
          String(await ctx.services.api.latestBlockHeight()),
        );
        await ctx.requireTx("deploy-headscale:deployment", [
          createDeploymentMsg({ owner: addr, dseq, groups: artifacts.groups, hash: artifacts.hash, deposit }),
        ]);

        const existing = await ctx.services.api.listBids(addr, dseq);
        const alive = existing.some((b) => b.bid.state === "open" || b.bid.state === "active");
        if (existing.length === 0 || alive) {
          bids = await pollBids(ctx.services.api, addr, dseq, {
            sleep: ctx.services.sleep,
            minBids: 1,
            // console-air-style: gather a fuller bid set before the policy engine picks
            settleRounds: 2,
          });
          break;
        }
        if (round >= 1) {
          throw new AwaitUser(
            "deploy-headscale",
            `bids on redeployed order ${dseq} expired too — sign faster, or check provider supply, then resume`,
          );
        }
        await redeploy(dseq, `went stale (all ${existing.length} bids closed)`);
      }
      const openBids = bids.filter((b) => b.bid.state === "open");
      // wallet-wide provider prefs apply to the initial pick, not just
      // relaunches — avoid is a hard filter, prefer outranks the spec's list
      const prefs = ctx.db.providerPrefs(addr);
      const decision = selectProvider(openBids, {
        policy: {
          ...ctx.spec.providers.policy,
          preference: [...new Set([...prefs.prefer, ...ctx.spec.providers.policy.preference])],
        },
        chosenProviders: new Set(),
        avoidProviders: new Set(prefs.avoid),
        requiredStorageClass: artifacts.requiredStorageClass,
        providers,
      });
      if (!decision.chosen) {
        throw new AwaitUser(
          "deploy-headscale",
          `no acceptable headscale bids: ${JSON.stringify(decision.rejected)}`,
        );
      }
      bidId = decision.chosen.bid.id;
      price = decision.chosen.bid.price.amount;
      await ctx.requireTx("deploy-headscale:lease", [createLeaseMsg(bidId)]);
    }

    // the manifest hash must match the deployment on-chain — if the renderer
    // changed since the deployment tx (e.g. a manifest-shape fix), update the
    // deployment in place (keeps the lease) before pushing the manifest
    const wantHash = Buffer.from(artifacts.hash).toString("base64");
    const onChain = await ctx.services.api.deploymentInfo(addr, dseq);
    if (onChain?.hash && onChain.hash !== wantHash) {
      ctx.log(`headscale manifest hash drifted from deployment ${dseq} — updating on-chain`);
      await ctx.requireTx(`deploy-headscale:update:${dseq}:${wantHash.slice(0, 8)}`, [
        {
          typeUrl: TypeUrl.UpdateDeployment,
          value: { id: { owner: addr, dseq }, hash: wantHash },
        },
      ]);
    }

    const cert = loadCert(ctx);
    const info = providers.get(bidId.provider)!;
    await ctx.services.provider.sendManifest(cert, info.hostUri, dseq, artifacts.manifestJson);
    // confirm the workload is running — and grab the provider ingress
    // hostname, which is what the user's DNS record must point at (NOT the
    // provider's :8443 API endpoint)
    const status: any = await waitLeaseStatus(
      ctx, cert, info.hostUri, dseq, bidId.gseq, bidId.oseq,
    );
    const uris: string[] = Object.values(status?.services ?? {}).flatMap(
      (s: any) => s?.uris ?? [],
    );
    const ingress = uris.find((u) => u !== domain) ?? new URL(info.hostUri).hostname;

    // DNS gate (§5 step 9): headscale must answer on its public domain
    const url = `https://${domain}/health`;
    if (!(await ctx.services.rpc.httpOk(url))) {
      throw new AwaitUser(
        "deploy-headscale",
        `headscale not reachable at ${url} — create a DNS record for ${domain} → ` +
          `CNAME ${ingress} (or an A record to that host's IP). ` +
          `Cloudflare: proxy on, SSL=Flexible, WebSockets on. Then resume.`,
      );
    }
    return {
      dseq,
      provider: bidId.provider,
      hostUri: info.hostUri,
      price,
      gseq: bidId.gseq,
      oseq: bidId.oseq,
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
    const domain = ctx.spec.topology.headscale.domain;

    await headscaleShell(
      ctx,
      hs,
      `sed -i 's|^server_url:.*|server_url: https://${domain}|' /etc/headscale/config.yaml`,
    );
    // kill 1 restarts the container — the shell connection dies with it, so
    // tolerate the drop, then wait for the pod to actually accept commands
    // again. (The lease-status `available` counter is NOT a readiness
    // signal — it reads 1 even mid-crash-loop; the shell itself is.)
    await headscaleShell(ctx, hs, "kill 1").catch(() => {});
    let up = false;
    for (let i = 0; i < 20 && !up; i++) {
      await ctx.services.sleep(4000);
      try {
        await headscaleShell(ctx, hs, "true");
        up = true;
      } catch {
        // "no active replica" / connection refused while the pod restarts
      }
    }
    if (!up) throw new Error("headscale did not come back after server_url restart");
    await headscaleShell(
      ctx,
      hs,
      `headscale users create ${ctx.spec.network.name} 2>/dev/null || true`,
    );
    // preauthkeys --user takes the NUMERIC id, not the name (DEPLOYMENT.md:
    // "note the numeric user ID from headscale users list")
    const userId = await headscaleUserId(ctx, hs, ctx.spec.network.name);

    const mint = async (label: string) => {
      const res = await headscaleShell(
        ctx,
        hs,
        `headscale preauthkeys create --user ${userId} --reusable --expiration 8760h --output json`,
      );
      const parsed = JSON.parse(res.stdout.trim());
      const key = typeof parsed === "string" ? parsed : parsed.key;
      if (!key) throw new Error(`no preauth key in output for ${label}`);
      return key as string;
    };

    const perNode: Record<string, string> = {};
    for (const node of nodes(ctx.spec)) perNode[node.key] = await mint(node.key);
    for (const c of statelessComponents(ctx.spec)) {
      if (c.mesh) perNode[c.key] = await mint(c.key);
    }
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
    const stage = path.join(ctx.dirs.root, "headscale-backup");
    fs.mkdirSync(stage, { recursive: true });
    // Port of seed-replica.sh: db + noise/DERP keys, validated before upload.
    // No sshd in the headscale image — files come out base64 over lease-shell.
    const check = await headscaleShell(
      ctx,
      hs,
      `sqlite3 /var/lib/headscale/db.sqlite "SELECT count(*) FROM users"`,
    );
    if (Number(check.stdout.trim()) === 0) throw new Error("refusing to seed: headscale db has no users");
    for (const f of ["db.sqlite", "noise_private.key"]) {
      const b64 = await headscaleShell(ctx, hs, `base64 /var/lib/headscale/${f}`);
      fs.writeFileSync(path.join(stage, f), Buffer.from(b64.stdout.replace(/\s+/g, ""), "base64"));
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

    // a fleet shutdown may have closed headscale while this launch sat in
    // recovery — the nodes about to be deployed can never join the mesh
    // without it, so refuse before spending their deposits. Only positive
    // evidence pauses (an LCD hiccup must not wedge a healthy launch).
    const hs = ctx.output<HeadscaleOutput>("deploy-headscale");
    if (hs) {
      const info = await ctx.services.api.deploymentInfo(addr, hs.dseq).catch(() => undefined);
      if (info && info.state !== "active") {
        throw new AwaitUser(
          "create-deployments",
          `headscale deployment ${hs.dseq} is closed on-chain (fleet shut down?) — ` +
            "this launch cannot continue without its mesh coordinator. " +
            "Shut down the fleet and start a new launch from the same spec.",
        );
      }
    }

    // a re-run after stale-bid recovery may inherit an orphaned close row
    // (recovery raced a fleet shutdown that had already closed everything);
    // this step re-running means that generation is dead either way
    ctx.db.deleteUnsignedPendingTxsLike(ctx.launchId, "create-leases:close:%");

    // pinned for the same reason as the headscale dseq: the signed batch
    // must match the plan across re-runs of this step
    const height = Number(
      await pinnedValue(ctx, "node-dseq-base", async () =>
        String(await ctx.services.api.latestBlockHeight()),
      ),
    );
    const msgs: Msg[] = [];
    const perNode: DeploymentPlan["perNode"] = {};
    let offset = 0;
    // nodes + stateless components share the one batched tx (§5 step 12)
    const deployKeys = [
      ...nodes(ctx.spec).map((n) => n.key),
      ...statelessComponents(ctx.spec).map((c) => c.key),
    ];
    for (const key of deployKeys) {
      // inject the real preauth key over the Phase A placeholder (the
      // frontend never joins the mesh, so it has no key to inject)
      const sdlPath = path.join(ctx.dirs.sdl, `${key}.yaml`);
      let rendered = fs.readFileSync(sdlPath, "utf8");
      const authkey = preauth.perNode[key];
      if (authkey) rendered = rendered.replace(placeholder.tsAuthkey(key), authkey);
      fs.writeFileSync(sdlPath, rendered);

      const artifacts = sdlArtifacts(loadSdl(sdlPath));
      const dseq = String(height + offset++); // distinct dseq per deployment, one batched tx
      const manifestPath = path.join(ctx.dirs.sdl, `${key}.manifest.json`);
      fs.writeFileSync(manifestPath, artifacts.manifestJson);
      perNode[key] = { dseq, manifestPath, requiredStorageClass: artifacts.requiredStorageClass };
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
    // anti-affinity covers headscale/validators/sentries (§6); the stateless
    // components can share providers freely — requiring N more distinct
    // providers for them would only shrink the viable bid set
    const stateless = new Set<string>(statelessComponents(ctx.spec).map((c) => c.key));
    // wallet-wide provider prefs apply to the initial pick, not just
    // relaunches — avoid is a hard filter, prefer outranks the spec's list
    const prefs = ctx.db.providerPrefs(addr);
    const policy = {
      ...ctx.spec.providers.policy,
      preference: [...new Set([...prefs.prefer, ...ctx.spec.providers.policy.preference])],
    };
    const avoidProviders = new Set(prefs.avoid);
    const perNode: Assignments["perNode"] = {};
    for (const [key, entry] of Object.entries(plan.perNode)) {
      const bids = await pollBids(ctx.services.api, addr, entry.dseq, {
        sleep: ctx.services.sleep,
        minBids: 1,
        // console-air-style: gather a fuller bid set before the policy engine picks
        settleRounds: 2,
      });
      const decision = selectProvider(bids.filter((b) => b.bid.state === "open"), {
        policy,
        chosenProviders: stateless.has(key) ? new Set<string>() : chosen,
        avoidProviders,
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
      if (!stateless.has(key)) chosen.add(bid.id.provider);
      perNode[key] = {
        provider: bid.id.provider,
        hostUri: providers.get(bid.id.provider)!.hostUri,
        price: bid.price.amount,
        gseq: bid.id.gseq,
        oseq: bid.id.oseq,
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

    // Bids expire minutes after their order opens, so a launch that sat at
    // this signature holds assignments the chain will reject ("bid not
    // open"). Re-check freshness before asking for a signature — but only
    // while nothing is signed: leasing flips the winner to "active" and
    // closes the rest, so a re-check after signing would misread a good
    // batch as stale (same trap as the headscale stale-order path).
    const row = ctx.db.getPendingTx(ctx.launchId, "create-leases");
    if (!row || row.status === "pending" || row.status === "failed") {
      const stale: string[] = [];
      for (const [key, a] of Object.entries(assignments.perNode)) {
        const bids = await ctx.services.api.listBids(addr, plan.perNode[key]!.dseq);
        const bid = bids.find(
          (b) =>
            b.bid.id.provider === a.provider &&
            b.bid.id.gseq === a.gseq &&
            b.bid.id.oseq === a.oseq,
        );
        if (bid?.bid.state !== "open") stale.push(key);
      }
      if (stale.length > 0) {
        // start the node batch over: close what's still open on-chain
        // (escrow refunds on close), then forget the plan + bids so the
        // next drive redeploys fresh. Deployments and bids are cheap;
        // partial surgery on a half-stale batch is not.
        ctx.log(`bids expired for ${stale.join(", ")} — closing node deployments to redeploy`);
        // drop the unsigned lease tx FIRST: the queue serves oldest-first,
        // so the older create-leases row would shadow the close signature
        // (and signing it is exactly the "bid not open" failure)
        ctx.db.deletePendingTx(ctx.launchId, "create-leases");
        const closes: Msg[] = [];
        for (const { dseq } of Object.values(plan.perNode)) {
          if ((await ctx.services.api.deploymentInfo(addr, dseq))?.state === "active") {
            closes.push(closeDeploymentMsg(addr, dseq));
          }
        }
        const closeStep = `create-leases:close:${Object.values(plan.perNode)[0]!.dseq}`;
        if (closes.length > 0) {
          await ctx.requireTx(closeStep, closes);
        } else {
          // everything already closed on-chain (a fleet shutdown raced this
          // recovery) — drop the close row a prior pass may have enqueued,
          // or it wedges the oldest-first signing queue with a tx the chain
          // rejects ("Deployment closed")
          ctx.db.deletePendingTx(ctx.launchId, closeStep);
        }
        clearPin(ctx, "node-dseq-base");
        ctx.db.deletePendingTx(ctx.launchId, "create-deployments");
        ctx.db.resetStep(ctx.launchId, "create-deployments");
        ctx.db.resetStep(ctx.launchId, "collect-bids");
        throw new Error(
          `bids for ${stale.join(", ")} expired while awaiting the lease signature — ` +
            "stale deployments closed (deposits refunded); resume to redeploy and re-bid",
        );
      }
    }

    const msgs = Object.entries(assignments.perNode).map(([key, a]) =>
      createLeaseMsg({
        owner: addr,
        dseq: plan.perNode[key]!.dseq,
        gseq: a.gseq,
        oseq: a.oseq,
        provider: a.provider,
      }),
    );
    // Launch service fee: one-time send of a cut of the leased monthly
    // rate (headscale included), batched into this tx so it rides the same
    // signature and is visible in the prompt. Initial launch only —
    // relaunch ops re-lease without it.
    const fee = feeConfig();
    let feePaid: { address: string; amount: string; denom: string } | undefined;
    if (fee.launchBps > 0) {
      const hs = ctx.output<HeadscaleOutput>("deploy-headscale")!;
      const amount = launchFeeAmount(
        [hs.price, ...Object.values(assignments.perNode).map((a) => a.price)],
        fee.launchBps,
      );
      const coin = await feeCoin(
        PRICING_DENOM[ctx.spec.infra.akashNetwork],
        amount,
        ctx.services.api,
      );
      if (coin) {
        msgs.push(sendMsg(addr, fee.address, coin));
        feePaid = { address: fee.address, ...coin };
      } else {
        ctx.log("AKT oracle price unavailable — launch fee skipped");
      }
    }
    const txHash = await ctx.requireTx("create-leases", msgs);
    return { txHash, fee: feePaid };
  },
};

export interface SshEndpoints {
  perNode: Record<string, { host: string; port: number }>;
  /**
   * Sentry P2P: provider-assigned forwarded 26656 (§5 "Public peering").
   * upload-node-data writes it into external_address; the join bundle
   * recomputes it live, so this copy is only the config-render source.
   */
  p2p?: Record<string, { host: string; port: number }>;
}

export const sendManifestsStep: StepDef = {
  name: "send-manifests",
  async run(ctx): Promise<SshEndpoints> {
    const plan = ctx.output<DeploymentPlan>("create-deployments")!;
    const assignments = ctx.output<Assignments>("collect-bids")!;
    const cert = loadCert(ctx);
    // the frontend image runs no sshd — wait for the workload, but skip the
    // forwarded-port extraction (nothing ever SSHes into it)
    const noSsh = new Set<string>(
      statelessComponents(ctx.spec)
        .filter((c) => !c.mesh)
        .map((c) => c.key),
    );
    const perNode: SshEndpoints["perNode"] = {};
    const p2p: NonNullable<SshEndpoints["p2p"]> = {};
    for (const [key, entry] of Object.entries(plan.perNode)) {
      const a = assignments.perNode[key]!;
      const manifest = fs.readFileSync(entry.manifestPath, "utf8");
      await ctx.services.provider.sendManifest(cert, a.hostUri, entry.dseq, manifest);
      let status = await waitLeaseStatus(ctx, cert, a.hostUri, entry.dseq, a.gseq, a.oseq, {
        ...(noSsh.has(key) ? {} : { forwardedPort: 2222 }),
      });
      if (!noSsh.has(key)) perNode[key] = extractForwardedPort(status, 2222);
      if (key.startsWith("sentry-")) {
        // sentries expose P2P 26656 global — usually in the same status
        // payload as 2222, but give a slow provider a second look. A
        // provider that never forwards it degrades the sentry to
        // non-advertising (external_address stays empty) rather than
        // failing the launch.
        try {
          p2p[key] = extractForwardedPort(status, 26656);
        } catch {
          try {
            status = await waitLeaseStatus(ctx, cert, a.hostUri, entry.dseq, a.gseq, a.oseq, {
              forwardedPort: 26656,
              attempts: 6,
            });
            p2p[key] = extractForwardedPort(status, 26656);
          } catch {
            ctx.log(`${key}: provider forwards no P2P port; sentry will not advertise a public peer address`);
          }
        }
      }
    }
    return { perNode, p2p };
  },
};

// --- shared helpers ---

/**
 * Lease status right after a manifest PUT races the provider's kube
 * scheduler ("no deployments for lease" 404) and image pulls — poll until
 * the workload exists (and, when requested, a forwarded port appears).
 */
export async function waitLeaseStatus(
  ctx: StepCtx,
  cert: Certificate,
  hostUri: string,
  dseq: string,
  gseq: number,
  oseq: number,
  opts: { forwardedPort?: number; attempts?: number } = {},
): Promise<unknown> {
  const attempts = opts.attempts ?? 36; // × 5s ≈ 3 min (image pulls are slow)
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await ctx.services.sleep(5000);
    try {
      const status = await ctx.services.provider.leaseStatus(cert, hostUri, dseq, gseq, oseq);
      if (opts.forwardedPort === undefined) return status;
      try {
        extractForwardedPort(status, opts.forwardedPort);
        return status;
      } catch (e) {
        lastError = String(e);
      }
    } catch (e) {
      lastError = String(e);
      if (!/404|no deployments|not found/i.test(lastError)) throw e;
    }
  }
  throw new Error(`lease ${dseq} workload not up after ${attempts} checks: ${lastError}`);
}

/**
 * Compute a value once per launch and persist it in the workdir; re-runs
 * of a step (after signature pauses) get the original value back.
 */
export async function pinnedValue(
  ctx: StepCtx,
  name: string,
  compute: () => Promise<string>,
): Promise<string> {
  const file = path.join(ctx.dirs.root, `${name}.pin`);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const value = await compute();
  fs.mkdirSync(ctx.dirs.root, { recursive: true });
  fs.writeFileSync(file, value);
  return value;
}

/** Forget a pinned value so the next pinnedValue() recomputes (redeploys). */
export function clearPin(ctx: StepCtx, name: string): void {
  fs.rmSync(path.join(ctx.dirs.root, `${name}.pin`), { force: true });
}

export function sshTarget(
  ctx: StepCtx,
  host: string,
  port: number,
  shellFallback?: SshTarget["shellFallback"],
): SshTarget {
  return {
    host,
    port,
    user: "root",
    privateKeyPem: toSsh2CompatiblePrivateKey(readSecretFile(path.join(ctx.dirs.secrets, "ssh_ed25519.pem"))),
    ...(shellFallback ? { shellFallback } : {}),
  };
}

/** Lease-shell fallback descriptor for a node component (service sparkdreamd). */
export function nodeShellFallback(
  ctx: StepCtx,
  hostUri: string,
  dseq: string,
  gseq = 1,
  oseq = 1,
): NonNullable<SshTarget["shellFallback"]> {
  const cert = loadCert(ctx);
  return {
    creds: { certPem: cert.certPem, keyPem: cert.keyPem },
    hostUri,
    dseq,
    gseq,
    oseq,
    service: "sparkdreamd",
  };
}

/** SSH target for a deployed node, from the launch's own step outputs. */
export function nodeTarget(ctx: StepCtx, key: string): SshTarget {
  const ssh = ctx.output<SshEndpoints>("send-manifests");
  const ep = ssh?.perNode[key];
  if (!ep) throw new Error(`no SSH endpoint for ${key}`);
  // lease-shell fallback for providers whose forwarded ports drop SSH
  const entry = ctx.output<DeploymentPlan>("create-deployments")?.perNode[key];
  const a = ctx.output<Assignments>("collect-bids")?.perNode[key];
  const fallback =
    a && entry ? nodeShellFallback(ctx, a.hostUri, entry.dseq, a.gseq, a.oseq) : undefined;
  return sshTarget(ctx, ep.host, ep.port, fallback);
}

/**
 * External URL of a node's CometBFT RPC. The SDL exposes 26657 globally as a
 * RANDOM_PORT, so the reachable endpoint is a provider-assigned forwarded
 * port from lease status (plain http) — NOT <provider-host>:26657.
 */
export async function nodeRpcUrl(
  ctx: StepCtx,
  hostUri: string,
  dseq: string,
  gseq = 1,
  oseq = 1,
): Promise<string> {
  const status = await ctx.services.provider.leaseStatus(loadCert(ctx), hostUri, dseq, gseq, oseq);
  const ep = extractForwardedPort(status, 26657);
  return `http://${ep.host}:${ep.port}`;
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
