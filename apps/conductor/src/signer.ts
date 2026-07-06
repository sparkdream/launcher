import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice, SigningStargateClient } from "@cosmjs/stargate";
import { launcherRegistry, toEncodeObject, type Msg } from "@sparkdream/akash-tx";
import type { Signer } from "./engine.js";

export { toEncodeObject, launcherRegistry };

export interface CliSignerOpts {
  mnemonic: string;
  rpcEndpoint: string;
  /** e.g. "0.025uact" */
  gasPrice: string;
  bech32Prefix?: string;
}

/**
 * M2 headless signer (§11): signs & broadcasts with a mnemonic from the
 * environment. Never used when a browser wallet drives the launch — the
 * web UI signs with Keplr through the same @sparkdream/akash-tx layer.
 */
export class CliSigner implements Signer {
  private client: SigningStargateClient | undefined;
  private wallet: DirectSecp256k1HdWallet | undefined;
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
