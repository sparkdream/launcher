import path from "node:path";
import {
  isServicesFleet,
  nodeResources,
  nodes,
  nodeSize,
  serviceComponents,
  type ComponentKey,
  type LaunchSpec,
  type RoleResources,
} from "@sparkdream/launch-spec";
import { loadSdl } from "./akash/sdl-groups.js";
import { feeConfig } from "./fee.js";
import { descriptor } from "./components/index.js";
import { vendorDir } from "./vendor.js";

/**
 * Pre-launch running-cost estimate (design §11 M2 "estimate-costs") as a
 * LOW–HIGH range, computed from the stock provider bid script's USD targets
 * (provider-services price_script_generic.sh) — the reference most providers
 * bid from:
 *
 *   HIGH = the stock rates verbatim (a default-configured provider's bid).
 *   LOW  = half of that — competitive providers undercut the stock script,
 *          and the policy engine picks the cheapest acceptable bid. On the
 *          first real mainnet fleet (2026-07) every winning bid landed at
 *          0.53–0.58× the stock rate, so 0.5 tracks the observed floor.
 *
 * ACT is USD-pegged 1:1, so these read directly as $/month. Deposits are
 * separate (refundable escrow, 5 ACT per deployment).
 */

/** Stock bid-script targets: USD per unit-month. */
const RATE = {
  cpuThread: 1.6,
  memoryGb: 0.8,
  ephemeralGb: 0.02,
  persistentGb: { beta1: 0.01, beta2: 0.03, beta3: 0.04 } as Record<string, number>,
};
const COMPETITIVE_BID_FACTOR = 0.5;

export interface CostEstimate {
  /** Per single deployment of the role, USD/month. */
  perRole: Array<{ role: string; count: number; unitLowUsd: number; unitHighUsd: number }>;
  totalLowUsd: number;
  totalHighUsd: number;
  /** One-time launch service fee (feeBps of the leased monthly rate);
   *  bps 0 = disabled, and the fee fields read 0. */
  feeBps: number;
  feeLowUsd: number;
  feeHighUsd: number;
}

export function sizeToBytes(size: string): number {
  const m = /^([0-9]+)([MGT]i)$/.exec(size);
  if (!m) throw new Error(`unparseable size "${size}"`);
  const mult = { Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 }[m[2] as "Mi" | "Gi" | "Ti"];
  return Number(m[1]) * mult;
}

const toGb = (bytes: number) => bytes / 2 ** 30;
const cents = (usd: number) => Math.round(usd * 100) / 100;

interface Workload {
  cpuThreads: number;
  memoryBytes: number;
  ephemeralBytes: number;
  /** storage class → bytes. */
  persistentBytes: Record<string, number>;
}

function monthlyUsd(w: Workload): number {
  let usd =
    w.cpuThreads * RATE.cpuThread +
    toGb(w.memoryBytes) * RATE.memoryGb +
    toGb(w.ephemeralBytes) * RATE.ephemeralGb;
  for (const [cls, bytes] of Object.entries(w.persistentBytes)) {
    usd += toGb(bytes) * (RATE.persistentGb[cls] ?? RATE.persistentGb.beta3!);
  }
  return usd;
}

/** SDL-shaped compute resources → workload (splits volumes by persistence). */
function sdlResourcesToWorkload(res: any): Workload {
  const storage = Array.isArray(res.storage) ? res.storage : [res.storage];
  const w: Workload = {
    cpuThreads: Number(res.cpu.units),
    memoryBytes: sizeToBytes(res.memory.size),
    ephemeralBytes: 0,
    persistentBytes: {},
  };
  for (const s of storage) {
    const bytes = sizeToBytes(s.size);
    if (s.attributes?.persistent) {
      const cls = s.attributes.class ?? "beta3";
      w.persistentBytes[cls] = (w.persistentBytes[cls] ?? 0) + bytes;
    } else {
      w.ephemeralBytes += bytes;
    }
  }
  return w;
}

/**
 * One row per role, or per role and size once infra.nodeSizes gives some of
 * a role's nodes another tier ("sentries (large)").
 */
function nodeRoles(
  spec: LaunchSpec,
  workload: (r: RoleResources) => Workload,
): Array<{ role: string; count: number; workloads: Workload[] }> {
  const rows: Array<{ role: string; size: string; res: RoleResources; count: number }> = [];
  for (const node of nodes(spec)) {
    const res = nodeResources(spec, node.key);
    const same = rows.find((r) => r.role === node.role && JSON.stringify(r.res) === JSON.stringify(res));
    if (same) same.count++;
    else rows.push({ role: node.role, size: nodeSize(spec, node.key), res, count: 1 });
  }
  const plural = (role: string) => (role === "validator" ? "validators" : "sentries");
  return rows.map((r) => ({
    role: rows.filter((o) => o.role === r.role).length > 1 ? `${plural(r.role)} (${r.size})` : plural(r.role),
    count: r.count,
    workloads: [workload(r.res)],
  }));
}

export function estimateLaunchCost(spec: LaunchSpec): CostEstimate {
  const nodeWorkload = (r: RoleResources): Workload => ({
    cpuThreads: r.cpu,
    memoryBytes: sizeToBytes(r.memory),
    ephemeralBytes: sizeToBytes(r.storage.root),
    persistentBytes: r.storage.persistent
      ? { [r.storage.class]: sizeToBytes(r.storage.data) }
      : {},
  });
  // headscale's resources come from the vendored SDL it deploys with; its
  // ephemeral data volume when not persistent is already covered by the split
  const headscale = loadSdl(path.join(vendorDir(), "mesh", "headscale.sdl.yaml"));
  const headscaleWorkloads = Object.values(headscale.profiles.compute).map((p: any) =>
    sdlResourcesToWorkload(p.resources),
  );

  // a services fleet deploys its components and nothing else
  const services = isServicesFleet(spec);
  const roles: Array<{ role: string; count: number; workloads: Workload[] }> = services
    ? serviceComponents(spec).map((c) => ({
        role: c.key,
        count: 1,
        workloads: descriptor(c.key).resources(spec).map(sdlResourcesToWorkload),
      }))
    : [
    ...nodeRoles(spec, nodeWorkload),
    // a shared mesh (reuseFleet) is deployed and paid for by its owning fleet
    ...(spec.topology.headscale.reuseFleet
      ? []
      : [{ role: "headscale", count: 1, workloads: headscaleWorkloads }]),
    ...serviceComponents(spec).map((c) => ({
      role: c.key,
      count: 1,
      workloads: descriptor(c.key).resources(spec).map(sdlResourcesToWorkload),
    })),
  ];

  const perRole: CostEstimate["perRole"] = [];
  let totalHigh = 0;
  for (const r of roles) {
    const high = r.workloads.reduce((sum, w) => sum + monthlyUsd(w), 0);
    perRole.push({
      role: r.role,
      count: r.count,
      unitLowUsd: cents(high * COMPETITIVE_BID_FACTOR),
      unitHighUsd: cents(high),
    });
    totalHigh += high * r.count;
  }
  const fee = feeConfig();
  return {
    perRole,
    totalLowUsd: cents(totalHigh * COMPETITIVE_BID_FACTOR),
    totalHighUsd: cents(totalHigh),
    feeBps: fee.launchBps,
    feeLowUsd: cents(totalHigh * COMPETITIVE_BID_FACTOR * (fee.launchBps / 10_000)),
    feeHighUsd: cents(totalHigh * (fee.launchBps / 10_000)),
  };
}

/** One node at `r` resources, USD/month: the competitive bid and the stock-script ceiling. */
export function estimateNode(r: RoleResources): { lowUsd: number; highUsd: number } {
  const high = monthlyUsd({
    cpuThreads: r.cpu,
    memoryBytes: sizeToBytes(r.memory),
    ephemeralBytes: sizeToBytes(r.storage.root),
    persistentBytes: r.storage.persistent ? { [r.storage.class]: sizeToBytes(r.storage.data) } : {},
  });
  return { lowUsd: cents(high * COMPETITIVE_BID_FACTOR), highUsd: cents(high) };
}

/** One service component as `spec` would deploy it, USD/month; undefined when its resources need settings it lacks. */
export function estimateComponent(spec: LaunchSpec, key: ComponentKey): { lowUsd: number; highUsd: number } | undefined {
  try {
    const high = descriptor(key).resources(spec).map(sdlResourcesToWorkload).reduce((sum, w) => sum + monthlyUsd(w), 0);
    return { lowUsd: cents(high * COMPETITIVE_BID_FACTOR), highUsd: cents(high) };
  } catch {
    return undefined;
  }
}
