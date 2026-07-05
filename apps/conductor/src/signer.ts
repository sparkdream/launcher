import { Registry, DirectSecp256k1HdWallet, type EncodeObject } from "@cosmjs/proto-signing";
import { GasPrice, SigningStargateClient, defaultRegistryTypes } from "@cosmjs/stargate";
import { akashProtoRegistry } from "@sparkdreamnft/sparkdreamjs/akash/client.js";
import { MsgCreateCertificate } from "@sparkdreamnft/sparkdreamjs/akash/cert/v1/msg.js";
import {
  MsgCloseDeployment,
  MsgCreateDeployment,
  MsgUpdateDeployment,
} from "@sparkdreamnft/sparkdreamjs/akash/deployment/v1beta4/deploymentmsg.js";
import { MsgCreateLease } from "@sparkdreamnft/sparkdreamjs/akash/market/v1beta5/leasemsg.js";
import { TypeUrl, type Msg } from "./akash/messages.js";
import type { Signer } from "./engine.js";

/**
 * Bridge from the conductor's stored proto-JSON msgs (pending_txs, plain
 * JSON: string dseqs, base64 bytes, snake_case group specs from sdl-groups)
 * to the generated sparkdreamjs types (bigint, Uint8Array, camelCase).
 * The browser path (M4) does the same conversion with the same package.
 */

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

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
          cert: b64(v.cert),
          pubkey: b64(v.pubkey),
        }),
      };
    case TypeUrl.CreateDeployment:
      return {
        typeUrl: msg.typeUrl,
        value: MsgCreateDeployment.fromPartial({
          id: { owner: v.id.owner, dseq: BigInt(v.id.dseq) },
          groups: v.groups.map(groupSpec),
          hash: b64(v.hash),
          deposit: v.deposit,
          depositor: v.depositor,
        }),
      };
    case TypeUrl.UpdateDeployment:
      return {
        typeUrl: msg.typeUrl,
        value: MsgUpdateDeployment.fromPartial({
          id: { owner: v.id.owner, dseq: BigInt(v.id.dseq) },
          hash: b64(v.hash),
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

export interface CliSignerOpts {
  mnemonic: string;
  rpcEndpoint: string;
  /** e.g. "0.025uact" */
  gasPrice: string;
  bech32Prefix?: string;
}

/**
 * M2 headless signer (§11): signs & broadcasts with a mnemonic from the
 * environment. Never used when a browser wallet drives the launch.
 */
export class CliSigner implements Signer {
  private client: SigningStargateClient | undefined;
  private address = "";

  constructor(private readonly opts: CliSignerOpts) {}

  async sign(msgs: Msg[]): Promise<string> {
    const client = await this.connect();
    const result = await client.signAndBroadcast(this.address, msgs.map(toEncodeObject), "auto");
    if (result.code !== 0) {
      throw new Error(`tx failed (code ${result.code}): ${result.rawLog ?? ""}`);
    }
    return result.transactionHash;
  }

  async ownerAddress(): Promise<string> {
    await this.connectWallet();
    return this.address;
  }

  private wallet: DirectSecp256k1HdWallet | undefined;

  private async connectWallet(): Promise<DirectSecp256k1HdWallet> {
    if (!this.wallet) {
      this.wallet = await DirectSecp256k1HdWallet.fromMnemonic(this.opts.mnemonic, {
        prefix: this.opts.bech32Prefix ?? "akash",
      });
      const [account] = await this.wallet.getAccounts();
      this.address = account!.address;
    }
    return this.wallet;
  }

  private async connect(): Promise<SigningStargateClient> {
    if (!this.client) {
      const wallet = await this.connectWallet();
      this.client = await SigningStargateClient.connectWithSigner(this.opts.rpcEndpoint, wallet, {
        registry: launcherRegistry(),
        gasPrice: GasPrice.fromString(this.opts.gasPrice),
      });
    }
    return this.client;
  }
}
