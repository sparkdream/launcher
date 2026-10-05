import type { ComponentKey, ComponentRef, LaunchSpec } from "@sparkdream/launch-spec";
import type { StepDef } from "../engine.js";

/** One SDL compute profile's `resources` block. */
export interface SdlResources {
  cpu: { units: number };
  memory: { size: string };
  storage: Array<{ name?: string; size: string; attributes?: Record<string, unknown> }>;
}

export interface RenderInput {
  spec: LaunchSpec;
  component: ComponentRef;
  sshPublicKey: string;
  placeholder: {
    tailnetIp: (nodeKey: string) => string;
    tsAuthkey: (nodeKey: string) => string;
  };
  /** Public REST APIs of the chains this chain relays with, by chain id
   *  (sisterChainApis): the frontend's federation form reads a peer chain's
   *  identity from them. */
  peerChains?: Record<string, string>;
  /** Current tailnet IP of a tunnel peer in ANOTHER fleet (`key@launchId`).
   *  Those fleets are already running, so their addresses are known at render
   *  time; this fleet's own peers stay placeholders until persist-start. */
  peerTailnetIp?: (peer: string) => string | undefined;
  /** The launch's secrets directory, for a kind whose env carries secrets it
   *  keeps there (Mastodon's keys, the bridge operator's mnemonic). */
  secretsDir?: string;
  /** Another fleet's (or this one's) spec and secrets directory, for a kind
   *  that acts on a target fleet's chain (the verifier). */
  resolveFleet?: (
    launchId: string,
  ) => { spec: LaunchSpec; secretsDir: string; launchId: string; accounts: Record<string, string> } | undefined;
  /** This launch's id (what a target defaults to). */
  launchId?: string;
}

/** A mesh tunnel: local port → `remote` port on the fleet component `peer`. */
export interface Tunnel {
  local: number;
  remote: number;
  peer: string;
}

/**
 * How the conductor deploys and operates one service component kind. The
 * kind-independent facts (mesh, ssh, domain, …) live in COMPONENT_KINDS in
 * @sparkdream/launch-spec; this is the conductor-only half.
 *
 * Every per-kind decision in the conductor goes through a descriptor, so a
 * new kind is a new file in this directory plus a registry entry.
 */
export interface ComponentDescriptor {
  key: ComponentKey;
  /**
   * SDL services, keyed by service name, with each one's compute resources.
   * A kind may run several services in one deployment (they share a provider
   * and reach each other by service name). `shellService` must be among them.
   */
  render(input: RenderInput): Record<string, { service: Record<string, unknown>; resources: SdlResources }>;
  /** Compute resources per service — what the estimator prices. Must agree
   *  with render(). */
  resources(spec: LaunchSpec): SdlResources[];
  /** Services that run the component's own image. An upgrade swaps the
   *  services already running the new image's repository, else these (a
   *  sidecar database keeps its image either way). */
  imageServices: string[];
  /**
   * The spec image (spec.images key) each other service of the deployment
   * runs, for a deployment that carries more than its main image (Mastodon:
   * upstream streaming, the bridge's sdap). An upgrade to one of those
   * images swaps that service and records it under its own key.
   */
  sideImages?: Record<string, string>;
  /** Service that lease-shell restarts and execs target. */
  shellService: string;
  /** Mesh tunnels its env bakes, re-aimed when a peer's tailnet IP moves. */
  tunnels(spec: LaunchSpec): Tunnel[];
  /**
   * How upgrade and chain-reset refresh the chain identity in a deployed SDL:
   * - "rerender": the SDL holds nothing the spec doesn't (no resolved tunnel
   *   IPs or auth keys), so render it again from scratch.
   * - "patch": set chainEnv(spec) on the image services in place, preserving
   *   what persist-start resolved.
   * - "none": the env carries no chain identity.
   */
  envRefresh: "rerender" | "patch" | "none";
  chainEnv?(spec: LaunchSpec): Record<string, string>;
  /**
   * Steps that configure the component once it is placed and healthy — after
   * every placement, since each one (add, relaunch) lands on a fresh volume.
   * `name` prefixes a step name with the op's. Absent = the container
   * configures itself from its env.
   */
  configureSteps?(name: (step: string) => string, spec: LaunchSpec): StepDef[];
  /** Every image the kind deploys, when more than its own (validate-spec
   *  probes them). Default: the component's image. */
  images?(spec: LaunchSpec): string[];
  /** Every public ingress and the URL that proves it serves, when more than
   *  https://<domain>/ (verify-chain's DNS gate and the health monitor). */
  ingress?(spec: LaunchSpec): Array<{ domain: string; healthUrl: string }>;
  /** A health probe run in the container over SSH (kinds without a public
   *  domain): the command, and what its output means. An unhealthy verdict
   *  reads as "unreachable" unless it names a more specific status. */
  probe?: {
    command: string;
    verdict(stdout: string): { healthy: boolean; detail: string; status?: string };
  };
  /** Providers this kind must not land on, decided at placement time (the
   *  verifier avoids whichever provider hosts the Mastodon it checks).
   *  `assigned` holds this launch's placements made so far. */
  avoidProviders?(input: {
    db: import("../db.js").ConductorDb;
    launchId: string;
    spec: LaunchSpec;
    assigned: Record<string, string>;
  }): string[];
  /** Env derived from domains; a domain retarget sets these (undefined =
   *  remove) alongside rewriting accept lists. */
  retargetEnv?(spec: LaunchSpec): Record<string, string | undefined>;
  /** A domain retarget's component-specific part, applied to the deployed
   *  SDL after the accept lists and retargetEnv: the domains of side
   *  services (Mastodon's login) and the env that names them. */
  retargetDoc?(doc: any, spec: LaunchSpec): void;
}
