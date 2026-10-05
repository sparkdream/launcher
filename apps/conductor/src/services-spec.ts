import type { LaunchSpec } from "@sparkdream/launch-spec";
import { readMastodonSecrets } from "./components/mastodon-secrets.js";
import type { ConductorDb } from "./db.js";
import { launchDirs } from "./engine.js";
import { mayUseFleet } from "./bridge-target.js";

/** What a services fleet's Mastodon needs, however it is drafted. */
export interface ServicesDraft {
  name: string;
  /** Placement defaults only: "devnet" allows unaudited providers; unset,
   *  the audited-provider profile a shared, long-lived service wants. */
  type?: "devnet" | "testnet" | "mainnet";
  domain: string;
  streamingDomain?: string;
  owner: { username: string; email: string };
  size?: "small" | "standard";
  registrations?: "open" | "approved" | "none";
  /** The relay settings; `password` (typed) or `passwordFromFleet` (copied
   *  from a fleet's secret store at creation) for the secret. */
  smtp?: Record<string, unknown>;
  /** Other wallets whose chain fleets may link bridges to it. */
  sharing?: string[];
  /** Wallet sign-in for the members of the chains that link it. */
  walletLogin?: { enabled: boolean; minTrustLevel?: string };
}

/**
 * A services fleet spec (kind: services) from scratch: the Mastodon it runs
 * and nothing chain-shaped (withDefaults fills the chain fields a services
 * fleet ignores). `extra` carries settings a source fleet adds (providers,
 * infra, images, key mode). The notes say what is left to do.
 */
export function servicesSpecDraft(
  d: ServicesDraft,
  extra: Record<string, unknown> = {},
): { spec: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  const mastodon: Record<string, unknown> = {
    enabled: true,
    domain: d.domain,
    ...(d.streamingDomain ? { streamingDomain: d.streamingDomain } : {}),
    owner: d.owner,
    registrations: d.registrations ?? "none",
    size: d.size ?? "small",
    ...(d.smtp ? { smtp: d.smtp } : {}),
    ...(d.walletLogin ? { walletLogin: d.walletLogin } : {}),
  };
  if (!d.smtp) {
    // with registrations "none" nobody signs up, so there is nothing to confirm
    if ((d.registrations ?? "none") !== "none") {
      notes.push("no SMTP relay: sign-ups cannot confirm their address until topology.components.mastodon.smtp is set");
    }
  } else if (d.smtp.passwordFromFleet) {
    notes.push(
      `the SMTP password is copied from fleet ${d.smtp.passwordFromFleet}'s secret store when the launch is created ` +
        "(smtp.passwordFromFleet); it never passes through this editor",
    );
  } else if (!d.smtp.password) notes.push("set topology.components.mastodon.smtp.password (it moves to the secret store at launch)");
  const streaming = d.streamingDomain ?? `streaming.${d.domain}`;
  const login = d.walletLogin?.enabled ? ` and login.${d.domain} (wallet sign-in)` : "";
  notes.push(`DNS: ${d.domain}, ${streaming}${login}, when the launch pauses with their targets`);
  notes.push(
    "each chain links this instance with a standalone bridge component: add… → bridge on that chain's fleet, " +
      `target ${d.name} (its account there is @bridgedev, @bridgetest or @bridge by network)`,
  );
  return {
    spec: {
      version: 1,
      kind: "services",
      network: { name: d.name, ...(d.type ? { type: d.type } : {}) },
      ...(d.sharing?.length ? { sharing: { wallets: d.sharing } } : {}),
      ...extra,
      topology: { components: { mastodon } },
    },
    notes,
  };
}

/**
 * The same, drafted from an existing fleet that ran Mastodon itself (a
 * chain fleet, before services fleets): its Mastodon's owner,
 * registrations, size, SMTP (the password copied from its secret store
 * at creation) and wallet sign-in (on the new instance's own login domain),
 * and its Akash network, provider policy and images, so the
 * draft places and runs like the fleets it serves. Its bridge sidecar is
 * dropped: each chain links the instance with a standalone bridge instead.
 */
export function servicesSpecFrom(
  base: LaunchSpec,
  opts: { name: string; domain: string; streamingDomain?: string; smtpPasswordFrom?: string; sharing?: string[] },
): { spec: Record<string, unknown>; notes: string[] } {
  const src = base.topology.components.mastodon;
  let smtp: Record<string, unknown> | undefined;
  if (src?.smtp) {
    const { password: _secret, passwordFromFleet: _from, ...rest } = src.smtp as Record<string, unknown>;
    smtp = { ...rest, ...(opts.smtpPasswordFrom ? { passwordFromFleet: opts.smtpPasswordFrom } : {}) };
  }
  const components = base.providers.components as Record<string, unknown> | undefined;
  const result = servicesSpecDraft(
    {
      name: opts.name,
      domain: opts.domain,
      ...(opts.streamingDomain ? { streamingDomain: opts.streamingDomain } : {}),
      owner: src?.owner ?? { username: "admin", email: "you@example.com" },
      ...(src?.size ? { size: src.size } : {}),
      ...(src?.registrations ? { registrations: src.registrations } : {}),
      ...(smtp ? { smtp } : {}),
      ...(opts.sharing?.length ? { sharing: opts.sharing } : {}),
      // the source's login domain belongs to its old instance
      ...(src?.walletLogin?.enabled ? { walletLogin: { enabled: true, minTrustLevel: src.walletLogin.minTrustLevel } } : {}),
    },
    {
      // what a component placement uses: the Akash network, the provider
      // policy and the images; node resources and key mode have nothing to
      // apply to in a fleet with no nodes
      infra: { akashNetwork: base.infra.akashNetwork },
      providers: { ...base.providers, components: components?.mastodon ? { mastodon: components.mastodon } : {} },
      images: {
        ...(base.images.mastodon ? { mastodon: base.images.mastodon } : {}),
        ...(base.images.mastodonStreaming ? { mastodonStreaming: base.images.mastodonStreaming } : {}),
        ...(src?.walletLogin?.enabled && base.images.sdap ? { sdap: base.images.sdap } : {}),
      },
    },
  );
  if (!src?.owner) result.notes.unshift("set topology.components.mastodon.owner: the instance's only way in");
  return result;
}

/**
 * smtp.passwordFromFleet → smtp.password, read from that fleet's secret
 * store (same wallet only), so stashSmtpPassword can move it into the new
 * launch's. Throws with a user-facing reason.
 */
export function resolveSmtpPasswordSource(db: ConductorDb, workRoot: string, owner: string, spec: LaunchSpec): void {
  const smtp = spec.topology.components.mastodon?.smtp as (Record<string, unknown> & { passwordFromFleet?: string; password?: string }) | undefined;
  const from = smtp?.passwordFromFleet;
  if (!smtp || !from) return;
  const source = db.getLaunch(from);
  if (!source) throw new Error(`smtp.passwordFromFleet: no fleet ${from} on this launcher`);
  if (!mayUseFleet(source, owner)) {
    throw new Error("smtp.passwordFromFleet: that fleet belongs to a different wallet that does not share it with this one");
  }
  const password = readMastodonSecrets(launchDirs(workRoot, from).secrets)?.smtpPassword;
  if (!password) throw new Error(`smtp.passwordFromFleet: fleet ${from} has no SMTP password stored`);
  smtp.password = password;
  delete smtp.passwordFromFleet;
}
