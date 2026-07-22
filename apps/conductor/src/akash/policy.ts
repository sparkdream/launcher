import type { LaunchSpec } from "@sparkdream/launch-spec";

/** LCD bid shape (snake_case per API conventions). */
export interface Bid {
  bid: {
    id: {
      owner: string;
      dseq: string;
      gseq: number;
      oseq: number;
      provider: string;
    };
    state: string;
    price: { denom: string; amount: string };
    /** What the provider offers for this order — storage carries class attributes. */
    resources_offer?: Array<{
      resources?: {
        storage?: Array<{ attributes?: Array<{ key: string; value: string }> }>;
      };
    }>;
  };
}

/** The bid itself is the authoritative storage signal: a provider that bid
 *  on an order requiring a class echoes it in resources_offer. */
function bidOffersStorageClass(b: Bid, cls: string): boolean {
  return (b.bid.resources_offer ?? []).some((o) =>
    (o.resources?.storage ?? []).some((s) =>
      (s.attributes ?? []).some((a) => a.key === "class" && a.value === cls),
    ),
  );
}

/** Enriched provider metadata from the Console public API. */
export interface ProviderInfo {
  owner: string;
  hostUri: string;
  isAudited: boolean;
  uptime7d: number;
  /** Storage classes offered (from provider attributes, e.g. "beta3"). */
  storageClasses: string[];
}

export interface Rejection {
  provider: string;
  reason: string;
}

export interface PolicyDecision {
  chosen: Bid | null;
  rejected: Rejection[];
}

export interface PolicyContext {
  policy: LaunchSpec["providers"]["policy"];
  /** Providers already chosen this launch (anti-affinity, §6.1). */
  chosenProviders: ReadonlySet<string>;
  /**
   * Hard exclusions regardless of anti-affinity mode: the wallet-wide avoid
   * list, plus the provider a relaunch is moving off of.
   */
  avoidProviders?: ReadonlySet<string>;
  /**
   * Spec-declared exclusions (fleet-wide + this pick's component group):
   * hard filter, matched on owner address or hostname fragment. Unlike
   * anti-affinity these are never relaxed.
   */
  excludeMatchers?: ExclusionEntry[];
  /** Selection-time log for exclusion matches; steps pass StepCtx.log. */
  log?: (message: string) => void;
  /** Persistent storage class the deployment needs, if any. */
  requiredStorageClass?: string | undefined;
  providers: Map<string, ProviderInfo>;
}

/** A spec exclusion entry plus the list it came from (for logs/reasons). */
export interface ExclusionEntry {
  /** Raw spec entry: an akash1 owner address or a hostname fragment. */
  entry: string;
  /** "fleet" for providers.exclude, else the component group name. */
  source: string;
}

/**
 * Effective exclusions for a component key: the fleet-wide list plus the
 * key's component group. val-N -> validators, sentry-N -> sentries, every
 * other key (headscale, explorer, frontend, hub) maps to itself.
 * Null-tolerant: resumed launches replay the stored spec JSON without a
 * schema re-parse, so specs written before this feature arrive with
 * providers.exclude / providers.components undefined at runtime.
 */
export function exclusionEntries(spec: LaunchSpec, key: string): ExclusionEntry[] {
  const out: ExclusionEntry[] = (spec.providers.exclude ?? []).map((entry) => ({
    entry,
    source: "fleet",
  }));
  const group = /^val-\d+$/.test(key) ? "validators" : /^sentry-\d+$/.test(key) ? "sentries" : key;
  const own = (
    spec.providers.components as
      | Record<string, { exclude?: string[] } | undefined>
      | undefined
  )?.[group];
  for (const entry of own?.exclude ?? []) out.push({ entry, source: group });
  return out;
}

/**
 * Address entries (akash1...) match the provider owner exactly; anything
 * else is a case-insensitive substring of the provider's hostname, parsed
 * from hostUri (never the raw URI, whose scheme would false-match "https").
 */
export function matchesExclusion(entry: string, info: ProviderInfo): boolean {
  if (entry.startsWith("akash1")) return info.owner === entry;
  let host: string;
  try {
    host = new URL(info.hostUri).hostname;
  } catch {
    host = info.hostUri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  }
  return host.toLowerCase().includes(entry.toLowerCase());
}

/**
 * Provider selection (§6): hard filters → preference list → lowest price.
 * Every rejection carries a reason for the UI's explainability table.
 */
export function selectProvider(bids: Bid[], ctx: PolicyContext): PolicyDecision {
  const rejected: Rejection[] = [];
  const open = bids.filter((b) => b.bid.state === "open");

  const prices = open.map((b) => Number(b.bid.price.amount)).sort((a, b) => a - b);
  const median =
    prices.length === 0
      ? 0
      : prices.length % 2
        ? prices[(prices.length - 1) / 2]!
        : (prices[prices.length / 2 - 1]! + prices[prices.length / 2]!) / 2;

  const survivors = open.filter((b) => {
    const provider = b.bid.id.provider;
    const info = ctx.providers.get(provider);
    const reject = (reason: string) => {
      rejected.push({ provider, reason });
      return false;
    };

    if (!info) return reject("unknown provider (not in Console API list)");
    const excluded = ctx.excludeMatchers?.find((m) => matchesExclusion(m.entry, info));
    if (excluded) {
      ctx.log?.(
        `${provider} (${info.hostUri}) matched spec exclusion "${excluded.entry}" ` +
          `(${excluded.source} list); not eligible for this pick`,
      );
      return reject(`excluded by spec (${excluded.source}): ${excluded.entry}`);
    }
    if (ctx.avoidProviders?.has(provider)) return reject("on the avoid list");
    if (ctx.policy.auditedOnly && !info.isAudited) return reject("not audited");
    if (info.uptime7d < ctx.policy.minUptime7d) {
      return reject(`uptime ${info.uptime7d} below floor ${ctx.policy.minUptime7d}`);
    }
    if (
      median > 0 &&
      Number(b.bid.price.amount) > ctx.policy.maxPriceMultiplier * median
    ) {
      return reject(`price ${b.bid.price.amount} above ${ctx.policy.maxPriceMultiplier}x median`);
    }
    if (ctx.policy.antiAffinity === "strict" && ctx.chosenProviders.has(provider)) {
      return reject("anti-affinity: provider already used in this launch");
    }
    if (
      ctx.requiredStorageClass &&
      !bidOffersStorageClass(b, ctx.requiredStorageClass) &&
      !info.storageClasses.includes(ctx.requiredStorageClass)
    ) {
      return reject(`no ${ctx.requiredStorageClass} persistent storage`);
    }
    return true;
  });

  if (survivors.length === 0) return { chosen: null, rejected };

  // Preference list: order beats price (§6.2)
  for (const preferred of ctx.policy.preference) {
    const hit = survivors.find((b) => b.bid.id.provider === preferred);
    if (hit) return { chosen: hit, rejected };
  }

  // preferSpread: soft anti-affinity — prefer unused providers, fall back if none
  let pool = survivors;
  if (ctx.policy.antiAffinity === "preferSpread") {
    const fresh = survivors.filter((b) => !ctx.chosenProviders.has(b.bid.id.provider));
    if (fresh.length > 0) pool = fresh;
  }

  pool = [...pool].sort((a, b) => Number(a.bid.price.amount) - Number(b.bid.price.amount));
  return { chosen: pool[0]!, rejected };
}
