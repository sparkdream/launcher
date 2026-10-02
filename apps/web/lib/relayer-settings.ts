import type { EndpointCounterparty, RelayerPathSpec, RelayerSettings, SisterFleet } from "./api";
import { toDisplay } from "./relayer-funds";

/**
 * The relayer settings editor's logic, apart from React: building paths from
 * the user's choices, naming them, and saying in plain words what applying a
 * draft will do.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function validPathId(id: string): boolean {
  return ID_RE.test(id);
}

/** A path id from any label ("Osmosis testnet" → "osmosis-testnet"), made
 *  unique against `taken` with a numeric suffix. */
export function suggestPathId(base: string, taken: string[]): string {
  let id = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  if (!id) id = "path";
  if (!/^[a-z0-9]/.test(id)) id = `p${id}`.slice(0, 28);
  if (!taken.includes(id)) return id;
  for (let n = 2; ; n++) {
    const next = `${id}-${n}`;
    if (!taken.includes(next)) return next;
  }
}

export const isFleetPath = (
  p: RelayerPathSpec,
): p is RelayerPathSpec & { counterparty: { fleet: string; via?: "mesh" | "public" } } => "fleet" in p.counterparty;

/**
 * Paths to a sister fleet: federation (with a companion transfer path, since
 * peer registration keys voucher metadata on it) or a transfer alone. The
 * route is left for the conductor to settle (mesh when shared, else public).
 */
export function sisterPaths(
  sister: SisterFleet,
  opts: { federation: boolean; alsoTransfer: boolean; taken: string[] },
): RelayerPathSpec[] {
  const taken = [...opts.taken];
  const out: RelayerPathSpec[] = [];
  const add = (kind: RelayerPathSpec["kind"], base: string) => {
    const id = suggestPathId(base, taken);
    taken.push(id);
    out.push({ id, kind, counterparty: { fleet: sister.launchId } });
  };
  if (opts.federation) {
    add("federation", sister.name);
    if (opts.alsoTransfer) add("transfer", `${sister.name}-transfer`);
  } else {
    add("transfer", sister.name);
  }
  return out;
}

/** What is missing from an endpoint counterparty before it can be saved. */
export function endpointProblems(cp: Partial<EndpointCounterparty>): string[] {
  const out: string[] = [];
  const url = (u: string | undefined) => Boolean(u && /^https?:\/\/\S+$/.test(u));
  if (!cp.chainId) out.push("chain id");
  if (!url(cp.rpc)) out.push("RPC URL");
  if (!url(cp.grpc)) out.push("gRPC URL");
  if (cp.lcd && !url(cp.lcd)) out.push("LCD URL");
  if (!cp.bech32Prefix || !/^[a-z][a-z0-9]{0,15}$/.test(cp.bech32Prefix)) out.push("address prefix");
  if (!cp.gasDenom) out.push("gas denom");
  if (!(typeof cp.gasPrice === "number" && cp.gasPrice > 0)) out.push("gas price");
  if (cp.maxBalance !== undefined && cp.maxBalance !== "" && !/^[1-9][0-9]*$/.test(cp.maxBalance)) {
    out.push("cap (whole base units)");
  }
  return out;
}

/** The chain a path leads to, for display: a sister fleet by its names, an
 *  endpoint chain by its id. */
export function pathTarget(
  p: RelayerPathSpec,
  sisters: SisterFleet[],
): { chainId: string; label: string; route?: "mesh" | "public" } {
  if (isFleetPath(p)) {
    const s = sisters.find((x) => x.launchId === p.counterparty.fleet);
    return {
      chainId: s?.chainId ?? p.counterparty.fleet,
      label: s ? `${s.displayName} (fleet)` : `fleet ${p.counterparty.fleet}`,
      route: p.counterparty.via ?? s?.route,
    };
  }
  const cp = p.counterparty as EndpointCounterparty;
  return { chainId: cp.chainId, label: cp.chainId };
}

/** A path's live state from the last link: its channel pair, or why it has none. */
export function pathStatus(p: RelayerPathSpec, state: RelayerSettings["state"]): string {
  const ch = state?.channels.find((c) => c.id === p.id);
  if (ch) {
    const peers = (state?.peers ?? []).filter((x) => x.ibcChannelId === ch.a.channel || x.ibcChannelId === ch.b.channel);
    const peerNote =
      p.kind === "federation" && peers.length > 0 ? ` · peers ${peers.map((x) => x.status.replace(/^PEER_STATUS_/, "").toLowerCase()).join(" / ")}` : "";
    return `${ch.a.channel} ↔ ${ch.b.channel}${peerNote}`;
  }
  if (state?.waiting?.some((w) => w.paths.includes(p.id))) return "waiting for funds";
  return state ? "not opened yet" : "not linked yet";
}

export interface ChangeLine {
  tone: "add" | "drop" | "change" | "note";
  text: string;
}

/**
 * Plain-language summary of what applying `after` over `before` does: which
 * channels open or stop being relayed, which federation peers get set up and
 * who signs each end, which sister sentry gets its gRPC opened (a signature),
 * and what has to be funded. Empty when nothing changes.
 */
export function describeChanges(
  before: RelayerPathSpec[],
  after: RelayerPathSpec[],
  ctx: {
    chainId: string;
    founderHeld: boolean;
    sisters: SisterFleet[];
    presets: Array<{ counterparty: { chainId: string }; paid: boolean; symbol: string }>;
    cap?: { before: string | null; after: string | null; symbol: string; decimals: number };
  },
): ChangeLine[] {
  const lines: ChangeLine[] = [];
  const byId = (list: RelayerPathSpec[]) => new Map(list.map((p) => [p.id, p]));
  const was = byId(before);
  const now = byId(after);
  const own = ctx.chainId;
  const ownSigner = ctx.founderHeld ? "your founder vote" : "your Operations Committee";
  // public routes the draft opens that the stored spec did not use yet
  const publicBefore = new Set(
    before.filter(isFleetPath).filter((p) => p.counterparty.via === "public").map((p) => p.counterparty.fleet),
  );
  const exposed = new Set<string>();

  for (const p of after) {
    const old = was.get(p.id);
    if (old) {
      if (JSON.stringify(old) !== JSON.stringify(p)) lines.push({ tone: "change", text: `Updates ${p.id}` });
      continue;
    }
    if (isFleetPath(p)) {
      const s = ctx.sisters.find((x) => x.launchId === p.counterparty.fleet);
      const chain = s?.chainId ?? p.counterparty.fleet;
      lines.push({ tone: "add", text: `Opens a ${p.kind} channel to ${chain}${s ? ` (${s.displayName})` : ""}` });
      if (p.kind === "federation") {
        const theirs = s?.founderHeld ? "that fleet's founder vote" : "that chain's Operations Committee";
        lines.push({
          tone: "note",
          text:
            `Registers and activates the federation peer on both chains: a committee proposal on ${own} ` +
            `(${ownSigner}) and on ${chain} (${theirs})`,
        });
      }
      const route = p.counterparty.via ?? s?.route;
      if (route === "public" && !publicBefore.has(p.counterparty.fleet) && !exposed.has(p.counterparty.fleet)) {
        exposed.add(p.counterparty.fleet);
        const wallet = s?.otherWallet ? ` with its own wallet (${s.otherWallet})` : "";
        lines.push({
          tone: "note",
          text:
            `${s?.name ?? chain} is on another mesh, so the relayer reaches it over its sentry-0's public ports. ` +
            `Unless that sentry already forwards gRPC, the link pauses until you relaunch it${wallet}: a port ` +
            "only comes with a new deployment",
        });
      }
      continue;
    }
    const cp = p.counterparty as EndpointCounterparty;
    const preset = ctx.presets.find((x) => x.counterparty.chainId === cp.chainId);
    lines.push({ tone: "add", text: `Opens a ${p.kind} channel to ${cp.chainId}` });
    if (p.kind === "federation") {
      lines.push({
        tone: "note",
        text:
          `Registers the federation peer on ${own} (${ownSigner}). ${cp.chainId} is not run by this launcher: ` +
          "its Operations Committee must register and activate its end. The launcher writes those messages to " +
          "this fleet's peering folder and waits until the chain reports them done",
      });
    }
    const symbol = preset?.symbol ?? cp.gasDenom;
    if (p.openWhenFunded) {
      lines.push({
        tone: "note",
        text: `Stays unopened until the relayer's key on ${cp.chainId} holds ${symbol}: fund it from the funds panel, then relink`,
      });
    } else {
      lines.push({ tone: "note", text: `The link pauses until the relayer's key on ${cp.chainId} is funded with ${symbol}` });
    }
  }

  for (const p of before) {
    if (now.has(p.id)) continue;
    lines.push({
      tone: "drop",
      text:
        `Stops relaying ${p.id}; its channels stay open on chain` +
        (p.kind === "federation" ? ", and the federation peer stays active until a committee suspends it" : ""),
    });
  }

  if (lines.some((l) => l.tone === "add" && /channel to/.test(l.text)) && after.some(isFleetPath)) {
    const sisterAdded = after.some((p) => isFleetPath(p) && !was.has(p.id));
    if (sisterAdded) {
      lines.push({
        tone: "note",
        text:
          "Relay fees between sister chains come back once their peers are active, so the relayer's key there " +
          "only needs a small float (the launcher funds it from that fleet's founder account when it holds the key)",
      });
    }
  }

  const cap = ctx.cap;
  if (cap && cap.after !== null && cap.after !== cap.before) {
    const show = (v: string | null) => (v === null ? "unset" : `${toDisplay(v, cap.decimals)} ${cap.symbol}`);
    lines.push({ tone: "change", text: `Spark Dream key cap: ${show(cap.before)} → ${show(cap.after)}` });
  }
  return lines;
}

/** Endpoint fields as the user typed them, trimmed to what the spec takes. */
export function cleanEndpoint(cp: Partial<EndpointCounterparty>): EndpointCounterparty {
  const out: EndpointCounterparty = {
    chainId: (cp.chainId ?? "").trim(),
    rpc: (cp.rpc ?? "").trim(),
    grpc: (cp.grpc ?? "").trim(),
    bech32Prefix: (cp.bech32Prefix ?? "").trim(),
    gasDenom: (cp.gasDenom ?? "").trim(),
    gasPrice: Number(cp.gasPrice),
  };
  if (cp.lcd?.trim()) out.lcd = cp.lcd.trim();
  if (cp.dynamicGasPrice) out.dynamicGasPrice = cp.dynamicGasPrice;
  if (cp.maxBalance) out.maxBalance = cp.maxBalance;
  if (cp.gasMultiplier) out.gasMultiplier = cp.gasMultiplier;
  if (cp.eventSource) out.eventSource = cp.eventSource;
  if (cp.ws) out.ws = cp.ws;
  if (cp.hdPath) out.hdPath = cp.hdPath;
  if (cp.trustingPeriod) out.trustingPeriod = cp.trustingPeriod;
  return out;
}
