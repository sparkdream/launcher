import { Registry, type EncodeObject } from "@cosmjs/proto-signing";
import { defaultRegistryTypes } from "@cosmjs/stargate";
import { akashProtoRegistry } from "@sparkdreamnft/sparkdreamjs/akash/client.js";
import { MsgCreateCertificate } from "@sparkdreamnft/sparkdreamjs/akash/cert/v1/msg.js";
import {
  MsgCloseDeployment,
  MsgCreateDeployment,
  MsgUpdateDeployment,
} from "@sparkdreamnft/sparkdreamjs/akash/deployment/v1beta4/deploymentmsg.js";
import { MsgCreateLease } from "@sparkdreamnft/sparkdreamjs/akash/market/v1beta5/leasemsg.js";

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
  AccountDeposit: "/akash.escrow.v1.MsgAccountDeposit",
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
          deposit: v.deposit,
          depositor: v.depositor,
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
    default:
      // escrow top-up (M5) stays unresolved until the network's proto
      // generation is pinned (MsgDepositDeployment vs MsgAccountDeposit)
      throw new Error(`no encoder for ${msg.typeUrl}`);
  }
}

export function launcherRegistry(): Registry {
  return new Registry([...defaultRegistryTypes, ...(akashProtoRegistry as any)]);
}
