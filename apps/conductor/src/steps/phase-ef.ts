import fs from "node:fs";
import path from "node:path";
import { chainId, headscaleDomain, nodes, resolveTopology, statelessComponents, tunnelPort, type NodeRef } from "@sparkdream/launch-spec";
import { AwaitUser, type StepCtx, type StepDef } from "../engine.js";
import { updateDeploymentMsgs } from "../akash/update.js";
import { placeholder, type GenerateKeysOutput } from "./phase-a.js";
import { loadCert, nodeRpcUrl, nodeTarget, type Assignments, type DeploymentPlan, type PreauthKeys, type SshEndpoints } from "./phase-bcd.js";
import type { SshTarget } from "../services.js";
import { NODE_HOME, rpcUrl, socatTunnelCmd, START_NODE_CMD, VAL_PEER_TUNNEL_PORT, WITNESS_RPC_PORT } from "../node-ops.js";
import { buildTmkmsSetup, SIGNER_CONNECTED_PROBE, VALIDATOR_STATUS_PROBE, probeSaysConnected, statusConsensusPubkey } from "../tmkms.js";
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

const MESH_SOCK = `${NODE_HOME}/tailscale/tailscaled.sock`;

/** A node's assigned tailnet IPv4, or undefined if it has not joined yet.
 *  An unreachable node is "not joined", not an error — the deployment check
 *  below decides whether that is worth waiting out. */
async function meshTailnetIp(ctx: StepCtx, target: SshTarget): Promise<string | undefined> {
  const res = await ctx.services.ssh
    .exec(target, `tailscale --socket=${MESH_SOCK} ip -4 2>/dev/null || true`)
    .catch(() => ({ stdout: "" }));
  const ip = res.stdout.trim().split("\n")[0];
  return ip && /^100\./.test(ip) ? ip : undefined;
}

/**
 * Bypass a black-holed IPv6 path to headscale (§ mesh join). Akash providers
 * routinely give a container an IPv6 stack with no working IPv6 route;
 * headscale sits behind Cloudflare, which advertises AAAA records, so the
 * control client tries IPv6 first and the connection hangs on a dead route —
 * `tailscale up` never completes and the node never joins. Pinning the
 * headscale domain to its IPv4 in /etc/hosts makes the resolver return no
 * AAAA at all (both musl and glibc consult /etc/hosts before DNS and use its
 * entries exclusively for a matched name), so the control connection only
 * ever tries IPv4. Then re-run `tailscale up` to retry the join. Best-effort:
 * a failure here just falls through to the reachability diagnosis.
 */
async function pinHeadscaleIpv4AndRejoin(
  ctx: StepCtx,
  node: NodeRef,
  target: SshTarget,
  domain: string,
  authkey: string | undefined,
): Promise<string> {
  const resolved = await ctx.services.ssh.exec(
    target,
    `nslookup ${domain} 2>/dev/null | awk '/^Address: [0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+/{print $2; exit}'`,
  );
  const ipv4 = resolved.stdout.trim().split("\n")[0];
  if (!ipv4 || !/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(ipv4)) {
    return `could not resolve an IPv4 address for ${domain} from this node`;
  }
  await ctx.services.ssh.exec(
    target,
    `grep -qF ' ${domain}' /etc/hosts || echo '${ipv4} ${domain}' >> /etc/hosts`,
  );
  if (authkey) {
    // timeout-guarded: a pinned-IPv4 up completes in seconds, but never let a
    // wedged up hang the launch
    await ctx.services.ssh.exec(
      target,
      `timeout 90 tailscale --socket=${MESH_SOCK} up --auth-key=${authkey} ` +
        `--login-server=https://${domain} --hostname=${node.key} --accept-dns=false --reset ` +
        `>/dev/null 2>&1 || true`,
    );
  }
  return `pinned ${domain}→${ipv4} in /etc/hosts and re-ran tailscale up (bypassing a likely IPv6 black hole)`;
}

/** Is headscale reachable from this node at all — the difference between an
 *  IPv6 black hole (IPv4 works) and provider egress filtering (nothing works). */
async function headscaleReachable(ctx: StepCtx, target: SshTarget, domain: string): Promise<boolean> {
  const res = await ctx.services.ssh
    .exec(
      target,
      `wget --no-check-certificate -q -O /dev/null -T 10 https://${domain}/health && echo REACH_OK || echo REACH_FAIL`,
    )
    .catch(() => ({ stdout: "REACH_FAIL" }));
  return res.stdout.includes("REACH_OK");
}

export const awaitMeshStep: StepDef = {
  name: "await-mesh",
  async run(ctx): Promise<MeshTable> {
    const ips: Record<string, string> = {};
    const domain = headscaleDomain(ctx.spec);
    const preauth = ctx.output<PreauthKeys>("configure-headscale");
    const plan = ctx.output<DeploymentPlan>("create-deployments");
    const addr = ctx.db.getLaunch(ctx.launchId)?.owner ?? "";
    const maxAttempts = 30;
    // ~20s of no-join before assuming the IPv6-black-hole path and pinning IPv4
    const remediateAfter = 4;
    for (const node of nodes(ctx.spec)) {
      const target = nodeTarget(ctx, node.key);
      let remediated = false;
      let ip: string | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        ip = await meshTailnetIp(ctx, target);
        if (ip) break;
        // A node whose deployment is closed can never join — polling it for
        // the full budget wastes minutes and, worse, holds the launch driver
        // so a relaunch the user just requested cannot start (drive() is a
        // no-op while a run is in flight). Bail out immediately and say what
        // to do. Only positive evidence counts; an LCD hiccup keeps waiting.
        const dseq = plan?.perNode[node.key]?.dseq;
        if (dseq && addr) {
          const info = await ctx.services.api.deploymentInfo(addr, dseq).catch(() => undefined);
          if (info && info.state !== "active") {
            throw new AwaitUser(
              "await-mesh",
              `${node.key}'s deployment (dseq ${dseq}) is closed, so it can never join the mesh. ` +
                `Use relaunch on ${node.key} to re-place it on another provider, then resume.`,
            );
          }
        }
        if (!remediated && attempt >= remediateAfter) {
          remediated = true;
          const note = await pinHeadscaleIpv4AndRejoin(
            ctx,
            node,
            target,
            domain,
            preauth?.perNode[node.key],
          ).catch((e) => `IPv4 pin failed: ${String(e).slice(0, 120)}`);
          ctx.log(`${node.key}: not on the mesh yet — ${note}`);
        }
        await ctx.services.sleep(5000);
      }
      if (!ip) {
        // Name the culprit instead of timing out blindly. The decisive
        // question is whether headscale is unreachable for EVERYONE or just
        // for this node: probe it from the node AND from the launcher.
        // Getting that backwards costs hours — a headscale whose public
        // endpoint was down once sent us re-placing a blameless sentry
        // across three providers.
        const fromNode = await headscaleReachable(ctx, target, domain);
        const fromLauncher = await ctx.services.rpc
          .httpOk(`https://${domain}/health`)
          .catch(() => false);
        if (!fromLauncher) {
          throw new AwaitUser(
            "await-mesh",
            `${node.key} cannot join the mesh because headscale at ${domain} is not answering ` +
              `from anywhere — the launcher cannot reach it either. No node can register until ` +
              `it does: check the domain's DNS/Cloudflare and that the headscale deployment is ` +
              `serving, then resume. (This is not a problem with ${node.key} or its provider.)`,
          );
        }
        throw new Error(
          fromNode
            ? `${node.key} never joined the mesh, though headscale at ${domain} answers from it — ` +
              `check the node's tailscaled log; the control connection is failing for a reason ` +
              `beyond the network path (which was already pinned to IPv4).`
            : `${node.key} never joined the mesh: headscale at ${domain} answers for the launcher ` +
              `but NOT from this node's Akash provider — an egress or path problem specific to ` +
              `that provider. Relaunch ${node.key} to re-place it elsewhere.`,
        );
      }
      ips[node.key] = ip;
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
      // sentry mesh (render-configs): substitute the other sentries' tailnet
      // IPs into this sentry's persistent_peers placeholders. Tailnet only —
      // sentries advertise their public external_address and run pex, so
      // CometBFT can still find direct public routes on its own.
      const seds: string[] = [];
      for (let s2 = 0; s2 < ctx.spec.topology.sentries.count; s2++) {
        if (s2 === s) continue;
        const ip = mesh.ips[`sentry-${s2}`];
        if (!ip) throw new Error(`no tailnet IP for sentry-${s2}`);
        seds.push(`s|${placeholder.tailnetIp(`sentry-${s2}`)}|${ip}|g`);
      }
      if (seds.length > 0) {
        await ctx.services.ssh.exec(
          target,
          `sed -i '${seds.join("; ")}' ${NODE_HOME}/config/config.toml`,
        );
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
    const p2p = ctx.output<SshEndpoints>("send-manifests")?.p2p;
    const publicPeers: Record<string, string[]> = {};
    for (let v = 0; v < ctx.spec.topology.validators.count; v++) {
      const target = nodeTarget(ctx, `val-${v}`);
      for (const s of topo.validatorSentries[v] ?? []) {
        const token = placeholder.tailnetIp(`sentry-${s}`);
        const ip = mesh.ips[`sentry-${s}`];
        if (!ip) throw new Error(`no tailnet IP for sentry-${s}`);
        // public-first (§5): the mesh path rides a DERP relay whose silent
        // stalls drop votes in bursts — a validator that can reach its
        // sentry's public p2p endpoint peers over one direct TCP hop
        // instead. The tailnet form stays as the fallback (the sentry's
        // dial-in tunnel still covers those providers).
        const pub = p2p?.[`sentry-${s}`];
        if (pub) {
          const probe = await ctx.services.ssh.exec(
            target,
            `nc -zw 4 ${pub.host} ${pub.port} >/dev/null 2>&1 && echo open || echo closed`,
            { quick: true },
          );
          if (probe.stdout.includes("open")) {
            await ctx.services.ssh.exec(
              target,
              `sed -i 's|${token}:26656|${pub.host}:${pub.port}|g' ${NODE_HOME}/config/config.toml`,
            );
            ctx.log(`val-${v}: peering with sentry-${s} over its public endpoint ${pub.host}:${pub.port} (no relay)`);
            (publicPeers[`val-${v}`] ??= []).push(`sentry-${s}`);
          }
        }
        // any remaining references (tmkms addr blocks, non-peered fallback)
        await ctx.services.ssh.exec(
          target,
          `sed -i 's|${token}|${ip}|g' ${NODE_HOME}/config/config.toml`,
        );
      }
    }
    return { patched: true, publicPeers };
  },
};

export const awaitSignerStep: StepDef = {
  name: "await-signer",
  async run(ctx) {
    if (ctx.spec.security.keyMode !== "tmkms") return { skipped: true };
    const mesh = ctx.output<MeshTable>("await-mesh")!;
    // stanzas come from the guided-setup generator (single source for the
    // protocol details; a hardcoded copy here drifted to the wrong protocol
    // version once already)
    const setup = buildTmkmsSetup({
      spec: ctx.spec,
      chainId: chainId(ctx.spec),
      meshIps: mesh.ips,
      nodeDir: (k) => ctx.dirs.node(k),
    });
    const stanzas: Record<string, string> = {};
    for (const v of setup.validators) {
      stanzas[v.key] = v.tmkmsToml.slice(v.tmkmsToml.indexOf("[[validator]]"));
    }
    // Pause until a signer actually holds a privval session on each
    // validator. Probing the port alone is vacuous: sparkdreamd binds the
    // backend listener at boot, so nc -z passes with no signer anywhere in
    // sight and the launch sails into a chain that can never sign. The
    // established-session probe only goes green when tmkms dials in through
    // the keepalive proxy. This runs right after start-chain, so poll for a
    // minute first: the node needs a few seconds to bind the listener and a
    // ready signer's reconnect has to land.
    for (let v = 0; v < ctx.spec.topology.validators.count; v++) {
      const target = nodeTarget(ctx, `val-${v}`);
      let connected = false;
      for (let attempt = 0; attempt < 12 && !connected; attempt++) {
        if (attempt > 0) await ctx.services.sleep(5000);
        const probe = await ctx.services.ssh.exec(target, SIGNER_CONNECTED_PROBE);
        connected = probeSaysConnected(probe.stdout);
      }
      if (!connected) {
        throw new AwaitUser(
          "await-signer",
          `connect your tmkms signer(s): the setup checklist below walks through it. ` +
            `Resume once every validator reports its signer connected.\n` +
            `${Object.values(stanzas).join("\n")}`,
        );
      }
      // spec-pinned key (hardware signer): a connected session is not enough,
      // the device must hold the key the chain was built with. A confirmed
      // mismatch means the chain rejects every vote this signer produces.
      const pinned = ctx.spec.topology.validators.consensusPubkeys?.[v];
      if (pinned) {
        let signerKey: string | null = null;
        for (let attempt = 0; attempt < 6 && !signerKey; attempt++) {
          if (attempt > 0) await ctx.services.sleep(5000);
          const status = await ctx.services.ssh.exec(target, VALIDATOR_STATUS_PROBE);
          signerKey = statusConsensusPubkey(status.stdout);
        }
        if (signerKey && signerKey !== pinned) {
          throw new AwaitUser(
            "await-signer",
            `the signer connected to val-${v} holds consensus pubkey ${signerKey}, but the spec ` +
              `pins ${pinned}: the chain was built with the pinned key and rejects every vote ` +
              `this signer produces. Point the signer at the pinned key (or relaunch with a ` +
              `corrected consensusPubkeys list), then resume.`,
          );
        }
        if (!signerKey) {
          ctx.log(
            `val-${v}: signer connected but /status did not report a pubkey; cannot verify it ` +
              `against the spec's pinned key, proceeding anyway (the setup panel shows the live match state)`,
          );
        }
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
        // p2p: prefer the own sentry's PUBLIC endpoint over the mesh — the
        // DERP-relayed path stalls silently and drops votes in bursts
        // (see the relaunch configure step); mesh proxy stays the fallback
        const pub = s !== undefined
          ? ctx.output<SshEndpoints>("send-manifests")?.p2p?.[`sentry-${s}`]
          : undefined;
        let peered = false;
        if (pub) {
          const probe = await ctx.services.ssh.exec(
            nodeTarget(ctx, key),
            `nc -zw 4 ${pub.host} ${pub.port} >/dev/null 2>&1 && echo open || echo closed`,
            { quick: true },
          );
          if (probe.stdout.includes("open")) {
            await ctx.services.ssh.exec(
              nodeTarget(ctx, key),
              `sed -i 's|@${sentryIp}:26656|@${pub.host}:${pub.port}|' ${NODE_HOME}/config/config.toml`,
            );
            ctx.log(`${key}: peering with sentry-${s} over its public endpoint ${pub.host}:${pub.port} (no relay)`);
            peered = true;
          }
        }
        if (!peered) {
          await ctx.services.ssh.exec(
            nodeTarget(ctx, key),
            socatTunnelCmd(VAL_PEER_TUNNEL_PORT, sentryIp, 26656),
          );
          await ctx.services.ssh.exec(
            nodeTarget(ctx, key),
            `sed -i 's|@${sentryIp}:26656|@127.0.0.1:${VAL_PEER_TUNNEL_PORT}|' ${NODE_HOME}/config/config.toml`,
          );
        }
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
    // start-chain before await-signer: containers boot with WAIT_FOR_CONFIG
    // (no sparkdreamd), and the signer gate probes for an ESTABLISHED privval
    // session, which can only exist once the node is up and has bound the
    // backend listener. Gating earlier deadlocked the launch: no backend, no
    // session, ever.
    startChainStep,
    awaitSignerStep,
    persistStartStep,
    verifyChainStep,
    // Phase G (§5 "Join mode"): promote the joined pair to a bonded
    // validator — no-ops outside join mode, runs before the dashboard flip
    ...phaseGSteps(),
    finalizeStep,
  ];
}
