import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { chainId, resolveTopology, statelessComponents, tunnelPort, withDefaults, type ComponentRef, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb, FleetComponentRow, FleetOpRow } from "./db.js";
import { AwaitUser, type StepCtx, type StepDef } from "./engine.js";
import { sendMsg } from "@sparkdream/akash-tx";
import { createDeploymentMsg, createLeaseMsg, TypeUrl, type Msg } from "./akash/messages.js";
import { feeCoin, feeConfig } from "./fee.js";
import { PRICING_DENOM } from "./render-sdl.js";
import { pollBids } from "./akash/client.js";
import { exclusionEntries, selectProvider } from "./akash/policy.js";
import { loadSdl, sdlArtifacts, sortedJson } from "./akash/sdl-groups.js";
import { extractForwardedPort, headscaleUserId, loadCert, nodeRpcUrl, nodeShellFallback, pinnedValue, sshTarget, waitLeaseStatus, type HeadscaleOutput } from "./steps/phase-bcd.js";
import {
  buildGenesisFiles,
  createNamedAccounts,
  packageNodeDataStep,
  placeholder,
  type GenerateKeysOutput,
} from "./steps/phase-a.js";
import { sparkdreamd } from "./exec.js";
import { explorerChainEnv, renderComponentSdl } from "./render-component-sdl.js";
import { ingressHost } from "./steps/phase-ef.js";
import { resolveStateSyncTrust } from "./steps/join.js";
import { accountCoordinates, awaitTxIncluded, queryJson } from "./steps/phase-g.js";
import {
  assembleUnjailTxJson,
  buildUnjailSignDoc,
  valoperAddress,
  verifySignedDoc,
  type GentxSignResponse,
} from "./gentx.js";
import { NODE_HOME, restartNode, rpcUrl, socatTunnelCmd, START_NODE_CMD, VAL_PEER_TUNNEL_PORT, WITNESS_RPC_PORT } from "./node-ops.js";
import { probeSaysConnected, SIGNER_CONNECTED_PROBE } from "./tmkms.js";
import type { SshTarget } from "./services.js";

/**
 * Fleet operations (M5): relaunch (§5 "Component relaunch & close") and
 * rolling upgrades (§5 "Node upgrades") expressed as engine step lists
 * composed onto the owning launch — they inherit checkpointing, the signing
 * loop, and resume for free. Step names are op-scoped (`op<N>:...`) so
 * generations never collide.
 */

const DEPOSIT: Record<string, string> = { uakt: "5000000", uact: "5000000" };
/** §5: wait this many blocks past the last signed height before a relaunched
 *  softsign validator starts signing. */
const DOUBLE_SIGN_WINDOW = 20;

export interface RelaunchParams {
  key: string;
  generation: number;
  /** Provider addresses to keep this relaunch OFF (broken/unwanted hosts). */
  avoidProviders?: string[];
  /** Provider addresses to try first (promoted in the preference order). */
  preferProviders?: string[];
}

export interface UpgradeParams {
  /** Components in rolling order (sentries first, then validators). */
  components: string[];
  image: string;
}

function componentRow(ctx: StepCtx, key: string): FleetComponentRow {
  const row = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find(
    (c) => c.key === key,
  );
  if (!row) throw new Error(`fleet component ${key} not found`);
  return row;
}

/**
 * The headscale lease to mint preauth keys against. A fleet with its own
 * mesh has a "headscale" component row; a shared-mesh fleet (reuseFleet)
 * has none — its deploy-headscale output points at the owning fleet's
 * lease (headscale never relaunches, so the output stays current).
 */
function headscaleRef(ctx: StepCtx): { hostUri: string; dseq: string; gseq: number; oseq: number } {
  const row = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find(
    (c) => c.key === "headscale",
  );
  // single-group SDL ⇒ gseq/oseq are always 1
  if (row) return { hostUri: row.host_uri, dseq: row.dseq, gseq: 1, oseq: 1 };
  const hs = ctx.db.stepOutput<HeadscaleOutput>(ctx.launchId, "deploy-headscale");
  if (!hs) throw new Error("no headscale for this fleet (deploy-headscale never ran)");
  return { hostUri: hs.hostUri, dseq: hs.dseq, gseq: hs.gseq, oseq: hs.oseq };
}

function rowTarget(ctx: StepCtx, row: FleetComponentRow): SshTarget {
  if (!row.ssh_host || !row.ssh_port) throw new Error(`${row.key}: no SSH endpoint recorded`);
  return sshTarget(ctx, row.ssh_host, row.ssh_port, nodeShellFallback(ctx, row.host_uri, row.dseq));
}

function sdlPathFor(ctx: StepCtx, key: string): string {
  return path.join(ctx.dirs.sdl, `${key}.yaml`);
}

async function sentryRpcHeight(ctx: StepCtx, excludeKey?: string): Promise<number | undefined> {
  const sentry = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find(
    (c) => c.key.startsWith("sentry-") && c.state === "active" && c.key !== excludeKey,
  );
  if (!sentry) return undefined;
  const url = await nodeRpcUrl(ctx, sentry.host_uri, sentry.dseq);
  return (await ctx.services.rpc.status(url)).latestBlockHeight;
}

/** Relaunch: close → fresh deploy on a new provider → rewire → guarded start.
 *  Stateless components (§5): no volume, keys, peers, or double-sign risk —
 *  the rewiring and guarded-start steps are replaced by an HTTP health gate. */
export function relaunchSteps(opId: number, params: RelaunchParams, spec: LaunchSpec): StepDef[] {
  const { key } = params;
  const p = (s: string) => `op${opId}:${s}`;
  const isValidator = key.startsWith("val-");
  const valIndex = isValidator ? Number(key.split("-")[1]) : -1;
  const stateless = statelessComponents(spec).find((c) => c.key === key);

  const steps: StepDef[] = [];

  steps.push({
    name: p("close"),
    async run(ctx) {
      const row = componentRow(ctx, key);
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      let baseline: number | undefined;
      if (isValidator && spec.security.keyMode === "softsign") {
        // §5 double-sign safety: record height before the old node dies
        baseline = await sentryRpcHeight(ctx);
      }
      const lease = await ctx.services.api.leaseState(owner, row.dseq, row.provider);
      if (lease === "active") {
        await ctx.requireTx(p("close"), [
          { typeUrl: TypeUrl.CloseDeployment, value: { id: { owner, dseq: row.dseq } } },
        ]);
      }
      // old node must actually be gone (zombie check, §5). Proof of
      // execution required, not mere reachability: some provider gateways
      // (observed on jjozzietech) answer lease-shell for an already-closed
      // lease with empty success, which read as "still alive" and wedged
      // the op behind a container that was long torn down.
      if (row.ssh_host && row.ssh_port) {
        try {
          const probe = await ctx.services.ssh.exec(rowTarget(ctx, row), "echo zombie-probe");
          if (probe.stdout.includes("zombie-probe")) {
            throw new AwaitUser(
              p("close"),
              `${key}'s old container still answers SSH after close: wait for the provider to tear it down, then resume`,
            );
          }
        } catch (e) {
          if (e instanceof AwaitUser) throw e;
          // unreachable — exactly what we want
        }
      }
      ctx.db.setComponentState(ctx.launchId, key, "relaunching");
      return { closedDseq: row.dseq, oldTailnetIp: row.tailnet_ip, baselineHeight: baseline };
    },
  });

  steps.push({
    name: p("deploy"),
    async run(ctx) {
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      // the frontend never joins the mesh — no preauth key to mint
      if (!stateless || stateless.mesh) {
        // fresh preauth key via headscale lease-shell (§5: expired keys
        // re-minted; the headscale image has no sshd) — own row or, for a
        // shared mesh, the owning fleet's lease. preauthkeys --user needs
        // the numeric id.
        const hsRef = headscaleRef(ctx);
        // PINNED: this step re-runs after the signature pause — a re-minted
        // key would rewrite the SDL/manifest and drift from the SIGNED
        // deployment's hash (the provider then 422s the manifest)
        const authkey = await pinnedValue(ctx, `op${opId}-authkey`, async () => {
          const userId = await headscaleUserId(ctx, hsRef, spec.network.name);
          const mint = await ctx.services.provider.shellExec(
            loadCert(ctx),
            hsRef.hostUri,
            hsRef.dseq,
            hsRef.gseq,
            hsRef.oseq,
            "headscale",
            ["sh", "-c", `headscale preauthkeys create --user ${userId} --reusable --expiration 8760h --output json`],
          );
          const parsedKey = JSON.parse(mint.stdout.trim());
          const k: string = typeof parsedKey === "string" ? parsedKey : parsedKey.key;
          if (!k) throw new Error("no preauth key in mint output");
          return k;
        });

        const sdlPath = sdlPathFor(ctx, key);
        let sdl = fs.readFileSync(sdlPath, "utf8");
        sdl = sdl.replace(/TS_AUTHKEY=[^\n"']*/g, `TS_AUTHKEY=${authkey}`);
        // fresh volume must wait for node-data again (no-op for components)
        sdl = sdl.replace(/WAIT_FOR_CONFIG=false/g, "WAIT_FOR_CONFIG=true");
        fs.writeFileSync(sdlPath, sdl);
      }
      const sdlPath = sdlPathFor(ctx, key);

      const artifacts = sdlArtifacts(loadSdl(sdlPath));
      const dseq = await pinnedValue(ctx, `op${opId}-dseq`, async () =>
        String(await ctx.services.api.latestBlockHeight()),
      );
      fs.writeFileSync(
        path.join(ctx.dirs.sdl, `${key}.manifest.json`),
        artifacts.manifestJson,
      );
      const msgs: Msg[] = [
        createDeploymentMsg({
          owner,
          dseq,
          groups: artifacts.groups,
          hash: artifacts.hash,
          deposit: {
            denom: artifacts.pricingDenom,
            amount: DEPOSIT[artifacts.pricingDenom] ?? "5000000",
          },
        }),
      ];
      await ctx.requireTx(p("deploy"), msgs);
      return { dseq, requiredStorageClass: artifacts.requiredStorageClass };
    },
  });

  steps.push({
    name: p("lease"),
    async run(ctx) {
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      const deploy = ctx.output<{ dseq: string; requiredStorageClass?: string }>(p("deploy"))!;
      const providers = await ctx.services.api.listProviders();

      // A lease already signed on a prior run IS the choice — don't re-poll
      // bids (leasing flips the winner to "active" and closes the rest; a
      // re-poll would grind through the whole budget and then misreport
      // "no acceptable bids"). Same short-circuit as deploy-headscale.
      const leaseRow = ctx.db.getPendingTx(ctx.launchId, p("lease"));
      if (leaseRow && (leaseRow.status === "signed" || leaseRow.status === "confirmed")) {
        const bidId = JSON.parse(leaseRow.msgs_json)[0].value.bidId;
        await ctx.requireTx(p("lease"), [createLeaseMsg(bidId)]);
        const all = await ctx.services.api.listBids(owner, deploy.dseq);
        return {
          provider: bidId.provider,
          gseq: bidId.gseq,
          oseq: bidId.oseq,
          hostUri: providers.get(bidId.provider)!.hostUri,
          price: all.find((b) => b.bid.id.provider === bidId.provider)?.bid.price.amount ?? "0",
        };
      }

      // avoid (hard, regardless of anti-affinity mode): any provider we're
      // explicitly moving off of — including the one this component just ran
      // on. A relaunch is a "move", so re-picking the same (often broken)
      // provider defeats the purpose. exclude (per the policy's anti-affinity
      // mode): other active components' providers. Stateless components are
      // exempt from anti-affinity (§6) — only the avoid list constrains them.
      const avoidProviders = new Set<string>(params.avoidProviders ?? []);
      const exclude = new Set<string>();
      if (!stateless) {
        for (const c of ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]) {
          if (c.key !== key && c.state === "active") exclude.add(c.provider);
        }
      }
      const bids = await pollBids(ctx.services.api, owner, deploy.dseq, {
        sleep: ctx.services.sleep,
        minBids: 1,
        // console-air-style: gather a fuller bid set before the policy engine picks
        settleRounds: 2,
      });
      // prefer-listed providers win first (before the spec's own preference)
      const preference = [
        ...new Set([...(params.preferProviders ?? []), ...spec.providers.policy.preference]),
      ];
      const decision = selectProvider(bids.filter((b) => b.bid.state === "open"), {
        policy: { ...spec.providers.policy, preference },
        chosenProviders: exclude,
        avoidProviders,
        excludeMatchers: exclusionEntries(spec, key),
        log: ctx.log,
        requiredStorageClass: deploy.requiredStorageClass,
        providers,
      });
      if (!decision.chosen) {
        // distinguish "market had nothing" from "the bids expired": a bid
        // not leased within a few minutes closes, and providers do not
        // re-bid on an old order — resuming here can never succeed, so
        // point at the abandon path instead of looping on the same order
        const expired = bids.length > 0 && bids.every((b) => b.bid.state !== "open");
        throw new AwaitUser(
          p("lease"),
          expired
            ? `the bids for ${key}'s relaunch deployment have expired (a lease must be signed ` +
                "within a few minutes of the bids arriving). Resuming cannot recover this: " +
                "use Abandon on this operation to close the deployment and refund its escrow, " +
                `then relaunch ${key} again and sign the lease promptly`
            : `no acceptable bids for ${key} relaunch avoiding ${avoidProviders.size + exclude.size} provider(s): ${JSON.stringify(decision.rejected)}`,
        );
      }
      const bidId = decision.chosen.bid.id;
      await ctx.requireTx(p("lease"), [createLeaseMsg(bidId)]);
      return {
        provider: bidId.provider,
        gseq: bidId.gseq,
        oseq: bidId.oseq,
        hostUri: providers.get(bidId.provider)!.hostUri,
        price: decision.chosen.bid.price.amount,
      };
    },
  });

  steps.push({
    name: p("manifest"),
    async run(ctx) {
      const deploy = ctx.output<{ dseq: string }>(p("deploy"))!;
      const lease = ctx.output<{
        provider: string;
        gseq: number;
        oseq: number;
        hostUri: string;
        price: string;
      }>(p("lease"))!;
      const cert = loadCert(ctx);
      const manifest = fs.readFileSync(path.join(ctx.dirs.sdl, `${key}.manifest.json`), "utf8");
      // reconcile hash drift (e.g. pre-pin re-mints rewrote the manifest
      // after the deployment was signed) — update-in-place keeps the lease
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      const wantHash = crypto.createHash("sha256").update(manifest).digest("base64");
      const onChain = await ctx.services.api.deploymentInfo(owner, deploy.dseq);
      if (onChain?.hash && onChain.hash !== wantHash) {
        ctx.log(`${key} manifest hash drifted from deployment ${deploy.dseq} — updating on-chain`);
        await ctx.requireTx(`${p("update")}:${wantHash.slice(0, 8)}`, [
          {
            typeUrl: TypeUrl.UpdateDeployment,
            value: { id: { owner, dseq: deploy.dseq }, hash: wantHash },
          },
        ]);
      }
      await ctx.services.provider.sendManifest(cert, lease.hostUri, deploy.dseq, manifest);
      // the frontend image runs no sshd — just wait for the workload
      const wantSsh = !stateless || stateless.mesh;
      const status = await waitLeaseStatus(
        ctx,
        cert,
        lease.hostUri,
        deploy.dseq,
        lease.gseq,
        lease.oseq,
        wantSsh ? { forwardedPort: 2222 } : {},
      );
      ctx.db.updateComponentPlacement(ctx.launchId, key, {
        dseq: deploy.dseq,
        provider: lease.provider,
        host_uri: lease.hostUri,
        price: lease.price,
        generation: params.generation,
      });
      if (!wantSsh) return {};
      const ssh = extractForwardedPort(status, 2222);
      ctx.db.updateComponentRuntime(ctx.launchId, key, {
        ssh_host: ssh.host,
        ssh_port: ssh.port,
      });
      return ssh;
    },
  });

  if (stateless) {
    // §5: stateless components skip the node rewiring and guarded start —
    // the container is live once it answers on its domain. The explorer's
    // SDL env already carries the real sentry tailnet IP (baked by
    // persist-start), so its tunnels come up correct at boot.
    steps.push({
      name: p("verify"),
      async run(ctx) {
        const url = `https://${stateless!.domain}/`;
        for (let i = 0; i < 36; i++) {
          if (await ctx.services.rpc.httpOk(url)) {
            ctx.db.setComponentState(ctx.launchId, key, "active");
            ctx.db.setFleetOpStatus(opId, "done");
            return { healthy: true, url };
          }
          await ctx.services.sleep(5000);
        }
        // the relaunch moved providers, so the domain's DNS record now
        // points at the OLD provider's ingress — pause with the new target
        const deploy = ctx.output<{ dseq: string }>(p("deploy"))!;
        const lease = ctx.output<{ hostUri: string; gseq: number; oseq: number }>(p("lease"))!;
        const ingress = await ingressHost(
          ctx, lease.hostUri, deploy.dseq, lease.gseq, lease.oseq, stateless!.domain,
        );
        throw new AwaitUser(
          p("verify"),
          `${key} not answering at ${url} — update the DNS record for ${stateless!.domain} → ` +
            `CNAME ${ingress} (the relaunch moved providers), then resume`,
        );
      },
    });
    return steps;
  }

  steps.push({
    name: p("configure"),
    async run(ctx) {
      const row = componentRow(ctx, key);
      const target = rowTarget(ctx, row);
      // upload node data (same node key → same node ID, §5) — new volume
      const bundle = path.join(ctx.dirs.bundles, `${key}.tgz`);
      await ctx.services.ssh.upload(target, bundle, "/tmp/node-data.tgz");
      await ctx.services.ssh.exec(
        target,
        `mkdir -p ${NODE_HOME} && tar xzf /tmp/node-data.tgz -C ${NODE_HOME} && touch ${NODE_HOME}/.node-data-uploaded`,
      );
      if (spec.join) {
        // join fleets: the bundle's [statesync] block still carries the
        // launch-time trust anchor, long outside the light-client trust
        // period by relaunch time. The relaunched node starts on an empty
        // volume and MUST state-sync, so re-resolve a fresh anchor (the
        // same refresh start-chain performs) and re-enable [statesync] in
        // case the bundle was packaged with it flipped off.
        const trust = await resolveStateSyncTrust(ctx);
        let servers = trust.rpcServers.join(",");
        if (isValidator) {
          // own-sentry witness on localhost, same rationale as start-chain:
          // the bundle RPCs may be unreachable from the NEW provider
          // (egress filtering killed exactly this relaunch's state sync on
          // datanode.uk), and the local proxy is provider-agnostic
          const s = resolveTopology(spec).validatorSentries[valIndex]?.[0];
          const sentryIp = s !== undefined ? componentRow(ctx, `sentry-${s}`).tailnet_ip : null;
          if (sentryIp) {
            await ctx.services.ssh.exec(target, socatTunnelCmd(WITNESS_RPC_PORT, sentryIp, 26657));
            servers = `http://127.0.0.1:${WITNESS_RPC_PORT},${servers}`;
          }
        }
        await ctx.services.ssh.exec(
          target,
          `sed -i 's|^rpc_servers = .*|rpc_servers = "${servers}"|; ` +
            `s|^trust_height = .*|trust_height = ${trust.trustHeight}|; ` +
            `s|^trust_hash = .*|trust_hash = "${trust.trustHash}"|; ` +
            `/^\\[statesync\\]$/,/^\\[/ s|^enable = false|enable = true|' ${NODE_HOME}/config/config.toml`,
        );
        ctx.log(`${key}: state-sync trust anchor refreshed at height ${trust.trustHeight}`);
      }
      if (!isValidator) {
        // advertise-peers: the new lease assigned a new forwarded 26656 —
        // re-stamp external_address so the sentry keeps advertising a
        // reachable public peer address (§5 "Public peering"). The uploaded
        // node data still carries the OLD lease's address, so on failure it
        // must be blanked, not kept: a stale address gossips a dead endpoint.
        const deploy = ctx.output<{ dseq: string }>(p("deploy"))!;
        const lease = ctx.output<{ hostUri: string; gseq: number; oseq: number }>(p("lease"))!;
        let advertised = "";
        try {
          const status = await waitLeaseStatus(
            ctx, loadCert(ctx), lease.hostUri, deploy.dseq, lease.gseq, lease.oseq,
            { forwardedPort: 26656, attempts: 6 },
          );
          const ep = extractForwardedPort(status, 26656);
          advertised = `${ep.host}:${ep.port}`;
        } catch {
          ctx.log(`${key}: provider forwards no P2P port; clearing the stale external_address`);
        }
        await ctx.services.ssh.exec(
          target,
          `sed -i 's|^external_address = .*|external_address = "${advertised}"|' ${NODE_HOME}/config/config.toml`,
        );
      }
      // await mesh join → new tailnet IP
      let ip = "";
      for (let attempt = 1; attempt <= 30; attempt++) {
        const res = await ctx.services.ssh.exec(
          target,
          `tailscale --socket=${NODE_HOME}/tailscale/tailscaled.sock ip -4 2>/dev/null || true`,
        );
        ip = res.stdout.trim().split("\n")[0] ?? "";
        if (/^100\./.test(ip)) break;
        if (attempt === 30) throw new Error(`${key} never joined the mesh after relaunch`);
        await ctx.services.sleep(5000);
      }
      ctx.db.updateComponentRuntime(ctx.launchId, key, { tailnet_ip: ip });

      const topo = resolveTopology(spec);
      const publicPeered = new Set<number>();
      if (isValidator) {
        // patch own config's sentry placeholders — public endpoint first
        // (same rationale as patch-validator-peers), tailnet IP fallback
        for (const s of topo.validatorSentries[valIndex] ?? []) {
          const sentryRow = componentRow(ctx, `sentry-${s}`);
          const sentryIp = sentryRow.tailnet_ip;
          if (!sentryIp) throw new Error(`sentry-${s} has no recorded tailnet IP`);
          const token = placeholder.tailnetIp(`sentry-${s}`);
          try {
            const status = await ctx.services.provider.leaseStatus(
              loadCert(ctx), sentryRow.host_uri, sentryRow.dseq, 1, 1,
            );
            const pub = extractForwardedPort(status, 26656);
            const probe = await ctx.services.ssh.exec(
              target,
              `nc -zw 4 ${pub.host} ${pub.port} >/dev/null 2>&1 && echo open || echo closed`,
              { quick: true },
            );
            if (probe.stdout.includes("open")) {
              // cover both the placeholder form and an already-substituted
              // tailnet form (bundles re-packaged after a launch carry IPs)
              await ctx.services.ssh.exec(
                target,
                `sed -i 's|${token}:26656|${pub.host}:${pub.port}|g; ` +
                  `s|@${sentryIp}:26656|@${pub.host}:${pub.port}|g' ${NODE_HOME}/config/config.toml`,
              );
              ctx.log(`${key}: peering with sentry-${s} over its public endpoint ${pub.host}:${pub.port} (no relay)`);
              publicPeered.add(s);
            }
          } catch {
            // no forwarded p2p or probe failure — tailnet fallback below
          }
          await ctx.services.ssh.exec(
            target,
            `sed -i 's|${token}|${sentryIp}|g' ${NODE_HOME}/config/config.toml`,
          );
        }
        // §5: relaunching a validator re-wires its sentries' tunnels.
        // socatTunnelCmd self-cleans the port, so no manual pkill (which,
        // unanchored, could kill its own sh wrapper mid-command).
        for (const s of topo.validatorSentries[valIndex] ?? []) {
          const sentryRow = componentRow(ctx, `sentry-${s}`);
          const port = tunnelPort(valIndex);
          await ctx.services.ssh.exec(rowTarget(ctx, sentryRow), socatTunnelCmd(port, ip));
        }
        if (spec.join) {
          // join validators with no public path still dial OUT through a
          // local mesh proxy — the sentry dial-in alone leaves the link
          // hostage to the sentry dialer's exponential backoff whenever the
          // validator was down a while
          const s0 = (topo.validatorSentries[valIndex] ?? [])[0];
          const sentryIp0 = s0 !== undefined ? componentRow(ctx, `sentry-${s0}`).tailnet_ip : null;
          if (s0 !== undefined && !publicPeered.has(s0) && sentryIp0) {
            await ctx.services.ssh.exec(target, socatTunnelCmd(VAL_PEER_TUNNEL_PORT, sentryIp0, 26656));
            await ctx.services.ssh.exec(
              target,
              `sed -i 's|@${sentryIp0}:26656|@127.0.0.1:${VAL_PEER_TUNNEL_PORT}|' ${NODE_HOME}/config/config.toml`,
            );
          }
        }
      } else {
        // relaunched sentry: create its own tunnels to current validator IPs
        const sIndex = Number(key.split("-")[1]);
        for (const v of topo.sentryValidators[sIndex] ?? []) {
          const valIp = componentRow(ctx, `val-${v}`).tailnet_ip;
          if (!valIp) throw new Error(`val-${v} has no recorded tailnet IP`);
          const port = tunnelPort(v);
          await ctx.services.ssh.exec(target, socatTunnelCmd(port, valIp));
        }
        // §5: relaunching a sentry re-patches its validators' persistent_peers
        const close = ctx.output<{ oldTailnetIp: string | null }>(p("close"))!;
        for (const v of topo.sentryValidators[sIndex] ?? []) {
          const valRow = componentRow(ctx, `val-${v}`);
          if (close.oldTailnetIp) {
            await ctx.services.ssh.exec(
              rowTarget(ctx, valRow),
              `sed -i 's|${close.oldTailnetIp}|${ip}|g' ${NODE_HOME}/config/config.toml`,
            );
          }
          // peer change requires a process restart (documented in the dialog)
          await restartNode(ctx.services.ssh, rowTarget(ctx, valRow));
        }
      }
      return { tailnetIp: ip };
    },
  });

  steps.push({
    name: p("start"),
    async run(ctx) {
      const row = componentRow(ctx, key);
      const target = rowTarget(ctx, row);
      const close = ctx.output<{ baselineHeight?: number }>(p("close"))!;
      const cfg = ctx.output<{ tailnetIp: string }>(p("configure"))!;

      if (isValidator && spec.security.keyMode === "tmkms") {
        // §5 tmkms fleets: new IP → signer must be repointed before start
        const probe = await ctx.services.ssh.exec(target, "nc -z 127.0.0.1 26660 && echo ok || echo no");
        if (probe.stdout.trim() !== "ok") {
          throw new AwaitUser(
            p("start"),
            `repoint your tmkms signer to the relaunched ${key}:\n` +
              `addr = "tcp://${cfg.tailnetIp}:26659"\nthen resume`,
          );
        }
      }
      if (isValidator && spec.security.keyMode === "softsign" && close.baselineHeight !== undefined) {
        // §5 double-sign safety window: wait N blocks past the pre-close height
        for (let i = 0; i < 120; i++) {
          const height = await sentryRpcHeight(ctx, key);
          if (height !== undefined && height >= close.baselineHeight + DOUBLE_SIGN_WINDOW) break;
          if (i === 119) throw new Error("double-sign window never cleared (chain halted?)");
          await ctx.services.sleep(5000);
        }
      }
      // Deliberately NOT starting sparkdreamd here. This step used to
      // SSH-start it, and the persist step's manifest push then restarted
      // the container underneath the young process — observed live killing
      // a validator mid-first-commit right after its state-sync restore,
      // leaving a torn state (storeHeight = appHeight + 1) whose boot-time
      // replay panicked, i.e. a crash loop. The node boots exactly once,
      // entrypoint-owned, when persist flips WAIT_FOR_CONFIG off.
      ctx.db.setComponentState(ctx.launchId, key, "active");
      return { gated: true };
    },
  });

  steps.push({
    name: p("persist"),
    async run(ctx) {
      // §5 step 20b, relaunch edition: the deploy step ships the fresh
      // volume in wait mode; this step persists the final shape into the
      // deployments — WAIT_FOR_CONFIG=false so the entrypoint owns
      // sparkdreamd, current tunnel targets in env so restarts self-heal,
      // and the same corrections for the counterpart sentries whose env
      // still names the old validator IP. The manifest push restarts the
      // containers, and THAT restart is the node's first boot: the start
      // step gates but does not launch, so nothing can be killed mid-commit
      // by this push (an SSH-started node torn down here left a replay-
      // panicking crash loop, and a recycled sentry once came back with its
      // env tunnel aimed at the pre-relaunch validator IP — both observed
      // live).
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      const cfg = ctx.output<{ tailnetIp: string }>(p("configure"))!;
      const topo = resolveTopology(spec);
      const targets: string[] = [key];
      if (isValidator) targets.push(...(topo.validatorSentries[valIndex] ?? []).map((s) => `sentry-${s}`));

      const msgs: Msg[] = [];
      const manifests: Array<{ row: FleetComponentRow; json: string }> = [];
      for (const k of targets) {
        const row = componentRow(ctx, k);
        const sdlPath = sdlPathFor(ctx, k);
        let text = fs.readFileSync(sdlPath, "utf8");
        text = text.replace(/WAIT_FOR_CONFIG=true/g, "WAIT_FOR_CONFIG=false");
        if (k === key && isValidator && spec.join) {
          // own-sentry witness + outbound peer tunnels (what the configure
          // step wired over SSH), baked so a container restart re-creates
          // them — the entrypoint runs every TS_TUNNEL_* env entry
          const s = topo.validatorSentries[valIndex]?.[0];
          const sentryIp = s !== undefined ? componentRow(ctx, `sentry-${s}`).tailnet_ip : null;
          if (sentryIp) {
            const doc = yaml.load(text) as any;
            const svc = doc.services?.sparkdreamd;
            if (svc) {
              const env: string[] = (svc.env ?? []).filter(
                (e: string) => !e.startsWith("TS_TUNNEL_WITNESS=") && !e.startsWith("TS_TUNNEL_PEER="),
              );
              env.push(`TS_TUNNEL_WITNESS=${WITNESS_RPC_PORT}:${sentryIp}:26657`);
              env.push(`TS_TUNNEL_PEER=${VAL_PEER_TUNNEL_PORT}:${sentryIp}:26656`);
              svc.env = env;
              text = yaml.dump(doc, { lineWidth: 120 });
            }
          }
        }
        if (k !== key) {
          // counterpart sentry: re-aim its tunnel for THIS validator at the
          // new tailnet IP (placeholder form covers never-persisted SDLs)
          text = text
            .replace(
              new RegExp(`(TS_TUNNEL_\\d+=${tunnelPort(valIndex)}:)[0-9.]+(:26656)`, "g"),
              `$1${cfg.tailnetIp}$2`,
            )
            .replaceAll(placeholder.tailnetIp(key), cfg.tailnetIp);
        }
        if (k === key && !isValidator) {
          // relaunched sentry: re-aim its validator tunnels at current IPs
          const sIndex = Number(key.split("-")[1]);
          for (const v of topo.sentryValidators[sIndex] ?? []) {
            const valIp = componentRow(ctx, `val-${v}`).tailnet_ip;
            if (!valIp) continue;
            text = text
              .replace(
                new RegExp(`(TS_TUNNEL_\\d+=${tunnelPort(v)}:)[0-9.]+(:26656)`, "g"),
                `$1${valIp}$2`,
              )
              .replaceAll(placeholder.tailnetIp(`val-${v}`), valIp);
          }
        }
        fs.writeFileSync(sdlPath, text);
        const artifacts = sdlArtifacts(loadSdl(sdlPath));
        fs.writeFileSync(path.join(ctx.dirs.sdl, `${k}.manifest.json`), artifacts.manifestJson);
        manifests.push({ row, json: artifacts.manifestJson });
        // convergent like retarget: skip deployments already at this version
        const wantHash = Buffer.from(artifacts.hash).toString("base64");
        const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
        if (onChain?.hash === wantHash) {
          ctx.log(`${k}: on-chain version already matches — skipping update tx`);
          continue;
        }
        msgs.push({
          typeUrl: TypeUrl.UpdateDeployment,
          value: { id: { owner, dseq: row.dseq }, hash: wantHash },
        });
      }
      if (msgs.length > 0) await ctx.requireTx(p("persist"), msgs);
      else ctx.db.deletePendingTx(ctx.launchId, p("persist"));
      const cert = loadCert(ctx);
      // Order matters: the counterpart sentries restart FIRST and must be
      // serving at the head again before the relaunched validator boots.
      // Pushing every manifest at once recycled the validator's only
      // snapshot source in the middle of its state-sync restore — the
      // restore completed against the interrupted chunk stream into a
      // subtly corrupt state whose first block panics ("invalid denom"),
      // i.e. a deterministic crash loop. Observed live twice; a restore
      // from a stable sentry executed cleanly.
      const counterparts = manifests.filter((m) => m.row.key !== key);
      for (const { row: r, json } of counterparts) {
        await ctx.services.provider.sendManifest(cert, r.host_uri, r.dseq, json);
      }
      for (const { row: r } of counterparts) {
        let ok = false;
        let lastProblem = "unreachable";
        for (let i = 0; i < 60 && !ok; i++) {
          if (i > 0) await ctx.services.sleep(5000);
          try {
            const url = await nodeRpcUrl(ctx, r.host_uri, r.dseq);
            const st = await ctx.services.rpc.status(url);
            if (!st.catchingUp && st.latestBlockHeight > 0) ok = true;
            else lastProblem = `catching up at ${st.latestBlockHeight}`;
          } catch (e) {
            lastProblem = String(e).slice(0, 80);
          }
        }
        if (!ok) {
          throw new Error(`${r.key} not back at the head after its persist restart (${lastProblem})`);
        }
      }
      for (const { row: r, json } of manifests.filter((m) => m.row.key === key)) {
        await ctx.services.provider.sendManifest(cert, r.host_uri, r.dseq, json);
      }
      // the push boots the relaunched node (entrypoint-owned, its first and
      // only start) — wait for the process before declaring the op done
      const row = componentRow(ctx, key);
      let back = false;
      for (let i = 0; i < 36 && !back; i++) {
        if (i > 0) await ctx.services.sleep(5000);
        try {
          const r = await ctx.services.ssh.exec(
            rowTarget(ctx, row),
            "pgrep -x sparkdreamd >/dev/null && echo yes || echo no",
            { quick: true },
          );
          back = r.stdout.trim() === "yes";
        } catch {
          // container restarting
        }
      }
      if (!back) throw new Error(`${key} did not come back after the persist restart`);
      ctx.db.setFleetOpStatus(opId, "done");
      return { persisted: targets };
    },
  });

  return steps;
}

/** Rolling upgrade (§5 "Node upgrades"): serial per component, health-gated. */
export function upgradeSteps(opId: number, params: UpgradeParams, spec: LaunchSpec): StepDef[] {
  const steps: StepDef[] = [];
  const stateless = new Map<string, ComponentRef>(
    statelessComponents(spec).map((c) => [c.key, c]),
  );
  const ordered = [...params.components].sort((a, b) => {
    // stateless components upgrade freely, then sentries, validators last
    // (§5 rolling sequencer)
    const rank = (k: string) => (stateless.has(k) ? 0 : k.startsWith("val-") ? 2 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  for (const key of ordered) {
    const p = (s: string) => `op${opId}:${key}:${s}`;
    const earlier = ordered.slice(0, ordered.indexOf(key));

    steps.push({
      name: p("update"),
      async run(ctx) {
        const row = componentRow(ctx, key);
        const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
        const sdlPath = sdlPathFor(ctx, key);
        let sdl = fs.readFileSync(sdlPath, "utf8");
        // precondition (§5): a gated container would come back down
        if (sdl.includes("WAIT_FOR_CONFIG=true")) {
          throw new Error(`${key}: WAIT_FOR_CONFIG still true — run persist-start (step 20b) first`);
        }
        sdl = sdl.replace(/image: .*/g, `image: ${params.image}`);
        fs.writeFileSync(sdlPath, sdl);
        // the explorer reads its chain identity from env (v1.0.6+ renders
        // /chain-config.json from it) — inject the current values on upgrade
        // so installing the env-aware image also delivers the env, without
        // needing a chain reset. In place, so persist-start's resolved
        // tunnel targets survive.
        if (key === "explorer") setExplorerChainEnv(sdlPath, spec);
        const artifacts = sdlArtifacts(loadSdl(sdlPath));
        fs.writeFileSync(
          path.join(ctx.dirs.sdl, `${key}.manifest.json`),
          artifacts.manifestJson,
        );
        // convergent, like retarget: a retried op re-walks components an
        // earlier attempt already updated on-chain, and an update tx whose
        // hash matches the live version is rejected ("invalid: deployment
        // hash") — re-send the manifest only for those
        const wantHash = Buffer.from(artifacts.hash).toString("base64");
        const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
        if (onChain?.hash === wantHash) {
          ctx.log(`${key}: on-chain version already matches — skipping update tx`);
          ctx.db.deletePendingTx(ctx.launchId, p("update"));
        } else {
          const msgs: Msg[] = [
            {
              typeUrl: TypeUrl.UpdateDeployment,
              value: { id: { owner, dseq: row.dseq }, hash: wantHash },
            },
          ];
          // upgrade service fee — flat, once per op, riding the first
          // update tx that actually happens (skipped components can't
          // carry it: there's no tx to batch it into)
          const fee = feeConfig();
          const feeDue = earlier.every(
            (k) => ctx.output<{ txSkipped?: boolean }>(`op${opId}:${k}:update`)?.txSkipped,
          );
          if (feeDue && fee.upgradeFlat > 0) {
            const coin = await feeCoin(
              PRICING_DENOM[spec.infra.akashNetwork],
              String(fee.upgradeFlat),
              ctx.services.api,
            );
            if (coin) msgs.push(sendMsg(owner, fee.address, coin));
            else ctx.log("AKT oracle price unavailable — upgrade fee skipped");
          }
          await ctx.requireTx(p("update"), msgs);
        }
        const cert = loadCert(ctx);
        await ctx.services.provider.sendManifest(
          cert,
          row.host_uri,
          row.dseq,
          fs.readFileSync(path.join(ctx.dirs.sdl, `${key}.manifest.json`), "utf8"),
        );
        ctx.db.updateComponentRuntime(ctx.launchId, key, { image: params.image });
        return { image: params.image, txSkipped: onChain?.hash === wantHash };
      },
    });

    steps.push({
      name: p("verify"),
      async run(ctx) {
        // stateless (§5): ephemeral filesystem, so the update is just the
        // image swap plus an HTTP health gate on the public domain
        const comp = stateless.get(key);
        if (comp) {
          const url = `https://${comp.domain}/`;
          for (let i = 0; i < 60; i++) {
            if (await ctx.services.rpc.httpOk(url)) return { healthy: true, url };
            await ctx.services.sleep(5000);
          }
          throw new Error(`${key} did not answer at ${url} after upgrade`);
        }
        const row = componentRow(ctx, key);
        // persistent volume → same tailnet IP, supervised restart (§5): the
        // gate is "node back and progressing" before the next component.
        // Probe failures are expected while the provider restarts the
        // container, so they only log (deduped) instead of failing the step.
        let lastNote = "";
        const note = (m: string) => {
          if (m === lastNote) return;
          lastNote = m;
          ctx.log(`${key} verify: ${m}`);
        };
        const cause = (e: unknown) =>
          (e instanceof Error ? e.message : String(e)).slice(0, 200);
        for (let i = 0; i < 60; i++) {
          if (key.startsWith("sentry-")) {
            // a sentry proves itself over its public RPC — height progress
            // is the gate, so a broken sshd can't wedge the rollout
            try {
              const url = await nodeRpcUrl(ctx, row.host_uri, row.dseq);
              const a = await ctx.services.rpc.status(url);
              await ctx.services.sleep(3000);
              const b = await ctx.services.rpc.status(url);
              if (b.latestBlockHeight > a.latestBlockHeight) return { healthy: true };
              note(`rpc answers but height is stalled at ${b.latestBlockHeight}`);
            } catch (e) {
              note(`rpc not up yet: ${cause(e)}`);
            }
          } else {
            // validators expose no public RPC — the supervised process
            // being back is the best signal available over SSH
            try {
              const running = await ctx.services.ssh.exec(
                rowTarget(ctx, row),
                "pgrep -x sparkdreamd >/dev/null && echo yes || echo no",
              );
              if (running.stdout.trim() === "yes") return { healthy: true };
              note("ssh reachable, sparkdreamd not running yet");
            } catch (e) {
              note(`ssh probe failed: ${cause(e)}`);
            }
          }
          await ctx.services.sleep(5000);
        }
        throw new Error(
          `${key} did not come back healthy after upgrade (last: ${lastNote || "no probe ran"})`,
        );
      },
    });
  }

  steps.push({
    name: `op${opId}:finish`,
    async run(ctx) {
      ctx.db.setFleetOpStatus(opId, "done");
      return { upgraded: ordered, image: params.image };
    },
  });

  return steps;
}

export interface HaltUpgradeParams {
  image: string;
  haltHeight: number;
}

/**
 * Coordinated halt-height upgrade (§5 "Node upgrades", consensus-breaking
 * releases; M7): halt every node at H, swap every image, resume together.
 */
export function haltUpgradeSteps(
  opId: number,
  params: HaltUpgradeParams,
  spec: LaunchSpec,
): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  // chain nodes only — headscale and the stateless components run neither
  // sparkdreamd nor halt-height
  const nodeRows = (ctx: StepCtx) =>
    (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).filter(
      (c) => c.state === "active" && /^(val|sentry)-/.test(c.key),
    );

  return [
    {
      name: p("halt-set"),
      async run(ctx) {
        // halt-height is read at process start → set it, restart each node
        for (const row of nodeRows(ctx)) {
          const target = rowTarget(ctx, row);
          await ctx.services.ssh.exec(
            target,
            `sed -i 's|^halt-height =.*|halt-height = ${params.haltHeight}|' ${NODE_HOME}/config/app.toml`,
          );
          await restartNode(ctx.services.ssh, target);
        }
        return { haltHeight: params.haltHeight };
      },
    },
    {
      name: p("halt-wait"),
      async run(ctx) {
        for (let i = 0; i < 720; i++) {
          const height = await sentryRpcHeight(ctx);
          if (height !== undefined && height >= params.haltHeight) return { haltedAt: height };
          await ctx.services.sleep(5000);
        }
        throw new Error(`chain never reached halt height ${params.haltHeight}`);
      },
    },
    {
      name: p("halt-clear"),
      async run(ctx) {
        // clear BEFORE the image swap restarts containers, or the new
        // binary comes up and halts again immediately
        for (const row of nodeRows(ctx)) {
          await ctx.services.ssh.exec(
            rowTarget(ctx, row),
            `sed -i 's|^halt-height =.*|halt-height = 0|' ${NODE_HOME}/config/app.toml`,
          );
        }
        return { cleared: true };
      },
    },
    {
      name: p("update-all"),
      async run(ctx) {
        const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
        const msgs: Msg[] = [];
        const manifests: Array<{ row: FleetComponentRow; json: string }> = [];
        for (const row of nodeRows(ctx)) {
          const sdlPath = sdlPathFor(ctx, row.key);
          let sdl = fs.readFileSync(sdlPath, "utf8");
          sdl = sdl.replace(/image: .*/g, `image: ${params.image}`);
          fs.writeFileSync(sdlPath, sdl);
          const artifacts = sdlArtifacts(loadSdl(sdlPath));
          const json = artifacts.manifestJson;
          fs.writeFileSync(path.join(ctx.dirs.sdl, `${row.key}.manifest.json`), json);
          manifests.push({ row, json });
          msgs.push({
            typeUrl: TypeUrl.UpdateDeployment,
            value: {
              id: { owner, dseq: row.dseq },
              hash: Buffer.from(artifacts.hash).toString("base64"),
            },
          });
        }
        // upgrade service fee — flat, once per op, on this batched update
        const fee = feeConfig();
        if (fee.upgradeFlat > 0) {
          const coin = await feeCoin(
            PRICING_DENOM[spec.infra.akashNetwork],
            String(fee.upgradeFlat),
            ctx.services.api,
          );
          if (coin) msgs.push(sendMsg(owner, fee.address, coin));
          else ctx.log("AKT oracle price unavailable — upgrade fee skipped");
        }
        // one batched tx: all nodes move to the new binary together
        await ctx.requireTx(p("update-all"), msgs);
        const cert = loadCert(ctx);
        for (const { row, json } of manifests) {
          await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, json);
          ctx.db.updateComponentRuntime(ctx.launchId, row.key, { image: params.image });
        }
        return { updated: manifests.map((m) => m.row.key) };
      },
    },
    {
      name: p("resume-verify"),
      async run(ctx) {
        // providers restart containers on the new image; WAIT_FOR_CONFIG=false
        // (step 20b) auto-starts them — chain resumes once >2/3 are back
        for (let i = 0; i < 240; i++) {
          const height = await sentryRpcHeight(ctx);
          if (height !== undefined && height > params.haltHeight) {
            ctx.db.setFleetOpStatus(opId, "done");
            return { resumedAt: height };
          }
          await ctx.services.sleep(5000);
        }
        throw new Error("chain did not resume after the coordinated upgrade");
      },
    },
  ];
}

export interface RetargetParams {
  /** Deployments whose SDLs must be re-rendered for the new domains. */
  components: string[];
}

/**
 * Rewrite the domain-bearing parts of an already-deployed SDL from the
 * (updated) spec: accept-domain ingress lists, and the frontend's runtime
 * endpoint env. Everything else — baked tailnet IPs, auth keys, images —
 * is preserved, which is why this mutates the on-disk SDL instead of
 * re-rendering from scratch.
 */
export function retargetSdl(sdlPath: string, key: string, spec: LaunchSpec): void {
  const doc = yaml.load(fs.readFileSync(sdlPath, "utf8")) as any;
  const comps = spec.topology.components;
  const pub = spec.topology.publicEndpoints;
  if (key === "explorer" || key === "frontend") {
    const svc = doc.services?.[key];
    if (!svc) throw new Error(`${key}.yaml has no services.${key}`);
    const domain = comps[key].domain;
    if (!domain) throw new Error(`${key} has no domain in the spec`);
    for (const e of svc.expose ?? []) if (e.accept) e.accept = [domain];
    if (key === "frontend") {
      const env: string[] = svc.env ?? [];
      const set = (k: string, v: string | undefined) => {
        const i = env.findIndex((x) => x.startsWith(k + "="));
        if (v === undefined) {
          if (i >= 0) env.splice(i, 1);
        } else if (i >= 0) env[i] = `${k}=${v}`;
        else env.push(`${k}=${v}`);
      };
      if (pub?.api) set("LCD_ENDPOINT", `https://${pub.api}`);
      if (pub?.rpc) set("RPC_ENDPOINT", `https://${pub.rpc}`);
      set(
        "EXPLORER_URL",
        comps.explorer.enabled && comps.explorer.domain
          ? `https://${comps.explorer.domain}/${comps.explorer.route ?? spec.network.name}`
          : undefined,
      );
      svc.env = env;
    }
  } else {
    // sentry-0: LCD accept rides the 1317 expose, RPC accept the 26657 one
    const svc = doc.services?.sparkdreamd;
    if (!svc) throw new Error(`${key}.yaml has no services.sparkdreamd`);
    for (const e of svc.expose ?? []) {
      if (e.port === 1317 && pub?.api) e.accept = [pub.api];
      if (e.port === 26657 && pub?.rpc) e.accept = [pub.rpc];
    }
  }
  fs.writeFileSync(sdlPath, yaml.dump(doc, { lineWidth: 120 }));
}

/**
 * Domain retarget: batch one MsgUpdateDeployment per affected deployment
 * (same signature), re-send manifests, then gate on the new domains
 * answering. No service fee — it's configuration, not an upgrade. The spec
 * was already updated by requestDomainUpdate, so health checks and future
 * relaunches use the new domains.
 */
export function retargetSteps(opId: number, params: RetargetParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  return [
    {
      name: p("update"),
      async run(ctx) {
        const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
        const msgs: Msg[] = [];
        const manifests: Array<{ row: FleetComponentRow; json: string }> = [];
        for (const key of params.components) {
          const row = componentRow(ctx, key);
          retargetSdl(sdlPathFor(ctx, key), key, spec);
          const artifacts = sdlArtifacts(loadSdl(sdlPathFor(ctx, key)));
          fs.writeFileSync(path.join(ctx.dirs.sdl, `${key}.manifest.json`), artifacts.manifestJson);
          manifests.push({ row, json: artifacts.manifestJson });
          // convergent, like deploy-headscale's hash reconciliation: if the
          // on-chain version already matches (an earlier retarget landed),
          // an update tx would be rejected with ErrInvalidHash ("nothing to
          // change") — just re-send the manifest for that one
          const wantHash = Buffer.from(artifacts.hash).toString("base64");
          const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
          if (onChain?.hash === wantHash) {
            ctx.log(`${key}: on-chain version already matches — skipping update tx`);
            continue;
          }
          msgs.push({
            typeUrl: TypeUrl.UpdateDeployment,
            value: { id: { owner, dseq: row.dseq }, hash: wantHash },
          });
        }
        if (msgs.length > 0) {
          await ctx.requireTx(p("update"), msgs);
        } else {
          // everything already on-chain — drop a tx an earlier pass enqueued
          ctx.db.deletePendingTx(ctx.launchId, p("update"));
        }
        const cert = loadCert(ctx);
        for (const { row, json } of manifests) {
          await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, json);
        }
        return { updated: params.components };
      },
    },
    {
      name: p("verify"),
      async run(ctx) {
        const comps = spec.topology.components;
        const pub = spec.topology.publicEndpoints;
        const urls: string[] = [];
        for (const key of params.components) {
          if (key === "explorer" || key === "frontend") urls.push(`https://${comps[key].domain}/`);
        }
        if (params.components.some((k) => k.startsWith("sentry-"))) {
          if (pub?.api) urls.push(`https://${pub.api}/cosmos/base/tendermint/v1beta1/node_info`);
          if (pub?.rpc) urls.push(`https://${pub.rpc}/status`);
        }
        const dark: string[] = [];
        for (const url of urls) {
          let ok = false;
          for (let i = 0; i < 24 && !ok; i++) {
            if (i > 0) await ctx.services.sleep(5000);
            ok = await ctx.services.rpc.httpOk(url);
          }
          if (!ok) dark.push(url);
        }
        if (dark.length > 0) {
          throw new AwaitUser(
            p("verify"),
            `not reachable after the domain update: ${dark.join(", ")} — ` +
              "create or repoint the DNS records (CNAME each domain to its provider ingress host, " +
              "same target as before for unchanged providers), then resume.",
          );
        }
        ctx.db.setFleetOpStatus(opId, "done");
        return { verified: urls };
      },
    },
  ];
}

export interface ResetChainParams {
  /** New sparkdreamd image — set when the reset rides a chain upgrade. */
  image?: string;
}

/**
 * Patch the explorer's chain-identity env into its deployed SDL in place —
 * everything else (baked tunnel IPs, auth keys, image) is preserved, same
 * rationale as retargetSdl.
 */
function setExplorerChainEnv(sdlPath: string, spec: LaunchSpec): void {
  const doc = yaml.load(fs.readFileSync(sdlPath, "utf8")) as any;
  const svc = doc.services?.explorer;
  if (!svc) throw new Error("explorer.yaml has no services.explorer");
  const env: string[] = svc.env ?? [];
  for (const [k, v] of Object.entries(explorerChainEnv(spec))) {
    const i = env.findIndex((x) => x.startsWith(k + "="));
    if (i >= 0) env[i] = `${k}=${v}`;
    else env.push(`${k}=${v}`);
  }
  svc.env = env;
  fs.writeFileSync(sdlPath, yaml.dump(doc, { lineWidth: 120 }));
}

/**
 * Rewrite WAIT_FOR_CONFIG in the on-disk node SDLs and build the batched
 * MsgUpdateDeployment + manifests. This is how a reset stops and resumes
 * the chain: after persist-start the entrypoint execs sparkdreamd as PID 1,
 * so pkill just restarts the container into a self-healed running node —
 * the only way to hold a node stopped is its own wait mode ("container
 * alive, SSH in, upload config/data"), and the only way out is flipping
 * back. Convergent like retarget: deployments already at the wanted hash
 * are skipped, so re-runs and relaunched nodes (SDL already in wait mode)
 * don't produce rejected txs.
 */
async function flipWaitMode(
  ctx: StepCtx,
  rows: FleetComponentRow[],
  value: "true" | "false",
): Promise<{ msgs: Msg[]; manifests: Array<{ row: FleetComponentRow; json: string }> }> {
  const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
  const msgs: Msg[] = [];
  const manifests: Array<{ row: FleetComponentRow; json: string }> = [];
  for (const row of rows) {
    const sdlPath = sdlPathFor(ctx, row.key);
    const sdl = fs
      .readFileSync(sdlPath, "utf8")
      .replace(/WAIT_FOR_CONFIG=(true|false)/g, `WAIT_FOR_CONFIG=${value}`);
    fs.writeFileSync(sdlPath, sdl);
    const artifacts = sdlArtifacts(loadSdl(sdlPath));
    fs.writeFileSync(path.join(ctx.dirs.sdl, `${row.key}.manifest.json`), artifacts.manifestJson);
    manifests.push({ row, json: artifacts.manifestJson });
    const wantHash = Buffer.from(artifacts.hash).toString("base64");
    const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
    if (onChain?.hash === wantHash) continue;
    msgs.push({
      typeUrl: TypeUrl.UpdateDeployment,
      value: { id: { owner, dseq: row.dseq }, hash: wantHash },
    });
  }
  return { msgs, manifests };
}

/**
 * Chain reset (§5 "Chain reset"): wipe all chain state and restart from a
 * freshly built genesis under a bumped chain-id, on the SAME deployments —
 * no new leases, providers, mesh, or DNS. For state-breaking chain upgrades:
 * the (already-updated) spec's genesis-shaping fields — accounts, members,
 * chainParams, token — all take effect, and the operator/account keyring is
 * rebuilt from scratch (fresh mnemonics; edited account lists just work).
 * The bumped chain-id is also what makes restarting safe: signer state
 * (softsign priv_validator_state, tmkms) can never confuse the new chain
 * with the old one.
 */
export function resetChainSteps(opId: number, params: ResetChainParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const cid = chainId(spec);
  const bondDenom = spec.token.bondDenom ?? spec.token.baseDenom;
  const nodeRows = (ctx: StepCtx) =>
    (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).filter(
      (c) => c.state === "active" && /^(val|sentry)-/.test(c.key),
    );

  const steps: StepDef[] = [
    {
      name: p("halt"),
      async run(ctx) {
        // hold every node stopped via its wait mode (see flipWaitMode);
        // no service fee — it's the reset's stop mechanism, not an upgrade
        const { msgs, manifests } = await flipWaitMode(ctx, nodeRows(ctx), "true");
        if (msgs.length > 0) await ctx.requireTx(p("halt"), msgs);
        else ctx.db.deletePendingTx(ctx.launchId, p("halt"));
        const cert = loadCert(ctx);
        for (const { row, json } of manifests) {
          await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, json);
        }
        // converge to "stopped": once the wait-mode env is on-chain, ANY
        // container restart lands in wait mode — so killing a straggler
        // (even PID-1 sparkdreamd) is terminal, not a self-heal loop
        for (const row of nodeRows(ctx)) {
          let stopped = false;
          for (let i = 0; i < 36 && !stopped; i++) {
            if (i > 0) await ctx.services.sleep(5000);
            if (i > 0 && i % 6 === 0) ctx.log(`${row.key}: waiting for wait mode (attempt ${i})`);
            try {
              const running = await ctx.services.ssh.exec(
                rowTarget(ctx, row),
                "pgrep -x sparkdreamd >/dev/null && echo yes || echo no",
                { quick: true },
              );
              if (running.stdout.trim() === "no") {
                stopped = true;
                break;
              }
              await ctx.services.ssh.exec(rowTarget(ctx, row), "pkill -x sparkdreamd || true", {
                quick: true,
              });
            } catch {
              // container restarting into wait mode
            }
          }
          if (!stopped) throw new Error(`${row.key}: sparkdreamd still running after the wait-mode flip`);
        }
        return { halted: nodeRows(ctx).map((r) => r.key) };
      },
    },
    {
      name: p("reset-keys"),
      async run(ctx) {
        const master = ctx.dirs.node("val-0");
        // the whole account keyring is rebuilt — edited account lists (new,
        // renamed, member changes) regenerate cleanly; old mnemonics die here
        fs.rmSync(path.join(master, "keyring-test"), { recursive: true, force: true });
        fs.rmSync(path.join(master, "config", "gentx"), { recursive: true, force: true });
        // fresh genesis skeleton with the NEW chain-id, from a throwaway home
        // (init in the node homes would clobber their rendered configs)
        const scratch = path.join(ctx.dirs.root, `op${opId}-init`);
        fs.rmSync(scratch, { recursive: true, force: true });
        await sparkdreamd([
          "init", "reset", "--chain-id", cid, "--default-denom", bondDenom, "--home", scratch,
        ]);
        fs.copyFileSync(
          path.join(scratch, "config", "genesis.json"),
          path.join(master, "config", "genesis.json"),
        );
        fs.rmSync(scratch, { recursive: true, force: true });

        const accounts = await createNamedAccounts(ctx);
        // fold the new addresses into the launch's generate-keys output —
        // the accounts view and later ops read it (node keys are untouched)
        const keys = ctx.output<GenerateKeysOutput>("generate-keys");
        if (!keys) throw new Error("generate-keys output missing");
        ctx.db.stepDone(ctx.launchId, "generate-keys", { ...keys, accounts });
        // external operators re-sign gentxs against the new chain-id — the
        // old sign docs are stale, so drop the rows entirely
        ctx.db.deleteGentxs(ctx.launchId);
        return { chainId: cid, accounts: Object.keys(accounts).length };
      },
    },
    {
      name: p("rebuild-genesis"),
      async run(ctx) {
        const keys = ctx.output<GenerateKeysOutput>("generate-keys");
        if (!keys) throw new Error("generate-keys output missing");
        const result = await buildGenesisFiles(ctx, keys);
        // bundles feed future relaunches — re-pack so they carry the new genesis
        await packageNodeDataStep.run(ctx);
        return result;
      },
    },
  ];

  if (params.image) {
    steps.push({
      name: p("swap-image"),
      async run(ctx) {
        const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
        const msgs: Msg[] = [];
        const manifests: Array<{ row: FleetComponentRow; json: string }> = [];
        for (const row of nodeRows(ctx)) {
          const sdlPath = sdlPathFor(ctx, row.key);
          let sdl = fs.readFileSync(sdlPath, "utf8");
          sdl = sdl.replace(/image: .*/g, `image: ${params.image}`);
          fs.writeFileSync(sdlPath, sdl);
          const artifacts = sdlArtifacts(loadSdl(sdlPath));
          fs.writeFileSync(
            path.join(ctx.dirs.sdl, `${row.key}.manifest.json`),
            artifacts.manifestJson,
          );
          manifests.push({ row, json: artifacts.manifestJson });
          const wantHash = Buffer.from(artifacts.hash).toString("base64");
          const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
          if (onChain?.hash === wantHash) {
            ctx.log(`${row.key}: on-chain version already matches — skipping update tx`);
            continue;
          }
          msgs.push({
            typeUrl: TypeUrl.UpdateDeployment,
            value: { id: { owner, dseq: row.dseq }, hash: wantHash },
          });
        }
        // it's an upgrade — same flat fee as the rolling/halt upgrade ops
        const fee = feeConfig();
        if (msgs.length > 0 && fee.upgradeFlat > 0) {
          const coin = await feeCoin(
            PRICING_DENOM[spec.infra.akashNetwork],
            String(fee.upgradeFlat),
            ctx.services.api,
          );
          if (coin) msgs.push(sendMsg(owner, fee.address, coin));
          else ctx.log("AKT oracle price unavailable — upgrade fee skipped");
        }
        if (msgs.length > 0) await ctx.requireTx(p("swap-image"), msgs);
        else ctx.db.deletePendingTx(ctx.launchId, p("swap-image"));
        const cert = loadCert(ctx);
        for (const { row, json } of manifests) {
          await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, json);
          ctx.db.updateComponentRuntime(ctx.launchId, row.key, { image: params.image! });
        }
        // providers restart the containers — into wait mode, since op:halt
        // flipped the env first; wait for SSH back before the wipe
        for (const row of nodeRows(ctx)) {
          let up = false;
          for (let i = 0; i < 60 && !up; i++) {
            if (i > 0) await ctx.services.sleep(5000);
            try {
              await ctx.services.ssh.exec(rowTarget(ctx, row), "true");
              up = true;
            } catch {
              // container still restarting
            }
          }
          if (!up) throw new Error(`${row.key} unreachable after the image swap`);
        }
        return { image: params.image };
      },
    });
  }

  steps.push(
    {
      name: p("wipe"),
      async run(ctx) {
        const master = ctx.dirs.node("val-0");
        const genesisPath = path.join(master, "config", "genesis.json");
        // nothing is running (wait mode, enforced by op:halt) — the data
        // wipe and genesis swap happen on a quiet home dir
        for (const row of nodeRows(ctx)) {
          const target = rowTarget(ctx, row);
          await ctx.services.ssh.exec(
            target,
            `sparkdreamd comet unsafe-reset-all --home ${NODE_HOME}`,
          );
          await ctx.services.ssh.upload(target, genesisPath, `${NODE_HOME}/config/genesis.json`);
          await ctx.services.ssh.exec(
            target,
            `sed -i 's|^chain-id =.*|chain-id = "${cid}"|' ${NODE_HOME}/config/client.toml`,
          );
        }
        return { wiped: nodeRows(ctx).map((r) => r.key), chainId: cid };
      },
    },
  );

  if (spec.security.keyMode === "tmkms") {
    steps.push({
      name: p("signer"),
      async run(ctx) {
        // new chain-id → the signer needs [chain] id updated BEFORE the
        // nodes resume (tmkms state is per-chain-id, so it starts fresh)
        for (const row of nodeRows(ctx).filter((r) => r.key.startsWith("val-"))) {
          const probe = await ctx.services.ssh.exec(
            rowTarget(ctx, row),
            "nc -z 127.0.0.1 26660 && echo ok || echo no",
          );
          if (probe.stdout.trim() !== "ok") {
            throw new AwaitUser(
              p("signer"),
              `update your tmkms config for ${row.key}: set chain_id = "${cid}" in tmkms.toml ` +
                "(both [[chain]] and [[validator]]), restart the signer, then resume",
            );
          }
        }
        return { signersReady: true };
      },
    });
  }

  steps.push(
    {
      name: p("start"),
      async run(ctx) {
        // resume: flip wait mode off — the entrypoint execs sparkdreamd on
        // the new genesis when the containers restart
        const { msgs, manifests } = await flipWaitMode(ctx, nodeRows(ctx), "false");
        // the frontend and explorer embed chain identity in their env
        // (CHAIN_ID/CHAIN_NAME, denoms, display symbols — the Keplr
        // suggest-chain payload and the explorer's runtime chain config) —
        // refresh both on the resume tx, or they keep advertising the
        // pre-reset chain. The frontend re-renders wholesale (no
        // placeholders); the explorer's env is patched in place, because a
        // re-render would reintroduce the {{TS_AUTHKEY}}/tunnel
        // placeholders that persist-start already resolved.
        const componentRows = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).filter(
          (c) => (c.key === "frontend" || c.key === "explorer") && c.state === "active",
        );
        for (const row of componentRows) {
          const sdlPath = sdlPathFor(ctx, row.key);
          if (row.key === "frontend") {
            const keys = ctx.output<GenerateKeysOutput>("generate-keys");
            if (!keys) throw new Error("generate-keys output missing");
            const component = statelessComponents(spec).find((c) => c.key === "frontend")!;
            renderComponentSdl({
              spec,
              component,
              sshPublicKey: keys.sshPublicKey,
              outPath: sdlPath,
              placeholder,
            });
          } else {
            setExplorerChainEnv(sdlPath, spec);
          }
          const artifacts = sdlArtifacts(loadSdl(sdlPath));
          fs.writeFileSync(
            path.join(ctx.dirs.sdl, `${row.key}.manifest.json`),
            artifacts.manifestJson,
          );
          manifests.push({ row, json: artifacts.manifestJson });
          const wantHash = Buffer.from(artifacts.hash).toString("base64");
          const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
          const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
          if (onChain?.hash !== wantHash) {
            msgs.push({
              typeUrl: TypeUrl.UpdateDeployment,
              value: { id: { owner, dseq: row.dseq }, hash: wantHash },
            });
          }
        }
        if (msgs.length > 0) await ctx.requireTx(p("start"), msgs);
        else ctx.db.deletePendingTx(ctx.launchId, p("start"));
        const cert = loadCert(ctx);
        for (const { row, json } of manifests) {
          await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, json);
        }
        // sentries first — validators dial them on start
        const rows = nodeRows(ctx).sort(
          (a, b) =>
            (a.key.startsWith("val-") ? 1 : 0) - (b.key.startsWith("val-") ? 1 : 0) ||
            a.key.localeCompare(b.key),
        );
        for (const row of rows) {
          let running = false;
          for (let i = 0; i < 36 && !running; i++) {
            if (i > 0) await ctx.services.sleep(5000);
            if (i > 0 && i % 6 === 0) ctx.log(`${row.key}: waiting for the node (attempt ${i})`);
            try {
              const r = await ctx.services.ssh.exec(
                rowTarget(ctx, row),
                "pgrep -x sparkdreamd >/dev/null && echo yes || echo no",
                { quick: true },
              );
              if (r.stdout.trim() === "yes") running = true;
              // a node whose deployment hash didn't change (relaunched nodes
              // already carried wait mode) gets no container restart and
              // must be started the SSH way. The long grace period keeps the
              // nudge clear of a restarting container's entrypoint (tailscale
              // join etc.) — racing it would double-start sparkdreamd.
              else if (i >= 12) await ctx.services.ssh.exec(rowTarget(ctx, row), START_NODE_CMD);
            } catch {
              // container restarting
            }
          }
          if (!running) throw new Error(`${row.key} did not come back after the resume flip`);
        }
        return { resumed: rows.map((r) => r.key) };
      },
    },
    {
      name: p("retunnel"),
      async run(ctx) {
        // sentry-side p2p tunnels: the restarts killed SSH-issued socat
        // listeners; env-baked ones self-heal but relaunched nodes' don't —
        // re-issuing is idempotent, so do it for every sentry
        const topo = resolveTopology(spec);
        for (const row of nodeRows(ctx).filter((r) => r.key.startsWith("sentry-"))) {
          const sIndex = Number(row.key.split("-")[1]);
          for (const v of topo.sentryValidators[sIndex] ?? []) {
            const valIp = componentRow(ctx, `val-${v}`).tailnet_ip;
            if (!valIp) throw new Error(`val-${v} has no recorded tailnet IP`);
            await ctx.services.ssh.exec(rowTarget(ctx, row), socatTunnelCmd(tunnelPort(v), valIp));
          }
        }
        return { retunneled: true };
      },
    },
    {
      name: p("verify"),
      async run(ctx) {
        let height: number | undefined;
        for (let i = 0; i < 120 && height === undefined; i++) {
          if (i > 0) await ctx.services.sleep(5000);
          if (i > 0 && i % 12 === 0) ctx.log(`waiting for block production (attempt ${i})`);
          try {
            const h = await sentryRpcHeight(ctx);
            if (h !== undefined && h >= 1) height = h;
          } catch {
            // sentry RPC still rebooting — the loop is the retry
          }
        }
        if (height === undefined) {
          throw new Error("chain did not start producing blocks after the reset");
        }
        // the frontend and explorer restarted with the new chain env — gate
        // on both answering again
        const active = new Set(
          (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[])
            .filter((c) => c.state === "active")
            .map((c) => c.key),
        );
        for (const comp of statelessComponents(spec).filter((c) => active.has(c.key))) {
          let ok = false;
          for (let i = 0; i < 24 && !ok; i++) {
            if (i > 0) await ctx.services.sleep(5000);
            ok = await ctx.services.rpc.httpOk(`https://${comp.domain}/`);
          }
          if (!ok) throw new Error(`${comp.key} did not answer at https://${comp.domain}/ after the reset`);
        }
        ctx.db.setFleetOpStatus(opId, "done");
        return { chainId: cid, height };
      },
    },
  );

  return steps;
}

export interface UnjailParams {
  /** Validator component key, e.g. "val-0". */
  key: string;
}

/** Gas budget for MsgUnjail (a light tx; generous headroom). */
const UNJAIL_GAS = 300_000;

/**
 * Unjail a downtime-jailed validator (§5): gate on the node being back at
 * the chain head (unjailing a still-lagging node just re-jails it one
 * signed-blocks window later), broadcast MsgUnjail from the operator key
 * the conductor holds, and verify the validator re-enters the bonded set.
 * Generated operators only — external operators hold their own keys and
 * unjail from their own wallet (requestUnjail refuses them up front).
 */
export function unjailSteps(opId: number, params: UnjailParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const v = Number(params.key.split("-")[1]);
  const cid = chainId(spec);

  const ownRpc = async (ctx: StepCtx): Promise<string> => {
    const sentry = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find(
      (c) => c.key.startsWith("sentry-") && c.state === "active",
    );
    if (!sentry) throw new Error("no active sentry to reach the chain through");
    return nodeRpcUrl(ctx, sentry.host_uri, sentry.dseq);
  };

  const operator = (ctx: StepCtx): string => {
    const keys = ctx.output<GenerateKeysOutput>("generate-keys");
    const address = keys?.accounts[`op-val-${v}`];
    if (!address) throw new Error(`no operator account recorded for ${params.key}`);
    return address;
  };

  return [
    {
      name: p("sync-gate"),
      async run(ctx) {
        // same rationale as the phase-g bond gate: the chain only lifts the
        // jail; whether it sticks depends on the node signing immediately
        const row = componentRow(ctx, params.key);
        const target = rowTarget(ctx, row);
        let lastProblem = "no probe yet";
        for (let i = 0; i < 120; i++) {
          if (i > 0) await ctx.services.sleep(5000);
          const head = await sentryRpcHeight(ctx);
          const probe = await ctx.services.ssh.exec(
            target,
            "wget -qO- http://127.0.0.1:26657/status 2>/dev/null || true",
            { quick: true },
          );
          const height = Number(/latest_block_height"?\s*:\s*"?(\d+)/.exec(probe.stdout)?.[1]);
          const catchingUp = /catching_up"?\s*:\s*"?(\w+)/.exec(probe.stdout)?.[1] === "true";
          if (Number.isFinite(height) && !catchingUp && (head === undefined || height >= head - 3)) {
            return { height, head };
          }
          lastProblem = Number.isFinite(height)
            ? `${catchingUp ? "catching up " : ""}at height ${height}, chain head ${head ?? "unknown"}`
            : "local RPC not answering";
        }
        throw new Error(
          `${params.key} is not at the chain head after ~10 min (${lastProblem}) — ` +
            "unjailing now would only re-jail it; fix the node first, then resume",
        );
      },
    },
    {
      name: p("unjail"),
      async run(ctx) {
        const rpc = await ownRpc(ctx);
        const address = operator(ctx);
        const valoper = valoperAddress(address);
        const val = await queryJson(["query", "staking", "validator", valoper], rpc);
        if (!(val.validator ?? val).jailed) {
          return { alreadyUnjailed: true }; // idempotent re-run
        }
        // the chain refuses MsgUnjail before jailed_until — a fast relaunch
        // can beat the 10-minute jail clock here (observed live: "validator
        // still jailed" burned a fee); wait the window out instead
        try {
          const keys = ctx.output<GenerateKeysOutput>("generate-keys");
          const pubkey = keys?.consensusPubkeys[params.key];
          if (pubkey) {
            const pubkeyArg = JSON.stringify({ "@type": "/cosmos.crypto.ed25519.PubKey", key: pubkey });
            const out = await queryJson(["query", "slashing", "signing-info", pubkeyArg], rpc);
            const info = out.val_signing_info ?? out;
            const until = info.jailed_until ? new Date(info.jailed_until).getTime() : 0;
            const waitMs = until - Date.now() + 5000;
            if (waitMs > 0 && waitMs < 3_600_000) {
              ctx.log(`${params.key}: jailed until ${info.jailed_until} — waiting ${Math.ceil(waitMs / 1000)}s`);
              await ctx.services.sleep(waitMs);
            }
          }
        } catch {
          // best-effort: a failed query falls through to the broadcast,
          // whose own error stays the source of truth
        }
        const fee = Math.ceil(Number(spec.token.minGasPrice) * UNJAIL_GAS);

        if (Array.isArray(spec.topology.validators.operators)) {
          // external operator: the wallet signs MsgUnjail through the same
          // amino signing loop as promote-validator's create-validator
          const coords = await accountCoordinates(ctx, rpc, address);
          const signDoc = buildUnjailSignDoc(address, cid, {
            ...coords,
            fee: {
              amount: fee > 0 ? [{ denom: spec.token.baseDenom, amount: String(fee) }] : [],
              gas: String(UNJAIL_GAS),
            },
          });
          // the gentx row for this valIndex may still hold Phase G's SIGNED
          // create-validator response — requireGentx would hand it straight
          // back; clear it so the wallet is served the unjail doc instead
          const row = ctx.db.getPendingGentx(ctx.launchId, v);
          if (row?.status === "signed" && row.sign_doc_json !== JSON.stringify(signDoc)) {
            ctx.db.resetGentx(ctx.launchId, v);
          }
          const responseJson = ctx.requireGentx(v, address, JSON.stringify(signDoc));
          const response = JSON.parse(responseJson) as GentxSignResponse;
          const verdict = await verifySignedDoc(signDoc, response, address);
          if (!verdict.ok) {
            ctx.db.resetGentx(ctx.launchId, v);
            throw new Error(`unjail signature for ${params.key} rejected: ${verdict.reason}`);
          }
          const txFile = path.join(ctx.dirs.root, `op${opId}-unjail.signed.json`);
          fs.writeFileSync(txFile, assembleUnjailTxJson(address, response));
          try {
            const { stdout } = await sparkdreamd([
              "tx", "broadcast", txFile, "--node", rpc, "--output", "json",
            ]);
            const res = JSON.parse(stdout) as { txhash: string; code?: number; raw_log?: string };
            if (res.code) {
              throw new Error(`unjail rejected at broadcast (code ${res.code}): ${res.raw_log ?? ""}`);
            }
            await awaitTxIncluded(ctx, rpc, res.txhash);
            return { txhash: res.txhash };
          } catch (e) {
            // a stale sequence (the operator transacted between sign and
            // broadcast) needs a FRESH sign doc — never replay the cached one
            ctx.db.resetGentx(ctx.launchId, v);
            throw e;
          }
        }

        // generated operator: the conductor holds the key in the master keyring
        const { stdout } = await sparkdreamd([
          "tx", "slashing", "unjail",
          "--from", `op-val-${v}`,
          "--keyring-backend", "test",
          "--home", ctx.dirs.node("val-0"),
          "--chain-id", cid,
          "--node", rpc,
          "--gas", String(UNJAIL_GAS),
          "--fees", `${fee}${spec.token.baseDenom}`,
          "--yes",
          "--output", "json",
        ]);
        const res = JSON.parse(stdout) as { txhash: string; code?: number; raw_log?: string };
        if (res.code) {
          // e.g. still inside jailed_until, or slashed below min-self-delegation
          throw new Error(`unjail rejected at broadcast (code ${res.code}): ${res.raw_log ?? ""}`);
        }
        await awaitTxIncluded(ctx, rpc, res.txhash);
        return { txhash: res.txhash };
      },
    },
    {
      name: p("verify"),
      async run(ctx) {
        const rpc = await ownRpc(ctx);
        const valoper = valoperAddress(operator(ctx));
        let status = "";
        let jailed = true;
        for (let i = 0; i < 36 && (jailed || status !== "BOND_STATUS_BONDED"); i++) {
          if (i > 0) await ctx.services.sleep(5000);
          try {
            const out = await queryJson(["query", "staking", "validator", valoper], rpc);
            const val = out.validator ?? out;
            jailed = Boolean(val.jailed);
            status = val.status ?? "";
          } catch {
            // transient RPC failure — the loop is the retry
          }
        }
        if (jailed || status !== "BOND_STATUS_BONDED") {
          throw new Error(
            `${params.key} did not re-enter the bonded set after ~3 min ` +
              `(jailed: ${jailed}, status: ${status || "unknown"})`,
          );
        }
        ctx.db.setFleetOpStatus(opId, "done");
        return { unjailed: true };
      },
    },
  ];
}

export interface ResumeSigningParams {
  /** Validator component key, e.g. "val-0". */
  key: string;
}

/** Blocks of live signing the verify step insists on observing. */
const RESUME_PROBE_BLOCKS = 10;

/**
 * Resume signing on a stalled tmkms validator: the signer box went away
 * (power, network, a mesh re-key) and its privval session dropped, so the
 * validator started missing blocks — on a small fleet the chain stalls
 * outright. Without this op the only recovery is bouncing the deployment by
 * hand through another tool, and that out-of-band manifest update drifts the
 * on-chain hash away from the launcher's SDL and 422s every later manifest
 * send (seen live). Instead: gate on the signer session being back (the user
 * brings the signer up first), restart sparkdreamd in place — no manifest
 * change, no hash drift — then prove the validator is signing by watching
 * its signing-info counters advance.
 */
export function resumeSigningSteps(opId: number, params: ResumeSigningParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const v = Number(params.key.split("-")[1]);

  const ownRpc = async (ctx: StepCtx): Promise<string> => {
    const sentry = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find(
      (c) => c.key.startsWith("sentry-") && c.state === "active",
    );
    if (!sentry) throw new Error("no active sentry to reach the chain through");
    return nodeRpcUrl(ctx, sentry.host_uri, sentry.dseq);
  };

  return [
    {
      // named to rhyme with the launch's await-signer on purpose: the UI
      // auto-opens the tmkms setup card for any *await-signer step that
      // parks at AwaitUser
      name: p("await-signer"),
      async run(ctx) {
        const row = componentRow(ctx, params.key);
        const target = rowTarget(ctx, row);
        // a ready signer's reconnect lands within seconds — poll a minute
        // before parking (same cushion as the launch's await-signer)
        for (let attempt = 0; attempt < 12; attempt++) {
          if (attempt > 0) await ctx.services.sleep(5000);
          const probe = await ctx.services.ssh.exec(target, SIGNER_CONNECTED_PROBE);
          if (probeSaysConnected(probe.stdout)) return { connected: true };
        }
        throw new AwaitUser(
          p("await-signer"),
          `${params.key} has no connected tmkms signer: start (or restart) the signer and let ` +
            "it rejoin the mesh (the tmkms panel shows the live session state). Resume once " +
            "it reports connected; the op then restarts the validator process in place and " +
            "watches it sign blocks again.",
        );
      },
    },
    {
      name: p("restart"),
      async run(ctx) {
        // process bounce over SSH (lease-shell fallback): unlike a manifest
        // update this changes nothing on-chain, so nothing can drift
        const row = componentRow(ctx, params.key);
        await restartNode(ctx.services.ssh, rowTarget(ctx, row));
        return { restarted: true };
      },
    },
    {
      name: p("verify"),
      async run(ctx) {
        const keys = ctx.output<GenerateKeysOutput>("generate-keys");
        const address = keys?.accounts[`op-val-${v}`];
        const pubkey =
          keys?.consensusPubkeys[params.key] ?? spec.topology.validators.consensusPubkeys?.[v];
        const rpc = await ownRpc(ctx);
        if (!address || !pubkey) {
          throw new Error(
            `${params.key}: no operator account or consensus pubkey recorded; cannot probe signing`,
          );
        }
        const valoper = valoperAddress(address);
        const pubkeyArg = JSON.stringify({ "@type": "/cosmos.crypto.ed25519.PubKey", key: pubkey });
        let baseline: { offset: number; missed: number } | undefined;
        let lastProblem = "no signing info yet";
        for (let i = 0; i < 90; i++) {
          if (i > 0) await ctx.services.sleep(5000);
          // a stall long enough to jail means no restart can resume the
          // chain — recovery is the unjail op, and making this step fail
          // would only obscure that (same rationale as verify-signing)
          try {
            const out = await queryJson(["query", "staking", "validator", valoper], rpc);
            if (Boolean((out.validator ?? out).jailed)) {
              ctx.log(
                `${params.key} was downtime-jailed during the stall. The process is restarted ` +
                  "and the signer connected, but the chain re-admits it only via the fleet " +
                  "panel's unjail action (it gates on the node being back at the head first).",
              );
              ctx.db.setFleetOpStatus(opId, "done");
              return { restarted: true, jailed: true };
            }
          } catch (e) {
            lastProblem = `validator query failed (${String(e).slice(0, 80)})`;
            continue;
          }
          let info: any;
          try {
            const out = await queryJson(["query", "slashing", "signing-info", pubkeyArg], rpc);
            info = out.val_signing_info ?? out;
          } catch (e) {
            lastProblem = `signing-info query failed (${String(e).slice(0, 80)})`;
            continue;
          }
          // index_offset advances per block in the active set (so it also
          // stands still while the whole chain is stalled);
          // missed_blocks_counter grows per block this validator failed to sign
          const offset = Number(info.index_offset ?? 0);
          const missed = Number(info.missed_blocks_counter ?? 0);
          if (!baseline) baseline = { offset, missed };
          const seen = offset - baseline.offset;
          const missedDelta = Math.max(0, missed - baseline.missed);
          if (seen < RESUME_PROBE_BLOCKS) {
            lastProblem =
              seen <= 0
                ? "no new blocks since the restart (chain stalled or node not in the set)"
                : `observed ${Math.max(0, seen)} of ${RESUME_PROBE_BLOCKS} blocks`;
            continue;
          }
          if (missedDelta * 2 > seen) {
            throw new Error(
              `${params.key} missed ${missedDelta} of the last ${seen} blocks after the restart, ` +
                "so it is still not signing: check the signer session (tmkms panel), the key it " +
                "holds, and the node's peers",
            );
          }
          ctx.log(
            `${params.key}: signing confirmed (${seen - missedDelta}/${seen} blocks in the probe window)`,
          );
          ctx.db.setFleetOpStatus(opId, "done");
          return { restarted: true, signing: true };
        }
        throw new Error(
          `${params.key}: could not confirm signing after ~7 min (${lastProblem}); the chain ` +
            "only produces blocks when this validator signs, so check the signer session and the node",
        );
      },
    },
  ];
}

/** Steps for every active op of a launch, in creation order. */
export function buildOpSteps(db: ConductorDb, launchId: string): StepDef[] {  const launch = db.getLaunch(launchId);
  if (!launch) return [];
  const spec = withDefaults(JSON.parse(launch.spec_json));
  const steps: StepDef[] = [];
  for (const op of db.listFleetOps(launchId) as FleetOpRow[]) {
    if (op.status !== "active" && op.status !== "done") continue;
    // done ops keep their steps in the list — checkpointed rows skip instantly
    const params = JSON.parse(op.params_json);
    if (op.kind === "relaunch") steps.push(...relaunchSteps(op.id, params, spec));
    if (op.kind === "upgrade") steps.push(...upgradeSteps(op.id, params, spec));
    if (op.kind === "halt-upgrade") steps.push(...haltUpgradeSteps(op.id, params, spec));
    if (op.kind === "retarget") steps.push(...retargetSteps(op.id, params, spec));
    if (op.kind === "reset-chain") steps.push(...resetChainSteps(op.id, params, spec));
    if (op.kind === "unjail") steps.push(...unjailSteps(op.id, params, spec));
    if (op.kind === "resume-signing") steps.push(...resumeSigningSteps(op.id, params, spec));
  }
  return steps;
}
