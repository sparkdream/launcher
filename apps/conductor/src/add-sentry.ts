import fs from "node:fs";
import path from "node:path";
import { chainId, nodes, resolveTopology, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import type { LaunchDirs, StepDef } from "./engine.js";
import type { ConductorDb } from "./db.js";
import { run, sparkdreamd } from "./exec.js";
import { relaunchSteps, sdlPathFor, withTomlListEntry } from "./fleet-ops.js";
import { renderNodeConfigs } from "./render-configs.js";
import { renderNodeSdl } from "./render-sdl.js";
import { placeholder, type GenerateKeysOutput } from "./steps/phase-a.js";
import { resolveStateSyncTrust } from "./steps/join.js";

/**
 * Add a sentry to a running fleet ("add-sentry" op, robustness plan step 5).
 * The spec already counts it (the request bumped topology.sentries.count),
 * so this does for one node what the launch's Phase A did for all of them,
 * then places it with the relaunch's own steps minus the close:
 *
 * - home: `sparkdreamd init`, its node id merged into generate-keys (every
 *   peer-line writer reads ids from there), the live genesis, its configs;
 *   the other nodes' launcher-side configs gain it too and every touched
 *   bundle is re-packed, so a later relaunch of any of them boots knowing it
 * - render: its SDL, and its fleet row (rows outside the launch plan are
 *   never rebuilt from step outputs, so this one sticks)
 * - deploy → lease → manifest → configure → start → persist (relaunch):
 *   configure appends it to the live peers and restarts them once
 *
 * It syncs the chain from block 1 off its peers, so it reports catching-up
 * for a while after the op ends.
 */

export interface AddSentryParams {
  key: string;
  /** spec.topology.sentries before the request bumped it, put back if the op is
   *  abandoned before the sentry runs (absent on older ops: count - 1). */
  sentriesBefore?: unknown;
  /** The wallet's avoided providers at request time (relaunch takes the same). */
  avoidProviders?: string[];
  /** The operator picks the bid: the lease step parks with every bid. */
  manualBid?: boolean;
}

export function addSentrySteps(opId: number, params: AddSentryParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const { key } = params;
  const node = nodes(spec).find((n) => n.key === key);

  const steps: StepDef[] = [
    {
      name: p("home"),
      async run(ctx) {
        if (!node || node.role !== "sentry") throw new Error(`${key} is not a sentry in the spec`);
        const keys = ctx.output<GenerateKeysOutput>("generate-keys");
        if (!keys) throw new Error("generate-keys output missing");
        const home = ctx.dirs.node(key);
        if (!fs.existsSync(path.join(home, "config", "node_key.json"))) {
          await sparkdreamd([
            "init",
            node.moniker,
            "--chain-id",
            chainId(spec),
            "--default-denom",
            spec.token.bondDenom ?? spec.token.baseDenom,
            "--home",
            home,
          ]);
        }
        const id = (await sparkdreamd(["comet", "show-node-id", "--home", home])).stdout.trim();
        const nodeIds = { ...keys.nodeIds, [key]: id };
        ctx.db.stepDone(ctx.launchId, "generate-keys", { ...keys, nodeIds });
        // the chain's genesis as the fleet runs it (a reset rebuilt it in
        // val-0's home, which stays the authority)
        fs.copyFileSync(
          path.join(ctx.dirs.node("val-0"), "config", "genesis.json"),
          path.join(home, "config", "genesis.json"),
        );
        const stateSync = spec.join ? await resolveStateSyncTrust(ctx) : undefined;
        renderNodeConfigs({
          spec,
          node,
          home,
          nodeIds,
          topology: resolveTopology(spec),
          tailnetIpPlaceholder: placeholder.tailnetIp,
          ...(stateSync ? { join: { peers: spec.join!.peers, stateSync } } : {}),
        });
        // the rest of the fleet, launcher-side: the form render-configs
        // would have written had the sentry been there from the start
        const touched = [key];
        for (const other of nodes(spec)) {
          if (other.key === key) continue;
          const config = path.join(ctx.dirs.node(other.key), "config", "config.toml");
          if (!fs.existsSync(config)) continue;
          let text = fs.readFileSync(config, "utf8");
          const before = text;
          if (other.role === "sentry") {
            text = withTomlListEntry(text, "persistent_peers", `${id}@${placeholder.tailnetIp(key)}:26656`, id);
          }
          text = withTomlListEntry(text, "unconditional_peer_ids", id, id);
          if (text !== before) {
            fs.writeFileSync(config, text);
            touched.push(other.key);
          }
        }
        await packBundles(ctx.dirs, spec, touched);
        return { nodeId: id, repacked: touched };
      },
    },
    {
      name: p("render"),
      async run(ctx) {
        const keys = ctx.output<GenerateKeysOutput>("generate-keys")!;
        renderNodeSdl({
          spec,
          node: node!,
          topology: resolveTopology(spec),
          sshPublicKey: keys.sshPublicKey,
          outPath: sdlPathFor(ctx, key),
          placeholder,
        });
        // shown while it is placed; relaunch's manifest step fills it in
        ctx.db.upsertFleetComponent({
          launch_id: ctx.launchId,
          key,
          dseq: "0",
          provider: "",
          host_uri: "",
          price: "0",
          state: "relaunching",
          image: spec.images.sparkdreamd,
        });
        ctx.db.setComponentState(ctx.launchId, key, "relaunching");
        return {};
      },
    },
  ];
  const avoid = params.avoidProviders?.length ? { avoidProviders: params.avoidProviders } : {};
  const pick = params.manualBid ? { manualBid: true } : {};
  steps.push(...relaunchSteps(opId, { key, generation: 0, ...avoid, ...pick }, spec).filter((s) => s.name !== p("close")));
  return steps;
}

/** package-node-data for some nodes: the same archive, keys excluded the same way. */
async function packBundles(dirs: LaunchDirs, spec: LaunchSpec, keys: string[]): Promise<void> {
  fs.mkdirSync(dirs.bundles, { recursive: true });
  for (const k of keys) {
    const args = ["czf", path.join(dirs.bundles, `${k}.tgz`), "-C", dirs.node(k)];
    if (k.startsWith("val-") && spec.security.keyMode === "tmkms") {
      args.push("--exclude", "config/priv_validator_key.json");
    }
    args.push("--exclude", "config/gentx", "--exclude", "keyring-test", "config", "data");
    await run("tar", args);
  }
}

/** A comma-separated TOML list field without the entries mentioning `id`. */
function withoutTomlListEntry(text: string, field: string, id: string): string {
  const re = new RegExp(`^${field} = "(.*)"$`, "m");
  const m = re.exec(text);
  if (!m || !m[1]!.includes(id)) return text;
  const list = m[1]!.split(",").filter((e) => e && !e.includes(id)).join(",");
  return text.replace(re, `${field} = "${list}"`);
}

/**
 * Undo an add-sentry op abandoned before its sentry ran: the request had
 * already counted it in the spec, and a sentry the spec counts but no
 * deployment backs breaks every later relaunch that wires peers. Puts the
 * spec back, drops its row, node id and launcher-side files, and takes it
 * out of the other nodes' peer lists (bundles re-packed). Does nothing once
 * the sentry is active, or when another sentry was added after it. Returns
 * a note when live nodes may already list it (configure ran): a repair
 * rebuilds their peer lines.
 */
export async function undoAddSentry(
  db: ConductorDb,
  dirs: LaunchDirs,
  launchId: string,
  opId: number,
  params: AddSentryParams,
): Promise<string | undefined> {
  const { key } = params;
  const launch = db.getLaunch(launchId);
  if (!launch) return undefined;
  const row = db.listFleetComponents(launchId).find((c) => c.key === key);
  if (row?.state === "active") return undefined;
  const stored = JSON.parse(launch.spec_json);
  const count = Number(key.split("-")[1]);
  if (withDefaults(stored).topology.sentries.count !== count + 1) return undefined;

  const id = db.stepOutput<{ nodeId: string; repacked?: string[] }>(launchId, `op${opId}:home`);
  const configured = db.getStep(launchId, `op${opId}:configure`)?.status === "done";

  await dropSentrySlot(db, dirs, launchId, key, id?.nodeId, params.sentriesBefore);
  return configured
    ? `${key} was already added to the running nodes' peer lists: run repair to take it out`
    : undefined;
}

/**
 * The launcher-side half of taking sentry `key` (the highest-numbered) out
 * of a fleet: the spec counts one fewer (or goes back to `sentriesBefore`),
 * its size, row and node id go, the other homes' peer lists lose it (bundles
 * re-packed), and its home, bundle and SDL are deleted.
 */
async function dropSentrySlot(
  db: ConductorDb,
  dirs: LaunchDirs,
  launchId: string,
  key: string,
  nodeId: string | undefined,
  sentriesBefore?: unknown,
): Promise<void> {
  const launch = db.getLaunch(launchId)!;
  const stored = JSON.parse(launch.spec_json);
  const count = Number(key.split("-")[1]);
  if (sentriesBefore !== undefined) stored.topology.sentries = sentriesBefore;
  else {
    stored.topology.sentries = { ...stored.topology.sentries, count };
    if (Array.isArray(stored.topology.sentries.mapping)) stored.topology.sentries.mapping = stored.topology.sentries.mapping.slice(0, count);
  }
  if (stored.infra?.nodeSizes?.[key]) {
    const { [key]: _, ...rest } = stored.infra.nodeSizes;
    stored.infra = { ...stored.infra, nodeSizes: rest };
  }
  db.setLaunchSpec(launchId, JSON.stringify(stored));
  db.deleteFleetComponent(launchId, key);

  const keys = db.stepOutput<GenerateKeysOutput>(launchId, "generate-keys");
  if (keys?.nodeIds[key]) {
    const { [key]: _, ...nodeIds } = keys.nodeIds;
    db.stepDone(launchId, "generate-keys", { ...keys, nodeIds });
  }
  if (nodeId) {
    const spec = withDefaults(stored);
    const touched: string[] = [];
    for (const other of nodes(spec)) {
      const config = path.join(dirs.node(other.key), "config", "config.toml");
      if (!fs.existsSync(config)) continue;
      const before = fs.readFileSync(config, "utf8");
      let text = withoutTomlListEntry(before, "persistent_peers", nodeId);
      text = withoutTomlListEntry(text, "unconditional_peer_ids", nodeId);
      if (text !== before) {
        fs.writeFileSync(config, text);
        touched.push(other.key);
      }
    }
    if (touched.length > 0) await packBundles(dirs, spec, touched);
  }
  fs.rmSync(dirs.node(key), { recursive: true, force: true });
  fs.rmSync(path.join(dirs.bundles, `${key}.tgz`), { force: true });
  fs.rmSync(path.join(dirs.sdl, `${key}.yaml`), { force: true });
}

/**
 * The shell edit that drops every entry naming `nodeId` from a running
 * node's persistent_peers and unconditional_peer_ids (busybox awk). It
 * takes effect at the node's next restart; until then it only dials a peer
 * that is gone.
 */
export function withoutPeerCmd(nodeId: string, config = "/root/.sparkdream/config/config.toml"): string {
  if (!/^[0-9a-f]{40}$/.test(nodeId)) throw new Error(`not a node id: ${nodeId}`);
  return (
    `awk -v id=${nodeId} '/^(persistent_peers|unconditional_peer_ids) = "/ { ` +
    `match($0, /"[^"]*"/); v = substr($0, RSTART + 1, RLENGTH - 2); n = split(v, a, ","); out = ""; ` +
    `for (i = 1; i <= n; i++) if (a[i] != "" && index(a[i], id) == 0) out = out (out == "" ? "" : ",") a[i]; ` +
    `$0 = substr($0, 1, RSTART - 1) "\\"" out "\\"" substr($0, RSTART + RLENGTH) } { print }' ` +
    `${config} > ${config}.tmp && mv ${config}.tmp ${config}`
  );
}

/**
 * Take the fleet's highest-numbered sentry out, once it is closed (the
 * fleet card's remove): the spec counts one fewer and its slot goes
 * (dropSentrySlot); the running nodes' peer lists lose it too, which they
 * act on at their next restart. sentry-0 serves the public endpoints and is
 * never removed this way.
 */
export async function removeSentry(
  db: ConductorDb,
  dirs: LaunchDirs,
  launchId: string,
  key: string,
  edit: (row: { key: string }, command: string) => Promise<void>,
): Promise<{ unreachable: string[] }> {
  const launch = db.getLaunch(launchId);
  if (!launch) throw new Error("launch not found");
  const spec = withDefaults(JSON.parse(launch.spec_json));
  const m = /^sentry-(\d+)$/.exec(key);
  if (!m) throw new Error(`${key} is not a sentry`);
  const index = Number(m[1]);
  if (index === 0) throw new Error("sentry-0 serves the public endpoints and is not removed: relaunch it instead");
  if (index !== spec.topology.sentries.count - 1) {
    throw new Error(`only the highest-numbered sentry (sentry-${spec.topology.sentries.count - 1}) can be removed`);
  }
  const rows = db.listFleetComponents(launchId);
  const row = rows.find((c) => c.key === key);
  if (row && row.state !== "closed") throw new Error(`close ${key} first: only a closed sentry can be removed`);
  const nodeId = db.stepOutput<GenerateKeysOutput>(launchId, "generate-keys")?.nodeIds[key];
  await dropSentrySlot(db, dirs, launchId, key, nodeId);
  const unreachable: string[] = [];
  if (nodeId) {
    for (const r of rows) {
      if (r.key === key || r.state !== "active" || !/^(val|sentry)-\d+$/.test(r.key)) continue;
      await edit(r, withoutPeerCmd(nodeId)).catch(() => unreachable.push(r.key));
    }
  }
  return { unreachable };
}
