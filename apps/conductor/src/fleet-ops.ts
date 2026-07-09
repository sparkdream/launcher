import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveTopology, tunnelPort, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb, FleetComponentRow, FleetOpRow } from "./db.js";
import { AwaitUser, type StepCtx, type StepDef } from "./engine.js";
import { createDeploymentMsg, createLeaseMsg, TypeUrl, type Msg } from "./akash/messages.js";
import { pollBids } from "./akash/client.js";
import { selectProvider } from "./akash/policy.js";
import { loadSdl, sdlArtifacts, sortedJson } from "./akash/sdl-groups.js";
import { extractForwardedPort, headscaleUserId, loadCert, nodeRpcUrl, nodeShellFallback, pinnedValue, sshTarget, waitLeaseStatus } from "./steps/phase-bcd.js";
import { placeholder } from "./steps/phase-a.js";
import { NODE_HOME, restartNode, rpcUrl, socatTunnelCmd, START_NODE_CMD } from "./node-ops.js";
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

/** Relaunch: close → fresh deploy on a new provider → rewire → guarded start. */
export function relaunchSteps(opId: number, params: RelaunchParams, spec: LaunchSpec): StepDef[] {
  const { key } = params;
  const p = (s: string) => `op${opId}:${s}`;
  const isValidator = key.startsWith("val-");
  const valIndex = isValidator ? Number(key.split("-")[1]) : -1;

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
      // old node must actually be gone (zombie check, §5)
      if (row.ssh_host && row.ssh_port) {
        try {
          await ctx.services.ssh.exec(rowTarget(ctx, row), "true");
          throw new AwaitUser(
            p("close"),
            `${key}'s old container still answers SSH after close — wait for the provider to tear it down, then resume`,
          );
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
      const hsRow = componentRow(ctx, "headscale");
      // fresh preauth key via headscale lease-shell (§5: expired keys
      // re-minted; the headscale image has no sshd). Single-group SDL ⇒
      // gseq/oseq are always 1. preauthkeys --user needs the numeric id.
      const hsRef = { hostUri: hsRow.host_uri, dseq: hsRow.dseq, gseq: 1, oseq: 1 };
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
      // fresh volume must wait for node-data again
      sdl = sdl.replace(/WAIT_FOR_CONFIG=false/g, "WAIT_FOR_CONFIG=true");
      fs.writeFileSync(sdlPath, sdl);

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

      // exclude: other active components' providers (anti-affinity) PLUS
      // any provider we're explicitly moving off of — including the one this
      // component just ran on. A relaunch is a "move", so re-picking the
      // same (often broken) provider defeats the purpose.
      const exclude = new Set<string>(params.avoidProviders ?? []);
      for (const c of ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]) {
        if (c.key !== key && c.state === "active") exclude.add(c.provider);
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
        requiredStorageClass: deploy.requiredStorageClass,
        providers,
      });
      if (!decision.chosen) {
        throw new AwaitUser(
          p("lease"),
          `no acceptable bids for ${key} relaunch avoiding ${[...exclude].length} provider(s): ${JSON.stringify(decision.rejected)}`,
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
      const status = await waitLeaseStatus(
        ctx,
        cert,
        lease.hostUri,
        deploy.dseq,
        lease.gseq,
        lease.oseq,
        { forwardedPort: 2222 },
      );
      const ssh = extractForwardedPort(status, 2222);
      ctx.db.updateComponentPlacement(ctx.launchId, key, {
        dseq: deploy.dseq,
        provider: lease.provider,
        host_uri: lease.hostUri,
        price: lease.price,
        generation: params.generation,
      });
      ctx.db.updateComponentRuntime(ctx.launchId, key, {
        ssh_host: ssh.host,
        ssh_port: ssh.port,
      });
      return ssh;
    },
  });

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
      if (isValidator) {
        // patch own config's sentry placeholders with CURRENT sentry IPs
        for (const s of topo.validatorSentries[valIndex] ?? []) {
          const sentryIp = componentRow(ctx, `sentry-${s}`).tailnet_ip;
          if (!sentryIp) throw new Error(`sentry-${s} has no recorded tailnet IP`);
          await ctx.services.ssh.exec(
            target,
            `sed -i 's|${placeholder.tailnetIp(`sentry-${s}`)}|${sentryIp}|g' ${NODE_HOME}/config/config.toml`,
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
      const running = await ctx.services.ssh.exec(
        target,
        "pgrep -x sparkdreamd >/dev/null && echo yes || echo no",
      );
      if (running.stdout.trim() !== "yes") {
        await ctx.services.ssh.exec(target, START_NODE_CMD);
      }
      ctx.db.setComponentState(ctx.launchId, key, "active");
      ctx.db.setFleetOpStatus(opId, "done");
      return { started: true };
    },
  });

  return steps;
}

/** Rolling upgrade (§5 "Node upgrades"): serial per component, health-gated. */
export function upgradeSteps(opId: number, params: UpgradeParams, spec: LaunchSpec): StepDef[] {
  const steps: StepDef[] = [];
  const ordered = [...params.components].sort((a, b) => {
    // sentries first, validators last (§5 rolling sequencer)
    const rank = (k: string) => (k.startsWith("val-") ? 1 : 0);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  for (const key of ordered) {
    const p = (s: string) => `op${opId}:${key}:${s}`;

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
        const artifacts = sdlArtifacts(loadSdl(sdlPath));
        fs.writeFileSync(
          path.join(ctx.dirs.sdl, `${key}.manifest.json`),
          artifacts.manifestJson,
        );
        await ctx.requireTx(p("update"), [
          {
            typeUrl: TypeUrl.UpdateDeployment,
            value: {
              id: { owner, dseq: row.dseq },
              hash: Buffer.from(artifacts.hash).toString("base64"),
            },
          },
        ]);
        const cert = loadCert(ctx);
        await ctx.services.provider.sendManifest(
          cert,
          row.host_uri,
          row.dseq,
          fs.readFileSync(path.join(ctx.dirs.sdl, `${key}.manifest.json`), "utf8"),
        );
        ctx.db.updateComponentRuntime(ctx.launchId, key, { image: params.image });
        return { image: params.image };
      },
    });

    steps.push({
      name: p("verify"),
      async run(ctx) {
        const row = componentRow(ctx, key);
        // persistent volume → same tailnet IP, supervised restart (§5): the
        // gate is "node back and progressing" before the next component
        for (let i = 0; i < 60; i++) {
          try {
            const running = await ctx.services.ssh.exec(
              rowTarget(ctx, row),
              "pgrep -x sparkdreamd >/dev/null && echo yes || echo no",
            );
            if (running.stdout.trim() === "yes") {
              if (key.startsWith("sentry-")) {
                const url = await nodeRpcUrl(ctx, row.host_uri, row.dseq);
                const a = await ctx.services.rpc.status(url);
                await ctx.services.sleep(3000);
                const b = await ctx.services.rpc.status(url);
                if (b.latestBlockHeight <= a.latestBlockHeight) throw new Error("height stalled");
              }
              return { healthy: true };
            }
          } catch {
            // provider still restarting the container
          }
          await ctx.services.sleep(5000);
        }
        throw new Error(`${key} did not come back healthy after upgrade`);
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
  _spec: LaunchSpec,
): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const nodeRows = (ctx: StepCtx) =>
    (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).filter(
      (c) => c.state === "active" && c.key !== "headscale",
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

/** Steps for every active op of a launch, in creation order. */
export function buildOpSteps(db: ConductorDb, launchId: string): StepDef[] {
  const launch = db.getLaunch(launchId);
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
  }
  return steps;
}
