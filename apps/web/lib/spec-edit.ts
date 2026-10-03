import { isMap, parseDocument, type Document } from "yaml";
import { NODE_SIZES, type NodeSize, type RoleResources } from "@sparkdream/launch-spec";

export type NodeRoleName = "validator" | "sentry";

/**
 * Who chooses the bids at launch: the selection policy for everything
 * ("auto"), the operator for the validators and sentries only ("nodes"), or
 * the operator for every deployment ("every"). "custom" is any other mix the
 * YAML sets by hand.
 */
export type BidMode = "auto" | "nodes" | "every" | "custom";

/**
 * Edit the spec YAML in place, keeping its comments and layout (a join
 * prefill's notes are comments). Returns undefined when the text does not
 * parse: broken YAML can only be fixed by hand.
 */
export function editSpecYaml(text: string, edit: (doc: Document) => void): string | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return undefined;
  edit(doc);
  return doc.toString({ lineWidth: 120 });
}

/** Set a value at `path`, or with undefined remove it and any map it leaves empty. */
function put(doc: Document, path: string[], value: unknown): void {
  if (value !== undefined) {
    doc.setIn(path, value);
    return;
  }
  if (!doc.hasIn(path)) return;
  doc.deleteIn(path);
  for (let i = path.length - 1; i > 0; i--) {
    const parent = doc.getIn(path.slice(0, i));
    if (!isMap(parent) || parent.items.length > 0) break;
    doc.deleteIn(path.slice(0, i));
  }
}

const sameResources = (a: RoleResources, b: Partial<RoleResources> | undefined): boolean =>
  b !== undefined &&
  a.cpu === b.cpu &&
  a.memory === b.memory &&
  a.storage.root === b.storage?.root &&
  a.storage.data === b.storage?.data &&
  a.storage.persistent === b.storage?.persistent &&
  a.storage.class === (b.storage?.class ?? "beta3");

/**
 * The size every node of a role launches at, read off the parsed (raw) spec:
 * infra.roleSizes, else the tier the role's infra.resources match, else
 * "custom". No resources in the spec means the profile's, which are standard.
 */
export function roleSizeOf(doc: any, role: NodeRoleName): NodeSize | "custom" {
  const set = doc?.infra?.roleSizes?.[role];
  if (set === "small" || set === "standard" || set === "large") return set;
  const res = doc?.infra?.resources?.[role];
  if (res === undefined) return "standard";
  return (Object.keys(NODE_SIZES) as NodeSize[]).find((s) => sameResources(NODE_SIZES[s][role], res)) ?? "custom";
}

/**
 * Launch every node of `role` at `size`. A node's own infra.nodeSizes entry
 * would override the role, so the role's entries are dropped: the picker
 * means all of them.
 */
export function setRoleSize(text: string, role: NodeRoleName, size: NodeSize): string | undefined {
  return editSpecYaml(text, (doc) => {
    put(doc, ["infra", "roleSizes", role], size);
    const own = doc.getIn(["infra", "nodeSizes"]);
    if (isMap(own)) {
      const prefix = role === "validator" ? "val-" : "sentry-";
      for (const item of [...own.items]) {
        const key = String((item.key as any)?.value ?? item.key);
        if (key.startsWith(prefix)) put(doc, ["infra", "nodeSizes", key], undefined);
      }
    }
  });
}

/** Read the bid mode off the parsed (raw) spec. */
export function bidModeOf(doc: any): BidMode {
  const every = doc?.providers?.policy?.manualBid === true;
  const groups = doc?.providers?.components ?? {};
  const val = groups.validators?.manualBid;
  const sen = groups.sentries?.manualBid;
  const others = Object.entries(groups).some(
    ([k, v]: [string, any]) => k !== "validators" && k !== "sentries" && v?.manualBid !== undefined,
  );
  if (others) return "custom";
  if (every) return val === false || sen === false ? "custom" : "every";
  if (val === true && sen === true) return "nodes";
  if (val === undefined && sen === undefined) return "auto";
  return "custom";
}

/** Set the bid mode, touching only the manualBid keys (exclusions stay). */
export function setBidMode(text: string, mode: Exclude<BidMode, "custom">): string | undefined {
  return editSpecYaml(text, (doc) => {
    put(doc, ["providers", "policy", "manualBid"], mode === "every" ? true : undefined);
    for (const group of ["validators", "sentries"]) {
      put(doc, ["providers", "components", group, "manualBid"], mode === "nodes" ? true : undefined);
    }
  });
}
