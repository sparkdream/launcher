import type { LaunchSpec } from "./schema.js";

/**
 * The service component kinds a fleet can run beside its chain nodes, and the
 * facts about each that the spec layer, the conductor and the UI all need.
 *
 * This is the one place a kind is declared. Code that has to treat kinds
 * differently reads these fields (or, in the conductor, the kind's descriptor
 * in apps/conductor/src/components/) instead of comparing keys, so adding a
 * kind is an entry here plus a descriptor there — not a sweep for
 * `key === "explorer"`.
 */
export const COMPONENT_KEYS = ["explorer", "frontend", "relayer", "mastodon", "verifier", "bridge", "hub", "ntfy", "battle"] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

export interface ComponentKind {
  key: ComponentKey;
  /** Label in the fleet UI and cost table. */
  label: string;
  /** One line on what it is for (the add dialog's picker). */
  summary: string;
  /** Joins the headscale mesh: needs a preauth key, tunnel re-aiming on peer
   *  moves, and a live headscale to relaunch. */
  mesh: boolean;
  /** Runs sshd on 2222: the launcher can upload files and run commands in it. */
  ssh: boolean;
  /** Where files uploaded from the fleet panel land: a persistent path, the
   *  only kind that survives a container restart. Absent = no uploads. */
  uploadDir?: string;
  /** Serves a public HTTPS domain. Such a kind needs `domain` in the spec, is
   *  health-checked by HTTP 200 there, and pauses for DNS when it is dark. */
  domain: boolean;
  /** Reads chain data from sentry-0, so the fleet needs at least one sentry. */
  needsSentry: boolean;
  /** Consumes the sentries' LCD (1317), which the configs then switch on. */
  needsLcd: boolean;
  /** Consumes sentry-0's gRPC (9090), which the configs then bind to all
   *  interfaces so the mesh tunnel can reach it. */
  needsGrpc: boolean;
}

export const COMPONENT_KINDS: Readonly<Record<ComponentKey, ComponentKind>> = {
  explorer: {
    key: "explorer",
    label: "Block explorer",
    summary: "Public block explorer for the chain",
    mesh: true,
    ssh: true,
    uploadDir: "/data",
    domain: true,
    needsSentry: true,
    needsLcd: true,
    needsGrpc: false,
  },
  frontend: {
    key: "frontend",
    label: "Web app",
    summary: "The chain's user-facing web app",
    mesh: false,
    ssh: false,
    domain: true,
    needsSentry: true,
    needsLcd: true,
    needsGrpc: false,
  },
  relayer: {
    key: "relayer",
    label: "IBC relayer",
    summary: "Relays IBC packets between chains",
    mesh: true,
    ssh: true,
    // Hermes' key store and config live here; bringup re-reads them
    uploadDir: "/data",
    domain: false,
    needsSentry: true,
    needsLcd: false,
    needsGrpc: true,
  },
  mastodon: {
    key: "mastodon",
    label: "Mastodon",
    summary: "Social instance the chain's posts federate through",
    // talks to the world over its domain; its bridge reaches the chain over
    // the public api endpoint, like any client
    mesh: false,
    // upstream-derived image, no sshd: configured over lease-shell
    ssh: false,
    domain: true,
    needsSentry: false,
    needsLcd: false,
    needsGrpc: false,
  },
  bridge: {
    key: "bridge",
    label: "ActivityPub bridge",
    summary: "Federates the chain's posts to a Mastodon instance",
    // a client of another fleet's Mastodon (its API) and of this chain's
    // public api, like the verifier: no mesh, no sshd (the sdap image)
    mesh: false,
    ssh: false,
    domain: false,
    needsSentry: false,
    needsLcd: false,
    needsGrpc: false,
  },
  verifier: {
    key: "verifier",
    label: "Content verifier",
    summary: "Checks content posted through the bridge",
    // a client of the target chain's public api and of the Mastodon it
    // checks, like any outsider: no mesh, no sshd (the sdap image)
    mesh: false,
    ssh: false,
    domain: false,
    needsSentry: false,
    needsLcd: false,
    needsGrpc: false,
  },
  hub: {
    key: "hub",
    label: "Landing page",
    summary: "Landing page that links the apps",
    // a static site (nginx serving the hub's Vite build): reads nothing from
    // any chain, so it runs the same beside a chain or in a services fleet
    mesh: false,
    ssh: false,
    domain: true,
    needsSentry: false,
    needsLcd: false,
    needsGrpc: false,
  },
  ntfy: {
    key: "ntfy",
    label: "Alerts (ntfy)",
    summary: "Push server for the launcher's alerts to your phone",
    // a push server the launcher posts incident alerts to and a phone app
    // reads: chain-independent, so it runs in a services fleet as well
    mesh: false,
    ssh: false,
    domain: true,
    needsSentry: false,
    needsLcd: false,
    needsGrpc: false,
  },
  battle: {
    key: "battle",
    label: "Battle royale",
    summary: "Browser battle royale game, with bots and a leaderboard",
    // a game server (the battle-royale repo's image): reads nothing from any
    // chain, so it runs the same beside a chain or in a services fleet
    mesh: false,
    ssh: false,
    domain: true,
    needsSentry: false,
    needsLcd: false,
    needsGrpc: false,
  },
};

/** The domain on a component's spec toggle (kinds without one carry none). */
export function componentDomain(spec: LaunchSpec, key: ComponentKey): string | undefined {
  const toggle = spec.topology.components[key] as { domain?: string } | undefined;
  return toggle?.domain;
}

export function isComponentKey(key: string): key is ComponentKey {
  return (COMPONENT_KEYS as readonly string[]).includes(key);
}
