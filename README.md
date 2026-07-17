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

Build and push the image, then deploy with `deploy.yaml` (same process as
sparkdream-ui):

```bash
# Build (bundles conductor, static web UI, and the sparkdreamd binary).
# SPARKDREAMD_IMAGE defaults to the tag matching packages/launch-spec profiles;
# override with --build-arg SPARKDREAMD_IMAGE=... if needed.
docker build -t sparkdreamnft/launcher:v1.0.0 .

# Push to the registry
docker push sparkdreamnft/launcher:v1.0.0

# Update image:, accept: domain, and env: in deploy.yaml, then create the
# deployment (or paste deploy.yaml into Akash Console)
akash tx deployment create deploy.yaml --from <key> --chain-id akashnet-2 --node <akash-rpc>
```

#### Building for a specific chain version

The image bundles two version-coupled pieces: the `sparkdreamd` binary
(pulled from the chain image named by the `SPARKDREAMD_IMAGE` build arg) and
the chain repo's deploy data in `vendor/` (reference genesis, config
templates, SDLs). Both must agree on genesis format with the chain version
you deploy. To build a launcher for a different chain version:

1. Check out the chain repo at the matching tag.
2. Run `pnpm sync-vendor`. This re-vendors the deploy data and regenerates
   `packages/launch-spec/src/vendor-info.ts`; profile image defaults and the
   spec validator's minimum-image check follow it automatically.
3. Set the `SPARKDREAMD_IMAGE` default in the `Dockerfile` to the same
   version (`pnpm test` fails if the two drift), then build and push.

Rebuilding is the zero-runtime-config path. The launcher can also serve
other chain versions at runtime; see the next section.

#### Chain versions at runtime: fetch mode, offline mode, pre-seeding

Each launch resolves its chain assets (the `sparkdreamd` binary used for
genesis generation, plus the chain repo's deploy data) from the version the
spec names in `images.sparkdreamd`. `CHAIN_ASSET_MODE` picks the behavior:

| mode | behavior |
| --- | --- |
| `baked` / Offline (default) | Zero network: no downloads, no registry probes. Chain versions validate against the built-in release manifest; assets come from the baked-in version or a pre-seeded cache entry. An unknown or locally missing version stops at validation with the remediations. Custom image overrides are unprobed: your informed risk. |
| `fetch` / Online | Missing versions are fetched on demand: the binary is extracted from the chain image via the Docker Hub API (bit-identical to what the nodes run, digest-verified against the release manifest), and deploy data is cloned from the chain repo at the manifest's release commit, a matching git tag, the spec's `images.chainRepoCommit` pin, or a commit you pick in the launch panel. Unpushed images are caught by a Docker Hub check before any deposit. |

The mode is a toggle in the launch panel, persisted server-side. Setting
`CHAIN_ASSET_MODE` in the environment overrides and locks it: an airgapped
or mainnet launcher's offline guarantee is deployment config, not a browser
click.

`SPARKDREAM_CHAIN_REPO` sets the clone source (URL or local path; default
`~/cosmos/sparkdream/sparkdream`). Fetched assets are cached under
`DATA_DIR/chain-assets/<image-tag>/` and pruned automatically to the three
most recently used versions (versions referenced by unfinished launches are
never evicted).

**The release manifest.** `packages/launch-spec/src/releases.ts` (generated,
checked in) records every known chain release: version, the chain-repo
commit its deploy data came from, and the published image digests. It is
what lets Offline mode validate versions with zero network, and Online mode
resolve commits without git tags and verify downloads against release-time
digests. After each chain release, run `pnpm sync-releases` here and
rebuild: the launcher's counterpart to the chain repo's
`prepare-release.sh` (release discovery keys off its "Bump deploy images to
vX" commits, so image tags running ahead of git tags cannot desync it).

**Pre-seeding (airgapped launchers, dev builds).** `pnpm seed-chain-assets`
builds a cache entry without a running launcher:

```bash
# release version, binary from the registry, deploy data at the git tag
pnpm seed-chain-assets sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.24

# dev build: binary from a local file, deploy data from the working tree
# (dirty state allowed and recorded in the entry's meta.json)
pnpm seed-chain-assets sparkdreamnft/sparkdreamd-devnet-ssh:dev-abc123 \
  --binary ./sparkdreamd --chain-repo ~/cosmos/sparkdream/sparkdream

# portable entry for an airgapped launcher: write to a directory, then
# copy it into the target's DATA_DIR/chain-assets/
pnpm seed-chain-assets sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.24 --out ./seed
```

`GET /api/chain-assets` reports the active mode, the baked version, and the
cached entries; the launch panel uses it to show how a spec's version will
resolve and to prompt for a commit when no git tag matches.

In Akash mode set:

- `LAUNCHER_SECRET` — encrypts secret files at rest (required)
- `OPERATOR_ADDRESSES` — comma-separated allowlist; enables wallet-session auth
- `LAUNCHER_ON_AKASH=true` — surfaces the mainnet-on-untrusted-provider warning
- `LITESTREAM_REPLICA_URL` (+ S3 creds) — optional state replication

Mainnet launches should use a **local** launcher with `tmkms` + external
(hardware-wallet) operators — see [docs/DESIGN.md](docs/DESIGN.md) §2–3.

## Status

Under active development, built for SparkDream first: expect breaking
changes. The full design and implementation plan lives in
[docs/DESIGN.md](docs/DESIGN.md).

## Security

See [SECURITY.md](SECURITY.md). Never commit real credentials; all example
specs use placeholders.

## License

[Apache 2.0](LICENSE). Portions derived from
[Akash Console](https://github.com/akash-network/console) — see
[NOTICE](NOTICE).
