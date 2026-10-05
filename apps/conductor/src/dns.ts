import fs from "node:fs";
import path from "node:path";
import { readSecretFile, writeSecretFile } from "./secrets.js";

/**
 * DNS updates after a placement or a move (robustness plan step 6). Every
 * step that pauses with "point <domain> at CNAME <ingress>" first asks this
 * to do it, when the launcher holds a Cloudflare API token (DNS Edit and
 * Zone Read on the zones the fleets use, plus Origin Rules Edit for the
 * sentry's public API/RPC; free plans included). Without one, or for a
 * domain in no zone the token reaches, the pause stays as it was.
 *
 * Every domain is proxied (the zone runs SSL "Flexible": Cloudflare ends
 * TLS, the provider's ingress speaks plain HTTP). A service component's
 * domain reaches its ingress on port 80; the sentry's API and RPC are
 * forwarded ports instead, which an Origin Rule per hostname sends the
 * proxied traffic to (pointOrigin).
 */
export interface DnsUpdater {
  /** Create or update `name` as a CNAME to `target`; false when not configured or no zone holds it. */
  pointCname(name: string, target: string): Promise<boolean>;
  /** pointCname, plus an Origin Rule sending `name`'s traffic to `port` on the
   *  target: false when not configured, no zone holds it, or the token may
   *  not edit origin rules (the CNAME may then be set already). */
  pointOrigin?(name: string, target: string, port: number): Promise<boolean>;
}

const tokenFile = (workRoot: string) => path.join(workRoot, "secrets", "cloudflare-token");

export function cloudflareToken(workRoot: string): string | null {
  const f = tokenFile(workRoot);
  return fs.existsSync(f) ? readSecretFile(f).trim() || null : null;
}

export function setCloudflareToken(workRoot: string, token: string | null): void {
  const f = tokenFile(workRoot);
  if (!token) {
    fs.rmSync(f, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeSecretFile(f, `${token.trim()}\n`);
}

interface DnsRecord {
  id: string;
  type: string;
  name?: string;
  content: string;
  proxied: boolean;
  ttl?: number;
}

/**
 * The one hostname a rule expression matches, when that is all it matches:
 * `http.host eq "h"` or `==`, parenthesised or not, or a one-element
 * `http.host in {"h"}`. Anything else (several hosts, paths, other fields)
 * is undefined: such a rule is the operator's to edit.
 */
export function onlyHost(expression: string): string | undefined {
  let e = expression.trim();
  while (e.startsWith("(") && e.endsWith(")")) e = e.slice(1, -1).trim();
  const m = /^http\.host\s*(?:eq|==)\s*"([^"]+)"$/i.exec(e) ?? /^http\.host\s+in\s*\{\s*"([^"]+)"\s*\}$/i.exec(e);
  return m?.[1]?.toLowerCase();
}

interface OriginRuleset {
  id: string;
  rules?: {
    id: string;
    expression: string;
    description?: string;
    action: string;
    enabled?: boolean;
    action_parameters?: { origin?: { host?: string; port?: number } } & Record<string, unknown>;
  }[];
}

/** Records a CNAME replaces when a component moves. */
const ADDRESS_TYPES = new Set(["A", "AAAA"]);

interface CfResponse<T> {
  success: boolean;
  errors?: { message: string }[];
  result: T;
}

export class CloudflareDns implements DnsUpdater {
  constructor(
    /** read on every call, so a token set or removed in the UI applies at once */
    private readonly token: () => string | null,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly api = "https://api.cloudflare.com/client/v4",
  ) {}

  private async call<T>(token: string, method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.api}${url}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({ success: false }))) as CfResponse<T>;
    if (!res.ok || !json.success) {
      throw new Error(`cloudflare ${method} ${url}: ${json.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`}`);
    }
    return json.result;
  }

  /** The zone holding `name`: the longest suffix the token can see. */
  private async zoneFor(token: string, name: string): Promise<string | null> {
    const labels = name.split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join(".");
      const zones = await this.call<{ id: string }[]>(token, "GET", `/zones?name=${encodeURIComponent(candidate)}`);
      if (zones[0]) return zones[0].id;
    }
    return null;
  }

  async pointCname(name: string, target: string): Promise<boolean> {
    const token = this.token();
    if (!token) return false;
    const zone = await this.zoneFor(token, name);
    if (!zone) return false;
    const existing = await this.call<DnsRecord[]>(token, "GET", `/zones/${zone}/dns_records?name=${encodeURIComponent(name)}`);
    const cname = existing.find((r) => r.type === "CNAME");
    if (cname?.content === target) return true;
    // a name holds a CNAME or other records, never both. Address records
    // (an A to an old ingress) are what a move replaces; anything else on
    // the name (MX, TXT, CAA...) is someone's, so the operator decides
    if (existing.some((r) => !ADDRESS_TYPES.has(r.type) && r.type !== "CNAME")) return false;
    // keep the old record's proxy setting; a new one is proxied, as every
    // fleet domain is (SSL Flexible: the ingress serves plain HTTP)
    const body = { type: "CNAME", name, content: target, proxied: (cname ?? existing[0])?.proxied ?? true, ttl: 1 };
    if (cname) {
      await this.call(token, "PUT", `/zones/${zone}/dns_records/${cname.id}`, body);
      return true;
    }
    const replaced = existing.filter((r) => ADDRESS_TYPES.has(r.type));
    for (const r of replaced) await this.call(token, "DELETE", `/zones/${zone}/dns_records/${r.id}`);
    try {
      await this.call(token, "POST", `/zones/${zone}/dns_records`, body);
    } catch (e) {
      // never leave the name with no record at all: put the old ones back
      for (const r of replaced) {
        await this.call(token, "POST", `/zones/${zone}/dns_records`, {
          type: r.type,
          name: r.name ?? name,
          content: r.content,
          proxied: r.proxied,
          ttl: r.ttl ?? 1,
        }).catch(() => undefined);
      }
      throw e;
    }
    return true;
  }

  async pointOrigin(name: string, target: string, port: number): Promise<boolean> {
    const token = this.token();
    if (!token) return false;
    const zone = await this.zoneFor(token, name);
    if (!zone) return false;
    if (!(await this.pointCname(name, target))) return false;
    return this.setOriginPort(token, zone, name, port);
  }

  /**
   * The zone's Origin Rule for `name` sends it to `port`: an existing rule
   * on exactly this hostname (one the operator made by hand included) gets
   * the port, else a rule of the launcher's own is added. A rule on a wider
   * expression that mentions the host is the operator's: left alone (false).
   */
  private async setOriginPort(token: string, zone: string, name: string, port: number): Promise<boolean> {
    const phase = `/zones/${zone}/rulesets/phases/http_request_origin/entrypoint`;
    let ruleset: OriginRuleset | null;
    try {
      ruleset = await this.call<OriginRuleset>(token, "GET", phase);
    } catch (e) {
      // no origin ruleset yet is a 404; anything else (no permission) is a refusal
      if (!/HTTP 404|could not find|not found/i.test(String(e))) return false;
      ruleset = null;
    }
    const rules = ruleset?.rules ?? [];
    const mine = rules.find((r) => r.action === "route" && onlyHost(r.expression) === name.toLowerCase());
    const wider = rules.find((r) => r !== mine && r.expression.toLowerCase().includes(`"${name.toLowerCase()}"`));
    if (!mine && wider) return false;
    const rule = {
      expression: mine?.expression ?? `(http.host eq "${name}")`,
      description: mine?.description ?? `sparkdream-launcher: ${name}`,
      action: "route",
      action_parameters: { ...(mine?.action_parameters ?? {}), origin: { ...(mine?.action_parameters?.origin ?? {}), port } },
      enabled: true,
    };
    if (mine && mine.action_parameters?.origin?.port === port && mine.enabled !== false) return true;
    if (!ruleset) {
      await this.call(token, "PUT", phase, { rules: [rule] });
    } else if (mine) {
      await this.call(token, "PATCH", `/zones/${zone}/rulesets/${ruleset.id}/rules/${mine.id}`, rule);
    } else {
      await this.call(token, "POST", `/zones/${zone}/rulesets/${ruleset.id}/rules`, rule);
    }
    return true;
  }

  /**
   * Whether the token can do what pointCname needs, checked the same way:
   * list the zones it sees (Zone Read), then read one zone's records (DNS).
   * Works for account-owned tokens too, which /user/tokens/verify rejects.
   * Edit cannot be proven without writing; a token without it fails at the
   * first move, and that step pauses as without a token.
   */
  async check(token: string): Promise<{ ok: true; zones: string[]; originRules: boolean } | { ok: false; reason: string }> {
    let zones: { id: string; name: string }[];
    try {
      zones = await this.call<{ id: string; name: string }[]>(token, "GET", "/zones?per_page=50");
    } catch (e) {
      return { ok: false, reason: `Cloudflare refused the token: ${String(e instanceof Error ? e.message : e).replace(/^cloudflare GET \S+: /, "")}` };
    }
    if (zones.length === 0) {
      return { ok: false, reason: "the token works but sees no zone: give it Zone Read (and DNS Edit) on the zones your fleets use" };
    }
    try {
      await this.call(token, "GET", `/zones/${zones[0]!.id}/dns_records?per_page=1`);
    } catch (e) {
      return {
        ok: false,
        reason: `the token sees ${zones[0]!.name} but cannot read its DNS records: give it DNS Edit (${String(e instanceof Error ? e.message : e).replace(/^cloudflare GET \S+: /, "")})`,
      };
    }
    // origin rules (the sentry's API/RPC ports): readable means editable for
    // a token made with Origin Rules Edit; missing only costs that automation
    const originRules = await this.call(token, "GET", `/zones/${zones[0]!.id}/rulesets/phases/http_request_origin/entrypoint`)
      .then(() => true)
      .catch((e) => /HTTP 404|could not find|not found/i.test(String(e)));
    return { ok: true, zones: zones.map((z) => z.name), originRules };
  }
}
