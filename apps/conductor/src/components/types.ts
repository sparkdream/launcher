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
  /** Current tailnet IP of a tunnel peer in ANOTHER fleet (`key@launchId`).
   *  Those fleets are already running, so their addresses are known at render
   *  time; this fleet's own peers stay placeholders until persist-start. */
  peerTailnetIp?: (peer: string) => string | undefined;
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
  resources(): SdlResources[];
  /** Services that run the component's own image; an upgrade swaps only these
   *  (a sidecar database keeps its image). */
  imageServices: string[];
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
  /** Env derived from domains; a domain retarget sets these (undefined =
   *  remove) alongside rewriting accept lists. */
  retargetEnv?(spec: LaunchSpec): Record<string, string | undefined>;
}
