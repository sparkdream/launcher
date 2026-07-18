import fs from "node:fs";
import path from "node:path";
import { chainId, nodes, resolveTopology, statelessComponents, tunnelPort } from "@sparkdream/launch-spec";
import { AwaitUser, type StepCtx, type StepDef } from "../engine.js";
import { updateDeploymentMsgs } from "../akash/update.js";
import { placeholder, type GenerateKeysOutput } from "./phase-a.js";
import { loadCert, nodeRpcUrl, nodeTarget, type Assignments, type DeploymentPlan, type SshEndpoints } from "./phase-bcd.js";
import { NODE_HOME, rpcUrl, socatTunnelCmd, START_NODE_CMD, WITNESS_RPC_PORT } from "../node-ops.js";
import { phaseGSteps } from "./phase-g.js";
import { resolveStateSyncTrust } from "./join.js";

const UPLOAD_MARKER = `${NODE_HOME}/.node-data-uploaded`;

// --- Phase E ---

export const uploadNodeDataStep: StepDef = {
  name: "upload-node-data",
  async run(ctx) {
    const ssh = ctx.output<SshEndpoints>("send-manifests");
    for (const node of nodes(ctx.spec)) {
      const target = nodeTarget(ctx, node.key);
      const marker = await ctx.services.ssh.exec(target, `test -f ${UPLOAD_MARKER} && echo yes || echo no`);
      if (marker.stdout.trim() === "yes") continue; // idempotent (§5 step 16)
      const bundle = path.join(ctx.dirs.bundles, `${node.key}.tgz`);
      await ctx.services.ssh.upload(target, bundle, "/tmp/node-data.tgz");
      await ctx.services.ssh.exec(
        target,
        `mkdir -p ${NODE_HOME} && tar xzf /tmp/node-data.tgz -C ${NODE_HOME}` +
          `${externalAddressSed(ssh?.p2p?.[node.key])} && touch ${UPLOAD_MARKER}`,
      );
    }
    return { uploaded: nodes(ctx.spec).map((n) => n.key) };
  },
};

/**
 * advertise-peers (§5 "Public peering & the join bundle"): stamp the
 * sentry's provider-forwarded 26656 into external_address so PEX gossips a
 * reachable peer string instead of the container-internal address. Rides
 * the node-data extraction command so the marker file still gates both.
 */
export function externalAddressSed(ep: { host: string; port: number } | undefined): string {
  if (!ep) return "";
  return ` && sed -i 's|^external_address = .*|external_address = "${ep.host}:${ep.port}"|' ${NODE_HOME}/config/config.toml`;
}

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
        `[[validator]]\nchain_id = "${chainId(ctx.spec)}"\n` +
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
    if (ctx.spec.join) return startJoinChain(ctx, start);
    // validators near-simultaneously (>2/3 must be online for block 1), then sentries
    await Promise.all(
      Array.from({ length: ctx.spec.topology.validators.count }, (_, v) => start(`val-${v}`)),
    );
    for (let s = 0; s < ctx.spec.topology.sentries.count; s++) await start(`sentry-${s}`);
    return { started: true };
  },
};

/**
 * Join mode (§5 "Join mode", Phase F variant): the chain is already live,
 * so there is no 2/3 start coordination. The state-sync trust anchor is
 * re-resolved right before boot (the render-time one can outlive the
 * light-client trust period when a launch pauses on signatures for days).
 * Sentries start FIRST and must state-sync + catch up to chain head; then
 * validators start and state-sync off their own sentries (a state-synced
 * sentry cannot serve blocks below its snapshot, so validators can never
 * block-sync from height 0) — Phase G only bonds validators that are
 * verified synced here.
 */
async function startJoinChain(ctx: StepCtx, start: (key: string) => Promise<void>) {
  const assignments = ctx.output<Assignments>("collect-bids")!;
  const plan = ctx.output<DeploymentPlan>("create-deployments")!;
  const S = ctx.spec.topology.sentries.count;
  const V = ctx.spec.topology.validators.count;
  const allKeys = [
    ...Array.from({ length: S }, (_, s) => `sentry-${s}`),
    ...Array.from({ length: V }, (_, v) => `val-${v}`),
  ];

  // refresh the trust anchor on every node's config before anything boots
  const trust = await resolveStateSyncTrust(ctx);
  const topo = resolveTopology(ctx.spec);
  const mesh = ctx.output<MeshTable>("await-mesh");
  for (const key of allKeys) {
    // Validators get their OWN sentry as light-client primary, proxied to
    // localhost over the mesh: the bundle's RPCs ride forwarded ports that
    // egress-filtered providers block (observed live: datanode.uk refused
    // every non-443 port and state sync died "no witnesses connected"),
    // and tailnet IPs are not directly dialable (userspace tailscale). The
    // bundle RPCs stay in the list as cross-check witnesses. Sentries keep
    // the bundle list unchanged — they sync from the public network and
    // have no synced sentry of their own to lean on.
    let servers = trust.rpcServers.join(",");
    if (key.startsWith("val-")) {
      const s = topo.validatorSentries[Number(key.split("-")[1])]?.[0];
      const sentryIp = s !== undefined ? mesh?.ips[`sentry-${s}`] : undefined;
      if (sentryIp) {
        await ctx.services.ssh.exec(
          nodeTarget(ctx, key),
          socatTunnelCmd(WITNESS_RPC_PORT, sentryIp, 26657),
        );
        servers = `http://127.0.0.1:${WITNESS_RPC_PORT},${servers}`;
      }
    }
    await ctx.services.ssh.exec(
      nodeTarget(ctx, key),
      `sed -i 's|^rpc_servers = .*|rpc_servers = "${servers}"|; ` +
        `s|^trust_height = .*|trust_height = ${trust.trustHeight}|; ` +
        `s|^trust_hash = .*|trust_hash = "${trust.trustHash}"|' ${NODE_HOME}/config/config.toml`,
    );
  }
  ctx.log(`state-sync trust anchor refreshed at height ${trust.trustHeight}`);

  const disableStateSync = (key: string) =>
    // one-shot bootstrap done — flip [statesync] off so a container restart
    // can't try to re-sync (CometBFT skips it on non-empty state anyway)
    ctx.services.ssh.exec(
      nodeTarget(ctx, key),
      `sed -i '/^\\[statesync\\]$/,/^\\[/ s|^enable = true|enable = false|' ${NODE_HOME}/config/config.toml`,
    );

  await Promise.all(Array.from({ length: S }, (_, s) => start(`sentry-${s}`)));

  const caughtUp: Record<string, number> = {};
  for (let s = 0; s < S; s++) {
    const key = `sentry-${s}`;
    const a = assignments.perNode[key]!;
    const url = await nodeRpcUrl(ctx, a.hostUri, plan.perNode[key]!.dseq, a.gseq, a.oseq);
    // state sync discovers, fetches, and restores a snapshot — minutes, not
    // seconds; poll generously (~20 min) before declaring the join stuck
    const attempts = 240;
    let synced = false;
    let lastProblem = "unreachable";
    for (let i = 0; i < attempts && !synced; i++) {
      if (i > 0) await ctx.services.sleep(5000);
      try {
        const st = await ctx.services.rpc.status(url);
        if (!st.catchingUp && st.latestBlockHeight > 0) {
          caughtUp[key] = st.latestBlockHeight;
          synced = true;
        } else {
          lastProblem = `catching up at height ${st.latestBlockHeight}`;
        }
      } catch (e) {
        lastProblem = `unreachable (${String(e).slice(0, 80)})`;
      }
    }
    if (!synced) {
      throw new Error(
        `${key}: not synced to the network after ~20 min (${lastProblem}). ` +
          "Check that the join peers and state-sync RPCs are reachable and serving snapshots.",
      );
    }
    ctx.log(`${key}: synced at height ${caughtUp[key]}`);
    await disableStateSync(key);
  }

  await Promise.all(Array.from({ length: V }, (_, v) => start(`val-${v}`)));

  // validators state-sync via their sentries, which serve their first
  // snapshot only when the chain height next crosses a snapshot-interval
  // boundary — up to interval×blocktime away, so the budget is generous
  // (~60 min). No public RPC on validators: probe localhost over SSH.
  for (let v = 0; v < V; v++) {
    const key = `val-${v}`;
    const attempts = 720;
    let synced = false;
    let lastProblem = "unreachable";
    for (let i = 0; i < attempts && !synced; i++) {
      if (i > 0) await ctx.services.sleep(5000);
      const probe = await ctx.services.ssh.exec(
        nodeTarget(ctx, key),
        "wget -qO- http://127.0.0.1:26657/status 2>/dev/null || true",
        { quick: true },
      );
      const height = Number(/latest_block_height"?\s*:\s*"?(\d+)/.exec(probe.stdout)?.[1]);
      const catchingUp = /catching_up"?\s*:\s*"?(\w+)/.exec(probe.stdout)?.[1] === "true";
      if (Number.isFinite(height) && height > 0 && !catchingUp) {
        caughtUp[key] = height;
        synced = true;
      } else {
        lastProblem = Number.isFinite(height)
          ? `catching up at height ${height}`
          : "local RPC not answering";
      }
    }
    if (!synced) {
      throw new Error(
        `${key}: not synced after ~60 min (${lastProblem}). Validators state-sync ` +
          "from their own sentries, which serve their first snapshot only after the " +
          "chain crosses a snapshot-interval boundary; check the sentries' snapshot settings.",
      );
    }
    ctx.log(`${key}: synced at height ${caughtUp[key]}`);
    await disableStateSync(key);
  }

  return { started: true, syncedAt: caughtUp };
}

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
    // Phase G (§5 "Join mode"): promote the joined pair to a bonded
    // validator — no-ops outside join mode, runs before the dashboard flip
    ...phaseGSteps(),
    finalizeStep,
  ];
}
