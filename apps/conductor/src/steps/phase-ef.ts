import fs from "node:fs";
import path from "node:path";
import { nodes, resolveTopology, statelessComponents, tunnelPort } from "@sparkdream/launch-spec";
import { AwaitUser, type StepCtx, type StepDef } from "../engine.js";
import { updateDeploymentMsgs } from "../akash/update.js";
import { placeholder, type GenerateKeysOutput } from "./phase-a.js";
import { loadCert, nodeRpcUrl, nodeShellFallback, sshTarget, type Assignments, type DeploymentPlan, type SshEndpoints } from "./phase-bcd.js";
import { NODE_HOME, rpcUrl, socatTunnelCmd, START_NODE_CMD } from "../node-ops.js";
import type { SshTarget } from "../services.js";

const UPLOAD_MARKER = `${NODE_HOME}/.node-data-uploaded`;

function nodeTarget(ctx: StepCtx, key: string): SshTarget {
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

// --- Phase E ---

export const uploadNodeDataStep: StepDef = {
  name: "upload-node-data",
  async run(ctx) {
    for (const node of nodes(ctx.spec)) {
      const target = nodeTarget(ctx, node.key);
      const marker = await ctx.services.ssh.exec(target, `test -f ${UPLOAD_MARKER} && echo yes || echo no`);
      if (marker.stdout.trim() === "yes") continue; // idempotent (§5 step 16)
      const bundle = path.join(ctx.dirs.bundles, `${node.key}.tgz`);
      await ctx.services.ssh.upload(target, bundle, "/tmp/node-data.tgz");
      await ctx.services.ssh.exec(
        target,
        `mkdir -p ${NODE_HOME} && tar xzf /tmp/node-data.tgz -C ${NODE_HOME} && touch ${UPLOAD_MARKER}`,
      );
    }
    return { uploaded: nodes(ctx.spec).map((n) => n.key) };
  },
};

export interface MeshTable {
  /** node key → tailnet IPv4. */
  ips: Record<string, string>;
}

export const awaitMeshStep: StepDef = {
  name: "await-mesh",
  async run(ctx): Promise<MeshTable> {
    const ips: Record<string, string> = {};
    const maxAttempts = 30;
    for (const node of nodes(ctx.spec)) {
      const target = nodeTarget(ctx, node.key);
      for (let attempt = 1; ; attempt++) {
        const res = await ctx.services.ssh.exec(
          target,
          `tailscale --socket=${NODE_HOME}/tailscale/tailscaled.sock ip -4 2>/dev/null || true`,
        );
        const ip = res.stdout.trim().split("\n")[0];
        if (ip && /^100\./.test(ip)) {
          ips[node.key] = ip;
          break;
        }
        if (attempt >= maxAttempts) throw new Error(`${node.key} never joined the mesh`);
        await ctx.services.sleep(5000);
      }
    }
    return { ips };
  },
};

export const wireTunnelsStep: StepDef = {
  name: "wire-tunnels",
  async run(ctx) {
    const mesh = ctx.output<MeshTable>("await-mesh")!;
    const topo = resolveTopology(ctx.spec);
    for (let s = 0; s < ctx.spec.topology.sentries.count; s++) {
      const target = nodeTarget(ctx, `sentry-${s}`);
      // replace boot-time placeholder tunnels with real validator IPs (§5
      // step 18). ^socat: an unanchored -f pattern also matches this
      // command's own sh wrapper — pkill then kills the wrapper mid-command
      await ctx.services.ssh.exec(target, "pkill -f '^socat TCP-LISTEN' || true");
      for (const v of topo.sentryValidators[s] ?? []) {
        const port = tunnelPort(v);
        const ip = mesh.ips[`val-${v}`];
        if (!ip) throw new Error(`no tailnet IP for val-${v}`);
        await ctx.services.ssh.exec(target, socatTunnelCmd(port, ip));
      }
    }
    return { wired: true };
  },
};

export const patchValidatorPeersStep: StepDef = {
  name: "patch-validator-peers",
  async run(ctx) {
    const mesh = ctx.output<MeshTable>("await-mesh")!;
    const topo = resolveTopology(ctx.spec);
    for (let v = 0; v < ctx.spec.topology.validators.count; v++) {
      const target = nodeTarget(ctx, `val-${v}`);
      for (const s of topo.validatorSentries[v] ?? []) {
        const token = placeholder.tailnetIp(`sentry-${s}`);
        const ip = mesh.ips[`sentry-${s}`];
        if (!ip) throw new Error(`no tailnet IP for sentry-${s}`);
        await ctx.services.ssh.exec(
          target,
          `sed -i 's|${token}|${ip}|g' ${NODE_HOME}/config/config.toml`,
        );
      }
    }
    return { patched: true };
  },
};

export const awaitSignerStep: StepDef = {
  name: "await-signer",
  async run(ctx) {
    if (ctx.spec.security.keyMode !== "tmkms") return { skipped: true };
    const mesh = ctx.output<MeshTable>("await-mesh")!;
    const stanzas: Record<string, string> = {};
    for (let v = 0; v < ctx.spec.topology.validators.count; v++) {
      stanzas[`val-${v}`] =
        `[[validator]]\nchain_id = "${ctx.spec.network.name}-${ctx.spec.network.chainIdSuffix}"\n` +
        `addr = "tcp://${mesh.ips[`val-${v}`]}:26659"\nprotocol_version = "v0.34"\n`;
    }
    // Probe the privval keepalive port on each validator; pause until all pass.
    for (let v = 0; v < ctx.spec.topology.validators.count; v++) {
      const target = nodeTarget(ctx, `val-${v}`);
      const probe = await ctx.services.ssh.exec(
        target,
        "nc -z 127.0.0.1 26660 && echo ok || echo no",
      );
      if (probe.stdout.trim() !== "ok") {
        throw new AwaitUser(
          "await-signer",
          `connect your tmkms signer(s), then resume.\n${Object.values(stanzas).join("\n")}`,
        );
      }
    }
    return { stanzas };
  },
};

// --- Phase F ---

export const startChainStep: StepDef = {
  name: "start-chain",
  async run(ctx) {
    const start = async (key: string) => {
      const target = nodeTarget(ctx, key);
      const running = await ctx.services.ssh.exec(target, "pgrep -x sparkdreamd >/dev/null && echo yes || echo no");
      if (running.stdout.trim() === "yes") return;
      await ctx.services.ssh.exec(target, START_NODE_CMD);
    };
    // validators near-simultaneously (>2/3 must be online for block 1), then sentries
    await Promise.all(
      Array.from({ length: ctx.spec.topology.validators.count }, (_, v) => start(`val-${v}`)),
    );
    for (let s = 0; s < ctx.spec.topology.sentries.count; s++) await start(`sentry-${s}`);
    return { started: true };
  },
};

export const persistStartStep: StepDef = {
  name: "persist-start",
  async run(ctx) {
    // No devnet skip: without persisted env (WAIT_FOR_CONFIG=false + real
    // tunnel IPs) a provider-initiated pod restart leaves the node dead in
    // wait mode behind a placeholder tunnel — observed live on mainnet.
    // Containers must self-heal; devnets pay real uact like everyone else.
    const plan = ctx.output<DeploymentPlan>("create-deployments")!;
    const assignments = ctx.output<Assignments>("collect-bids")!;
    const mesh = ctx.output<MeshTable>("await-mesh")!;
    const addr = ctx.db.getLaunch(ctx.launchId)!.owner;

    // Flip WAIT_FOR_CONFIG + persist real tunnel targets into the SDL env (§5 step 20b)
    const { msgs, manifests } = updateDeploymentMsgs({
      spec: ctx.spec,
      owner: addr,
      sdlDir: ctx.dirs.sdl,
      plan,
      mesh: mesh.ips,
    });
    await ctx.requireTx("persist-start", msgs);
    const cert = loadCert(ctx);
    for (const [key, manifestJson] of Object.entries(manifests)) {
      const a = assignments.perNode[key]!;
      await ctx.services.provider.sendManifest(cert, a.hostUri, plan.perNode[key]!.dseq, manifestJson);
    }
    return { persisted: Object.keys(manifests) };
  },
};

export const verifyChainStep: StepDef = {
  name: "verify-chain",
  async run(ctx) {
    const assignments = ctx.output<Assignments>("collect-bids")!;
    // sentry RPC must be up with height increasing (§5 step 21)
    const plan = ctx.output<DeploymentPlan>("create-deployments")!;
    const sentryKeys = Object.keys(assignments.perNode).filter((k) => k.startsWith("sentry-"));
    const checks: Record<string, { height: number }> = {};
    for (const key of sentryKeys) {
      const a = assignments.perNode[key]!;
      const url = await nodeRpcUrl(ctx, a.hostUri, plan.perNode[key]!.dseq, a.gseq, a.oseq);
      // Right after persist-start the providers restart the pods, so the
      // RPC may be unreachable for a minute and then blocksyncing — poll
      // patiently (~5 min) for "reachable, synced, height increasing"
      // rather than failing the launch on one unlucky probe.
      const attempts = 60;
      let last: number | undefined;
      let verified = false;
      let lastProblem = "unreachable";
      for (let i = 0; i < attempts && !verified; i++) {
        if (i > 0) await ctx.services.sleep(5000);
        let s;
        try {
          s = await ctx.services.rpc.status(url);
        } catch (e) {
          lastProblem = `unreachable (${String(e).slice(0, 80)})`;
          continue; // node still restarting
        }
        if (s.catchingUp) {
          lastProblem = `still catching up at height ${s.latestBlockHeight}`;
        } else if (last !== undefined && s.latestBlockHeight > last) {
          checks[key] = { height: s.latestBlockHeight };
          verified = true;
        } else {
          lastProblem = `height not increasing (${s.latestBlockHeight})`;
        }
        last = s.latestBlockHeight;
      }
      if (!verified) {
        throw new Error(`${key}: chain not verified after ~5 min — ${lastProblem}`);
      }
      ctx.log(`${key}: verified at height ${checks[key]!.height}`);
    }

    // §5 step 21 continued: explorer/frontend HTTP 200 on their domains,
    // public api/rpc serving chain data. The domains are user-created DNS
    // records pointing at provider ingress hosts, so an unreachable one
    // pauses with the exact record needed (headscale DNS-gate pattern).
    const http: Record<string, string> = {};
    const targets: Array<{ name: string; domain: string; url: string; behind: string }> = [];
    for (const c of statelessComponents(ctx.spec)) {
      targets.push({ name: c.key, domain: c.domain, url: `https://${c.domain}/`, behind: c.key });
    }
    const pub = ctx.spec.topology.publicEndpoints;
    if (pub?.api) {
      targets.push({
        name: "public-api",
        domain: pub.api,
        url: `https://${pub.api}/cosmos/base/tendermint/v1beta1/node_info`,
        behind: "sentry-0",
      });
    }
    if (pub?.rpc) {
      targets.push({
        name: "public-rpc",
        domain: pub.rpc,
        url: `https://${pub.rpc}/status`,
        behind: "sentry-0",
      });
    }
    const failures: string[] = [];
    for (const t of targets) {
      // ~1 min per target — persist-start restarts the pods just before this
      let ok = false;
      for (let i = 0; i < 12 && !ok; i++) {
        if (i > 0) await ctx.services.sleep(5000);
        ok = await ctx.services.rpc.httpOk(t.url);
      }
      if (ok) {
        http[t.name] = t.url;
        ctx.log(`${t.name}: reachable at ${t.url}`);
        continue;
      }
      const a = assignments.perNode[t.behind]!;
      const ingress = await ingressHost(
        ctx, a.hostUri, plan.perNode[t.behind]!.dseq, a.gseq, a.oseq, t.domain,
      );
      failures.push(
        `${t.name}: not reachable at ${t.url} — create a DNS record for ${t.domain} → ` +
          `CNAME ${ingress} (or an A record to that host's IP). ` +
          `Cloudflare: proxy on, SSL=Flexible.`,
      );
    }
    if (failures.length > 0) {
      throw new AwaitUser("verify-chain", `${failures.join("\n")}\nThen resume.`);
    }
    return { sentries: checks, http };
  },
};

/** The hostname the user's DNS record must point at (NOT the :8443 API). */
export async function ingressHost(
  ctx: StepCtx,
  hostUri: string,
  dseq: string,
  gseq: number,
  oseq: number,
  domain: string,
): Promise<string> {
  const status: any = await ctx.services.provider.leaseStatus(
    loadCert(ctx), hostUri, dseq, gseq, oseq,
  );
  const uris: string[] = Object.values(status?.services ?? {}).flatMap(
    (s: any) => s?.uris ?? [],
  );
  return uris.find((u) => u !== domain) ?? new URL(hostUri).hostname;
}

export const finalizeStep: StepDef = {
  name: "finalize",
  async run(ctx) {
    const assignments = ctx.output<Assignments>("collect-bids")!;
    const keys = ctx.output<GenerateKeysOutput>("generate-keys")!;
    const reminders = [
      "sweep generated mnemonics to hardware custody",
      "stash the age identity offline",
      "rotate headscale preauth keys",
      "export + stash the fleet bundle",
      "optionally strip SSH from validator SDLs",
    ];
    return {
      components: Object.fromEntries(
        Object.entries(assignments.perNode).map(([key, a]) => [
          key,
          { provider: a.provider, price: a.price },
        ]),
      ),
      ageRecipient: keys.ageRecipient,
      reminders,
    };
  },
};

export function phaseEFSteps(): StepDef[] {
  return [
    uploadNodeDataStep,
    awaitMeshStep,
    wireTunnelsStep,
    patchValidatorPeersStep,
    awaitSignerStep,
    startChainStep,
    persistStartStep,
    verifyChainStep,
    finalizeStep,
  ];
}
