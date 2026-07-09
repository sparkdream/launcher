import { TypeUrl, type Msg } from "@sparkdream/akash-tx";

/**
 * Unsigned Akash tx message construction, ported in shape from console-air's
 * TransactionMessageData.ts (see NOTICE). Values are proto-JSON: the browser
 * (Keplr + registry) or the CLI signer encodes them via @sparkdream/akash-tx;
 * the conductor never signs. Versions per §9: deployment v1beta4, lease
 * (market) v1beta5, cert v1, escrow deposit v1.
 */

export { TypeUrl, type Msg };

export interface Coin {
  denom: string;
  amount: string;
}

/**
 * akash.base.deposit.v1 enums, stored numerically so the generated
 * fromPartial encodes them directly (proto-JSON name strings would not
 * survive telescope's fromPartial).
 */
const SOURCE = { balance: 1, grant: 2 } as const;
const SCOPE = { deployment: 1 } as const;

/** Deposit { amount, sources } — same sources console-air sends. */
function deposit(amount: Coin) {
  return { amount, sources: [SOURCE.grant, SOURCE.balance] };
}

export interface DeploymentGroup {
  /** Raw group spec produced from the SDL (chain-sdk shape). */
  [key: string]: unknown;
}

export function createCertificateMsg(owner: string, certPem: string, pubkeyPem: string): Msg {
  return {
    typeUrl: TypeUrl.CreateCertificate,
    value: {
      owner,
      cert: Buffer.from(certPem).toString("base64"),
      pubkey: Buffer.from(pubkeyPem).toString("base64"),
    },
  };
}

export function createDeploymentMsg(input: {
  owner: string;
  dseq: string;
  groups: DeploymentGroup[];
  /** sha256 over the sorted manifest JSON (chain-sdk generateManifestVersion). */
  hash: Uint8Array;
  deposit: Coin;
}): Msg {
  return {
    typeUrl: TypeUrl.CreateDeployment,
    value: {
      id: { owner: input.owner, dseq: input.dseq },
      groups: input.groups,
      hash: Buffer.from(input.hash).toString("base64"),
      deposit: deposit(input.deposit),
    },
  };
}

export function closeDeploymentMsg(owner: string, dseq: string): Msg {
  return {
    typeUrl: TypeUrl.CloseDeployment,
    value: { id: { owner, dseq } },
  };
}

export interface BidId {
  owner: string;
  dseq: string;
  gseq: number;
  oseq: number;
  provider: string;
}

export function createLeaseMsg(bidId: BidId): Msg {
  return {
    typeUrl: TypeUrl.CreateLease,
    value: { bidId: { ...bidId } },
  };
}

/** Escrow top-up — mirrors console-air's getDepositDeploymentMsg. */
export function accountDepositMsg(owner: string, dseq: string, amount: Coin): Msg {
  return {
    typeUrl: TypeUrl.AccountDeposit,
    value: {
      signer: owner,
      id: { scope: SCOPE.deployment, xid: `${owner}/${dseq}` },
      deposit: deposit(amount),
    },
  };
}
