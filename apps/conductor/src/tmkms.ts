import fs from "node:fs";
import { headscaleDomain, type LaunchSpec } from "@sparkdream/launch-spec";
import { NODE_HOME } from "./node-ops.js";

/**
 * Guided tmkms signer setup (M7, §5 step 19): everything the local signer
 * machine needs, per validator. The privval listener rides the mesh on
 * 26659 speaking the CometBFT v0.38 wire protocol (see docs/DESIGN.md §3).
 */

export interface TmkmsValidatorSetup {
  key: string;
  tailnetIp: string;
  tmkmsToml: string;
  /** Exported priv_validator_key.json for softsign import; null when the
   *  spec pins a pre-existing pubkey (hardware signer holds the key). */
  consensusKey: unknown;
  /** Spec-pinned consensus pubkey the signer must hold, or null. */
  expectedPubkey: string | null;
  commands: string[];
}

export interface TmkmsSetup {
  chainId: string;
  validators: TmkmsValidatorSetup[];
}

/**
 * "Signer connected" probe, run on the validator over SSH. tmkms dials the
 * tailnet-facing keepalive proxy on 26659 and holds the privval session; the
 * proxy (entrypoint section 5c) forwards to sparkdreamd's backend listener on
 * 26660 for exactly as long as the session lives. An ESTABLISHED socket on
 * 26660 therefore means a signer is connected right now, unlike a port-open
 * check, which passes the moment sparkdreamd binds, signer or no signer.
 * netstat prints the state at end of line (ESTABLISHED), ss at the start
 * (ESTAB); busybox netstat exists in the node image, ss is the fallback.
 */
export const SIGNER_CONNECTED_PROBE =
  "{ netstat -tn 2>/dev/null || ss -tn 2>/dev/null; } | " +
  "grep -cE ':26660.*ESTABLISHED|ESTAB.*:26660' || true";

/** True when the probe output reports at least one established session. */
export function probeSaysConnected(stdout: string): boolean {
  const last = stdout.trim().split("\n").pop() ?? "";
  return Number(last) >= 1;
}

/**
 * Signer-path probes, run on the validator over SSH. Both read LOCAL
 * tailscaled state and measure the relay host only: a firewall on the signer
 * machine blocks everything aimed AT it (the validator cannot ping the tmkms
 * node — the signer only ever dials out), but the session state and the
 * relay's latency are visible from this side. Socket path matches the
 * sentry-link probes in fleet.ts (unjail guard).
 */
export const TAILSCALE_STATUS_PROBE =
  `tailscale --socket=${NODE_HOME}/tailscale/tailscaled.sock status --json 2>/dev/null || true`;

export const TAILSCALE_NETCHECK_PROBE =
  `tailscale --socket=${NODE_HOME}/tailscale/tailscaled.sock netcheck 2>/dev/null || true`;

export interface SignerPeerInfo {
  name: string;
  ip: string | null;
  online: boolean;
  /** the peer's session to this validator moved traffic recently */
  active: boolean;
  /** DERP region the session relays through, null when direct */
  relay: string | null;
  txBytes: number;
  rxBytes: number;
  lastHandshake: string | null;
}

/**
 * The signer machines visible from a validator's own tailscaled, parsed out
 * of `tailscale status --json` (local daemon state, no traffic toward the
 * signer). Matches the hostname the guided setup joins with (--hostname
 * tmkms-<network>, buildTmkmsSetup below): any tmkms-* peer counts since
 * headscale rewrites names to DNS-safe form, and the exact network match
 * sorts first.
 */
export function parseSignerPeers(stdout: string, networkName: string): SignerPeerInfo[] {
  let doc: any;
  try {
    doc = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  const want = `tmkms-${networkName}`.toLowerCase();
  const out: SignerPeerInfo[] = [];
  for (const p of Object.values(doc?.Peer ?? {}) as any[]) {
    const host = String(p?.HostName ?? "");
    const dns = String(p?.DNSName ?? "").split(".")[0]!;
    if (!host.toLowerCase().startsWith("tmkms-") && !dns.toLowerCase().startsWith("tmkms-")) {
      continue;
    }
    out.push({
      name: host || dns,
      ip: Array.isArray(p?.TailscaleIPs) ? String(p.TailscaleIPs[0] ?? "") || null : null,
      online: Boolean(p?.Online),
      active: Boolean(p?.Active),
      relay: p?.Relay ? String(p.Relay) : null,
      txBytes: Number(p?.TxBytes ?? 0),
      rxBytes: Number(p?.RxBytes ?? 0),
      lastHandshake: typeof p?.LastHandshake === "string" ? p.LastHandshake : null,
    });
  }
  out.sort(
    (a, b) =>
      Number(b.name.toLowerCase() === want) - Number(a.name.toLowerCase() === want) ||
      a.name.localeCompare(b.name),
  );
  return out;
}

export interface DerpRegionLatency {
  /** region code ("sparkdream"), the same string tailscale status reports in
   *  a peer's Relay field */
  code: string;
  /** display name ("SparkDream DERP"), null when the output carries none */
  name: string | null;
  ms: number;
}

export interface NetcheckInfo {
  nearest: string | null;
  regions: DerpRegionLatency[];
}

/**
 * The validator's own latency to each DERP region, from `tailscale netcheck`
 * text output (netcheck has no --json). This is the validator↔relay leg of
 * the signer path; the signer machine's leg is unreachable behind its
 * firewall, so the panel pairs this with the signer's own once-measured leg.
 */
export function parseNetcheck(stdout: string): NetcheckInfo {
  const nearest = /^\s*\* Nearest DERP:\s*(.+?)\s*$/m.exec(stdout)?.[1] ?? null;
  const regions: DerpRegionLatency[] = [];
  // "  - sparkdream: 71.9ms  (SparkDream DERP)"
  for (const m of stdout.matchAll(/^\s*-\s*([a-z0-9-]+):\s*([\d.]+)ms(?:\s+\(([^)]+)\))?\s*$/gim)) {
    regions.push({ code: m[1]!, name: m[3] ?? null, ms: Number(m[2]) });
  }
  return { nearest, regions };
}

/** Latency to the relay a signer session uses, when netcheck measured it. */
export function relayLatencyMs(netcheck: NetcheckInfo | null, relay: string | null): number | null {
  if (!netcheck) return null;
  if (relay) {
    const hit = netcheck.regions.find((r) => r.code === relay || r.name === relay);
    if (hit) return hit.ms;
  }
  return netcheck.regions[0]?.ms ?? null;
}

/**
 * The validator's own /status, fetched from inside its container. In tmkms
 * mode the node bundle carries no local priv_validator_key.json, so once a
 * signer holds the privval session the answer's validator_info.pub_key is
 * that signer's key — the only live check that the connected device holds
 * the key the chain was built with. (The standard tmkms verification recipe.)
 */
export const VALIDATOR_STATUS_PROBE =
  "wget -qO- http://127.0.0.1:26657/status 2>/dev/null || true";

/** Consensus pubkey from /status output, or null when unavailable. */
export function statusConsensusPubkey(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as any;
    const key = parsed?.result?.validator_info?.pub_key?.value;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

export function buildTmkmsSetup(args: {
  spec: LaunchSpec;
  chainId: string;
  meshIps?: Record<string, string> | undefined;
  homePreauthKey?: string | undefined;
  nodeDir: (key: string) => string;
}): TmkmsSetup {
  const { spec, chainId } = args;
  const validators: TmkmsValidatorSetup[] = [];
  for (let v = 0; v < spec.topology.validators.count; v++) {
    const key = `val-${v}`;
    const ip = args.meshIps?.[key] ?? "<pending: mesh not joined yet>";
    // spec-pinned pubkey (hardware signer, §3): the device holds the key, so
    // there is nothing to export — importing the init-generated placeholder
    // would sign with a key the chain never heard of
    const pinned = spec.topology.validators.consensusPubkeys?.[v] ?? null;
    // consensus key stays launcher-side in tmkms mode (§3) — exported here
    let consensusKey: unknown = null;
    if (!pinned) {
      const keyPath = `${args.nodeDir(key)}/config/priv_validator_key.json`;
      if (fs.existsSync(keyPath)) consensusKey = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    }
    const chainSection = [
      `[[chain]]`,
      `id = "${chainId}"`,
      // CometBFT v0.38 (SDK 0.50): sign extensions carry the vote
      // extension data; without them the signature is rejected
      `key_format = { type = "cometbft", sign_extensions = true }`,
      // per-validator state file when there are several: each validator
      // needs its own tmkms process (softsign maps one key per chain id),
      // and two processes sharing one double-sign watermark file either
      // refuse each other's heights (permanent missed blocks) or corrupt it
      // under concurrent writes. Single-validator fleets keep the legacy
      // un-keyed path so a re-fetched checklist never points a live signer
      // at a fresh (empty) watermark.
      `state_file = "state/${chainId}${spec.topology.validators.count > 1 ? `-${key}` : ""}-consensus.json"`,
    ];
    // keep [[validator]] LAST: await-signer slices its stanza from it onward
    const validatorSection = [
      `[[validator]]`,
      `chain_id = "${chainId}"`,
      `addr = "tcp://${ip}:26659"`,
      `protocol_version = "v0.38"`,
      `reconnect = true`,
    ];
    const providerSection = pinned
      ? [
          `# Hardware signer: the launch pinned a pre-existing consensus pubkey,`,
          `# so no key is imported here. Fill in the provider section for YOUR`,
          `# device (tmkms signing providers:`,
          `# https://github.com/iqlusioninc/tmkms#signing-providers). The device`,
          `# MUST hold the key whose consensus pubkey is:`,
          `#   ${pinned}`,
          `# the chain was built with it; any other key's votes are rejected.`,
          `#`,
          `# YubiHSM 2:`,
          `# [[providers.yubihsm]]`,
          `# adapter = { type = "usb" }`,
          `# auth = { key = 1, password = "..." }`,
          `# keys = [{ chain_ids = ["${chainId}"], key = 1, type = "consensus" }]`,
          `#`,
          `# Ledger:`,
          `# [[providers.ledger]]`,
          `# chain_ids = ["${chainId}"]`,
        ]
      : [
          `[[providers.softsign]]`,
          `chain_ids = ["${chainId}"]`,
          `key_type = "consensus"`,
          `path = "secrets/${key}-consensus.key"`,
        ];
    const multiVal = spec.topology.validators.count > 1;
    const meshJoinNote = spec.topology.headscale.reuseFleet
      ? [`# 2. join the mesh with the spare 'home' preauth key: skip if this`,
         `#    machine is already logged into the shared mesh (reuseFleet)`]
      : multiVal
        ? [`# 2. join the mesh with the spare 'home' preauth key. One join per`,
           `#    machine: if this machine already runs another validator's`,
           `#    signer, skip this step (the existing login serves both)`]
        : [`# 2. join the mesh with the spare 'home' preauth key`];
    // per-validator hostname when there are several: distinct signer
    // machines must not collide on one mesh name (headscale would rename
    // the second, and the checklist could not tell the signers apart)
    const hostname = multiVal
      ? `tmkms-${spec.network.name}-${key}`
      : `tmkms-${spec.network.name}`;
    const meshJoin =
      `sudo tailscale up --login-server=https://${headscaleDomain(spec)} ` +
      `--authkey=${args.homePreauthKey ?? "<pending>"} --hostname ${hostname}`;
    const commands = pinned
      ? [
          `# 1. install tmkms with the feature for your signer, e.g.:`,
          `#    cargo install tmkms --features=yubihsm   (YubiHSM 2)`,
          `#    cargo install tmkms --features=ledger    (Ledger)`,
          ...meshJoinNote,
          meshJoin,
          `# 3. save the config above as tmkms-${key}.toml, then fill in its`,
          `#    [[providers.*]] section for your device. The signer's consensus`,
          `#    pubkey for this chain must be:`,
          `#    ${pinned}`,
          `mkdir -p state`,
          `# 4. start the signer (keep it running: tmux, or a systemd unit)`,
          `tmkms start -c tmkms-${key}.toml`,
          `# 5. back here: the status row for ${key} turns green, then resume the launch`,
        ]
      : [
          `# 1. install tmkms (release binary, or:)`,
          `cargo install tmkms --features=softsign`,
          ...meshJoinNote,
          meshJoin,
          `# 3. import the consensus key (downloaded from this panel)`,
          `mkdir -p state secrets`,
          `tmkms softsign import ${key}-priv_validator_key.json secrets/${key}-consensus.key`,
          `# 4. save the config above as tmkms-${key}.toml, then start the signer`,
          `#    (keep it running: tmux, or a systemd unit)`,
          `tmkms start -c tmkms-${key}.toml`,
          `# 5. back here: the status row for ${key} turns green, then resume the launch`,
        ];
    validators.push({
      key,
      tailnetIp: ip,
      tmkmsToml: [...chainSection, ``, ...providerSection, ``, ...validatorSection].join("\n"),
      consensusKey,
      expectedPubkey: pinned,
      commands,
    });
  }
  return { chainId, validators };
}
