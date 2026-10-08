import type { ConductorDb, IncidentRow } from "./db.js";

/**
 * Incidents (robustness plan step 3): the monitor's per-component health
 * turned into outages with a start, a cause, a suggested fix and an end.
 *
 * One bad check is a blip (an LCD hiccup, a provider answering slowly), so
 * an incident opens unconfirmed and only becomes an outage after
 * CONFIRM_CHECKS bad checks in a row, about two minutes at the monitor's
 * 45s cadence. Only confirmed incidents are shown and alerted on. A healthy
 * check deletes an unconfirmed one and closes a confirmed one.
 */

export const CONFIRM_CHECKS = 3;

/** Statuses that are not outages: the user closed it, or it is on its way back. */
const NOT_AN_OUTAGE = new Set(["healthy", "closed", "catching-up"]);

/** What the provider looked like when the incident was confirmed. */
/** "ingress-broken": the container runs, but the provider's own hostname for it serves nothing either. */
/** "public-only": the service answers inside its own container; only the way in from outside fails. */
export type ProviderProbe = "unreachable" | "service-down" | "ingress-broken" | "public-only" | "up" | "unknown";

/** Fleet actions an incident can suggest (the UI's fleetAction names). */
export type IncidentAction = "relaunch" | "force-redeploy" | "restart" | "unjail" | "topup" | "repair";

export interface Classified {
  cause: string;
  action: IncidentAction | null;
  severity: "down" | "warn";
}

/**
 * Why a component is unhealthy and what fixes it. The provider probe only
 * matters for "unreachable": the same symptom means a dead provider (move
 * the component), a dead container on a live provider (re-create it), or a
 * live container whose service stopped answering (restart it).
 */
export function classify(key: string, status: string, probe: ProviderProbe): Classified {
  const node = /^(val|sentry)-/.test(key);
  switch (status) {
    case "lease-not-active":
      return {
        cause: "the provider closed the lease (maintenance, decommission, or the escrow ran out)",
        action: "relaunch",
        severity: "down",
      };
    case "low-escrow":
      return { cause: "the escrow runs out within 3 days", action: "topup", severity: "warn" };
    case "stalled":
      return { cause: "the node answers but stopped following the chain", action: "restart", severity: "down" };
    case "jailed":
      return { cause: "the validator was jailed for downtime", action: "unjail", severity: "down" };
    case "low-gas":
      return { cause: "a relayer key is out of funds (top it up from the relayer's funds panel)", action: null, severity: "warn" };
    case "stale-tunnel":
      return {
        cause: "it runs, but a chain it relays does not answer through its mesh tunnel",
        action: "repair",
        severity: "down",
      };
    case "unreachable":
      if (probe === "unreachable") {
        return { cause: "the provider cannot be reached", action: "relaunch", severity: "down" };
      }
      if (probe === "service-down") {
        return {
          cause: "the container is not running, while its provider answers",
          action: "force-redeploy",
          severity: "down",
        };
      }
      if (probe === "public-only") {
        // restarting a service that answers fixes nothing outside it, and for
        // headscale it costs the whole mesh its control plane and relay
        // (2026-10-07: a one-minute provider blip read as a dead headscale)
        return {
          cause: "it answers inside its container, but not at its public address (DNS, Cloudflare or the provider's ingress)",
          action: null,
          severity: "down",
        };
      }
      if (probe === "ingress-broken") {
        return {
          cause: "the container runs, but its provider's ingress serves nothing (not even the provider's own hostname for it)",
          action: "relaunch",
          severity: "down",
        };
      }
      if (probe === "up") {
        return {
          cause: node ? "the container runs but the node does not answer" : "the container runs but its service does not answer",
          action: "restart",
          severity: "down",
        };
      }
      return { cause: "it does not answer, and its provider could not be checked", action: "relaunch", severity: "down" };
    default:
      return { cause: status, action: null, severity: "down" };
  }
}

export interface IncidentEvent {
  kind: "opened" | "resolved";
  incident: IncidentRow;
}

/**
 * Advance one component's incident by one monitor check. `probe` is only
 * called when an incident is about to be confirmed (it costs a provider
 * round trip). Returns the event to alert on, if any.
 */
export async function trackIncident(
  db: ConductorDb,
  launchId: string,
  component: string,
  status: string,
  detail: string | null,
  probe: () => Promise<ProviderProbe>,
  now: () => string = () => new Date().toISOString(),
): Promise<IncidentEvent | undefined> {
  const open = db.openIncident(launchId, component);
  if (NOT_AN_OUTAGE.has(status)) {
    if (!open) return undefined;
    // catching up after a fix is recovery in progress, not recovery
    if (status === "catching-up") return undefined;
    if (!open.confirmed_at) {
      db.deleteIncident(open.id);
      return undefined;
    }
    db.updateIncident(open.id, { closed_at: now() });
    return { kind: "resolved", incident: { ...open, closed_at: now() } };
  }

  if (!open) {
    const c = classify(component, status, "unknown");
    db.insertIncident({ launchId, component, status, detail, cause: c.cause, action: c.action });
    return undefined;
  }
  const checks = open.checks + 1;
  // a lease the chain reports closed is not a blip: one more check suffices
  const needed = status === "lease-not-active" ? 2 : CONFIRM_CHECKS;
  if (!open.confirmed_at && checks >= needed) {
    const c = classify(component, status, status === "unreachable" ? await probe().catch(() => "unknown" as const) : "unknown");
    const confirmed = { status, detail, cause: c.cause, action: c.action, checks, confirmed_at: now() };
    db.updateIncident(open.id, confirmed);
    return { kind: "opened", incident: { ...open, ...confirmed } };
  }
  // still bad: keep the latest reading; a confirmed incident keeps its
  // diagnosis unless the status itself changed
  const fields: Parameters<ConductorDb["updateIncident"]>[1] = { checks, detail };
  if (status !== open.status) {
    const c = classify(component, status, "unknown");
    Object.assign(fields, { status, cause: c.cause, action: c.action });
  }
  db.updateIncident(open.id, fields);
  return undefined;
}

// --- alerts ---

export interface AlertSettings {
  /** ntfy.sh (or a self-hosted ntfy): POST <server>/<topic>. `token`: an ntfy
   *  access token (tk_...) for a server that refuses anonymous posts; stored,
   *  never sent back to the browser (publicAlertSettings). */
  ntfy?: { server: string; topic: string; token?: string };
  /** Where an alert goes when `ntfy` does not take it (the server itself is
   *  down, often the very outage being reported): a second ntfy topic, e.g.
   *  a long random one on ntfy.sh. Never sent the token. */
  ntfyFallback?: { server: string; topic: string };
  /** Any URL that takes a JSON POST. */
  webhook?: string;
}

const ALERTS_SETTING = "alerts";

export function alertSettings(db: ConductorDb): AlertSettings {
  const raw = db.getSetting(ALERTS_SETTING);
  return raw ? (JSON.parse(raw) as AlertSettings) : {};
}

/** What the browser sees: the settings without the ntfy token, and whether one is set. */
export function publicAlertSettings(db: ConductorDb): AlertSettings & { ntfyTokenSet: boolean } {
  const s = alertSettings(db);
  const { token, ...ntfy } = s.ntfy ?? ({} as NonNullable<AlertSettings["ntfy"]>);
  return { ...s, ...(s.ntfy ? { ntfy } : {}), ntfyTokenSet: Boolean(token) };
}

/**
 * Save the alert settings. The ntfy token is write-only: absent keeps the
 * stored one (the browser never holds it), "" removes it.
 */
export function setAlertSettings(db: ConductorDb, settings: AlertSettings): void {
  const clean: AlertSettings = {};
  if (settings.ntfy?.topic?.trim()) {
    const topic = settings.ntfy.topic.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) throw new Error("an ntfy topic is letters, digits, - and _ only");
    const server = (settings.ntfy.server?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(server)) throw new Error("the ntfy server must be an http(s) URL");
    const given = settings.ntfy.token?.trim();
    const token = given === undefined ? alertSettings(db).ntfy?.token : given || undefined;
    if (token && !/^tk_[A-Za-z0-9]{20,64}$/.test(token)) throw new Error("an ntfy access token starts with tk_ (ntfy token add <user>)");
    clean.ntfy = { server, topic, ...(token ? { token } : {}) };
  }
  if (settings.ntfyFallback?.topic?.trim()) {
    const topic = settings.ntfyFallback.topic.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) throw new Error("an ntfy topic is letters, digits, - and _ only");
    const server = (settings.ntfyFallback.server?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(server)) throw new Error("the fallback ntfy server must be an http(s) URL");
    clean.ntfyFallback = { server, topic };
  }
  if (settings.webhook?.trim()) {
    const url = settings.webhook.trim();
    if (!/^https?:\/\//.test(url)) throw new Error("the webhook must be an http(s) URL");
    clean.webhook = url;
  }
  if (Object.keys(clean).length === 0) db.deleteSetting(ALERTS_SETTING);
  else db.setSetting(ALERTS_SETTING, JSON.stringify(clean));
}

export interface Alert {
  fleet: string;
  component: string;
  kind: "opened" | "resolved" | "test" | "auto";
  severity: "down" | "warn";
  title: string;
  message: string;
  action: string | null;
}

/** How a suggested fix reads in an alert. */
const ACTION_TEXT: Record<IncidentAction, string> = {
  relaunch: "relaunch it (moves it to another provider)",
  "force-redeploy": "force redeploy it (re-creates the container in place)",
  restart: "restart it",
  unjail: "unjail it",
  topup: "top up its escrow",
  repair: "repair the fleet (re-aims its tunnels at the current addresses)",
};

export function alertFor(fleet: string, ev: IncidentEvent): Alert {
  const i = ev.incident;
  const severity = classify(i.component, i.status, "unknown").severity;
  if (ev.kind === "resolved") {
    const mins = Math.max(1, Math.round((Date.parse(i.closed_at!) - Date.parse(i.opened_at)) / 60_000));
    return {
      fleet,
      component: i.component,
      kind: "resolved",
      severity,
      title: `${fleet}: ${i.component} is back`,
      message: `${i.component} is healthy again after about ${mins} min (${i.cause}).`,
      action: null,
    };
  }
  return {
    fleet,
    component: i.component,
    kind: "opened",
    severity,
    title: `${fleet}: ${i.component} ${severity === "down" ? "is down" : "needs attention"}`,
    message:
      `${i.component}: ${i.cause}.` +
      (i.action ? ` Suggested fix: ${ACTION_TEXT[i.action as IncidentAction] ?? i.action} (the fix button on the fleet card).` : "") +
      (i.detail ? `\n${i.detail.slice(0, 300)}` : ""),
    action: i.action,
  };
}

/** Deliver one alert to every configured channel; a failing channel never throws. */
export async function sendAlert(
  settings: AlertSettings,
  alert: Alert,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const failures: string[] = [];
  const toNtfy = async (target: { server: string; topic: string; token?: string }): Promise<string | null> => {
    try {
      const res = await fetchImpl(`${target.server}/${target.topic}`, {
        method: "POST",
        body: alert.message,
        headers: {
          ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
          Title: alert.title,
          Priority: alert.kind === "opened" && alert.severity === "down" ? "high" : "default",
          Tags: alert.kind === "resolved" ? "white_check_mark" : alert.severity === "down" ? "rotating_light" : "warning",
        },
      });
      return res.ok ? null : `answered ${res.status}`;
    } catch (e) {
      return String(e instanceof Error ? e.message : e);
    }
  };
  if (settings.ntfy) {
    const failed = await toNtfy(settings.ntfy);
    if (failed) {
      failures.push(`ntfy: ${failed}`);
      if (settings.ntfyFallback) {
        const also = await toNtfy(settings.ntfyFallback);
        failures.push(also ? `fallback ntfy: ${also}` : `sent to the fallback ${settings.ntfyFallback.server}/${settings.ntfyFallback.topic} instead`);
      }
    }
  } else if (settings.ntfyFallback) {
    const failed = await toNtfy(settings.ntfyFallback);
    if (failed) failures.push(`fallback ntfy: ${failed}`);
  }
  if (settings.webhook) {
    try {
      const res = await fetchImpl(settings.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(alert),
      });
      if (!res.ok) failures.push(`webhook answered ${res.status}`);
    } catch (e) {
      failures.push(`webhook: ${String(e instanceof Error ? e.message : e)}`);
    }
  }
  return failures;
}
