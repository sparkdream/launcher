import fs from "node:fs";
import path from "node:path";
import {
  chainId,
  nodes,
  resolveTopology,
  statelessComponents,
  tunnelPort,
  validateSpec,
  type LaunchSpec,
  type NodeRef,
} from "@sparkdream/launch-spec";
import type { StepCtx, StepDef } from "../engine.js";
import { writeSecretFile } from "../secrets.js";
import { sparkdreamd, run } from "../exec.js";
import { generateAgeKeypair, generateSshKeypair } from "../keys.js";
import {
  applyChainParams,
  applyFoundingMembers,
  applyGenesisMembers,
  applyReferenceGenesis,
  commissionFlags,
} from "../genesis-params.js";
import {
  assembleGentxJson,
  buildGentxSignDoc,
  verifySignedDoc,
  type GentxInputs,
  type GentxSignResponse,
} from "../gentx.js";
import { renderNodeConfigs } from "../render-configs.js";
import { fetchJoinGenesis, resolveStateSyncTrust } from "./join.js";
import { referenceGenesisPath } from "../vendor.js";
import { renderNodeSdl } from "../render-sdl.js";
import { renderComponentSdl } from "../render-component-sdl.js";

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
  /** name → address for operator + generated initial accounts. External
   *  operators appear here too (op-val-N → supplied address). */
  accounts: Record<string, string>;
  /** val key → base64 ed25519 consensus pubkey (comet show-validator). */
  consensusPubkeys: Record<string, string>;
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
    // fail fast on unpublished images — otherwise the pods ImagePullBackOff
    // silently 15 steps later, after real deposits are on-chain
    for (const image of Object.values(ctx.spec.images).filter((i): i is string => Boolean(i))) {
      if (await dockerHubTagMissing(ctx, image)) {
        throw new Error(
          `image ${image} not found on Docker Hub — push it (chain repo: ` +
            `make docker-build-*-ssh VERSION=<tag> && docker push) or override spec.images`,
        );
      }
    }
    return result;
  },
};

/**
 * True only when the image is a Docker Hub `ns/repo:tag` reference AND the
 * registry positively reports the tag absent (404). Network errors and
 * other registries return false — a fail-fast convenience, not a gate.
 */
async function dockerHubTagMissing(ctx: StepCtx, image: string): Promise<boolean> {
  const m = /^([a-z0-9-]+)\/([a-z0-9-_.]+):([\w.-]+)$/.exec(image);
  if (!m) return false;
  const status = await ctx.services.rpc.httpStatus(
    `https://hub.docker.com/v2/repositories/${m[1]}/${m[2]}/tags/${m[3]}`,
  );
  return status === 404;
}

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
      writeSecretFile(path.join(dirs.secrets, "ssh_ed25519.pem"), pair.privateKeyPem);
      fs.writeFileSync(path.join(dirs.secrets, "ssh_ed25519.pub"), pair.publicKeyOpenssh);
      sshPublicKey = pair.publicKeyOpenssh;
    }

    // age keypair for headscale backup (§3)
    const age = generateAgeKeypair();
    writeSecretFile(
      path.join(dirs.secrets, "age.txt"),
      `# recipient: ${age.recipient}\n${age.identity}\n`,
    );

    // Node homes: init creates node_key, priv_validator_key, genesis skeleton
    const nodeIds: Record<string, string> = {};
    const consensusPubkeys: Record<string, string> = {};
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
      if (node.role === "validator") {
        const { stdout: pub } = await sparkdreamd(["comet", "show-validator", "--home", home]);
        consensusPubkeys[node.key] = (JSON.parse(pub) as { key: string }).key;
      }
    }

    const accounts = await createNamedAccounts(ctx);

    return { nodeIds, accounts, consensusPubkeys, sshPublicKey, ageRecipient: age.recipient };
  },
};

/**
 * Operator + generated accounts in the master keyring (test backend), with
 * their mnemonics persisted to secrets/. Shared by generate-keys and the
 * reset-chain fleet op, which wipes the keyring first and reruns this
 * against the (possibly edited) account list.
 */
export async function createNamedAccounts(ctx: StepCtx): Promise<Record<string, string>> {
  const { spec, dirs } = ctx;
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
  const operators = spec.topology.validators.operators;
  for (let v = 0; v < spec.topology.validators.count; v++) {
    if (Array.isArray(operators)) {
      // external operators (§3): address supplied, key never exists here
      accounts[`op-val-${v}`] = operators[v]!;
    } else {
      const parsed = await addAccount(`op-val-${v}`);
      mnemonics[`op-val-${v}`] = parsed.mnemonic;
    }
  }
  for (const acct of spec.accounts.initial) {
    if (acct.generate) {
      const parsed = await addAccount(`acct-${acct.name}`);
      mnemonics[`acct-${acct.name}`] = parsed.mnemonic;
    }
  }
  // Plaintext on local disk for M1; M6 moves this into encrypted db columns.
  writeSecretFile(path.join(dirs.secrets, "mnemonics.json"), JSON.stringify(mnemonics, null, 2));
  return accounts;
}

export const buildGenesisStep: StepDef = {
  name: "build-genesis",
  async run(ctx) {
    // join mode: the chain exists — download + verify its genesis instead
    // of building one (same output shape, so consumers don't branch)
    if (ctx.spec.join) return fetchJoinGenesis(ctx);
    const keys = ctx.output<GenerateKeysOutput>("generate-keys");
    if (!keys) throw new Error("generate-keys output missing");
    return buildGenesisFiles(ctx, keys);
  },
};

/**
 * The genesis pipeline (§5 step 3): reference overlay + members + chain
 * params onto the master's init skeleton, genesis accounts, one gentx per
 * validator (locally signed or browser-signed with verification), collect,
 * validate, distribute to every node home. Shared by build-genesis and the
 * reset-chain fleet op, which re-runs it against a fresh skeleton with a
 * bumped chain-id.
 */
export async function buildGenesisFiles(
  ctx: StepCtx,
  keys: GenerateKeysOutput,
): Promise<{ chainId: string; genesisSha256: string; gentxCount: number }> {
  const { spec, dirs } = ctx;
  const cid = chainId(spec);
  const master = masterHome(ctx);
  const genesisPath = path.join(master, "config", "genesis.json");
  const bondDenom = spec.token.bondDenom ?? spec.token.baseDenom;

  // 1. reference-network genesis overlay, then spec overrides on top
  const genesis = JSON.parse(fs.readFileSync(genesisPath, "utf8"));
  const reference = JSON.parse(
    fs.readFileSync(referenceGenesisPath(spec.network.type), "utf8"),
  );
  applyReferenceGenesis(genesis, reference, spec);
  applyGenesisMembers(genesis, reference, spec, keys.accounts);
  applyFoundingMembers(genesis, spec, keys.accounts);
  applyChainParams(genesis, spec);
  fs.writeFileSync(genesisPath, JSON.stringify(genesis, null, 2));

  // 2. genesis accounts: initial allocations + operator self-delegation
  //    funds. Idempotent: this step re-runs after every gentx pause in
  //    external-operator mode, so skip accounts already present.
  const hasAccount = (address: string): boolean => {
    const g = JSON.parse(fs.readFileSync(genesisPath, "utf8"));
    return (g.app_state?.bank?.balances ?? []).some((b: any) => b.address === address);
  };
  const addGenesisAccount = async (address: string, amount: string) => {
    if (hasAccount(address)) return;
    await sparkdreamd([
      "genesis",
      "add-genesis-account",
      address,
      `${amount}${spec.token.baseDenom}`,
      "--home",
      master,
    ]);
  };

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

  // 3. one gentx per validator — locally signed (generated operators) or
  //    browser-signed with verification (external operators, §5 step 3b)
  const gentxDir = path.join(master, "config", "gentx");
  fs.mkdirSync(gentxDir, { recursive: true });
  const operators = spec.topology.validators.operators;
  for (let v = 0; v < spec.topology.validators.count; v++) {
    const home = dirs.node(`val-${v}`);
    if (v !== 0) {
      fs.copyFileSync(genesisPath, path.join(home, "config", "genesis.json"));
    }
    const outputDocument = path.join(gentxDir, `gentx-val-${v}.json`);

    if (Array.isArray(operators)) {
      const inputs: GentxInputs = {
        spec,
        valIndex: v,
        operatorAddress: operators[v]!,
        consensusPubkey: keys.consensusPubkeys[`val-${v}`]!,
        nodeId: keys.nodeIds[`val-${v}`]!,
        chainId: cid,
      };
      const signDoc = buildGentxSignDoc(inputs);
      const responseJson = ctx.requireGentx(v, operators[v]!, JSON.stringify(signDoc));
      const response = JSON.parse(responseJson) as GentxSignResponse;
      const verdict = await verifySignedDoc(signDoc, response, operators[v]!);
      if (!verdict.ok) {
        // never let a bad signature into genesis — it bricks block 1
        ctx.db.resetGentx(ctx.launchId, v);
        throw new Error(`gentx signature for validator ${v} rejected: ${verdict.reason}`);
      }
      fs.writeFileSync(outputDocument, assembleGentxJson(inputs, response));
      continue;
    }

    const commission = commissionFlags(spec);
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
      outputDocument,
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
}

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
    // join mode: sentries boot with [statesync] pointed at the network —
    // the trust anchor is resolved live, cross-checked across two RPCs
    const stateSync = ctx.spec.join ? await resolveStateSyncTrust(ctx) : undefined;
    for (const node of nodes(ctx.spec)) {
      renderNodeConfigs({
        spec: ctx.spec,
        node,
        home: ctx.dirs.node(node.key),
        nodeIds: keys.nodeIds,
        topology: topo,
        tailnetIpPlaceholder: placeholder.tailnetIp,
        ...(stateSync ? { join: { peers: ctx.spec.join!.peers, stateSync } } : {}),
      });
    }
    return { rendered: nodes(ctx.spec).map((n) => n.key), ...(stateSync ? { stateSync } : {}) };
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
    for (const component of statelessComponents(ctx.spec)) {
      const outPath = path.join(ctx.dirs.sdl, `${component.key}.yaml`);
      renderComponentSdl({
        spec: ctx.spec,
        component,
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
