"use client";

import { Children, Fragment, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { GasPrice, SigningStargateClient } from "@cosmjs/stargate";
import { launcherRegistry, mintActMsg, toEncodeObject } from "@sparkdream/akash-tx";
import {
  checkSpec,
  COMPONENT_KEYS,
  SERVICES_FLEET_COMPONENTS,
  COMPONENT_KINDS,
  defaultLoginDomain,
  isComponentKey,
  NODE_SIZES,
  type NodeSize,
  type LaunchSpec,
  type SpecCheck,
} from "@sparkdream/launch-spec";
import yaml from "js-yaml";
import { EDITOR, openLaunchFor } from "../lib/open-launch";
import { resetSource } from "../lib/reset-spec";
import { specPathLine } from "../lib/spec-lines";
import { bidModeOf, roleSizeOf, setBidMode, setRoleSize, type BidMode, type NodeRoleName } from "../lib/spec-edit";
import {
  createLaunch,
  exportLauncherBackup,
  getChainAssets,
  getFleet,
  getLaunch,
  getPendingGentx,
  getPendingTx,
  importLauncherBackup,
  postFleetAction,
  postGentxResult,
  postSignedGentxTx,
  postTxResult,
  resumeLaunch,
  startLaunch,
  setChainAssetsMode,
  type AccountView,
  type BackupImportReport,
  type ChainAssetsView,
  type ComponentView,
  type CostEstimate,
  type FeeInfo,
  type FleetSummary,
  type LaunchView,
  type OpProgress,
  type PendingGentx,
  type PendingTx,
  type RelayerFunds,
  type SpecPrefill,
} from "../lib/api";
import { FundingRows } from "./relayer-funds";
import { RelayerSettingsModal } from "./relayer-settings";
import { PeerSetupRoutes } from "./peer-setup";
import {
  connectKeplr,
  DEFAULT_CHAIN,
  loadChainConfig,
  saveChainConfig,
  signGentx,
  suggestChain,
  type ChainConfig,
  type ConnectedWallet,
} from "../lib/keplr";
import {
  BME_CANCEL_REASONS,
  fetchAktUsdPrice,
  fetchBalances,
  fetchBmeInfo,
  fetchBmeLedger,
  type BmeInfo,
  type BmeLedgerSummary,
  type Coin,
} from "../lib/lcd";

const EXAMPLE_SPEC = `version: 1
# kind: services   # a fleet of shared components with no chain (a Mastodon
#                  # that several chains bridge to): no nodes, no mesh;
#                  # topology.components may then enable mastodon only
network:
  name: sparkdreamdev
  type: devnet
  bech32Prefix: sprkdrm
token:
  # chain rule for both denoms: u<2-5 letters>.<suffix>
  baseDenom: uspark.sparkdreamdev
  displayDenom: SPARK
  # dreamDenom: udream.sparkdreamdev  # udream. + baseDenom's suffix unless set
  # dreamDisplayDenom: DREAM
  # minGasPrice: "0.025"   # per GAS UNIT in baseDenom, not a fee (profile default)
accounts:
  initial:
    - name: treasury
      generate: true
      amount: "500000000000000"
    # member: seed as an active genesis member (people, not treasury/operators);
    # true → core founder defaults, or pick trustLevel (new|provisional|
    # established|trusted|core) and dreamBalance per account
    # council: seat on the founding governance councils (exactly one sets
    # founder: true). Without council accounts the chain's compiled-in
    # founder addresses must exist in genesis or governance never bootstraps
    - name: alice
      generate: true
      amount: "1000000000000"
      member: true
      council: { founder: true, handles: [alice] }
    - name: bob
      generate: true
      amount: "1000000000000"
      member: { trustLevel: established }
      council: true
    - name: carol
      generate: true
      amount: "1000000000000"
      member: { trustLevel: provisional }
      council: true
    - name: dave
      generate: true
      amount: "1000000000000"
      # member cosmetics seed the season profile (otherwise claimed on-chain)
      member: { trustLevel: provisional, dreamBalance: "5000000000", username: dave, displayName: Dave, achievements: [genesis_founder] }
  validatorSelfDelegation: "1000000000000"
  # genesis community pool in the bond denom (split across the root councils
  # at chain start); adds to total supply on top of the accounts above
  # communityPool: "95000000000000"
topology:
  validators: { count: 1 }
  # per-validator staking monikers (default: <name>-val-<index>)
  # validators: { count: 1, monikers: ["🦢 Svanmøy-01 // ⚡"] }
  # tmkms with a pre-existing consensus key (hardware signer): pin each
  # validator's ed25519 pubkey (base64, from comet show-validator or a gentx);
  # the launcher then exports no key and the setup panel configures your device
  # validators: { count: 1, consensusPubkeys: ["OElT4VJpHCEW//d/q5FjCQ7i8EZURn49PSeB7MHp8ds="] }
  sentries: { count: 1 }
  components:
    # route: the ping-pub path baked into the image, when it differs from network.name
    explorer: { enabled: false, domain: explorer.example.com, route: sparkdream }
    frontend: { enabled: false, domain: app.example.com }
    hub: { enabled: false }
    # IBC relayer (Hermes): one process, any number of paths. kind transfer
    # moves tokens (ICS-20); kind federation carries x/federation content to
    # a sister Spark Dream chain. A counterparty is another fleet on this
    # launcher (over the shared mesh, or its sentry's public ports when it
    # runs its own) or any chain by its endpoints. Once launched, the
    # relayer card's settings… edits these without YAML.
    # The relayer's key sits on its provider (Hermes cannot use a session
    # key): fund it with gas money only. maxBalance caps what the launcher
    # asks for on Spark Dream chains; set one per endpoint chain too.
    # relayer:
    #   enabled: true
    #   genesisBalance: "25000000"     # this chain, at genesis
    #   maxBalance: "100000000"
    #   paths:
    #     - { id: sister, kind: federation, counterparty: { fleet: <launch id or network name> } }
    #     - id: osmosis
    #       kind: transfer
    #       counterparty:
    #         chainId: osmo-test-5
    #         rpc: https://rpc.osmotest5.example.com
    #         grpc: http://grpc.osmotest5.example.com:9090
    #         bech32Prefix: osmo
    #         gasDenom: uosmo
    #         gasPrice: 0.025
    #         maxBalance: "5000000"
    #         # optional: follow Osmosis' fee market up to max (gasPrice is the fallback),
    #         # poll instead of the websocket, and a gas limit margin (default 2.5)
    #         # dynamicGasPrice: { multiplier: 1.1, max: 0.1 }
    #         # eventSource: pull
    #         # gasMultiplier: 1.5
    #       # optional: keep the path ready but unopened until the relayer's key on
    #       # this chain is funded (linking skips it instead of pausing; relink after)
    #       # openWhenFunded: true
    # Mastodon instance (web + sidekiq, streaming, postgres, redis in one
    # deployment). Its domain is permanent (ActivityPub ids embed it); DNS
    # needs the domain and streaming.<domain>. The owner's password shows up
    # in the fleet's accounts panel. bridge: anchor opted-in authors' posts on
    # this chain (needs publicEndpoints.api; registers the instance as an
    # ActivityPub peer and bonds a bridge operator, 1000 SPARK). The bridge
    # signs through a session key; the operator's key stays here. Its account
    # on the instance is named after the network (bridgedev, bridgetest,
    # bridge on mainnet). An instance several chains share belongs in a
    # services fleet, each chain linking it with a standalone bridge (below).
    # mastodon:
    #   enabled: true
    #   domain: social.example.com
    #   owner: { username: admin, email: you@example.com }
    #   registrations: none            # none (default: bridge only) | approved | open
    #   size: small                    # small (~2 CPU, 3.6 GB) | standard (~4 CPU, 8 GB); fixed per deployment
    #   # outgoing mail, so sign-ups can confirm their address (only needed
    #   # when registrations is not none); the password moves to the
    #   # launcher's secret store when the component is added
    #   smtp:
    #     server: smtp.example.com
    #     port: 587                    # security: starttls (587) | tls (465) | none
    #     login: apikey
    #     password: <relay password or API key>
    #     fromAddress: "Mastodon <notifications@example.com>"
    #   # members sign in with Keplr (sdaplogin, sdap image) on their own domain
    #   # (default: mstdn.example.io -> mstdn-login.example.io, same depth):
    #   # handle = their x/name, no email or password; chains linked by a
    #   # standalone bridge are offered too. Needs publicEndpoints api + rpc
    #   walletLogin: { enabled: true, minTrustLevel: new }   # new | provisional | established | trusted | core
    #   bridge: { enabled: true }
    # Standalone bridge: links a Mastodon another fleet runs (typically a
    # services fleet) to THIS chain, with its own account there, its own
    # peer, operator bond and session key here. Not together with a Mastodon
    # bridge sidecar in the same fleet.
    # bridge:
    #   enabled: true
    #   target: { fleet: <services fleet's network name or launch id> }
    #   # account: bridgedev          # default: by this network's type
    # Content verifier (sdapverify) for the bridge's anchored posts, on its
    # own deployment and never on the Mastodon's provider. Acts as a member
    # (ESTABLISHED+) of the target chain and bonds 500 DREAM as
    # federation-verifier: account names a generated member (the launcher
    # signs as it), or wallet gives a member address whose key stays in your
    # wallet (the launcher pauses for your signature to bond and to grant or
    # renew the session key). target: another fleet's chain (omit: this one);
    # peers default to the target's Mastodon domain. It signs through a
    # session key, renewed with a third of its lifetime left: session.days
    # defaults to 90 (30 on mainnet), within the chain's
    # chainParams.session.maxExpirationDays.
    # verifier:
    #   enabled: true
    #   account: vera                  # or: wallet: <your member address>
    #   # session: { days: 90, spendLimit: "25000000" }
    #   # target: { fleet: <launch id or network name> }
    #   # alarmWebhook: https://hooks.example.com/sdapverify
  # required when frontend is enabled — sentry-0 serves these domains:
  # publicEndpoints:
  #   api: api.example.com
  #   rpc: rpc.example.com
  headscale:
    domain: headscale.example.com
    # or share an existing fleet's mesh instead of deploying a headscale
    # (one tailscale login on a tmkms signer reaches every sharing fleet):
    # reuseFleet: <launch id or network name of the owning fleet>
# providers:
#   policy:
#     # pause every deployment with its bids listed and lease the one you pick
#     # (the guided "provider selection" toggle writes this); per component
#     # group, set providers.components.<group>.manualBid instead
#     manualBid: true
#   # fleet-wide: providers on this list may host no component
#   exclude: []
#   components:
#     # per-component exclusions, merged over the fleet-wide list. Entries are
#     # an akash1... owner address (exact match) or a case-insensitive fragment
#     # of the provider's hostname. Example: keep the coordination server off a
#     # provider whose network drops traffic from other providers, while nodes
#     # stay eligible for it:
#     headscale: { exclude: ["provider-hostname-fragment"] }
#     # validators: { exclude: [] }
#     # sentries:   { exclude: [] }
`;

// the open launch is remembered per deploy account: switching accounts in
// Keplr swaps the fleet cards, and the Launch panel has to swap with them
const lastLaunchKey = (owner: string) => `launcher.lastLaunchId.${owner}`;
const SPEC_KEY = "launcher.specText";
const MODE_KEY = "launcher.editMode";
const WALLET_CONNECTED_KEY = "launcher.walletConnected";

type EditMode = "guided" | "form" | "yaml";

/** Akash blocks are ~6.098s; used for per-month price and escrow runway. */
const BLOCKS_PER_MONTH = (30.437 * 24 * 60 * 60) / 6.098;
const BLOCKS_PER_DAY = (24 * 60 * 60) / 6.098;

const ROLE_LABELS: Array<[RegExp, string]> = [
  [/^val-/, "Validator"],
  [/^sentry-/, "Sentry node"],
  [/^headscale$/, "VPN mesh"],
  ...COMPONENT_KEYS.map((k): [RegExp, string] => [new RegExp(`^${k}$`), COMPONENT_KINDS[k].label]),
  [/^hub$/, "Hub"],
];
const roleLabel = (key: string) =>
  ROLE_LABELS.find(([re]) => re.test(key))?.[1] ?? "Service";

/** "418,320 / 1,204,885 · 34.7% · ~2h 10m left" — the caption beside the bar. */
const progressText = (p: OpProgress): string =>
  [
    p.current === undefined
      ? null
      : p.current.toLocaleString() + (p.target ? ` / ${p.target.toLocaleString()}` : ""),
    p.percent === undefined ? null : `${p.percent}%`,
    p.etaSeconds === undefined ? null : `~${duration(p.etaSeconds)} left`,
  ]
    .filter(Boolean)
    .join(" · ");

/** The rest of it, on hover: what is running, how fast, and how fresh. */
const progressTitle = (p: OpProgress): string =>
  p.label +
  (p.rate ? `, ${p.rate} blocks/s` : "") +
  (p.elapsedSeconds === undefined ? "" : `, running ${duration(p.elapsedSeconds)}`) +
  `. Updated ${new Date(p.updatedAt).toLocaleTimeString()}. ` +
  "The work runs on the node itself: closing this page does not stop it.";

/** Bytes as GiB, one decimal under 10 ("7.8 GiB", "42 GiB"). */
function gib(bytes: number): string {
  const g = bytes / 1024 ** 3;
  return `${g < 10 ? g.toFixed(1) : Math.round(g)} GiB`;
}

/** "3h 12m" / "12m" / "45s" — coarse on purpose, these are estimates. */
const duration = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

// Nebula background ported from sparkdream-ui's Imaginarium (NebulaField):
// drifting cosmic blobs, cold palette, screen-blended over the black canvas.
const NEBULA_BLOBS = [
  { top: 8,  left: 12, size: 520, color: "99, 102, 241",  duration: 72,  delay: 0,  driftX:  80, driftY: -50, peak: 0.38 }, // violet
  { top: 22, left: 68, size: 480, color: "96, 165, 250",  duration: 88,  delay: 11, driftX: -70, driftY:  60, peak: 0.32 }, // blue
  { top: 55, left: 18, size: 460, color: "52, 211, 153",  duration: 96,  delay: 22, driftX:  90, driftY:  40, peak: 0.26 }, // green
  { top: 68, left: 78, size: 540, color: "168, 85, 247",  duration: 80,  delay: 6,  driftX: -60, driftY: -70, peak: 0.34 }, // purple
  { top: 2,  left: 50, size: 420, color: "34, 211, 238",  duration: 104, delay: 16, driftX:  50, driftY:  80, peak: 0.24 }, // cyan
  { top: 82, left: 38, size: 400, color: "129, 140, 248", duration: 78,  delay: 27, driftX: -80, driftY: -40, peak: 0.30 }, // indigo
  { top: 38, left: 2,  size: 440, color: "217, 70, 239",  duration: 92,  delay: 9,  driftX: 100, driftY:  50, peak: 0.22 }, // magenta
  { top: 48, left: 55, size: 380, color: "45, 212, 191",  duration: 112, delay: 19, driftX: -40, driftY:  70, peak: 0.28 }, // teal
  { top: 15, left: 88, size: 360, color: "139, 92, 246",  duration: 86,  delay: 3,  driftX: -90, driftY:  30, peak: 0.30 }, // deep violet
];

function NebulaField() {
  return (
    <div className="sd-nebula-field" aria-hidden="true">
      {NEBULA_BLOBS.map((b, i) => (
        <span
          key={i}
          className="sd-nebula-blob"
          style={{
            top: `${b.top}%`,
            left: `${b.left}%`,
            width: `${b.size}px`,
            height: `${b.size}px`,
            animationDuration: `${b.duration}s`,
            animationDelay: `-${b.delay}s`,
            ["--sd-blob-color" as string]: b.color,
            ["--sd-blob-peak" as string]: b.peak,
            ["--sd-blob-drift-x" as string]: `${b.driftX}px`,
            ["--sd-blob-drift-y" as string]: `${b.driftY}px`,
          }}
        />
      ))}
    </div>
  );
}

/** Health/state → status dot color class. */
const healthKind = (c: ComponentView): "ok" | "warn" | "err" | "off" => {
  if (c.state !== "active") return "off";
  switch (c.health?.status) {
    case "healthy":
      return "ok";
    case "low-escrow":
    case "low-gas":
    case "catching-up":
      return "warn";
    case undefined:
      return "ok"; // no sweep yet; the lease is active
    default:
      return "err";
  }
};

/** useState persisted to localStorage. Loads after mount (the page is
 *  statically prerendered, so reading storage during render would mismatch
 *  hydration) and saves on every change. */
function usePersistedState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) setValue(JSON.parse(raw) as T);
    } catch {
      // unreadable stored value — keep the default
    }
    loaded.current = true;
  }, [key]);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable (private mode) — state still works in-memory
    }
  }, [key, value]);
  return [value, setValue] as const;
}

/** "40 minutes", "8.5 hours", "2 days". */
function hoursText(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) return `${Math.round(hours * 10) / 10} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** "sparkdreamnft/hermes:v1.0.48@sha256:8588a6…f00d": a long digest shortened, the rest as it is. */
function shortImage(image: string): string {
  const m = /^(.*@sha256:)([0-9a-f]{64})$/.exec(image);
  return m ? `${m[1]}${m[2]!.slice(0, 6)}…${m[2]!.slice(-4)}` : image;
}

/** "akash1k8j8…9476uc8": a bech32 address shortened in the middle (copy takes the whole). */
function shortAddress(address: string): string {
  return address.length > 24 ? `${address.slice(0, 10)}…${address.slice(-7)}` : address;
}

/** A component row's actions, by intent (design 2a): the group of each by its label. */
const ACTION_GROUPS: Array<{ id: string; title: string; match: RegExp }> = [
  { id: "operate", title: "Operate", match: /^(restart|logs|upload|uploading|channels|shell|unjail|resume signing|manage signer|release signer|taking over|bridge peers|back up mesh)/ },
  { id: "lease", title: "Lease", match: /^(top-up|top up|funds|relink)/ },
  { id: "deploy", title: "Deploy", match: /^(upgrade|settings|sdl|force redeploy|resize|restore)/ },
  { id: "move", title: "Move provider", match: /^relaunch/ },
];
/** Destructive ones, set apart on the right. */
const ACTION_DANGER = /^(close|remove|reset data)/;

/** The visible text of a rendered element (its label). */
function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return "";
}

/** Rendered children with fragments unwrapped and nothing-rendering ones dropped. */
function flattenActions(children: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  Children.toArray(children).forEach((child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) out.push(...flattenActions((child.props as { children?: ReactNode }).children));
    else out.push(child);
  });
  return out;
}

/**
 * Files a row's action buttons into labeled groups (Operate, Lease, Deploy,
 * Move provider) with the destructive ones in a column of their own, from
 * the buttons that actually render: each keeps its own condition, and a
 * group with none is not drawn.
 */
function ActionGroups({ children }: { children: ReactNode }) {
  const items = flattenActions(children).map((el, i) => ({ el, i, label: nodeText(el).trim().toLowerCase() }));
  const danger = items.filter((x) => ACTION_DANGER.test(x.label));
  const rest = items.filter((x) => !ACTION_DANGER.test(x.label));
  const groups = ACTION_GROUPS.map((g) => ({ ...g, items: rest.filter((x) => g.match.test(x.label)) }));
  // anything no group names joins Operate, so no action is ever lost
  const named = new Set(groups.flatMap((g) => g.items.map((x) => x.i)));
  groups[0]!.items.push(...rest.filter((x) => !named.has(x.i)));
  return (
    <div className="acts grouped">
      <div className="act-groups">
        {groups
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <div key={g.id} className={`act-group${g.id === "move" ? " move" : ""}`}>
              <div className="act-label">{g.title}</div>
              <div className="act-btns">
                {g.items.map((x) => (
                  <Fragment key={x.i}>{x.el}</Fragment>
                ))}
              </div>
            </div>
          ))}
      </div>
      {danger.length > 0 && (
        <div className="act-danger">
          {danger.map((x) => (
            <Fragment key={x.i}>{x.el}</Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Page() {
  const [chain, setChain] = useState<ChainConfig>(DEFAULT_CHAIN);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  // a reload that is about to reconnect a wallet has not resolved its open
  // launch yet: the panel waits rather than flashing the launch editor
  const [reconnecting, setReconnecting] = useState(false);
  const [specText, setSpecText] = useState(EXAMPLE_SPEC);
  const [launchId, setLaunchId] = useState<string | null>(null);
  const [launch, setLaunch] = useState<LaunchView | null>(null);
  const [pending, setPending] = useState<PendingTx | null>(null);
  const [pendingGentx, setPendingGentx] = useState<PendingGentx | null>(null);
  const [fleet, setFleet] = useState<FleetSummary | null>(null);
  const [fleetAccounts, setFleetAccounts] = useState<Record<string, AccountView[]>>({});
  const [revealedMnemonics, setRevealedMnemonics] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // the relayer funds panel: which fleet, and its keys once read
  const [relayerFundsView, setRelayerFundsView] = useState<{ launchId: string; rows: RelayerFunds[] | null } | null>(null);
  const openRelayerFunds = useCallback(async (launchId: string) => {
    setRelayerFundsView((v) => ({ launchId, rows: v?.launchId === launchId ? v.rows : null }));
    try {
      const { getRelayerFunds } = await import("../lib/api");
      const rows = await getRelayerFunds(launchId);
      setRelayerFundsView((v) => (v?.launchId === launchId ? { launchId, rows } : v));
    } catch (e) {
      setError(String(e));
      setRelayerFundsView(null);
    }
  }, []);
  // the relayer settings editor: which fleet's relayer is open in it
  const [relayerSettingsFor, setRelayerSettingsFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Coin[] | null>(null);
  const [bme, setBme] = useState<BmeInfo | null>(null);
  const [ledger, setLedger] = useState<BmeLedgerSummary | null>(null);
  const [aktPrice, setAktPrice] = useState<number | null>(null);
  const [mintAmount, setMintAmount] = useState("");
  const [warnings, setWarnings] = useState<{ path: string; message: string }[]>([]);

  // mission-control UI state
  const [mode, setMode] = useState<EditMode>("guided");
  const [wizStep, setWizStep] = useState(0);
  /** The launch card, so a join spec built on a fleet card scrolls into view. */
  const launchCardRef = useRef<HTMLElement | null>(null);
  const [wizMax, setWizMax] = useState(0);
  const [advOpen, setAdvOpen] = useState(false);
  const [costOpen, setCostOpen] = useState(false);
  const [networkOpen, setNetworkOpen] = usePersistedState("launcher.panel.network", false);
  const [fleetActsOpen, setFleetActsOpen] = usePersistedState<Record<string, boolean>>(
    "launcher.panel.fleetActs",
    {},
  );
  // fleet cards collapse by clicking the header, like the accounts card
  // (undefined = open, the useful default for a live fleet)
  const [fleetBodyOpen, setFleetBodyOpen] = usePersistedState<Record<string, boolean>>(
    "launcher.panel.fleetBody",
    {},
  );
  const [openComponent, setOpenComponent] = useState<string | null>(null);
  const [acctsOpen, setAcctsOpen] = usePersistedState<Record<string, boolean>>(
    "launcher.panel.accounts",
    {},
  );
  // lazy account fetch, driven by the open state so a persisted-open panel
  // loads its rows after a reload too
  const acctsFetching = useRef(new Set<string>());
  useEffect(() => {
    for (const fl of fleet?.fleets ?? []) {
      const id = fl.launchId;
      if (!acctsOpen[id] || fleetAccounts[id] || acctsFetching.current.has(id)) continue;
      acctsFetching.current.add(id);
      import("../lib/api").then(({ getFleetAccounts }) =>
        getFleetAccounts(id)
          .then((r) => setFleetAccounts((m) => ({ ...m, [id]: r.accounts })))
          .catch((e) => setError(String(e)))
          .finally(() => acctsFetching.current.delete(id)),
      );
    }
  }, [fleet, acctsOpen, fleetAccounts]);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(""), 2400);
  }, []);

  // localStorage only after mount — the page is statically prerendered
  useEffect(() => {
    setChain(loadChainConfig());
    setReconnecting(localStorage.getItem(WALLET_CONNECTED_KEY) !== null);
    const savedSpec = localStorage.getItem(SPEC_KEY);
    if (savedSpec) setSpecText(savedSpec);
    const savedMode = localStorage.getItem(MODE_KEY);
    if (savedMode === "guided" || savedMode === "form" || savedMode === "yaml") {
      setMode(savedMode);
    }
  }, []);

  const switchMode = (m: EditMode) => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
  };

  const updateSpec = (text: string) => {
    setSpecText(text);
    localStorage.setItem(SPEC_KEY, text);
  };

  // The editor draft is one localStorage slot, so every prefill overwrites
  // whatever is in it. An untouched example is nobody's work; anything else
  // is asked about first.
  const confirmDraftOverwrite = (): boolean =>
    specText.trim() === EXAMPLE_SPEC.trim() ||
    window.confirm(
      "Replace the spec in the editor? The draft it holds now is not saved anywhere else.",
    );

  /**
   * Land a prefill draft in the editor. Notes and validation issues lead
   * the YAML as comments so they are read before Review, which is what
   * makes a prefill a draft rather than a spec to launch on sight.
   */
  const applyPrefill = (result: SpecPrefill, source: string) => {
    const noteLines = [
      `# Prefilled from ${source}. Review before launching:`,
      ...result.notes.map((n) => `#  - ${n}`),
      ...result.issues.map((i) => `#  ${i.warning ? "warning" : "ERROR"} ${i.path}: ${i.message}`),
    ];
    updateSpec(`${noteLines.join("\n")}\n${yaml.dump(result.spec, { lineWidth: 100 })}`);
    setAdvOpen(true);
  };

  // "Prefill from genesis.json": reverse-map an uploaded genesis into a
  // spec draft; unmappable facts arrive as notes
  const prefillFromGenesisFile = async (file: File) => {
    if (!confirmDraftOverwrite()) return;
    setBusy("prefilling spec from genesis…");
    setError(null);
    try {
      const genesis = JSON.parse(await file.text());
      const { postSpecPrefill } = await import("../lib/api");
      applyPrefill(await postSpecPrefill(genesis), file.name);
    } catch (e) {
      setError(`genesis prefill: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy(null);
    }
  };

  // "Prefill from join bundle": the joiner's side of §5. The bundle's
  // fields land in four places (join, network.bech32Prefix, token,
  // images.sparkdreamd); the rest of the spec is the joiner's own and
  // arrives as notes.
  const prefillFromJoinBundleFile = async (file: File) => {
    if (!confirmDraftOverwrite()) return;
    setBusy("prefilling spec from join bundle…");
    setError(null);
    try {
      const bundle = JSON.parse(await file.text());
      const { postJoinPrefill } = await import("../lib/api");
      applyPrefill(await postJoinPrefill(bundle), file.name);
    } catch (e) {
      setError(`join bundle prefill: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy(null);
    }
  };

  /**
   * "Join spec" off a fleet card: a draft for adding a sovereign pair to
   * the chain this fleet already runs. The editor only shows when no
   * launch is open, so the open one is closed (it keeps running) and the
   * page scrolls back up to the draft it just wrote.
   */
  const joinSpecFromFleet = async (fleet: { launchId: string; chainId: string }) => {
    if (!confirmDraftOverwrite()) return;
    setBusy("building a join spec…");
    setError(null);
    try {
      const { getFleetJoinSpec } = await import("../lib/api");
      const result = await getFleetJoinSpec(fleet.launchId);
      closeLaunch();
      switchMode("yaml"); // the notes are YAML comments; guided mode hides them
      applyPrefill(result, `${fleet.chainId}'s join bundle`);
      setTimeout(
        () => launchCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
        0,
      );
    } catch (e) {
      setError(`join spec: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy(null);
    }
  };

  // The questions every services fleet draft asks: its name and its
  // Mastodon's domains. undefined when the user cancels.
  const askServicesBasics = ():
    | { name: string; domain: string; streamingDomain: string; sharing: string[] }
    | undefined => {
    const name = window.prompt("Name of the new services fleet:", "sparkdream-services")?.trim();
    if (!name) return undefined;
    const domain = window.prompt("The Mastodon instance's domain (permanent: handles are @user@<domain>):", "mstdn.example.com")?.trim();
    if (!domain) return undefined;
    // one label deep by default: a free Cloudflare certificate covers
    // *.example.com, not streaming.mstdn.example.com
    const dot = domain.indexOf(".");
    const suggested = dot > 0 ? `${domain.slice(0, dot)}-streaming${domain.slice(dot)}` : `streaming.${domain}`;
    const streamingDomain = window.prompt("Its streaming domain:", suggested)?.trim();
    if (!streamingDomain) return undefined;
    // one person's other wallets (a devnet one and a testnet one) whose
    // chain fleets should link bridges to this instance
    const shareInput = window.prompt(
      "Other Akash wallets whose chain fleets may link bridges to this instance (comma separated; empty for none):",
      "",
    );
    if (shareInput === null) return undefined;
    const sharing = shareInput.split(/[,\s]+/).map((w) => w.trim()).filter(Boolean);
    return { name, domain, streamingDomain, sharing };
  };

  // "New services fleet…": a services fleet (kind: services) from scratch,
  // the usual start for a Mastodon several chains share
  const newServicesFleet = async () => {
    const basics = askServicesBasics();
    if (!basics) return;
    const username = window.prompt("Owner account's username (the instance's admin):", "admin")?.trim();
    if (!username) return;
    const email = window.prompt("Owner's email address:")?.trim();
    if (!email) return;
    const size = window.prompt("Size: small (~2 CPU, 3.6 GB, a new community) or standard (~4 CPU, 8 GB):", "small")?.trim();
    if (size !== "small" && size !== "standard") {
      setError('size must be "small" or "standard"');
      return;
    }
    if (!confirmDraftOverwrite()) return;
    setBusy("drafting a services fleet spec…");
    setError(null);
    try {
      const { postServicesSpec } = await import("../lib/api");
      const result = await postServicesSpec({ ...basics, owner: { username, email }, size });
      closeLaunch();
      switchMode("yaml"); // the notes are YAML comments; guided mode hides them
      applyPrefill(result, "a new services fleet");
      setTimeout(() => launchCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    } catch (e) {
      setError(`services spec: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy(null);
    }
  };

  // "services spec…" on a fleet card: the same, drafted from a fleet that ran
  // Mastodon itself (its owner, SMTP, size, providers carry over)
  const servicesSpecFromFleet = async (fleet: { launchId: string; name: string }) => {
    const basics = askServicesBasics();
    if (!basics) return;
    const { name, domain, streamingDomain, sharing } = basics;
    if (!confirmDraftOverwrite()) return;
    setBusy("drafting a services fleet spec…");
    setError(null);
    try {
      const { getServicesSpec } = await import("../lib/api");
      const result = await getServicesSpec(fleet.launchId, { name, domain, streamingDomain, sharing });
      closeLaunch();
      switchMode("yaml"); // the notes are YAML comments; guided mode hides them
      applyPrefill(result, `${fleet.name}'s Mastodon settings`);
      setTimeout(() => launchCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    } catch (e) {
      setError(`services spec: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy(null);
    }
  };

  const updateChain = (patch: Partial<ChainConfig>) => {
    const next = { ...chain, ...patch };
    setChain(next);
    saveChainConfig(next);
  };

  const chainIsCustom = (Object.keys(DEFAULT_CHAIN) as (keyof ChainConfig)[]).some(
    (k) => chain[k] !== DEFAULT_CHAIN[k],
  );
  const rpcHost = useMemo(() => {
    try {
      return new URL(chain.rpc).hostname;
    } catch {
      return chain.rpc;
    }
  }, [chain.rpc]);

  const connect = useCallback(
    async (config?: ChainConfig, silent = false) => {
      const cfg = config ?? chain;
      try {
        if (!silent) setError(null);
        const w = await connectKeplr(cfg);
        // wallet-session auth when the conductor requires it (Akash mode, M6 §2)
        const { getAuthMode, authNonce, authVerify, setAuthToken, loadAuthToken } =
          await import("../lib/api");
        const authMode = await getAuthMode();
        // a persisted session token (12h server TTL) skips the re-sign
        if (authMode.required && !loadAuthToken()) {
          if (silent) return; // never pop a signature request on page load
          const { signAuthNonce } = await import("../lib/keplr");
          const nonce = await authNonce(w.address);
          const signature = await signAuthNonce(cfg, w.address, nonce);
          setAuthToken(await authVerify(w.address, signature));
        }
        setWallet(w);
        localStorage.setItem(WALLET_CONNECTED_KEY, "1");
      } catch (e) {
        // silent = auto-reconnect: site approval was likely revoked, so
        // stop trying on future loads rather than surfacing an error
        if (silent) localStorage.removeItem(WALLET_CONNECTED_KEY);
        else {
          setError(String(e));
          // a failed connect is the one moment the network fields matter
          setNetworkOpen(true);
        }
      }
    },
    [chain],
  );

  // reconnect on reload: Keplr's enable() resolves without a prompt once the
  // site is approved, so a previously connected wallet comes back silently
  const autoConnectTried = useRef(false);
  useEffect(() => {
    if (autoConnectTried.current || !localStorage.getItem(WALLET_CONNECTED_KEY)) return;
    autoConnectTried.current = true;
    const cfg = loadChainConfig(); // chain state may not have hydrated yet
    (async () => {
      const { waitForKeplr } = await import("../lib/keplr");
      if (await waitForKeplr()) await connect(cfg, true);
      setReconnecting(false);
    })();
  }, [connect]);

  // account switched in Keplr → the session token and wallet-scoped views
  // belong to the old address; drop them and reconnect as the new account
  useEffect(() => {
    if (!wallet) return;
    const onKeystoreChange = async () => {
      const { setAuthToken } = await import("../lib/api");
      setAuthToken(null);
      setWallet(null);
      setBalances(null);
      setLedger(null);
      setFleet(null);
      setReconnecting(true);
      await connect(undefined, true);
      setReconnecting(false);
    };
    window.addEventListener("keplr_keystorechange", onKeystoreChange);
    return () => window.removeEventListener("keplr_keystorechange", onKeystoreChange);
  }, [wallet, connect]);

  const importSpec = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => updateSpec(String(reader.result));
    reader.readAsText(file);
  };

  const exportSpec = () => {
    const blob = new Blob([specText], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "launch.yaml";
    a.click();
    URL.revokeObjectURL(url);
  };

  // launcher backup (machine migration): a passphrase modal drives both the
  // encrypted export and the merge-import
  // chain-data backups dialog (data-backup / data-restore ops), by launch id
  const [chainBackupsFor, setChainBackupsFor] = useState<string | null>(null);
  // design 4a: the resize dialog (sizes from GET resize-options)
  const [resizeFor, setResizeFor] = useState<{
    launchId: string;
    dseq: string;
    key: string;
    pick: "small" | "standard" | "large" | null;
    opts?: import("../lib/api").ResizeOptions;
    error?: string;
  } | null>(null);
  const openResize = async (launchId: string, dseq: string, key: string) => {
    setResizeFor({ launchId, dseq, key, pick: null });
    try {
      const { getResizeOptions } = await import("../lib/api");
      const opts = await getResizeOptions(launchId, dseq);
      // the next size up that fits, else any other that fits
      const order = ["small", "standard", "large"] as const;
      const fits = opts.sizes.filter((z) => z.id !== opts.current.size && !z.tooSmall).map((z) => z.id);
      const up = order.slice(order.indexOf(opts.current.size as (typeof order)[number]) + 1).find((z) => fits.includes(z));
      setResizeFor((r) => (r && r.dseq === dseq ? { ...r, opts, pick: up ?? fits[fits.length - 1] ?? null } : r));
    } catch (e) {
      setResizeFor((r) => (r && r.dseq === dseq ? { ...r, error: String(e) } : r));
    }
  };
  const chainBackupAction = async (
    launchId: string,
    settings: { schedule?: "off" | "daily" | "weekly"; autoRestore?: boolean; source?: string | null } = {},
  ) => {
    setError(null);
    try {
      const { postDataBackup, getFleet } = await import("../lib/api");
      const res = await postDataBackup(launchId, settings);
      if (res.source) {
        showToast(`backing up ${res.source}'s chain data: follow it in the Launch panel`);
        setChainBackupsFor(null);
        openLaunch(launchId);
      } else if (wallet) {
        setFleet(await getFleet(wallet.address));
      }
    } catch (e) {
      setError(String(e));
    }
  };
  const removeChainBackup = async (launchId: string, b: { name: string; height: number; verified: boolean }) => {
    const what = `the backup at height ${b.height.toLocaleString("en-US")}`;
    const ask = b.verified
      ? `Delete ${what} from the bucket? It passed its check and could still be restored.`
      : `Delete ${what} from the bucket? It was never checked after its upload, so it may not restore anyway.`;
    if (!window.confirm(ask)) return;
    setError(null);
    try {
      const { deleteDataBackup, getFleet } = await import("../lib/api");
      await deleteDataBackup(launchId, b.name);
      showToast(`deleted ${what}`);
      if (wallet) setFleet(await getFleet(wallet.address));
    } catch (e) {
      setError(String(e));
    }
  };
  const restoreNodeFromBackup = async (
    f: import("../lib/api").FleetSummary["fleets"][number],
    key: string,
  ) => {
    const usable = (f.dataBackups?.backups ?? []).filter((b) => b.blocker === null);
    if (usable.length === 0) {
      setError(`no usable chain-data backup for ${f.name}: take one from "chain backups…" first`);
      return;
    }
    const pick = window.prompt(
      `Replace ${key}'s chain data with which backup? The node stops (its container restarts held), its ` +
        "data directory is replaced, and it starts again and syncs from the backup's height to the head. " +
        "Its keys and signing state stay.\n" +
        usable
          .map((b, i) => `  ${i + 1}. height ${b.height}, ${new Date(b.takenAt).toLocaleString()} (from ${b.from})`)
          .join("\n"),
      "1",
    )?.trim();
    if (!pick) return;
    const chosen = usable[Number(pick) - 1];
    if (!chosen) {
      setError("pick a number from the list");
      return;
    }
    try {
      const { postDataRestore } = await import("../lib/api");
      await postDataRestore(f.launchId, key, chosen.name);
      showToast(`restoring ${key} from height ${chosen.height}: follow it in the Launch panel`);
      openLaunch(f.launchId);
    } catch (e) {
      setError(String(e));
    }
  };
  // headscale mesh backup form (mesh-backup op)
  // the fleet card's add… dialog (design 1a): what to add, and how it is placed
  const [addForm, setAddForm] = useState<{
    launchId: string;
    name: string;
    /** the fleet's current USD/month, for the footer's "fleet after" */
    fleetMonthly: number | null;
    /** loaded from the conductor when the dialog opens */
    options: import("../lib/api").AddOptions | null;
    key: string;
    pickerOpen: boolean;
    /** lease a bid of the operator's choosing (the lease step parks with every bid) */
    manualBid: boolean;
    size: "small" | "standard" | "large";
    domain: string;
    bridgeTarget: string;
    verifierWallet: string;
  } | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  /** Open the add dialog for a fleet, reading what it can add; `prefer` preselects a choice (the backups dialog's "add a second sentry"). */
  const openAddDialog = (launchId: string, name: string, fleetMonthly: number | null, prefer?: string) => {
    setAddForm({
      launchId,
      name,
      fleetMonthly,
      options: null,
      key: "",
      pickerOpen: false,
      manualBid: false,
      size: "standard",
      domain: "",
      bridgeTarget: "",
      verifierWallet: "",
    });
    void import("../lib/api")
      .then(({ getAddOptions }) => getAddOptions(launchId))
      .then((options) =>
        setAddForm((cur) => {
          if (!cur || cur.launchId !== launchId) return cur;
          const choices = [...(options.sentry ? ["sentry"] : []), ...options.kinds.map((k) => k.key)];
          const key = prefer && choices.includes(prefer) ? prefer : (choices[0] ?? "");
          return { ...cur, options, key };
        }),
      )
      .catch((e) => {
        setAddForm(null);
        setError(String(e));
      });
  };
  const submitAdd = async () => {
    if (!addForm) return;
    const { launchId, key, manualBid } = addForm;
    setError(null);
    setAddBusy(true);
    try {
      if (key === "sentry") {
        const { postAddSentry } = await import("../lib/api");
        const started = await postAddSentry(launchId, addForm.size, manualBid);
        showToast(`adding ${started.key}: follow it in the Launch panel`);
      } else {
        if (!isComponentKey(key)) throw new Error(`"${key}" is not a component kind`);
        // kinds with structured settings (the relayer's paths, mastodon's
        // owner and bridge) take them from the spec editor, as the domains
        // button takes domains; the bridge and verifier need one value each
        let settings: Record<string, unknown> | undefined;
        if (key === "relayer" || key === "mastodon" || key === "verifier" || key === "bridge") {
          const edited = yaml.load(specText) as any;
          settings = edited?.topology?.components?.[key];
          if ((!settings || typeof settings !== "object") && key === "bridge" && addForm.bridgeTarget.trim()) {
            settings = { enabled: true, target: { fleet: addForm.bridgeTarget.trim() } };
          }
          if ((!settings || typeof settings !== "object") && key === "verifier" && addForm.verifierWallet.trim()) {
            settings = { enabled: true, wallet: addForm.verifierWallet.trim() };
          }
          if (!settings || typeof settings !== "object") {
            throw new Error(
              key === "bridge"
                ? "name the Mastodon fleet to bridge to"
                : key === "verifier"
                  ? "give the verifier's member address"
                  : `add topology.components.${key} in the spec editor first (see the example spec), then add the ${COMPONENT_KINDS[key].label}`,
            );
          }
        }
        const domain =
          addForm.domain.trim() || (typeof settings?.domain === "string" ? (settings.domain as string) : undefined);
        if (COMPONENT_KINDS[key].domain && !domain) throw new Error(`the ${COMPONENT_KINDS[key].label} needs a public domain`);
        const { postAddComponent } = await import("../lib/api");
        await postAddComponent(launchId, {
          key,
          ...(domain ? { domain } : {}),
          ...(settings ? { settings } : {}),
          ...(manualBid ? { manualBid: true } : {}),
        });
      }
      setAddForm(null);
      openLaunch(launchId); // surfaces the signing banner (and the bid list, when picking)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setAddBusy(false);
    }
  };
  const [meshBackupForm, setMeshBackupForm] = useState<
    | (import("../lib/api").MeshBackupStorage & { launchId: string; network: string; secret: string; known: boolean })
    | null
  >(null);
  const [meshBackupBusy, setMeshBackupBusy] = useState(false);
  const openMeshBackup = async (launchId: string, network: string) => {
    setError(null);
    let known: import("../lib/api").MeshBackupStorage | null = null;
    try {
      const { getMeshBackupStorage } = await import("../lib/api");
      known = (await getMeshBackupStorage(launchId)).known;
    } catch {
      known = null;
    }
    setMeshBackupForm({
      launchId,
      network,
      endpoint: known?.endpoint ?? "",
      bucket: known?.bucket ?? "",
      region: known?.region ?? "us-west-2",
      accessKeyId: known?.accessKeyId ?? "",
      secret: "",
      known: known !== null,
    });
  };
  const submitMeshBackup = async () => {
    if (!meshBackupForm) return;
    setMeshBackupBusy(true);
    setError(null);
    try {
      const { postMeshBackup, getFleet } = await import("../lib/api");
      const { launchId, endpoint, bucket, region, accessKeyId, secret } = meshBackupForm;
      await postMeshBackup(launchId, { endpoint, bucket, region, accessKeyId, ...(secret ? { secret } : {}) });
      setMeshBackupForm(null);
      if (wallet) setFleet(await getFleet(wallet.address));
    } catch (e) {
      setError(String(e));
    } finally {
      setMeshBackupBusy(false);
    }
  };
  const [backupPrompt, setBackupPrompt] = useState<
    null | { mode: "export" } | { mode: "import"; file: File }
  >(null);
  const [backupPass, setBackupPass] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupReport, setBackupReport] = useState<BackupImportReport | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);

  // settings cog: menu items open the System panel above the Launch panel
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const [systemOpen, setSystemOpen] = usePersistedState("launcher.panel.system", false);
  // Cloudflare DNS token and the wallet's unattended recovery, loaded with the System panel
  const [dnsSet, setDnsSet] = useState<boolean | null>(null);
  const [dnsZones, setDnsZones] = useState<string[]>([]);
  const [dnsOrigin, setDnsOrigin] = useState(false);
  const [dnsToken, setDnsToken] = useState("");
  const [unattended, setUnattended] = useState<import("../lib/api").UnattendedStatus | null>(null);
  const [unattendedCap, setUnattendedCap] = useState("");
  const [unattendedSaving, setUnattendedSaving] = useState(false);
  const loadUnattended = useCallback(async (owner: string) => {
    try {
      const { getUnattended } = await import("../lib/api");
      const u = await getUnattended(owner);
      setUnattended(u);
      setUnattendedCap(String(Number(u.settings.dailyCap.amount) / 1e6));
    } catch {
      setUnattended(null);
    }
  }, []);
  // incident alert channels, loaded when the System panel opens
  const [alertForm, setAlertForm] = useState<{
    topic: string;
    server: string;
    webhook: string;
    /** typed here only to replace the stored token; the stored one is never shown */
    token: string;
    tokenSet: boolean;
    /** fallback ntfy topic (server: ntfy.sh unless given as https://server/topic) */
    fallback: string;
  } | null>(null);
  const [alertNote, setAlertNote] = useState<string | null>(null);
  useEffect(() => {
    if (!systemOpen) return;
    setAlertNote(null);
    import("../lib/api")
      .then(({ getAlertSettings }) => getAlertSettings())
      .then((a) =>
        setAlertForm({
          topic: a.ntfy?.topic ?? "",
          server: a.ntfy?.server && a.ntfy.server !== "https://ntfy.sh" ? a.ntfy.server : "",
          webhook: a.webhook ?? "",
          token: "",
          tokenSet: Boolean(a.ntfyTokenSet),
          fallback: a.ntfyFallback
            ? a.ntfyFallback.server === "https://ntfy.sh"
              ? a.ntfyFallback.topic
              : `${a.ntfyFallback.server}/${a.ntfyFallback.topic}`
            : "",
        }),
      )
      .catch(() => setAlertForm({ topic: "", server: "", webhook: "", token: "", tokenSet: false, fallback: "" }));
    import("../lib/api")
      .then(({ getDnsSettings }) => getDnsSettings())
      .then((d) => {
        setDnsSet(d.cloudflare);
        setDnsZones(d.zones ?? []);
        setDnsOrigin(Boolean(d.originRules));
      })
      .catch(() => setDnsSet(null));
    if (wallet) void loadUnattended(wallet.address);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemOpen, wallet?.address]);
  const [sysFocus, setSysFocus] = useState<"backup" | "assets" | "recovery" | null>(null);
  const openSystem = (section: "backup" | "assets" | "recovery") => {
    setSettingsOpen(false);
    setSystemOpen(true);
    setSysFocus(section);
  };
  // the menu entry's block, once the panel has rendered it
  useEffect(() => {
    if (!systemOpen || !sysFocus) return;
    const t = setTimeout(() => document.querySelector(".sys-block.focus")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    return () => clearTimeout(t);
  }, [systemOpen, sysFocus]);
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!settingsRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [settingsOpen]);

  const runBackup = async () => {
    if (!backupPrompt || !backupPass) return;
    setBackupBusy(true);
    setBackupError(null);
    try {
      if (backupPrompt.mode === "export") {
        await exportLauncherBackup(backupPass);
      } else {
        setBackupReport(await importLauncherBackup(backupPrompt.file, backupPass));
      }
      setBackupPrompt(null);
      setBackupPass("");
      // pull the restored fleets in now rather than waiting for the 5s poll
      if (backupPrompt.mode === "import" && wallet) setFleet(await getFleet(wallet.address));
    } catch (e) {
      // surfaced in the System panel's backup block, next to the buttons
      setBackupError(e instanceof Error ? e.message : String(e));
      setBackupPrompt(null);
    } finally {
      setBackupBusy(false);
    }
  };

  const [tmkms, setTmkms] = useState<import("../lib/api").TmkmsSetup | null>(null);
  const [tmkmsId, setTmkmsId] = useState<string | null>(null);
  const [tmkmsStatus, setTmkmsStatus] = useState<import("../lib/api").TmkmsStatus | null>(null);
  const [localSigner, setLocalSigner] = useState<import("../lib/api").LocalSignerView | null>(null);
  const [localSignerBusy, setLocalSignerBusy] = useState<string | null>(null);
  // per-validator signing deltas, diffed between status polls: the stall
  // signal (0 new blocks while connected) lives in the delta, not the counters
  const [tmkmsSignDeltas, setTmkmsSignDeltas] = useState<Record<string, { seen: number; missed: number } | null>>({});
  const tmkmsPrevCounters = useRef<Record<string, { missed: number; offset: number }>>({});
  const showTmkms = async (id: string) => {
    setError(null);
    try {
      const { getTmkmsSetup } = await import("../lib/api");
      setTmkms(await getTmkmsSetup(id));
      setTmkmsId(id);
    } catch (e) {
      setError(String(e));
    }
  };
  const closeTmkms = () => {
    setTmkms(null);
    setTmkmsId(null);
    setTmkmsStatus(null);
    setLocalSigner(null);
    setTmkmsSignDeltas({});
    tmkmsPrevCounters.current = {};
  };


  // wallet-scoped fleet view (§2): connect wallet → see your fleets
  useEffect(() => {
    if (!wallet) return;
    let stop = false;
    const tick = () =>
      getFleet(wallet.address)
        .then((f) => {
          if (stop) return;
          setFleet(f);
          for (const fl of f.fleets) refreshProviderPrefs(fl.launchId);
        })
        .catch(() => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [wallet]);

  // The Launch panel opens on a launch of the CONNECTED account, and only
  // ever on one: the fleet view is wallet-scoped, so an id remembered while
  // another deploy account was connected (the reported case: switching from
  // the testnet account to the devnet one) left the header naming a chain
  // that no card below it belonged to. The account's own fleets are the
  // authority, re-checked on every sweep — so a launch whose account is no
  // longer connected cannot stay open either, unless the account that took
  // its place has no fleets to rank (a validator operator connecting to sign
  // its gentx: openLaunchFor).
  const owner = wallet?.address ?? null;
  const openLaunch = useCallback(
    (id: string) => {
      if (owner) localStorage.setItem(lastLaunchKey(owner), id);
      setLaunchId(id);
    },
    [owner],
  );
  // "new launch": the editor is open by choice, so nothing reattaches to it
  const closeLaunch = useCallback(() => {
    if (owner) localStorage.setItem(lastLaunchKey(owner), EDITOR);
    setLaunchId(null);
  }, [owner]);
  // a deleted launch is not a choice to remember: the account falls back to
  // whatever it is still running
  const forgetLaunch = useCallback(() => {
    if (owner) localStorage.removeItem(lastLaunchKey(owner));
    setLaunchId(null);
  }, [owner]);
  useEffect(() => {
    // A Keplr account switch drops the wallet for a beat before it reconnects
    // as the new account. The open launch waits out that gap instead of being
    // cleared in it: a gentx signer switches accounts exactly here, and the
    // banner it came for is in this panel. The new account's own fleet sweep
    // re-resolves it a moment later.
    if (!owner || !fleet) return;
    const next = openLaunchFor(
      localStorage.getItem(lastLaunchKey(owner)),
      fleet.fleets.map((f) => ({
        launchId: f.launchId,
        launchStatus: f.launchStatus,
        alive: f.components.some((c) => c.state !== "closed"),
      })),
      launchId,
    );
    // a signing account has no fleets to rank, so nothing would re-derive
    // this after a reload: remember what it is holding open
    if (next && fleet.fleets.length === 0) localStorage.setItem(lastLaunchKey(owner), next);
    setLaunchId(next);
  }, [owner, fleet, launchId]);

  // real-time block height for active nodes (validators + sentries; not
  // headscale/explorer/frontend — they have no RPC). Lighter + faster than
  // the 45s health sweep; re-derives its target list from the current fleet.
  const heightTargets = useMemo(
    () =>
      (fleet?.fleets ?? []).flatMap((f) =>
        f.components
          .filter((c) => /^(val|sentry)-/.test(c.key) && c.state === "active")
          .map((c) => ({ launchId: f.launchId, dseq: c.dseq })),
      ),
    [fleet],
  );
  useEffect(() => {
    if (heightTargets.length === 0) return;
    let stop = false;
    const tick = async () => {
      const { getComponentHeight } = await import("../lib/api");
      await Promise.all(
        heightTargets.map(async ({ launchId, dseq }) => {
          const h = await getComponentHeight(launchId, dseq).catch(() => null);
          if (h && !stop) setLiveHeights((m) => ({ ...m, [dseq]: h }));
        }),
      );
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [heightTargets]);

  // how full each node's data volume is: it fills over days, so once a
  // minute is plenty (the conductor caches the read for as long)
  useEffect(() => {
    if (heightTargets.length === 0) return;
    let stop = false;
    const tick = async () => {
      const { getComponentDisk } = await import("../lib/api");
      await Promise.all(
        heightTargets.map(async ({ launchId, dseq }) => {
          const d = await getComponentDisk(launchId, dseq).catch(() => null);
          if (d && !stop) setNodeDisks((m) => ({ ...m, [dseq]: d }));
        }),
      );
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [heightTargets]);

  // compute-network balances + BME mint state (console-air's mint & burn
  // flow, §mint): deployments on mainnet are paid in uact, acquired by
  // burning uakt via MsgMintACT — settled asynchronously by the BME ledger
  useEffect(() => {
    if (!wallet) return;
    let stop = false;
    fetchBmeInfo(chain.rest)
      .then((b) => !stop && setBme(b))
      .catch(() => {});
    const tick = async () => {
      try {
        const b = await fetchBalances(chain.rest, wallet.address);
        if (stop) return;
        setBalances(b);
        setLedger(await fetchBmeLedger(chain.rest, wallet.address).catch(() => null));
      } catch {
        // LCD hiccups are non-fatal; keep the last known balances
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    // AKT price feeds the ACT-output estimate only — refreshed sparingly
    // (coingecko rate limits), the chain applies the real oracle rate
    const priceTick = () => fetchAktUsdPrice().then((p) => !stop && p && setAktPrice(p));
    priceTick();
    const pt = setInterval(priceTick, 60000);
    return () => {
      stop = true;
      clearInterval(t);
      clearInterval(pt);
    };
  }, [wallet, chain.rest]);

  // the wallet grants (or revokes) unattended recovery: plain Keplr signing
  // of the msgs the conductor builds for the launcher's key
  const signUnattended = async (kind: "grant" | "revoke") => {
    if (!wallet) return;
    setBusy(kind === "grant" ? "granting unattended recovery in Keplr…" : "revoking unattended recovery in Keplr…");
    setError(null);
    try {
      const { getUnattendedMsgs } = await import("../lib/api");
      const { msgs } = await getUnattendedMsgs(wallet.address, kind, 30);
      const client = await SigningStargateClient.connectWithSigner(chain.rpc, wallet.signer, {
        registry: launcherRegistry(),
        gasPrice: GasPrice.fromString(`${chain.gasPrice}${chain.denom}`),
      });
      const result = await client.signAndBroadcast(wallet.address, msgs.map(toEncodeObject), "auto");
      if (result.code !== 0) throw new Error(`tx rejected on-chain (code ${result.code}): ${result.rawLog ?? ""}`);
      showToast(kind === "grant" ? "unattended recovery granted for 30 days" : "unattended recovery revoked");
      await loadUnattended(wallet.address);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const mint = async () => {
    if (!wallet) return;
    const akt = Number(mintAmount);
    if (!Number.isFinite(akt) || akt <= 0) return setError("enter a positive AKT amount to mint");
    if (belowMinMint && bme?.min_mint_uact) {
      return setError(
        `estimated output is below the network minimum of ${Number(bme.min_mint_uact) / 1e6} ACT: the chain would cancel this mint at settlement`,
      );
    }
    setBusy("minting ACT in Keplr…");
    setError(null);
    try {
      const client = await SigningStargateClient.connectWithSigner(chain.rpc, wallet.signer, {
        registry: launcherRegistry(),
        gasPrice: GasPrice.fromString(`${chain.gasPrice}${chain.denom}`),
      });
      const msg = mintActMsg(wallet.address, {
        denom: "uakt",
        amount: String(Math.round(akt * 1e6)),
      });
      const result = await client.signAndBroadcast(wallet.address, [toEncodeObject(msg)], "auto");
      if (result.code !== 0) {
        throw new Error(`tx rejected on-chain (code ${result.code}): ${result.rawLog ?? ""}`);
      }
      setMintAmount("");
      // optimistic until the next ledger poll — settlement is asynchronous
      setLedger((s) => (s ? { ...s, pending: s.pending + 1 } : s));
      showToast("mint broadcast, the ACT arrives after the next settlement epoch");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const microToDisplay = (amount: string | null | undefined) =>
    amount == null
      ? "—"
      : (Number(amount) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });
  const balanceOf = (denom: string) => balances?.find((c) => c.denom === denom)?.amount ?? null;
  const denomLabel = chain.denom.replace(/^u/, "").toUpperCase();

  // Akash lease price is micro-denom PER BLOCK (DecCoin). Convert to
  // whole-denom PER MONTH the way console-air does.
  const monthlyNum = (microPerBlock: string) => {
    const perBlock = Number(microPerBlock);
    return Number.isFinite(perBlock) ? (perBlock / 1e6) * BLOCKS_PER_MONTH : null;
  };
  const priceMonthly = (microPerBlock: string, microDenom: string) => {
    const monthly = monthlyNum(microPerBlock);
    if (monthly === null) return "—";
    const denom = microDenom.replace(/^u/, "").toUpperCase(); // uact → ACT
    // ACT is USD-pegged 1:1 → show dollars like console-air; other denoms
    // (e.g. sandbox AKT) aren't USD, so label them with the token
    return denom === "ACT" ? `$${monthly.toFixed(2)}/mo` : `${monthly.toFixed(2)} ${denom}/mo`;
  };

  // escrow balance: micro-denom amount → whole tokens ($ for ACT)
  const balanceDisplay = (microAmount: string, microDenom: string) => {
    const whole = Number(microAmount) / 1e6;
    if (!Number.isFinite(whole)) return "—";
    const denom = microDenom.replace(/^u/, "").toUpperCase();
    return denom === "ACT" ? `$${whole.toFixed(2)}` : `${whole.toFixed(2)} ${denom}`;
  };

  // escrow runway in days at the current lease price
  const runwayDays = (c: ComponentView): number | null => {
    if (c.escrow == null) return null;
    const perBlock = Number(c.price);
    const escrow = Number(c.escrow);
    if (!Number.isFinite(perBlock) || perBlock <= 0 || !Number.isFinite(escrow)) return null;
    return escrow / (perBlock * BLOCKS_PER_DAY);
  };
  const runwayClass = (d: number) => (d < 7 ? "err" : d < 14 ? "warn" : "ok");

  // UI estimate of the mint output (ACT is USD-pegged, so ACT ≈ AKT × price,
  // less the on-chain spread). Mints whose estimated output is below
  // params.min_mint are CANCELED at settlement, not rejected at broadcast —
  // so gate here, like console-air, instead of letting them fail silently.
  const mintAkt = Number(mintAmount);
  const estimatedMintUact =
    aktPrice !== null && Number.isFinite(mintAkt) && mintAkt > 0
      ? Math.floor(mintAkt * aktPrice * 1e6 * (1 - (bme?.mint_spread_bps ?? 0) / 10000))
      : null;
  const belowMinMint =
    estimatedMintUact !== null &&
    bme?.min_mint_uact != null &&
    estimatedMintUact < Number(bme.min_mint_uact);

  // pre-launch deposit estimate so the user can mint ACT in advance: one
  // deployment per node plus headscale, 5 ACT/AKT escrow each (the
  // conductor's DEFAULT_DEPOSIT; estimate-costs refines). Gas fees come on
  // top but are small next to the deposits.
  const DEPOSIT_PER_DEPLOYMENT = 5_000_000;
  const requiredDeposit = useMemo(() => {
    try {
      const spec = yaml.load(specText) as any;
      const nodeCount =
        (spec?.topology?.validators?.count ?? 0) + (spec?.topology?.sentries?.count ?? 0);
      if (nodeCount <= 0) return null;
      const comps = spec?.topology?.components ?? {};
      const componentCount = COMPONENT_KEYS.filter((k) => comps[k]?.enabled).length;
      return (nodeCount + 1 + componentCount) * DEPOSIT_PER_DEPLOYMENT;
    } catch {
      return null; // spec doesn't parse — validation will complain elsewhere
    }
  }, [specText]);
  const depositShortfall =
    requiredDeposit !== null && balances !== null
      ? Math.max(0, requiredDeposit - Number(balanceOf(chain.denom) ?? "0"))
      : 0;
  const walletReady = wallet !== null && balances !== null && depositShortfall === 0;
  const depositActStr =
    requiredDeposit !== null ? `~${microToDisplay(String(requiredDeposit))} ${denomLabel}` : "—";
  const haveAct = Number(balanceOf(chain.denom) ?? "0");
  const actPct =
    requiredDeposit !== null && balances !== null
      ? Math.min(100, (haveAct / requiredDeposit) * 100)
      : 0;

  // complete validation on every keystroke: YAML parse, then the same
  // pipeline the conductor runs on submit (profile defaults + schema with
  // every issue collected + cross-field checks)
  const specCheck = useMemo((): SpecCheck => {
    let doc: unknown;
    try {
      doc = yaml.load(specText);
    } catch (e: any) {
      const line = typeof e?.mark?.line === "number" ? `line ${e.mark.line + 1}: ` : "";
      const reason = String(e?.reason ?? e?.message ?? e).split("\n")[0]!;
      return {
        spec: null,
        errors: [{ path: "", message: `${line}${reason} (YAML syntax)` }],
        warnings: [],
        ok: false,
      };
    }
    if (doc == null || typeof doc !== "object") {
      return {
        spec: null,
        errors: [{ path: "", message: "spec is empty" }],
        warnings: [],
        ok: false,
      };
    }
    return checkSpec(doc);
  }, [specText]);

  // ---- guided/form binding: the YAML spec stays the single source of truth;
  // form fields read the parsed document and write back targeted patches.
  // (A form edit re-serializes the YAML, so hand-written comments are lost
  // the first time a field is touched — the values themselves survive.)
  const specDoc = useMemo(() => {
    try {
      const d = yaml.load(specText);
      return d && typeof d === "object" ? (d as any) : null;
    } catch {
      return null;
    }
  }, [specText]);

  const patchSpec = (fn: (doc: any) => void) => {
    let doc: any;
    try {
      doc = yaml.load(specText) ?? {};
    } catch {
      return; // broken YAML can only be fixed in YAML mode
    }
    if (typeof doc !== "object") doc = {};
    fn(doc);
    updateSpec(yaml.dump(doc, { lineWidth: 120, noRefs: true }));
  };

  // ---- §13 chain assets: ask the conductor what the spec's chain version
  // resolves to (baked/cache/tag/pin), or whether it needs a commit prompt
  // (no matching chain-repo tag) or is unavailable (baked mode, not local).
  const specImage: string | undefined = (specCheck.spec as any)?.images?.sparkdreamd;
  const specRepoPin: string | undefined = (specCheck.spec as any)?.images?.chainRepoCommit;
  const [chainAssets, setChainAssets] = useState<ChainAssetsView | null>(null);
  const [assetsNonce, setAssetsNonce] = useState(0);
  useEffect(() => {
    // without a spec image there is no resolution preview, but mode/locked
    // still power the settings-menu Offline/Online toggle
    let stale = false;
    const t = setTimeout(() => {
      getChainAssets(specImage, specImage ? specRepoPin : undefined)
        .then((v) => !stale && setChainAssets(v))
        .catch(() => !stale && setChainAssets(null));
    }, 400);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [specImage, specRepoPin, assetsNonce]);
  const toggleAssetsMode = async (mode: "baked" | "fetch") => {
    try {
      await setChainAssetsMode(mode);
    } catch {
      // locked or unreachable — the refresh below re-syncs the display
    }
    setAssetsNonce((n) => n + 1);
  };
  const assetsNeedCommit = chainAssets?.resolution === "prompt";
  const assetsUnavailable = chainAssets?.resolution === "unavailable";
  const assetsUnknown = chainAssets?.resolution === "unknown";
  const [repoCommitDraft, setRepoCommitDraft] = useState("");
  useEffect(() => {
    if (assetsNeedCommit) setRepoCommitDraft(chainAssets?.headCommit ?? "");
  }, [assetsNeedCommit, chainAssets?.headCommit]);
  const repoCommitValid = /^[0-9a-f]{7,40}$/.test(repoCommitDraft.trim());
  const pinRepoCommit = () => {
    if (!repoCommitValid) return;
    patchSpec((doc) => {
      doc.images = { ...(doc.images ?? {}), chainRepoCommit: repoCommitDraft.trim() };
    });
  };

  const specName: string = specDoc?.network?.name ?? "";
  // a services fleet spec has no chain for the guided and form editors to
  // shape: it is edited as YAML only
  const servicesDraft = specDoc?.kind === "services";
  const viewMode: EditMode = servicesDraft ? "yaml" : mode;
  const specType: string = specDoc?.network?.type ?? "devnet";
  const specSym: string = specDoc?.token?.displayDenom ?? "";
  const specDream: string = specDoc?.token?.dreamDisplayDenom ?? "DREAM";
  const specVals: number = specDoc?.topology?.validators?.count ?? 1;
  const specSents: number = specDoc?.topology?.sentries?.count ?? 0;
  const specBidMode: BidMode = bidModeOf(specDoc);
  const specRoleSize = (role: NodeRoleName) => roleSizeOf(specDoc, role);
  const specAccounts: string[] = Array.isArray(specDoc?.accounts?.initial)
    ? specDoc.accounts.initial.map((a: any) => String(a?.name ?? "?"))
    : [];

  const setSpecName = (v: string) =>
    patchSpec((doc) => {
      doc.network = { ...(doc.network ?? {}), name: v };
      // denom suffixes follow the network name by convention — keep them in step
      const base: string | undefined = doc.token?.baseDenom;
      const m = typeof base === "string" ? base.match(/^(u[a-z]{2,5})\.(.+)$/) : null;
      if (m && v) doc.token.baseDenom = `${m[1]}.${v}`;
      const dream: string | undefined = doc.token?.dreamDenom;
      const dm = typeof dream === "string" ? dream.match(/^(u[a-z]{2,5})\.(.+)$/) : null;
      if (dm && v) doc.token.dreamDenom = `${dm[1]}.${v}`;
    });
  const setSpecType = (v: string) =>
    patchSpec((doc) => {
      doc.network = { ...(doc.network ?? {}), type: v };
    });
  const setSpecSym = (v: string) =>
    patchSpec((doc) => {
      doc.token = { ...(doc.token ?? {}), displayDenom: v };
      const base: string | undefined = doc.token.baseDenom;
      const m = typeof base === "string" ? base.match(/^u[a-z]{2,5}\.(.+)$/) : null;
      if (m && /^[A-Za-z]{2,5}$/.test(v)) doc.token.baseDenom = `u${v.toLowerCase()}.${m[1]}`;
    });
  const setSpecDream = (v: string) =>
    patchSpec((doc) => {
      doc.token = { ...(doc.token ?? {}), dreamDisplayDenom: v };
      // like setSpecSym: a renamed dream token also renames its base denom
      // (u<symbol>.<suffix>), keeping whichever suffix is already in play
      const current: string | undefined = doc.token.dreamDenom ?? doc.token.baseDenom;
      const m = typeof current === "string" ? current.match(/^u[a-z]{2,5}\.(.+)$/) : null;
      if (m && /^[A-Za-z]{2,5}$/.test(v)) doc.token.dreamDenom = `u${v.toLowerCase()}.${m[1]}`;
    });
  // who picks the bids at launch (§6.6), and how big each node role is:
  // edited in place so the YAML keeps its comments (a join draft's notes)
  const applySpecEdit = (out: string | undefined) => {
    if (out !== undefined) updateSpec(out);
  };
  const setSpecBidMode = (mode: Exclude<BidMode, "custom">) => applySpecEdit(setBidMode(specText, mode));
  const setSpecRoleSize = (role: NodeRoleName, size: NodeSize) => applySpecEdit(setRoleSize(specText, role, size));
  const setSpecCount = (kind: "validators" | "sentries", delta: number) =>
    patchSpec((doc) => {
      doc.topology = doc.topology ?? {};
      const cur = doc.topology[kind]?.count ?? (kind === "validators" ? 1 : 0);
      const min = kind === "validators" ? 1 : 0;
      const next = Math.max(min, Math.min(9, cur + delta));
      doc.topology[kind] = { ...(doc.topology[kind] ?? {}), count: next };
    });
  const addSpecAccount = () =>
    patchSpec((doc) => {
      doc.accounts = doc.accounts ?? {};
      const list: any[] = Array.isArray(doc.accounts.initial) ? doc.accounts.initial : [];
      let i = list.length;
      while (list.some((a) => a?.name === `account-${i}`)) i++;
      list.push({ name: `account-${i}`, generate: true, amount: "1000000000000" });
      doc.accounts.initial = list;
    });

  // issue paths are semantic; point them back into the textarea where we can
  const issueLine = useCallback(
    (path: string) => (path ? specPathLine(specText, path) : null),
    [specText],
  );
  const specRef = useRef<HTMLTextAreaElement>(null);
  const jumpToLine = (line: number) => {
    const ta = specRef.current;
    if (!ta) return;
    const start = specText.split("\n").slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0);
    const end = specText.indexOf("\n", start);
    ta.focus();
    ta.setSelectionRange(start, end < 0 ? specText.length : end);
  };

  // the deployment plan this spec resolves to (profile defaults applied) —
  // one row per role with count + image, joined with the cost estimate in
  // the render. Shown whenever the schema parses, even with cross-field
  // errors outstanding.
  const resolvedImages = useMemo(() => {
    const spec = specCheck.spec;
    if (!spec) return null;
    // role names match the estimator's perRole keys
    const rows: Array<{ role: string; count: number; image: string }> = [
      { role: "validators", count: spec.topology.validators.count, image: spec.images.sparkdreamd },
    ];
    if (spec.topology.sentries.count > 0) {
      rows.push({ role: "sentries", count: spec.topology.sentries.count, image: spec.images.sparkdreamd });
    }
    // a shared mesh (reuseFleet) is deployed and billed by its owning fleet
    if (!spec.topology.headscale.reuseFleet) {
      rows.push({ role: "headscale", count: 1, image: spec.images.headscale });
    }
    for (const key of COMPONENT_KEYS) {
      const image = spec.images[key];
      if (spec.topology.components[key]?.enabled && image) rows.push({ role: key, count: 1, image });
    }
    return rows;
  }, [specCheck]);

  // market-based running-cost estimate for the current spec (conductor →
  // console pricing API), debounced so we only price a settled spec
  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  useEffect(() => {
    if (!resolvedImages) {
      setCostEstimate(null);
      return;
    }
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const { postEstimate } = await import("../lib/api");
        const est = await postEstimate(yaml.load(specText));
        if (!stale) setCostEstimate(est);
      } catch {
        if (!stale) setCostEstimate(null); // estimate is best-effort
      }
    }, 700);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [specText, resolvedImages]);

  // service fee schedule (upgrade/top-up dialogs show exact amounts; the fee
  // is always in the Keplr prompt regardless)
  const [fee, setFee] = useState<FeeInfo | null>(null);
  useEffect(() => {
    import("../lib/api").then(({ getFee }) => getFee().then(setFee).catch(() => {}));
  }, []);

  const [logsView, setLogsView] = useState<{ key: string; text: string } | null>(null);
  // file in flight to a component's container (key → original filename)
  const [uploading, setUploading] = useState<Record<string, string>>({});
  // shut-down fleets (every component closed) collapse to one line; the
  // record stays for bundle export / genesis download behind this toggle
  const [showClosedFleet, setShowClosedFleet] = usePersistedState<Record<string, boolean>>(
    "launcher.panel.closedFleets",
    {},
  );
  // live sentry block heights, keyed by dseq, polled every 3s
  const [liveHeights, setLiveHeights] = useState<Record<string, import("../lib/api").NodeHeight>>({});
  const [nodeDisks, setNodeDisks] = useState<Record<string, import("../lib/api").NodeDisk>>({});
  // per-launch provider avoid/prefer lists, keyed by launchId
  const [providerPrefs, setProviderPrefs] = useState<
    Record<string, { avoid: string[]; prefer: string[]; names: Record<string, string> }>
  >({});

  const refreshProviderPrefs = useCallback(async (launchId: string) => {
    const { getProviderPrefs } = await import("../lib/api");
    const prefs = await getProviderPrefs(launchId).catch(() => null);
    if (prefs) setProviderPrefs((m) => ({ ...m, [launchId]: prefs }));
  }, []);

  const cycleProviderPref = async (
    launchId: string,
    provider: string,
    current: "avoid" | "prefer" | "none",
    name?: string,
  ) => {
    // none → avoid → prefer → none
    const next = current === "none" ? "avoid" : current === "avoid" ? "prefer" : "none";
    const { setProviderPref } = await import("../lib/api");
    const prefs = await setProviderPref(launchId, provider, next, name).catch((e) => {
      setError(String(e));
      return null;
    });
    if (prefs) setProviderPrefs((m) => ({ ...m, [launchId]: prefs }));
  };

  const providerPrefOf = (launchId: string, provider: string): "avoid" | "prefer" | "none" => {
    const p = providerPrefs[launchId];
    if (p?.avoid.includes(provider)) return "avoid";
    if (p?.prefer.includes(provider)) return "prefer";
    return "none";
  };

  const fleetAction = async (
    launchId: string,
    dseq: string,
    action:
      | "close"
      | "restart"
      | "relaunch"
      | "upgrade"
      | "topup"
      | "unjail"
      | "resume-signing"
      | "restore-archive"
      | "repair"
      | "force-redeploy"
      | "clear-halt-height"
      | "reset-data"
      | "resize"
      | "mastodon-settings"
      | "bridge-peers"
      | "remove",
    extra: {
      image?: string;
      components?: string[];
      amount?: string;
      haltHeight?: number;
      manualBid?: boolean;
      size?: "small" | "standard" | "large";
      /** already confirmed in a dialog (resize): skip the warnings round trip */
      confirm?: boolean;
      peers?: string[];
      registrations?: "open" | "approved" | "none";
      walletLogin?: { enabled: boolean; minTrustLevel?: string; domain?: string };
    } = {},
  ) => {
    setError(null);
    try {
      const first = await postFleetAction(launchId, dseq, action, extra);
      if (first.error) {
        setError(first.error);
        return;
      }
      let result = first;
      // no chain-data backup to start from: offer to take one first, since
      // it turns hours of replay into minutes (the op is asked for again after)
      if (first.backupFirst) {
        const backUp = window.confirm(
          `${action === "resize" ? "This resize" : "This move"} has no chain-data backup to start from, so the new node ` +
            "replays the whole chain from its peers (see the estimate on the next screen).\n\n" +
            "OK: take a backup first (opens chain backups…; run this again once it is done, it then starts from the backup).\n" +
            "Cancel: go on without one.",
        );
        if (backUp) {
          setChainBackupsFor(launchId);
          return;
        }
      }
      if (first.warnings?.length) {
        const ok = window.confirm(
          `${first.warnings.join("\n\n")}\n\n${first.confirmPrompt ?? "Proceed anyway?"}`,
        );
        if (!ok) return;
        // the confirmed call is the one that acts, so it carries what
        // happened — a refusal here would otherwise pass silently
        result = await postFleetAction(launchId, dseq, action, { ...extra, confirm: true });
        if (result.error) {
          setError(result.error);
          return;
        }
      }
      // signature-bearing actions flow through the launch's signing loop —
      // open that launch's panel so the prompt is visible (and survives reload)
      // a mid-launch re-placement may have to wait for the running step, so
      // surface what the conductor said instead of looking like a no-op
      if (result.note) showToast(result.note);
      if (action === "restart") {
        showToast(`restart requested (${dseq})`);
      } else if (action !== "reset-data") {
        // reset-data acts over SSH and is already done: its note says so
        openLaunch(launchId);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  /** Name the bid a parked placement should lease. An op-made placement is
   *  answered on the op, a launch-made one on the launch's component key. */
  const chooseBid = async (
    launchId: string,
    target: { opId: number } | { key: string },
    provider: string,
  ) => {
    setError(null);
    try {
      const api = await import("../lib/api");
      const { key } =
        "opId" in target
          ? await api.postChooseBid(launchId, target.opId, provider)
          : await api.postChooseLaunchBid(launchId, target.key, provider);
      showToast(`${key}: leasing the picked bid — sign the lease when prompted`);
      openLaunch(launchId);
    } catch (e) {
      setError(String(e));
    }
  };

  const showLogs = async (launchId: string, dseq: string, key: string) => {
    setError(null);
    try {
      const { getComponentLogs } = await import("../lib/api");
      setLogsView({ key, text: await getComponentLogs(launchId, dseq) });
    } catch (e) {
      setError(String(e));
    }
  };

  // drop the previous launch's state immediately on switch — a stale pending
  // tx must never be signable against the new launch id. Its own effect, so
  // that re-running the poll below (a Keplr account switch re-binds it) does
  // not blank a banner that is still current.
  useEffect(() => {
    setLaunch(null);
    setPending(null);
    setPendingGentx(null);
    setStepsExpanded(false);
  }, [launchId]);

  // poll launch status + pending tx while a launch is active
  useEffect(() => {
    if (!launchId) return;
    let stop = false;
    const tick = async () => {
      try {
        const view = await getLaunch(launchId);
        if (stop) return;
        setLaunch(view);
        // fleet close/top-up enqueue txs on completed launches too, so
        // always ask — the endpoints return 204 when nothing is pending
        setPending(await getPendingTx(launchId));
        setPendingGentx(await getPendingGentx(launchId));
      } catch (e) {
        if (stop) return;
        // The open launch is held across a Keplr account switch for the
        // signing accounts, which have no fleet list to check it against.
        // This poll is that check: a launch since deleted (404), or one this
        // session is not allowed to read (403, wallet auth on), is not a
        // choice to keep remembering.
        if (/^Error: (404|403):/.test(String(e))) return forgetLaunch();
        setError(String(e));
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [launchId, forgetLaunch]);

  const create = async () => {
    if (!wallet) return setError("connect Keplr first");
    setBusy("creating launch…");
    setError(null);
    try {
      const spec = yaml.load(specText);
      const created = await createLaunch(spec, wallet.address);
      setWarnings(created.warnings);
      openLaunch(created.id);
      await startLaunch(created.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  // step whose last sign attempt failed — unlocks the "rebuild tx" escape
  // hatch for that step only, so the everyday UI stays minimal
  const [signFailedStep, setSignFailedStep] = useState<string | null>(null);
  const signingRef = useRef(false);
  const sign = useCallback(async () => {
    if (!wallet || !launchId || !pending || signingRef.current) return;
    signingRef.current = true;
    setBusy(`signing ${pending.step} in Keplr…`);
    setError(null);
    try {
      const client = await SigningStargateClient.connectWithSigner(chain.rpc, wallet.signer, {
        registry: launcherRegistry(),
        gasPrice: GasPrice.fromString(`${chain.gasPrice}${chain.denom}`),
      });
      const result = await client.signAndBroadcast(
        wallet.address,
        pending.msgs.map(toEncodeObject),
        "auto",
      );
      if (result.code !== 0) {
        throw new Error(`tx rejected on-chain (code ${result.code}): ${result.rawLog ?? ""}`);
      }
      await postTxResult(launchId, result.transactionHash);
      setPending(null);
      setSignFailedStep(null);
    } catch (e) {
      setSignFailedStep(pending.step);
      setError(String(e));
    } finally {
      signingRef.current = false;
      setBusy(null);
    }
  }, [wallet, launchId, pending, chain]);

  // the signing queue serves oldest-first, so an unwanted head blocks every
  // later fleet action — dismissing it is the only way out short of signing
  const dismissPendingTx = useCallback(async () => {
    if (!launchId || !pending) return;
    const ok = window.confirm(
      pending.kind === "fleet-action"
        ? `Cancel ${pending.origin}? Nothing is signed or broadcast, so the action simply does not happen.`
        : `Clear the signature request from ${pending.origin}? Nothing is broadcast, but the step re-creates this transaction the next time the launch resumes, so abort the operation itself to stop it for good.`,
    );
    if (!ok) return;
    setError(null);
    try {
      const { discardPendingTx } = await import("../lib/api");
      await discardPendingTx(launchId, pending.step);
      setPending(null);
      setSignFailedStep(null);
    } catch (e) {
      setError(String(e));
    }
  }, [launchId, pending]);

  const signingGentxRef = useRef(false);
  const signGentxNow = useCallback(async () => {
    if (!launchId || !launch || !pendingGentx || signingGentxRef.current) return;
    signingGentxRef.current = true;
    setBusy(`signing gentx for validator ${pendingGentx.valIndex} in Keplr…`);
    setError(null);
    try {
      // signs against the NEW chain (suggested to Keplr on the fly), offline,
      // amino mode — works with Ledger-backed accounts
      const response = await signGentx(launch.spec, pendingGentx.address, pendingGentx.signDoc);
      await postGentxResult(launchId, pendingGentx.valIndex, response);
      setPendingGentx(null);
    } catch (e) {
      setError(String(e));
    } finally {
      signingGentxRef.current = false;
      setBusy(null);
    }
  }, [launchId, launch, pendingGentx]);

  // offline signing (airgapped operator keys): pasted `tx sign --offline`
  // output goes to the same endpoint; the conductor converts and verifies
  const [offlineGentxText, setOfflineGentxText] = useState("");
  const submitOfflineGentx = useCallback(async () => {
    if (!launchId || !pendingGentx || !offlineGentxText.trim()) return;
    setBusy(`verifying offline signature for validator ${pendingGentx.valIndex}…`);
    setError(null);
    try {
      const parsed = JSON.parse(offlineGentxText);
      await postSignedGentxTx(launchId, pendingGentx.valIndex, parsed);
      setOfflineGentxText("");
      setPendingGentx(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [launchId, pendingGentx, offlineGentxText]);

  // banner honesty: step messages persist across conductor restarts, so a
  // banner may describe a PREVIOUS attempt — show how old the report is
  const reportedAgo = (s: { started_at: string | null; finished_at: string | null }) => {
    const t = s.finished_at ?? s.started_at;
    if (!t) return null;
    const secs = Math.max(0, Math.floor((Date.now() - Date.parse(t)) / 1000));
    if (secs < 90) return `${secs}s ago`;
    if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
    return `${Math.round(secs / 3600)}h ago`;
  };

  const waitingStep = useMemo(
    () =>
      launch?.steps.find(
        (s) =>
          s.status === "waiting" &&
          s.error !== "awaiting signature" &&
          !s.error?.startsWith("awaiting gentx"),
      ),
    [launch],
  );
  const failedStep = useMemo(() => launch?.steps.find((s) => s.status === "error"), [launch]);

  const isTmkms = (launch?.spec as any)?.security?.keyMode === "tmkms";

  // the launch's await-signer step and any op's *:await-signer gate both
  // mean "the signer needs you" — the setup panel opens on its own (§5 step 19)
  // A node resize's start-node only waits on a tmkms validator's signer.
  const awaitingSigner = (name?: string) =>
    name === "await-signer" || name?.endsWith(":await-signer") || (isTmkms && name?.endsWith(":start-node"));
  useEffect(() => {
    if (awaitingSigner(waitingStep?.name) && launchId) void showTmkms(launchId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingStep?.name, launchId]);

  // live status while the panel is open: mesh join + per-validator connection
  useEffect(() => {
    if (!tmkms || !tmkmsId) return;
    let stop = false;
    const tick = () =>
      import("../lib/api").then(({ getTmkmsStatus }) =>
        getTmkmsStatus(tmkmsId)
          .then((s) => {
            if (stop) return;
            setTmkmsStatus(s);
            // diff the slashing counters against the previous sample: "no new
            // blocks while connected" is the live stall signal; a backward
            // jump (state re-sync) hides the row rather than lying
            const prev = tmkmsPrevCounters.current;
            const deltas: Record<string, { seen: number; missed: number } | null> = {};
            for (const v of s.validators) {
              if (v.indexOffset === null || v.missedBlocks === null) continue;
              const p = prev[v.key];
              if (p) {
                const seen = v.indexOffset - p.offset;
                deltas[v.key] =
                  seen >= 0 ? { seen, missed: Math.max(0, v.missedBlocks - p.missed) } : null;
              }
              prev[v.key] = { missed: v.missedBlocks, offset: v.indexOffset };
            }
            setTmkmsSignDeltas(deltas);
          })
          .catch(() => {}),
      );
    const tickLocal = () =>
      import("../lib/api").then(({ getLocalSigner }) =>
        getLocalSigner(tmkmsId)
          .then((v) => {
            if (!stop) setLocalSigner(v);
          })
          .catch(() => {}),
      );
    void tickLocal();
    const tl = setInterval(tickLocal, 10_000);
    void tick();
    const t = setInterval(tick, 10_000);
    return () => {
      stop = true;
      clearInterval(t);
      clearInterval(tl);
    };
  }, [tmkms, tmkmsId]);

  const runLocalSigner = async (launchId: string, action: "adopt" | "release", key: string, remote?: string) => {
    const sure =
      remote
        ? window.confirm(
            `Let the launcher manage the tmkms signer for ${key} on ${remote}?\n\n` +
              `It reaches ${remote} over SSH (your ssh_config entry and key) and finds the tmkms signing for this ` +
              "chain. If it already runs as a systemd service, that service is used as it is (nothing is stopped); " +
              "otherwise it is moved under one. From then on the launcher repoints and restarts it after relaunches, " +
              "resizes, mesh re-keys and chain resets, and restarts it when it loses its session. The state file and " +
              "the signing key are never touched.",
          )
        : action === "adopt"
        ? window.confirm(
            `Let the launcher manage the tmkms signer for ${key} on this machine?\n\n` +
              "It stops the tmkms process you started and runs the same binary and config as a " +
              "systemd user unit (a few seconds without signing). From then on it repoints and " +
              "restarts the signer itself after relaunches, resizes, mesh re-keys and chain resets, " +
              "and restarts it when it loses its session. The state file is never edited.",
          )
        : window.confirm(
            `Stop managing the signer for ${key}? Its systemd unit keeps running; signer pauses ` +
              "will ask you to repoint and restart it by hand again.",
          );
    if (!sure) return;
    setLocalSignerBusy(key);
    setError(null);
    try {
      const { localSignerAction, getLocalSigner, getFleet } = await import("../lib/api");
      await localSignerAction(launchId, action, key, remote);
      if (tmkmsId === launchId) setLocalSigner(await getLocalSigner(launchId));
      if (wallet) setFleet(await getFleet(wallet.address));
    } catch (e) {
      setError(String(e));
    } finally {
      setLocalSignerBusy(null);
    }
  };

  // ---- derived view state for the mission-control layout ----
  // Nothing is known to be open until the account's fleet says which launch
  // is: render a quiet loading header for that wait — a reconnect on reload,
  // the fleet's first sweep, the selected launch's first poll — instead of
  // flashing the idle wizard through every one of them.
  const loadingLaunch =
    reconnecting || (wallet !== null && fleet === null) || (launchId !== null && launch === null);
  const launching =
    launch !== null && ["created", "running", "paused"].includes(launch.status);
  const launched = launch?.status === "completed";
  const idle = !launching && !launched && !loadingLaunch;
  const doneSteps = launch?.steps.filter((s) => s.status === "done").length ?? 0;
  const totalSteps = launch?.steps.length ?? 0;
  // Progress is WHERE the run is, not how many steps are done. The two agree
  // on a launch that only moves forward, but a re-opened one (a component
  // re-placed after the launch finished) has a long done tail — every later
  // step plus every past op's — behind the step actually running. Counting
  // those read "92% · step 97 of 104" while the work sat at await-mesh, a
  // third of the way down. The engine walks the list in order, so the first
  // step that is not done IS the position.
  const openIdx = launch?.steps.findIndex((s) => s.status !== "done") ?? -1;
  const stepPos = openIdx < 0 ? totalSteps : openIdx + 1;
  const launchPct =
    totalSteps > 0 ? Math.round(((openIdx < 0 ? totalSteps : openIdx) / totalSteps) * 100) : 0;
  const launchSpec = launch?.spec as any;
  const launchName: string = launchSpec?.network?.name ?? specName ?? "chain";

  // a running launch that has active fleet ops is a day-2 operation on a live
  // chain (relaunch, upgrade, domain update, …), not the first launch — the
  // progress header should say so
  const activeOpKinds = (fleet?.fleets ?? [])
    .filter((f) => f.launchId === launchId)
    .flatMap((f) => f.ops.filter((o) => o.status === "active").map((o) => o.kind));

  // the step list accumulates every past op's steps, so what matters is not a
  // leading run: a step that failed early keeps its place while later ops append
  // hundreds of finished ones behind it, and collapsing only the run in front of
  // it left the whole rest of the log on screen with no way to fold it. Hide the
  // done steps instead, wherever they sit: every step that is not done stays (the
  // failure, the running one, the work still ahead), as does the tail, and each
  // stretch of done steps folds into one summary row that opens the full log.
  const [stepsExpanded, setStepsExpanded] = useState(false);
  // completed launch: clicking the "is live" header shows/hides the step log
  // (remembered per launch)
  const [logOpenMap, setLogOpenMap] = usePersistedState<Record<string, boolean>>(
    "launcher.panel.launchLog",
    {},
  );
  const logOpen = launchId !== null && (logOpenMap[launchId] ?? false);
  const toggleLog = () => {
    if (launchId) setLogOpenMap((m) => ({ ...m, [launchId]: !logOpen }));
  };
  const allSteps = launch?.steps ?? [];
  const STEP_TAIL = 2;
  const keepStep = (s: LaunchView["steps"][number], i: number) =>
    i >= allSteps.length - STEP_TAIL || s.status !== "done";
  type StepGroup =
    | { kind: "step"; step: LaunchView["steps"][number] }
    | { kind: "gap"; steps: LaunchView["steps"][number][] };
  const stepGroups: StepGroup[] = [];
  allSteps.forEach((s, i) => {
    if (keepStep(s, i)) {
      stepGroups.push({ kind: "step", step: s });
      return;
    }
    const last = stepGroups[stepGroups.length - 1];
    if (last?.kind === "gap") last.steps.push(s);
    else stepGroups.push({ kind: "gap", steps: [s] });
  });
  // every stretch folds, however short: the collapsed pane keeps one height
  const stepPlan: StepGroup[] = stepGroups;
  const hiddenSteps = stepPlan.reduce((n, g) => (g.kind === "gap" ? n + g.steps.length : n), 0);
  const stepCount = (n: number) => `${n} completed step${n === 1 ? "" : "s"}`;

  // headline fleet for the status pill: the open launch's fleet, else the
  // most recent fleet that still has live components
  const aliveFleets = (fleet?.fleets ?? []).filter((f) =>
    f.components.some((c) => c.state !== "closed"),
  );
  const headlineFleet =
    aliveFleets.find((f) => f.launchId === launchId) ?? aliveFleets[aliveFleets.length - 1];
  const headlineHeight = headlineFleet
    ? Math.max(
        0,
        ...headlineFleet.components.map((c) => liveHeights[c.dseq]?.height ?? 0),
      )
    : 0;

  // the idle wizard can be dismissed when there is a completed launch to
  // return to (e.g. after clicking "new launch", or when the launcher opened
  // on the editor with a chain already running)
  const completedFleets = (fleet?.fleets ?? []).filter((f) => f.launchStatus === "completed");
  const cancelTargetId = completedFleets
    .map((f) => f.launchId)
    .filter((id) => id !== launchId)
    .pop();

  const fleetMonthlyUsd = (comps: ComponentView[]) => {
    let total = 0;
    for (const c of comps) {
      if (c.state !== "active") continue;
      if (c.priceDenom.replace(/^u/, "").toUpperCase() !== "ACT") return null;
      const m = monthlyNum(c.price);
      if (m === null) return null;
      total += m;
    }
    return total;
  };

  const copyAddress = (address: string, name: string) => {
    try {
      navigator.clipboard.writeText(address);
    } catch {
      // clipboard unavailable (http origin) — the toast still confirms intent
    }
    showToast(`address copied (${name})`);
  };

  const costRange = costEstimate
    ? `$${(costEstimate.totalLowUsd + costEstimate.feeLowUsd).toFixed(2)}–${(
        costEstimate.totalHighUsd + costEstimate.feeHighUsd
      ).toFixed(2)}`
    : null;
  const monthlyRange = costEstimate
    ? `$${costEstimate.totalLowUsd.toFixed(2)}–${costEstimate.totalHighUsd.toFixed(2)}`
    : null;

  const launchDisabled =
    !wallet ||
    busy !== null ||
    !specCheck.ok ||
    depositShortfall > 0 ||
    assetsNeedCommit ||
    assetsUnavailable ||
    assetsUnknown;
  const launchDisabledWhy = !wallet
    ? "connect Keplr first"
    : !specCheck.ok
      ? "fix the spec errors first"
      : assetsNeedCommit
        ? "pin the chain-repo commit for this chain version first"
        : assetsUnavailable || assetsUnknown
          ? "this launcher cannot serve the spec's chain version (see the chain-assets note)"
          : depositShortfall > 0
            ? `the wallet is short ${microToDisplay(String(depositShortfall))} ${denomLabel} for deposits`
            : undefined;

  const wizardGo = (i: number) => {
    if (i <= wizMax) setWizStep(i);
  };
  const wizardNext = () => {
    const n = Math.min(2, wizStep + 1);
    setWizStep(n);
    setWizMax((m) => Math.max(m, n));
  };

  // ---- shared render pieces ----

  const specIssueList = (compact = false) =>
    specCheck.errors.length > 0 || specCheck.warnings.length > 0 ? (
      <ul className="issues">
        {specCheck.errors.map((iss, i) => {
          const line = issueLine(iss.path);
          return (
            <li
              key={`e-${iss.path}-${i}`}
              className={line && !compact ? "err jump" : "err"}
              onClick={line && !compact ? () => jumpToLine(line) : undefined}
              title={line && !compact ? "click to jump to the line" : undefined}
            >
              ✕ {line ? `line ${line}, ` : ""}
              {iss.path ? `${iss.path}: ` : ""}
              {iss.message}
            </li>
          );
        })}
        {specCheck.warnings.map((iss, i) => {
          const line = issueLine(iss.path);
          return (
            <li
              key={`w-${iss.path}-${i}`}
              className={line && !compact ? "warn jump" : "warn"}
              onClick={line && !compact ? () => jumpToLine(line) : undefined}
              title={line && !compact ? "click to jump to the line" : undefined}
            >
              ⚠ {line ? `line ${line}, ` : ""}
              {iss.path ? `${iss.path}: ` : ""}
              {iss.message}
            </li>
          );
        })}
      </ul>
    ) : null;

  // §13: chain-asset banners — the plain Offline/Online toggle lives in the
  // settings cog menu; these are the spec-scoped states: the commit prompt
  // when nothing else resolves, escalation for unknown versions, remediation
  // for known ones, a quiet confirmation otherwise
  const assetsBanner = () => {
    if (assetsUnknown) {
      const known = chainAssets?.knownVersions ?? [];
      return (
        <div className="ready-banner warn">
          <span className="grow">
            {specImage} is unknown to this launcher: a typo, or a release newer than this
            build. Known versions: {known.slice(0, 5).join(", ")}
            {known.length > 5 ? ", …" : ""}. Fix the version, seed the cache (pnpm
            seed-chain-assets {specImage}){chainAssets?.locked ? "" : ", or go online"}.
          </span>
          {!chainAssets?.locked && (
            <button
              className="btn amber"
              style={{ flex: "none" }}
              onClick={() => toggleAssetsMode("fetch")}
            >
              Switch to Online
            </button>
          )}
        </div>
      );
    }
    if (assetsUnavailable)
      return (
        <div className="ready-banner warn">
          <span className="grow">
            {specImage} is a known release, but this launcher is in Offline mode with no
            local assets for it (baked: {chainAssets?.bakedVersion}). Seed the cache (pnpm
            seed-chain-assets {specImage}), rebuild for that version
            {chainAssets?.locked ? "." : ", or go online."}
          </span>
          {!chainAssets?.locked && (
            <button
              className="btn amber"
              style={{ flex: "none" }}
              onClick={() => toggleAssetsMode("fetch")}
            >
              Switch to Online
            </button>
          )}
        </div>
      );
    if (assetsNeedCommit)
      return (
        <div className="ready-banner warn">
          <span className="grow">
            No chain release or repo tag matches {specImage}. Pin the commit to pair its
            deploy data with{chainAssets?.headCommit ? " (repo HEAD proposed)" : ""}:
          </span>
          <input
            className="field"
            style={{ flex: "1 1 300px", fontFamily: "var(--mono, monospace)" }}
            value={repoCommitDraft}
            onChange={(e) => setRepoCommitDraft(e.target.value)}
            placeholder="chain-repo commit hash"
          />
          <button
            className="btn amber"
            style={{ flex: "none" }}
            onClick={pinRepoCommit}
            disabled={!repoCommitValid}
          >
            Pin commit
          </button>
        </div>
      );
    if (
      chainAssets &&
      (chainAssets.resolution === "release" ||
        chainAssets.resolution === "tag" ||
        chainAssets.resolution === "pin" ||
        chainAssets.resolution === "cache")
    )
      return (
        <div className="ready-banner ok">
          <span className="grow">
            ✓ Chain assets{" "}
            {chainAssets.resolution === "cache"
              ? "are cached locally"
              : `will be fetched (deploy data via ${
                  chainAssets.resolution === "release"
                    ? "the release manifest"
                    : chainAssets.resolution === "tag"
                      ? "matching tag"
                      : "pinned commit"
                }${chainAssets.commit ? ` @ ${chainAssets.commit.slice(0, 12)}` : ""})`}
            .
          </span>
        </div>
      );
    return null;
  };

  const costBreakdownRows = (short: boolean) => {
    if (!resolvedImages) return null;
    const rows = resolvedImages.map((r) => {
      const cost = costEstimate?.perRole.find((c) => c.role === r.role);
      const v = cost
        ? `${cost.count > 1 ? `${cost.count} × ` : ""}$${cost.unitLowUsd.toFixed(2)}–${cost.unitHighUsd.toFixed(2)}`
        : "—";
      return { k: r.role + (r.count > 1 ? ` ×${r.count}` : ""), d: r.image, v };
    });
    rows.push({
      k: "deposits",
      d: `${depositActStr} refundable when you shut down`,
      v: "—",
    });
    if (costEstimate && costEstimate.feeBps > 0) {
      rows.push({
        k: "launch fee",
        d: `one-time, ${costEstimate.feeBps / 100}% of the leased monthly rate, paid in AKT`,
        v: `$${costEstimate.feeLowUsd.toFixed(2)}–${costEstimate.feeHighUsd.toFixed(2)}`,
      });
    }
    return (
      <div style={{ marginTop: short ? 10 : 14 }}>
        {rows.map((r) =>
          short ? (
            <div key={r.k} className="rail-row" title={r.d}>
              <span className="k">{r.k}</span>
              <span className="v">{r.v}</span>
            </div>
          ) : (
            <div key={r.k} className="cost-row">
              <div className="k">{r.k}</div>
              <div className="d">{r.d}</div>
              <div className="v">{r.v}</div>
            </div>
          ),
        )}
        {costRange && !short && (
          <div className="cost-total">
            <div>total, first month</div>
            <div className="v">{costRange}</div>
          </div>
        )}
      </div>
    );
  };

  const mintBlock = (compact: boolean) => (
    <>
      {ledger?.last_status === "canceled" && (
        <div className="banner fail" style={{ marginTop: 12 }}>
          Your last mint was canceled at settlement
          {ledger.last_cancel_reason
            ? `: ${BME_CANCEL_REASONS[ledger.last_cancel_reason] ?? ledger.last_cancel_reason}`
            : ""}
          . The burned AKT is refunded to your wallet.
        </div>
      )}
      <div className={compact ? "mint-row" : "sub-card mint-row"} style={{ marginTop: 14 }}>
        <div className="grow">
          <div className="title">Mint ACT from AKT</div>
          <div className="sub">
            Arrives after the next settlement epoch.
            {bme?.min_mint_uact && ` Minimum ${microToDisplay(bme.min_mint_uact)} ACT.`}
            {estimatedMintUact !== null && (
              <span className={belowMinMint ? " " : undefined}>
                {" "}
                ≈ {microToDisplay(String(estimatedMintUact))} ACT out
                {belowMinMint && " (below the minimum, the chain would cancel it)"}
              </span>
            )}
          </div>
        </div>
        <input
          className="mint-amt"
          value={mintAmount}
          onChange={(e) => setMintAmount(e.target.value)}
          placeholder="AKT"
          inputMode="decimal"
        />
        <button
          className="btn primary small"
          onClick={mint}
          disabled={busy !== null || !mintAmount || belowMinMint || !bme?.mints_allowed}
          title="Minting burns AKT and settles asynchronously via the BME ledger"
        >
          Mint ACT
        </button>
      </div>
      {bme && !bme.mints_allowed && (
        <div className="banner fail">
          The BME circuit breaker has halted ACT mints on this network. Try again later.
        </div>
      )}
      {ledger && ledger.pending > 0 && (
        <div className="mint-note pending">
          ⟳ {ledger.pending} mint{ledger.pending > 1 ? "s" : ""} settling, the ACT arrives after
          the next settlement epoch…
        </div>
      )}
      {aktPrice === null && wallet && (
        <div className="dim-note" style={{ marginTop: 8 }}>
          Price feed unreachable: no output estimate; below-minimum mints are canceled by the
          chain.
        </div>
      )}
    </>
  );

  const readyRailCard = (
    <div className={`ready-card ${walletReady ? "ok" : "warn"}`}>
      <div className="head">
        <span className={`t ${walletReady ? "ok" : "warn"}`}>
          {walletReady ? "✓ Wallet ready" : wallet ? `Needs more ${denomLabel}` : "No wallet"}
        </span>
        <span className="have">
          {balances ? microToDisplay(balanceOf(chain.denom) ?? "0") : "—"} / {depositActStr}
        </span>
      </div>
      <div className="meter">
        <i className={walletReady ? "ok" : "warn"} style={{ width: `${actPct}%` }} />
      </div>
      {!wallet && (
        <button className="btn wide" onClick={() => connect()}>
          Connect Keplr
        </button>
      )}
      {wallet && !walletReady && (
        <button
          className="btn amber wide"
          onClick={() => {
            switchMode("guided");
            setWizStep(0);
          }}
        >
          Mint ACT from AKT
        </button>
      )}
    </div>
  );

  const editorRail = (
    <div className="rail">
      <div className="rail-card">
        <div className="head">
          <span className="stat-k">EST. FIRST MONTH</span>
          <button className="btn link" style={{ fontSize: 11.5 }} onClick={() => setCostOpen((v) => !v)}>
            {costOpen ? "hide ▴" : "breakdown ▾"}
          </button>
        </div>
        <div className="big">{costRange ?? "—"}</div>
        <div className="sub">
          then {monthlyRange ?? "—"}/mo · +{depositActStr} deposit, refundable
        </div>
        {costOpen && costBreakdownRows(true)}
      </div>
      {readyRailCard}
      <button
        className="btn primary wide"
        onClick={create}
        disabled={launchDisabled}
        title={launchDisabledWhy}
      >
        Launch {specName || "chain"} →
      </button>
    </div>
  );

  const typeSeg = (
    <div className="seg fill">
      {["devnet", "testnet", "mainnet"].map((t) => (
        <button key={t} className={specType === t ? "on" : ""} onClick={() => setSpecType(t)}>
          {t}
        </button>
      ))}
    </div>
  );

  const bidSeg = (
    <div className="seg fill">
      {(
        [
          ["auto", "automatic", "The selection policy leases the bid it picks for every deployment."],
          ["nodes", "pick node bids", "The validators and sentries pause with their bids listed for you to choose; the mesh and service components place themselves."],
          ["every", "pick every bid", "Every deployment pauses with its bids listed for you to choose."],
        ] as const
      ).map(([mode, label, title]) => (
        <button
          key={mode}
          className={specBidMode === mode ? "on" : ""}
          title={title}
          onClick={() => setSpecBidMode(mode)}
        >
          {label}
        </button>
      ))}
    </div>
  );

  // one tier for every node of a role (infra.roleSizes); "custom" lights no
  // button, since hand-edited resources match none of them
  const sizeSeg = (role: NodeRoleName) => (
    <div className="seg fill">
      {(["small", "standard", "large"] as const).map((size) => {
        const r = NODE_SIZES[size][role];
        return (
          <button
            key={size}
            className={specRoleSize(role) === size ? "on" : ""}
            title={`${r.cpu} CPU, ${r.memory} RAM, ${r.storage.data} chain data`}
            onClick={() => setSpecRoleSize(role, size)}
          >
            {size}
          </button>
        );
      })}
    </div>
  );

  const bidNote = (mode: BidMode) =>
    mode === "every"
      ? "Every deployment will pause with its bids listed for you to choose from, starting with the VPN mesh and then the whole node batch at once. The launch waits at each pause until you pick."
      : mode === "nodes"
        ? "The validators and sentries will pause with their bids listed for you to choose from; the mesh and service components place themselves. The launch waits until you pick."
        : mode === "custom"
          ? "The spec picks bids per component in a way these buttons do not describe (providers.components in the YAML)."
          : null;

  // the node sizes and bid choice, in the views that have no form fields
  // for them (the YAML editor, which a join draft opens in)
  const launchSettings = (
    <div className="sub-card" style={{ marginTop: 12 }}>
      <div className="two-col narrow">
        <div>
          <div className="f-label">Validator size</div>
          {sizeSeg("validator")}
        </div>
        <div>
          <div className="f-label">Sentry size</div>
          {sizeSeg("sentry")}
        </div>
        <div>
          <div className="f-label">
            Provider selection <span className="hint">· who picks the bids</span>
          </div>
          {bidSeg}
        </div>
      </div>
      {bidNote(specBidMode) && (
        <div className="dim-note" style={{ marginTop: 10 }}>
          {bidNote(specBidMode)}
        </div>
      )}
    </div>
  );

  const counter = (value: number, kind: "validators" | "sentries") => (
    <div className="counter">
      <button onClick={() => setSpecCount(kind, -1)}>−</button>
      <div className="n">{value}</div>
      <button onClick={() => setSpecCount(kind, +1)}>+</button>
    </div>
  );

  const specTextarea = (height: number) => (
    <textarea
      ref={specRef}
      className={`spec${specCheck.errors.length > 0 ? " invalid" : ""}`}
      value={specText}
      onChange={(e) => updateSpec(e.target.value)}
      style={{ height }}
      spellCheck={false}
    />
  );

  // Live position of this launch's long ops, by op id. The step list is where
  // an operator actually watches a restore (a replay runs for hours inside one
  // step row), so the bar belongs here and not only on the fleet panel's chip.
  const opProgress = new Map<number, OpProgress>(
    (fleet?.fleets ?? [])
      .filter((f) => f.launchId === launchId)
      .flatMap((f) =>
        f.ops.flatMap((o) => (o.progress ? [[o.id, o.progress] as [number, OpProgress]] : [])),
      ),
  );

  // step rows for the launching view, mapped from the conductor's real steps
  const stepRow = (s: LaunchView["steps"][number]) => {
    // op steps are named op<id>:<step>; only the running one has a position
    const opId = Number(/^op(\d+):/.exec(s.name)?.[1]);
    const progress = s.status === "running" ? opProgress.get(opId) : undefined;
    const cls =
      s.status === "done"
        ? "done"
        : s.status === "running"
          ? "active"
          : s.status === "error"
            ? "err"
            : s.status === "waiting"
              ? "waiting"
              : "";
    return (
      <div key={s.name} className={`launch-row ${cls}`}>
        {s.status === "running" ? (
          <span className="spin" />
        ) : (
          <span className="mark">
            {s.status === "done" ? "✓" : s.status === "error" ? "✕" : s.status === "waiting" ? "!" : "·"}
          </span>
        )}
        <span className="lbl">{s.name}</span>
        {progress && (
          <span className="step-progress" title={progressTitle(progress)}>
            {/* no target (archives that do not name their range): the caption
                carries the height and the bar is left out rather than faked */}
            {progress.percent !== undefined && (
              <span className="op-bar step-bar">
                <span className="op-bar-fill" style={{ width: `${progress.percent}%` }} />
              </span>
            )}
            <span className="mono">{progressText(progress)}</span>
          </span>
        )}
        <span className="op">{s.status}</span>
      </div>
    );
  };

  // action banners: signature prompts, gentx, waiting-on-you, failures —
  // they follow the launch card whatever state the card itself is in
  const launchBanners = launch && (
    <>
      {pending && (
        <div className="banner sign">
          <span>
            Signature needed for <b>{pending.step}</b>{" "}
            {/* name the messages, not just a count: a user mid-task once
                signed another op's MsgCloseDeployment believing it was part
                of their own flow */}
            ({[...new Set(pending.msgs.map((m) => m.typeUrl.split(".").pop() ?? m.typeUrl))].join(", ")}
            {pending.msgs.length > 1 ? ` × ${pending.msgs.length}` : ""})
            {/* a request read minutes after the click needs to say what it
                came from, or the only safe move looks like signing it */}
            {pending.origin && <span className="dim-note"> · {pending.origin}</span>}
          </span>
          <button onClick={sign} className="btn primary small" disabled={busy !== null}>
            Sign with Keplr
          </button>
          <button
            className="btn"
            title={
              pending.kind === "fleet-action"
                ? "Cancel this request without signing. Nothing is broadcast and the action does not happen."
                : "Clear this request without signing. The step re-creates it the next time the launch resumes."
            }
            onClick={() => dismissPendingTx()}
            disabled={busy !== null}
          >
            {pending.kind === "fleet-action" ? "cancel request" : "dismiss"}
          </button>
          {signFailedStep === pending.step && (
            <button
              className="btn"
              title="Re-run the step to regenerate this transaction (use after a conductor fix or if signing keeps failing)"
              onClick={() => {
                setSignFailedStep(null);
                if (launchId) resumeLaunch(launchId).catch((e) => setError(String(e)));
              }}
              disabled={busy !== null}
            >
              rebuild tx
            </button>
          )}
        </div>
      )}
      {pendingGentx &&
        (() => {
          const msgType = (pendingGentx.signDoc as { msgs?: Array<{ type?: string }> })?.msgs?.[0]?.type;
          const isUnjail = msgType === "cosmos-sdk/MsgUnjail";
          return (
            <div className="banner sign">
              <span>
                {isUnjail ? (
                  <>
                    Unjail signature needed for <b>validator {pendingGentx.valIndex}</b>, operator{" "}
                    <code>{pendingGentx.address}</code> (live tx on the chain; select the matching
                    account in Keplr)
                  </>
                ) : (
                  <>
                    Gentx signature needed for <b>validator {pendingGentx.valIndex}</b>, operator{" "}
                    <code>{pendingGentx.address}</code> (offline, on the new chain; select the
                    matching account in Keplr)
                  </>
                )}
              </span>
              <button onClick={signGentxNow} className="btn primary small" disabled={busy !== null}>
                {isUnjail ? "Sign unjail with Keplr" : "Sign gentx with Keplr"}
              </button>
              {pendingGentx.unsignedTx !== undefined && (
                <details style={{ width: "100%", marginTop: 8 }}>
                  <summary style={{ cursor: "pointer" }}>
                    Sign offline instead (operator key on another machine)
                  </summary>
                  <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                    <span>
                      1. Save this unsigned tx as <code>unsigned-tx.json</code> on the signing
                      machine:{" "}
                      <button
                        className="btn small"
                        onClick={() =>
                          navigator.clipboard.writeText(
                            JSON.stringify(pendingGentx.unsignedTx, null, 2),
                          )
                        }
                      >
                        copy unsigned tx
                      </button>
                    </span>
                    <span>2. Sign it there with the operator key:</span>
                    <pre style={{ overflowX: "auto", margin: 0 }}>
                      <code>{pendingGentx.signCommand}</code>
                    </pre>
                    <span>
                      3. Paste the contents of <code>signed-tx.json</code>:
                    </span>
                    <textarea
                      rows={5}
                      value={offlineGentxText}
                      onChange={(e) => setOfflineGentxText(e.target.value)}
                      placeholder='{"body": ..., "auth_info": ..., "signatures": [...]}'
                      style={{ fontFamily: "monospace", width: "100%" }}
                    />
                    <button
                      className="btn primary small"
                      onClick={submitOfflineGentx}
                      disabled={busy !== null || !offlineGentxText.trim()}
                      style={{ justifySelf: "start" }}
                    >
                      Submit offline signature
                    </button>
                  </div>
                </details>
              )}
            </div>
          );
        })()}
      {launch.status === "aborted" && (
        <div className="banner wait">
          This launch was aborted: its deployments are closed (deposits refunded). Adjust the
          spec and launch again.
        </div>
      )}
      {!pending && !pendingGentx && waitingStep && launch.status !== "aborted" && (
        <div className="banner wait">
          <span>
            <b>{waitingStep.name}</b> is waiting on you
            {reportedAgo(waitingStep) && (
              <span className="dim-note"> (reported {reportedAgo(waitingStep)})</span>
            )}
            :
          </span>
          <pre>{waitingStep.error}</pre>
          {waitingStep.funding && waitingStep.funding.length > 0 && (
            // relayer keys to fund: copy each address, or send from Keplr here
            <FundingRows
              rows={waitingStep.funding}
              toast={showToast}
              onError={(m) => setError(m)}
              liveFrom={launchId ?? undefined}
            />
          )}
          {waitingStep.peerSetup && <PeerSetupRoutes setup={waitingStep.peerSetup} toast={showToast} />}
          {waitingStep.wallet && (
            // a transaction the launcher holds no key for: the user's wallet signs it here
            <div style={{ display: "grid", gap: 8 }}>
              <div>
                <b>{waitingStep.wallet.title}</b>
                <div className="dim-note">
                  Sign as {waitingStep.wallet.signerRole}
                  {waitingStep.wallet.signer && (
                    <>
                      {" "}(<span className="mono">{waitingStep.wallet.signer}</span>)
                    </>
                  )}{" "}
                  on {waitingStep.wallet.chain.chainName} (
                  {waitingStep.wallet.chain.chainId}). Your wallet shows the transaction before
                  anything is sent.
                </div>
                <ul style={{ margin: "4px 0 0 18px" }}>
                  {waitingStep.wallet.msgs.map((m, i) => (
                    <li key={i} className="mono">
                      {String(m["@type"]).split(".").pop()}
                    </li>
                  ))}
                </ul>
              </div>
              <button
                className="btn primary"
                style={{ justifySelf: "start" }}
                disabled={busy !== null}
                onClick={async () => {
                  const w = waitingStep.wallet;
                  if (!launchId || !w) return;
                  setBusy(`signing in your wallet: ${w.title}…`);
                  setError(null);
                  try {
                    const { signWalletRequest } = await import("../lib/fleet-wallet");
                    const { address, txHash } = await signWalletRequest(w);
                    showToast(`signed by ${address.slice(0, 14)}…, tx ${txHash.slice(0, 10)}…; resuming`);
                    await resumeLaunch(launchId);
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {waitingStep.peerSetup ? "Sign the next step with Keplr" : "Sign with Keplr"}
              </button>
              {waitingStep.wallet.cli && !waitingStep.peerSetup && (
                <details>
                  <summary className="dim-note">Key not in a browser wallet? Show the CLI commands</summary>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{waitingStep.wallet.cli}</pre>
                </details>
              )}
            </div>
          )}
          <div className="banner-acts">
            {awaitingSigner(waitingStep.name) && (
              <button className="btn" onClick={() => launchId && showTmkms(launchId)}>
                Show tmkms signer setup
              </button>
            )}
            <button
              className={waitingStep.funding?.length ? "btn primary" : "btn"}
              onClick={() => launchId && resumeLaunch(launchId).catch((e) => setError(String(e)))}
            >
              {waitingStep.peerSetup
                ? "Done elsewhere? Resume now"
                : waitingStep.wallet
                ? "Signed another way, resume"
                : waitingStep.funding?.length
                  ? "Funded, resume"
                  : "I did it, resume"}
            </button>
          </div>
        </div>
      )}
      {failedStep && launch.status !== "aborted" && (
        <div className="banner fail">
          <span>
            <b>{failedStep.name}</b> failed
            {reportedAgo(failedStep) && (
              <span className="dim-note"> ({reportedAgo(failedStep)})</span>
            )}
            :
          </span>
          <pre>{failedStep.error}</pre>
          <button
            className="btn"
            onClick={() => launchId && resumeLaunch(launchId).catch((e) => setError(String(e)))}
          >
            Retry
          </button>
        </div>
      )}
      {/* paused with nothing failed, waiting or to sign (a re-place whose close
          was just confirmed, say): nothing else here would move it on */}
      {!pending &&
        !pendingGentx &&
        !waitingStep &&
        !failedStep &&
        launch.status === "paused" && (
          <div className="banner wait">
            <span>The launch is paused with nothing waiting on you.</span>
            <button
              className="btn"
              onClick={() => launchId && resumeLaunch(launchId).catch((e) => setError(String(e)))}
            >
              Resume
            </button>
          </div>
        )}
    </>
  );

  return (
    <main className="shell">
      <NebulaField />
      {/* ---------- top bar ---------- */}
      <header className="topbar">
        <div className="logo">
          <span className="logo-glyph" aria-hidden="true" />
          <h1>
            Spark Dream <span>Launcher</span>
          </h1>
        </div>
        {headlineFleet ? (
          launching && headlineFleet.launchId === launchId ? (
            <div className="pill busy-pill">
              <span className="dot" />
              <span className="chain-name" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {headlineFleet.chainId}
              </span>
              <span className="state">{activeOpKinds.length > 0 ? "working" : "launching"}</span>
            </div>
          ) : (
            <div className="pill live">
              <span className="dot" />
              <span className="chain-name">{headlineFleet.chainId}</span>
              <span className="state">running</span>
              {headlineHeight > 0 && (
                <span className="mono">block {headlineHeight.toLocaleString()}</span>
              )}
            </div>
          )
        ) : (
          <div className="pill none">
            <span className="dot" />
            <span>no chain yet</span>
          </div>
        )}
        {!wallet && (
          <button className="btn primary small" style={{ marginLeft: "auto" }} onClick={() => connect()}>
            Connect Keplr
          </button>
        )}
        <div
          className="net-pill"
          style={wallet ? undefined : { marginLeft: 0 }}
          onClick={() => setNetworkOpen((v) => !v)}
          title="Akash network settings and wallet balances"
        >
          <span className={`dot ${wallet ? "on" : "off"}`} />
          <span>{chain.chainName}</span>
          {wallet && balances && (
            <span className="bal">
              {microToDisplay(balanceOf("uakt"))} AKT · {microToDisplay(balanceOf("uact"))} ACT
            </span>
          )}
          {ledger && ledger.pending > 0 && <span className="bal">⟳ {ledger.pending} settling</span>}
          <span className="chev">{networkOpen ? "▴" : "▾"}</span>
        </div>
        <div className="settings-wrap" ref={settingsRef}>
          <button
            className="settings-cog"
            title="Launcher settings"
            aria-haspopup="menu"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            ⚙
          </button>
          {settingsOpen && (
            <div className="settings-menu" role="menu">
              <button className="menu-item" role="menuitem" onClick={() => openSystem("backup")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="5" rx="1" />
                  <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
                  <path d="M10 12h4" />
                </svg>
                <span className="mi-text">
                  <span className="mi-title">Backup</span>
                  <span className="mi-sub">Export or import launcher data</span>
                </span>
              </button>
              <button className="menu-item" role="menuitem" onClick={() => openSystem("recovery")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
                  <path d="M21 3v5h-5" />
                </svg>
                <span className="mi-text">
                  <span className="mi-title">Recovery and alerts</span>
                  <span className={`mi-sub${dnsSet ? " on" : ""}`}>Cloudflare DNS, unattended signing, alerts</span>
                </span>
              </button>
              <button className="menu-item" role="menuitem" onClick={() => openSystem("assets")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m7.5 4.27 9 5.15" />
                  <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                  <path d="M3.3 7 12 12l8.7-5" />
                  <path d="M12 22V12" />
                </svg>
                <span className="mi-text">
                  <span className="mi-title">Chain asset source</span>
                  <span className={`mi-sub${chainAssets?.mode === "fetch" ? " on" : ""}`}>
                    {chainAssets
                      ? `${chainAssets.mode === "baked" ? "Offline" : "Online"}${chainAssets.locked ? " (locked)" : ""}`
                      : "Offline or Online chain versions"}
                  </span>
                </span>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ---------- network settings ---------- */}
      {networkOpen && (
        <section className="net-panel">
          <div className="head">
            <span className="k">AKASH NETWORK</span>
            <span className="v">
              {chain.chainId} · {chain.denom} · {rpcHost}
            </span>
            {chainIsCustom && (
              <span
                className="v"
                style={{ color: "var(--amber-text)" }}
                title="One or more values differ from the built-in Akash mainnet defaults"
              >
                custom
              </span>
            )}
            <span className="note">deployments and the launch fee settle here</span>
            {wallet && (
              <span className="v" title={wallet.address}>
                connected: {wallet.name} ({wallet.address.slice(0, 14)}…)
              </span>
            )}
          </div>
          <div className="net-grid">
            {(
              [
                ["chainId", "chain id"],
                ["chainName", "name"],
                ["rpc", "rpc"],
                ["rest", "rest (lcd)"],
                ["denom", "denom"],
                ["bech32Prefix", "prefix"],
                ["gasPrice", "gas price"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <div className="f-label">{label}</div>
                <input
                  className="field"
                  value={chain[key]}
                  onChange={(e) => updateChain({ [key]: e.target.value })}
                />
              </div>
            ))}
            <div className="actions">
              <button
                className="btn accent-ghost"
                title="Register this network in Keplr (one-time; akashnet-2 is already known to Keplr)"
                onClick={() => suggestChain(chain).catch((e) => setError(String(e)))}
              >
                Suggest chain to Keplr
              </button>
              {chainIsCustom && (
                <button className="btn" onClick={() => updateChain(DEFAULT_CHAIN)}>
                  Reset to Akash mainnet
                </button>
              )}
            </div>
          </div>
          {wallet && bme && <div className="net-mint">{mintBlock(true)}</div>}
        </section>
      )}

      {relayerSettingsFor && (
        <RelayerSettingsModal
          launchId={relayerSettingsFor}
          onClose={() => setRelayerSettingsFor(null)}
          onError={(m) => setError(m)}
          onApplied={(result) => {
            const id = relayerSettingsFor;
            setRelayerSettingsFor(null);
            if (result.opId !== undefined) {
              showToast("relayer changes started: follow them in the Launch panel");
              openLaunch(id);
            } else {
              showToast("relayer settings saved");
            }
          }}
        />
      )}

      {relayerFundsView && (
        <div className="modal-scrim" onClick={() => setRelayerFundsView(null)}>
          <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
            <div className="k">Relayer funds</div>
            <p className="note">
              One key per chain the relayer signs on. Each sits on the relayer&apos;s provider, so keep it to
              gas money, under its cap. Withdrawing empties a key and stops relaying on that chain until it is
              funded again.
            </p>
            {relayerFundsView.rows === null ? (
              <p className="note">Reading balances…</p>
            ) : relayerFundsView.rows.length === 0 ? (
              <p className="note">This fleet has no relayer key yet.</p>
            ) : (
              <FundingRows
                rows={relayerFundsView.rows}
                toast={showToast}
                onError={(m) => setError(m)}
                onChanged={() => openRelayerFunds(relayerFundsView.launchId)}
                withdraw={async (chainId, to) => {
                  const { postRelayerWithdraw } = await import("../lib/api");
                  return postRelayerWithdraw(relayerFundsView.launchId, chainId, to);
                }}
              />
            )}
            <div className="actions" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => openRelayerFunds(relayerFundsView.launchId)}>
                Refresh
              </button>
              <button className="btn" onClick={() => setRelayerFundsView(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {resizeFor &&
        (() => {
          // design 4a: size cards, now vs. after, what the move does, cost change
          const f = fleet?.fleets.find((x) => x.launchId === resizeFor.launchId);
          const c = f?.components.find((x) => x.dseq === resizeFor.dseq);
          if (!f || !c) return null;
          const { opts, pick } = resizeFor;
          const close = () => setResizeFor(null);
          const gib = (v: string) => {
            const m = /^(\d+(?:\.\d+)?)(Mi|Gi|Ti)$/.exec(v);
            return m ? Number(m[1]) * (m[2] === "Mi" ? 1 / 1024 : m[2] === "Ti" ? 1024 : 1) : NaN;
          };
          const fmtGib = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} GiB`;
          const role = c.key.startsWith("val-") ? "Validator" : "Sentry node";
          const now = opts?.current.resources;
          const next = opts?.sizes.find((z) => z.id === pick);
          const col = (a: number, b: number) => (a > b ? "#4ade80" : a < b ? "#f5d08a" : "#c9cad6");
          const nowUsd = c.priceDenom === "uact" ? monthlyNum(c.price) : null;
          const delta = next && nowUsd !== null ? next.lowUsd - nowUsd : null;
          const usedGib = opts?.disk ? opts.disk.usedBytes / 2 ** 30 : null;
          const shrinks = now && next && (gib(next.resources.storage.data) < gib(now.storage.data) || gib(next.resources.memory) < gib(now.memory));
          const db = f.dataBackups;
          const usable = db?.autoRestore ? db.backups.find((b) => !b.blocker) : undefined;
          // what the old confirm said, folded into the design's own parts:
          // the steps, one amber note, and a backup link in the replay step
          const backupLink = (
            <button
              className="dlg-link"
              onClick={() => {
                close();
                setChainBackupsFor(f.launchId);
              }}
            >
              take a backup first
            </button>
          );
          const steps: ReactNode[] = [
            `A new ${pick ?? ""} deployment is created beside ${c.key}, on ${c.providerName} when it bids, else on another provider`,
            usable ? (
              `It starts from the chain-data backup at height ${usable.height.toLocaleString("en-US")} and syncs the rest while ${c.key} keeps running (both are billed until the handover)`
            ) : db?.scratchSync ? (
              <>
                It replays all ~{db.scratchSync.blocks.toLocaleString("en-US")} blocks from the fleet&apos;s nodes, about {hoursText(db.scratchSync.hours)}, while {c.key} keeps
                running and both are billed: {backupLink} to cut that to minutes
              </>
            ) : (
              `It syncs the chain from the fleet's nodes while ${c.key} keeps running (both are billed until the handover)`
            ),
            c.key.startsWith("val-")
              ? opts?.tmkms
                ? `The op pauses with the new signer address for tmkms.toml, then again after the one-minute handover for you to restart tmkms: be at the signer for both`
                : `It takes over ${c.key}'s node ID and signing state, so it cannot double-sign; about a minute offline`
              : `It takes over ${c.key}'s node ID and public endpoints; about a minute offline`,
            "The old deployment is closed and its deposit refunded; other fleet operations wait until then",
          ];
          const mono = "'JetBrains Mono', monospace";
          const cell = { padding: "8px 12px", borderTop: "1px solid rgba(255,255,255,.06)" } as const;
          const head = { padding: "8px 12px", background: "rgba(255,255,255,.025)", color: "#9a9bab" } as const;
          return (
            <div className="modal-scrim" onClick={close}>
              <div
                onClick={(e) => e.stopPropagation()}
                style={{ width: 500, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 32px)", overflowY: "auto", background: "#101016", border: "1px solid rgba(255,255,255,.1)", borderRadius: 14, boxShadow: "0 24px 64px rgba(0,0,0,.6)", color: "#ecedf2" }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "20px 22px 0" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 17 }}>Resize {c.key}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#9a9bab" }}>
                      {role} <span style={{ color: "#4a4b56" }}>·</span>{" "}
                      <span style={{ fontFamily: mono, fontSize: 11.5, color: "#c9cad6" }}>{c.providerName}</span>
                    </span>
                  </div>
                  <button onClick={close} aria-label="Close" className="dlg-x">✕</button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: "20px 22px" }}>
                  {!opts && !resizeFor.error && <div style={{ fontSize: 12.5, color: "#9a9bab" }}>Reading {c.key}'s sizes and disk…</div>}
                  {resizeFor.error && <div style={{ fontSize: 12.5, color: "#fca5a5" }}>{resizeFor.error}</div>}
                  {opts && (
                    <>
                      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                          <span style={{ fontWeight: 600, color: "#c9cad6" }}>New size</span>
                          <span style={{ display: "flex", alignItems: "center", gap: 6, color: "#9a9bab" }}>
                            Current{" "}
                            <span style={{ fontFamily: mono, fontSize: 11, color: "#f5d08a", background: "rgba(245,199,106,.08)", border: "1px solid rgba(245,199,106,.25)", padding: "1px 6px", borderRadius: 5 }}>
                              {opts.current.size}
                            </span>
                          </span>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                          {opts.sizes.map((z) => {
                            const sel = z.id === pick;
                            const current = z.id === opts.current.size;
                            const off = current || !!z.tooSmall;
                            return (
                              <button
                                key={z.id}
                                disabled={off}
                                title={current ? `${c.key} is ${z.id} now` : z.tooSmall}
                                onClick={() => setResizeFor((r) => r && { ...r, pick: z.id })}
                                style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 11px", borderRadius: 9, border: `1px solid ${sel ? "rgba(109,106,248,.6)" : "rgba(255,255,255,.1)"}`, background: sel ? "rgba(109,106,248,.12)" : "#16161e", color: "#ecedf2", cursor: off ? "default" : "pointer", textAlign: "left", opacity: off ? 0.45 : 1 }}
                              >
                                <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                                  <span style={{ fontSize: 13, fontWeight: 600, textTransform: "capitalize" }}>{z.id}</span>
                                  <span style={{ fontFamily: mono, fontSize: 11.5, color: "#c9cad6" }}>{current ? "now" : `$${z.lowUsd.toFixed(2)}`}</span>
                                </span>
                                <span style={{ display: "flex", flexDirection: "column", fontFamily: mono, fontSize: 10.5, color: "#9a9bab", lineHeight: 1.5 }}>
                                  <span style={{ whiteSpace: "nowrap" }}>{z.resources.cpu} vCPU · {fmtGib(gib(z.resources.memory))}</span>
                                  <span style={{ whiteSpace: "nowrap" }}>{fmtGib(gib(z.resources.storage.data))} disk</span>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {now && next && (
                        <div style={{ display: "grid", gridTemplateColumns: "72px repeat(3, minmax(0, 1fr))", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, overflow: "hidden", fontSize: 12 }}>
                          <span style={{ ...head, color: "#7d7e8c" }} />
                          <span style={head}>CPU</span>
                          <span style={head}>Memory</span>
                          <span style={head}>Data disk</span>
                          <span style={{ ...cell, color: "#9a9bab" }}>Now</span>
                          <span style={{ ...cell, fontFamily: mono, color: "#c9cad6" }}>{now.cpu} CPU</span>
                          <span style={{ ...cell, fontFamily: mono, color: "#c9cad6" }}>{fmtGib(gib(now.memory))}</span>
                          <span style={{ ...cell, fontFamily: mono, color: "#c9cad6" }}>
                            {fmtGib(gib(now.storage.data))}
                            <span
                              style={{ display: "block", fontSize: 10.5, color: "#7d7e8c" }}
                              title={usedGib === null ? `${c.key}'s disk could not be read, so whether a size fits its chain data was not checked` : undefined}
                            >
                              {usedGib !== null ? `${fmtGib(Math.round(usedGib * 10) / 10)} used` : "use unknown"}
                            </span>
                          </span>
                          <span style={{ ...cell, color: "#9a9bab" }}>After</span>
                          <span style={{ ...cell, fontFamily: mono, color: col(next.resources.cpu, now.cpu) }}>{next.resources.cpu} CPU</span>
                          <span style={{ ...cell, fontFamily: mono, color: col(gib(next.resources.memory), gib(now.memory)) }}>{fmtGib(gib(next.resources.memory))}</span>
                          <span style={{ ...cell, fontFamily: mono, color: col(gib(next.resources.storage.data), gib(now.storage.data)) }}>{fmtGib(gib(next.resources.storage.data))}</span>
                        </div>
                      )}

                      {opts.blocked && (
                        <div className="dlg-warn red">
                          <b>!</b>
                          <span>{opts.blocked}</span>
                        </div>
                      )}
                      {!opts.blocked && !next && (
                        <div className="dlg-warn">
                          <b>!</b>
                          <span>No other size fits: {c.key}'s chain data needs more room than the sizes it could move to.</span>
                        </div>
                      )}
                      {!opts.blocked && next && (shrinks || opts.risks.length > 0) && (
                        <div className="dlg-warn">
                          <b>!</b>
                          <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {shrinks && (
                              <span>
                                {gib(next.resources.storage.data) < gib(now!.storage.data)
                                  ? `The data disk shrinks to ${fmtGib(gib(next.resources.storage.data))}` +
                                    (usedGib !== null && opts.disk
                                      ? `. ${c.key} uses ~${fmtGib(Math.round(usedGib * 10) / 10)} today (${fmtGib(Math.round((opts.disk.freeBytes / 2 ** 30) * 10) / 10)} free), so it has less room to grow.`
                                      : ".")
                                  : `Memory drops to ${fmtGib(gib(next.resources.memory))}: a busy node may run short.`}
                              </span>
                            )}
                            {opts.risks.map((r) => (
                              <span key={r}>{r}</span>
                            ))}
                          </span>
                        </div>
                      )}

                      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", background: "rgba(255,255,255,.025)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "#9a9bab" }}>What happens</div>
                        {steps.map((t, i) => (
                          <div key={i} style={{ display: "flex", gap: 10, fontSize: 12.5, lineHeight: 1.45, color: "#c9cad6" }}>
                            <span style={{ flex: "none", width: 18, height: 18, borderRadius: 99, background: "rgba(109,106,248,.16)", color: "#b3b1fb", font: `600 10.5px ${mono}`, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>{i + 1}</span>
                            <span style={{ textWrap: "pretty" } as React.CSSProperties}>{t}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 22px", borderTop: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.02)", borderRadius: "0 0 14px 14px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                    {next && (
                      <span style={{ fontFamily: mono, fontSize: 13, color: "#ecedf2" }}>
                        {nowUsd !== null ? `$${nowUsd.toFixed(2)} → ` : ""}~${next.lowUsd.toFixed(2)}
                        {delta !== null && (
                          <span style={{ color: delta > 0 ? "#f5d08a" : "#4ade80" }}>
                            {" "}({delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)})
                          </span>
                        )}
                      </span>
                    )}
                    <span style={{ fontSize: 11.5, color: "#9a9bab" }}>per month, est. · 4 signatures</span>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={close}
                      style={{ padding: "9px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,.12)", background: "transparent", color: "#c9cad6", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
                    >
                      Cancel
                    </button>
                    <button
                      disabled={!next || !!opts?.blocked}
                      onClick={() => {
                        if (!pick) return;
                        close();
                        // the dialog is the confirmation: the conductor still refuses
                        // what cannot go ahead (too small, another resize running)
                        void fleetAction(f.launchId, c.dseq, "resize", { size: pick, confirm: true });
                      }}
                      style={{ padding: "9px 16px", borderRadius: 8, border: "none", background: !next || opts?.blocked ? "#3d3c7a" : "#6d6af8", color: "#fff", fontSize: 13, fontWeight: 600, cursor: !next || opts?.blocked ? "default" : "pointer" }}
                    >
                      Resize{pick ? ` to ${pick}` : ""}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

      {chainBackupsFor &&
        (() => {
          // design 3a: the downtime risk up front, kept backups as a list,
          // schedule and restore as real controls
          const f = fleet?.fleets.find((x) => x.launchId === chainBackupsFor);
          const db = f?.dataBackups;
          if (!f || !db) return null;
          const sentries = f.components.filter((c) => c.key.startsWith("sentry-") && c.state === "active");
          const spare = sentries.some((c) => c.key !== "sentry-0");
          const running = f.ops.find((o) => o.kind === "data-backup" && o.status === "active");
          // the copy's source: the running op's, else the chosen sentry or the automatic pick
          const source = (running?.params as { source?: string } | undefined)?.source ?? db.sourceNow ?? "sentry-0";
          const latestUsable = db.backups.find((b) => !b.blocker)?.name;
          const label = { fontSize: 12, fontWeight: 600, color: "#c9cad6" };
          const footNote = running
            ? source !== "sentry-0"
              ? "sentry-0 keeps serving meanwhile"
              : "API/RPC paused until the copy finishes"
            : source !== "sentry-0"
              ? `Copies from ${source}, no downtime`
              : "sentry-0 will pause during the copy";
          const schedulable = spare || db.schedule !== "off";
          return (
            <div className="modal-scrim" onClick={() => setChainBackupsFor(null)}>
              <div
                onClick={(e) => e.stopPropagation()}
                style={{ width: 560, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 32px)", overflowY: "auto", background: "#101016", border: "1px solid rgba(255,255,255,.1)", borderRadius: 14, boxShadow: "0 24px 64px rgba(0,0,0,.6)", color: "#ecedf2" }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "20px 22px 0" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 17 }}>Chain-data backups</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: "#c9cad6", background: "rgba(255,255,255,.06)", padding: "2px 7px", borderRadius: 5 }}>{f.name}</span>
                    </div>
                    <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "#9a9bab" }}>
                      A sentry&apos;s full data directory, encrypted with the fleet key and streamed to the mesh backup bucket.
                      Nothing is written to the node&apos;s disk.
                    </div>
                  </div>
                  <button
                    aria-label="Close"
                    onClick={() => setChainBackupsFor(null)}
                    style={{ flex: "none", width: 30, height: 30, borderRadius: 8, border: "none", background: "transparent", color: "#9a9bab", fontSize: 16, cursor: "pointer" }}
                  >
                    ✕
                  </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: "18px 22px 20px" }}>
                  {!spare && (
                    <div style={{ display: "flex", gap: 12, padding: "12px 14px", background: "rgba(245,199,106,.06)", border: "1px solid rgba(245,199,106,.28)", borderRadius: 10 }}>
                      <span style={{ flex: "none", width: 18, height: 18, borderRadius: 99, background: "rgba(245,199,106,.18)", color: "#f5d08a", font: "700 11px 'JetBrains Mono', monospace", display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>!</span>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#f5d08a" }}>Backing up causes downtime</div>
                        <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "#e6dcc4" }}>
                          sentry-0 stops while it copies. It&apos;s your only sentry, so the public API/RPC and the validator&apos;s link go quiet until it&apos;s done.
                        </div>
                        <button
                          onClick={() => {
                            setChainBackupsFor(null);
                            openAddDialog(f.launchId, f.name, null, "sentry");
                          }}
                          style={{ alignSelf: "flex-start", padding: 0, border: "none", background: "none", color: "#8f8dfa", fontSize: 12.5, fontWeight: 500, cursor: "pointer" }}
                        >
                          Add a second sentry to avoid this and enable schedules ›
                        </button>
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={label}>Kept backups</span>
                      <span style={{ fontSize: 11.5, color: "#9a9bab" }}>last 2 are kept</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", border: "1px solid rgba(255,255,255,.09)", borderRadius: 10, overflow: "hidden" }}>
                      {running && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 7, padding: "10px 13px", background: "rgba(109,106,248,.07)", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span style={{ width: 6, height: 6, borderRadius: 99, background: "#8f8dfa" }} />
                            <span style={{ fontSize: 12.5 }}>{running.progress?.label ?? `backing up from ${(running.params as { source?: string }).source ?? source}`}</span>
                            <span style={{ flex: 1 }} />
                            {running.progress?.elapsedSeconds !== undefined && (
                              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#b3b1fb" }}>
                                {Math.round(running.progress.elapsedSeconds / 60)} min
                              </span>
                            )}
                          </div>
                          <span className="bk-progress"><span /></span>
                        </div>
                      )}
                      {db.backups.length === 0 && !running && (
                        <div style={{ padding: "10px 13px", fontSize: 12.5, color: "#9a9bab" }}>No backups yet.</div>
                      )}
                      {db.backups.map((b) => {
                        const latest = b.name === latestUsable;
                        const tag = !b.verified ? "unverified" : b.blocker ? "not restorable" : latest ? "latest" : "usable";
                        return (
                          <div
                            key={b.name}
                            title={b.blocker ?? b.name}
                            style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr) auto auto", alignItems: "center", gap: 12, padding: "10px 13px", borderBottom: "1px solid rgba(255,255,255,.06)" }}
                          >
                            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5, color: b.blocker ? "#7d7e8c" : latest ? "#ecedf2" : "#c9cad6" }}>
                              {b.height.toLocaleString("en-US")}
                            </span>
                            <span style={{ fontSize: 12, color: "#9a9bab" }}>
                              {new Date(b.takenAt).toLocaleString()} · from {b.from}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                padding: "2px 8px",
                                borderRadius: 99,
                                color: !b.verified ? "#fbbf24" : b.blocker ? "#9a9bab" : latest ? "#4ade80" : "#c9cad6",
                                background: !b.verified ? "rgba(251,191,36,.1)" : b.blocker ? "rgba(255,255,255,.04)" : latest ? "rgba(74,222,128,.1)" : "rgba(255,255,255,.07)",
                              }}
                            >
                              {tag}
                            </span>
                            <button
                              className="bk-delete"
                              title={`Delete ${b.name} from the bucket`}
                              disabled={!!running}
                              onClick={() => void removeChainBackup(f.launchId, b)}
                            >
                              delete
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {sentries.length > 1 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <span style={label}>Copy from</span>
                        <span style={{ fontSize: 11.5, color: "#9a9bab" }}>
                          {db.source === "sentry-0" ? "scheduled backups still skip sentry-0" : "the sentry pauses during the copy"}
                        </span>
                      </div>
                      <div
                        style={{ display: "grid", gridTemplateColumns: `repeat(${sentries.length + 1}, minmax(0, 1fr))`, gap: 2, padding: 3, background: "#16161e", border: "1px solid rgba(255,255,255,.1)", borderRadius: 9, opacity: running ? 0.45 : 1 }}
                      >
                        {[null, ...sentries.map((c) => c.key).sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]))].map((k) => {
                          const on = db.source === k;
                          return (
                            <button
                              key={k ?? "auto"}
                              disabled={!!running || on}
                              title={
                                k === null
                                  ? `The highest-numbered sentry other than sentry-0 (now ${db.sourceNow ?? "none"})`
                                  : k === "sentry-0"
                                    ? "sentry-0 serves the public API/RPC: they pause while it is copied"
                                    : `Copy ${k}; sentry-0 keeps serving`
                              }
                              onClick={() => void chainBackupAction(f.launchId, { source: k })}
                              style={{ padding: "7px 0", borderRadius: 6, border: "none", background: on ? "rgba(109,106,248,.22)" : "transparent", color: on ? "#ecedf2" : "#9a9bab", fontSize: 12.5, fontWeight: 500, cursor: !running && !on ? "pointer" : "default", fontFamily: k ? "'JetBrains Mono', monospace" : undefined }}
                            >
                              {k ?? "Automatic"}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={label}>Schedule</span>
                      {!spare && <span style={{ fontSize: 11.5, color: "#9a9bab" }}>needs a second sentry</span>}
                    </div>
                    <div
                      style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 2, padding: 3, background: "#16161e", border: "1px solid rgba(255,255,255,.1)", borderRadius: 9, opacity: schedulable ? 1 : 0.45 }}
                    >
                      {(["off", "daily", "weekly"] as const).map((v) => {
                        const on = db.schedule === v;
                        return (
                          <button
                            key={v}
                            disabled={!schedulable || on}
                            onClick={() => void chainBackupAction(f.launchId, { schedule: v })}
                            style={{ padding: "7px 0", borderRadius: 6, border: "none", background: on ? "rgba(109,106,248,.22)" : "transparent", color: on ? "#ecedf2" : "#9a9bab", fontSize: 12.5, fontWeight: 500, cursor: schedulable && !on ? "pointer" : "default", textTransform: "capitalize" }}
                          >
                            {v}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <button
                    role="switch"
                    aria-checked={db.autoRestore}
                    onClick={() => void chainBackupAction(f.launchId, { autoRestore: !db.autoRestore })}
                    style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 14px", background: "rgba(255,255,255,.025)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, color: "#ecedf2", cursor: "pointer", textAlign: "left" }}
                  >
                    <span style={{ flex: "none", width: 32, height: 18, borderRadius: 99, background: db.autoRestore ? "#6d6af8" : "rgba(255,255,255,.18)", display: "flex", alignItems: "center", padding: 2, boxSizing: "border-box", justifyContent: db.autoRestore ? "flex-end" : "flex-start", marginTop: 1 }}>
                      <span style={{ width: 14, height: 14, borderRadius: 99, background: "#fff" }} />
                    </span>
                    <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>New nodes start from the latest usable backup</span>
                      <span style={{ fontSize: 12, lineHeight: 1.5, color: "#9a9bab" }}>
                        Applies to relaunched and added nodes. Off: they sync the whole chain from peers. An unverified backup, or one from another genesis or from before a node upgrade, is never used.
                      </span>
                    </span>
                  </button>
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 22px", borderTop: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.02)", borderRadius: "0 0 14px 14px" }}>
                  <span style={{ fontSize: 12, color: source !== "sentry-0" ? "#9a9bab" : "#f5d08a", flex: 1, minWidth: 0 }}>{footNote}</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => setChainBackupsFor(null)}
                      style={{ padding: "9px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,.12)", background: "transparent", color: "#c9cad6", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
                    >
                      Close
                    </button>
                    <button
                      disabled={Boolean(running)}
                      onClick={() => void chainBackupAction(f.launchId)}
                      style={{ padding: "9px 16px", borderRadius: 8, border: "none", background: running ? "#3d3c7a" : "#6d6af8", color: "#fff", fontSize: 13, fontWeight: 600, cursor: running ? "default" : "pointer" }}
                    >
                      {running ? "Backing up…" : source !== "sentry-0" ? "Back up now" : "Back up now, pause sentry-0"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

      {addForm && (() => {
        const o = addForm.options;
        const isSentry = addForm.key === "sentry";
        const kind = o?.kinds.find((k) => k.key === addForm.key);
        const size = o?.sentry?.sizes.find((z) => z.id === addForm.size);
        const low = isSentry ? size?.lowUsd : kind?.lowUsd;
        const high = isSentry ? size?.highUsd : kind?.highUsd;
        const name = isSentry ? (o?.sentry?.name ?? "sentry") : addForm.key;
        const usd = (n: number) => `$${n.toFixed(2)}`;
        const range = (lo?: number, hi?: number) => (lo !== undefined && hi !== undefined ? `${usd(lo)}–${usd(hi)}` : "—");
        const steps = isSentry ? (o?.sentry?.steps ?? []) : (kind?.steps ?? []);
        const signatures = isSentry ? (o?.sentry?.signatures ?? 3) : (kind?.signatures ?? 2);
        const choice = (k: string) =>
          k === "sentry"
            ? { label: "Sentry node", summary: "Public peer in front of the validator", count: `${o?.sentry?.have ?? 0} in fleet` }
            : (() => {
                const kk = o?.kinds.find((x) => x.key === k);
                return { label: kk?.label ?? k, summary: kk?.summary ?? "", count: "not in fleet" };
              })();
        const cur = addForm.key ? choice(addForm.key) : null;
        const sel = (on: boolean) => ({
          background: on ? "rgba(109,106,248,.12)" : "#16161e",
          border: `1px solid ${on ? "rgba(109,106,248,.6)" : "rgba(255,255,255,.1)"}`,
        });
        const field = {
          padding: "9px 12px",
          background: "#16161e",
          border: "1px solid rgba(255,255,255,.12)",
          borderRadius: 9,
          color: "#ecedf2",
          fontSize: 13,
          outline: "none",
          width: "100%",
          boxSizing: "border-box" as const,
        };
        const label = { fontSize: 12, fontWeight: 600, color: "#c9cad6" };
        return (
          <div className="modal-scrim" onClick={() => !addBusy && setAddForm(null)}>
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 500,
                maxWidth: "calc(100vw - 32px)",
                maxHeight: "calc(100vh - 32px)",
                overflowY: "auto",
                background: "#101016",
                border: "1px solid rgba(255,255,255,.1)",
                borderRadius: 14,
                boxShadow: "0 24px 64px rgba(0,0,0,.6)",
                position: "relative",
                color: "#ecedf2",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "20px 22px 0" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 17 }}>Add component</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#9a9bab" }}>
                    to fleet{" "}
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: "#c9cad6", background: "rgba(255,255,255,.06)", padding: "2px 7px", borderRadius: 5 }}>
                      {addForm.name}
                    </span>
                  </div>
                </div>
                <button
                  aria-label="Close"
                  disabled={addBusy}
                  onClick={() => setAddForm(null)}
                  style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid transparent", background: "transparent", color: "#9a9bab", fontSize: 16, cursor: "pointer" }}
                >
                  ✕
                </button>
              </div>

              {!o ? (
                <div style={{ padding: "26px 22px", fontSize: 12.5, color: "#9a9bab" }}>Reading what this fleet can add…</div>
              ) : !cur ? (
                <div style={{ padding: "26px 22px", fontSize: 12.5, color: "#9a9bab" }}>Nothing left to add to this fleet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: "20px 22px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7, position: "relative" }}>
                    <div style={label}>Component</div>
                    <button
                      onClick={() => setAddForm({ ...addForm, pickerOpen: !addForm.pickerOpen })}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, width: "100%", padding: "10px 12px", background: "#16161e", border: "1px solid rgba(255,255,255,.12)", borderRadius: 9, color: "#ecedf2", cursor: "pointer", textAlign: "left" }}
                    >
                      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{cur.label}</span>
                        <span style={{ fontSize: 12, color: "#9a9bab" }}>{cur.summary}</span>
                      </span>
                      <span style={{ color: "#9a9bab", fontSize: 11 }}>▾</span>
                    </button>
                    {addForm.pickerOpen && (
                      <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 6, zIndex: 5, background: "#16161e", border: "1px solid rgba(255,255,255,.14)", borderRadius: 10, boxShadow: "0 16px 40px rgba(0,0,0,.6)", padding: 5, display: "flex", flexDirection: "column", gap: 2 }}>
                        {[...(o.sentry ? ["sentry"] : []), ...o.kinds.map((k) => k.key)].map((k) => {
                          const c = choice(k);
                          return (
                            <button
                              key={k}
                              onClick={() => setAddForm({ ...addForm, key: k, pickerOpen: false })}
                              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 10px", borderRadius: 7, border: "none", background: k === addForm.key ? "rgba(109,106,248,.12)" : "transparent", color: "#ecedf2", cursor: "pointer", textAlign: "left" }}
                            >
                              <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                                <span style={{ fontSize: 13, fontWeight: 600 }}>{c.label}</span>
                                <span style={{ fontSize: 11.5, color: "#9a9bab" }}>{c.summary}</span>
                              </span>
                              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#9a9bab", whiteSpace: "nowrap" }}>{c.count}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={label}>Name</span>
                      <span style={{ color: "#7d7e8c" }}>{isSentry ? "auto-numbered" : "one per fleet"}</span>
                    </div>
                    <input readOnly value={name} style={{ ...field, fontFamily: "'JetBrains Mono', monospace", color: "#c9cad6" }} />
                  </div>

                  {!isSentry && kind?.needsDomain && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      <div style={label}>Public domain</div>
                      <input
                        placeholder="e.g. ntfy.example.com (blank: the spec editor's)"
                        value={addForm.domain}
                        onChange={(e) => setAddForm({ ...addForm, domain: e.target.value })}
                        style={field}
                      />
                    </div>
                  )}
                  {addForm.key === "bridge" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      <div style={label}>Mastodon fleet</div>
                      <input
                        placeholder="network name or launch id (blank: the spec editor's)"
                        value={addForm.bridgeTarget}
                        onChange={(e) => setAddForm({ ...addForm, bridgeTarget: e.target.value })}
                        style={field}
                      />
                    </div>
                  )}
                  {addForm.key === "verifier" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      <div style={label}>Verifier member</div>
                      <input
                        placeholder="address, ESTABLISHED or above (blank: the spec editor's)"
                        value={addForm.verifierWallet}
                        onChange={(e) => setAddForm({ ...addForm, verifierWallet: e.target.value })}
                        style={field}
                      />
                    </div>
                  )}
                  {(addForm.key === "relayer" || addForm.key === "mastodon") && (
                    <div style={{ fontSize: 12, color: "#9a9bab" }}>
                      Its settings come from topology.components.{addForm.key} in the spec editor.
                    </div>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", background: "rgba(255,255,255,.025)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "#9a9bab" }}>What happens</div>
                    {steps.map((text, i) => (
                      <div key={i} style={{ display: "flex", gap: 10, fontSize: 12.5, lineHeight: 1.45, color: "#c9cad6" }}>
                        <span style={{ flex: "none", width: 18, height: 18, borderRadius: 99, background: "rgba(109,106,248,.16)", color: "#b3b1fb", font: "600 10.5px 'JetBrains Mono', monospace", display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>
                          {i + 1}
                        </span>
                        <span style={{ textWrap: "pretty" } as React.CSSProperties}>{text}</span>
                      </div>
                    ))}
                  </div>

                  {isSentry && o.sentry && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      <div style={label}>Size</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                        {o.sentry.sizes.map((z) => (
                          <button
                            key={z.id}
                            onClick={() => setAddForm({ ...addForm, size: z.id })}
                            style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 11px", borderRadius: 9, color: "#ecedf2", cursor: "pointer", textAlign: "left", ...sel(z.id === addForm.size) }}
                          >
                            <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
                              <span style={{ fontSize: 13, fontWeight: 600, textTransform: "capitalize" }}>{z.id}</span>
                              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: "#c9cad6" }}>{usd(z.lowUsd)}</span>
                            </span>
                            <span style={{ display: "flex", flexDirection: "column", fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: "#9a9bab", lineHeight: 1.5 }}>
                              <span style={{ whiteSpace: "nowrap" }}>
                                {z.cpu} vCPU · {z.memory.replace("Gi", " GiB")}
                              </span>
                              <span style={{ whiteSpace: "nowrap" }}>{z.data.replace("Gi", " GiB")} disk</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    <div style={label}>Provider</div>
                    {(
                      [
                        [false, "Let the launcher pick", "Leases the best bid your selection policy accepts (audit, uptime, price cap, avoid list) right away."],
                        [true, "Choose the bid myself", "Pauses in the Launch panel with every bid received until you pick one."],
                      ] as const
                    ).map(([manual, title, desc]) => {
                      const on = addForm.manualBid === manual;
                      return (
                        <button
                          key={title}
                          onClick={() => setAddForm({ ...addForm, manualBid: manual })}
                          style={{ display: "flex", gap: 11, alignItems: "flex-start", padding: "10px 12px", borderRadius: 9, color: "#ecedf2", cursor: "pointer", textAlign: "left", ...sel(on) }}
                        >
                          <span style={{ flex: "none", width: 16, height: 16, borderRadius: 99, border: `1.5px solid ${on ? "#6d6af8" : "rgba(255,255,255,.3)"}`, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>
                            {on && <span style={{ width: 8, height: 8, borderRadius: 99, background: "#6d6af8" }} />}
                          </span>
                          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
                            <span style={{ fontSize: 12, color: "#9a9bab", lineHeight: 1.45 }}>{desc}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 22px", borderTop: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.02)", borderRadius: "0 0 14px 14px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>
                    +{range(low, high)}/mo<span style={{ color: "#9a9bab" }}> est.</span>
                  </span>
                  <span style={{ fontSize: 11.5, color: "#9a9bab" }}>
                    {addForm.fleetMonthly !== null && low !== undefined
                      ? `fleet $${addForm.fleetMonthly.toFixed(2)} → ~$${(addForm.fleetMonthly + low).toFixed(2)}/mo · `
                      : ""}
                    1 lease + deposit · {signatures} signatures
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    disabled={addBusy}
                    onClick={() => setAddForm(null)}
                    style={{ padding: "9px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,.12)", background: "transparent", color: "#c9cad6", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
                  >
                    Cancel
                  </button>
                  <button
                    disabled={addBusy || !cur}
                    onClick={() => void submitAdd()}
                    style={{ padding: "9px 16px", borderRadius: 8, border: "none", background: "#6d6af8", color: "#fff", fontSize: 13, fontWeight: 600, cursor: addBusy || !cur ? "default" : "pointer", opacity: addBusy || !cur ? 0.6 : 1 }}
                  >
                    {addBusy ? "Starting…" : `Add ${name}`}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {meshBackupForm && (
        <div className="modal-scrim" onClick={() => !meshBackupBusy && setMeshBackupForm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="k">Back up the {meshBackupForm.network} mesh</div>
            <p className="note">
              headscale streams its database to this S3 bucket and uploads its keys once, all
              encrypted with this fleet&apos;s age key before they leave the container. A relaunch on
              another provider then restores the mesh as it was, instead of re-keying every
              component. One signature updates the running headscale in place (a few seconds of
              control-plane restart; existing connections keep working).
            </p>
            {(
              [
                ["endpoint", "S3 endpoint (https://…)"],
                ["bucket", "bucket"],
                ["region", "region"],
                ["accessKeyId", "access key"],
              ] as const
            ).map(([k, label]) => (
              <input
                key={k}
                className="field"
                placeholder={label}
                value={meshBackupForm[k]}
                onChange={(e) => setMeshBackupForm({ ...meshBackupForm, [k]: e.target.value })}
                style={{ marginBottom: 6 }}
              />
            ))}
            <input
              className="field"
              type="password"
              placeholder={meshBackupForm.known ? "secret key (blank: reuse the stored one)" : "secret key"}
              value={meshBackupForm.secret}
              onChange={(e) => setMeshBackupForm({ ...meshBackupForm, secret: e.target.value })}
            />
            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="btn primary small"
                disabled={
                  meshBackupBusy ||
                  !meshBackupForm.endpoint ||
                  !meshBackupForm.bucket ||
                  !meshBackupForm.accessKeyId ||
                  (!meshBackupForm.known && !meshBackupForm.secret)
                }
                onClick={() => void submitMeshBackup()}
              >
                {meshBackupBusy ? "Starting…" : "Turn on backup"}
              </button>
              <button className="btn" disabled={meshBackupBusy} onClick={() => setMeshBackupForm(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {backupPrompt && (
        <div className="modal-scrim" onClick={() => !backupBusy && setBackupPrompt(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="k">
              {backupPrompt.mode === "export" ? "Create launcher backup" : "Restore launcher backup"}
            </div>
            <p className="note">
              {backupPrompt.mode === "export"
                ? "Choose a passphrase to encrypt the archive. You will need the same passphrase to restore it, and it cannot be recovered if lost."
                : "Enter the passphrase this backup was encrypted with. Launches already present here are left untouched."}
            </p>
            <input
              className="field"
              type="password"
              autoFocus
              placeholder="passphrase"
              value={backupPass}
              onChange={(e) => setBackupPass(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && backupPass && !backupBusy) runBackup();
              }}
            />
            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="btn primary small"
                disabled={!backupPass || backupBusy}
                onClick={runBackup}
              >
                {backupBusy
                  ? "Working…"
                  : backupPrompt.mode === "export"
                    ? "Create"
                    : "Restore"}
              </button>
              <button className="btn" disabled={backupBusy} onClick={() => setBackupPrompt(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="content">
        {/* ---------- system panel (opened from the settings cog) ---------- */}
        {systemOpen && (
          <section className="card sys-panel">
            <div className="card-head">
              <div>
                <div className="card-title">System</div>
                <div className="card-sub">launcher-wide tools and settings</div>
              </div>
              <button className="btn" onClick={() => setSystemOpen(false)}>
                Close
              </button>
            </div>
            <div className="card-body sys-blocks">
              <div className={`sys-block${sysFocus === "backup" ? " focus" : ""}`}>
                <div className="f-label">Backup</div>
                <div className="sys-desc">
                  One encrypted archive of every fleet: keys, deployment records and settings.
                  Create one to move this launcher to another machine, or restore one here
                  (launches already present are left untouched).
                </div>
                <div className="sys-actions">
                  <button
                    className="btn accent-ghost"
                    title="Best done while no launch is running"
                    onClick={() => {
                      setBackupReport(null);
                      setBackupError(null);
                      setBackupPass("");
                      setBackupPrompt({ mode: "export" });
                    }}
                  >
                    Create backup
                  </button>
                  <label className="btn">
                    Restore backup
                    <input
                      ref={backupInputRef}
                      type="file"
                      accept=".enc"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setBackupReport(null);
                        setBackupError(null);
                        setBackupPass("");
                        setBackupPrompt({ mode: "import", file });
                        e.target.value = ""; // allow re-selecting the same file
                      }}
                    />
                  </label>
                </div>
                {backupReport && (
                  <div className="ready-banner ok">
                    <span className="grow">
                      Restored {backupReport.restored.length} launch(es)
                      {backupReport.restored.length > 0 && `: ${backupReport.restored.join(", ")}`}.
                      {backupReport.skipped.length > 0 &&
                        ` Skipped ${backupReport.skipped.length} already present: ${backupReport.skipped.join(", ")}.`}
                      {backupReport.settingsAdded.length > 0 &&
                        ` Filled ${backupReport.settingsAdded.length} setting(s).`}
                    </span>
                    <button className="btn" style={{ flex: "none" }} onClick={() => setBackupReport(null)}>
                      Dismiss
                    </button>
                  </div>
                )}
                {backupError && (
                  <div className="ready-banner warn">
                    <span className="grow">{backupError}</span>
                    <button className="btn" style={{ flex: "none" }} onClick={() => setBackupError(null)}>
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
              <div className="sys-block">
                <div className="f-label">Alerts</div>
                <div className="sys-desc">
                  Where the launcher tells you a component went down (after about two minutes of
                  failed checks) and when it is back, with the fix it suggests. ntfy.sh is free:
                  install its app, subscribe to a topic name only you know, and enter it here. On
                  your own ntfy server with logins, add the launcher user&apos;s access token. A
                  webhook gets the same alerts as JSON.
                </div>
                {alertForm && (
                  <div style={{ display: "grid", gap: 6, maxWidth: 420 }}>
                    <input
                      className="field"
                      placeholder="ntfy topic (e.g. a long random name)"
                      value={alertForm.topic}
                      onChange={(e) => setAlertForm({ ...alertForm, topic: e.target.value })}
                    />
                    <input
                      className="field"
                      placeholder="ntfy server (blank: https://ntfy.sh)"
                      value={alertForm.server}
                      onChange={(e) => setAlertForm({ ...alertForm, server: e.target.value })}
                    />
                    <input
                      className="field"
                      type="password"
                      placeholder={
                        alertForm.tokenSet
                          ? "ntfy access token is set (type to replace)"
                          : "ntfy access token tk_... (self-hosted server with logins)"
                      }
                      value={alertForm.token}
                      onChange={(e) => setAlertForm({ ...alertForm, token: e.target.value })}
                    />
                    <input
                      className="field"
                      placeholder="fallback ntfy topic on ntfy.sh, used when your server is down (or https://server/topic)"
                      value={alertForm.fallback}
                      onChange={(e) => setAlertForm({ ...alertForm, fallback: e.target.value })}
                    />
                    <input
                      className="field"
                      placeholder="webhook URL (optional)"
                      value={alertForm.webhook}
                      onChange={(e) => setAlertForm({ ...alertForm, webhook: e.target.value })}
                    />
                  </div>
                )}
                <div className="sys-actions">
                  <button
                    className="btn accent-ghost"
                    onClick={async () => {
                      if (!alertForm) return;
                      setError(null);
                      try {
                        const { saveAlertSettings } = await import("../lib/api");
                        const saved = await saveAlertSettings({
                          ...(alertForm.topic.trim()
                            ? {
                                ntfy: {
                                  topic: alertForm.topic.trim(),
                                  server: alertForm.server.trim(),
                                  // blank keeps the stored token
                                  ...(alertForm.token.trim() ? { token: alertForm.token.trim() } : {}),
                                },
                              }
                            : {}),
                          ...(alertForm.fallback.trim()
                            ? {
                                ntfyFallback: (() => {
                                  const f = alertForm.fallback.trim().replace(/\/+$/, "");
                                  const m = /^(https?:\/\/.+)\/([^/]+)$/.exec(f);
                                  return m ? { server: m[1]!, topic: m[2]! } : { server: "https://ntfy.sh", topic: f };
                                })(),
                              }
                            : {}),
                          ...(alertForm.webhook.trim() ? { webhook: alertForm.webhook.trim() } : {}),
                        });
                        setAlertForm({ ...alertForm, token: "", tokenSet: Boolean(saved.ntfyTokenSet) });
                        setAlertNote("saved");
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    Save
                  </button>
                  <button
                    className="btn"
                    onClick={async () => {
                      setError(null);
                      try {
                        const { sendTestAlert } = await import("../lib/api");
                        const { failures } = await sendTestAlert();
                        setAlertNote(failures.length === 0 ? "test alert sent" : failures.join("; "));
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    Send test
                  </button>
                  {alertNote && <span className="dim-note">{alertNote}</span>}
                </div>
              </div>
              <div className={`sys-block${sysFocus === "recovery" ? " focus" : ""}`}>
                <div className="f-label">Cloudflare DNS</div>
                <div className="sys-desc">
                  When a move puts a component on another provider, its domains have to point at the new
                  ingress. With a Cloudflare API token (DNS Edit, Zone Read and Origin Rules Edit on the zones
                  your fleets use; free plans include them) the launcher sets the records, and the origin rules
                  that send the sentry&apos;s public API and RPC to their ports, instead of pausing for you.{" "}
                  {dnsSet === true
                    ? `A token is set${dnsZones.length > 0 ? `; it reaches ${dnsZones.join(", ")}` : ""}${
                        dnsOrigin ? " and can edit origin rules." : ", but not origin rules: the public API and RPC still pause for you."
                      }`
                    : dnsSet === false
                      ? "No token is set."
                      : ""}
                </div>
                <div className="sys-actions">
                  <input
                    className="field"
                    type="password"
                    style={{ maxWidth: 320 }}
                    placeholder={dnsSet ? "replace the token" : "Cloudflare API token"}
                    value={dnsToken}
                    onChange={(e) => setDnsToken(e.target.value)}
                  />
                  <button
                    className="btn accent-ghost"
                    disabled={!dnsToken.trim()}
                    onClick={async () => {
                      setError(null);
                      try {
                        const { saveCloudflareToken } = await import("../lib/api");
                        const saved = await saveCloudflareToken(dnsToken.trim());
                        setDnsSet(saved.cloudflare);
                        setDnsZones(saved.zones ?? []);
                        setDnsOrigin(Boolean(saved.originRules));
                        setDnsToken("");
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    Save
                  </button>
                  {dnsSet && (
                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          const { saveCloudflareToken } = await import("../lib/api");
                          setDnsSet((await saveCloudflareToken(null)).cloudflare);
                          setDnsZones([]);
                        } catch (e) {
                          setError(String(e));
                        }
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
              {wallet && unattended && (
                <div className="sys-block">
                  <div className="f-label">Unattended recovery</div>
                  <div className="sys-desc">
                    Lets the launcher sign the transactions of the recoveries it starts on its own (a fleet&apos;s
                    auto-recovery), as this wallet: create, update and close deployments and create leases,
                    nothing else (no transfers). Your wallet grants that to the launcher&apos;s key below for 30
                    days, plus a fee allowance; new deployments&apos; deposits are capped per day here.
                  </div>
                  <div style={{ display: "grid", gap: 4, fontSize: 13 }}>
                    <div>
                      launcher key <code>{unattended.grantee}</code>
                    </div>
                    <div>
                      grant:{" "}
                      {unattended.grants === null ? (
                        <span className="dim-note">could not be read</span>
                      ) : unattended.covers.every((t) => unattended.grants!.some((g) => g.msgType === t)) ? (
                        <span style={{ color: "var(--ok)" }}>
                          active until{" "}
                          {new Date(
                            Math.min(...unattended.grants.map((g) => Date.parse(g.expiration ?? "9999-12-31"))),
                          ).toLocaleDateString()}
                        </span>
                      ) : (
                        <span style={{ color: "var(--amber-text)" }}>not granted</span>
                      )}
                      {unattended.allowance && (
                        <span className="dim-note">
                          {" "}
                          · fee allowance{" "}
                          {unattended.allowance.spendLimit.map((c) => `${Number(c.amount) / 1e6} ${c.denom.replace(/^u/, "").toUpperCase()}`).join(", ")}{" "}
                          left
                        </span>
                      )}
                    </div>
                    {unattended.allowanceProblem && (
                      <div style={{ color: "var(--amber-text)" }}>{unattended.allowanceProblem}</div>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={unattended.settings.enabled}
                        disabled={unattendedSaving}
                        onChange={async (e) => {
                          // shown at once: a controlled box otherwise snaps back
                          // until the reload answers, and reads as "did nothing"
                          const enabled = e.target.checked;
                          const before = unattended;
                          setUnattended({ ...unattended, settings: { ...unattended.settings, enabled } });
                          setUnattendedSaving(true);
                          try {
                            const { saveUnattended } = await import("../lib/api");
                            await saveUnattended(wallet.address, { enabled });
                            await loadUnattended(wallet.address);
                          } catch (err) {
                            setUnattended(before);
                            setError(`could not ${enabled ? "turn on" : "turn off"} unattended signing: ${String(err)}`);
                          } finally {
                            setUnattendedSaving(false);
                          }
                        }}
                      />{" "}
                      sign auto-recovery transactions with the grant
                    </label>
                    <label>
                      daily deposit cap{" "}
                      <input
                        className="field"
                        style={{ width: 90, display: "inline-block" }}
                        value={unattendedCap}
                        onChange={(e) => setUnattendedCap(e.target.value)}
                        onBlur={async () => {
                          const v = Number(unattendedCap);
                          if (!Number.isFinite(v) || v < 0) return;
                          try {
                            const { saveUnattended } = await import("../lib/api");
                            await saveUnattended(wallet.address, { dailyCap: String(Math.round(v * 1e6)) });
                            await loadUnattended(wallet.address);
                          } catch (err) {
                            setError(String(err));
                          }
                        }}
                      />{" "}
                      ACT <span className="dim-note">({Number(unattended.spentToday) / 1e6} used in the last 24 hours)</span>
                    </label>
                  </div>
                  <div className="sys-actions">
                    <button className="btn accent-ghost" disabled={busy !== null} onClick={() => void signUnattended("grant")}>
                      Grant for 30 days
                    </button>
                    <button className="btn" disabled={busy !== null} onClick={() => void signUnattended("revoke")}>
                      Revoke
                    </button>
                  </div>
                </div>
              )}
              <div className={`sys-block${sysFocus === "assets" ? " focus" : ""}`}>
                <div className="f-label">Chain asset source</div>
                <div className="sys-desc">
                  Where the chain node binary and its deploy config come from when a launch
                  needs a version. Offline uses only locally cached versions with zero
                  network; Online fetches and verifies them as needed. Service images
                  (frontend, explorer, ...) are unaffected: providers pull those directly.
                </div>
                {chainAssets ? (
                  <div className="sys-actions">
                    <span className={`sys-mode${chainAssets.mode === "fetch" ? " on" : ""}`}>
                      {chainAssets.mode === "baked" ? "Offline" : "Online"}
                      {chainAssets.locked ? " (set by the operator)" : ""}
                    </span>
                    {!chainAssets.locked && (
                      <button
                        className="btn"
                        onClick={() =>
                          toggleAssetsMode(chainAssets.mode === "baked" ? "fetch" : "baked")
                        }
                      >
                        Switch to {chainAssets.mode === "baked" ? "Online" : "Offline"}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="sys-desc">mode unavailable (conductor unreachable)</div>
                )}
              </div>
            </div>
          </section>
        )}
        {/* ---------- launch card ---------- */}
        {/* the accent border matches the selected fleet pair below, tying the
            step log to the fleet it belongs to */}
        <section
          ref={launchCardRef}
          className={`card${loadingLaunch || launching || launched ? " viewing" : ""}`}
        >
          <div
            className={`card-head${launched ? " clickable" : ""}`}
            title={launched ? "show / hide the launch step log" : undefined}
            onClick={launched ? toggleLog : undefined}
          >
            {idle && (
              <>
                <div>
                  <div className="card-title">
                    {specDoc?.kind === "services" ? "Launch your services fleet" : "Launch your chain"}
                  </div>
                  <div className="card-sub">
                    {specDoc?.kind === "services"
                      ? "Shared components, no chain: edit the YAML, or start another draft from New services fleet…."
                      : "Guided setup, or switch to the form or raw YAML."}
                    {costRange && ` Est. ${costRange} first month.`}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
                  <div className="seg tight">
                    {(
                      [
                        ["guided", "Guided"],
                        ["form", "Form"],
                        ["yaml", "YAML"],
                      ] as const
                    )
                      .filter(([m]) => !servicesDraft || m === "yaml")
                      .map(([m, label]) => (
                      <button key={m} className={viewMode === m ? "on" : ""} onClick={() => switchMode(m)}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {cancelTargetId && (
                    <button
                      className="btn"
                      title="Close the launch editor and go back to your running chain (nothing is discarded; the spec stays as edited)"
                      onClick={() => {
                        openLaunch(cancelTargetId);
                        setWizStep(0);
                        setWizMax(0);
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </>
            )}
            {loadingLaunch && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div className="card-title">Launch</div>
                {(() => {
                  const name = fleet?.fleets.find((f) => f.launchId === launchId)?.name;
                  return name ? <span className="tag name">{name}</span> : null;
                })()}
                <span className="spinner" />
                {/* invisible twin of the launched header's button keeps the
                    row height identical, so the card doesn't jump while the
                    launch view loads */}
                <button className="btn" style={{ visibility: "hidden" }} aria-hidden tabIndex={-1}>
                  new launch
                </button>
              </div>
            )}
            {launching && (
              <>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <div className="card-title">Launch</div>
                    <span className="tag name">{launchName}</span>
                    <span className="card-title" style={{ fontWeight: 500 }}>
                      {activeOpKinds.length > 0
                        ? `working: ${activeOpKinds.join(", ")}…`
                        : "launching…"}
                    </span>
                  </div>
                  <div className="card-sub">
                    {activeOpKinds.length > 0
                      ? "This operation runs through the same steps and signatures as a launch."
                      : "Leases, genesis and services. Deposits stay refundable."}
                  </div>
                </div>
                <span className="mono-dim" style={{ flex: "none", fontSize: 12 }}>
                  {launchPct}% · step {stepPos} of {totalSteps}
                </span>
                {isTmkms && (
                  <button
                    className="btn"
                    title="Signer machine setup: mesh join command, consensus key, tmkms.toml"
                    onClick={() => launchId && showTmkms(launchId)}
                  >
                    tmkms setup
                  </button>
                )}
              </>
            )}
            {launched && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div className="card-title">Launch</div>
                  <span className="tag name">{launchName}</span>
                  <span className="card-title" style={{ fontWeight: 500 }}>
                    is live
                  </span>
                  <span className="badge-ok">
                    completed · {doneSteps}/{totalSteps}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "none" }}>
                  <span className="mono-dim">spec {launch!.id.slice(0, 8)}</span>
                  {isTmkms && (
                    <button
                      className="btn"
                      title="Signer machine setup: mesh join command, consensus key, tmkms.toml"
                      onClick={(e) => {
                        e.stopPropagation();
                        launchId && showTmkms(launchId);
                      }}
                    >
                      tmkms setup
                    </button>
                  )}
                  <button
                    className="btn"
                    title="Start a fresh launch from the spec editor (this chain keeps running)"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeLaunch();
                    }}
                  >
                    new launch
                  </button>
                  <span style={{ color: "var(--dim2)", fontSize: 13 }}>{logOpen ? "▴" : "▾"}</span>
                </div>
              </>
            )}
          </div>

          {/* guided wizard */}
          {idle && viewMode === "guided" && (
            <div className="card-body">
              <div className="wiz-tabs">
                {["Wallet", "Configure", "Review"].map((label, i) => {
                  const done = i < wizStep;
                  const active = i === wizStep;
                  return (
                    <button
                      key={label}
                      className={`wiz-tab${active ? " active" : done ? " done" : ""}${i <= wizMax ? " reachable" : ""}`}
                      onClick={() => wizardGo(i)}
                    >
                      <span className="wiz-num">{done ? "✓" : i + 1}</span>
                      {label}
                    </button>
                  );
                })}
              </div>

              {wizStep === 0 && (
                <div className="wiz-body">
                  <div className="wiz-intro">
                    Deployments are paid in ACT. This launch needs about{" "}
                    <b>{depositActStr}</b> in refundable deposits: mint it from your AKT balance
                    first.
                  </div>
                  <div className="dim-note" style={{ marginTop: 9, fontSize: 12 }}>
                    Paying on{" "}
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--dim)" }}>
                      {chain.chainId} · {chain.denom} · {rpcHost}
                    </span>{" "}
                    ·{" "}
                    <button className="btn link" onClick={() => setNetworkOpen(true)}>
                      network settings
                    </button>
                  </div>
                  {!wallet ? (
                    <div className="sub-card" style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 14 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>Connect your wallet</div>
                        <div className="stat-sub">
                          Keplr signs every transaction; the launcher never holds your keys.
                        </div>
                      </div>
                      <button className="btn primary small" onClick={() => connect()}>
                        Connect Keplr
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="two-col" style={{ marginTop: 16 }}>
                        <div className="sub-card">
                          <div className="stat-k">AKT · AKASH</div>
                          <div className="stat-v">
                            {balances ? microToDisplay(balanceOf("uakt")) : "—"}
                          </div>
                          <div className="stat-sub">available to convert</div>
                        </div>
                        <div className="sub-card">
                          <div className="stat-k">{denomLabel} · DEPLOYMENT CREDIT</div>
                          <div className="stat-v">
                            {balances ? microToDisplay(balanceOf(chain.denom)) : "—"}
                          </div>
                          <div className="meter" style={{ marginTop: 9 }}>
                            <i
                              className={walletReady ? "ok" : "warn"}
                              style={{ width: `${actPct}%` }}
                            />
                          </div>
                          <div
                            className="stat-sub"
                            style={{
                              marginTop: 6,
                              color: walletReady ? "var(--ok)" : "var(--amber)",
                            }}
                          >
                            {walletReady
                              ? "✓ enough for this launch"
                              : `${microToDisplay(balanceOf(chain.denom) ?? "0")} of ${depositActStr} needed`}
                          </div>
                        </div>
                      </div>
                      {bme && mintBlock(false)}
                    </>
                  )}
                  <div className="wiz-nav end">
                    <button className="btn primary" onClick={wizardNext}>
                      Continue →
                    </button>
                  </div>
                </div>
              )}

              {wizStep === 1 && (
                <div className="wiz-body">
                  <div className="two-col narrow">
                    <div>
                      <div className="f-label">Chain name</div>
                      <input
                        className="field"
                        value={specName}
                        onChange={(e) => setSpecName(e.target.value)}
                      />
                    </div>
                    <div>
                      <div className="f-label">Network type</div>
                      {typeSeg}
                    </div>
                    <div>
                      <div className="f-label">Token symbol</div>
                      <input
                        className="field"
                        value={specSym}
                        onChange={(e) => setSpecSym(e.target.value)}
                      />
                    </div>
                    <div>
                      <div className="f-label">Dream token</div>
                      <input
                        className="field"
                        value={specDream}
                        onChange={(e) => setSpecDream(e.target.value)}
                      />
                    </div>
                    <div>
                      <div className="f-label">
                        Validators <span className="hint">· the nodes that sign blocks</span>
                      </div>
                      {counter(specVals, "validators")}
                    </div>
                    <div>
                      <div className="f-label">
                        Sentries <span className="hint">· shield your validators</span>
                      </div>
                      {counter(specSents, "sentries")}
                    </div>
                    <div>
                      <div className="f-label">
                        Validator size <span className="hint">· CPU, memory, chain data</span>
                      </div>
                      {sizeSeg("validator")}
                    </div>
                    <div>
                      <div className="f-label">
                        Sentry size <span className="hint">· a public sentry may need large</span>
                      </div>
                      {sizeSeg("sentry")}
                    </div>
                    <div>
                      <div className="f-label">
                        Provider selection <span className="hint">· who picks the bids</span>
                      </div>
                      {bidSeg}
                    </div>
                  </div>
                  {bidNote(specBidMode) && (
                    <div className="dim-note" style={{ marginTop: 10 }}>
                      {bidNote(specBidMode)}
                    </div>
                  )}
                  <div style={{ marginTop: 18 }}>
                    <div className="f-label" style={{ marginBottom: 9 }}>
                      Genesis accounts
                    </div>
                    <div className="chips">
                      {specAccounts.map((a) => (
                        <span key={a} className="chip">
                          {a}
                        </span>
                      ))}
                      <button className="chip-add" onClick={addSpecAccount}>
                        + add
                      </button>
                    </div>
                  </div>
                  <div style={{ marginTop: 18, display: "flex", gap: 12, alignItems: "center" }}>
                    <button className="btn link" onClick={() => setAdvOpen((v) => !v)}>
                      {advOpen ? "▾" : "▸"} Advanced: edit the raw spec (YAML)
                    </button>
                    <label className="btn link" style={{ cursor: "pointer" }}>
                      Prefill from genesis.json…
                      <input
                        type="file"
                        accept=".json,application/json"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) void prefillFromGenesisFile(file);
                        }}
                      />
                    </label>
                    <label
                      className="btn link"
                      style={{ cursor: "pointer" }}
                      title="Join an existing chain: the bundle its operator published becomes the spec's join block, token, prefix and node image. Everything else (your providers, resources, keys) stays yours."
                    >
                      Prefill from join bundle…
                      <input
                        type="file"
                        accept=".json,application/json"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) void prefillFromJoinBundleFile(file);
                        }}
                      />
                    </label>
                    <button
                      className="btn link"
                      title="A services fleet: no chain, only shared components several chains use (a Mastodon instance each chain links with a standalone bridge). Asks for its name, the instance's domains, owner and size, and writes the spec into the editor."
                      onClick={() => void newServicesFleet()}
                    >
                      New services fleet…
                    </button>
                  </div>
                  {advOpen && <div style={{ marginTop: 10 }}>{specTextarea(220)}</div>}
                  {specIssueList(!advOpen)}
                  <div className="wiz-nav">
                    <button className="btn" onClick={() => setWizStep(0)}>
                      ← Back
                    </button>
                    <button className="btn primary" onClick={wizardNext}>
                      Review →
                    </button>
                  </div>
                </div>
              )}

              {wizStep === 2 && (
                <div className="wiz-body">
                  <div className="chips">
                    <span className="chip plain">{specName || "unnamed"}</span>
                    <span className="chip plain">{specType}</span>
                    <span className="chip plain">
                      {specSym || "?"} / {specDream}
                    </span>
                    <span className="chip plain">
                      {specVals} validator{specVals === 1 ? "" : "s"} · {specSents}{" "}
                      {specSents === 1 ? "sentry" : "sentries"} · {specAccounts.length} accounts
                    </span>
                    <span className="chip plain">
                      validators {specRoleSize("validator")} · sentries {specRoleSize("sentry")}
                    </span>
                    {specBidMode === "every" && <span className="chip plain">you pick every bid</span>}
                    {specBidMode === "nodes" && <span className="chip plain">you pick the node bids</span>}
                  </div>
                  <div className="sub-card" style={{ marginTop: 16, padding: "18px 20px" }}>
                    <div className="cost-head">
                      <div>
                        <div className="stat-k">EST. FIRST MONTH</div>
                        <div className="cost-big">{costRange ?? "—"}</div>
                        <div className="stat-sub">
                          then {monthlyRange ?? "—"} / month · plus {depositActStr} refundable
                          deposit
                        </div>
                      </div>
                      <button className="btn" style={{ flex: "none" }} onClick={() => setCostOpen((v) => !v)}>
                        {costOpen ? "Hide breakdown ▴" : "See breakdown ▾"}
                      </button>
                    </div>
                    {costOpen && costBreakdownRows(false)}
                  </div>
                  <div className={`ready-banner ${walletReady ? "ok" : "warn"}`}>
                    <span className="grow">
                      {walletReady
                        ? `✓ Wallet ready: ${microToDisplay(balanceOf(chain.denom) ?? "0")} ${denomLabel} covers the ${depositActStr} deposit.`
                        : wallet
                          ? `This launch needs ${depositActStr} in deposits; you have ${
                              balances ? microToDisplay(balanceOf(chain.denom) ?? "0") : "?"
                            }.`
                          : "Connect your Keplr wallet on the Wallet step first."}
                    </span>
                    {!walletReady && (
                      <button className="btn amber" style={{ flex: "none" }} onClick={() => setWizStep(0)}>
                        {wallet ? "Go mint ACT" : "Go to Wallet"}
                      </button>
                    )}
                  </div>
                  {assetsBanner()}
                  {specIssueList(true)}
                  <div className="wiz-nav">
                    <button className="btn" onClick={() => setWizStep(1)}>
                      ← Back
                    </button>
                    <button
                      className="btn primary"
                      onClick={create}
                      disabled={launchDisabled}
                      title={launchDisabledWhy}
                    >
                      Launch {specName || "chain"} →
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* form / yaml modes */}
          {idle && viewMode !== "guided" && (
            <div className="card-body">
              <div className="editor-grid">
                <div>
                  {viewMode === "form" && (
                    <>
                      <div className="two-col">
                        <div>
                          <div className="f-label">Chain name</div>
                          <input
                            className="field"
                            value={specName}
                            onChange={(e) => setSpecName(e.target.value)}
                          />
                        </div>
                        <div>
                          <div className="f-label">Network type</div>
                          {typeSeg}
                        </div>
                        <div>
                          <div className="f-label">Validators</div>
                          {counter(specVals, "validators")}
                        </div>
                        <div>
                          <div className="f-label">Sentries</div>
                          {counter(specSents, "sentries")}
                        </div>
                        <div>
                          <div className="f-label">Validator size</div>
                          {sizeSeg("validator")}
                        </div>
                        <div>
                          <div className="f-label">Sentry size</div>
                          {sizeSeg("sentry")}
                        </div>
                        <div>
                          <div className="f-label">Provider selection</div>
                          {bidSeg}
                        </div>
                      </div>
                      {bidNote(specBidMode) && (
                        <div className="dim-note" style={{ marginTop: 10 }}>
                          {bidNote(specBidMode)}
                        </div>
                      )}
                      <div className="dim-note" style={{ marginTop: 12 }}>
                        Tokens, accounts and service images keep the spec's current values.
                        Switch to YAML for full control.
                      </div>
                    </>
                  )}
                  {viewMode === "yaml" && (
                    <>
                      {specTextarea(280)}
                      {/* a services fleet has no nodes to size or place */}
                      {!servicesDraft && specDoc && launchSettings}
                      <div className="spec-btns">
                        <label className="btn">
                          Import spec
                          <input
                            type="file"
                            accept=".yaml,.yml"
                            onChange={(e) => e.target.files?.[0] && importSpec(e.target.files[0])}
                          />
                        </label>
                        <button className="btn" onClick={exportSpec}>
                          Export spec
                        </button>
                        <button
                          className="btn"
                          onClick={() => {
                            if (
                              window.confirm(
                                "Replace the spec with the built-in example? Your edits will be lost.",
                              )
                            ) {
                              updateSpec(EXAMPLE_SPEC);
                            }
                          }}
                        >
                          Reset to example
                        </button>
                      </div>
                    </>
                  )}
                  {assetsBanner()}
                  {specIssueList(viewMode !== "yaml")}
                </div>
                {editorRail}
              </div>
            </div>
          )}

          {/* launch progress (live) and the completed-launch step log */}
          {(launching || (launched && logOpen)) && (
            <div className="card-body">
              {launching && (
                <div className="progress-track">
                  <i style={{ width: `${launchPct}%` }} />
                </div>
              )}
              <div className="launch-rows">
                {stepsExpanded && hiddenSteps > 0 && (
                  <button
                    className="launch-row done summary"
                    title="Collapse the earlier steps"
                    onClick={() => setStepsExpanded(false)}
                  >
                    <span className="mark">✓</span>
                    <span className="lbl">hide {stepCount(hiddenSteps)}</span>
                    <span className="op">hide ▴</span>
                  </button>
                )}
                {stepsExpanded
                  ? allSteps.map(stepRow)
                  : stepPlan.map((g, i) => {
                      if (g.kind === "step") return stepRow(g.step);
                      return (
                        <button
                          key={`gap-${i}`}
                          className="launch-row done summary"
                          title="Show these steps"
                          onClick={() => setStepsExpanded(true)}
                        >
                          <span className="mark">✓</span>
                          <span className="lbl">{stepCount(g.steps.length)}</span>
                          <span className="op">show ▾</span>
                        </button>
                      );
                    })}
              </div>
            </div>
          )}

          {/* banners follow the card in every state */}
          {(pending ||
            pendingGentx ||
            waitingStep ||
            failedStep ||
            launch?.status === "aborted" ||
            launch?.status === "paused") && (
            <div className="card-body" style={{ paddingTop: launching || launched ? 0 : undefined }}>
              {launchBanners}
            </div>
          )}

          {/* server-side extras only (e.g. the launcher-on-Akash notice) — the
              shared validateSpec warnings already show live above */}
          {warnings.filter(
            (w) => !specCheck.warnings.some((l) => l.path === w.path && l.message === w.message),
          ).length > 0 && (
            <ul className="issues">
              {warnings
                .filter(
                  (w) =>
                    !specCheck.warnings.some((l) => l.path === w.path && l.message === w.message),
                )
                .map((w) => (
                  <li key={w.path} className="warn">
                    ⚠ {w.path}: {w.message}
                  </li>
                ))}
            </ul>
          )}
        </section>

        {/* ---------- empty fleet placeholder ---------- */}
        {wallet && (!fleet || fleet.fleets.length === 0) && (
          <div className="placeholder">
            {launch ? (
              // a gentx signer connects its operator account, which owns no
              // deployments of its own: the panel above stays (it holds the
              // signing banner), but the cards down here belong to the
              // deploy account and only come back with it
              <>
                This account owns no deployments. The launch above belongs to the deploy
                account: select that account in Keplr to see its fleet cards again.
              </>
            ) : (
              <>
                {specDoc?.kind === "services"
                  ? "Your services fleet appears here once its components are live."
                  : "Your fleet appears here once the chain is live: validator, sentry, headscale, explorer and frontend."}
              </>
            )}
          </div>
        )}

        {/* ---------- fleet + accounts cards, one pair per launch ---------- */}
        {(fleet?.fleets ?? []).map((f) => {
          // a launch still placing (a re-place closed the old deployment and
          // the new one is not leased yet) is not shut down: its bid picks
          // render in this card
          const shutDown =
            f.components.length > 0 &&
            f.components.every((c) => c.state === "closed") &&
            f.bidPicks.length === 0 &&
            !["running", "paused"].includes(f.launchStatus);
          const collapsed = shutDown && !showClosedFleet[f.launchId];
          // delete is offered on shut-down fleets (collapsed or not) and on
          // stale records that never placed anything (failed/aborted attempts,
          // and drafts). "created" is normally transient — the new-launch flow
          // creates then immediately starts — but a start that never happens
          // (closed tab, failed call) strands the launch in it forever, and
          // withholding the button there left an empty fleet card with no way
          // to dismiss it. Placing anything moves the launch off "created", so
          // this only ever offers delete on a draft that owns no deployments;
          // a driving launch ("running") still gets no button, and the server
          // 409s a delete raced against the driver.
          const deletable =
            shutDown ||
            (f.components.length === 0 &&
              (f.launchStatus === "aborted" ||
                f.launchStatus === "paused" ||
                f.launchStatus === "created"));
          const active = f.components.filter((c) => c.state === "active");
          // a services fleet has no chain: only component actions apply
          const chainFleet = f.kind !== "services";
          const unhealthy = active.filter((c) => healthKind(c) !== "ok");
          const monthly = fleetMonthlyUsd(f.components);
          const prefs = providerPrefs[f.launchId];
          const actsOpen = fleetActsOpen[f.launchId] ?? false;
          const bodyOpen = fleetBodyOpen[f.launchId] ?? true;
          const deleteFleet = async () => {
            const ok = window.confirm(
              `Delete launch ${f.launchId.slice(0, 8)} (${f.chainId}) permanently?\n\n` +
                "This erases its records AND secrets (account mnemonics, validator keys) " +
                "from the launcher." +
                (f.components.length > 0
                  ? " Export the fleet bundle first if you want an archive."
                  : ""),
            );
            if (!ok) return;
            try {
              const { deleteLaunch } = await import("../lib/api");
              await deleteLaunch(f.launchId);
              if (launchId === f.launchId) forgetLaunch();
              setFleet((cur) =>
                cur
                  ? { ...cur, fleets: cur.fleets.filter((x) => x.launchId !== f.launchId) }
                  : cur,
              );
            } catch (e) {
              setError(String(e));
            }
          };
          const viewing = f.launchId === launchId;
          return (
            <Fragment key={f.launchId}>
              <section className={`card${viewing ? " viewing" : ""}`}>
                <div
                  className="card-head row-gap clickable"
                  title={
                    viewing
                      ? "show / hide the fleet components"
                      : "open this fleet's launch in the Launch panel at the top"
                  }
                  onClick={() => {
                    // first click selects the fleet (same as the old "view
                    // launch" button); expand/collapse only once selected
                    if (!viewing) {
                      openLaunch(f.launchId);
                      return;
                    }
                    if (shutDown) {
                      setShowClosedFleet((m) => ({ ...m, [f.launchId]: !m[f.launchId] }));
                    } else {
                      setFleetBodyOpen((m) => ({ ...m, [f.launchId]: !bodyOpen }));
                    }
                  }}
                >
                  <div className="card-title">Fleet</div>
                  {f.name && <span className="tag name">{f.name}</span>}
                  <span className="tag">{f.chainId}</span>
                  {viewing && (
                    <span
                      className="tag viewing-chip"
                      title="This fleet's launch is open in the Launch panel at the top of the page"
                    >
                      ▲ in Launch panel
                    </span>
                  )}
                  {shutDown ? (
                    <span className="dim-note">shut down · record kept</span>
                  ) : (
                    <span
                      style={{
                        fontSize: 12,
                        color: unhealthy.length === 0 ? "var(--ok)" : "var(--amber-text)",
                      }}
                    >
                      {active.length} component{active.length === 1 ? "" : "s"} ·{" "}
                      {unhealthy.length === 0
                        ? "all healthy"
                        : `${unhealthy.length} need${unhealthy.length === 1 ? "s" : ""} attention`}
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {monthly !== null && monthly > 0 && (
                      <span className="mono-dim" style={{ color: "var(--dim)", fontSize: 12 }}>
                        ${monthly.toFixed(2)}/mo
                      </span>
                    )}
                    <button
                      // always visible, even on a collapsed shut-down card
                      // (keeps the header height constant); toggles only the
                      // actions row
                      className="btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFleetActsOpen((m) => ({ ...m, [f.launchId]: !actsOpen }));
                      }}
                    >
                      Fleet actions {actsOpen ? "▴" : "▾"}
                    </button>
                    <span style={{ color: "var(--dim2)", fontSize: 13 }}>
                      {collapsed || !bodyOpen ? "▾" : "▴"}
                    </span>
                  </span>
                </div>

                {actsOpen && (
                  <div className="fleet-acts">
                    {/* actions grouped by intent; the danger zone is set apart on the right */}
                    <div className="act-grid">
                      <div className="act-groups">
                        <div className="act-group">
                          <div className="act-label">Upgrade</div>
                          <div className="act-btns">
                            {!shutDown && (
                              <>
                                {chainFleet && (
                                  <button
                                    className="btn"
                                    onClick={() => {
                                      const feeNote =
                                        fee && fee.upgradeFlat > 0
                                          ? ` A ${microToDisplay(String(fee.upgradeFlat))} ${denomLabel} service fee is added per upgrade (signed together).`
                                          : "";
                                      // node fleet only — prefill with a current node image so
                                      // the expected ns/repo:tag format is obvious
                                      const nodes = f.components.filter(
                                        (c) => c.state === "active" && /^(val|sentry)-/.test(c.key),
                                      );
                                      const node = nodes[0];
                                      const image = window.prompt(
                                        `New sparkdreamd image for validators + sentries:${feeNote}`,
                                        node?.image ?? undefined,
                                      );
                                      // skip only when the whole node fleet already runs the
                                      // image — after an aborted mid-upgrade the fleet is mixed
                                      // and re-running with the same tag is the retry path
                                      if (image && node && nodes.some((c) => c.image !== image))
                                        fleetAction(f.launchId, node.dseq, "upgrade", { image });
                                    }}
                                  >
                                    rolling upgrade…
                                  </button>
                                )}
                              </>
                            )}
                            {!shutDown && (
                              <>
                                {chainFleet && (
                                  <button
                                    className="btn"
                                    onClick={async () => {
                                      const feeNote =
                                        fee && fee.upgradeFlat > 0
                                          ? ` A ${microToDisplay(String(fee.upgradeFlat))} ${denomLabel} service fee is added per upgrade (signed together).`
                                          : "";
                                      // prefill with a current node image, as the rolling
                                      // prompt does: the expected ns/repo:tag shape is
                                      // then obvious, and a tag typed from memory cannot
                                      // quietly disagree with what the fleet runs
                                      const nodes = f.components.filter(
                                        (c) => c.state === "active" && /^(val|sentry)-/.test(c.key),
                                      );
                                      const image = window.prompt(
                                        `New image for a coordinated (consensus-breaking) upgrade:${feeNote}`,
                                        nodes[0]?.image ?? undefined,
                                      );
                                      // an unedited prefill on a fleet already running it
                                      // would halt consensus to install what is installed;
                                      // a mixed fleet is the aborted-upgrade retry path
                                      if (!image || !nodes.some((c) => c.image !== image)) return;
                                      const h = window.prompt("Halt height:");
                                      const first = f.components.find(
                                        (c) => c.state === "active" && c.key !== "headscale",
                                      );
                                      if (h && first) {
                                        const { postFleetAction: post } = await import("../lib/api");
                                        await post(f.launchId, first.dseq, "halt-upgrade", {
                                          image,
                                          haltHeight: Number(h),
                                        }).catch((e) => setError(String(e)));
                                        openLaunch(f.launchId);
                                      }
                                    }}
                                  >
                                    halt-height upgrade…
                                  </button>
                                )}
                              </>
                            )}
                            {chainFleet && !shutDown && active.length > 0 && (
                              <button
                                className="btn"
                                title="Set halt-height back to 0 on every chain node. Recovery for a halt-height upgrade abandoned before it cleared the setting itself: until it is cleared, a node that stopped at the halt height halts again on every restart, and nothing else in the launcher edits it. Nothing is started — restart a halted node to resume on its current image, or run an upgrade to bring it back on a new one."
                                onClick={() => fleetAction(f.launchId, active[0]!.dseq, "clear-halt-height")}
                              >
                                clear halt height
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="act-group">
                          <div className="act-label">Configure</div>
                          <div className="act-btns">
                            {!shutDown && (
                              <>
                                {(() => {
                                  const addable = COMPONENT_KEYS.filter(
                                    (k) =>
                                      // a services fleet runs chain-independent kinds only
                                      (chainFleet || SERVICES_FLEET_COMPONENTS.includes(k)) &&
                                      !f.components.some((c) => c.key === k && c.state !== "closed"),
                                  );
                                  // a chain fleet can also grow a sentry: a node, not a service
                                  // kind (its own add-sentry op), offered in the same picker
                                  const sentryAddable = chainFleet && !shutDown && active.length > 0;
                                  const choices: string[] = [...addable, ...(sentryAddable ? ["sentry"] : [])];
                                  if (choices.length === 0) return null;
                                  return (
                                    <button
                                      className="btn accent-ghost"
                                      title={`Add to this fleet: ${[
                                        ...addable.map((k) => COMPONENT_KINDS[k].label),
                                        ...(sentryAddable
                                          ? ["a sentry (another node on its own provider, so losing one no longer cuts the validator off)"]
                                          : []),
                                      ].join(", ")}`}
                                      onClick={() => openAddDialog(f.launchId, f.name, monthly)}
                                    >
                                      + add component…
                                    </button>
                                  );
                                })()}
                              </>
                            )}
                            {!shutDown && (
                              <>
                                <button
                                  className="btn"
                                  title="Apply the domains from the spec editor to this fleet: one deployment-update signature, then repoint DNS"
                                  onClick={async () => {
                                    try {
                                      // the spec editor is the source of truth: diff its
                                      // domains against the fleet's stored spec and apply
                                      const edited = yaml.load(specText) as any;
                                      const ec = edited?.topology?.components ?? {};
                                      const ep = edited?.topology?.publicEndpoints ?? {};
                                      const cur = (await getLaunch(f.launchId)).spec as any;
                                      const cc = cur?.topology?.components ?? {};
                                      const cp = cur?.topology?.publicEndpoints ?? {};
                                      const changes: Record<string, string> = {};
                                      if (ec.explorer?.domain && ec.explorer.domain !== cc.explorer?.domain)
                                        changes.explorer = ec.explorer.domain;
                                      if (ec.explorer?.route && ec.explorer.route !== cc.explorer?.route)
                                        changes.explorerRoute = ec.explorer.route;
                                      if (ec.frontend?.domain && ec.frontend.domain !== cc.frontend?.domain)
                                        changes.frontend = ec.frontend.domain;
                                      if (ep?.api && ep.api !== cp?.api) changes.api = ep.api;
                                      if (ep?.rpc && ep.rpc !== cp?.rpc) changes.rpc = ep.rpc;
                                      if (Object.keys(changes).length === 0) {
                                        setError(
                                          "no domain changes: the spec editor's domains match this fleet, edit the spec first",
                                        );
                                        return;
                                      }
                                      const { postDomainUpdate } = await import("../lib/api");
                                      await postDomainUpdate(f.launchId, changes);
                                      openLaunch(f.launchId); // surfaces the signing banner
                                    } catch (e) {
                                      setError(String(e));
                                    }
                                  }}
                                >
                                  update domains…
                                </button>
                              </>
                            )}
                            {chainFleet && !shutDown && active.length > 0 && f.minGasPrice !== undefined && (
                              <button
                                className={`btn${f.gasPriceProblem ? " amber" : ""}`}
                                title={`The minimum gas price every node accepts, per gas unit in ${f.gasDenom ?? "the base denom"} (now ${f.minGasPrice}). Sets it in the fleet's spec, the bundles a relaunch boots from, and each live node's app.toml; only nodes whose value changes restart, sentries first. Node config, not consensus: no reset or upgrade.`}
                                onClick={async () => {
                                  const input = window.prompt(
                                    `Minimum gas price for ${f.chainId}, per gas unit in ${f.gasDenom ?? "the base denom"} ` +
                                      `(now ${f.minGasPrice}; typically 0.025, or 0 on a devnet). A fee for a 200,000-gas ` +
                                      "transaction is this times 200,000.",
                                    f.gasPriceProblem ? "0.025" : f.minGasPrice,
                                  );
                                  if (input === null || input.trim() === f.minGasPrice) return;
                                  try {
                                    const { postGasPrice } = await import("../lib/api");
                                    await postGasPrice(f.launchId, input.trim());
                                    showToast(`setting the minimum gas price to ${input.trim()}: follow it in the Launch panel`);
                                    openLaunch(f.launchId);
                                  } catch (e) {
                                    setError(String(e));
                                  }
                                }}
                              >
                                gas price…
                              </button>
                            )}
                            {chainFleet && (
                              <button
                                className="btn"
                                title="For a Mastodon first set up in this chain fleet: draft a services fleet (no chain: shared components several chains use) in the editor, carrying this fleet's Mastodon settings (owner, SMTP, size, providers) under the domain you choose. The SMTP password is copied from this fleet's secret store when you launch it. Starting fresh? Use New services fleet… on the launch card. Each chain then links the instance with a standalone bridge."
                                onClick={() => void servicesSpecFromFleet(f)}
                              >
                                services spec…
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="act-group">
                          <div className="act-label">Maintain</div>
                          <div className="act-btns">
                            {chainFleet && !shutDown && active.length > 0 && (
                              <button
                                className="btn"
                                title="Reconcile this fleet against reality and fix what has drifted, in place. Today: corrects the launcher's own records — where each component answers SSH (re-read from its provider) and its live mesh address (asked of the component) — so containers recycled outside the launcher don't leave it out of step, then fixes anything dialling an old address — stale tunnel env is rewritten and re-pushed to its deployment, stale persistent_peers are edited on the node, and every node's minimum gas price is brought back to the spec's. Only what is actually broken is touched, and only those components restart. No redeploy, no data moves. Free to run on a healthy fleet."
                                onClick={() => fleetAction(f.launchId, active[0]!.dseq, "repair")}
                              >
                                repair fleet
                              </button>
                            )}
                            {chainFleet && !shutDown && f.dataBackups && f.meshBackup && (
                              <button
                                className="btn"
                                title="Back up the chain data to the mesh backup's bucket, schedule it, and choose whether relaunched nodes restore from it."
                                onClick={() => setChainBackupsFor(f.launchId)}
                              >
                                chain backups…
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="act-group">
                          <div className="act-label">Share &amp; export</div>
                          <div className="act-btns">
                            {!shutDown && (
                              <button
                                className="btn"
                                title={
                                  chainFleet
                                    ? "Other Akash wallets on this launcher whose relayers may relay to this chain (your devnet and testnet wallets, say): content federation and transfers between sister chains. This fleet's own wallet always may. Removing a wallet stops new links; relayers already linked keep running."
                                    : "Other Akash wallets on this launcher whose chain fleets may link a standalone bridge to this fleet's Mastodon (your devnet and testnet wallets, say). This fleet's own wallet always may. Removing a wallet stops new links; bridges already linked keep running."
                                }
                                onClick={async () => {
                                  try {
                                    const current: string[] = ((await getLaunch(f.launchId)).spec as any)?.sharing?.wallets ?? [];
                                    const input = window.prompt(
                                      `Wallets this ${chainFleet ? "chain" : "services"} fleet is shared with (comma separated; empty for none):`,
                                      current.join(", "),
                                    );
                                    if (input === null) return;
                                    const { postFleetSharing } = await import("../lib/api");
                                    const r = await postFleetSharing(
                                      f.launchId,
                                      input.split(/[,\s]+/).map((w) => w.trim()).filter(Boolean),
                                    );
                                    showToast(r.wallets.length ? `shared with ${r.wallets.length} wallet(s)` : "no longer shared");
                                  } catch (e) {
                                    setError(String(e));
                                  }
                                }}
                              >
                                share…
                              </button>
                            )}
                            <button
                              className="btn"
                              onClick={async () => {
                                const { downloadFleetBundle } = await import("../lib/api");
                                await downloadFleetBundle(f.launchId).catch((e) => setError(String(e)));
                              }}
                            >
                              export fleet bundle
                            </button>
                            {chainFleet && (
                              <button
                                className="btn"
                                onClick={async () => {
                                  const { downloadGenesis } = await import("../lib/api");
                                  await downloadGenesis(f.launchId, f.chainId).catch((e) =>
                                    setError(String(e)),
                                  );
                                }}
                              >
                                download genesis
                              </button>
                            )}
                            {chainFleet && (
                              <button
                                className="btn"
                                title="Public join document for third-party operators (genesis sha256, sentry peer strings, state-sync RPCs); they paste it into their own launcher's spec join block"
                                onClick={async () => {
                                  const { downloadJoinBundle } = await import("../lib/api");
                                  await downloadJoinBundle(f.launchId, f.chainId).catch((e) =>
                                    setError(String(e)),
                                  );
                                }}
                              >
                                join bundle
                              </button>
                            )}
                            {chainFleet && (
                              <button
                                className="btn"
                                title="Add another sovereign validator/sentry pair to this chain: writes a join spec into the editor, built from this fleet's own spec (its resources, providers and key mode) plus the live join bundle. What it cannot carry over, it says in the notes."
                                onClick={() => void joinSpecFromFleet(f)}
                              >
                                join spec
                              </button>
                            )}
                            {!shutDown && (
                              <>
                                <button
                                  className="btn"
                                  title="Copy this fleet's live spec into the spec editor, replacing the draft there. The starting point for a chain reset that changes accounts, chainParams or token: edited from the fleet's own spec, those edits are carried into the reset instead of being ignored."
                                  onClick={async () => {
                                    try {
                                      const live = (await getLaunch(f.launchId)).spec;
                                      if (
                                        specText.trim() &&
                                        !window.confirm(
                                          `Replace the spec editor with ${f.chainId}'s live spec? Your current draft there is lost.`,
                                        )
                                      )
                                        return;
                                      updateSpec(yaml.dump(live, { lineWidth: 100, noRefs: true }));
                                      setAdvOpen(true);
                                    } catch (e) {
                                      setError(String(e));
                                    }
                                  }}
                                >
                                  load spec into editor
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="act-group danger">
                        <div className="act-label">Danger zone</div>
                        <div className="act-btns">
                          {!shutDown && (
                            <>
                              {chainFleet && (
                                <button
                                  className="btn amber"
                                  title="Wipe all chain state and restart from a genesis rebuilt from this fleet's own spec: accounts and members are re-seeded (fresh mnemonics!), deployments and the chain-id stay. The op pauses after the wipe for you to clear every signer's watermark before the chain restarts. Prompts for the node image; edit accounts, chainParams or token in the spec editor first to change those too."
                                  onClick={async () => {
                                    try {
                                      // the fleet's own spec is the baseline, so the
                                      // reset never has to be reconciled by hand with
                                      // whatever draft the spec editor happens to hold
                                      const live = (await getLaunch(f.launchId)).spec as LaunchSpec;
                                      const { spec, fromEditor } = resetSource(specText, live);
                                      const image = window.prompt(
                                        "sparkdreamd image for the reset chain (the fleet restarts on it):",
                                        spec.images.sparkdreamd,
                                      );
                                      if (image === null) return;
                                      if (image.trim()) spec.images.sparkdreamd = image.trim();
                                      const ok = window.confirm(
                                        `Reset the chain? ALL on-chain state is wiped and the fleet restarts from a new genesis, still as ${f.chainId}, built from ` +
                                          (fromEditor
                                            ? "your edited spec in the spec editor"
                                            : "this fleet's own current spec") +
                                          `. The account keyring is rebuilt: generated accounts get FRESH mnemonics. Export the fleet bundle first if you need the old ones. The op then waits for you to clear every signer's watermark (tmkms state, and any validator outside this fleet) before the chain restarts at height 1. Node image: ${spec.images.sparkdreamd}.`,
                                      );
                                      if (!ok) return;
                                      const { postChainReset } = await import("../lib/api");
                                      await postChainReset(f.launchId, spec);
                                      openLaunch(f.launchId); // surfaces the signing banner
                                    } catch (e) {
                                      setError(String(e));
                                    }
                                  }}
                                >
                                  reset chain…
                                </button>
                              )}
                            </>
                          )}
                          {!shutDown && (
                            <>
                              <button
                                className="btn red"
                                onClick={async () => {
                                  const activeKeys = active.map((c) => c.key);
                                  const ok = window.confirm(
                                    `Shut down the whole fleet? This closes ${activeKeys.length} deployment${activeKeys.length === 1 ? "" : "s"} (${activeKeys.join(", ")}). The chain STOPS and escrow is refunded. One signature.`,
                                  );
                                  if (!ok) return;
                                  const { postFleetShutdown } = await import("../lib/api");
                                  try {
                                    await postFleetShutdown(f.launchId);
                                    openLaunch(f.launchId); // surfaces the signing banner
                                  } catch (e) {
                                    setError(String(e));
                                  }
                                }}
                              >
                                shut down fleet…
                              </button>
                            </>
                          )}
                          {deletable && (
                            <button
                              className="btn red"
                              title="Permanently delete this launch's records and secrets (account mnemonics, validator keys) from the launcher"
                              onClick={() => deleteFleet()}
                            >
                              delete…
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                    {f.ops
                      .filter((o) => o.status === "active")
                      .map((o) => (
                        <span key={o.id} className={o.progress ? "op-active measured" : "op-active"}>
                          {o.progress ? (
                            <span className="op-progress" title={progressTitle(o.progress)}>
                              <span className="op-progress-text">
                                {o.progress.label} <span className="mono">{progressText(o.progress)}</span>
                              </span>
                              {/* no target height (archives that do not name
                                  their range): the bar would be a lie, so the
                                  height alone stands in for it */}
                              {o.progress.percent !== undefined && (
                                <span className="op-bar">
                                  <span
                                    className="op-bar-fill"
                                    style={{ width: `${o.progress.percent}%` }}
                                  />
                                </span>
                              )}
                            </span>
                          ) : (
                            <>{o.kind} in progress…</>
                          )}
                          <button
                            className="btn"
                            title="Abandon this operation (e.g. if it's stuck on a broken provider). Closes its new deployment; the component can then be relaunched."
                            onClick={async () => {
                              if (
                                !window.confirm(
                                  `Abandon the in-progress ${o.kind}? Its new deployment is closed (escrow refunded) and you can relaunch fresh.`,
                                )
                              )
                                return;
                              const { postAbortOp } = await import("../lib/api");
                              try {
                                const r = await postAbortOp(f.launchId, o.id);
                                if (r.warning) setError(`Abandoned, but: ${r.warning}`);
                                if (r.step) openLaunch(f.launchId); // sign the close
                              } catch (e) {
                                setError(String(e));
                              }
                            }}
                          >
                            abort
                          </button>
                        </span>
                      ))}
                    {!shutDown &&
                      f.incidents
                        .filter((i) => i.closedAt === null)
                        .map((i) => {
                          const comp = f.components.find((c) => c.key === i.component);
                          const label: Record<string, string> = {
                            relaunch: "relaunch",
                            "force-redeploy": "force redeploy",
                            restart: "restart",
                            unjail: "unjail",
                            topup: "top up",
                            repair: "repair fleet",
                          };
                          return (
                            <span
                              key={`inc-${i.id}`}
                              className="dim-note"
                              style={{ flexBasis: "100%", color: "var(--red-text)" }}
                              title={i.detail ?? undefined}
                            >
                              {i.component} down since {new Date(i.openedAt).toLocaleString()}: {i.cause}.{" "}
                              {i.action && comp && comp.state !== "closed" && (
                                <button
                                  className="btn amber"
                                  onClick={() => {
                                    if (i.action === "topup") {
                                      const amount = window.prompt("Top-up amount (uact):", "5000000");
                                      if (amount) fleetAction(f.launchId, comp.dseq, "topup", { amount });
                                    } else if (i.action) {
                                      fleetAction(f.launchId, comp.dseq, i.action);
                                    }
                                  }}
                                >
                                  {label[i.action] ?? i.action}
                                </button>
                              )}
                            </span>
                          );
                        })}
                    {/* collapsed settings and history, side by side */}
                    {((chainFleet && !shutDown) ||
                      (!shutDown && f.incidents.some((i) => i.closedAt !== null)) ||
                      (prefs && (prefs.avoid.length > 0 || prefs.prefer.length > 0))) && (
                    <div style={{ flexBasis: "100%", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-start" }}>
                    {chainFleet && !shutDown && (
                      <details className="dim-note pill">
                        <summary
                          title="Recover a component on its own once an outage is confirmed: relaunch it off a dead provider, re-create a dead container, or restart a stuck node. Its transactions are signed with your wallet's unattended-recovery grant (System panel), else they wait for Keplr."
                        >
                          Auto-recovery <b style={{ color: f.autoRecover.enabled ? "var(--ok)" : undefined }}>{f.autoRecover.enabled ? "On" : "Off"}</b>
                        </summary>
                        <div style={{ display: "grid", gap: 2, padding: "4px 0" }}>
                          {(
                            [
                              ["enabled", "recover automatically"],
                              ["validators", "validators"],
                              ["sentries", "sentries"],
                              ["headscale", "headscale (only with its mesh backup)"],
                              ["services", "explorer, frontend and other services"],
                            ] as const
                          ).map(([k, label]) => (
                            <label key={k} style={{ marginLeft: k === "enabled" ? 0 : 16 }}>
                              <input
                                type="checkbox"
                                checked={f.autoRecover[k]}
                                disabled={k !== "enabled" && !f.autoRecover.enabled}
                                onChange={async (e) => {
                                  // read before any await: React puts a controlled
                                  // checkbox back to its old state once the handler yields
                                  const on = e.target.checked;
                                  setFleet((prev) =>
                                    prev && {
                                      ...prev,
                                      fleets: prev.fleets.map((x) =>
                                        x.launchId === f.launchId ? { ...x, autoRecover: { ...x.autoRecover, [k]: on } } : x,
                                      ),
                                    },
                                  );
                                  try {
                                    const { saveAutoRecover, getFleet } = await import("../lib/api");
                                    await saveAutoRecover(f.launchId, { [k]: on });
                                    if (wallet) setFleet(await getFleet(wallet.address));
                                  } catch (err) {
                                    setError(String(err));
                                    if (wallet) void getFleet(wallet.address).then(setFleet, () => undefined);
                                  }
                                }}
                              />{" "}
                              {label}
                            </label>
                          ))}
                        </div>
                      </details>
                    )}
                    {!shutDown && f.incidents.some((i) => i.closedAt !== null) && (
                      <details className="dim-note pill">
                        <summary>Recent outages</summary>
                        {f.incidents
                          .filter((i) => i.closedAt !== null)
                          .map((i) => (
                            <div key={`past-${i.id}`}>
                              {i.component}: {new Date(i.openedAt).toLocaleString()} to{" "}
                              {new Date(i.closedAt!).toLocaleTimeString()}, {i.cause}
                            </div>
                          ))}
                      </details>
                    )}
                    {prefs && (prefs.avoid.length > 0 || prefs.prefer.length > 0) && (
                      <details className="dim-note pill">
                        <summary title="Providers to prefer or avoid when placing and moving components. These lists apply to every launch on this wallet.">
                          Relaunch policy{" "}
                          <b>
                            {prefs.prefer.length + prefs.avoid.length} rule{prefs.prefer.length + prefs.avoid.length === 1 ? "" : "s"}
                          </b>
                        </summary>
                        <span className="pref-summary" style={{ padding: "4px 0" }}>
                        {prefs.prefer.map((p) => (
                          <button
                            key={p}
                            className="pref-tag prefer"
                            title={`${p} (click to remove)`}
                            onClick={() => cycleProviderPref(f.launchId, p, "prefer")}
                          >
                            ⭐ {prefs.names[p] ?? `${p.slice(0, 14)}…`} ✕
                          </button>
                        ))}
                        {prefs.avoid.map((p) => (
                          <button
                            key={p}
                            className="pref-tag avoid"
                            title={`${p} (click to remove)`}
                            onClick={() =>
                              // avoid → prefer → none needs two clicks; jump straight to none
                              import("../lib/api").then(({ setProviderPref }) =>
                                setProviderPref(f.launchId, p, "none")
                                  .then((next) =>
                                    setProviderPrefs((m) => ({ ...m, [f.launchId]: next })),
                                  )
                                  .catch((e) => setError(String(e))),
                              )
                            }
                          >
                            ⛔ {prefs.names[p] ?? `${p.slice(0, 14)}…`} ✕
                          </button>
                        ))}
                      </span>
                      </details>
                    )}
                    </div>
                    )}
                    {f.gasPriceProblem && !shutDown && (
                      <span className="dim-note" style={{ flexBasis: "100%", color: "var(--amber-text)" }}>
                        Minimum gas price {f.minGasPrice} {f.gasDenom}: {f.gasPriceProblem}. Fix it with gas price….
                      </span>
                    )}
                    {chainFleet && !shutDown && (f.dataBackups?.scratchSync || (f.dataBackups?.latestAgeDays ?? 0) > 7) && (
                      <span className="dim-note" style={{ flexBasis: "100%", color: "var(--amber-text)" }}>
                        {f.dataBackups!.scratchSync
                          ? `No chain-data backup (${f.dataBackups!.scratchSync.reason}): a node this fleet moves, resizes or adds ` +
                            `replays all ~${f.dataBackups!.scratchSync.blocks.toLocaleString("en-US")} blocks, about ` +
                            `${hoursText(f.dataBackups!.scratchSync.hours)}. `
                          : `The latest chain-data backup is ${f.dataBackups!.latestAgeDays} days old: a node moved now replays everything since. `}
                        {f.meshBackup ? (
                          <button className="btn" style={{ padding: "0 8px" }} onClick={() => setChainBackupsFor(f.launchId)}>
                            chain backups…
                          </button>
                        ) : (
                          "Turn on the mesh backup first (chain data goes to the same bucket)."
                        )}
                      </span>
                    )}
                  </div>
                )}

                {/* manual bid selection: a placement parked for a pick offers
                    every bid it drew; the pick is leased as-is, so bids the
                    policy rejected stay choosable (that is the point —
                    reaching a provider auto-selection passes over). A
                    relaunch op carries its offers on the op, a re-place made
                    by the launch itself on the launch. */}
                {!collapsed &&
                  [
                    ...f.ops
                      .filter(
                        (o) => o.status === "active" && o.params.offeredBids && !o.params.bidChoice,
                      )
                      .map((o) => ({
                        id: `op-${o.id}`,
                        key: o.params.key ?? "component",
                        dseq: o.params.offeredBids!.dseq,
                        bids: o.params.offeredBids!.bids,
                        reason: o.params.offeredBids!.reason,
                        target: { opId: o.id } as { opId: number } | { key: string },
                        retry:
                          o.kind === "node-resize"
                            ? "abandon the operation and resize again for a fresh set"
                            : "abandon the operation and relaunch for a fresh set",
                      })),
                    ...f.bidPicks.map((p) => ({
                      id: `launch-${p.key}`,
                      key: p.key,
                      dseq: p.dseq,
                      bids: p.bids,
                      reason: undefined as string | undefined,
                      target: { key: p.key } as { opId: number } | { key: string },
                      retry: "resume the launch to draw a fresh set",
                    })),
                  ].map((o) => (
                      <div key={`bid-pick-${o.id}`} className="bid-pick">
                        <div className="bid-pick-head">
                          <b>{o.key}</b>: pick the bid to lease (deployment {o.dseq})
                          <span className="dim-note">
                            {" "}
                            Bids close a few minutes after they arrive. If the lease then fails,{" "}
                            {o.retry}.
                          </span>
                        </div>
                        {o.reason && (
                          <div className="bid-row">
                            <span className="bid-host">
                              {o.key}: {o.reason}. Lease the selection policy's pick, or a bid of
                              your own below.
                            </span>
                            {(() => {
                              const auto = o.bids.find((b) => b.autoPick);
                              return (
                                <button
                                  className="btn amber"
                                  disabled={!auto}
                                  title={
                                    auto
                                      ? "Lease the bid the selection policy picks (price, uptime, audit and anti-affinity rules)."
                                      : "The selection policy accepts none of these bids: pick one below."
                                  }
                                  onClick={() => void chooseBid(f.launchId, o.target, "auto")}
                                >
                                  {auto ? `auto-lease (${auto.hostUri.replace(/^https?:\/\//, "")})` : "auto-lease (none accepted)"}
                                </button>
                              );
                            })()}
                          </div>
                        )}
                        {o.bids.length === 0 && (
                          <div className="dim-note">
                            No usable bids (bidders missing from the provider list cannot be
                            leased). Try again for a fresh set.
                          </div>
                        )}
                        {o.bids.map((b) => (
                          <div key={b.provider} className="bid-row">
                            <span className="bid-host" title={b.provider}>
                              {b.hostUri.replace(/^https?:\/\//, "")}
                            </span>
                            <span className="bid-price" title={`${b.price} ${b.priceDenom}/block`}>
                              {priceMonthly(b.price, b.priceDenom)}
                            </span>
                            <span className="bid-meta">
                              {b.audited ? "audited" : "unaudited"} · uptime{" "}
                              {(b.uptime7d * 100).toFixed(1)}%
                            </span>
                            <span className={`bid-verdict${b.rejected ? " off" : ""}`}>
                              {b.autoPick
                                ? "auto-selection would lease this"
                                : (b.rejected ?? "passes the policy")}
                            </span>
                            <button
                              className="btn amber"
                              onClick={() => {
                                // a rejected bid is leased as asked, but the
                                // reason can be a real blocker (no persistent
                                // storage class) rather than a preference
                                if (
                                  b.rejected &&
                                  !window.confirm(
                                    `The selection policy rejected this bid: ${b.rejected}\n\n` +
                                      "Lease it anyway?",
                                  )
                                )
                                  return;
                                void chooseBid(f.launchId, o.target, b.provider);
                              }}
                            >
                              lease this
                            </button>
                          </div>
                        ))}
                      </div>
                    ))}

                {!collapsed &&
                  bodyOpen &&
                  f.components.map((c) => {
                    const rowKey = `${f.launchId}:${c.dseq}`;
                    const open = openComponent === rowKey;
                    const kind = healthKind(c);
                    const days = runwayDays(c);
                    // a tag as it is; an image pinned by digest shows the digest shortened
                    const digest = c.image ? /@sha256:([0-9a-f]{64})$/.exec(c.image)?.[1] : undefined;
                    const version = digest ? `${digest.slice(0, 6)}…${digest.slice(-4)}` : c.image?.split(":").pop();
                    const pref = providerPrefOf(f.launchId, c.provider);
                    const height = liveHeights[c.dseq];
                    const disk = nodeDisks[c.dseq];
                    // a full volume stops the node: amber from 80%, red from 90%
                    const diskColor = !disk
                      ? undefined
                      : disk.percentUsed >= 90
                        ? "var(--red-text)"
                        : disk.percentUsed >= 80
                          ? "var(--amber-text)"
                          : undefined;
                    return (
                      <div key={rowKey} className="fleet-comp">
                        <div
                          className={`fleet-row${c.state === "closed" ? " closed" : ""}`}
                          onClick={() => setOpenComponent(open ? null : rowKey)}
                        >
                          <span className={`dot ${kind}`} />
                          <div>
                            <div className="name">{c.key}</div>
                            <div className="role">
                              {roleLabel(c.key)}
                              {version ? ` · ${version}` : ""}
                              {c.state !== "active" ? ` · ${c.state}` : ""}
                              {disk && c.state === "active" && (
                                <span
                                  style={diskColor ? { color: diskColor } : undefined}
                                  title={`chain data volume: ${gib(disk.freeBytes)} free of ${gib(disk.totalBytes)}`}
                                >
                                  {` · ${gib(disk.freeBytes)} free`}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="provider" title={c.provider}>
                            {c.providerName || c.provider}
                          </div>
                          <div className="runway">
                            {days !== null && c.state === "active" ? (
                              <>
                                <div className="meter">
                                  <i
                                    className={runwayClass(days) === "err" ? "red" : runwayClass(days) === "warn" ? "warn" : "ok"}
                                    style={{
                                      width: `${Math.min(100, Math.round((days / 90) * 100))}%`,
                                    }}
                                  />
                                </div>
                                <span className={`runway-days ${runwayClass(days)}`}>
                                  {days.toFixed(1)}d
                                </span>
                              </>
                            ) : (
                              <span className="runway-days off">—</span>
                            )}
                          </div>
                          <div className="price" title={`${c.price} ${c.priceDenom}/block`}>
                            {c.state === "active" ? priceMonthly(c.price, c.priceDenom) : "—"}
                          </div>
                          <span className="chev">{open ? "▴" : "▾"}</span>
                        </div>
                        {open && (
                          <div className="fleet-detail">
                            <div className="facts">
                              {/* dseq first: it is what every provider/chain
                                  lookup keys on when something goes wrong */}
                              <span className="f-dseq">
                                Lease dseq{" "}
                                <span
                                  className="v"
                                  title="click to copy"
                                  style={{ cursor: "pointer" }}
                                  onClick={() => void navigator.clipboard.writeText(c.dseq)}
                                >
                                  {c.dseq}
                                </span>
                              </span>
                              {c.image && (
                                <span className="f-wide f-image">
                                  Image{" "}
                                  <span className="v" title={c.image}>
                                    {shortImage(c.image)}{" "}
                                    <button className="copy" onClick={() => void navigator.clipboard.writeText(c.image!)}>
                                      copy
                                    </button>
                                  </span>
                                </span>
                              )}
                              {c.size && (
                                <span>
                                  Size <span className="v">{c.size}</span>
                                </span>
                              )}
                              {disk && (
                                <span title={`read ${new Date(disk.checkedAt).toLocaleTimeString()}`}>
                                  Chain data{" "}
                                  <span className="v" style={diskColor ? { color: diskColor } : undefined}>
                                    {gib(disk.freeBytes)} free of {gib(disk.totalBytes)} ({disk.percentUsed}% used)
                                  </span>
                                  {disk.percentUsed >= 80 && " · resize… to a larger size"}
                                </span>
                              )}
                              {c.tailnetIp && (
                                <span className="f-mesh">
                                  Mesh IP{" "}
                                  <span
                                    className="v"
                                    title="Address on the headscale mesh (click to copy). Peers reach this component here."
                                    style={{ cursor: "pointer" }}
                                    onClick={() =>
                                      void navigator.clipboard.writeText(c.tailnetIp!)
                                    }
                                  >
                                    {c.tailnetIp}
                                  </span>
                                </span>
                              )}
                              {c.escrow != null && (
                                <span className="f-escrow">
                                  Escrow left{" "}
                                  <span className="v">{balanceDisplay(c.escrow, c.priceDenom)}</span>
                                </span>
                              )}
                              {height && (
                                <span>
                                  Block height{" "}
                                  <span className="v">
                                    {height.height.toLocaleString()}
                                    {height.catchingUp ? " (syncing)" : ""}
                                  </span>
                                  {height.source === "chain" && (
                                    // the provider could not reach into the node:
                                    // this is the chain's latest commit, via a sentry
                                    <span className="dim-note">
                                      {" "}
                                      (chain, via sentry
                                      {height.signed === true
                                        ? ": signed the latest block"
                                        : height.signed === false
                                          ? ": NOT in the latest commit"
                                          : ""}
                                      )
                                    </span>
                                  )}
                                </span>
                              )}
                              {height?.source === "chain" && (
                                <span title={height.providerError}>
                                  Provider API{" "}
                                  <span className="v" style={{ color: "var(--amber-text)" }}>
                                    unreachable
                                  </span>
                                  <span className="dim-note"> (logs, shell, restart and upload wait on the provider)</span>
                                </span>
                              )}
                              {c.key === "headscale" && f.meshBackup !== undefined && (
                                <span className="f-wide">
                                  Mesh backup{" "}
                                  {f.meshBackup ? (
                                    <span className="v">
                                      {f.meshBackup.bucket}/{f.meshBackup.path}
                                      {!f.meshBackup.verified && (
                                        <span className="dim-note" style={{ color: "var(--amber-text)" }}>
                                          {" "}
                                          (not verified yet: not trusted for a restore)
                                        </span>
                                      )}
                                    </span>
                                  ) : (
                                    <span className="v" style={{ color: "var(--amber-text)" }}>
                                      none
                                      <span className="dim-note"> (a relaunch re-keys the whole mesh)</span>
                                    </span>
                                  )}
                                </span>
                              )}
                              {c.health && (
                                <span className="f-health">
                                  Health{" "}
                                  <span className="v">
                                    {c.health.status}
                                    {c.health.detail ? ` (${c.health.detail})` : ""}
                                  </span>
                                </span>
                              )}
                              <span className="f-wide f-provider">
                                Provider{" "}
                                <span className="v" title={c.provider}>
                                  {shortAddress(c.provider)}{" "}
                                  <button className="copy" onClick={() => void navigator.clipboard.writeText(c.provider)}>
                                    copy
                                  </button>
                                </span>
                                <button
                                  className={`pref-tag ${pref}`}
                                  title="Cycle this provider (wallet-wide): none → avoid → prefer. Relaunch avoids ⛔ and prefers ⭐ across all your launches."
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    cycleProviderPref(f.launchId, c.provider, pref, c.providerName);
                                  }}
                                >
                                  {pref === "avoid" ? "⛔ avoid" : pref === "prefer" ? "⭐ prefer" : "＋ list"}
                                </button>
                              </span>
                            </div>
                            <ActionGroups>
                              {c.state === "active" && (
                                <>
                                  {c.key.startsWith("val-") && c.health?.status === "jailed" && (
                                    <button
                                      className="btn amber"
                                      title="Broadcast an unjail tx from the operator key. Waits until the node is back at the chain head first, so the validator doesn't get re-jailed."
                                      onClick={() => fleetAction(f.launchId, c.dseq, "unjail")}
                                    >
                                      unjail
                                    </button>
                                  )}
                                  {f.keyMode === "tmkms" && c.key.startsWith("val-") && (
                                    <button
                                      className="btn amber"
                                      title="Signer stalled the chain? Bring the tmkms signer up first, then run this: it waits for the signer session, restarts the validator process in place (no redeploy, no manifest change), and watches it sign blocks again."
                                      onClick={() => fleetAction(f.launchId, c.dseq, "resume-signing")}
                                    >
                                      resume signing
                                    </button>
                                  )}
                                  {f.localSigner?.managed.includes(c.key) ? (
                                    <button
                                      className="btn"
                                      title="The launcher runs this validator's tmkms signer on this machine and repoints and restarts it by itself. Release it to go back to doing that by hand (the signer keeps running as it is)."
                                      disabled={localSignerBusy !== null}
                                      onClick={() => void runLocalSigner(f.launchId, "release", c.key)}
                                    >
                                      release signer
                                    </button>
                                  ) : f.keyMode === "tmkms" &&
                                    c.key.startsWith("val-") &&
                                    f.localSigner?.remote &&
                                    !f.localSigner.adoptable.includes(c.key) ? (
                                    <button
                                      className="btn"
                                      title="This validator's tmkms signer runs on another machine the launcher can reach over SSH (a Raspberry Pi with the hardware key, say). Let the launcher manage it there: it repoints and restarts it after relaunches, resizes, mesh re-keys and chain resets, and when it loses its session."
                                      disabled={localSignerBusy !== null}
                                      onClick={() => {
                                        const alias = window
                                          .prompt(
                                            `Which machine runs ${c.key}'s tmkms signer? Its ssh_config host alias (the launcher uses that entry's address, user and key).`,
                                            "",
                                          )
                                          ?.trim();
                                        if (alias) void runLocalSigner(f.launchId, "adopt", c.key, alias);
                                      }}
                                    >
                                      {localSignerBusy === c.key ? "taking over…" : "manage signer…"}
                                    </button>
                                  ) : f.localSigner?.adoptable.includes(c.key) ? (
                                    <button
                                      className="btn"
                                      title="This validator's tmkms signer runs on the launcher's machine. Let the launcher manage it: it takes over the running tmkms process, then repoints and restarts it after relaunches, resizes, mesh re-keys and chain resets, and when it loses its session."
                                      disabled={localSignerBusy !== null}
                                      onClick={() => void runLocalSigner(f.launchId, "adopt", c.key)}
                                    >
                                      {localSignerBusy === c.key ? "taking over…" : "manage signer"}
                                    </button>
                                  ) : null}
                                  {c.key === "headscale" && (f.meshBackup === null || f.meshBackup?.verified === false) && (
                                    <button
                                      className="btn amber"
                                      title="Stream headscale's state to an S3 bucket (encrypted) so a relaunch on another provider restores the mesh as it was, instead of re-keying every component."
                                      onClick={() => void openMeshBackup(f.launchId, f.name)}
                                    >
                                      back up mesh…
                                    </button>
                                  )}
                                  <button
                                    className="btn"
                                    onClick={() => fleetAction(f.launchId, c.dseq, "restart")}
                                  >
                                    restart
                                  </button>
                                  {/^(val|sentry)-/.test(c.key) && (f.dataBackups?.backups.length ?? 0) > 0 && (
                                    <button
                                      className="btn amber"
                                      title="Replace this node's chain data with one of the fleet's chain-data backups, in place: the cure for corrupted data or a node stuck on a bad state, without moving it. Its keys and signing state stay."
                                      onClick={() => void restoreNodeFromBackup(f, c.key)}
                                    >
                                      restore from backup…
                                    </button>
                                  )}
                                  {/^(val|sentry)-/.test(c.key) && (
                                    <>
                                      <button
                                        className="btn amber"
                                        title="Move this node to a deployment of another size. Akash cannot resize a running deployment, so a new one is created beside this node (on the same provider when it bids) and syncs the whole chain while this node keeps running; then it takes over this node's identity, with about a minute of downtime. A validator's signing state moves with it, so it cannot double-sign."
                                        onClick={() => void openResize(f.launchId, c.dseq, c.key)}
                                      >
                                        resize…
                                      </button>
                                      <button
                                        className="btn"
                                        title="Rebuild block history from archive files uploaded to this node: stops sparkdreamd, runs replay-from-archive in the background (its output stays on the node, so nothing floods the log viewer), then starts the node on the restored state. Upload the blocks_*.jsonl.gz files, or one .tar.gz of them, first."
                                        onClick={() =>
                                          fleetAction(f.launchId, c.dseq, "restore-archive")
                                        }
                                      >
                                        restore
                                      </button>
                                      <button
                                        className="btn red"
                                        title="Erase this node's chain data (comet unsafe-reset-all) and leave it stopped. Keys are kept. Only needed to rebuild history BELOW the node's current height: restore replays forward from where the node is, so a full rebuild from block 1 starts from an empty database."
                                        onClick={() => fleetAction(f.launchId, c.dseq, "reset-data")}
                                      >
                                        reset data…
                                      </button>
                                    </>
                                  )}
                                  <button
                                    className="btn"
                                    onClick={() => showLogs(f.launchId, c.dseq, c.key)}
                                  >
                                    logs
                                  </button>
                                  {c.ssh && (
                                    <label
                                      className="btn"
                                      title={
                                        uploading[c.key]
                                          ? undefined
                                          : `Push a file into this container. It lands in ${
                                              (isComponentKey(c.key) && COMPONENT_KINDS[c.key].uploadDir) ||
                                              "/root/.sparkdream (the chain home)"
                                            } as-is; move or extract it from the shell afterwards.`
                                      }
                                      style={
                                        uploading[c.key]
                                          ? { opacity: 0.5, pointerEvents: "none" }
                                          : { cursor: "pointer" }
                                      }
                                    >
                                      {uploading[c.key]
                                        ? `uploading ${uploading[c.key]}…`
                                        : "upload"}
                                      <input
                                        type="file"
                                        hidden
                                        onChange={async (e) => {
                                          const file = e.target.files?.[0];
                                          e.target.value = "";
                                          if (!file) return;
                                          setUploading((u) => ({ ...u, [c.key]: file.name }));
                                          try {
                                            const { uploadToComponent } = await import("../lib/api");
                                            const { remotePath } = await uploadToComponent(
                                              f.launchId,
                                              c.key,
                                              file,
                                            );
                                            showToast(`uploaded to ${c.key}:${remotePath}`);
                                          } catch (err) {
                                            setError(String(err));
                                          } finally {
                                            setUploading((u) => {
                                              const next = { ...u };
                                              delete next[c.key];
                                              return next;
                                            });
                                          }
                                        }}
                                      />
                                    </label>
                                  )}
                                  <button
                                    className="btn"
                                    title="Download the rendered SDL this component was deployed with"
                                    onClick={async () => {
                                      const { downloadComponentSdl } = await import("../lib/api");
                                      await downloadComponentSdl(f.launchId, c.dseq, c.key).catch(
                                        (e) => setError(String(e)),
                                      );
                                    }}
                                  >
                                    sdl
                                  </button>
                                  <button
                                    className="btn"
                                    onClick={() => {
                                      const feeNote =
                                        fee && fee.topupBps > 0
                                          ? ` A ${fee.topupBps / 100}% service fee is added (signed together).`
                                          : "";
                                      const amount = window.prompt(
                                        `Top-up amount (uact):${feeNote}`,
                                        "5000000",
                                      );
                                      if (amount)
                                        fleetAction(f.launchId, c.dseq, "topup", { amount });
                                    }}
                                  >
                                    top-up
                                  </button>
                                  {isComponentKey(c.key) && (
                                    <button
                                      className="btn"
                                      title={`Swap just this component's image (current: ${c.image}). One deployment update; the service fee is added.`}
                                      onClick={() => {
                                        const feeNote =
                                          fee && fee.upgradeFlat > 0
                                            ? ` A ${microToDisplay(String(fee.upgradeFlat))} ${denomLabel} service fee is added per upgrade (signed together).`
                                            : "";
                                        // Mastodon's deployment runs more than its web image: an
                                        // image of another repository swaps the service running it
                                        const sideNote =
                                          c.key === "mastodon"
                                            ? " The web image upgrades web + sidekiq; an sparkdreamnft/sdap image upgrades the bridge and sign-in services (with neither running, it is only recorded for the next move, with no signature), and a mastodon-streaming image the streaming service, each on its own."
                                            : "";
                                        const image = window.prompt(
                                          `Upgrade ${c.key}:${sideNote}${feeNote}`,
                                          c.image ?? undefined,
                                        );
                                        if (image && image !== c.image)
                                          fleetAction(f.launchId, c.dseq, "upgrade", {
                                            image,
                                            components: [c.key],
                                          });
                                      }}
                                    >
                                      upgrade…
                                    </button>
                                  )}
                                  {(() => {
                                    // the daemon in this component signs through a session key
                                    const role =
                                      c.key === "verifier" ? "verifier" : c.key === "mastodon" || c.key === "bridge" ? "bridge" : undefined;
                                    const session = role ? f.sessions?.find((x) => x.role === role) : undefined;
                                    if (!role || !session) return null;
                                    const days = Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 86_400_000));
                                    return (
                                      <button
                                        className={days <= 7 ? "btn amber" : "btn"}
                                        title={
                                          `The ${role} signs through a session key granted by ${session.granter}: scoped to its one message, ` +
                                          `a fee budget of ${session.spendLimit}, expiring ${session.expiresAt}. The account's own key never ` +
                                          `leaves this launcher. Renewed automatically from ${session.renewAt} while the launcher runs. ` +
                                          "Click to see it, or to rotate it now (e.g. after a provider incident)."
                                        }
                                        onClick={async () => {
                                          const ok = window.confirm(
                                            [
                                              `${role} session key`,
                                              `  key (grantee):  ${session.grantee}`,
                                              `  granted by:     ${session.granter} on ${session.chainId}`,
                                              `  fee budget:     ${session.spendLimit}`,
                                              `  expires:        ${session.expiresAt} (${days} days)`,
                                              `  auto-renews:    ${session.renewAt} (the launcher must be running then)`,
                                              ...(session.pendingRevoke?.length
                                                ? [`  revoke pending: ${session.pendingRevoke.join(", ")}`]
                                                : []),
                                              "",
                                              "Rotate it now? A new key is granted and delivered, then the old one is revoked. No wallet signature.",
                                            ].join("\n"),
                                          );
                                          if (!ok) return;
                                          try {
                                            const { postRotateSessions } = await import("../lib/api");
                                            await postRotateSessions(f.launchId, role);
                                            openLaunch(f.launchId);
                                          } catch (e) {
                                            setError(String(e));
                                          }
                                        }}
                                      >
                                        session key ({days}d)
                                      </button>
                                    );
                                  })()}
                                  {c.key === "relayer" && (
                                    <>
                                      <button
                                        className="btn"
                                        title="The relayer's address on each chain (fund these to pay gas) and the channels it relays"
                                        onClick={async () => {
                                          try {
                                            const { getRelayerState } = await import("../lib/api");
                                            const st = await getRelayerState(f.launchId);
                                            window.alert(
                                              [
                                                "Relayer addresses (each pays gas on its chain). The key sits on the",
                                                "relayer's provider: keep each balance to gas money, under its cap.",
                                                ...st.chains.map((ch) => {
                                                  const over = ch.balance && ch.cap && BigInt(ch.balance) > BigInt(ch.cap);
                                                  const money = ch.balance
                                                    ? ` holds ${ch.balance} ${ch.denom ?? ""}${ch.cap ? ` (cap ${ch.cap})` : ""}${over ? "  OVER CAP: move the excess out" : ""}`
                                                    : "";
                                                  return `  ${ch.chainId}: ${ch.address}${money}`;
                                                }),
                                                "",
                                                "Channels:",
                                                ...st.channels.map(
                                                  (ch) =>
                                                    `  ${ch.id} (${ch.port}): ${ch.a.chain}/${ch.a.channel} <-> ${ch.b.chain}/${ch.b.channel}`,
                                                ),
                                                ...(st.waiting?.length
                                                  ? [
                                                      "",
                                                      "Waiting for funds (configured, not opened; fund the key, then relink):",
                                                      ...st.waiting.map(
                                                        (w) =>
                                                          `  ${w.paths.join(", ")} on ${w.chainId}: send about ${w.amount} ${w.denom} to ${w.address}` +
                                                          (w.cap ? ` (cap ${w.cap})` : ""),
                                                      ),
                                                    ]
                                                  : []),
                                                ...(st.peers?.length
                                                  ? [
                                                      "",
                                                      "Federation peers (content moves only when both ends are ACTIVE):",
                                                      ...st.peers.map(
                                                        (p) => `  on ${p.chainId}: ${p.peerId} ${p.status.replace("PEER_STATUS_", "")}`,
                                                      ),
                                                    ]
                                                  : []),
                                                "",
                                                `Linked ${st.linkedAt}`,
                                              ].join("\n"),
                                            );
                                          } catch (e) {
                                            setError(String(e));
                                          }
                                        }}
                                      >
                                        channels
                                      </button>
                                      <button
                                        className="btn"
                                        title="Re-open whatever a chain reset on either end closed and restart Hermes on the current channels. Open channels are reused; no signature."
                                        onClick={async () => {
                                          try {
                                            const { postRelink } = await import("../lib/api");
                                            await postRelink(f.launchId);
                                            openLaunch(f.launchId);
                                          } catch (e) {
                                            setError(String(e));
                                          }
                                        }}
                                      >
                                        relink
                                      </button>
                                      <button
                                        className="btn"
                                        title="Each relayer key's live balance against its cap: top one up from Keplr, or withdraw what it holds"
                                        onClick={() => openRelayerFunds(f.launchId)}
                                      >
                                        funds…
                                      </button>
                                      <button
                                        className="btn"
                                        title="The chains this relayer connects to: content federation with Spark Dream sister chains and token transfers. Add or remove connections, then review what applying does."
                                        onClick={() => setRelayerSettingsFor(f.launchId)}
                                      >
                                        settings…
                                      </button>
                                    </>
                                  )}
                                  {c.key === "mastodon" && chainFleet && (
                                    <button
                                      className="btn"
                                      title="Other Mastodon servers whose authors the bridge anchors, each as a federation peer of its own. Each new one is registered and activated (a signature from a council or committee member), closed to every author until you curate it on the frontend, and bound to the bridge operator on its existing bond. For many servers under this instance's one peer instead, list them in the peer policy's content hosts on the frontend."
                                      onClick={async () => {
                                        try {
                                          const current: string[] =
                                            ((await getLaunch(f.launchId)).spec as any)?.topology?.components?.mastodon?.bridge?.peers?.map(
                                              (p: { id: string }) => p.id,
                                            ) ?? [];
                                          const input = window.prompt(
                                            "Other Mastodon servers to bridge as peers of their own (comma separated; empty for none).\n" +
                                              "New servers start closed: open or curate their authors on the frontend's federation page.",
                                            current.join(", "),
                                          );
                                          if (input === null) return;
                                          const peers = input.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
                                          fleetAction(f.launchId, c.dseq, "bridge-peers", { peers });
                                        } catch (e) {
                                          setError(String(e));
                                        }
                                      }}
                                    >
                                      bridge peers…
                                    </button>
                                  )}
                                  {c.key === "mastodon" && (
                                    <button
                                      className="btn amber"
                                      title="Move the instance to a deployment of another size, with its database and uploaded media. Akash cannot resize a running deployment, so this backs the data up, closes the old deployment, deploys the new size (preferring the same provider, so DNS stays put), restores, and restarts. The instance is down for several minutes."
                                      onClick={() => {
                                        const size = window.prompt(
                                          "Resize Mastodon to which size?\n" +
                                            "  small    ~2 CPU, ~3.6 GB RAM, 10 GiB media (a new community)\n" +
                                            "  standard ~4 CPU, ~8 GB RAM, 20 GiB media",
                                          "small",
                                        )?.trim();
                                        if (!size) return;
                                        if (size !== "small" && size !== "standard") {
                                          setError('size must be "small" or "standard"');
                                          return;
                                        }
                                        const ok = window.confirm(
                                          `Resize Mastodon to "${size}"?\n\n` +
                                            "1. Its database and uploaded media are backed up to the launcher (encrypted).\n" +
                                            "2. The current deployment is closed (one signature): the instance goes down.\n" +
                                            "3. A new deployment at the new size is created and leased (signatures), on the same provider if it bids.\n" +
                                            "4. The data is restored and Mastodon restarts; the bridge is re-linked.\n\n" +
                                            "Posts made during the few minutes between the backup and the close are not carried over. " +
                                            "If the new deployment lands on another provider, you will be asked to update the DNS records.",
                                        );
                                        if (ok) fleetAction(f.launchId, c.dseq, "resize", { size });
                                      }}
                                    >
                                      resize…
                                    </button>
                                  )}
                                  {c.key === "mastodon" && (
                                    <button
                                      className="btn"
                                      title="Who may sign up, and wallet sign-in (members of the linked chains sign in with Keplr; their handle is their x/name). Registrations and the sign-in trust level apply in place. Turning wallet sign-in on or off moves the instance to a new deployment at its current size, as a resize does."
                                      onClick={async () => {
                                        try {
                                          const m = ((await getLaunch(f.launchId)).spec as any)?.topology?.components?.mastodon ?? {};
                                          const registrations = window.prompt(
                                            "Who may sign up?\n" +
                                              "  none      nobody (the bridge account, and wallet sign-in if on)\n" +
                                              "  approved  anyone, once an admin approves them\n" +
                                              "  open      anyone",
                                            m.registrations ?? "none",
                                          )?.trim();
                                          if (!registrations) return;
                                          if (!["none", "approved", "open"].includes(registrations)) {
                                            setError('registrations must be "none", "approved" or "open"');
                                            return;
                                          }
                                          const signIn = window.prompt(
                                            "Wallet sign-in (on/off): members of this fleet's chain and of every chain whose bridge links " +
                                              "this instance sign in with Keplr on a domain of its own, which needs a DNS record.",
                                            m.walletLogin?.enabled ? "on" : "off",
                                          )?.trim();
                                          if (!signIn) return;
                                          if (signIn !== "on" && signIn !== "off") {
                                            setError('wallet sign-in must be "on" or "off"');
                                            return;
                                          }
                                          let minTrustLevel: string | undefined;
                                          let domain: string | undefined;
                                          if (signIn === "on") {
                                            minTrustLevel = window.prompt(
                                              "Lowest x/rep trust level that may sign in: new, provisional, established, trusted or core",
                                              m.walletLogin?.minTrustLevel ?? "new",
                                            )?.trim();
                                            if (!minTrustLevel) return;
                                            domain = window.prompt(
                                              "Sign-in domain. Keep it at the same depth as the instance's own domain: behind Cloudflare, " +
                                                "the free certificate covers only one level below the zone (mstdn-login.example.io works, " +
                                                "login.mstdn.example.io does not). Changing it later updates the deployment in place.",
                                              m.walletLogin?.domain ?? (m.domain ? defaultLoginDomain(m.domain) : ""),
                                            )?.trim().toLowerCase();
                                            if (!domain) return;
                                          }
                                          fleetAction(f.launchId, c.dseq, "mastodon-settings", {
                                            registrations: registrations as "none" | "approved" | "open",
                                            walletLogin: {
                                              enabled: signIn === "on",
                                              ...(minTrustLevel ? { minTrustLevel } : {}),
                                              ...(domain ? { domain } : {}),
                                            },
                                          });
                                        } catch (e) {
                                          setError(String(e));
                                        }
                                      }}
                                    >
                                      settings…
                                    </button>
                                  )}
                                  <button
                                    className="btn"
                                    title="Make the provider re-create this container from its current manifest, on the same deployment and provider. For when the deployment already carries the right settings but the running container was never rebuilt from them, so it keeps serving stale env (a tunnel aimed at an address that has since moved). Carries a nonce so the manifest is genuinely new, since a provider refuses an identical one. One signature; the component restarts, nothing else is touched."
                                    onClick={() => fleetAction(f.launchId, c.dseq, "force-redeploy")}
                                  >
                                    force redeploy
                                  </button>
                                  <button
                                    className="btn amber"
                                    onClick={() => fleetAction(f.launchId, c.dseq, "relaunch")}
                                  >
                                    relaunch
                                  </button>
                                  <button
                                    className="btn amber"
                                    title="Relaunch, but stop at the lease and list every bid so you can pick one. Your pick is leased whatever the selection policy says about it (price, uptime, avoid list)."
                                    onClick={() =>
                                      fleetAction(f.launchId, c.dseq, "relaunch", {
                                        manualBid: true,
                                      })
                                    }
                                  >
                                    relaunch: pick bid…
                                  </button>
                                  <button
                                    className="btn red"
                                    onClick={() => fleetAction(f.launchId, c.dseq, "close")}
                                  >
                                    close…
                                  </button>
                                </>
                              )}
                              {/* a closed/relaunching node can still be relaunched
                                  (redeploy fresh) — the only action that applies */}
                              {c.state !== "active" && !shutDown && (
                                <>
                                  {c.state === "closed" &&
                                    /^sentry-[1-9]\d*$/.test(c.key) &&
                                    Number(c.key.split("-")[1]) ===
                                      Math.max(...f.components.filter((x) => x.key.startsWith("sentry-")).map((x) => Number(x.key.split("-")[1]))) && (
                                      <button
                                        className="btn red"
                                        title="Remove this closed sentry from the fleet: the spec counts one sentry fewer, its row goes, and the other nodes stop listing it as a peer (running ones at their next restart). Nothing is signed: its deployment is already closed."
                                        onClick={() => {
                                          if (
                                            window.confirm(
                                              `Remove ${c.key} from this fleet? The spec counts one sentry fewer, its row and node identity go, ` +
                                                "and the other nodes stop listing it as a peer. Adding a sentry later creates a fresh one.",
                                            )
                                          ) {
                                            fleetAction(f.launchId, c.dseq, "remove");
                                          }
                                        }}
                                      >
                                        remove
                                      </button>
                                    )}
                                  {c.state === "closed" && isComponentKey(c.key) && (
                                    <button
                                      className="btn red"
                                      title="Remove this closed component from the fleet: its row goes and the spec stops enabling it (its settings stay for a later add). Nothing is signed: its deployment is already closed."
                                      onClick={() => {
                                        if (
                                          window.confirm(
                                            `Remove ${c.key} from this fleet? Its row disappears and the spec no longer enables it. ` +
                                              "Its settings, secrets and anything it set up on chain are kept, so adding it again later starts from them.",
                                          )
                                        ) {
                                          fleetAction(f.launchId, c.dseq, "remove");
                                        }
                                      }}
                                    >
                                      remove
                                    </button>
                                  )}
                                  <button
                                    className="btn amber"
                                    onClick={() => fleetAction(f.launchId, c.dseq, "relaunch")}
                                  >
                                    relaunch
                                  </button>
                                  <button
                                    className="btn amber"
                                    title="Relaunch, but stop at the lease and list every bid so you can pick one. Your pick is leased whatever the selection policy says about it (price, uptime, avoid list)."
                                    onClick={() =>
                                      fleetAction(f.launchId, c.dseq, "relaunch", {
                                        manualBid: true,
                                      })
                                    }
                                  >
                                    relaunch: pick bid…
                                  </button>
                                </>
                              )}
                            </ActionGroups>
                            {logsView?.key === c.key && (
                              <>
                                <pre className="logs">{logsView.text}</pre>
                                <button
                                  className="btn"
                                  style={{ marginTop: 8 }}
                                  onClick={() => setLogsView(null)}
                                >
                                  close logs
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                {/* accounts live inside the fleet card as its last section */}
                {!collapsed && bodyOpen && (
                  <div className="fleet-comp">
                    <div
                      className="acct-head"
                      title="show / hide the accounts"
                      onClick={() =>
                        // the acctsOpen effect fetches the rows on first open
                        setAcctsOpen((m) => ({ ...m, [f.launchId]: !(m[f.launchId] ?? false) }))
                      }
                    >
                      <div className="acct-title">Accounts</div>
                      {fleetAccounts[f.launchId] && (
                        <span className="tag">{fleetAccounts[f.launchId]!.length}</span>
                      )}
                      <span className="dim-note" style={{ fontSize: 12 }}>
                        genesis &amp; operator keys, click an address to copy
                      </span>
                      <span style={{ marginLeft: "auto", color: "var(--dim2)", fontSize: 13 }}>
                        {acctsOpen[f.launchId] ? "▴" : "▾"}
                      </span>
                    </div>
                    {acctsOpen[f.launchId] &&
                    (fleetAccounts[f.launchId] ?? []).map((a) => {
                      const rkey = `${f.launchId}:${a.name}`;
                      const revealed = revealedMnemonics[rkey];
                      return (
                        <div key={a.name} className="acct-row">
                          <div className="name">{a.name}</div>
                          <button
                            className="addr"
                            title="copy address"
                            onClick={() => copyAddress(a.address, a.name)}
                          >
                            {a.address}
                          </button>
                          <div className="tail">
                            {!a.hasMnemonic ? (
                              <span className="dim-note">external key</span>
                            ) : revealed ? (
                              <button
                                className="btn"
                                onClick={() =>
                                  setRevealedMnemonics((m) => {
                                    const next = { ...m };
                                    delete next[rkey];
                                    return next;
                                  })
                                }
                              >
                                hide
                              </button>
                            ) : (
                              <button
                                className="btn"
                                title="Show this account's seed phrase (import into Keplr to act as it)"
                                onClick={async () => {
                                  try {
                                    const { getAccountMnemonic } = await import("../lib/api");
                                    const r = await getAccountMnemonic(f.launchId, a.name);
                                    setRevealedMnemonics((m) => ({ ...m, [rkey]: r.mnemonic }));
                                  } catch (err) {
                                    setError(String(err));
                                  }
                                }}
                              >
                                reveal mnemonic
                              </button>
                            )}
                          </div>
                          {revealed && <span className="mnemonic">{revealed}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </Fragment>
          );
        })}

        {fleet && fleet.unmanaged.length > 0 && (
          <div className="placeholder" style={{ textAlign: "left" }}>
            Unmanaged deployments on this wallet (on-chain, not created here):{" "}
            {fleet.unmanaged.map((d) => `dseq ${d.dseq} (${d.state})`).join(" · ")}
          </div>
        )}

        {/* ---------- tmkms signer setup ---------- */}
        {tmkms && (
          <section className="card">
            <div className="card-head row-gap">
              <div className="card-title">tmkms signer setup</div>
              <span className="tag">{tmkms.chainId}</span>
              <span className="dim-note" style={{ fontSize: 12 }}>
                {localSigner?.validators.some((v) => v.managed)
                  ? "the launcher manages the signer on this machine"
                  : "run these on your signer machine, the launcher never touches it"}
              </span>
              <button className="btn" style={{ marginLeft: "auto" }} onClick={closeTmkms}>
                close
              </button>
            </div>
            <div className="card-body" style={{ paddingTop: 0 }}>
              <div className="dim-note">
                Work the numbered steps on your signer machine, top to bottom. The status
                lines below update on their own; when every validator reports its signer
                connected, resume the launch.
              </div>
              {tmkmsStatus && (
                <div style={{ display: "grid", gap: 4, fontSize: 13, marginTop: 8 }}>
                  <div>
                    signer machine on the mesh:{" "}
                    {tmkmsStatus.externalNodes.length === 0 ? (
                      <span style={{ color: "var(--amber-text)" }}>none seen yet</span>
                    ) : (
                      tmkmsStatus.externalNodes.map((n, i) => (
                        <span key={n.name}>
                          {i > 0 && ", "}
                          <span style={{ color: n.online ? "var(--ok)" : "var(--dim)" }}>
                            {n.name}
                            {n.ip ? ` (${n.ip})` : ""}
                            {n.online ? "" : " (offline)"}
                          </span>
                        </span>
                      ))
                    )}
                  </div>
                  {tmkmsStatus.validators.map((v) => {
                    const delta = tmkmsSignDeltas[v.key];
                    const peer = v.signerPeers?.[0];
                    return (
                      <div key={v.key}>
                        {v.key}:{" "}
                        {v.signerConnected === null ? (
                          <span style={{ color: "var(--dim)" }}>probe unreachable</span>
                        ) : !v.signerConnected ? (
                          <span style={{ color: "var(--amber-text)" }}>waiting for signer</span>
                        ) : v.pubkeyMatches === false ? (
                          <span style={{ color: "var(--red-text)" }}>
                            connected, but the signer holds the wrong consensus key (expected{" "}
                            {v.expectedPubkey})
                          </span>
                        ) : v.pubkeyMatches === true ? (
                          <span style={{ color: "var(--ok)" }}>signer connected, key matches the spec</span>
                        ) : (
                          <span style={{ color: "var(--ok)" }}>signer connected</span>
                        )}
                        {peer && (
                          <span className="dim-note">
                            {" · "}
                            {peer.relay ? `path relayed via ${peer.relay}` : "path direct"}
                          </span>
                        )}
                        {v.signerRelayMs !== null && (
                          <span className="dim-note">
                            {" · "}
                            {Math.round(v.signerRelayMs)}ms to the relay
                          </span>
                        )}
                        {v.signerRelayMs !== null && v.signerRelayMs > 1000 && (
                          <span style={{ color: "var(--amber-text)" }}>
                            {" "}
                            (high: a stall over 5s interrupts signing)
                          </span>
                        )}
                        {delta && delta.seen > 0 && delta.missed === 0 && (
                          <span className="dim-note">
                            {" · "}signed the last {delta.seen} block{delta.seen === 1 ? "" : "s"}
                          </span>
                        )}
                        {delta && delta.seen > 0 && delta.missed > 0 && (
                          <span style={{ color: "var(--amber-text)" }}>
                            {" · "}missed {delta.missed} of the last {delta.seen} blocks
                          </span>
                        )}
                        {delta && delta.seen === 0 && v.signerConnected === true && (
                          <span style={{ color: "var(--amber-text)" }}>
                            {" · "}no new blocks since the last check: the signer path may be
                            stalling
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {localSigner?.available &&
                    localSigner.validators.filter((l) => l.managed || l.adoptable).map((l) => (
                      <div key={`local-${l.key}`}>
                        {l.key} signer{l.machine ? ` on ${l.machine}` : " on this machine"}:{" "}
                        {l.managed ? (
                          <>
                            <span style={{ color: l.active ? "var(--ok)" : "var(--amber-text)" }}>
                              managed{l.active ? "" : " (unit not running)"}
                            </span>
                            <span className="dim-note">
                              {" · "}
                              <code>{l.unit}</code>
                            </span>
                            {l.addrMatches === false && (
                              <span style={{ color: "var(--amber-text)" }}>
                                {" · "}points at {l.addr}, the monitor repoints it
                              </span>
                            )}
                            {l.lastAction && (
                              <span className="dim-note">
                                {" · "}
                                {l.lastAction.what}, {new Date(l.lastAction.at).toLocaleString()}
                              </span>
                            )}{" "}
                            <button
                              className="btn"
                              disabled={localSignerBusy !== null}
                              onClick={() => tmkmsId && void runLocalSigner(tmkmsId, "release", l.key)}
                            >
                              stop managing
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="dim-note">
                              its tmkms runs on this machine, not managed: the launcher can repoint and
                              restart it for you{" "}
                            </span>
                            <button
                              className="btn"
                              disabled={localSignerBusy !== null}
                              onClick={() => tmkmsId && void runLocalSigner(tmkmsId, "adopt", l.key)}
                            >
                              {localSignerBusy === l.key ? "taking over…" : "manage signer"}
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  {tmkmsStatus.validators.length > 0 &&
                    tmkmsStatus.validators.every(
                      (v) => v.signerConnected === true && v.pubkeyMatches !== false,
                    ) && (
                      <div style={{ color: "var(--ok)", fontWeight: 600 }}>
                        all signers connected: resume the launch
                      </div>
                    )}
                </div>
              )}
            </div>
            {tmkms.validators.map((v) => (
              <div key={v.key} className="tmkms-val">
                <h3>
                  {v.key} · signer target <code>{v.tailnetIp}:26659</code>
                </h3>
                <details>
                  <summary>tmkms-{v.key}.toml</summary>
                  <pre>{v.tmkmsToml}</pre>
                </details>
                {v.expectedPubkey ? (
                  <details open>
                    <summary>consensus pubkey (must match the key in your hardware signer)</summary>
                    <pre>{v.expectedPubkey}</pre>
                  </details>
                ) : (
                  <details>
                    <summary>{v.key}-priv_validator_key.json (consensus key, handle offline)</summary>
                    <pre>{JSON.stringify(v.consensusKey, null, 2)}</pre>
                    <button
                      className="btn"
                      onClick={() => {
                        const blob = new Blob([JSON.stringify(v.consensusKey, null, 2)], {
                          type: "application/json",
                        });
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(blob);
                        a.download = `${v.key}-priv_validator_key.json`;
                        a.click();
                      }}
                    >
                      download key
                    </button>
                  </details>
                )}
                <pre>{v.commands.join("\n")}</pre>
              </div>
            ))}
          </section>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
      {busy && <div className="busy">{busy}</div>}
      {error && (
        <div className="banner fail global-error">
          <pre>{error}</pre>
          <button className="btn" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}
    </main>
  );
}
