import path from "node:path";
import { statelessComponents, type LaunchSpec } from "@sparkdream/launch-spec";
import { loadSdl } from "./akash/sdl-groups.js";
import { feeConfig } from "./fee.js";
import { componentResources } from "./render-component-sdl.js";
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

export function estimateLaunchCost(spec: LaunchSpec): CostEstimate {
  const nodeWorkload = (r: LaunchSpec["infra"]["resources"]["validator"]): Workload => ({
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

  const roles: Array<{ role: string; count: number; workloads: Workload[] }> = [
    {
      role: "validators",
      count: spec.topology.validators.count,
      workloads: [nodeWorkload(spec.infra.resources.validator)],
    },
    ...(spec.topology.sentries.count > 0
      ? [
          {
            role: "sentries",
            count: spec.topology.sentries.count,
            workloads: [nodeWorkload(spec.infra.resources.sentry)],
          },
        ]
      : []),
    // a shared mesh (reuseFleet) is deployed and paid for by its owning fleet
    ...(spec.topology.headscale.reuseFleet
      ? []
      : [{ role: "headscale", count: 1, workloads: headscaleWorkloads }]),
    ...statelessComponents(spec).map((c) => ({
      role: c.key,
      count: 1,
      workloads: [sdlResourcesToWorkload(componentResources(c.key))],
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
