import { isComponentKey, type ComponentKey } from "@sparkdream/launch-spec";
import { explorer } from "./explorer.js";
import { frontend } from "./frontend.js";
import { mastodon } from "./mastodon.js";
import { relayer } from "./relayer.js";
import { verifier } from "./verifier.js";
import { bridge } from "./bridge.js";
import { hub } from "./hub.js";
import { ntfy } from "./ntfy.js";
import { battle } from "./battle.js";
import type { ComponentDescriptor } from "./types.js";

export type { ComponentDescriptor, RenderInput, SdlResources, Tunnel } from "./types.js";
export { explorerChainEnv } from "./explorer.js";

const REGISTRY: Record<ComponentKey, ComponentDescriptor> = { explorer, frontend, relayer, mastodon, verifier, bridge, hub, ntfy, battle };

export function descriptor(key: ComponentKey): ComponentDescriptor {
  return REGISTRY[key];
}

/** The descriptor for a fleet component key, or undefined for chain nodes
 *  and headscale (which are not service components). */
export function descriptorFor(key: string): ComponentDescriptor | undefined {
  return isComponentKey(key) ? REGISTRY[key] : undefined;
}

/**
 * Set (or, for an undefined value, remove) env entries on the named services
 * of a parsed SDL, in place. Everything else in the env — resolved tunnel
 * targets, auth keys — is left alone, which is why deployed SDLs are patched
 * rather than re-rendered.
 */
export function setServiceEnv(
  doc: any,
  services: string[],
  entries: Record<string, string | undefined>,
): void {
  for (const name of services) {
    const svc = doc.services?.[name];
    if (!svc) throw new Error(`SDL has no services.${name}`);
    const env: string[] = svc.env ?? [];
    for (const [k, v] of Object.entries(entries)) {
      const i = env.findIndex((x) => x.startsWith(k + "="));
      if (v === undefined) {
        if (i >= 0) env.splice(i, 1);
      } else if (i >= 0) env[i] = `${k}=${v}`;
      else env.push(`${k}=${v}`);
    }
    svc.env = env;
  }
}
