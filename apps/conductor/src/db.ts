import Database from "better-sqlite3";

export type LaunchStatus = "created" | "running" | "paused" | "completed" | "aborted";
export type StepStatus = "pending" | "running" | "waiting" | "done" | "error";

export interface LaunchRow {
  id: string;
  owner: string;
  spec_json: string;
  status: LaunchStatus;
  created_at: string;
}

export interface StepRow {
  id: number;
  launch_id: string;
  name: string;
  status: StepStatus;
  started_at: string | null;
  finished_at: string | null;
  output_json: string | null;
  error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS launches (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL DEFAULT '',
  spec_json  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'created',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS launch_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  launch_id   TEXT NOT NULL REFERENCES launches(id),
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  started_at  TEXT,
  finished_at TEXT,
  output_json TEXT,
  error       TEXT,
  UNIQUE (launch_id, name)
);
CREATE TABLE IF NOT EXISTS fleet_components (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  launch_id  TEXT NOT NULL REFERENCES launches(id),
  key        TEXT NOT NULL,
  dseq       TEXT NOT NULL,
  provider   TEXT NOT NULL,
  host_uri   TEXT NOT NULL,
  price      TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'active',
  generation INTEGER NOT NULL DEFAULT 0,
  ssh_host   TEXT,
  ssh_port   INTEGER,
  tailnet_ip TEXT,
  image      TEXT,
  UNIQUE (launch_id, key)
);
CREATE TABLE IF NOT EXISTS fleet_ops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  launch_id   TEXT NOT NULL REFERENCES launches(id),
  kind        TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS component_health (
  launch_id  TEXT NOT NULL REFERENCES launches(id),
  component  TEXT NOT NULL,
  status     TEXT NOT NULL,
  detail     TEXT,
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (launch_id, component)
);
CREATE TABLE IF NOT EXISTS pending_gentxs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  launch_id     TEXT NOT NULL REFERENCES launches(id),
  val_index     INTEGER NOT NULL,
  address       TEXT NOT NULL,
  sign_doc_json TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  response_json TEXT,
  UNIQUE (launch_id, val_index)
);
CREATE TABLE IF NOT EXISTS pending_txs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  launch_id   TEXT NOT NULL REFERENCES launches(id),
  step        TEXT NOT NULL,
  msgs_json   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  tx_hash     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (launch_id, step)
);

-- Per-launch provider preferences (§6): kind 'avoid' excludes a provider
-- from relaunch selection; 'prefer' promotes it. Superseded by
-- provider_prefs_global (per wallet, carries across launches); kept for the
-- one-time migration below.
CREATE TABLE IF NOT EXISTS provider_prefs (
  launch_id   TEXT NOT NULL REFERENCES launches(id),
  provider    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('avoid', 'prefer')),
  name        TEXT,
  PRIMARY KEY (launch_id, provider)
);

-- Wallet-global provider preferences: one avoid/prefer list per owner,
-- applied to relaunches of ALL that owner's launches.
CREATE TABLE IF NOT EXISTS provider_prefs_global (
  owner       TEXT NOT NULL,
  provider    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('avoid', 'prefer')),
  name        TEXT,
  PRIMARY KEY (owner, provider)
);
`;

export class ConductorDb {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive column migrations for DBs created by earlier schema versions. */
  private migrate(): void {
    const cols = (table: string) =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
    if (!cols("provider_prefs").includes("name")) {
      this.db.exec("ALTER TABLE provider_prefs ADD COLUMN name TEXT");
    }
    // one-time: lift any per-launch prefs into the wallet-global list
    this.db.exec(
      `INSERT OR IGNORE INTO provider_prefs_global (owner, provider, kind, name)
       SELECT l.owner, pp.provider, pp.kind, pp.name
       FROM provider_prefs pp JOIN launches l ON l.id = pp.launch_id
       WHERE l.owner <> ''`,
    );
  }

  close(): void {
    this.db.close();
  }

  createLaunch(id: string, specJson: string, owner = ""): void {
    this.db
      .prepare("INSERT INTO launches (id, owner, spec_json) VALUES (?, ?, ?)")
      .run(id, owner, specJson);
  }

  getLaunch(id: string): LaunchRow | undefined {
    return this.db.prepare("SELECT * FROM launches WHERE id = ?").get(id) as
      | LaunchRow
      | undefined;
  }

  setLaunchStatus(id: string, status: LaunchStatus): void {
    this.db.prepare("UPDATE launches SET status = ? WHERE id = ?").run(status, id);
  }

  getStep(launchId: string, name: string): StepRow | undefined {
    return this.db
      .prepare("SELECT * FROM launch_steps WHERE launch_id = ? AND name = ?")
      .get(launchId, name) as StepRow | undefined;
  }

  listSteps(launchId: string): StepRow[] {
    return this.db
      .prepare("SELECT * FROM launch_steps WHERE launch_id = ? ORDER BY id")
      .all(launchId) as StepRow[];
  }

  stepStarted(launchId: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO launch_steps (launch_id, name, status, started_at, error)
         VALUES (?, ?, 'running', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL)
         ON CONFLICT (launch_id, name) DO UPDATE SET
           status = 'running',
           started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           finished_at = NULL,
           error = NULL`,
      )
      .run(launchId, name);
  }

  stepDone(launchId: string, name: string, output: unknown): void {
    this.db
      .prepare(
        `UPDATE launch_steps SET status = 'done',
           finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           output_json = ?
         WHERE launch_id = ? AND name = ?`,
      )
      .run(output === undefined ? null : JSON.stringify(output), launchId, name);
  }

  stepWaiting(launchId: string, name: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE launch_steps SET status = 'waiting', error = ? WHERE launch_id = ? AND name = ?",
      )
      .run(reason, launchId, name);
  }

  stepFailed(launchId: string, name: string, error: string): void {
    this.db
      .prepare(
        `UPDATE launch_steps SET status = 'error',
           finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           error = ?
         WHERE launch_id = ? AND name = ?`,
      )
      .run(error, launchId, name);
  }

  /** Erase an aborted op's step rows so they stop showing as errors. */
  deleteOpSteps(launchId: string, opId: number): void {
    this.db
      .prepare("DELETE FROM launch_steps WHERE launch_id = ? AND name LIKE ?")
      .run(launchId, `op${opId}:%`);
  }

  stepOutput<T>(launchId: string, name: string): T | undefined {
    const row = this.getStep(launchId, name);
    if (!row?.output_json) return undefined;
    return JSON.parse(row.output_json) as T;
  }

  // --- pending-tx signing loop (§8) ---

  getPendingTx(launchId: string, step: string): PendingTxRow | undefined {
    return this.db
      .prepare("SELECT * FROM pending_txs WHERE launch_id = ? AND step = ?")
      .get(launchId, step) as PendingTxRow | undefined;
  }

  /** The next unsigned tx for the UI banner, if any. */
  nextPendingTx(launchId: string): PendingTxRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM pending_txs WHERE launch_id = ? AND status = 'pending' ORDER BY id LIMIT 1",
      )
      .get(launchId) as PendingTxRow | undefined;
  }

  /** Signed-but-unconfirmed fleet action txs (settled by FleetService). */
  listSignedFleetTxs(launchId: string): PendingTxRow[] {
    return this.db
      .prepare(
        "SELECT * FROM pending_txs WHERE launch_id = ? AND status = 'signed' AND step LIKE 'fleet:%'",
      )
      .all(launchId) as PendingTxRow[];
  }

  enqueuePendingTx(launchId: string, step: string, msgsJson: string): void {
    this.db
      .prepare(
        `INSERT INTO pending_txs (launch_id, step, msgs_json) VALUES (?, ?, ?)
         ON CONFLICT (launch_id, step) DO NOTHING`,
      )
      .run(launchId, step, msgsJson);
  }

  /** Forget a settled pending tx so a step re-run can enqueue a fresh one
   *  (stale-order redeploy: the old deployment was closed on-chain). */
  deletePendingTx(launchId: string, step: string): void {
    this.db
      .prepare("DELETE FROM pending_txs WHERE launch_id = ? AND step = ?")
      .run(launchId, step);
  }

  /** Replace the msgs of a not-yet-signed pending tx (step re-run drift). */
  updatePendingTxMsgs(launchId: string, step: string, msgsJson: string): void {
    this.db
      .prepare(
        "UPDATE pending_txs SET msgs_json = ? WHERE launch_id = ? AND step = ? AND status IN ('pending', 'failed')",
      )
      .run(msgsJson, launchId, step);
  }

  setPendingTxSigned(launchId: string, step: string, txHash: string): void {
    this.db
      .prepare(
        "UPDATE pending_txs SET status = 'signed', tx_hash = ? WHERE launch_id = ? AND step = ?",
      )
      .run(txHash, launchId, step);
  }

  setPendingTxStatus(launchId: string, step: string, status: PendingTxStatus): void {
    this.db
      .prepare("UPDATE pending_txs SET status = ? WHERE launch_id = ? AND step = ?")
      .run(status, launchId, step);
  }

  // --- fleet (M5, §5 day-2) ---

  /** Launches the health monitor sweeps (only completed ones have a fleet). */
  listCompletedLaunches(): LaunchRow[] {
    return this.db
      .prepare("SELECT * FROM launches WHERE status = 'completed' ORDER BY created_at")
      .all() as LaunchRow[];
  }

  listLaunchesByOwner(owner: string): LaunchRow[] {
    return this.db
      .prepare("SELECT * FROM launches WHERE owner = ? ORDER BY created_at")
      .all(owner) as LaunchRow[];
  }

  upsertFleetComponent(c: {
    launch_id: string;
    key: string;
    dseq: string;
    provider: string;
    host_uri: string;
    price: string;
    state: string;
    ssh_host?: string | null;
    ssh_port?: number | null;
    tailnet_ip?: string | null;
    image?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO fleet_components
           (launch_id, key, dseq, provider, host_uri, price, state, ssh_host, ssh_port, tailnet_ip, image)
         VALUES (@launch_id, @key, @dseq, @provider, @host_uri, @price, @state,
                 @ssh_host, @ssh_port, @tailnet_ip, @image)
         ON CONFLICT (launch_id, key) DO NOTHING`,
      )
      .run({ ssh_host: null, ssh_port: null, tailnet_ip: null, image: null, ...c });
  }

  /** Fill endpoint fields that were unknown when the row was first
   *  materialized mid-launch (never overwrites present values). */
  backfillComponentEndpoints(
    launchId: string,
    key: string,
    fields: { ssh_host?: string | null; ssh_port?: number | null; tailnet_ip?: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE fleet_components SET
           ssh_host = COALESCE(ssh_host, @ssh_host),
           ssh_port = COALESCE(ssh_port, @ssh_port),
           tailnet_ip = COALESCE(tailnet_ip, @tailnet_ip)
         WHERE launch_id = @launch_id AND key = @key`,
      )
      .run({ ssh_host: null, ssh_port: null, tailnet_ip: null, ...fields, launch_id: launchId, key });
  }

  // --- provider preferences (§6 day-2): wallet-global, per owner ---

  /** Set a provider's preference for an owner; "none" removes it. */
  setProviderPref(
    owner: string,
    provider: string,
    kind: "avoid" | "prefer" | "none",
    name?: string | null,
  ): void {
    if (kind === "none") {
      this.db
        .prepare("DELETE FROM provider_prefs_global WHERE owner = ? AND provider = ?")
        .run(owner, provider);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO provider_prefs_global (owner, provider, kind, name) VALUES (?, ?, ?, ?)
         ON CONFLICT (owner, provider) DO UPDATE SET kind = excluded.kind,
           name = COALESCE(excluded.name, provider_prefs_global.name)`,
      )
      .run(owner, provider, kind, name ?? null);
  }

  providerPrefs(owner: string): {
    avoid: string[];
    prefer: string[];
    names: Record<string, string>;
  } {
    const rows = this.db
      .prepare("SELECT provider, kind, name FROM provider_prefs_global WHERE owner = ?")
      .all(owner) as Array<{ provider: string; kind: "avoid" | "prefer"; name: string | null }>;
    const names: Record<string, string> = {};
    for (const r of rows) if (r.name) names[r.provider] = r.name;
    return {
      avoid: rows.filter((r) => r.kind === "avoid").map((r) => r.provider),
      prefer: rows.filter((r) => r.kind === "prefer").map((r) => r.provider),
      names,
    };
  }

  listFleetComponents(launchId: string): FleetComponentRow[] {
    return this.db
      .prepare("SELECT * FROM fleet_components WHERE launch_id = ? ORDER BY key")
      .all(launchId) as FleetComponentRow[];
  }

  getFleetComponentByDseq(launchId: string, dseq: string): FleetComponentRow | undefined {
    return this.db
      .prepare("SELECT * FROM fleet_components WHERE launch_id = ? AND dseq = ?")
      .get(launchId, dseq) as FleetComponentRow | undefined;
  }

  setComponentState(launchId: string, key: string, state: string): void {
    this.db
      .prepare("UPDATE fleet_components SET state = ? WHERE launch_id = ? AND key = ?")
      .run(state, launchId, key);
  }

  setComponentHealth(launchId: string, component: string, status: string, detail?: string): void {
    this.db
      .prepare(
        `INSERT INTO component_health (launch_id, component, status, detail, checked_at)
         VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT (launch_id, component) DO UPDATE SET
           status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at`,
      )
      .run(launchId, component, status, detail ?? null);
  }

  listComponentHealth(launchId: string): ComponentHealthRow[] {
    return this.db
      .prepare("SELECT * FROM component_health WHERE launch_id = ?")
      .all(launchId) as ComponentHealthRow[];
  }

  updateComponentPlacement(
    launchId: string,
    key: string,
    fields: {
      dseq: string;
      provider: string;
      host_uri: string;
      price: string;
      generation: number;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE fleet_components SET dseq = @dseq, provider = @provider,
           host_uri = @host_uri, price = @price, generation = @generation,
           state = 'active'
         WHERE launch_id = @launch_id AND key = @key`,
      )
      .run({ ...fields, launch_id: launchId, key });
  }

  updateComponentRuntime(
    launchId: string,
    key: string,
    fields: { ssh_host?: string; ssh_port?: number; tailnet_ip?: string; image?: string },
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { launch_id: launchId, key };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      sets.push(`${k} = @${k}`);
      params[k] = v;
    }
    if (sets.length === 0) return;
    this.db
      .prepare(
        `UPDATE fleet_components SET ${sets.join(", ")} WHERE launch_id = @launch_id AND key = @key`,
      )
      .run(params);
  }

  // --- fleet ops (relaunch / rolling upgrade) ---

  createFleetOp(launchId: string, kind: string, params: unknown): number {
    const info = this.db
      .prepare("INSERT INTO fleet_ops (launch_id, kind, params_json) VALUES (?, ?, ?)")
      .run(launchId, kind, JSON.stringify(params));
    return Number(info.lastInsertRowid);
  }

  listFleetOps(launchId: string, status?: string): FleetOpRow[] {
    const rows = status
      ? this.db
          .prepare("SELECT * FROM fleet_ops WHERE launch_id = ? AND status = ? ORDER BY id")
          .all(launchId, status)
      : this.db.prepare("SELECT * FROM fleet_ops WHERE launch_id = ? ORDER BY id").all(launchId);
    return rows as FleetOpRow[];
  }

  setFleetOpStatus(opId: number, status: string): void {
    this.db.prepare("UPDATE fleet_ops SET status = ? WHERE id = ?").run(status, opId);
  }

  // --- gentx signing loop (§5 step 3b, external operators) ---

  getPendingGentx(launchId: string, valIndex: number): PendingGentxRow | undefined {
    return this.db
      .prepare("SELECT * FROM pending_gentxs WHERE launch_id = ? AND val_index = ?")
      .get(launchId, valIndex) as PendingGentxRow | undefined;
  }

  nextPendingGentx(launchId: string): PendingGentxRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM pending_gentxs WHERE launch_id = ? AND status = 'pending' ORDER BY val_index LIMIT 1",
      )
      .get(launchId) as PendingGentxRow | undefined;
  }

  enqueuePendingGentx(
    launchId: string,
    valIndex: number,
    address: string,
    signDocJson: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO pending_gentxs (launch_id, val_index, address, sign_doc_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (launch_id, val_index) DO NOTHING`,
      )
      .run(launchId, valIndex, address, signDocJson);
  }

  setGentxSigned(launchId: string, valIndex: number, responseJson: string): void {
    this.db
      .prepare(
        "UPDATE pending_gentxs SET status = 'signed', response_json = ? WHERE launch_id = ? AND val_index = ?",
      )
      .run(responseJson, launchId, valIndex);
  }

  resetGentx(launchId: string, valIndex: number): void {
    this.db
      .prepare(
        "UPDATE pending_gentxs SET status = 'pending', response_json = NULL WHERE launch_id = ? AND val_index = ?",
      )
      .run(launchId, valIndex);
  }
}

export interface FleetComponentRow {
  id: number;
  launch_id: string;
  key: string;
  dseq: string;
  provider: string;
  host_uri: string;
  price: string;
  state: string;
  generation: number;
  ssh_host: string | null;
  ssh_port: number | null;
  tailnet_ip: string | null;
  image: string | null;
}

export interface FleetOpRow {
  id: number;
  launch_id: string;
  kind: string;
  params_json: string;
  status: string;
  created_at: string;
}

export interface ComponentHealthRow {
  launch_id: string;
  component: string;
  status: string;
  detail: string | null;
  checked_at: string;
}

export interface PendingGentxRow {
  id: number;
  launch_id: string;
  val_index: number;
  address: string;
  sign_doc_json: string;
  status: "pending" | "signed";
  response_json: string | null;
}

export type PendingTxStatus = "pending" | "signed" | "confirmed" | "failed";

export interface PendingTxRow {
  id: number;
  launch_id: string;
  step: string;
  msgs_json: string;
  status: PendingTxStatus;
  tx_hash: string | null;
  created_at: string;
}
