import fs from "node:fs";
import type { LaunchSpec } from "@sparkdream/launch-spec";

/**
 * Guided tmkms signer setup (M7, §5 step 19): everything the local signer
 * machine needs, per validator. The privval listener rides the mesh on
 * 26659 speaking the CometBFT v0.34 wire protocol (see docs/DESIGN.md §3).
 */

export interface TmkmsValidatorSetup {
  key: string;
  tailnetIp: string;
  tmkmsToml: string;
  consensusKey: unknown;
  commands: string[];
}

export interface TmkmsSetup {
  chainId: string;
  validators: TmkmsValidatorSetup[];
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
    // consensus key stays launcher-side in tmkms mode (§3) — exported here
    let consensusKey: unknown = null;
    const keyPath = `${args.nodeDir(key)}/config/priv_validator_key.json`;
    if (fs.existsSync(keyPath)) consensusKey = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    validators.push({
      key,
      tailnetIp: ip,
      tmkmsToml: [
        `[[chain]]`,
        `id = "${chainId}"`,
        `key_format = { type = "cometbft", sign_extensions = false }`,
        `state_file = "state/${chainId}-consensus.json"`,
        ``,
        `[[providers.softsign]]`,
        `chain_ids = ["${chainId}"]`,
        `key_type = "consensus"`,
        `path = "secrets/${key}-consensus.key"`,
        ``,
        `[[validator]]`,
        `chain_id = "${chainId}"`,
        `addr = "tcp://${ip}:26659"`,
        `protocol_version = "v0.34"`,
        `reconnect = true`,
      ].join("\n"),
      consensusKey,
      commands: [
        `# 1. install tmkms (release binary, or:)`,
        `cargo install tmkms --features=softsign`,
        `# 2. join the mesh with the spare 'home' preauth key`,
        `sudo tailscale up --login-server=https://${spec.topology.headscale.domain} --authkey=${args.homePreauthKey ?? "<pending>"}`,
        `# 3. import the consensus key (saved from this panel)`,
        `tmkms softsign import ${key}-priv_validator_key.json secrets/${key}-consensus.key`,
        `# 4. start the signer`,
        `tmkms start -c tmkms-${key}.toml`,
      ],
    });
  }
  return { chainId, validators };
}
