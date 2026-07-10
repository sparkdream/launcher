# SparkDream Chain Launcher

Web app that launches a complete SparkDream chain — headscale mesh network,
N validators, M sentries, block explorer, and chain frontend — onto
[Akash Network](https://akash.network) with a few choices and a few clicks.

- **~6 wallet signatures per launch.** Akash transactions are signed in the
  browser with Keplr (batched deployment and lease messages); the launcher
  never holds wallet keys or funds.
- **Automatic provider selection** — audited providers, uptime floor, lowest
  price, operator preference list, anti-affinity between chain roles.
- **Full chain bootstrap, not just deployments.** The backend generates keys,
  genesis, and node configs locally, then configures the deployed nodes over
  SSH (mesh wiring, peer config, chain start) and verifies block production.
- **Declarative and resumable.** Every launch is a `launch.yaml` spec driven
  through a checkpointed state machine — failures resume, never restart.
- **Runs anywhere** — the same container works locally (recommended for
  mainnet) or deployed on Akash.

## Running

```bash
pnpm install
npm run start   # build everything, serve UI + API on http://localhost:8080
npm run dev     # development: Next.js frontend on :3210 + conductor API on :8180 (both hot-reload)
```

Open the UI, configure your compute network (chain id, RPC/REST, denom), and
connect Keplr — all Akash transactions are signed in the browser.

## Launch fee

Launching a fleet adds a **one-time service fee of 10% of the fleet's leased
monthly rate**, computed from the actual winning bid prices and shown in the
wizard's cost table before anything is signed. Two smaller day-2 fees follow:
a flat **2 ACT per upgrade** (rolling or coordinated, once per operation) and
**0.5% of each escrow top-up**. Every fee rides a transaction you already
sign — no extra signature — and appears as a plain bank send in the Keplr
prompt, so nothing is hidden.

Self-hosters can change or disable any of them:

| env var | default | fee |
| --- | --- | --- |
| `LAUNCH_FEE_ADDRESS` | project address | recipient of all fees |
| `LAUNCH_FEE_BPS` | `1000` (10%) | launch, on the leased monthly rate |
| `LAUNCH_FEE_UPGRADE` | `2000000` (2 ACT) | flat, per upgrade op |
| `LAUNCH_FEE_TOPUP_BPS` | `50` (0.5%) | on each escrow top-up |

Set any to `0` to disable that fee.

### Running on Akash

Build the image (`Dockerfile`) and deploy with `deploy.yaml`. In Akash mode set:

- `LAUNCHER_SECRET` — encrypts secret files at rest (required)
- `OPERATOR_ADDRESSES` — comma-separated allowlist; enables wallet-session auth
- `LAUNCHER_ON_AKASH=true` — surfaces the mainnet-on-untrusted-provider warning
- `LITESTREAM_REPLICA_URL` (+ S3 creds) — optional state replication

Mainnet launches should use a **local** launcher with `tmkms` + external
(hardware-wallet) operators — see [docs/DESIGN.md](docs/DESIGN.md) §2–3.

## Status

Pre-1.0, under active development, built for SparkDream first — expect
breaking changes. The full design and implementation plan lives in
[docs/DESIGN.md](docs/DESIGN.md).

## Security

See [SECURITY.md](SECURITY.md). Never commit real credentials; all example
specs use placeholders.

## License

[Apache 2.0](LICENSE). Portions derived from
[Akash Console](https://github.com/akash-network/console) — see
[NOTICE](NOTICE).
