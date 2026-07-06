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
      deposit: input.deposit,
      depositor: input.owner,
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

export function accountDepositMsg(owner: string, dseq: string, amount: Coin): Msg {
  return {
    typeUrl: TypeUrl.AccountDeposit,
    value: {
      id: { scope: "deployment", xid: `${owner}/${dseq}` },
      depositor: owner,
      deposit: {
        amount,
        sources: ["grant", "balance"],
      },
    },
  };
}
