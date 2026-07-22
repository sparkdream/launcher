import fs from "node:fs";
import { headscaleDomain, type LaunchSpec } from "@sparkdream/launch-spec";

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
      `state_file = "state/${chainId}-consensus.json"`,
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
    const meshJoinNote = spec.topology.headscale.reuseFleet
      ? [`# 2. join the mesh with the spare 'home' preauth key: skip if this`,
         `#    machine is already logged into the shared mesh (reuseFleet)`]
      : [`# 2. join the mesh with the spare 'home' preauth key`];
    const meshJoin =
      `sudo tailscale up --login-server=https://${headscaleDomain(spec)} ` +
      `--authkey=${args.homePreauthKey ?? "<pending>"} --hostname tmkms-${spec.network.name}`;
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
