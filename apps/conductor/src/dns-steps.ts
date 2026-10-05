import type { StepCtx } from "./engine.js";
import { extractForwardedPort } from "./steps/phase-bcd.js";

/**
 * The DNS work a step does before it pauses for a person (dns.ts): service
 * domains get a CNAME to their ingress, the sentry's public API and RPC a
 * CNAME to the provider's host plus an Origin Rule for their forwarded port.
 * Each returns the domains it set, none without a token; a failure is only
 * logged, since the step's own pause with the records to set still follows.
 */

/** Point domains at their new ingress through the launcher's DNS token. */
export async function pointDns(ctx: StepCtx, records: { domain: string; target: string }[]): Promise<string[]> {
  const dns = ctx.services.dns;
  if (!dns) return [];
  const done: string[] = [];
  for (const r of records) {
    try {
      if (await dns.pointCname(r.domain, r.target)) done.push(r.domain);
    } catch (e) {
      ctx.log(`DNS update for ${r.domain} failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
    }
  }
  if (done.length > 0) ctx.log(`DNS pointed through Cloudflare: ${records.filter((r) => done.includes(r.domain)).map((r) => `${r.domain} → ${r.target}`).join(", ")}`);
  return done;
}

/** A sentry public endpoint as Cloudflare must route it: CNAME `target`, Origin Rule `port`. */
export interface OriginRecord {
  domain: string;
  target: string;
  port: number;
}

/** The container port behind each of the sentry's public endpoints. */
export const PUBLIC_ENDPOINT_PORTS = { API: 1317, RPC: 26657 } as const;

/** Where each public endpoint domain is served now, from sentry-0's lease status. */
export function publicEndpointRecords(status: unknown, domains: { name: string; domain: string }[]): OriginRecord[] {
  const out: OriginRecord[] = [];
  for (const d of domains) {
    try {
      const fp = extractForwardedPort(status, PUBLIC_ENDPOINT_PORTS[d.name as keyof typeof PUBLIC_ENDPOINT_PORTS] ?? 26657);
      out.push({ domain: d.domain, target: fp.host, port: fp.port });
    } catch {
      // no forwarded port in the status (yet): nothing to point; the step's
      // own pause says the domain is dark
    }
  }
  return out;
}

/** Point the sentry's public endpoints: CNAME and Origin Rule each. */
export async function pointOrigins(ctx: StepCtx, records: OriginRecord[]): Promise<string[]> {
  const dns = ctx.services.dns;
  if (!dns?.pointOrigin) return [];
  const done: string[] = [];
  for (const r of records) {
    try {
      if (await dns.pointOrigin(r.domain, r.target, r.port)) done.push(r.domain);
      else ctx.log(`DNS for ${r.domain} not automated: the token reaches no zone for it, may not edit origin rules, or a wider rule of yours covers it`);
    } catch (e) {
      ctx.log(`DNS update for ${r.domain} failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
    }
  }
  if (done.length > 0) {
    ctx.log(
      `DNS and origin rules set through Cloudflare: ${records
        .filter((r) => done.includes(r.domain))
        .map((r) => `${r.domain} → ${r.target}:${r.port}`)
        .join(", ")}`,
    );
  }
  return done;
}

/** What a person sets for an endpoint the token could not. */
export function originInstruction(r: OriginRecord): string {
  return `${r.domain} → CNAME ${r.target} with an Origin Rule (hostname equals ${r.domain}) rewriting the destination port to ${r.port}`;
}
