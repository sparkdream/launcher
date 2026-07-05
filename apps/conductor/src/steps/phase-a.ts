import fs from "node:fs";
import path from "node:path";
import {
  chainId,
  nodes,
  resolveTopology,
  tunnelPort,
  validateSpec,
  type LaunchSpec,
  type NodeRef,
} from "@sparkdream/launch-spec";
import type { StepCtx, StepDef } from "../engine.js";
import { sparkdreamd, run } from "../exec.js";
import { generateAgeKeypair, generateSshKeypair } from "../keys.js";
import { applyChainParams, commissionFlags } from "../genesis-params.js";
import { renderNodeConfigs } from "../render-configs.js";
import { renderNodeSdl } from "../render-sdl.js";

/**
 * Placeholder for values only known in Phase E (tailnet IPs) or Phase C
 * (preauth keys). Grep-able, never valid in a live config.
 */
export const placeholder = {
  tailnetIp: (nodeKey: string) => `{{TAILNET_IP:${nodeKey}}}`,
  tsAuthkey: (nodeKey: string) => `{{TS_AUTHKEY:${nodeKey}}}`,
};

export interface GenerateKeysOutput {
  nodeIds: Record<string, string>;
  /** name → address for operator + generated initial accounts. */
  accounts: Record<string, string>;
  sshPublicKey: string;
  ageRecipient: string;
}

const masterKey = "val-0";

function masterHome(ctx: StepCtx): string {
  return ctx.dirs.node(masterKey);
}

export const validateSpecStep: StepDef = {
  name: "validate-spec",
  async run(ctx) {
    const result = validateSpec(ctx.spec);
    if (!result.ok) {
      throw new Error(
        "spec invalid: " + result.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
      );
    }
    for (const w of result.warnings) ctx.log(`warning: ${w.path}: ${w.message}`);
    return result;
  },
};

export const generateKeysStep: StepDef = {
  name: "generate-keys",
  async run(ctx): Promise<GenerateKeysOutput> {
    const { spec, dirs } = ctx;
    const cid = chainId(spec);
    fs.mkdirSync(dirs.secrets, { recursive: true, mode: 0o700 });

    // SSH keypair — user-supplied public key wins (spec §4 security.sshPublicKey)
    let sshPublicKey = spec.security.sshPublicKey;
    if (!sshPublicKey) {
      const pair = generateSshKeypair(`launch-${ctx.launchId}`);
      fs.writeFileSync(path.join(dirs.secrets, "ssh_ed25519.pem"), pair.privateKeyPem, {
        mode: 0o600,
      });
      fs.writeFileSync(path.join(dirs.secrets, "ssh_ed25519.pub"), pair.publicKeyOpenssh);
      sshPublicKey = pair.publicKeyOpenssh;
    }

    // age keypair for headscale backup (§3)
    const age = generateAgeKeypair();
    fs.writeFileSync(
      path.join(dirs.secrets, "age.txt"),
      `# recipient: ${age.recipient}\n${age.identity}\n`,
      { mode: 0o600 },
    );

    // Node homes: init creates node_key, priv_validator_key, genesis skeleton
    const nodeIds: Record<string, string> = {};
    for (const node of nodes(spec)) {
      const home = dirs.node(node.key);
      if (!fs.existsSync(path.join(home, "config", "node_key.json"))) {
        await sparkdreamd([
          "init",
          node.moniker,
          "--chain-id",
          cid,
          "--default-denom",
          spec.token.bondDenom ?? spec.token.baseDenom,
          "--home",
          home,
        ]);
      }
      const { stdout } = await sparkdreamd(["comet", "show-node-id", "--home", home]);
      nodeIds[node.key] = stdout.trim();
    }

    // Operator + generated accounts live in the master keyring (test backend)
    const accounts: Record<string, string> = {};
    const addAccount = async (name: string) => {
      const { stdout } = await sparkdreamd([
        "keys",
        "add",
        name,
        "--keyring-backend",
        "test",
        "--home",
        masterHome(ctx),
        "--output",
        "json",
      ]);
      const parsed = JSON.parse(stdout) as { address: string; mnemonic: string };
      if (!parsed.address.startsWith(spec.network.bech32Prefix + "1")) {
        throw new Error(
          `binary produced address ${parsed.address} but spec.network.bech32Prefix is ` +
            `"${spec.network.bech32Prefix}" — fix the spec (the chain binary's prefix is baked in)`,
        );
      }
      accounts[name] = parsed.address;
      return parsed;
    };

    const mnemonics: Record<string, string> = {};
    for (let v = 0; v < spec.topology.validators.count; v++) {
      const parsed = await addAccount(`op-val-${v}`);
      mnemonics[`op-val-${v}`] = parsed.mnemonic;
    }
    for (const acct of spec.accounts.initial) {
      if (acct.generate) {
        const parsed = await addAccount(`acct-${acct.name}`);
        mnemonics[`acct-${acct.name}`] = parsed.mnemonic;
      }
    }
    // Plaintext on local disk for M1; M6 moves this into encrypted db columns.
    fs.writeFileSync(path.join(dirs.secrets, "mnemonics.json"), JSON.stringify(mnemonics, null, 2), {
      mode: 0o600,
    });

    return { nodeIds, accounts, sshPublicKey, ageRecipient: age.recipient };
  },
};

export const buildGenesisStep: StepDef = {
  name: "build-genesis",
  async run(ctx) {
    const { spec, dirs } = ctx;
    const cid = chainId(spec);
    const keys = ctx.output<GenerateKeysOutput>("generate-keys");
    if (!keys) throw new Error("generate-keys output missing");
    const master = masterHome(ctx);
    const genesisPath = path.join(master, "config", "genesis.json");
    const bondDenom = spec.token.bondDenom ?? spec.token.baseDenom;

    // 1. chain params + denoms directly onto genesis JSON
    const genesis = JSON.parse(fs.readFileSync(genesisPath, "utf8"));
    applyChainParams(genesis, spec);
    fs.writeFileSync(genesisPath, JSON.stringify(genesis, null, 2));

    // 2. genesis accounts: initial allocations + operator self-delegation funds
    const addGenesisAccount = (address: string, amount: string) =>
      sparkdreamd([
        "genesis",
        "add-genesis-account",
        address,
        `${amount}${spec.token.baseDenom}`,
        "--home",
        master,
      ]);

    for (const acct of spec.accounts.initial) {
      const address = acct.address ?? keys.accounts[`acct-${acct.name}`];
      if (!address) throw new Error(`no address for account ${acct.name}`);
      await addGenesisAccount(address, acct.amount);
    }
    for (let v = 0; v < spec.topology.validators.count; v++) {
      await addGenesisAccount(
        keys.accounts[`op-val-${v}`]!,
        spec.accounts.validatorSelfDelegation,
      );
    }

    // 3. one gentx per validator, each against its own home (its consensus key)
    //    but the master keyring (operator keys live there)
    const gentxDir = path.join(master, "config", "gentx");
    fs.mkdirSync(gentxDir, { recursive: true });
    const commission = commissionFlags(spec);
    for (let v = 0; v < spec.topology.validators.count; v++) {
      const home = dirs.node(`val-${v}`);
      if (v !== 0) {
        fs.copyFileSync(genesisPath, path.join(home, "config", "genesis.json"));
      }
      await sparkdreamd([
        "genesis",
        "gentx",
        `op-val-${v}`,
        `${spec.accounts.validatorSelfDelegation}${bondDenom}`,
        "--chain-id",
        cid,
        "--moniker",
        `${spec.network.name}-val-${v}`,
        "--commission-rate",
        commission.rate,
        "--commission-max-rate",
        commission.maxRate,
        "--commission-max-change-rate",
        commission.maxChangeRate,
        "--home",
        home,
        "--keyring-backend",
        "test",
        "--keyring-dir",
        master,
        "--output-document",
        path.join(gentxDir, `gentx-val-${v}.json`),
      ]);
    }

    // 4. collect + validate, then distribute the final genesis everywhere
    await sparkdreamd(["genesis", "collect-gentxs", "--home", master]);
    await sparkdreamd(["genesis", "validate", genesisPath]);
    for (const node of nodes(spec)) {
      if (node.key === masterKey) continue;
      fs.copyFileSync(genesisPath, path.join(dirs.node(node.key), "config", "genesis.json"));
    }

    const final = JSON.parse(fs.readFileSync(genesisPath, "utf8"));
    return {
      chainId: cid,
      genesisSha256: await sha256File(genesisPath),
      gentxCount: (final.app_state?.genutil?.gen_txs ?? []).length,
    };
  },
};

async function sha256File(p: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export const renderConfigsStep: StepDef = {
  name: "render-configs",
  async run(ctx) {
    const keys = ctx.output<GenerateKeysOutput>("generate-keys");
    if (!keys) throw new Error("generate-keys output missing");
    const topo = resolveTopology(ctx.spec);
    for (const node of nodes(ctx.spec)) {
      renderNodeConfigs({
        spec: ctx.spec,
        node,
        home: ctx.dirs.node(node.key),
        nodeIds: keys.nodeIds,
        topology: topo,
        tailnetIpPlaceholder: placeholder.tailnetIp,
      });
    }
    return { rendered: nodes(ctx.spec).map((n) => n.key) };
  },
};

export const packageNodeDataStep: StepDef = {
  name: "package-node-data",
  async run(ctx) {
    const { spec, dirs } = ctx;
    fs.mkdirSync(dirs.bundles, { recursive: true });
    const bundles: Record<string, string> = {};
    for (const node of nodes(spec)) {
      const out = path.join(dirs.bundles, `${node.key}.tgz`);
      const args = ["czf", out, "-C", dirs.node(node.key)];
      // tmkms mode: consensus keys never leave the launcher (§3)
      if (node.role === "validator" && spec.security.keyMode === "tmkms") {
        args.push("--exclude", "config/priv_validator_key.json");
      }
      // keyring + gentx are launcher-side artifacts, not node runtime state
      args.push("--exclude", "config/gentx", "--exclude", "keyring-test", "config", "data");
      await run("tar", args);
      bundles[node.key] = out;
    }
    return { bundles };
  },
};

export const renderSdlsStep: StepDef = {
  name: "render-sdls",
  async run(ctx) {
    const keys = ctx.output<GenerateKeysOutput>("generate-keys");
    if (!keys) throw new Error("generate-keys output missing");
    fs.mkdirSync(ctx.dirs.sdl, { recursive: true });
    const topo = resolveTopology(ctx.spec);
    const written: string[] = [];
    for (const node of nodes(ctx.spec)) {
      const outPath = path.join(ctx.dirs.sdl, `${node.key}.yaml`);
      renderNodeSdl({
        spec: ctx.spec,
        node,
        topology: topo,
        sshPublicKey: keys.sshPublicKey,
        outPath,
        placeholder,
      });
      written.push(outPath);
    }
    return { written };
  },
};

export function phaseASteps(): StepDef[] {
  return [
    validateSpecStep,
    generateKeysStep,
    buildGenesisStep,
    renderConfigsStep,
    packageNodeDataStep,
    renderSdlsStep,
    // estimate-costs is M2: it needs live Akash market data.
  ];
}

export type { LaunchSpec, NodeRef };
export { tunnelPort };
