# SparkDream Chain Launcher — Design & Implementation Plan

Status: draft — 2026-07-04 (assumptions source-verified against the chain
repo and console-air; see §12 for resolutions and remaining chain-repo work)

A web app that launches a complete SparkDream chain (headscale mesh, N validators,
M sentries, block explorer, chain frontend) onto Akash Network with minimal user
input. Runs identically as a local container or as an Akash deployment. Akash
transactions are signed by the user's Keplr wallet in the browser; all
post-deploy orchestration (genesis upload, config surgery over SSH, chain start)
is performed by the launcher's own backend.

Source material:
- Manual process: `deploy/docs/DEPLOYMENT.md` in the chain repo
- Config templates: `deploy/config/` in the chain repo (chain.env,
  `template/*.toml.{validator,sentry}`, per-network SDLs, `mesh/`)
- Akash lifecycle reference: console-air, a fork of
  [Akash Console](https://github.com/akash-network/console) (see §9 for
  what we reuse)

---

## 1. Goals

1. **One-click-ish launch**: fill in chain identity, token, accounts, and
   topology (~2 minutes), sign ~6 Keplr transactions as they come due, watch
   a progress board for ~10–15 minutes, end with a running chain and live
   endpoint links.
2. **Configurable topology**: N validators, M sentries, sentry→validator
   mapping, plus explorer/frontend/hub on or off.
3. **Configurable chain parameters** with strong per-network-type defaults
   (devnet / testnet / mainnet profiles).
4. **Automatic provider selection**: audited providers, lowest price, uptime
   floor, operator preference list, anti-affinity between chain roles.
5. **Resumable**: every launch is a checkpointed state machine driven by a
   declarative spec. A failure at step 14/20 resumes, never restarts.
6. **Dual deployment mode**: the launcher itself runs locally (Docker) or on
   Akash — same image, same UI.
7. **Day-2 operations** (later milestone): fleet status, logs, escrow top-up,
   image upgrades, node restart, per-component relaunch and close, teardown.
8. **Wallet-scoped UI** (console-air pattern): everything the UI shows is
   keyed to the connected Keplr Akash account. Connect a wallet that has
   launched a fleet → land on that fleet's dashboard with live component
   status and per-component actions; connect a fresh wallet → land on the
   wizard.

Non-goals (v1): joining existing chains as a new validator, **multi-party**
coordinated genesis (collecting gentxs from other people — the single
operator signing their own gentxs with a hardware wallet IS supported, §3
"Operator keys"), TMKMS automation (we pause and hand off), cosmovisor /
gov-upgrade automation (coordinated halt-height upgrades are guided, not
automatic — §5 "Node upgrades"), archive-node / Arweave archival automation.

---

## 2. Architecture

```
┌────────────────────────── launcher container ──────────────────────────┐
│                                                                        │
│  React UI (Vite build, served statically)                              │
│   • wizard, progress board, fleet dashboard                           │
│   • Keplr: connect, sign cert/deployment/lease txs, broadcast         │
│                                                                        │
│  Conductor (Node backend, Fastify + WebSocket)                         │
│   • launch-spec validation, defaults, profiles                        │
│   • keygen + genesis + config rendering (sparkdreamd via child        │
│     process; binary baked into the launcher image)                    │
│   • unsigned tx construction (deposits, deployments, leases)          │
│   • bid polling, provider policy engine, lease/manifest via           │
│     direct mTLS to provider hostUri (see §9)                          │
│   • SSH orchestrator (ephemeral per-launch keypair)                   │
│   • state machine + checkpoint store (SQLite)                         │
│                                                                        │
│  SQLite state db  (+ optional litestream → S3 when deployed on Akash) │
└────────────────────────────────────────────────────────────────────────┘
          │                        │                         │
          ▼                        ▼                         ▼
   Akash chain REST         Console public API        deployed containers
   (txs, bids, leases)      (provider metadata,       (SSH via forwarded
   via user-chosen RPC       audited flag, uptime)     ports; headscale,
                                                       validators, sentries)
```

### Signing model (Keplr, self-custody)

The conductor never holds AKT funds or the user's chain accounts. Split of
responsibilities:

- **Browser (Keplr)** signs and broadcasts: `MsgCreateCertificate` (once per
  wallet), batched `MsgCreateDeployment` (one tx for all components), batched
  `MsgCreateLease` (one tx after bid selection), escrow `MsgAccountDeposit`
  top-ups, `MsgCloseDeployment` on teardown. The conductor builds each unsigned
  tx and hands it to the browser over the API; the browser returns the tx hash;
  the conductor confirms inclusion by polling the RPC.
- **Conductor** holds only operational secrets scoped to this launch:
  - the mTLS **certificate PEM + key** (needed server-side to PUT manifests and
    read logs/status directly against provider APIs). The cert only authenticates
    provider-API access for deployments owned by the wallet — it cannot move
    funds.
  - the ephemeral **SSH keypair** for node configuration.
  - generated **chain keys** (consensus keys, node keys, account mnemonics)
    until the user downloads them; see §3.

Expected signature count for a full launch: **5** — cert, headscale deployment,
headscale lease, batched node deployments, batched node leases — plus 1 at the
end for the step-20b persist (skippable in devnet, required for
testnet/mainnet), plus 1 if a fee-denom deposit tx is needed first, plus 1
per validator for external-operator gentxs (§3 — these sign against the NEW
chain, not the compute network, and happen during Phase A). The first three
happen in the opening minutes; the node deployment/lease pair comes after
headscale is up and configured (~5–10 min later, longer if DNS is manual).
The UI surfaces each as a blocking banner, so the user can walk away between
them but not skip them.

### Dual-mode launcher

Same image, two run modes:

- **Local**: `docker run -p 8080:8080 sparkdreamnft/launcher` (or compose).
  State on a bind mount. Recommended for mainnet launches.
- **On Akash**: deployed with its own SDL, persistent volume for SQLite, and
  optional litestream env vars (same pattern as headscale) so launcher state
  survives provider migration. Fronted by Cloudflare like the other services.

**Auth (required in Akash mode, optional locally)**: wallet-based. The UI asks
Keplr to `signArbitrary` a server nonce; the conductor verifies the signature
and checks the address against an `OPERATOR_ADDRESSES` allowlist env var.
No passwords to manage, and the entity who can operate the launcher is exactly
the entity who can sign for the deployments anyway.

**Wallet-scoped views**: the connected Keplr account is also the UI's data
scope, as in console-air. Launches, fleets, and pending txs are stored keyed
by owner address; on connect (or account switch via Keplr's
`keplr_keystorechange` event) the UI re-queries `/api/fleet` for that owner
and routes accordingly — existing fleet → dashboard, in-flight launch →
progress board at its current step, nothing → wizard. The conductor
reconciles its SQLite view against the chain's owner-scoped deployment list
(LCD `deployments/list?filters.owner=…`) so closed-out-of-band deployments
show as such; on-chain deployments the launcher didn't create appear in a
read-only "unmanaged" section (close is still offered — it's just a
signature — but relaunch is not, since the launcher has no spec or node data
for them).

**Scoping rule**: the owner address is always derived server-side from the
authenticated wallet session (in unauthenticated local mode, from the single
connected wallet), never from a client-supplied parameter. This matters
because some fleet actions mutate over SSH with *no* Keplr signature
(restart, log access, relaunch preparation) — they are not self-protecting
the way signed txs are, so they require the session owner to match the
fleet's owner in every mode, including local.

### Security model by mode

| | Local | On Akash |
|---|---|---|
| Wallet keys | Keplr only, never leave browser | same |
| SSH key, mTLS cert | on your machine | on provider disk (encrypted at rest, see below) |
| Generated mnemonics / consensus keys | on your machine until downloaded | transit + rest on an untrusted provider |
| Suitable for | anything incl. mainnet | devnet / testnet |

At-rest encryption: conductor encrypts secret columns with a key derived from
`LAUNCHER_SECRET` (env var set at deploy time). This protects the litestream
replica and casual disk access; it does **not** protect against a malicious
provider reading container memory. The wizard shows a clear warning when
`networkType=mainnet` and the launcher detects it is running on Akash
(env flag), recommending local mode and external TMKMS.

---

## 3. Key generation & custody

All generated locally in the conductor (sparkdreamd binary baked into the
image):

| Key | Purpose | Custody |
|---|---|---|
| `node_key.json` × (N+M) | node IDs — known **before** deploy, enabling pre-rendered `persistent_peers` | uploaded to nodes; kept in state db |
| `priv_validator_key.json` × N | consensus signing | **softsign mode**: uploaded to validator. **tmkms mode**: never uploaded; handed to user |
| account mnemonics (generated validator operator accounts, any "generate for me" initial accounts) | genesis allocations, gentxs | shown once in UI + downloadable encrypted bundle; flagged for sweep/rotation after launch. **Not created at all** for external-operator validators and address-only initial accounts — a hardware-custody mainnet launch generates zero mnemonics |
| SSH keypair (ed25519, per launch) | node orchestration | conductor state db |
| age keypair | headscale backup encryption | public key into SDL; private key shown once for offline stash |

**Key-security modes** (wizard choices, defaulted by network type). Two
independent axes:

*Consensus keys* (`security.keyMode`) — who signs blocks:

- `softsign` (default devnet/testnet): consensus keys live in the validator
  containers. True one-click.
- `tmkms` (recommended mainnet): launcher does everything up to chain start,
  then **pauses** at a checkpoint with a **guided signer setup** for the
  user's local machine (§5 step 19). Consensus keys are exported to the
  user, never uploaded. The launcher can generate every input the signer
  needs — it just can't (and shouldn't) run it: the whole point is that the
  signing box is hardware the launcher never touches.

*Operator keys* (`topology.validators.operators`) — who owns the stake:

- `generated` (default devnet/testnet): the conductor creates operator
  accounts in a local keyring and signs the gentxs itself (§5 step 3).
  Simple, but the mnemonics exist on the launcher until swept.
- `external` (recommended mainnet): the user supplies operator **addresses**
  (Keplr accounts, hardware-backed or not); the conductor funds them at
  genesis and **pauses per validator for a browser-signed gentx** (§5 step
  3b). The operator key never exists outside the user's wallet. Works with
  Ledger: a gentx is offline-signed with account number 0 / sequence 0 (the
  SDK's height-0 verification convention), Keplr supplies
  `SIGN_MODE_LEGACY_AMINO_JSON` for Ledger accounts (the Ledger Cosmos app
  supports `MsgCreateValidator`), and the new chain is pre-registered in
  Keplr via `experimentalSuggestChain` — Keplr accepts a suggested chain
  whose endpoints aren't live yet, and signing never queries the chain.

`tmkms` + `external` operators + address-only initial accounts is the full
mainnet custody posture: no consensus key, operator key, or funded mnemonic
ever exists on the launcher or a provider. What the launcher still holds —
node keys, the SSH keypair, the mTLS cert — is operational, not monetary.

---

## 4. Launch spec (`launch.yaml`)

The wizard is a form that produces this document; the conductor only ever
executes a spec. Specs are importable/exportable → reproducible launches,
diffable, and the natural home of the provider preference list.

```yaml
version: 1
network:
  name: sparkdream            # → chainId sparkdream-1, monikers sparkdream-val-0…
  type: testnet               # devnet | testnet | mainnet → defaults profile
  chainIdSuffix: 1            # bump for relaunches: sparkdream-2
  bech32Prefix: sprkdrm       # must match the binary's baked-in prefix;
                              # the conductor fails fast on mismatch

token:
  baseDenom: uspark.sparkdreamtest   # bond + fee denom (bondDenom override allowed)
  displayDenom: SPARK
  exponent: 6
  minGasPrice: "25000"               # in baseDenom, per gas

accounts:
  initial:
    - name: treasury
      address: sprkdrm1...           # or generate: true
      amount: "500000000000000"
    - name: team
      generate: true
      amount: "100000000000000"
  validatorSelfDelegation: "1000000000000"

topology:
  validators:
    count: 2
    operators: generated             # or a list of external addresses, one per
                                     # validator — gentxs then signed in the
                                     # browser (hardware-wallet capable, §3):
    # operators: [sprkdrm1aaa..., sprkdrm1bbb...]
  sentries:
    count: 2
    mapping: round-robin             # or explicit [[0],[1]] sentry→validators
  components:                        # non-node services
    explorer: { enabled: true, domain: explorer.sparkdream.io }
    frontend: { enabled: true, domain: app.sparkdream.io }
    hub:      { enabled: false }     # landing page usually already live
  headscale:
    domain: headscale.sparkdream.io
    backup:                          # required for mainnet, optional otherwise
      s3: { endpoint: ..., bucket: ..., region: auto, accessKeyId: ..., secretRef: ... }

providers:
  policy:
    auditedOnly: true
    minUptime7d: 0.99
    maxPriceMultiplier: 2.0          # vs median bid, sanity ceiling
    preference: []                   # ordered provider addresses, tried first
    antiAffinity: strict             # headscale/validators/sentries all on distinct providers
  escrow:
    targetRunwayDays: 30             # sizes the initial deposit per deployment

chainParams:                         # everything optional; profile provides defaults
  consensus: { timeoutCommit: 3s }
  staking:   { unbondingTime: 1814400s, maxValidators: 100 }
  gov:       { votingPeriod: 172800s, minDeposit: "10000000000" }
  mint:      { inflationMin: 0.07, inflationMax: 0.20, goalBonded: 0.67 }
  distribution: { communityTax: 0.02 }
  slashing:  { signedBlocksWindow: 10000, minSignedPerWindow: 0.5,
               downtimeJailDuration: 600s,
               slashFractionDowntime: 0.0001, slashFractionDoubleSign: 0.05 }
  validatorDefaults: { commissionRate: 0.05, commissionMaxRate: 0.20,
                       commissionMaxChangeRate: 0.01 }

images:                              # pinned versions; profile supplies latest-known
  sparkdreamd: sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.24
  headscale:   sparkdreamnft/headscale:v0.28.0
  explorer:    sparkdreamnft/explorer:v...
  frontend:    sparkdreamnft/frontend:v...

security:
  keyMode: softsign                  # softsign | tmkms
  sshPublicKey: null                 # null → launcher generates ephemeral keypair

infra:
  akashNetwork: mainnet              # the Akash network paying for compute
  rpcEndpoint: null                  # null → default public RPC
  cloudflare:                        # optional DNS automation
    apiTokenRef: env:CF_API_TOKEN
    zone: sparkdream.io
  resources:                         # per-role overrides; profile defaults shown
    validator: { cpu: 1, memory: 8Gi,
                 storage: { root: 5Gi, data: 50Gi, persistent: true, class: beta3 } }
    sentry:    { cpu: 2, memory: 8Gi,
                 storage: { root: 5Gi, data: 8Gi, persistent: true, class: beta3 } }
    # the data volume mounts at /root/.sparkdream (matches the source SDLs;
    # TS_STATE_DIR lives on it, so tailnet identity survives restarts).
    # persistent is required for validators and sentries
  sentrySettings: { pruning: default, snapshotInterval: 1000, stateSync: false }
                                     # stateSync serving stays off at genesis
                                     # (no snapshots exist yet); snapshot
                                     # production is on so later joiners can sync
```

Validation happens in a shared `@sparkdream/launch-spec` package (zod schema)
used by both UI and conductor.

---

## 5. Orchestration state machine

One launch = one row in `launches`; steps in `launch_steps`
(`id, launch_id, name, status, started_at, finished_at, output_json, error`).
Every step is **idempotent** — it checks observable state ("does this
deployment already exist on-chain?", "is the file already on the node?")
before acting, so resume is always safe. UI subscribes over WebSocket.

### Phase A — PREPARE (local, no chain interaction)

1. `validate-spec` — schema + cross-field checks (denoms consistent, mainnet
   requires backup creds, allocations ≥ self-delegations, validators and
   sentries keep `persistent: true` storage, external operator list length =
   validator count with addresses matching the chain's bech32 prefix;
   mainnet warns on `generated` operators…).
2. `generate-keys` — SSH keypair, age keypair, node keys ×(N+M), consensus
   keys ×N, mnemonics for `generate: true` accounts.
3. `build-genesis` — `sparkdreamd init` per node home; add genesis accounts;
   apply `chainParams` onto genesis JSON; then gentxs by operator mode (§3):
   - `generated` operators: `gentx` per validator, signed locally with the
     conductor's keyring (we hold every operator key — this is
     single-operator genesis, not multi-party collection);
   - `external` operators: step 3b pauses for browser signatures.
   Finally `collect-gentxs`; `validate-genesis`; distribute.
3b. *(external operators only)* `await-gentxs` — one pause per validator,
   served by a gentx variant of the signing loop (§8): the conductor builds
   the `MsgCreateValidator` sign doc (operator address, that validator's
   consensus pubkey from its home, self-delegation, commission from
   `validatorDefaults`, moniker; chain-id = the NEW chain, account number 0,
   sequence 0, zero fee); the UI pre-registers the new chain in Keplr via
   `experimentalSuggestChain` (endpoints may point at the not-yet-live
   sentry domains) and signs — amino mode for Ledger accounts, direct
   otherwise. The conductor verifies the returned signature against the
   operator address and the sign doc before accepting the gentx into the
   collection; a bad signature re-pauses rather than poisoning genesis
   (signature failures at InitChain brick block 1 — see the chain repo's
   gentx-hash guard war story).
   Two account-number notions, deliberately kept apart:
   - the **sign-doc account number is pinned to 0 and MUST NOT be
     user-configurable**: the SDK's ante handler verifies all height-0
     signatures against account number 0 regardless of the account's
     assigned number (`x/auth/ante/sigverify.go`) — any other value bricks
     the chain at block 1;
   - **which wallet account signs is entirely the user's choice**: operators
     are specified as addresses, so any Keplr/Ledger account at any BIP-44
     derivation index can back any validator — the wallet resolves the
     derivation, the conductor only checks that the signature matches the
     address.
4. `render-configs` — from `deploy/config/template/*.toml.{validator,sentry}`
   (vendored into the launcher). Node IDs are known now, but **tailnet IPs are
   not** (assigned by headscale in Phase E), so peer wiring renders in two
   stages:
   - sentry `persistent_peers` = `<validator_node_id>@127.0.0.1:<tunnelPort>`
     — fully renderable now (local tunnel address, no IP needed)
   - validator `persistent_peers` = `<sentry_node_id>@<SENTRY_TAILNET_IP>:26656`
     (validators dial sentries at tailnet IPs directly, per doc Phase 6) —
     rendered with a placeholder here, patched in Phase E step 18b
   - tunnel port allocation: sentry *s* → validator *v* uses `16656 + v`
     (`TS_TUNNEL_n=<port>:<validator_tailnet_ip>:26656`, IP patched in Phase E)
   - validator quirks baked in: `priv_validator_laddr = tcp://127.0.0.1:26660`
     (keepalive proxy backend), `allow_duplicate_ip = true` (all sentries
     arrive as 127.0.0.1 through socat)
   - `app.toml`: min gas price, pruning, snapshots per spec
5. `package-node-data` — one `node-data.tgz` per node (config + keys +
   genesis).
6. `render-sdls` — from vendored SDL templates: image tags, resources
   (including the persistent `data` volume — `persistent: true`,
   `class: beta3`, mounted at `/root/.sparkdream` — per the source SDLs),
   `SSH_PUBLIC_KEY`, `WAIT_FOR_CONFIG=true`, per-node `TS_AUTHKEY`
   placeholder (filled in Phase C), `accept:` hostnames for public services,
   pricing denom.
7. `estimate-costs` — median market prices per profile → show total + needed
   escrow before any signature.

**Checkpoint: user reviews summary + downloads key bundle → clicks Launch.**

### Phase B — CERTIFICATE (1 Keplr signature, once per wallet)

8. `ensure-certificate` — reuse valid stored cert, else generate PEM
   (chain-sdk `certificateManager`) and have the browser sign
   `MsgCreateCertificate`. Cert+key stored (encrypted) in conductor.

### Phase C — HEADSCALE

9. `deploy-headscale` — unsigned `MsgCreateDeployment`→ browser signs; poll
   bids; policy engine picks provider; browser signs `MsgCreateLease`;
   conductor sends manifest; wait for lease `available`.
   *(Headscale is deployed alone first because every other node's SDL needs
   its URL + auth keys; its lease is a 1-signature-pair mini-launch. If DNS
   automation is off, this phase pauses with "create this A record / set
   SSL=Flexible / enable WebSockets" instructions and a re-check button.)*
10. `configure-headscale` — over SSH: `sed` the `server_url` to the public
    domain, `kill 1`; `headscale users create`; mint per-node reusable
    preauth keys (one per validator/sentry + one spare `home` key surfaced to
    the user for TMKMS/archive machines).
11. `seed-headscale-backup` (skippable in devnet) — automated port of
    `seed-replica.sh`: pull DB + noise/DERP keys over SSH, validate, encrypt
    with age, upload to S3. The `state-keys.tar.age` archive (noise + DERP
    private keys, which litestream cannot replicate) is also added to the
    user's downloadable key bundle.

### Phase D — NODE DEPLOYMENTS (2 Keplr signatures total)

12. `create-deployments` — inject headscale URL + per-node `TS_AUTHKEY` into
    the node SDLs; **one batched tx** with `MsgCreateDeployment` for all
    validators, sentries, explorer, frontend. Browser signs once.
    *(Caveat: console-air never batches `MsgCreateDeployment` — only leases
    and closes — so this is unproven ground. Each msg carries its own
    explicitly-set dseq, so it should work at the protocol level, but gas
    limits at 6+ deployments are a real risk. Test in early M2; fall back to
    chunked txs — still one Keplr prompt per chunk — if needed.)*
13. `collect-bids` — poll all dseqs (7s interval, ~5.5-min budget per
    console-air behavior); policy engine (§6) selects a provider per deployment with
    anti-affinity across the whole set (including headscale's provider).
    Zero-passing-bids → pause with rejected-bid explanations + manual pick.
14. `create-leases` — **one batched `MsgCreateLease` tx**. Browser signs once.
15. `send-manifests` — conductor PUTs each manifest directly to the
    provider's hostUri over mTLS (3 retries on "no lease", 5s pre-send
    delay); wait for services up; record SSH forwarded ports from lease
    status.

### Phase E — NODE CONFIGURATION (conductor over SSH, no signatures)

Per node, parallel where safe:

16. `upload-node-data` — sftp `node-data.tgz` → extract into
    `/root/.sparkdream` (idempotent: skip if marker file present).
17. `await-mesh` — poll `tailscale --socket=$TS_STATE_DIR/tailscaled.sock ip -4`
    until each node has a tailnet IP; build the name→IP table.
18. `wire-tunnels` — the entrypoint creates socat tunnels **once at boot**
    from `TS_TUNNEL_n` env vars; there is no runtime re-read. Since tailnet
    IPs aren't known until now, the SDLs deploy with placeholder targets and
    this step rewires over SSH: kill the placeholder socat, launch
    replacement `socat TCP-LISTEN:<port>,fork,reuseaddr
    EXEC:"tailscale nc <validator_tailnet_ip> 26656"` processes; verify with
    `nc -zv 127.0.0.1 <port>`. These ad-hoc tunnels die on container restart
    — step 20b persists the real targets into the SDL env (the durable
    long-term fix is the entrypoint reading tunnel specs from a file;
    chain-repo image change, see §12.2).
18b. `patch-validator-peers` — fill each validator's `persistent_peers`
    placeholders with real sentry tailnet IPs (from the step-17 table) and
    restart/reload; node IDs alone were not enough to pre-render this in
    Phase A.
19. *(tmkms mode only)* `await-signer` — pause with a **guided signer
    setup** panel, one tab per validator. The launcher generates everything
    the local machine needs:
    - a downloadable per-validator bundle: ready-to-run `tmkms.toml`
      (chain id, `addr = "tcp://<validator_tailnet_ip>:26659"`, protocol
      version, state file path) + the exported consensus key in tmkms
      import format;
    - copy-paste commands with OS tabs: install tmkms (release binary or
      `cargo install tmkms --features=softsign`), join the mesh
      (`tailscale up --login-server=<headscale_url> --authkey=<spare
      'home' preauth key>` — the key minted in step 10), `tmkms softsign
      import`, `tmkms start`;
    - a live status row per validator: mesh join detected (headscale
      `nodes list`), privval port probe, "signer connected". Resume
      auto-enables when all validators' probes pass; the same panel is
      reachable later from the fleet dashboard for signer moves or
      re-imports (relaunch regenerates the bundle with the new tailnet IP).

### Phase F — CHAIN START

20. `start-chain` — start `sparkdreamd start --home /root/.sparkdream` over
    SSH on validators (near-simultaneously — >2/3 voting power must be online
    for block 1), then sentries; honors `STARTUP_DELAY` semantics.
    *(Mechanism confirmed: `WAIT_FOR_CONFIG=true` is a one-shot env check in
    `entrypoint_ssh.sh` — the entrypoint starts sshd + tailscale then sleeps
    forever, and the script itself documents SSH-starting the binary. No
    touch-file, no signature needed for the start itself.)*
20b. `persist-start` — a node started via SSH is **not supervised**: on
    container restart the entrypoint hits the `WAIT_FOR_CONFIG=true` gate
    again and the node stays down. Once the chain is producing blocks, flip
    the env durably via SDL update (`MsgUpdateDeployment`, 1 signature +
    manifest re-PUT; same providers, no re-bid) — this also persists the
    step-18 tunnel targets. Skippable in devnet; required for testnet/mainnet.
    *(Long-term: an entrypoint touch-file gate in the chain-repo image makes
    both this step and step 18's rewiring durable without the extra
    signature — see §12.1/§12.2.)*
21. `verify-chain` — automated port of the doc's checklist: headscale
    `nodes list` shows all nodes; sentry RPC `/status` reachable and
    `latest_block_height` increasing; every validator address present in
    signatures/precommits; explorer + frontend HTTP 200 on their domains.
22. `finalize` — dashboard flips to fleet view: endpoints, providers, prices,
    escrow runway; reminder list (sweep generated mnemonics, stash age key,
    rotate preauth keys, export + stash the fleet bundle, optionally strip
    SSH from validator SDL).

Failure handling: any step error marks the launch `paused` with the error and
a resume button; steps have bounded retries with backoff where transient
(bids, tailscale join, RPC polls). A launch can also be aborted → teardown
plan (close deployments, one signature).

### Component relaunch & close (day-2)

Per-component operations on a live fleet, driven from the wallet-scoped
dashboard as mini state machines reusing the launch steps:

- **Close** — `MsgCloseDeployment` for that component's dseq (1 signature).
  The dashboard marks dependent components degraded (e.g. closing a sentry
  leaves its validator without that peer path).
- **Relaunch** — close (if still open), then re-run steps 12–20 scoped to the
  one component, reusing the stored spec and `node-data.tgz` (same node key →
  same node ID, so peers' `persistent_peers` entries stay valid): render SDL
  with a fresh preauth key → `MsgCreateDeployment` (1 sig) → bids/policy →
  `MsgCreateLease` (1 sig) → manifest → upload node data → await mesh.
  **The relaunched node gets a new tailnet IP**, so the affected subset of
  steps 18/18b re-runs on its peers: relaunching a validator re-wires its
  sentries' tunnels; relaunching a sentry re-patches its validator's
  `persistent_peers`. Persistent volumes are **lease-scoped** — closing the
  deployment destroys them — so a relaunch always starts from an empty
  volume regardless of the persistence settings: validators resync chain
  data from their sentries, and the node re-registers with headscale (new
  tailnet IP, hence the re-wiring above). Expired preauth keys are re-minted
  via headscale SSH first.

**Validator relaunch: double-sign safety (mandatory, softsign mode).**
Relaunch re-uploads the *same consensus key* to a new container, and
`priv_validator_state.json` (the record of what heights the key already
signed) dies with the old lease-scoped volume — persistence does not carry
across a close+recreate. Two ways to get tombstoned + slashed
(`slashFractionDoubleSign`): a zombie old container still signing when the
new one starts (close tx confirmed ≠ provider actually stopped it), or the
new node signing a height the old one already signed. So the relaunch
machine enforces, before `sparkdreamd start` on the new container:
1. old lease closed on-chain **and** old node unreachable (SSH + tailnet
   probe both fail);
2. record the validator's last signed height (from a sentry's commit data),
   then wait a safety window of N blocks past it (default 20) before the new
   node starts signing. tmkms mode is inherently safe here (key never in the
   container); the UI says so and skips the window.

**Pre-action guards** (computed from topology + chain state, shown in the
confirm dialog):
- *Last-peer-path warning*: closing/relaunching a sentry whose validator has
  no other sentry isolates that validator — it misses blocks and risks
  downtime-jailing if the operation outlasts `signedBlocksWindow`. The
  dialog states this and suggests sequencing (add/relaunch a second sentry
  first on mainnet).
- *Balance check*: relaunch needs a fresh escrow deposit before the closed
  lease's refund settles; verify wallet balance covers it before closing
  anything.
- Stateless components (explorer, frontend) skip all of the above — close
  and relaunch freely.

Both actions record into `launch_steps` like any other step, so they're
resumable and their provider decisions are explainable in the UI.

### Node upgrades (day-2)

Mechanism: `MsgUpdateDeployment` with the new image tag (1 signature) +
manifest re-PUT to the **same provider** — no re-bid, lease and price
unchanged. The provider pulls the new image and restarts the container.

What the restart costs depends on the role's storage:

- **Persistent volume (sentries and validators, the default)**: the `data`
  volume survives a same-lease update, and everything that matters lives on
  it — node keys, configs, chain data, `priv_validator_state.json`, and
  `TS_STATE_DIR` (so the node rejoins the tailnet with the **same IP**). An
  upgrade is then just a supervised restart: no peer re-wiring, no data
  resync, and **no double-sign window** — the sign state is intact and the
  provider replaces the container in place, so there is no zombie to race.
  The flow verifies the node comes back, re-creates tunnels correctly (the
  entrypoint re-reads env at boot), and health-gates before moving on.
- **Ephemeral (explorer/frontend)**: the filesystem is gone — but these are
  stateless, so the upgrade is just the deployment update plus an HTTP
  health gate.

Precondition for either path: step 20b must have flipped
`WAIT_FOR_CONFIG=false` in the SDL env — otherwise the upgraded container
comes up gated. The upgrade flow checks this and runs 20b first if it never
happened.

**Rolling sequencer** — upgrades execute one component at a time, gated on
monitor health: sentries first (each must reconnect and catch up to chain
head before the next starts), then validators one at a time (each must
resume signing before the next; the fleet never drops below 2/3 voting
power — with 2 validators that means strictly serial, and the dialog says
one validator will briefly miss blocks). Explorer/frontend upgrade freely
in parallel.

**Scope**: the rolling flow covers non-consensus-breaking releases. For
consensus-breaking upgrades, a guided coordinated flow: the user supplies a
halt height, the conductor sets `halt-height` in `app.toml` across all
nodes over SSH, waits for the chain to halt there, then updates every image
and restarts validators near-simultaneously (same >2/3 rule as launch step
20). Cosmovisor/gov-upgrade automation remains a non-goal for v1. The
monitor records each node's running version (RPC `/abci_info`), and the
dashboard warns on mixed versions lingering past an upgrade or on an
attempted downgrade.

### tmkms-mode fleets (day-2)

The launcher still never manages the signer machine (non-goal §1); fleet
management makes tmkms fleets operable rather than automatic:

- Only operations that lose the validator's persistent volume change its
  tailnet IP and break the signer's dial target — in practice **relaunch**
  (lease-scoped volume); upgrades keep the IP and need no signer action.
  When the IP does change, the flow re-enters the step-19 `await-signer`
  pause with a regenerated `tmkms.toml` (new tailnet IP), resume on user
  confirmation + successful port probe. The rolling sequencer treats this
  pause as part of that validator's health gate.
- The **double-sign safety window is skipped** in tmkms mode: consensus
  keys never enter the container and tmkms tracks its own last-sign state,
  so container churn cannot double-sign.
- The monitor distinguishes **"awaiting signer"** (node up, blocked on the
  privval connection) from "down" — so a rolling upgrade doesn't misread a
  waiting validator as failed, and the dashboard tells the user exactly
  which signer needs reconnecting.

### Fleet health monitor

Health is produced by a conductor background loop per active fleet, not
computed when the dashboard asks — on-demand probing is slow (serial
provider mTLS calls), rate-limit-prone, and means runway alerts only fire
while someone is watching. Cadence 30–60s per fleet:

- lease state via provider API (mTLS), escrow balance/runway via LCD,
  block height + running version via sentry RPC (`/status`, `/abci_info`),
  HTTP probes for explorer/frontend, tailnet reachability via SSH where
  cheap, and in tmkms mode the privval-connection state ("awaiting signer"
  vs. down).
- results land in a `component_health` table (component, status, detail,
  checked_at); `GET /api/fleet` serves the cache, `WS /api/fleet/events`
  pushes deltas.
- this is also what detects **"lease open but node dead"** (provider
  degraded/zombie) — a state on-chain reconciliation alone can never see —
  and what feeds the double-sign safety and last-peer-path guards above
  with fresh data.

### Fleet bundle (management portability & DR)

Management capability lives in one instance's SQLite (spec, node keys, SSH
keypair, mTLS cert) — without a transfer mechanism, connecting the same
wallet to a *different* launcher shows your own fleet as "unmanaged".
Extending the spec import/export philosophy: an encrypted **fleet bundle**
export (age-encrypted; spec + node keys + SSH keypair + cert + component
records — never consensus keys in tmkms mode, preserving §3 custody) that
any launcher instance can import to take over management.
This is also the disaster-recovery story if launcher state is lost (beyond
litestream in Akash mode): re-import the bundle, the reconciler re-attaches
to the on-chain deployments, the monitor repopulates health. The `finalize`
step's reminder checklist includes "export and stash the fleet bundle".

---

## 6. Provider selection policy engine

Input: bids for a dseq + enriched provider list (Console public API:
`isAudited`, `uptime7d/30d`, attributes, `hostUri`) + already-chosen providers
this launch.

1. **Hard filters**: `isAudited` (if `auditedOnly`), `uptime7d ≥ minUptime7d`,
   `price ≤ maxPriceMultiplier × median(bid prices)`, provider ∉ chosen-set
   when `antiAffinity: strict` (headscale, every validator, every sentry on
   distinct providers — DEPLOYMENT.md requires this), and **persistent
   storage support**: when the role's resources declare a persistent volume
   (sentries and validators by default), the provider must offer the
   requested storage class (`beta3`) — checked via provider attributes
   before bidding is even expected, and surfaced in the rejection table
   ("no beta3 persistent storage").
2. **Preference list**: first bid whose provider appears in
   `providers.policy.preference` wins (list order beats price).
3. **Tiebreak**: lowest `price.amount`.
4. **Explainability**: every decision stored as
   `{chosen, rejected: [{provider, reason}]}` and shown in the UI ("cheapest
   of 4 audited bids; 2 rejected: uptime, anti-affinity").
5. **Escape hatch**: zero survivors → pause that deployment's row, render the
   rejection table, allow manual override or re-bid (close+recreate).

Non-strict anti-affinity variant (`preferSpread`) allowed for devnet where few
providers bid.

---

## 7. Wizard UX (3 steps + progress board)

Aesthetic: reuse the SPARK·DREAM fleet language (each component a ship;
launching the chain launches the armada).

1. **Identity & Token** — chain name (live chain-id preview), network type
   (switches all defaults + shows cost/security implications), base/display
   denom, exponent, min gas price. Advanced accordion: bech32 prefix, chain-id
   suffix.
2. **Accounts & Topology** — initial accounts table (address or "generate"),
   self-delegation; **operator key mode** (generated vs. external addresses —
   external shows one address field per validator and explains the extra
   gentx signatures, §3; any Keplr/Ledger account at any derivation index
   can be used per validator — paste that account's address); validator/sentry
   count steppers with a live
   topology diagram (ships + mesh lines) and per-count cost delta; component
   toggles (explorer/frontend/hub) with domain fields.
3. **Pre-flight review** — full spec summary, editable-in-place advanced
   sections (chain params, provider policy, images, resources, key mode,
   backup creds), cost + escrow total vs. wallet balance, mainnet warnings
   (launcher-on-Akash, softsign, generated operators, missing backup creds).
   Buttons:
   *Export spec* / **Launch fleet**.
4. **Launch board** — one row per component with stage chips
   (`deploying → bidding → provider ✓ (name, price, why) → lease → configuring
   → started → healthy`), global phase indicator, Keplr signature prompts
   surfaced as blocking banners, pause/resume/abort. Key-bundle download gate
   before the first signature.
5. **Fleet dashboard** (post-launch and on every revisit) — the landing view
   whenever the connected wallet owns a fleet (console-air pattern: connect
   wallet → see your deployments). Per component: health chip (lease state,
   block height / HTTP probe), endpoint links, provider + price, escrow
   runway bar, running version, logs viewer (provider WebSocket), and
   actions — top-up, restart, **rolling upgrade** (§5 "Node upgrades"),
   **relaunch**, **close** (per §5 "Component relaunch & close"). Fleet-level: teardown, the post-launch reminder
   checklist, fleet-bundle export/import, and an "unmanaged deployments"
   section for on-chain deployments owned by the wallet that this launcher
   didn't create (close confirms with full dseq/provider/price details —
   it may belong to another launcher instance's fleet; importing that
   instance's bundle upgrades it to managed). Switching Keplr accounts
   switches the whole view to the new owner's fleets (or the wizard if
   there are none).

---

## 8. Backend API sketch

```
POST /api/launches                    create from spec (validate + estimate)
GET  /api/launches/:id                spec + step states
POST /api/launches/:id/start|resume|abort
WS   /api/launches/:id/events         step transitions, logs, decisions

# Keplr signing loop (compute-network txs)
GET  /api/launches/:id/pending-tx     next unsigned tx (proto JSON), if any
POST /api/launches/:id/tx-result      {txHash} → conductor verifies on-chain

# gentx signing loop (NEW-chain offline signatures, external operators §3;
# no broadcast — conductor verifies the signature and embeds the gentx)
GET  /api/launches/:id/pending-gentx  sign doc for the next unsigned gentx
POST /api/launches/:id/gentx-result   {signedTxJson} → verify + collect

# fleet ops — owner always derived from the auth session (never a query
# param); SSH-mutating actions (restart, relaunch prep) require session
# owner == fleet owner in every mode, local included
GET  /api/fleet                       fleets + per-component health (served
                                      from the monitor's cache), lease
                                      status, runway; unmanaged deployments
POST /api/fleet/:dseq/actions         top-up (returns unsigned tx), restart,
                                      upgrade, close, relaunch — close and
                                      relaunch enqueue into the same
                                      pending-tx signing loop
WS   /api/fleet/events                health/runway deltas pushed from the
                                      monitor loop (dashboard renders cache,
                                      never probes on demand)
WS   /api/fleet/:dseq/logs

# fleet bundle (management portability / DR)
GET  /api/fleet/:fleetId/bundle       encrypted export: spec + node keys +
                                      SSH keypair + cert
POST /api/fleet/import                import bundle → this instance can
                                      manage the fleet

# auth (Akash mode)
POST /api/auth/nonce ; POST /api/auth/verify   (signArbitrary, allowlist)
```

The signing loop is generic: any step needing a signature enqueues a
`pending-tx`; the UI shows a "Sign in Keplr" banner; conductor resumes when
the tx is confirmed. If the browser disconnects mid-launch, the launch simply
pauses at the next signature; SSH-phase work continues unattended.

---

## 9. Repo & tech stack

Repo layout (github.com/sparkdream/launcher):

```
launcher/
  packages/launch-spec/      zod schema + defaults profiles + types
  packages/akash-tx/         isomorphic msg conversion + signing registry
                             (shared by conductor CLI signer and browser)
  apps/web/                  Next.js 15 + React 19, static export (matches
                             sparkdream-ui / gallery stack; no Next server —
                             the conductor serves apps/web/out). Keplr via
                             direct window.keplr (decided).
  apps/conductor/            Node 22 + Fastify + better-sqlite3 + ssh2
  vendor/sparkdream-deploy/  synced copy of deploy/config templates + SDLs
                             (script to re-sync from the chain repo)
  Dockerfile                 multi-stage: web build → conductor + static +
                             sparkdreamd binary + envsubst
  deploy.yaml                SDL for launcher-on-Akash (PVC + litestream)
```

Key dependencies / reuse from console-air (per exploration of that repo):

- `@akashnetwork/chain-sdk` — SDL→manifest (`generateManifest`,
  `generateManifestVersion`, `manifestToSortedJSON`), `certificateManager`,
  proto msg types (`MsgCreateDeployment` v1beta4, `MsgCreateLease` v1beta5,
  cert v1, escrow-v1 `MsgAccountDeposit`). Console-air pins
  `1.0.0-alpha.38` — an alpha; pin hard, expect churn between versions.
- Ported plain-TS code: `TransactionMessageData.ts`,
  `utils/deploymentData/v1beta3.ts` (filename is legacy — it uses v1beta4
  types; SDL parse, dseq from latest block, deposit calc), provider-proxy
  request/response shapes, bid/lease query shapes (7s poll, ~5.5-min budget),
  lease-status URI extraction.
- **Provider API access: direct mTLS from the conductor**, not console-air's
  path. Console-air routes manifest PUTs through Akash's *hosted* provider
  proxy (`console.akash.network/provider-proxy-*`), which terminates mTLS —
  the cert+key transit a third-party service. Our conductor is Node, so it
  PUTs `{hostUri}/deployment/{dseq}/manifest` directly with an https agent
  holding the cert/key. Simpler, no third-party trust, consistent with the
  self-custody model. Keep console-air's retry semantics (3 attempts, 5s
  pre-send delay, retry on "no lease").
- Console public API for enriched provider list (`isAudited`, uptime).
- `ssh2` for orchestration; `js-yaml` for SDL templating; `cloudflare` SDK
  for optional DNS automation.

Note: console-air has **no** auto-provider-selection or server-side signing —
policy engine (§6) and the pending-tx signing loop (§8) are ours.

---

## 10. Open source & licensing

The launcher is **open source**, like the chain and chain frontend
(repo: https://github.com/sparkdream/launcher).

- **License: Apache 2.0** — matches console-air (whose code we port:
  `TransactionMessageData.ts`, deployment-data utils, provider-proxy service)
  and the Cosmos/Akash ecosystem norm. Keep a `NOTICE` file crediting the
  console-air-derived portions.
- **Why open**: trust is the product — the tool generates consensus keys and
  mnemonics and holds SSH access to chain nodes; key-handling code must be
  inspectable. It also has an audience beyond SparkDream (most of the launcher
  is chain-agnostic; the SparkDream-specific parts are the vendored templates
  and binary, a future pluggable "chain profile"), making it a candidate for
  Akash community funding and external contributions. Security-critical paths
  (secret encryption, wallet auth, SSH orchestration) benefit from outside
  eyes.
- **Repo hygiene**: `SECURITY.md` from day one; README disclaimer
  ("pre-1.0, built for SparkDream first") to manage support expectations;
  all example `launch.yaml` files use placeholder credentials; no secrets in
  code — they live only in spec values, env vars, and the local SQLite state.

## 11. Milestones

**M1 — Conductor core (no UI, no Akash).** launch-spec package + profiles;
keygen/genesis/config rendering (Phase A) against the vendored templates;
state machine + SQLite checkpointing; golden tests: spec → deterministic
genesis/configs for 1×1 and 2×2 topologies; `validate-genesis` green.

**M2 — Akash lifecycle, headless.** cert, deployment, bid polling, policy
engine (unit-tested against recorded bid/provider fixtures), lease, manifest,
lease status. Signing via a temporary CLI signer (mnemonic env var) so M2 is
testable end-to-end on devnet without the UI. Deploy a single hub container
via spec as the smoke test. **Early M2 spike: batched multi-deployment tx**
(§5 step 12) — no console-air precedent; verify gas behavior and settle on
batch-vs-chunked before the UI signing loop is built on it.

**M3 — SSH orchestration + chain start.** ssh2 orchestrator, Phases C/E/F
against a real devnet launch (1 validator, 1 sentry). Exercises the SSH-based
tunnel rewiring (step 18), validator peer patching (step 18b), and SSH chain
start + SDL-update persistence (steps 20/20b). Coordinate with the chain repo
on the entrypoint improvements in §12.1–.2 — landing them before M3 removes
the ad-hoc rewiring entirely.

**M4 — Web UI + Keplr.** wizard, pending-tx signing loop, progress board,
wallet auth. Replace CLI signer. First full browser-driven devnet launch.

**M5 — Fleet dashboard + day-2 ops.** wallet-scoped dashboard (connect →
your fleet, account-switch aware, on-chain reconciliation + unmanaged
section); background health monitor + `WS /api/fleet/events`; logs, top-up;
per-component close and relaunch with the double-sign safety sequence and
pre-action guards (§5 "Component relaunch & close"); rolling node upgrades
with health-gated sequencing and tmkms-aware pauses (§5 "Node upgrades",
"tmkms-mode fleets"); fleet bundle export/import; escrow runway alerts.
The coordinated halt-height upgrade flow may slip to M7 if M5 runs long.

**M6 — Launcher-on-Akash + mainnet hardening.** litestream state
replication, secret encryption at rest, allowlist auth, mainnet warnings;
**external-operator gentx flow** (§3/§5 step 3b: browser/hardware-wallet
gentx signing — verify the amino-mode path against a real Ledger before
calling it done); publish image + SDL.

**M7 — Polish.** fleet-visual launch board, spec import/export, preference
list management UI, guided tmkms signer setup (§5 step 19 panel; a plain
stanza-display pause ships earlier with M3's tmkms checkpoint).

---

## 12. Open questions — resolved 2026-07-04 (verified against chain repo &
console-air sources)

1. **WAIT_FOR_CONFIG release contract** — RESOLVED. One-shot env check in
   `entrypoint_ssh.sh`: sshd + tailscale start first, then
   `exec tail -f /dev/null`. Chain start = SSH in and run `sparkdreamd start`
   (no signature). But an SSH-started node is unsupervised — container
   restart re-hits the gate and the node stays down. Hence step 20b (SDL
   update after first blocks). **Chain-repo ask**: entrypoint touch-file gate
   (e.g. start when `/root/.sparkdream/.start` appears) would make SSH start
   durable with zero extra signatures.
2. **Tunnel retargeting** — RESOLVED. Tunnels are created once at boot from
   `TS_TUNNEL_n` env; no runtime re-read. Rewiring = SSH ad-hoc socat
   replacement (step 18), persisted by the step-20b SDL update. **Chain-repo
   ask**: entrypoint reads tunnel specs from a re-readable file so rewiring
   survives restarts without an SDL update.
3. **Validator→sentry dialing** — RESOLVED. Validators dial sentries at
   tailnet IPs directly (`SENTRY_HOST=100.64.x.x`); sentries dial validators
   via the local socat tunnel (`127.0.0.1:16656+v`). Consequence: validator
   `persistent_peers` cannot be pre-rendered in Phase A (tailnet IPs unknown)
   → step 18b patches it in Phase E. Sentry side pre-renders fully.
4. **Genesis param application** — RESOLVED. Apply `chainParams` directly
   onto genesis JSON (no Python dependency). The gentx-hash guard in
   `regenerate-network-genesis.py` only protects committed genesis artifacts;
   irrelevant for freshly generated gentxs.
5. **Explorer/frontend chain wiring** — RESOLVED, needs chain-repo work. The
   Ping-Pub explorer reads a **baked JSON chain config**
   (`explorer/ping-pub/chains/<net>/sparkdream.json`, hardcoded localhost
   endpoints); no env wiring exists in explorer or frontend images. The
   launcher cannot inject endpoints until the images template their chain
   config from env at startup. **Chain-repo ask**: entrypoint-templated chain
   config for both images; blocks step 21's explorer/frontend health checks.
6. **Faucet component** — RESOLVED by cutting it: no faucet image exists in
   the chain repo (the only faucet code is the explorer UI page calling the
   external `faucet.ping.pub`), and a faucet is out of scope for the
   launcher. Users who need one can allocate a dedicated initial account and
   run any standard Cosmos faucet against a sentry RPC.
7. **Fee denom check** — RESOLVED: the chain repo's SDLs price in `uact`
   (not `uakt`, and distinct from the chain's own `uspark.*` denom). SDL
   renderer takes the pricing denom from the `infra.akashNetwork` profile.

### Remaining chain-repo dependencies

Tracked asks, ordered by which milestone they block:
- Explorer/frontend env-templated chain config (blocks full step 21 in M3/M4).
- Entrypoint touch-file start gate + file-based tunnel specs (nice-to-have
  before M3; removes step 20b's extra signature and step 18's fragility).
