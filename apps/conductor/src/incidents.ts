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
export type ProviderProbe = "unreachable" | "service-down" | "up" | "unknown";

/** Fleet actions an incident can suggest (the UI's fleetAction names). */
export type IncidentAction = "relaunch" | "force-redeploy" | "restart" | "unjail" | "topup";

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
  /** ntfy.sh (or a self-hosted ntfy): POST <server>/<topic>. */
  ntfy?: { server: string; topic: string };
  /** Any URL that takes a JSON POST. */
  webhook?: string;
}

const ALERTS_SETTING = "alerts";

export function alertSettings(db: ConductorDb): AlertSettings {
  const raw = db.getSetting(ALERTS_SETTING);
  return raw ? (JSON.parse(raw) as AlertSettings) : {};
}

export function setAlertSettings(db: ConductorDb, settings: AlertSettings): void {
  const clean: AlertSettings = {};
  if (settings.ntfy?.topic?.trim()) {
    const topic = settings.ntfy.topic.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) throw new Error("an ntfy topic is letters, digits, - and _ only");
    const server = (settings.ntfy.server?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(server)) throw new Error("the ntfy server must be an http(s) URL");
    clean.ntfy = { server, topic };
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
  if (settings.ntfy) {
    try {
      const res = await fetchImpl(`${settings.ntfy.server}/${settings.ntfy.topic}`, {
        method: "POST",
        body: alert.message,
        headers: {
          Title: alert.title,
          Priority: alert.kind === "opened" && alert.severity === "down" ? "high" : "default",
          Tags: alert.kind === "resolved" ? "white_check_mark" : alert.severity === "down" ? "rotating_light" : "warning",
        },
      });
      if (!res.ok) failures.push(`ntfy answered ${res.status}`);
    } catch (e) {
      failures.push(`ntfy: ${String(e instanceof Error ? e.message : e)}`);
    }
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
