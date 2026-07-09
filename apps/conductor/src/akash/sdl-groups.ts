import crypto from "node:crypto";
import fs from "node:fs";
import yaml from "js-yaml";
import { generateManifest, manifestToSortedJSON } from "@akashnetwork/chain-sdk";

/**
 * SDL → deployment group specs + provider manifest + version hash for our
 * vendored single-service SDLs.
 *
 * The MANIFEST and its VERSION HASH come straight from chain-sdk (the
 * reference implementation console-air uses): providers recompute the
 * version from the manifest they receive and 422 on any canonicalization
 * drift (storage param shape, expose order, field names, HTML escaping…) —
 * hand-mirroring it proved untenable. The GROUP SPECS for
 * MsgCreateDeployment stay hand-built below (proto-JSON for our stored-msg
 * pipeline, proven on-chain).
 */

type Sdl = {
  services: Record<string, any>;
  profiles: {
    compute: Record<string, { resources: any }>;
    placement: Record<string, { pricing: Record<string, { denom: string; amount: number }> }>;
  };
  deployment: Record<string, Record<string, { profile: string; count: number }>>;
};

export interface SdlArtifacts {
  groups: any[];
  /** Canonical manifest (parsed from chain-sdk's manifestToSortedJSON). */
  manifest: any[];
  /** The canonical manifest JSON string — hashed AND sent to providers
   *  verbatim (console-air PUTs these exact bytes). */
  manifestJson: string;
  /** Manifest version: sha256 over the canonical manifest JSON — what the
   *  provider recomputes and checks against the on-chain deployment. */
  hash: Uint8Array;
  /** First persistent storage class required, if any. */
  requiredStorageClass?: string | undefined;
  pricingDenom: string;
}

export function loadSdl(path: string): Sdl {
  return yaml.load(fs.readFileSync(path, "utf8")) as Sdl;
}

export function sdlArtifacts(sdl: Sdl): SdlArtifacts {
  const groups: any[] = [];
  let requiredStorageClass: string | undefined;
  let pricingDenom = "uakt";

  // SDL deployment section is deployment.<service>.<placement>; group by placement.
  const byPlacement = new Map<string, Array<{ serviceName: string; dep: { profile: string; count: number } }>>();
  for (const [serviceName, placements] of Object.entries(sdl.deployment)) {
    for (const [placementName, dep] of Object.entries(placements)) {
      if (!byPlacement.has(placementName)) byPlacement.set(placementName, []);
      byPlacement.get(placementName)!.push({ serviceName, dep });
    }
  }

  for (const [placementName, entries] of byPlacement) {
    const placement = sdl.profiles.placement[placementName];
    if (!placement) throw new Error(`SDL: placement profile ${placementName} missing`);

    const groupResources: any[] = [];

    for (const { serviceName, dep } of entries) {
      const svc = sdl.services[serviceName];
      const compute = sdl.profiles.compute[dep.profile]?.resources;
      if (!svc || !compute) throw new Error(`SDL: service/profile ${serviceName} incomplete`);
      const pricing = placement.pricing[dep.profile];
      if (pricing) pricingDenom = pricing.denom;

      const storage = (Array.isArray(compute.storage) ? compute.storage : [compute.storage]).map(
        (s: any) => {
          if (s.attributes?.persistent) requiredStorageClass = String(s.attributes.class);
          return {
            name: s.name ?? "default",
            quantity: { val: sizeToBytes(s.size) },
            ...(s.attributes
              ? {
                  attributes: Object.entries(s.attributes)
                    .map(([key, value]) => ({ key, value: String(value) }))
                    .sort((a, b) => a.key.localeCompare(b.key)),
                }
              : {}),
          };
        },
      );

      const resource = {
        id: groupResources.length + 1,
        cpu: { units: { val: String(Math.round(Number(compute.cpu.units) * 1000)) } },
        memory: { quantity: { val: sizeToBytes(compute.memory.size) } },
        storage,
        gpu: { units: { val: "0" } },
        // endpoint kind: 0 = SHARED_HTTP (port 80), 1 = RANDOM_PORT (any other tcp)
        endpoints: (svc.expose ?? [])
          .filter((e: any) => (e.to ?? []).some((t: any) => t.global))
          .map((e: any, i: number) => ({
            kind: (e.as ?? e.port) === 80 ? 0 : 1,
            sequence_number: i,
          })),
      };

      groupResources.push({
        resource,
        count: dep.count,
        price: pricing ? { denom: pricing.denom, amount: String(pricing.amount) } : undefined,
      });

    }

    groups.push({ name: placementName, requirements: { attributes: [], signed_by: { all_of: [], any_of: [] } }, resources: groupResources });
  }

  // manifest + version from the reference implementation (see module doc)
  const generated = generateManifest(sdl as any);
  if (!generated.ok) {
    throw new Error(`SDL rejected by chain-sdk: ${JSON.stringify(generated.value)}`);
  }
  const canonical = manifestToSortedJSON(generated.value.groups);
  const hash = crypto.createHash("sha256").update(canonical).digest();
  const manifest = JSON.parse(canonical);
  return { groups, manifest, manifestJson: canonical, hash, requiredStorageClass, pricingDenom };
}

function sizeToBytes(size: string): string {
  const m = /^([0-9]+)([KMGT]i)$/.exec(size);
  if (!m) throw new Error(`bad size ${size}`);
  const mult = { Ki: 1024n, Mi: 1024n ** 2n, Gi: 1024n ** 3n, Ti: 1024n ** 4n }[m[2] as string]!;
  return (BigInt(m[1]!) * mult).toString();
}

/** Deterministic JSON: object keys sorted recursively. */
export function sortedJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => [k, sortValue(val)]),
    );
  }
  return v;
}
