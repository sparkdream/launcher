import { Registry, type EncodeObject } from "@cosmjs/proto-signing";
import { defaultRegistryTypes } from "@cosmjs/stargate";
import { akashProtoRegistry } from "@sparkdreamnft/sparkdreamjs/akash/client.js";
import { MsgCreateCertificate } from "@sparkdreamnft/sparkdreamjs/akash/cert/v1/msg.js";
import {
  MsgCloseDeployment,
  MsgCreateDeployment,
  MsgUpdateDeployment,
} from "@sparkdreamnft/sparkdreamjs/akash/deployment/v1beta4/deploymentmsg.js";
import { MsgAccountDeposit } from "@sparkdreamnft/sparkdreamjs/akash/escrow/v1/msg.js";
import { MsgCreateLease } from "@sparkdreamnft/sparkdreamjs/akash/market/v1beta5/leasemsg.js";
import { MsgMintACT } from "@sparkdreamnft/sparkdreamjs/akash/bme/v1/msgs.js";

/**
 * Shared Akash tx layer: the conductor STORES msgs as plain proto-JSON
 * (string dseqs, base64 bytes, snake_case group specs) and both signing
 * paths — CLI (conductor) and Keplr (browser) — convert them to the
 * generated sparkdreamjs types with this module. Isomorphic: no Buffer.
 */

export const TypeUrl = {
  CreateCertificate: "/akash.cert.v1.MsgCreateCertificate",
  CreateDeployment: "/akash.deployment.v1beta4.MsgCreateDeployment",
  UpdateDeployment: "/akash.deployment.v1beta4.MsgUpdateDeployment",
  CloseDeployment: "/akash.deployment.v1beta4.MsgCloseDeployment",
  CreateLease: "/akash.market.v1beta5.MsgCreateLease",
  /** escrow top-up — same message console-air uses; the network removed
   *  deployment.v1.MsgDepositDeployment. */
  AccountDeposit: "/akash.escrow.v1.MsgAccountDeposit",
  /** BME module: burn AKT → mint ACT (async settlement). */
  MintAct: "/akash.bme.v1.MsgMintACT",
  /** Bank transfer — the launch service fee rides the create-leases tx. */
  Send: "/cosmos.bank.v1beta1.MsgSend",
} as const;

export interface Msg {
  typeUrl: string;
  value: Record<string, unknown>;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// isomorphic base64 — Buffer in Node, atob/btoa in the browser
const nodeBuffer: { from(data: unknown, enc?: string): { toString(enc: string): string } } | undefined =
  (globalThis as any).Buffer;

function b64ToBytes(s: string): Uint8Array {
  if (nodeBuffer) return new Uint8Array(nodeBuffer.from(s, "base64") as unknown as Uint8Array);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  if (nodeBuffer) return nodeBuffer.from(bytes).toString("base64");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function groupSpec(g: any): any {
  return {
    name: g.name,
    requirements: {
      signedBy: {
        allOf: g.requirements?.signed_by?.all_of ?? [],
        anyOf: g.requirements?.signed_by?.any_of ?? [],
      },
      attributes: g.requirements?.attributes ?? [],
    },
    resources: (g.resources ?? []).map((r: any) => ({
      resource: {
        id: r.resource.id,
        cpu: { units: { val: utf8(r.resource.cpu.units.val) } },
        memory: { quantity: { val: utf8(r.resource.memory.quantity.val) } },
        storage: (r.resource.storage ?? []).map((s: any) => ({
          name: s.name,
          quantity: { val: utf8(s.quantity.val) },
          attributes: s.attributes ?? [],
        })),
        gpu: { units: { val: utf8(r.resource.gpu.units.val) } },
        endpoints: (r.resource.endpoints ?? []).map((e: any) => ({
          kind: e.kind ?? 0,
          sequenceNumber: e.sequence_number ?? 0,
        })),
      },
      count: r.count,
      price: r.price,
    })),
  };
}

export function toEncodeObject(msg: Msg): EncodeObject {
  const v = msg.value as any;
  switch (msg.typeUrl) {
    case TypeUrl.CreateCertificate:
      return {
        typeUrl: msg.typeUrl,
        value: MsgCreateCertificate.fromPartial({
          owner: v.owner,
          cert: b64ToBytes(v.cert),
          pubkey: b64ToBytes(v.pubkey),
        }),
      };
    case TypeUrl.CreateDeployment:
      return {
        typeUrl: msg.typeUrl,
        value: MsgCreateDeployment.fromPartial({
          id: { owner: v.id.owner, dseq: BigInt(v.id.dseq) },
          groups: v.groups.map(groupSpec),
          hash: b64ToBytes(v.hash),
          // Deposit { amount: Coin, sources: Source[] } — console-air shape
          deposit: v.deposit,
        }),
      };
    case TypeUrl.UpdateDeployment:
      return {
        typeUrl: msg.typeUrl,
        value: MsgUpdateDeployment.fromPartial({
          id: { owner: v.id.owner, dseq: BigInt(v.id.dseq) },
          hash: b64ToBytes(v.hash),
        }),
      };
    case TypeUrl.CloseDeployment:
      return {
        typeUrl: msg.typeUrl,
        value: MsgCloseDeployment.fromPartial({
          id: { owner: v.id.owner, dseq: BigInt(v.id.dseq) },
        }),
      };
    case TypeUrl.AccountDeposit:
      return {
        typeUrl: msg.typeUrl,
        value: MsgAccountDeposit.fromPartial({
          signer: v.signer,
          id: { scope: v.id.scope, xid: v.id.xid },
          deposit: v.deposit,
        }),
      };
    case TypeUrl.CreateLease:
      return {
        typeUrl: msg.typeUrl,
        value: MsgCreateLease.fromPartial({
          bidId: {
            owner: v.bidId.owner,
            dseq: BigInt(v.bidId.dseq),
            gseq: v.bidId.gseq,
            oseq: v.bidId.oseq,
            provider: v.bidId.provider,
          },
        }),
      };
    case TypeUrl.MintAct:
      return {
        typeUrl: msg.typeUrl,
        value: MsgMintACT.fromPartial({
          owner: v.owner,
          to: v.to,
          coinsToBurn: v.coins_to_burn,
        }),
      };
    case TypeUrl.Send:
      // bank MsgSend is in defaultRegistryTypes; cosmjs encodes the plain
      // camelCase shape directly (same as SigningStargateClient.sendTokens)
      return {
        typeUrl: msg.typeUrl,
        value: {
          fromAddress: v.from_address,
          toAddress: v.to_address,
          amount: v.amount,
        },
      };
    default:
      throw new Error(`no encoder for ${msg.typeUrl}`);
  }
}

/** Plain bank transfer, stored proto-JSON like every other launcher msg. */
export function sendMsg(
  from: string,
  to: string,
  coin: { denom: string; amount: string },
): Msg {
  return {
    typeUrl: TypeUrl.Send,
    value: { from_address: from, to_address: to, amount: [coin] },
  };
}

/** Mint ACT by burning AKT — `to` must equal `owner` for ACT mints. */
export function mintActMsg(owner: string, coinsToBurn: { denom: string; amount: string }): Msg {
  return {
    typeUrl: TypeUrl.MintAct,
    value: { owner, to: owner, coins_to_burn: coinsToBurn },
  };
}

export function launcherRegistry(): Registry {
  return new Registry([...defaultRegistryTypes, ...(akashProtoRegistry as any)]);
}
