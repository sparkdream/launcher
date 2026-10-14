import type { LaunchSpec } from "@sparkdream/launch-spec";
import { scannerFeedUrl } from "../components/scanner.js";
import {
  SCANNER_OPERATOR,
  ensureVerdictSeed,
  verdictPublicKey,
  writeScannerOperatorAddress,
} from "../components/scanner-secrets.js";
import { AwaitUser, WALLET_SIGNER, type StepCtx, type StepDef } from "../engine.js";
import { fleetActor, sendTx, walletPause, type ChainActor } from "../peering.js";
import { ensureSession, sessionReserve, sessionSpendLimit } from "../sessions.js";
import { ensureOperatorKey } from "./mastodon.js";
import { queryJson } from "./phase-g.js";

/** The x/service type a scanner registers under (seeded at chain genesis). */
export const SCANNER_SERVICE_TYPE = "content-scanner";

const ADDRESS = /^[a-z]+1[02-9ac-hj-np-z]{38,58}$/;

/** Gas of MsgRegisterOperator (the bond moves into escrow). */
const REGISTER_GAS = 400_000;

/**
 * The scanner operator's key, in the master keyring and mnemonics.json like
 * the bridge operator's (ensureOperatorKey): kept across a chain reset, so
 * the running scanner's CS_GRANTER and its feed's worker address hold.
 */
export function ensureScannerOperatorKey(secretsDir: string, masterHome: string): Promise<string> {
  return ensureOperatorKey(secretsDir, masterHome, SCANNER_OPERATOR, (a) => writeScannerOperatorAddress(secretsDir, a));
}

/**
 * The operator metadata frontends read the scanner from
 * (contentscan.OperatorMetadata): its verdict key and feed URL.
 */
export function scannerMetadata(spec: LaunchSpec, secretsDir: string): Record<string, unknown> {
  return {
    v: 1,
    verdict_key: verdictPublicKey(ensureVerdictSeed(secretsDir)),
    feed_url: scannerFeedUrl(spec),
    ruleset_version: spec.topology.components.scanner!.rulesetVersion,
  };
}

/** Whether stored metadata (base64 JSON, as the LCD prints bytes) already
 *  says what `want` does. */
function metadataMatches(storedB64: string | undefined, want: Record<string, unknown>): boolean {
  try {
    const have = JSON.parse(Buffer.from(storedB64 ?? "", "base64").toString("utf8")) as Record<string, unknown>;
    return ["verdict_key", "feed_url", "ruleset_version"].every((k) => have[k] === want[k]);
  } catch {
    return false;
  }
}

/** The controller's policy address: given as one, or a commons group's. */
async function resolveController(chain: ChainActor, controller: string): Promise<string> {
  if (ADDRESS.test(controller)) return controller;
  const out = await queryJson(["query", "commons", "get-group", controller], chain.rpc).catch(() => undefined);
  const address = out?.group?.policy_address;
  if (!address) {
    throw new Error(`${chain.label} has no commons group "${controller}": set scanner.controller to a group name or policy address`);
  }
  return address;
}

/** The operator record, or undefined when the chain has none. */
async function queryOperator(chain: ChainActor, address: string): Promise<any | undefined> {
  try {
    const out = await queryJson(["query", "service", "operator", address, SCANNER_SERVICE_TYPE], chain.rpc);
    return out.operator;
  } catch (e) {
    if (/not found|NotFound|code = 5/i.test(String(e))) return undefined;
    throw e;
  }
}

/** OperatorStatus as the CLI prints it: a name, or a number. */
function statusName(raw: unknown): string {
  const names = ["UNSPECIFIED", "ACTIVE", "UNDERFUNDED", "UNBONDING", "SLASHED", "RETIRED"];
  const s = String(raw ?? "");
  return /^[0-9]+$/.test(s) ? names[Number(s)] ?? s : s.replace("OPERATOR_STATUS_", "");
}

/**
 * Register the fleet's scanner as an x/service content-scanner operator on
 * this chain: its own key bonds the service type's min_bond under the
 * spec's controller council and publishes the verdict key and feed URL as
 * metadata, which frontends read to trust its verdicts. Once registered,
 * only the metadata is kept current (a domain retarget changes the feed
 * URL); the controller and bond are the chain's business from then on.
 * Skipped when nothing changed, so it re-runs after every placement.
 */
export async function registerScanner(
  ctx: StepCtx,
  stepName: string,
  spec: LaunchSpec,
): Promise<{ operator: string; status: string; registered: boolean; metadataUpdated: boolean }> {
  const s = spec.topology.components.scanner!;
  const chain = await fleetActor(ctx, ctx.launchId, "this fleet");
  const operator = await ensureScannerOperatorKey(ctx.dirs.secrets, ctx.dirs.node("val-0"));
  const signer: ChainActor = { ...chain, signer: { home: ctx.dirs.node("val-0"), key: SCANNER_OPERATOR, address: operator } };
  const metadata = scannerMetadata(spec, ctx.dirs.secrets);
  const metadataB64 = Buffer.from(JSON.stringify(metadata)).toString("base64");

  const current = await queryOperator(chain, operator);
  if (current) {
    const status = statusName(current.status);
    if (status === "UNBONDING") {
      throw new AwaitUser(
        stepName,
        `the scanner operator ${operator} is unbonding on ${chain.chainId}: its verdicts no longer count. ` +
          "Let the unbonding finish and claim the bond (x/service claim-unbonded-bond), then resume to register again",
      );
    }
    if (status === "UNDERFUNDED") {
      ctx.log(`scanner: operator ${operator} is UNDERFUNDED: top up its bond (x/service top-up-bond) before the grace period ends`);
    }
    if (metadataMatches(current.metadata, metadata)) return { operator, status, registered: false, metadataUpdated: false };
    await sendTx(ctx, signer, `${chain.chainId}-scanner-metadata`, [
      { "@type": "/sparkdream.service.v1.MsgUpdateMetadata", operator, service_type: SCANNER_SERVICE_TYPE, new_metadata: metadataB64 },
    ]);
    ctx.log(`scanner: operator ${operator} metadata updated (feed ${metadata.feed_url})`);
    return { operator, status, registered: false, metadataUpdated: true };
  }

  const serviceType = await queryJson(["query", "service", "service-type", SCANNER_SERVICE_TYPE], chain.rpc);
  if (serviceType.config?.enabled === false) {
    throw new AwaitUser(stepName, `${chain.chainId} has the ${SCANNER_SERVICE_TYPE} service type disabled: governance has to enable it first`);
  }
  const bond = String(serviceType.config?.min_bond_amount ?? "0");
  const controller = await resolveController(chain, s.controller);

  const balances = await queryJson(["query", "bank", "balances", operator], chain.rpc);
  const have = BigInt((balances.balances ?? []).find((b: { denom: string }) => b.denom === chain.gasDenom)?.amount ?? "0");
  // the bond + its tx fee, the session key's reserve once the bond is
  // locked, and a few whole tokens of headroom for metadata updates and
  // renewals (one ask, a round amount), as for the bridge operator
  const headroom = 5n * 10n ** BigInt(spec.token.exponent ?? 6);
  const need =
    BigInt(bond) +
    BigInt(Math.ceil(chain.gasPrice * REGISTER_GAS)) +
    sessionReserve(chain.gasPrice, sessionSpendLimit(spec, "scanner")) +
    headroom;
  if (have < need) {
    throw await walletPause(
      ctx,
      stepName,
      chain,
      `fund the scanner operator ${operator} with ${need - have} ${chain.gasDenom} (bond ${bond}, gas and its session key's reserve; it holds ${have})`,
      [
        {
          "@type": "/cosmos.bank.v1beta1.MsgSend",
          from_address: WALLET_SIGNER,
          to_address: operator,
          amount: [{ denom: chain.gasDenom, amount: (need - have).toString() }],
        },
      ],
      { signerRole: `an account holding ${chain.gasDenom}` },
    );
  }
  await sendTx(
    ctx,
    signer,
    `${chain.chainId}-register-scanner`,
    [
      {
        "@type": "/sparkdream.service.v1.MsgRegisterOperator",
        creator: operator,
        service_type: SCANNER_SERVICE_TYPE,
        controller,
        bond_amount: bond,
        metadata: metadataB64,
      },
    ],
    { gas: REGISTER_GAS },
  );
  ctx.log(`scanner: operator ${operator} bonded ${bond} as ${SCANNER_SERVICE_TYPE} under ${controller} (feed ${metadata.feed_url})`);
  return { operator, status: "ACTIVE", registered: true, metadataUpdated: false };
}

/** Launch step: register an enabled scanner once its chain is up. */
export const configureScannerStep: StepDef = {
  name: "configure-scanner",
  async run(ctx) {
    if (!ctx.spec.topology.components.scanner?.enabled) return { skipped: true };
    const registered = await registerScanner(ctx, "configure-scanner", ctx.spec);
    return { ...registered, session: await ensureSession(ctx, ctx.spec, "scanner") };
  },
};
