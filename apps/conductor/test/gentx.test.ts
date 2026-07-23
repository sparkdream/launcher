import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Secp256k1HdWallet, type StdSignDoc } from "@cosmjs/amino";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { fileURLToPath } from "node:url";
import { makeSignDoc } from "@cosmjs/amino";
import { Decimal } from "@cosmjs/math";
import { encodePubkey } from "@cosmjs/proto-signing";
import { AminoTypes, createDefaultAminoConverters } from "@cosmjs/stargate";
import { verifyAminoSignature } from "../src/amino-verify.js";
import { ConductorDb } from "../src/db.js";
import { launchDirs, runWithSigner, type GentxSigner } from "../src/engine.js";
import {
  buildGentxSignDoc,
  gentxResponseFromSignedTx,
  unsignedTxJsonFromSignDoc,
  verifySignedDoc,
  type GentxInputs,
} from "../src/gentx.js";
import { allSteps } from "../src/index.js";
import { fakeServices, FakeSigner, keplrSignAmino, keplrSortObjectByKey } from "./fakes.js";

/**
 * External-operator gentx flow (§5 step 3b), end to end: the "wallet" signs
 * with cosmjs but answers in Keplr's response shape (key-sorted signed doc —
 * see keplrSignAmino in fakes), and genesis is validated by the real
 * sparkdreamd.
 */

// throwaway test vector — never funded
const OPERATOR_MNEMONIC =
  "surround miss nominee dream gap cross assault thank captain prosper drop duty group candy wealth weather scale put";
const PREFIX = "sprkdrm";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-gentx-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function operatorWallet(mnemonic = OPERATOR_MNEMONIC) {
  const wallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix: PREFIX });
  const [account] = await wallet.getAccounts();
  return { wallet, address: account!.address };
}

function externalSpec(operatorAddress: string): LaunchSpec {
  return testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: PREFIX },
    topology: {
      validators: { count: 1, operators: [operatorAddress] },
      sentries: { count: 1 },
      components: {
        explorer: { enabled: false },
        frontend: { enabled: false },
        hub: { enabled: false },
      },
      headscale: { domain: "headscale.sparkdream.io" },
    },
  });
}

function walletGentxSigner(wallet: Secp256k1HdWallet, signAs: string): GentxSigner {
  return {
    async signGentx(signDocJson: string): Promise<string> {
      return keplrSignAmino(wallet, signAs, signDocJson);
    },
  };
}

describe("verifySignedDoc vs the wallet's returned doc", () => {
  const inputs = (address: string): GentxInputs => ({
    spec: externalSpec(address),
    valIndex: 0,
    operatorAddress: address,
    consensusPubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", // 32 zero bytes
    nodeId: "d765bd2f17896c96646d2dfa82e80b0b60702522",
    chainId: "sparkdream-1",
  });

  it("accepts Keplr's key-sorted signed doc (the 2026-07-22 false rejection)", async () => {
    const { wallet, address } = await operatorWallet();
    const doc = buildGentxSignDoc(inputs(address));
    // the premise of the incident: Keplr's sort really does reorder the msgs
    const keplrSigned = keplrSortObjectByKey(doc);
    expect(JSON.stringify(keplrSigned.msgs)).not.toBe(JSON.stringify(doc.msgs));
    const { signature } = await wallet.signAmino(address, doc);
    const verdict = await verifySignedDoc(doc, { signed: keplrSigned, signature }, address);
    expect(verdict).toEqual({ ok: true });
  });

  it("rejects a tampered msg value and names the differing field", async () => {
    const { wallet, address } = await operatorWallet();
    const doc = buildGentxSignDoc(inputs(address));
    const { signature } = await wallet.signAmino(address, doc);
    const tampered = keplrSortObjectByKey(doc);
    tampered.msgs[0].value.commission.rate = "0.990000000000000000";
    const verdict = await verifySignedDoc(doc, { signed: tampered, signature }, address);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("msgs[0].value.commission.rate");
  });

  it("rejects a fee amount drift and names the coin", async () => {
    const { wallet, address } = await operatorWallet();
    const doc = buildGentxSignDoc(inputs(address));
    const { signature } = await wallet.signAmino(address, doc);
    const drifted = keplrSortObjectByKey(doc);
    drifted.fee.amount = [{ denom: "uspark.sparkdreamtest", amount: "5" }];
    const verdict = await verifySignedDoc(doc, { signed: drifted, signature }, address);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("fee.amount");
  });
});

describe("sign-doc rendering matches the chain's amino encoding", () => {
  // The chain regenerates gentx sign bytes with the SDK's amino-json
  // encoder, which omits empty-string fields (no amino.dont_omitempty on
  // Description's inner fields or the deprecated delegator_address). The
  // manual sparkdream-test-1 gentx — signed by sparkdreamd itself and
  // accepted by the running chain — is the ground truth: its signature
  // must verify over the omit-empty rendering with account_number 0, and
  // over nothing else.
  const genesis = JSON.parse(
    fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../vendor/sparkdream-deploy/network/testnet/genesis.json",
      ),
      "utf8",
    ),
  );
  const gentx = genesis.app_state.genutil.gen_txs[0];
  const m = gentx.body.messages[0];
  const operator = "sprkdrm1yhjdr8kxsrer3kcqpdrc2zd0kggvsj4c3vazkd";

  const aminoDoc = (accountNumber: number) => {
    const atomics = (d: string) => Decimal.fromUserInput(d, 18).atomics;
    const aminoMsg = new AminoTypes(createDefaultAminoConverters()).toAmino({
      typeUrl: "/cosmos.staking.v1beta1.MsgCreateValidator",
      value: {
        description: {
          moniker: m.description.moniker,
          identity: m.description.identity,
          website: m.description.website,
          securityContact: m.description.security_contact,
          details: m.description.details,
        },
        commission: {
          rate: atomics(m.commission.rate),
          maxRate: atomics(m.commission.max_rate),
          maxChangeRate: atomics(m.commission.max_change_rate),
        },
        minSelfDelegation: m.min_self_delegation,
        delegatorAddress: m.delegator_address,
        validatorAddress: m.validator_address,
        pubkey: encodePubkey({ type: "tendermint/PubKeyEd25519", value: m.pubkey.key }),
        value: m.value,
      },
    });
    // SDK omit-empty rendering (what buildGentxSignDoc now applies)
    const strip = (o: any): any => {
      if (Array.isArray(o)) return o.map(strip);
      if (o && typeof o === "object") {
        return Object.fromEntries(
          Object.entries(o)
            .filter(([, v]) => v !== "")
            .map(([k, v]) => [k, strip(v)]),
        );
      }
      return o;
    };
    return makeSignDoc(
      [strip(aminoMsg)],
      { amount: gentx.auth_info.fee.amount, gas: gentx.auth_info.fee.gas_limit },
      genesis.chain_id,
      gentx.body.memo,
      accountNumber,
      0,
    );
  };
  const signature = {
    pub_key: {
      type: "tendermint/PubKeySecp256k1",
      value: gentx.auth_info.signer_infos[0].public_key.key,
    },
    signature: gentx.signatures[0],
  };

  it("the historical gentx signature verifies over the omit-empty doc, account number 0", async () => {
    expect((await verifyAminoSignature(aminoDoc(0), operator, signature)).ok).toBe(true);
  });

  it("and fails over account number 2 (genesis signatures are pinned to 0)", async () => {
    expect((await verifyAminoSignature(aminoDoc(2), operator, signature)).ok).toBe(false);
  });

  it("buildGentxSignDoc emits no empty-string fields", async () => {
    const { address } = await operatorWallet();
    const doc = buildGentxSignDoc({
      spec: externalSpec(address),
      valIndex: 0,
      operatorAddress: address,
      consensusPubkey: m.pubkey.key,
      nodeId: "d765bd2f17896c96646d2dfa82e80b0b60702522",
      chainId: "sparkdream-1",
    });
    expect(JSON.stringify(doc)).not.toContain('""');
  });
});

describe("external-operator launch (1×1, browser-style gentx signing)", () => {
  it("completes with a verified, wallet-signed gentx in genesis", async () => {
    const { wallet, address } = await operatorWallet();
    const spec = externalSpec(address);
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    db.createLaunch("ext", JSON.stringify(spec), "akash1owner");

    const result = await runWithSigner(
      db,
      "ext",
      spec,
      work,
      allSteps(),
      fakeServices(),
      new FakeSigner(),
      undefined,
      walletGentxSigner(wallet, address),
    );
    if (result.status !== "completed") {
      const step = db.listSteps("ext").find((x) => x.status !== "done");
      throw new Error(`ended ${result.status} at ${step?.name}: ${step?.error}`);
    }

    const dirs = launchDirs(work, "ext");
    const genesis = JSON.parse(
      fs.readFileSync(path.join(dirs.node("val-0"), "config", "genesis.json"), "utf8"),
    );
    // the collected gentx is ours: external operator, amino sign mode
    expect(genesis.app_state.genutil.gen_txs).toHaveLength(1);
    const gentx = genesis.app_state.genutil.gen_txs[0];
    expect(gentx.body.messages[0].delegator_address).toBe(address);
    expect(gentx.auth_info.signer_infos[0].mode_info.single.mode).toBe(
      "SIGN_MODE_LEGACY_AMINO_JSON",
    );
    // operator funded at genesis
    expect(
      genesis.app_state.bank.balances.some((b: any) => b.address === address),
    ).toBe(true);

    // no operator mnemonic ever generated (§3: hardware-custody posture)
    const mnemonics = JSON.parse(
      fs.readFileSync(path.join(dirs.secrets, "mnemonics.json"), "utf8"),
    );
    expect(Object.keys(mnemonics).filter((k) => k.startsWith("op-val-"))).toEqual([]);
    db.close();
  }, 120_000);

  it("offline-signed gentx + hyphenated chain id + community pool + cosmetics + moniker", async () => {
    const { wallet, address } = await operatorWallet();
    const moniker = "🦢 Svanmøy-01 // ⚡";
    const spec = testnetSpec({
      network: { name: "sparkdream-test", type: "testnet", bech32Prefix: PREFIX },
      accounts: {
        initial: [
          {
            name: "valya",
            generate: true,
            amount: "1250000000000",
            member: {
              trustLevel: "core",
              dreamBalance: "5000000000",
              username: "valya",
              displayName: "Valya",
              achievements: ["first_spark", "genesis_founder"],
            },
            council: { founder: true },
          },
        ],
        validatorSelfDelegation: "400000000000",
        communityPool: "95000000000000",
      },
      topology: {
        validators: { count: 1, operators: [address], monikers: [moniker] },
        sentries: { count: 1 },
        components: {
          explorer: { enabled: false },
          frontend: { enabled: false },
          hub: { enabled: false },
        },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    db.createLaunch("offline", JSON.stringify(spec), "akash1owner");

    // Airgapped-machine simulation: export the unsigned tx, amino-sign the
    // doc (what `sparkdreamd tx sign --offline --sign-mode amino-json`
    // does), assemble the signed tx file, and feed it through the same
    // conversion the paste-back endpoint uses.
    const offlineSigner: GentxSigner = {
      async signGentx(signDocJson: string): Promise<string> {
        const signDoc = JSON.parse(signDocJson) as StdSignDoc;
        const unsigned = JSON.parse(unsignedTxJsonFromSignDoc(signDoc));
        const { signature } = await wallet.signAmino(address, signDoc);
        const signedTx = {
          body: unsigned.body,
          auth_info: {
            ...unsigned.auth_info,
            signer_infos: [
              {
                public_key: {
                  "@type": "/cosmos.crypto.secp256k1.PubKey",
                  key: signature.pub_key.value,
                },
                mode_info: { single: { mode: "SIGN_MODE_LEGACY_AMINO_JSON" } },
                sequence: String(signDoc.sequence),
              },
            ],
          },
          signatures: [signature.signature],
        };
        return JSON.stringify(gentxResponseFromSignedTx(signedTx, signDoc));
      },
    };

    const result = await runWithSigner(
      db, "offline", spec, work, allSteps(), fakeServices(), new FakeSigner(), undefined, offlineSigner,
    );
    if (result.status !== "completed") {
      const step = db.listSteps("offline").find((x) => x.status !== "done");
      throw new Error(`ended ${result.status} at ${step?.name}: ${step?.error}`);
    }

    const dirs = launchDirs(work, "offline");
    const genesis = JSON.parse(
      fs.readFileSync(path.join(dirs.node("val-0"), "config", "genesis.json"), "utf8"),
    );
    // hyphenated chain id straight from the name
    expect(genesis.chain_id).toBe("sparkdream-test-1");
    // the offline-signed gentx carries the custom moniker and the operator
    const gentx = genesis.app_state.genutil.gen_txs[0];
    expect(gentx.body.messages[0].description.moniker).toBe(moniker);
    expect(gentx.body.messages[0].delegator_address).toBe(address);
    // community pool: fee_pool + module account + balance + supply agree
    const denom = "uspark.sparkdreamtest";
    expect(genesis.app_state.distribution.fee_pool.community_pool).toEqual([
      { denom, amount: "95000000000000" },
    ]);
    const moduleAcct = genesis.app_state.auth.accounts.find(
      (a: any) => a["@type"] === "/cosmos.auth.v1beta1.ModuleAccount" && a.name === "distribution",
    );
    expect(moduleAcct).toBeTruthy();
    const poolBalance = genesis.app_state.bank.balances.find(
      (b: any) => b.address === moduleAcct.base_account.address,
    );
    expect(poolBalance.coins).toEqual([{ denom, amount: "95000000000000" }]);
    const supply = BigInt(
      genesis.app_state.bank.supply.find((s: any) => s.denom === denom).amount,
    );
    const balanceSum = (genesis.app_state.bank.balances as any[]).reduce(
      (sum, b) => sum + BigInt(b.coins.find((c: any) => c.denom === denom)?.amount ?? "0"),
      0n,
    );
    expect(supply).toBe(balanceSum);
    // season cosmetics seeded from the spec
    const profile = genesis.app_state.season.member_profile_map.find(
      (p: any) => p.username === "valya",
    );
    expect(profile.display_name).toBe("Valya");
    expect(profile.achievements).toEqual(["first_spark", "genesis_founder"]);
    db.close();
  }, 120_000);

  it("rejects a gentx signed by the wrong wallet and re-pauses", async () => {
    const { address } = await operatorWallet();
    const impostor = await operatorWallet(
      "special sign fit simple patrol salute grocery chicken wheat radar tonight ceiling",
    );
    const spec = externalSpec(address); // declared operator ≠ actual signer
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    db.createLaunch("bad", JSON.stringify(spec), "akash1owner");

    const result = await runWithSigner(
      db,
      "bad",
      spec,
      work,
      allSteps(),
      fakeServices(),
      new FakeSigner(),
      undefined,
      walletGentxSigner(impostor.wallet, impostor.address),
    );
    expect(result.status).toBe("paused");
    expect(result.failedStep).toBe("build-genesis");
    expect(db.getStep("bad", "build-genesis")?.error).toContain("rejected");
    // the bad response was discarded — a fresh signature is required
    expect(db.getPendingGentx("bad", 0)?.status).toBe("pending");
    db.close();
  }, 120_000);
});
