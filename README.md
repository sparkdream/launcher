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
