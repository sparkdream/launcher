import fs from "node:fs";
import yaml from "js-yaml";
import { descriptor, type RenderInput } from "./components/index.js";
import { PRICING_DENOM } from "./render-sdl.js";

export { explorerChainEnv } from "./components/index.js";

export interface RenderComponentSdlInput extends RenderInput {
  outPath: string;
}

/**
 * SDLs for the service components. Unlike the node/headscale SDLs these are
 * launcher-authored, not vendored: each kind's services come from its
 * descriptor (components/), with every value taken from the spec. This
 * wraps them into one deployment: a compute profile, a price and a
 * deployment entry per service, each named after its service — fleet ops
 * address lease-shell by those names.
 */
export function renderComponentSdl(input: RenderComponentSdlInput): void {
  const { spec, component } = input;
  const rendered = descriptor(component.key).render(input);
  const pricing = { denom: PRICING_DENOM[spec.infra.akashNetwork], amount: 1000 };
  const names = Object.keys(rendered);
  const sdl = {
    version: "2.0",
    services: Object.fromEntries(names.map((n) => [n, rendered[n]!.service])),
    profiles: {
      compute: Object.fromEntries(names.map((n) => [n, { resources: rendered[n]!.resources }])),
      placement: { dcloud: { pricing: Object.fromEntries(names.map((n) => [n, pricing])) } },
    },
    deployment: Object.fromEntries(names.map((n) => [n, { dcloud: { profile: n, count: 1 } }])),
  };
  fs.writeFileSync(input.outPath, yaml.dump(sdl, { lineWidth: 120 }));
}
