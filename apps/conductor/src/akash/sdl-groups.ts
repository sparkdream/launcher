import crypto from "node:crypto";
import fs from "node:fs";
import yaml from "js-yaml";

/**
 * SDL → deployment group specs + provider manifest + version hash for our
 * vendored single-service SDLs. Mirrors chain-sdk's generateManifest /
 * manifestToSortedJSON / generateManifestVersion behavior in shape.
 *
 * M2 NOTE (§11): before the first real devnet deployment, diff this output
 * against @akashnetwork/chain-sdk for one of our SDLs — the group/manifest
 * proto-JSON shape must match byte-for-byte where hashed.
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
  manifest: any[];
  /** sha256 over the sorted manifest JSON. */
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
  const manifest: any[] = [];
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
    const manifestServices: any[] = [];

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

      manifestServices.push({
        name: serviceName,
        image: svc.image,
        env: svc.env ?? [],
        count: dep.count,
        resources: resource,
        expose: (svc.expose ?? []).map((e: any) => ({
          port: e.port,
          externalPort: e.as ?? e.port,
          proto: (e.proto ?? "TCP").toUpperCase(),
          global: (e.to ?? []).some((t: any) => t.global),
        })),
        params: svc.params ?? null,
      });
    }

    groups.push({ name: placementName, requirements: { attributes: [], signed_by: { all_of: [], any_of: [] } }, resources: groupResources });
    manifest.push({ name: placementName, services: manifestServices });
  }

  const sorted = sortedJson(manifest);
  const hash = crypto.createHash("sha256").update(sorted).digest();
  return { groups, manifest, hash, requiredStorageClass, pricingDenom };
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
