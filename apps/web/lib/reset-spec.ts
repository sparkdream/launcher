import { applyFrozenReset, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import yaml from "js-yaml";

/**
 * Which spec a chain reset should be built from.
 *
 * A reset rebuilds genesis on the deployments the fleet already has, so its
 * baseline is the fleet's own stored spec, never the spec editor: the
 * editor is a free-standing draft (kept in localStorage, seeded from the
 * built-in example, never hydrated from a running fleet), and posting one
 * aimed at some other chain is how a reset ends up rejected for changing
 * what the deployments embody.
 *
 * The draft is still worth honoring when it is plainly about THIS fleet:
 * chain identity (name, type, prefix) has to match before its
 * genesis-shaping edits (accounts + members, chainParams, token, the node
 * image) count as edits of this chain. Even then the fields the deployments
 * embody are projected back off the live spec, so what the editor says can
 * never contradict what is running.
 */
export interface ResetSource {
  /** The spec to post. Frozen fields always match the deployed fleet. */
  spec: LaunchSpec;
  /** True when the spec editor's edits are being carried into the reset. */
  fromEditor: boolean;
}

export function resetSource(editorText: string, live: LaunchSpec): ResetSource {
  const draft = specDraftFor(editorText, live);
  return {
    spec: applyFrozenReset(live, draft ?? structuredClone(live)),
    fromEditor: draft !== null,
  };
}

/** The editor's draft when it is an edit of `live`'s chain, else null. */
function specDraftFor(editorText: string, live: LaunchSpec): LaunchSpec | null {
  let draft: LaunchSpec;
  try {
    draft = withDefaults(yaml.load(editorText));
  } catch {
    return null; // an unparseable or invalid draft is not an instruction
  }
  const identity = (s: LaunchSpec) =>
    [s.network?.name, s.network?.type, s.network?.bech32Prefix].join(" ");
  if (identity(draft) !== identity(live)) return null;
  // an untouched copy of the fleet's own spec is not an edit of it
  return JSON.stringify(applyFrozenReset(live, draft)) === JSON.stringify(live) ? null : draft;
}
