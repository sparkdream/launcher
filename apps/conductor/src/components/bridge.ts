import type { FleetComponentRow } from "../db.js";
import type { StepCtx } from "../engine.js";
import { ensureSession } from "../sessions.js";
import { linkStandaloneBridge } from "../steps/mastodon.js";
import { BRIDGE_RESOURCES, bridgeService } from "./mastodon.js";
import type { ComponentDescriptor, RenderInput } from "./types.js";

/**
 * Akash providers refuse a manifest with no globally exposed service ("zero
 * global services"), and sdapbridge listens on nothing: a plain TCP port
 * (not 80, so no ingress hostname) with nothing behind it.
 */
const PLACEHOLDER_EXPOSE = { port: 8080, as: 8080, proto: "tcp", to: [{ global: true }] };

/**
 * A standalone bridge (sdapbridge on its own deployment): links a Mastodon
 * instance another fleet runs (typically a services fleet) to this fleet's
 * chain. The same service the Mastodon component carries as its sidecar,
 * pointed at that instance's domain (resolved into bridge.target.domain).
 */
function render(input: RenderInput) {
  const { spec, component } = input;
  const b = spec.topology.components.bridge!;
  if (!b.target.domain) throw new Error("the bridge's Mastodon domain was never resolved from its target fleet");
  const service = bridgeService(input, b.target.domain, component.image);
  return {
    bridge: { service: { ...service, expose: [PLACEHOLDER_EXPOSE] }, resources: BRIDGE_RESOURCES },
  };
}

export const bridge: ComponentDescriptor = {
  key: "bridge",
  render,
  resources: () => [BRIDGE_RESOURCES],
  imageServices: ["bridge"],
  shellService: "bridge",
  tunnels: () => [],
  envRefresh: "none",
  configureSteps: (name, spec) => [
    { name: name("link-bridge"), run: (ctx: StepCtx) => linkStandaloneBridge(ctx, name("link-bridge"), spec) },
    { name: name("session-bridge"), run: (ctx: StepCtx) => ensureSession(ctx, spec, "bridge") },
  ],
};

/** The row of the Mastodon a fleet's standalone bridge links, if running. */
export function bridgeTargetRow(
  db: { listFleetComponents(launchId: string): unknown[] },
  targetFleet: string,
): FleetComponentRow | undefined {
  return (db.listFleetComponents(targetFleet) as FleetComponentRow[]).find(
    (c) => c.key === "mastodon" && c.state !== "closed",
  );
}
