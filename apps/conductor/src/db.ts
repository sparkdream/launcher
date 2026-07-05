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
`;

export class ConductorDb {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
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

  enqueuePendingTx(launchId: string, step: string, msgsJson: string): void {
    this.db
      .prepare(
        `INSERT INTO pending_txs (launch_id, step, msgs_json) VALUES (?, ?, ?)
         ON CONFLICT (launch_id, step) DO NOTHING`,
      )
      .run(launchId, step, msgsJson);
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
