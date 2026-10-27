// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createHmac, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryScope, TaskRecord } from "./types.js";
import {
  EncryptedPayloadSchema,
  WorkflowDefinitionSchema,
  WorkflowEventSchema,
  WorkflowRunSchema,
  WorkflowSnapshotSchema,
  type EncryptedPayload,
  type ApprovalDecision,
  type ApprovalDenial,
  type Refusal,
  type WorkflowEvent,
  type WorkflowRun,
  type WorkflowSnapshot,
} from "@melra/protocol";
import {
  sha256,
  type ActionReceipt,
  type ExecutionCertificate,
} from "@melra/receipt-schema";

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  key: string;
  value: string;
  source: string;
  confidence: number;
  tags: string[];
  speaker?: string;
  episodeId?: string;
  sequence?: number;
  expiresAt?: string;
  supersedesId?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

interface JsonRow {
  data: string;
}

interface NullableJsonRow {
  data: string | null;
}

interface StateVersionRow {
  stateVersion: number;
  data: string;
}

interface IdempotencyCommitRow {
  taskId: string;
  attempt: number;
  committedAt: string;
}

interface MemoryRow {
  id: string;
  scope: MemoryScope;
  key: string;
  value: string;
  source: string;
  confidence: number;
  tags: string;
  speaker: string | null;
  episodeId: string | null;
  sequence: number | null;
  expiresAt: string | null;
  supersedesId: string | null;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function toMemoryRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope,
    key: row.key,
    value: row.value,
    source: row.source,
    confidence: row.confidence,
    tags: JSON.parse(row.tags) as string[],
    ...(row.speaker === null ? {} : { speaker: row.speaker }),
    ...(row.episodeId === null ? {} : { episodeId: row.episodeId }),
    ...(row.sequence === null ? {} : { sequence: row.sequence }),
    ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
    ...(row.supersedesId === null ? {} : { supersedesId: row.supersedesId }),
    ...(row.supersededBy === null ? {} : { supersededBy: row.supersededBy }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface Parser<T> {
  parse(value: unknown): T;
}

function parseStored<T>(
  data: string,
  schema: Parser<T>,
  error: string,
): T {
  try {
    return schema.parse(JSON.parse(data));
  } catch {
    throw new Error(error);
  }
}

/**
 * The redacted copy of a workflow definition, kept for reading. Redaction
 * rewrites any string shaped like a credential, so a node id or a URL in it
 * may no longer match the definition schema; only the identity it is stored
 * under is checked. The sealed payload is the definition that runs.
 */
const RedactedWorkflowDefinitionSchema = WorkflowDefinitionSchema.pick({ id: true, version: true }).loose();
export type RedactedWorkflowDefinition = ReturnType<typeof RedactedWorkflowDefinitionSchema.parse>;

/**
 * Task records, events and receipts are for the user running MELRA alone:
 * the database, and the WAL and shared-memory files SQLite gives the same
 * mode, are made private if anything left them wider. `chmod`, never an open:
 * closing any descriptor to the file would drop the locks SQLite holds on it.
 */
function keepPrivate(path: string): void {
  if (process.platform === "win32") return;
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    } catch {
      // Not there yet, or not ours to change: SQLite creates the WAL files later, from the database's mode.
    }
  }
}

/** Refuses any update or delete of `table`'s rows, and an insert on a stored rowid (migration 7). */
function appendOnly(table: string): string {
  return `
      CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'record_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'record_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_rowid_reuse BEFORE INSERT ON ${table}
        WHEN NEW.rowid <> -1 AND EXISTS (SELECT 1 FROM ${table} WHERE rowid = NEW.rowid)
      BEGIN SELECT RAISE(ABORT, 'record_append_only'); END;`;
}

/** Refuses, or with `IGNORE` ignores, an insert under a stored row's key (migration 7). */
function keyedOnce(table: string, key: string, raise: string): string {
  return `
      CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table}
        WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${key})
      BEGIN SELECT RAISE(${raise}); END;`;
}

/**
 * The records the chain covers (migration 9): every one migrations 7 and 8
 * made append-only, with the key it is found under and the columns its digest
 * is taken over. A certificate's versions are found by id in `certificates`
 * and `certificate_history` alike, so one a judgement or settle replaced is
 * still the record it was. `certified_tasks` only says that a task has had a
 * certificate, which its chained certificates show.
 */
const CHAINED = {
  receipts: { key: ["id"], columns: ["id", "task_id", "data", "created_at"] },
  certificates: { key: ["id"], columns: ["id", "task_id", "data", "created_at"] },
  workflow_events: {
    key: ["id"],
    columns: ["id", "aggregate_id", "sequence", "trace_id", "type", "data", "occurred_at"],
  },
  approval_decisions: {
    key: ["approval_id"],
    columns: ["approval_id", "task_id", "render_digest", "channel", "approver", "decided_at"],
  },
  approval_denials: {
    key: ["approval_id"],
    columns: [
      "approval_id", "task_id", "render_digest", "operation_digest", "channel", "approver", "reason", "note",
      "decided_at",
    ],
  },
  refusals: {
    key: ["subject_id", "code"],
    columns: ["subject_id", "code", "kind", "mode", "principal", "client", "refused_at"],
  },
  capability_usage: { key: ["grant_id", "task_id"], columns: ["grant_id", "task_id", "amount", "committed_at"] },
  idempotency_commits: {
    key: ["idempotency_key"],
    columns: ["idempotency_key", "task_id", "attempt", "committed_at"],
  },
} as const;
type ChainedTable = keyof typeof CHAINED;

/** The link before the first. */
const GENESIS = "0".repeat(64);

/**
 * Every record of `table`, with the key the chain names it by. SQLite spells
 * that key in every path, sealing, sweeping and verifying, so they agree.
 */
function chainedRows(table: ChainedTable): string {
  const { key, columns } = CHAINED[table];
  const from = (source: string, column: (name: string) => string) =>
    `SELECT json_array(${key.map(column).join(", ")}) AS record_key, ` +
    `${columns.map((name) => `${column(name)} AS ${name}`).join(", ")} FROM ${source}`;
  return table === "certificates"
    ? `${from("certificate_history", (name) => (name === "id" ? "certificate_id" : name))} UNION ALL ${from("certificates", (name) => name)}`
    : from(table, (name) => name);
}

/** A chained column's value as a write binds it, and as SQLite reads it back. */
type Bound = string | number | null;

function recordDigest(table: ChainedTable, record: Record<string, unknown>): string {
  return sha256([table, record]);
}

/** `swept` (1 or 0) is whether a start sealed the record rather than the write that stored it. */
function chainLink(key: Buffer, previous: string, digest: string, swept: number): string {
  return createHmac("sha256", key).update(`${previous}\0${digest}\0${swept}`).digest("hex");
}

/** A link of the chain an operator keeps outside MELRA: `melra audit head`. */
export interface ChainHead {
  sequence: number;
  link: string;
}

export type ChainBreak =
  | "sequence_gap"
  | "link_forged"
  | "record_removed"
  | "record_changed"
  | "head_mismatch"
  | "head_truncated"
  | "unsealed_rows";

export interface ChainReport {
  ok: boolean;
  /** The chain's last link as stored, trusted only when `ok`. */
  head: ChainHead;
  /** Rows of chained tables no link seals yet. */
  unsealed: number;
  /** Links a start made (`sealRecords`) rather than the write that stored the record. */
  swept: number;
  /**
   * Swept links that come after one made at write time: how many, and the
   * first. An older MELRA writing beside this one leaves them, and so does a
   * link removed with every later one, the records changed and sealed again.
   */
  late?: { count: number; sequence: number; table: string; key: string };
  /** The first thing found wrong, in chain order, then the kept head, then unsealed rows. */
  break?: { reason: ChainBreak; sequence?: number; table?: string; key?: string };
}

interface ChainRow {
  sequence: number;
  recordTable: string;
  recordKey: string;
  recordDigest: string;
  previousLink: string;
  link: string;
  swept: number;
}

export class SqliteStore {
  readonly path: string;
  readonly database: DatabaseSync;
  // Held as a field on purpose: a garbage-collected handle would drop the lock
  // and make this live process look dead to every other one.
  private owner?: { id: string; lock?: DatabaseSync; file?: string };
  /**
   * Tasks something in this process is executing or recovering through this
   * store. Ownership is per store, so this is too: a row this store owns that
   * is not in here was orphaned by a write that failed, and may be taken back.
   */
  readonly inFlight = new Set<string>();
  /** Set by `sealRecords`; until then this store writes records unsealed, as an older MELRA does. */
  private chainKey?: Buffer;
  private inTransaction = false;

  /**
   * `readOnly` is for observers (`melra tasks`, `status`, `watch`) that sit
   * beside a live server. Such a connection never migrates, never switches the
   * journal mode, and cannot take a write lock, so a poll can never stall a
   * writer — in WAL mode a reader and a writer do not block each other. The
   * database must already exist; an observer has no business creating one.
   */
  constructor(path: string, options: { readOnly?: boolean } = {}) {
    this.path = path;
    if (options.readOnly === true) {
      this.database = new DatabaseSync(path, { readOnly: true });
      this.database.exec("PRAGMA busy_timeout = 5000");
      return;
    }
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // A new database is created private, not made so after SQLite has
      // created it at its default mode. `wx` opens only a file it creates,
      // never one this process may already hold SQLite locks on.
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch {
        // Already there (kept private below), or SQLite says why it cannot be.
      }
    }
    this.database = new DatabaseSync(path);
    if (path !== ":memory:") keepPrivate(path);
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS receipts_task_id ON receipts(task_id);
      CREATE TABLE IF NOT EXISTS certificates (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        speaker TEXT,
        episode_id TEXT,
        sequence INTEGER,
        expires_at TEXT,
        supersedes_id TEXT,
        superseded_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope);
      -- Newest first without sorting the scope, so a search reads no further
      -- than its budget. Descending, so a tie still comes out in the order it
      -- was written, as the sort gave it.
      CREATE INDEX IF NOT EXISTS memories_scope_updated ON memories(scope, updated_at DESC);
      CREATE INDEX IF NOT EXISTS memories_key ON memories(key);
    `);
    this.addColumnIfMissing("memories", "tags", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("memories", "speaker", "TEXT");
    this.addColumnIfMissing("memories", "episode_id", "TEXT");
    this.addColumnIfMissing("memories", "sequence", "INTEGER");
    this.addColumnIfMissing("memories", "expires_at", "TEXT");
    this.addColumnIfMissing("memories", "supersedes_id", "TEXT");
    this.addColumnIfMissing("memories", "superseded_by", "TEXT");
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS memories_expiry ON memories(expires_at);
      CREATE INDEX IF NOT EXISTS memories_superseded_by ON memories(superseded_by);
      CREATE INDEX IF NOT EXISTS memories_episode_sequence
        ON memories(episode_id, sequence);
    `);
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);
      const applied = this.database
        .prepare("SELECT version FROM schema_migrations WHERE version = 1")
        .get();
      if (applied !== undefined) return;
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS task_payloads (
          task_id TEXT PRIMARY KEY,
          request_payload TEXT NOT NULL,
          result_payload TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workflow_payloads (
          workflow_id TEXT NOT NULL,
          workflow_version INTEGER NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(workflow_id, workflow_version)
        );
        CREATE TABLE IF NOT EXISTS workflow_definitions (
          id TEXT NOT NULL,
          version INTEGER NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(id, version)
        );
        CREATE TABLE IF NOT EXISTS workflow_runs (
          id TEXT PRIMARY KEY,
          definition_id TEXT NOT NULL,
          definition_version INTEGER NOT NULL,
          state_version INTEGER NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workflow_events (
          id TEXT PRIMARY KEY,
          aggregate_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          trace_id TEXT NOT NULL,
          type TEXT NOT NULL,
          data TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          UNIQUE(aggregate_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS workflow_events_aggregate
          ON workflow_events(aggregate_id, sequence);
        CREATE TABLE IF NOT EXISTS workflow_snapshots (
          workflow_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(workflow_id, sequence)
        );
        CREATE TABLE IF NOT EXISTS idempotency_commits (
          idempotency_key TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          committed_at TEXT NOT NULL
        );
      `);
      this.database
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)",
        )
        .run(new Date().toISOString());
    });
    // Migration 2 adds cross-process advance leases. Schema changes get a new
    // migration rather than an edit to the version-1 statements above.
    this.applyMigration(
      2,
      `
      CREATE TABLE IF NOT EXISTS workflow_leases (
        workflow_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `,
    );
    // Migration 3 meters capability grants. A ledger row per commit rather than
    // a counter column, because a rolling daily total needs to know when each
    // draw happened, and a counter that only goes up cannot answer that. The
    // composite key is what makes a replayed or recovered commit idempotent:
    // the same task cannot spend the same grant twice.
    this.applyMigration(
      3,
      `
      CREATE TABLE IF NOT EXISTS capability_usage (
        grant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        committed_at TEXT NOT NULL,
        PRIMARY KEY(grant_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_capability_usage_window
        ON capability_usage(grant_id, committed_at);
    `,
    );
    // Migration 4 records which process is running each task, so recovery can
    // tell a live peer's work from a crashed one's. The index expression must
    // match the status filters' text exactly for SQLite to use it.
    this.applyMigration(
      4,
      `
      ALTER TABLE tasks ADD COLUMN owner TEXT;
      CREATE INDEX IF NOT EXISTS tasks_status
        ON tasks(json_extract(data, '$.status'));
    `,
    );
    // Migration 5 records operator approval decisions. Insert-once, and kept
    // off TaskRecord, because a task row is a whole-record write where the
    // last writer wins across processes; a decision must not be lost to one.
    this.applyMigration(
      5,
      `
      CREATE TABLE IF NOT EXISTS approval_decisions (
        approval_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        render_digest TEXT NOT NULL,
        channel TEXT NOT NULL,
        approver TEXT NOT NULL,
        decided_at TEXT NOT NULL
      );
    `,
    );
    // Migration 6 indexes tasks by idempotency key, so a workflow step finds
    // the tasks under its key without reading every task. As for migration 4,
    // the expression must match listTasksByKey's text exactly.
    this.applyMigration(
      6,
      `
      CREATE INDEX IF NOT EXISTS tasks_idempotency_key
        ON tasks(json_extract(data, '$.idempotencyKey'));
    `,
    );
    // Migration 7 makes the records an effect leaves append-only, in SQL so an
    // older MELRA sharing the home is held to it too: no version has ever
    // updated or deleted these rows, only inserted them (or ignored a repeat).
    // A certificate is still replaced when a task is judged or settled, by an
    // upsert on its task (every version writes it so), so the row it replaces
    // is kept in certificate_history. REPLACE removes a row without firing its
    // delete trigger (recursive_triggers is off), so an insert whose rowid or
    // key a stored row holds is refused too; the three written with INSERT OR
    // IGNORE ignore a key they hold instead, so a repeat still reports no
    // change. NEW.rowid is -1 in an insert that names none, so -1 is never
    // compared: no row MELRA writes has it, and one someone else wrote there
    // must not block every insert after it. An upsert fires the insert trigger too, so a certificate
    // insert may meet its own task's row; one that then lands as a new row
    // replaced it, which certificates_insert_once refuses by finding the task
    // in certified_tasks. An update may not move a certificate to another
    // rowid, task or certificate's id. This stops bugs, stray scripts and
    // naive edits, not someone who can write the file: they can drop a
    // trigger. A future prune must drop and recreate these triggers inside
    // the one transaction it deletes in.
    this.applyMigration(
      7,
      `
      CREATE TABLE IF NOT EXISTS certificate_history (
        certificate_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        replaced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS certified_tasks (task_id TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO certified_tasks(task_id) SELECT task_id FROM certificates;
      CREATE TRIGGER IF NOT EXISTS certificates_keep_history
        AFTER UPDATE ON certificates
      BEGIN
        INSERT INTO certificate_history(certificate_id, task_id, data, created_at, replaced_at)
        VALUES (OLD.id, OLD.task_id, OLD.data, OLD.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      END;
      CREATE TRIGGER IF NOT EXISTS certificates_no_delete BEFORE DELETE ON certificates
      BEGIN SELECT RAISE(ABORT, 'record_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS certificates_no_replace BEFORE INSERT ON certificates
        WHEN EXISTS (
          SELECT 1 FROM certificates
          WHERE (rowid = NEW.rowid AND NEW.rowid <> -1) OR (id = NEW.id AND task_id IS NOT NEW.task_id)
        )
      BEGIN SELECT RAISE(ABORT, 'record_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS certificates_insert_once AFTER INSERT ON certificates
      BEGIN
        SELECT RAISE(ABORT, 'record_append_only') FROM certified_tasks WHERE task_id = NEW.task_id;
        INSERT INTO certified_tasks(task_id) VALUES (NEW.task_id);
      END;
      CREATE TRIGGER IF NOT EXISTS certificates_no_rekey BEFORE UPDATE ON certificates
        WHEN NEW.rowid IS NOT OLD.rowid OR NEW.task_id IS NOT OLD.task_id
          OR EXISTS (SELECT 1 FROM certificates WHERE id = NEW.id AND rowid IS NOT OLD.rowid)
      BEGIN SELECT RAISE(ABORT, 'record_append_only'); END;
      ${["receipts", "workflow_events", "approval_decisions", "capability_usage", "idempotency_commits", "certificate_history", "certified_tasks"]
        .map(appendOnly)
        .join("")}
      ${[
        ["receipts", "id = NEW.id", "ABORT, 'record_append_only'"],
        [
          "workflow_events",
          "id = NEW.id OR (aggregate_id = NEW.aggregate_id AND sequence = NEW.sequence)",
          "ABORT, 'record_append_only'",
        ],
        ["approval_decisions", "approval_id = NEW.approval_id", "IGNORE"],
        ["capability_usage", "grant_id = NEW.grant_id AND task_id = NEW.task_id", "IGNORE"],
        ["idempotency_commits", "idempotency_key = NEW.idempotency_key", "IGNORE"],
        ["certified_tasks", "task_id = NEW.task_id", "IGNORE"],
      ]
        .map(([table, key, raise]) => keyedOnce(table!, key!, raise!))
        .join("")}
    `,
    );
    // Migration 8 records an operator's no to a challenge, once per challenge,
    // and the answers refused for coming from the agent's side or for not
    // matching what they answer (#424). A refusal is kept once per task or
    // run and code: one row per record that exists, however often the same
    // one is sent. Both are append-only as migration 7's tables are. Only new
    // code writes either, so an older MELRA sharing the home writes as before.
    this.applyMigration(
      8,
      `
      CREATE TABLE IF NOT EXISTS approval_denials (
        approval_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        render_digest TEXT NOT NULL,
        operation_digest TEXT NOT NULL,
        channel TEXT NOT NULL,
        approver TEXT NOT NULL,
        reason TEXT NOT NULL,
        note TEXT,
        decided_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refusals (
        subject_id TEXT NOT NULL,
        code TEXT NOT NULL,
        kind TEXT NOT NULL,
        mode TEXT NOT NULL,
        principal TEXT,
        client TEXT,
        refused_at TEXT NOT NULL,
        PRIMARY KEY(subject_id, code)
      );
      CREATE INDEX IF NOT EXISTS refusals_refused_at ON refusals(refused_at);
      ${appendOnly("approval_denials")}
      ${keyedOnce("approval_denials", "approval_id = NEW.approval_id", "IGNORE")}
      ${appendOnly("refusals")}
      ${keyedOnce("refusals", "subject_id = NEW.subject_id AND code = NEW.code", "IGNORE")}
    `,
    );
    // Migration 9 chains the records migrations 7 and 8 keep (see CHAINED):
    // each link is an HMAC, under a key derived from the payload key, of the
    // link before it, its record's digest and whether a start swept it, so
    // rewriting, removing or reordering a sealed record breaks the chain for
    // anyone without the key, and a head kept outside MELRA shows a removed
    // tail. Sealing happens in the transaction that writes the record, and for
    // what an older MELRA writes, which knows no chain, at the next start of one
    // that does (`sealRecords`), marked swept. Nothing here touches the chained
    // tables, so an older MELRA writes them as before; the index finds a
    // replaced certificate.
    this.applyMigration(
      9,
      `
      CREATE TABLE IF NOT EXISTS record_chain (
        sequence INTEGER PRIMARY KEY,
        record_table TEXT NOT NULL,
        record_key TEXT NOT NULL,
        record_digest TEXT NOT NULL,
        previous_link TEXT NOT NULL,
        link TEXT NOT NULL,
        swept INTEGER NOT NULL,
        UNIQUE(record_table, record_key)
      );
      CREATE INDEX IF NOT EXISTS certificate_history_certificate ON certificate_history(certificate_id);
      ${appendOnly("record_chain")}
      ${keyedOnce("record_chain", "record_table = NEW.record_table AND record_key = NEW.record_key", "ABORT, 'record_append_only'")}
    `,
    );
  }

  private applyMigration(version: number, statements: string): void {
    this.transaction(() => {
      const applied = this.database
        .prepare("SELECT version FROM schema_migrations WHERE version = ?")
        .get(version);
      if (applied !== undefined) return;
      this.database.exec(statements);
      this.database
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
        )
        .run(version, new Date().toISOString());
    });
  }

  /**
   * Runs `action` as one write transaction: another process sharing the
   * database waits, so nothing it read changes before it writes, and a throw
   * undoes every write it made. `action` must not call a method that opens a
   * transaction of its own.
   */
  transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      // SQLite may have rolled it back already (a full disk does), and the
      // ROLLBACK's own "no transaction is active" would then hide why.
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  /**
   * Seals, under `key`, every chained record no link seals yet, and from now
   * on each one this store writes, in the transaction that writes it. What an
   * older MELRA wrote is sealed here, by the next start that has the key, and
   * so is anything else written to the file meanwhile, or left without its
   * link: the chain shows what changed after it was last sealed, not who wrote
   * it, and marks these links swept. Returns how many it found unsealed.
   */
  sealRecords(key: Buffer): number {
    this.chainKey = Buffer.from(key);
    const pending = (Object.keys(CHAINED) as ChainedTable[]).flatMap((table) =>
      this.unsealedKeys(table).map((recordKey) => [table, recordKey] as const),
    );
    // In batches, so sealing a large home the first time never holds the
    // write lock long enough for another process's busy timeout to run out.
    for (let at = 0; at < pending.length; at += 500) {
      this.transaction(() => {
        for (const [table, recordKey] of pending.slice(at, at + 500)) {
          this.seal(table, JSON.parse(recordKey) as unknown[], 1);
        }
      });
    }
    return pending.length;
  }

  /** The chain's last link, for an operator to keep where MELRA cannot write; sequence 0 before the first. */
  chainHead(): ChainHead {
    const row = this.hasTable("record_chain")
      ? (this.database.prepare("SELECT sequence, link FROM record_chain ORDER BY sequence DESC LIMIT 1").get() as
          | ChainHead
          | undefined)
      : undefined;
    return row === undefined ? { sequence: 0, link: GENESIS } : { sequence: row.sequence, link: row.link };
  }

  /**
   * Walks the chain under `key`: each link must follow the one before it, be
   * the HMAC MELRA made, and seal a record still there as it was sealed; then
   * no row of a chained table may be unsealed. Swept links pass, counted, and
   * those after a link made at write time are reported as `late`. With
   * `kept`, a head an operator kept from `chainHead`, the chain must still
   * pass through it, the only way a removed tail shows. It only reads, so an observer's store can run it, in
   * one read transaction, so a writer beside it is seen at one moment.
   */
  verifyChain(key: Buffer, kept?: ChainHead): ChainReport {
    this.database.exec("BEGIN");
    try {
      const present = (Object.keys(CHAINED) as ChainedTable[]).filter((table) => this.hasTable(table));
      let last: ChainHead = { sequence: 0, link: GENESIS };
      let swept = 0;
      let written = false;
      let late: ChainReport["late"];
      const passes = () => kept === undefined || kept.sequence !== last.sequence || kept.link === last.link;
      let found: ChainReport["break"] = passes() ? undefined : { reason: "head_mismatch", sequence: 0 };
      if (found === undefined && this.hasTable("record_chain")) {
        const rows = this.database.prepare(`
          SELECT sequence, record_table AS recordTable, record_key AS recordKey,
            record_digest AS recordDigest, previous_link AS previousLink, link, swept
          FROM record_chain ORDER BY sequence
        `);
        for (const row of rows.iterate() as Iterable<ChainRow>) {
          found = this.linkBreak(key, last, row, present);
          if (found !== undefined) break;
          if (row.swept === 0) written = true;
          else if (written) {
            late ??= { count: 0, sequence: row.sequence, table: row.recordTable, key: row.recordKey };
            late.count += 1;
          }
          swept += row.swept;
          last = { sequence: row.sequence, link: row.link };
          if (!passes()) {
            found = { reason: "head_mismatch", sequence: row.sequence };
            break;
          }
        }
      }
      if (found === undefined && kept !== undefined && kept.sequence > last.sequence) {
        found = { reason: "head_truncated", sequence: kept.sequence };
      }
      let unsealed = 0;
      for (const table of present) {
        const keys = this.unsealedKeys(table);
        unsealed += keys.length;
        if (found === undefined && keys.length > 0) found = { reason: "unsealed_rows", table, key: keys[0]! };
      }
      return {
        ok: found === undefined,
        head: this.chainHead(),
        unsealed,
        swept,
        ...(late === undefined ? {} : { late }),
        ...(found === undefined ? {} : { break: found }),
      };
    } finally {
      this.database.exec("ROLLBACK");
    }
  }

  private linkBreak(
    key: Buffer,
    last: ChainHead,
    row: ChainRow,
    present: readonly ChainedTable[],
  ): ChainReport["break"] {
    if (row.sequence !== last.sequence + 1) return { reason: "sequence_gap", sequence: last.sequence + 1 };
    const at = { sequence: row.sequence, table: row.recordTable, key: row.recordKey };
    if (row.previousLink !== last.link || row.link !== chainLink(key, last.link, row.recordDigest, row.swept)) {
      return { reason: "link_forged", ...at };
    }
    // Looked up only under a name this code knows, never one read from the row.
    const table = present.find((name) => name === row.recordTable);
    let records: Array<Record<string, unknown>> = [];
    try {
      if (table !== undefined) records = this.records(table, JSON.parse(row.recordKey) as unknown[]);
    } catch {
      // A key that is not one this store wrote names no record.
    }
    if (records.length === 0) return { reason: "record_removed", ...at };
    // A certificate's id is its own version's, so every row under it is the one sealed.
    return records.some(({ record_key: _, ...record }) => recordDigest(table!, record) !== row.recordDigest)
      ? { reason: "record_changed", ...at }
      : undefined;
  }

  /** The rows of `table` under `key`: one, or a certificate's every version under its id. */
  private records(table: ChainedTable, key: readonly unknown[]): Array<Record<string, unknown>> {
    return this.database
      .prepare(`SELECT * FROM (${chainedRows(table)}) WHERE ${CHAINED[table].key.map((name) => `${name} IS ?`).join(" AND ")}`)
      .all(...(key as Array<string | number | null>)) as Array<Record<string, unknown>>;
  }

  /** The keys of `table`'s records no link seals; every one where no chain exists yet. */
  private unsealedKeys(table: ChainedTable): string[] {
    const sealed = this.hasTable("record_chain")
      ? `WHERE NOT EXISTS (SELECT 1 FROM record_chain WHERE record_table = '${table}' AND record_key = r.record_key)`
      : "";
    const rows = this.database
      .prepare(`SELECT record_key AS recordKey FROM (${chainedRows(table)}) AS r ${sealed}`)
      .all() as unknown as Array<{ recordKey: string }>;
    return rows.map((row) => row.recordKey);
  }

  /**
   * Appends a link sealing `table`'s record under `key`, unless one does
   * already. With `expected`, only when every row under the key has that
   * digest. Inside a write transaction.
   */
  private seal(table: ChainedTable, key: readonly unknown[], swept: 0 | 1, expected?: string): void {
    const rows = this.records(table, key);
    const [row] = rows;
    if (row === undefined) return;
    const { record_key: recordKey, ...record } = row;
    const sealed = this.database
      .prepare("SELECT 1 FROM record_chain WHERE record_table = ? AND record_key = ?")
      .get(table, recordKey as string);
    if (sealed !== undefined) return;
    const digest = recordDigest(table, record);
    if (expected !== undefined && rows.some(({ record_key: _, ...other }) => recordDigest(table, other) !== expected)) return;
    const head = this.chainHead();
    this.database
      .prepare(`
        INSERT INTO record_chain(sequence, record_table, record_key, record_digest, previous_link, link, swept)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(head.sequence + 1, table, recordKey as string, digest, head.link, chainLink(this.chainKey!, head.link, digest, swept), swept);
  }

  /**
   * `write` with `values`, the table's chained columns in order, and the
   * record it wrote sealed, in one transaction (the caller's, when it is in
   * one), so a record and its link commit together or not at all.
   */
  private sealing<T>(table: ChainedTable, values: readonly Bound[], write: (values: readonly Bound[]) => T): T {
    if (this.chainKey === undefined) return write(values);
    const { key, columns } = CHAINED[table];
    const written = Object.fromEntries(columns.map((name, index) => [name, values[index]]));
    const sealed = () => {
      const result = write(values);
      // Only what this write bound: a row under the key holding anything else
      // (an ignored insert's, or one a trigger planted or changed) is not this
      // write's, so the sweep seals it, marked as swept.
      this.seal(table, key.map((name) => written[name]), 0, recordDigest(table, written));
      return result;
    };
    return this.inTransaction ? sealed() : this.transaction(sealed);
  }

  private addColumnIfMissing(
    table: string,
    column: string,
    definition: string,
  ): void {
    const columns = this.database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as unknown as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  /** Without `owner`, a save keeps whichever owner the row already has. */
  saveTask(task: TaskRecord, owner?: string): void {
    this.database
      .prepare(`
        INSERT INTO tasks(id, data, created_at, updated_at, owner)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          data = excluded.data,
          updated_at = excluded.updated_at,
          owner = COALESCE(excluded.owner, tasks.owner)
      `)
      .run(task.id, JSON.stringify(task), task.createdAt, task.updatedAt, owner ?? null);
  }

  /**
   * `saveTask` only while the stored status is one of `expected`, saying
   * whether it wrote: a compare-and-set, so of two processes moving one task
   * out of a status (an execute and a deny, or two executes) exactly one does.
   */
  saveTaskIf(task: TaskRecord, expected: readonly TaskRecord["status"][], owner?: string): boolean {
    const result = this.database
      .prepare(`
        UPDATE tasks SET data = ?, updated_at = ?, owner = COALESCE(?, owner)
        WHERE id = ? AND json_extract(data, '$.status') IN (SELECT value FROM json_each(?))
      `)
      .run(JSON.stringify(task), task.updatedAt, owner ?? null, task.id, JSON.stringify(expected));
    return Number(result.changes) === 1;
  }

  /**
   * This store's owner id, created on first use. "Alive" means someone holds
   * an exclusive SQLite lock on `<db>-owners/<id>`; the kernel drops that lock
   * however the process ends, so a crash needs no clock or heartbeat to show.
   * The lock is taken before the id is returned, so no row can ever name an
   * owner whose lock was not yet held.
   */
  ownerId(): string {
    if (this.owner !== undefined) return this.owner.id;
    const id = randomUUID();
    if (this.path === ":memory:") return (this.owner = { id }).id;
    const directory = `${this.path}-owners`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.pruneOwners(directory);
    const file = join(directory, id);
    const lock = new DatabaseSync(file);
    // Never open these files through node:fs in the holding process: POSIX
    // drops all of a process's locks on an inode when any descriptor to it
    // closes. SQLite defers its own closes, so its probes are safe, and the
    // server reserves this directory from its file adapters. The write is
    // synced, so no row can name a file a power cut left unreadable.
    lock.exec(
      "PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = MEMORY; PRAGMA user_version = 1",
    );
    this.owner = { id, lock, file };
    return id;
  }

  /**
   * Deletes lock files whose process is gone, which a crash or an exit without
   * `close()` leaves behind. Only files older than a minute: a younger one may
   * belong to a process that has created it and not yet locked it.
   */
  private pruneOwners(directory: string): void {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name);
      try {
        if (Date.now() - statSync(file).mtimeMs < 60_000) continue;
        if (!this.ownerAlive(name)) rmSync(file, { force: true });
      } catch {
        // Gone already, or still open in a peer's probe on Windows.
      }
    }
  }

  private ownerAlive(id: string): boolean {
    if (id === this.owner?.id) return true;
    const file = join(`${this.path}-owners`, id);
    if (!existsSync(file)) return false;
    let probe: DatabaseSync | undefined;
    try {
      // node:sqlite's busy timeout is 0, so a held lock answers at once.
      probe = new DatabaseSync(file, { readOnly: true });
      probe.prepare("SELECT count(*) FROM sqlite_master").get();
      return false;
    } catch {
      // Busy means alive. Any other failure counts as alive too: recovery never
      // rewrites a task on a guess.
      return true;
    } finally {
      probe?.close();
    }
  }

  /**
   * Takes over a running or verifying task whose owner is gone, or returns
   * undefined. The compare-and-set on the owner means that of two recoverers
   * only one gets the task, and a live owner's task is never handed out. This
   * store's own rows count as abandoned when nothing here has them in flight.
   */
  claimInterruptedTask(id: string): TaskRecord | undefined {
    const row = this.database
      .prepare("SELECT owner FROM tasks WHERE id = ?")
      .get(id) as { owner: string | null } | undefined;
    const orphaned = row?.owner === this.owner?.id && !this.inFlight.has(id);
    if (
      row === undefined ||
      (row.owner !== null && !orphaned && this.ownerAlive(row.owner))
    ) {
      return undefined;
    }
    const claimed = this.database
      .prepare(`
        UPDATE tasks SET owner = ?
        WHERE id = ? AND owner IS ?
          AND json_extract(data, '$.status') IN ('running', 'verifying')
        RETURNING data
      `)
      .get(this.ownerId(), id, row.owner) as JsonRow | undefined;
    return claimed === undefined ? undefined : (JSON.parse(claimed.data) as TaskRecord);
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.database
      .prepare("SELECT data FROM tasks WHERE id = ?")
      .get(id) as JsonRow | undefined;
    return row === undefined ? undefined : (JSON.parse(row.data) as TaskRecord);
  }

  // The status filter runs in SQL, before the limit: filtering the newest N
  // afterwards would silently drop older matches.
  listTasks(limit = 50, status?: TaskRecord["status"]): TaskRecord[] {
    const rows = (
      status === undefined
        ? this.database
            .prepare("SELECT data FROM tasks ORDER BY updated_at DESC LIMIT ?")
            .all(limit)
        : this.database
            .prepare(
              "SELECT data FROM tasks WHERE json_extract(data, '$.status') = ? ORDER BY updated_at DESC LIMIT ?",
            )
            .all(status, limit)
    ) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.data) as TaskRecord);
  }

  /**
   * Up to `limit` ids starting with `prefix` (in `status`, if given), matched in
   * SQL over every task: a prefix any listing printed is found however many
   * tasks have been updated since.
   */
  taskIdsWithPrefix(prefix: string, limit: number, status?: TaskRecord["status"]): string[] {
    const rows = (
      status === undefined
        ? this.database
            .prepare("SELECT id FROM tasks WHERE substr(id, 1, ?) = ? LIMIT ?")
            .all(prefix.length, prefix, limit)
        : this.database
            .prepare(
              "SELECT id FROM tasks WHERE substr(id, 1, ?) = ? AND json_extract(data, '$.status') = ? LIMIT ?",
            )
            .all(prefix.length, prefix, status, limit)
    ) as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * Tasks waiting on a semantic judgement (#54) whose wait is over, oldest
   * first, and only those: the sweep that settles them should neither parse
   * every waiting row nor let newer ones crowd out the oldest. A task's
   * judgements share one `expiresAt`, which the kernel writes as an ISO
   * string, so the comparison is a string one; a row with none is due.
   */
  listExpiredJudgements(now: string): TaskRecord[] {
    const rows = this.database
      .prepare(`
        SELECT data FROM tasks
        WHERE json_extract(data, '$.status') = 'waiting_user'
          AND coalesce(json_extract(data, '$.judgements[0].expiresAt'), '') <= ?
        ORDER BY updated_at ASC
      `)
      .all(now) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.data) as TaskRecord);
  }

  /**
   * One caller's tasks awaiting approval whose challenge has not expired, by
   * the caller `callerRef` names (#422). Read on every challenge planned, so
   * the expired ones, which stay awaiting_approval and which nothing sweeps,
   * are left in SQL; `expiresAt` is an ISO string, compared as one.
   */
  listOpenChallenges(client: string, now: string): TaskRecord[] {
    const rows = this.database
      .prepare(`
        SELECT data FROM tasks
        WHERE json_extract(data, '$.status') = 'awaiting_approval'
          AND json_extract(data, '$.client') = ?
          AND json_extract(data, '$.approval.expiresAt') > ?
      `)
      .all(client, now) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.data) as TaskRecord);
  }

  /**
   * Parked tasks whose reconciliation missed inside its settle window (#418),
   * oldest first: no caller is bound to ask them again, so recovery does.
   */
  listSettlingTaskIds(): string[] {
    const rows = this.database
      .prepare(`
        SELECT id FROM tasks
        WHERE json_extract(data, '$.status') = 'recovery_required'
          AND json_extract(data, '$.error') = 'reconciliation_settling'
        ORDER BY updated_at ASC
      `)
      .all() as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /** Every task planned under one idempotency key, any status, found by its index. */
  listTasksByKey(idempotencyKey: string): TaskRecord[] {
    const rows = this.database
      .prepare("SELECT data FROM tasks WHERE json_extract(data, '$.idempotencyKey') = ?")
      .all(idempotencyKey) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.data) as TaskRecord);
  }

  /** Counted in SQL so a summary does not have to load every task to add them up. */
  taskStatusCounts(): Record<string, number> {
    const rows = this.database
      .prepare(
        "SELECT json_extract(data, '$.status') AS status, COUNT(*) AS count FROM tasks GROUP BY 1",
      )
      .all() as unknown as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }

  /**
   * One task or workflow payload sealed here, with the context it was sealed
   * under, for a start to check its key against; undefined while none is.
   */
  sealedPayloadSample(): { context: string; payload: EncryptedPayload } | undefined {
    const row = this.database
      .prepare(`
        SELECT 'task:' || task_id || ':request' AS context, request_payload AS data FROM task_payloads
        UNION ALL
        SELECT 'workflow:' || workflow_id || ':' || workflow_version || ':definition', payload FROM workflow_payloads
        LIMIT 1
      `)
      .get() as (JsonRow & { context: string }) | undefined;
    return row === undefined
      ? undefined
      : { context: row.context, payload: parseStored(row.data, EncryptedPayloadSchema, "stored_payload_invalid") };
  }

  saveTaskPayload(
    taskId: string,
    payload: EncryptedPayload,
    at: string,
  ): void {
    const parsed = EncryptedPayloadSchema.parse(payload);
    this.database
      .prepare(`
        INSERT INTO task_payloads(
          task_id, request_payload, result_payload, created_at, updated_at
        )
        VALUES (?, ?, NULL, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          request_payload = excluded.request_payload,
          updated_at = excluded.updated_at
      `)
      .run(taskId, JSON.stringify(parsed), at, at);
  }

  getTaskPayload(taskId: string): EncryptedPayload | undefined {
    const row = this.database
      .prepare(
        "SELECT request_payload AS data FROM task_payloads WHERE task_id = ?",
      )
      .get(taskId) as JsonRow | undefined;
    return row === undefined
      ? undefined
      : parseStored(
          row.data,
          EncryptedPayloadSchema,
          "stored_task_payload_invalid",
        );
  }

  saveTaskExecutionResult(
    task: TaskRecord,
    payload: EncryptedPayload,
  ): void {
    const parsed = EncryptedPayloadSchema.parse(payload);
    this.transaction(() => {
      this.saveTask(task);
      const result = this.database
        .prepare(`
          UPDATE task_payloads
          SET result_payload = ?, updated_at = ?
          WHERE task_id = ?
        `)
        .run(JSON.stringify(parsed), task.updatedAt, task.id);
      if (Number(result.changes) !== 1) {
        throw new Error("task_payload_not_found");
      }
    });
  }

  getTaskResult(taskId: string): EncryptedPayload | undefined {
    const row = this.database
      .prepare(
        "SELECT result_payload AS data FROM task_payloads WHERE task_id = ?",
      )
      .get(taskId) as NullableJsonRow | undefined;
    return row === undefined || row.data === null
      ? undefined
      : parseStored(
          row.data,
          EncryptedPayloadSchema,
          "stored_task_result_invalid",
        );
  }

  deleteTaskPayload(taskId: string): void {
    this.database
      .prepare("DELETE FROM task_payloads WHERE task_id = ?")
      .run(taskId);
  }

  listInterruptedTasks(): TaskRecord[] {
    const rows = this.database
      .prepare(`
        SELECT data FROM tasks
        WHERE json_extract(data, '$.status') IN ('running', 'verifying')
        ORDER BY updated_at
      `)
      .all() as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.data) as TaskRecord);
  }

  getWorkflowPayload(
    id: string,
    version: number,
  ): EncryptedPayload | undefined {
    const row = this.database
      .prepare(`
        SELECT payload AS data FROM workflow_payloads
        WHERE workflow_id = ? AND workflow_version = ?
      `)
      .get(id, version) as JsonRow | undefined;
    return row === undefined
      ? undefined
      : parseStored(
          row.data,
          EncryptedPayloadSchema,
          "stored_workflow_payload_invalid",
        );
  }

  /**
   * Store a new run. `payload` undefined means the definition is already
   * stored under this id and version (the caller has checked it is the same
   * one), so only the run and its events are written.
   */
  createWorkflow(
    redactedDefinition: unknown,
    payload: EncryptedPayload | undefined,
    run: WorkflowRun,
    events: WorkflowEvent[],
  ): void {
    const definition = RedactedWorkflowDefinitionSchema.parse(redactedDefinition);
    const sealed = payload === undefined ? undefined : EncryptedPayloadSchema.parse(payload);
    if (sealed === undefined && this.getWorkflowPayload(definition.id, definition.version) === undefined) {
      throw new Error("workflow_payload_not_found");
    }
    const projection = WorkflowRunSchema.parse(run);
    const parsedEvents = events.map((item) => WorkflowEventSchema.parse(item));
    if (
      definition.id !== projection.definitionId ||
      definition.version !== projection.definitionVersion
    ) {
      throw new Error("workflow_definition_mismatch");
    }
    this.assertWorkflowEvents(
      projection.id,
      projection.traceId,
      0,
      projection.stateVersion,
      parsedEvents,
    );

    this.transaction(() => {
      if (sealed !== undefined) {
        this.database
          .prepare(`
            INSERT INTO workflow_definitions(id, version, data, created_at)
            VALUES (?, ?, ?, ?)
          `)
          .run(
            definition.id,
            definition.version,
            JSON.stringify(definition),
            projection.createdAt,
          );
        this.database
          .prepare(`
            INSERT INTO workflow_payloads(
              workflow_id, workflow_version, payload, created_at
            )
            VALUES (?, ?, ?, ?)
          `)
          .run(
            definition.id,
            definition.version,
            JSON.stringify(sealed),
            projection.createdAt,
          );
      }
      this.database
        .prepare(`
          INSERT INTO workflow_runs(
            id, definition_id, definition_version, state_version, data,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          projection.id,
          projection.definitionId,
          projection.definitionVersion,
          projection.stateVersion,
          JSON.stringify(projection),
          projection.createdAt,
          projection.updatedAt,
        );
      for (const item of parsedEvents) this.insertWorkflowEvent(item);
    });
  }

  getWorkflowDefinition(
    id: string,
    version: number,
  ): RedactedWorkflowDefinition | undefined {
    const row = this.database
      .prepare(`
        SELECT data FROM workflow_definitions WHERE id = ? AND version = ?
      `)
      .get(id, version) as JsonRow | undefined;
    return row === undefined
      ? undefined
      : parseStored(
          row.data,
          RedactedWorkflowDefinitionSchema,
          "stored_workflow_definition_invalid",
        );
  }

  getWorkflowRun(id: string): WorkflowRun | undefined {
    const row = this.database
      .prepare("SELECT data FROM workflow_runs WHERE id = ?")
      .get(id) as JsonRow | undefined;
    return row === undefined
      ? undefined
      : parseStored(
          row.data,
          WorkflowRunSchema,
          "stored_workflow_run_invalid",
        );
  }

  listWorkflowRuns(
    statuses: WorkflowRun["status"][] = [],
  ): WorkflowRun[] {
    const rows =
      statuses.length === 0
        ? (this.database
            .prepare("SELECT data FROM workflow_runs ORDER BY updated_at")
            .all() as unknown as JsonRow[])
        : (this.database
            .prepare(`
              SELECT data FROM workflow_runs
              WHERE json_extract(data, '$.status') IN (
                ${statuses.map(() => "?").join(", ")}
              )
              ORDER BY updated_at
            `)
            .all(...statuses) as unknown as JsonRow[]);
    return rows.map((row) =>
      parseStored(
        row.data,
        WorkflowRunSchema,
        "stored_workflow_run_invalid",
      ),
    );
  }

  listWorkflowEvents(
    id: string,
    afterSequence = 0,
    limit = -1,
  ): WorkflowEvent[] {
    const rows = this.database
      .prepare(`
        SELECT data FROM workflow_events
        WHERE aggregate_id = ? AND sequence > ?
        ORDER BY sequence
        LIMIT ?
      `)
      .all(id, afterSequence, limit) as unknown as JsonRow[];
    return rows.map((row) =>
      parseStored(
        row.data,
        WorkflowEventSchema,
        "stored_workflow_event_invalid",
      ),
    );
  }

  saveWorkflowSnapshot(snapshot: WorkflowSnapshot): void {
    const parsed = WorkflowSnapshotSchema.parse(snapshot);
    this.database
      .prepare(`
        INSERT INTO workflow_snapshots(
          workflow_id, sequence, data, created_at
        )
        VALUES (?, ?, ?, ?)
      `)
      .run(
        parsed.workflowId,
        parsed.sequence,
        JSON.stringify(parsed),
        parsed.createdAt,
      );
  }

  getLatestWorkflowSnapshot(id: string): WorkflowSnapshot | undefined {
    const row = this.database
      .prepare(`
        SELECT data FROM workflow_snapshots
        WHERE workflow_id = ?
        ORDER BY sequence DESC
        LIMIT 1
      `)
      .get(id) as JsonRow | undefined;
    return row === undefined
      ? undefined
      : parseStored(
          row.data,
          WorkflowSnapshotSchema,
          "stored_workflow_snapshot_invalid",
        );
  }

  /** With `snapshot`, that snapshot is saved in the same transaction. */
  transitionWorkflow(
    id: string,
    expectedStateVersion: number,
    run: WorkflowRun,
    events: WorkflowEvent[],
    snapshot?: WorkflowSnapshot,
  ): void {
    const projection = WorkflowRunSchema.parse(run);
    const parsedEvents = events.map((item) => WorkflowEventSchema.parse(item));
    this.assertWorkflowEvents(
      id,
      projection.traceId,
      expectedStateVersion,
      projection.stateVersion,
      parsedEvents,
    );
    if (projection.id !== id) throw new Error("workflow_projection_id_mismatch");

    this.transaction(() => {
      const current = this.database
        .prepare(
          `SELECT state_version AS stateVersion, data
           FROM workflow_runs WHERE id = ?`,
        )
        .get(id) as StateVersionRow | undefined;
      if (current === undefined) throw new Error("workflow_not_found");
      if (current.stateVersion !== expectedStateVersion) {
        throw new Error("workflow_state_conflict");
      }
      const stored = parseStored(
        current.data,
        WorkflowRunSchema,
        "stored_workflow_run_invalid",
      );
      if (
        projection.definitionId !== stored.definitionId ||
        projection.definitionVersion !== stored.definitionVersion ||
        projection.traceId !== stored.traceId
      ) {
        throw new Error("workflow_projection_identity_mismatch");
      }
      for (const item of parsedEvents) this.insertWorkflowEvent(item);
      const updated = this.database
        .prepare(`
          UPDATE workflow_runs
          SET state_version = ?, data = ?, updated_at = ?
          WHERE id = ? AND state_version = ?
        `)
        .run(
          projection.stateVersion,
          JSON.stringify(projection),
          projection.updatedAt,
          id,
          expectedStateVersion,
        );
      if (Number(updated.changes) !== 1) {
        throw new Error("workflow_state_conflict");
      }
      if (snapshot !== undefined) this.saveWorkflowSnapshot(snapshot);
    });
  }

  // Cross-process mutual exclusion for one workflow. `BEGIN IMMEDIATE` in
  // `transaction` takes SQLite's write lock, so two server processes sharing a
  // data directory serialize here and exactly one wins the row. Leases expire
  // so a killed process cannot strand a workflow forever.
  acquireWorkflowLease(
    workflowId: string,
    owner: string,
    now: string,
    expiresAt: string,
  ): boolean {
    return this.takeWorkflowLease(workflowId, owner, now, expiresAt) !== "refused";
  }

  /**
   * `acquireWorkflowLease`, saying whether a lease was already there. Recovery
   * needs that: an expired lease it replaced marks a run still waiting for a
   * repair, while a lease it created means whoever held one released it.
   */
  takeWorkflowLease(
    workflowId: string,
    owner: string,
    now: string,
    expiresAt: string,
  ): "refused" | "created" | "replaced" {
    return this.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT owner, expires_at AS expiresAt
           FROM workflow_leases WHERE workflow_id = ?`,
        )
        .get(workflowId) as
        | { owner: string; expiresAt: string }
        | undefined;
      if (
        existing !== undefined &&
        existing.owner !== owner &&
        existing.expiresAt > now
      ) {
        return "refused";
      }
      this.database
        .prepare(`
          INSERT INTO workflow_leases(
            workflow_id, owner, acquired_at, expires_at
          )
          VALUES (?, ?, ?, ?)
          ON CONFLICT(workflow_id) DO UPDATE SET
            owner = excluded.owner,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at
        `)
        .run(workflowId, owner, now, expiresAt);
      return existing === undefined ? "created" : "replaced";
    });
  }

  renewWorkflowLease(
    workflowId: string,
    owner: string,
    expiresAt: string,
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE workflow_leases SET expires_at = ?
         WHERE workflow_id = ? AND owner = ?`,
      )
      .run(expiresAt, workflowId, owner);
    return Number(result.changes) === 1;
  }

  releaseWorkflowLease(workflowId: string, owner: string): void {
    this.database
      .prepare(
        "DELETE FROM workflow_leases WHERE workflow_id = ? AND owner = ?",
      )
      .run(workflowId, owner);
  }

  /** Gives back a claim this store holds, so any process may take the task next. */
  releaseTaskClaim(id: string): void {
    if (this.owner === undefined) return;
    this.database
      .prepare("UPDATE tasks SET owner = NULL WHERE id = ? AND owner = ?")
      .run(id, this.owner.id);
  }

  expiredWorkflowLeases(now: string): string[] {
    const rows = this.database
      .prepare("SELECT workflow_id AS id FROM workflow_leases WHERE expires_at <= ?")
      .all(now) as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  getWorkflowLease(
    workflowId: string,
  ): { owner: string; acquiredAt: string; expiresAt: string } | undefined {
    return this.database
      .prepare(`
        SELECT owner, acquired_at AS acquiredAt, expires_at AS expiresAt
        FROM workflow_leases WHERE workflow_id = ?
      `)
      .get(workflowId) as
      | { owner: string; acquiredAt: string; expiresAt: string }
      | undefined;
  }

  commitIdempotency(
    key: string,
    taskId: string,
    attempt: number,
    at: string,
  ): boolean {
    return this.sealing("idempotency_commits", [key, taskId, attempt, at], (values) => {
      const result = this.database
        .prepare(`
          INSERT OR IGNORE INTO idempotency_commits(
            idempotency_key, task_id, attempt, committed_at
          )
          VALUES (?, ?, ?, ?)
        `)
        .run(...values);
      return Number(result.changes) === 1;
    });
  }

  getIdempotencyCommit(
    key: string,
  ): IdempotencyCommitRow | undefined {
    return this.database
      .prepare(`
        SELECT task_id AS taskId, attempt, committed_at AS committedAt
        FROM idempotency_commits
        WHERE idempotency_key = ?
      `)
      .get(key) as IdempotencyCommitRow | undefined;
  }

  /** False when a decision for this approval was already recorded. */
  recordApprovalDecision(decision: ApprovalDecision): boolean {
    const values = [
      decision.approvalId,
      decision.taskId,
      decision.renderDigest,
      decision.channel,
      decision.approver,
      decision.decidedAt,
    ];
    return this.sealing("approval_decisions", values, (bound) => {
      const result = this.database
        .prepare(`
          INSERT OR IGNORE INTO approval_decisions(
            approval_id, task_id, render_digest, channel, approver, decided_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(...bound);
      return Number(result.changes) === 1;
    });
  }

  getApprovalDecision(approvalId: string): ApprovalDecision | undefined {
    return this.database
      .prepare(`
        SELECT approval_id AS approvalId, task_id AS taskId,
          render_digest AS renderDigest, channel, approver,
          decided_at AS decidedAt
        FROM approval_decisions WHERE approval_id = ?
      `)
      .get(approvalId) as ApprovalDecision | undefined;
  }

  /** False when this challenge already has a denial. */
  recordApprovalDenial(denial: ApprovalDenial): boolean {
    const values = [
      denial.approvalId,
      denial.taskId,
      denial.renderDigest,
      denial.operationDigest,
      denial.channel,
      denial.approver,
      denial.reason,
      denial.note ?? null,
      denial.decidedAt,
    ];
    return this.sealing("approval_denials", values, (bound) => {
      const result = this.database
        .prepare(`
          INSERT OR IGNORE INTO approval_denials(
            approval_id, task_id, render_digest, operation_digest, channel,
            approver, reason, note, decided_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(...bound);
      return Number(result.changes) === 1;
    });
  }

  /** Silent on a repeat: the first refusal of a code for a task or run is the one kept. */
  recordRefusal(refusal: Refusal): void {
    const values = [
      refusal.subjectId,
      refusal.code,
      refusal.kind,
      refusal.mode,
      refusal.principal ?? null,
      refusal.client ?? null,
      refusal.refusedAt,
    ];
    this.sealing("refusals", values, (bound) => {
      this.database
        .prepare(`
          INSERT OR IGNORE INTO refusals(
            subject_id, code, kind, mode, principal, client, refused_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(...bound);
    });
  }

  /** The newest `limit` refusals, of the tasks and runs in `subjectIds` if given. */
  listRefusals(limit: number, subjectIds?: readonly string[]): Refusal[] {
    if (!this.recordsRefusals()) return [];
    const rows = this.database
      .prepare(`
        SELECT subject_id AS subjectId, code, kind, mode, principal, client, refused_at AS refusedAt
        FROM refusals
        WHERE ?1 IS NULL OR subject_id IN (SELECT value FROM json_each(?1))
        ORDER BY refused_at DESC LIMIT ?2
      `)
      .all(subjectIds === undefined ? null : JSON.stringify(subjectIds), limit) as unknown as Array<Omit<Refusal, "principal" | "client"> & { principal: string | null; client: string | null }>;
    return rows.map(({ principal, client, ...row }) => ({
      ...row,
      ...(principal === null ? {} : { principal }),
      ...(client === null ? {} : { client }),
    }));
  }

  /**
   * An observer's store never migrates, so a home only an older MELRA has
   * opened has no refusals table yet, and nothing refused recorded in it.
   */
  private recordsRefusals(): boolean {
    return this.hasTable("refusals");
  }

  private hasTable(name: string): boolean {
    return this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  }

  refusalCount(): number {
    if (!this.recordsRefusals()) return 0;
    return Number((this.database.prepare("SELECT COUNT(*) AS count FROM refusals").get() as { count: number }).count);
  }

  /**
   * Draws one operation, and whatever it declared it moved, against a grant.
   *
   * Silent on a repeat: the key is `(grant, task)`, so recovery replaying a
   * task or a receipt being rebuilt cannot spend the grant a second time.
   * Called once the adapter may have run (it returned, or threw an
   * outcome-unknown error), whatever the evidence then says, and never at
   * plan time: a refusal, a cancel before the adapter ran, an adapter error
   * saying nothing went out, or a duplicate stopped before it ran leaves the
   * budget where it found it.
   */
  recordCapabilityUse(
    grantId: string,
    taskId: string,
    amount: number,
    at: string,
  ): void {
    this.sealing("capability_usage", [grantId, taskId, amount, at], (values) => {
      this.database
        .prepare(`
          INSERT OR IGNORE INTO capability_usage(
            grant_id, task_id, amount, committed_at
          )
          VALUES (?, ?, ?, ?)
        `)
        .run(...values);
    });
  }

  /**
   * Whether a task has drawn any grant.
   *
   * ponytail: scans capability_usage, whose key leads with grant_id; asked
   * only when settling a task after the fact. Index task_id if that changes.
   */
  hasCapabilityUse(taskId: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 FROM capability_usage WHERE task_id = ? LIMIT 1")
        .get(taskId) !== undefined
    );
  }

  /**
   * What a grant has spent: every operation ever, and the declared amounts
   * committed at or after `since`.
   */
  capabilityUsage(
    grantId: string,
    since: string,
  ): { operations: number; amountInWindow: number } {
    const row = this.database
      .prepare(`
        SELECT
          COUNT(*) AS operations,
          COALESCE(
            SUM(CASE WHEN committed_at >= ? THEN amount ELSE 0 END), 0
          ) AS amountInWindow
        FROM capability_usage
        WHERE grant_id = ?
      `)
      .get(since, grantId) as
      | { operations: number; amountInWindow: number }
      | undefined;
    return row ?? { operations: 0, amountInWindow: 0 };
  }

  private assertWorkflowEvents(
    workflowId: string,
    traceId: string,
    previousStateVersion: number,
    nextStateVersion: number,
    events: WorkflowEvent[],
  ): void {
    if (
      events.some(
        (item) =>
          item.aggregateId !== workflowId || item.traceId !== traceId,
      )
    ) {
      throw new Error("workflow_event_identity_invalid");
    }
    if (
      events.length === 0 ||
      nextStateVersion !== previousStateVersion + events.length ||
      events.some(
        (item, index) =>
          item.sequence !== previousStateVersion + index + 1,
      )
    ) {
      throw new Error("workflow_event_sequence_invalid");
    }
  }

  private insertWorkflowEvent(event: WorkflowEvent): void {
    const values = [
      event.id,
      event.aggregateId,
      event.sequence,
      event.traceId,
      event.type,
      JSON.stringify(event),
      event.occurredAt,
    ];
    this.sealing("workflow_events", values, (bound) => {
      this.database
        .prepare(`
          INSERT INTO workflow_events(
            id, aggregate_id, sequence, trace_id, type, data, occurred_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(...bound);
    });
  }

  saveReceipt(receipt: ActionReceipt): void {
    const values = [receipt.receiptId, receipt.taskId, JSON.stringify(receipt), receipt.endedAt];
    this.sealing("receipts", values, (bound) => {
      this.database
        .prepare(`
          INSERT INTO receipts(id, task_id, data, created_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(...bound);
    });
  }

  getReceipt(id: string): ActionReceipt | undefined {
    const row = this.database
      .prepare("SELECT data FROM receipts WHERE id = ?")
      .get(id) as JsonRow | undefined;
    return row === undefined ? undefined : (JSON.parse(row.data) as ActionReceipt);
  }

  getReceiptsForTask(taskId: string): ActionReceipt[] {
    const rows = this.database
      .prepare("SELECT data FROM receipts WHERE task_id = ? ORDER BY created_at")
      .all(taskId) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.data) as ActionReceipt);
  }

  /**
   * Stores a task's certificate in place of the one it had, and returns what
   * is stored. With `ifAbsent` one already there stays instead, so two
   * processes certifying the same outcome hand out the same certificate.
   */
  saveCertificate(
    certificate: ExecutionCertificate,
    { ifAbsent = false }: { ifAbsent?: boolean } = {},
  ): ExecutionCertificate {
    // The one it replaces was sealed under its own id, and stays so in certificate_history.
    const values = [certificate.certificateId, certificate.taskId, JSON.stringify(certificate), certificate.createdAt];
    return this.sealing("certificates", values, (bound) => {
      this.database
        .prepare(`
          INSERT INTO certificates(id, task_id, data, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(task_id) DO ${ifAbsent ? "NOTHING" : `UPDATE SET
            id = excluded.id,
            data = excluded.data,
            created_at = excluded.created_at`}
        `)
        .run(...bound);
      return ifAbsent ? this.getCertificateForTask(certificate.taskId)! : certificate;
    });
  }

  getCertificateForTask(taskId: string): ExecutionCertificate | undefined {
    const row = this.database
      .prepare("SELECT data FROM certificates WHERE task_id = ?")
      .get(taskId) as JsonRow | undefined;
    return row === undefined
      ? undefined
      : (JSON.parse(row.data) as ExecutionCertificate);
  }

  putMemory(memory: MemoryRecord): void {
    this.database
      .prepare(`
        INSERT INTO memories(
          id, scope, key, value, source, confidence, tags, speaker, episode_id,
          sequence, expires_at, supersedes_id, superseded_by, created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          scope = excluded.scope,
          key = excluded.key,
          value = excluded.value,
          source = excluded.source,
          confidence = excluded.confidence,
          tags = excluded.tags,
          speaker = excluded.speaker,
          episode_id = excluded.episode_id,
          sequence = excluded.sequence,
          expires_at = excluded.expires_at,
          supersedes_id = excluded.supersedes_id,
          superseded_by = excluded.superseded_by,
          updated_at = excluded.updated_at
      `)
      .run(
        memory.id,
        memory.scope,
        memory.key,
        memory.value,
        memory.source,
        memory.confidence,
        JSON.stringify(memory.tags),
        memory.speaker ?? null,
        memory.episodeId ?? null,
        memory.sequence ?? null,
        memory.expiresAt ?? null,
        memory.supersedesId ?? null,
        memory.supersededBy ?? null,
        memory.createdAt,
        memory.updatedAt,
      );
  }

  getMemory(id: string): MemoryRecord | undefined {
    const row = this.database
      .prepare(`
        SELECT id, scope, key, value, source, confidence, tags, speaker,
               episode_id AS episodeId, sequence,
               expires_at AS expiresAt, supersedes_id AS supersedesId,
               superseded_by AS supersededBy,
               created_at AS createdAt, updated_at AS updatedAt
        FROM memories WHERE id = ?
      `)
      .get(id) as MemoryRow | undefined;
    return row === undefined ? undefined : toMemoryRecord(row);
  }

  listMemories(
    scope: MemoryScope,
    limit: number,
    includeSuperseded = false,
  ): MemoryRecord[] {
    const rows = this.database
      .prepare(`
        SELECT id, scope, key, value, source, confidence, tags, speaker,
               episode_id AS episodeId, sequence,
               expires_at AS expiresAt, supersedes_id AS supersedesId,
               superseded_by AS supersededBy,
               created_at AS createdAt, updated_at AS updatedAt
        FROM memories
        WHERE scope = ?
          AND (expires_at IS NULL OR expires_at > ?)
          AND (? = 1 OR superseded_by IS NULL)
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(
        scope,
        new Date().toISOString(),
        includeSuperseded ? 1 : 0,
        limit,
      ) as unknown as MemoryRow[];
    return rows.map(toMemoryRecord);
  }

  /**
   * The newest `limit` memories, read no further once their keys, values and
   * tags pass `maxChars` together: a search tokenises every one, so a few
   * large values would otherwise fill the heap.
   */
  memoryCandidates(
    scope: MemoryScope,
    limit: number,
    includeSuperseded = false,
    maxChars = Infinity,
  ): MemoryRecord[] {
    const rows = this.database
      .prepare(`
        SELECT id, scope, key, value, source, confidence, tags, speaker,
               episode_id AS episodeId, sequence,
               expires_at AS expiresAt, supersedes_id AS supersedesId,
               superseded_by AS supersededBy,
               created_at AS createdAt, updated_at AS updatedAt
        FROM memories
        WHERE scope = ?
          AND (expires_at IS NULL OR expires_at > ?)
          AND (? = 1 OR superseded_by IS NULL)
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .iterate(
        scope,
        new Date().toISOString(),
        includeSuperseded ? 1 : 0,
        limit,
      ) as unknown as Iterable<MemoryRow>;
    const records: MemoryRecord[] = [];
    let chars = 0;
    for (const row of rows) {
      records.push(toMemoryRecord(row));
      chars += row.key.length + row.value.length + row.tags.length;
      if (chars >= maxChars) break;
    }
    return records;
  }

  supersedeMemory(
    id: string,
    scope: MemoryScope,
    supersededBy: string,
  ): boolean {
    const result = this.database
      .prepare(`
        UPDATE memories
        SET superseded_by = ?, updated_at = ?
        WHERE id = ? AND scope = ? AND superseded_by IS NULL
      `)
      .run(supersededBy, new Date().toISOString(), id, scope);
    return Number(result.changes) > 0;
  }

  /**
   * Make `id` live again if `supersededBy` is what retired it, for when the
   * record that replaced it is deleted or stops claiming to replace it.
   * Otherwise it stayed hidden with nothing live pointing at it, so it could
   * be neither read, edited nor superseded, and compaction later deleted it.
   */
  unsupersedeMemory(
    id: string,
    scope: MemoryScope,
    supersededBy: string,
  ): boolean {
    const result = this.database
      .prepare(`
        UPDATE memories
        SET superseded_by = NULL, updated_at = ?
        WHERE id = ? AND scope = ? AND superseded_by = ?
      `)
      .run(new Date().toISOString(), id, scope, supersededBy);
    return Number(result.changes) > 0;
  }

  /**
   * Deleting a live correction undoes it: what it replaced is live again.
   * Deleting one in the middle of a chain links the records on either side of
   * it, so the latest stays the only live one. An expired correction leaves
   * what it replaced retired, as it does once compaction has removed it.
   */
  deleteMemory(id: string, scope: MemoryScope): boolean {
    return this.transaction(() => {
      const row = this.database
        .prepare(`
          SELECT supersedes_id AS supersedesId, superseded_by AS supersededBy, expires_at AS expiresAt
          FROM memories WHERE id = ? AND scope = ?
        `)
        .get(id, scope) as
        | { supersedesId: string | null; supersededBy: string | null; expiresAt: string | null }
        | undefined;
      const result = this.database
        .prepare("DELETE FROM memories WHERE id = ? AND scope = ?")
        .run(id, scope);
      const replaced = row?.supersedesId;
      // An expired correction changes nothing, spliced or not, so deleting it
      // does what compaction removing it does, whichever comes first.
      const live = row !== undefined && (row.expiresAt === null || row.expiresAt > new Date().toISOString());
      if (live && replaced != null) {
        if (row.supersededBy != null) {
          this.database
            .prepare("UPDATE memories SET superseded_by = ? WHERE id = ? AND scope = ? AND superseded_by = ?")
            .run(row.supersededBy, replaced, scope, id);
          this.database
            .prepare("UPDATE memories SET supersedes_id = ? WHERE id = ? AND scope = ? AND supersedes_id = ?")
            .run(replaced, row.supersededBy, scope, id);
        } else {
          this.unsupersedeMemory(replaced, scope, id);
        }
      }
      return Number(result.changes) > 0;
    });
  }

  clearMemories(scope: MemoryScope): number {
    const result = this.database
      .prepare("DELETE FROM memories WHERE scope = ?")
      .run(scope);
    return Number(result.changes);
  }

  /**
   * Reclaim memory rows that no read path can return.
   *
   * `listMemories` and `memoryCandidates` both filter out expired rows, and
   * filter out superseded ones unless asked for them, but nothing ever deleted
   * either — so a long-lived install grew forever while the searchable set
   * stayed the same size. This deletes what is already unreachable.
   *
   * `maxPerScope` is different in kind and defaults to off: it evicts *live*
   * memories, which is data the caller stored and can still read. An operator
   * who wants a hard ceiling opts into one.
   *
   * A superseded row is only dropped once nothing live points at it, so a
   * chain is removed from its tail inwards across successive compactions.
   */
  compactMemories(
    scope: MemoryScope,
    retention: { maxAgeDays: number; maxPerScope: number },
    now = new Date(),
  ): { expired: number; superseded: number; evicted: number } {
    const nowIso = now.toISOString();
    const cutoff = new Date(
      now.getTime() - retention.maxAgeDays * 86_400_000,
    ).toISOString();
    return this.transaction(() => {
      const expired = Number(
        this.database
          .prepare(
            "DELETE FROM memories WHERE scope = ? AND expires_at IS NOT NULL AND expires_at <= ?",
          )
          .run(scope, nowIso).changes,
      );
      const superseded = Number(
        this.database
          .prepare(`
            DELETE FROM memories
            WHERE scope = ?
              AND superseded_by IS NOT NULL
              AND updated_at <= ?
              AND id NOT IN (
                SELECT supersedes_id FROM memories
                WHERE scope = ? AND supersedes_id IS NOT NULL AND superseded_by IS NULL
              )
          `)
          .run(scope, cutoff, scope).changes,
      );
      const evicted =
        retention.maxPerScope <= 0
          ? 0
          : Number(
              this.database
                .prepare(`
                  DELETE FROM memories
                  WHERE scope = ? AND superseded_by IS NULL AND id NOT IN (
                    SELECT id FROM memories
                    WHERE scope = ? AND superseded_by IS NULL
                    ORDER BY updated_at DESC, id DESC
                    LIMIT ?
                  )
                `)
                .run(scope, scope, retention.maxPerScope).changes,
            );
      return { expired, superseded, evicted };
    });
  }

  close(): void {
    if (this.owner?.lock !== undefined) {
      this.owner.lock.close();
      try {
        rmSync(this.owner.file!, { force: true });
      } catch {
        // On Windows a peer's probe may have it open. An unlocked file left
        // behind still reads as a dead owner.
      }
    }
    this.database.close();
  }
}

export type { MemoryScope, TaskRecord } from "./types.js";
