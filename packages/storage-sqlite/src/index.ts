// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryScope, TaskRecord } from "./types.js";
import {
  EncryptedPayloadSchema,
  WorkflowDefinitionSchema,
  WorkflowEventSchema,
  WorkflowRunSchema,
  WorkflowSnapshotSchema,
  type EncryptedPayload,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowRun,
  type WorkflowSnapshot,
} from "@melra/protocol";
import type {
  ActionReceipt,
  ExecutionCertificate,
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

export class SqliteStore {
  readonly path: string;
  readonly database: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
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

  private transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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

  saveTask(task: TaskRecord): void {
    this.database
      .prepare(`
        INSERT INTO tasks(id, data, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
      `)
      .run(task.id, JSON.stringify(task), task.createdAt, task.updatedAt);
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.database
      .prepare("SELECT data FROM tasks WHERE id = ?")
      .get(id) as JsonRow | undefined;
    return row === undefined ? undefined : (JSON.parse(row.data) as TaskRecord);
  }

  listTasks(limit = 50): TaskRecord[] {
    const rows = this.database
      .prepare("SELECT data FROM tasks ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.data) as TaskRecord);
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

  createWorkflow(
    redactedDefinition: WorkflowDefinition,
    payload: EncryptedPayload,
    run: WorkflowRun,
    events: WorkflowEvent[],
  ): void {
    const definition = WorkflowDefinitionSchema.parse(redactedDefinition);
    const sealed = EncryptedPayloadSchema.parse(payload);
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
  ): WorkflowDefinition | undefined {
    const row = this.database
      .prepare(`
        SELECT data FROM workflow_definitions WHERE id = ? AND version = ?
      `)
      .get(id, version) as JsonRow | undefined;
    return row === undefined
      ? undefined
      : parseStored(
          row.data,
          WorkflowDefinitionSchema,
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
  ): WorkflowEvent[] {
    const rows = this.database
      .prepare(`
        SELECT data FROM workflow_events
        WHERE aggregate_id = ? AND sequence > ?
        ORDER BY sequence
      `)
      .all(id, afterSequence) as unknown as JsonRow[];
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

  transitionWorkflow(
    id: string,
    expectedStateVersion: number,
    run: WorkflowRun,
    events: WorkflowEvent[],
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
        return false;
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
      return true;
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
    const result = this.database
      .prepare(`
        INSERT OR IGNORE INTO idempotency_commits(
          idempotency_key, task_id, attempt, committed_at
        )
        VALUES (?, ?, ?, ?)
      `)
      .run(key, taskId, attempt, at);
    return Number(result.changes) === 1;
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

  /**
   * Draws one operation, and whatever it declared it moved, against a grant.
   *
   * Silent on a repeat: the key is `(grant, task)`, so recovery replaying a
   * committed task or a receipt being rebuilt cannot spend the grant a second
   * time. Called at the same point as `commitIdempotency` — after verification,
   * never at plan time — so a refused, failed, or cancelled operation leaves
   * the budget where it found it.
   */
  recordCapabilityUse(
    grantId: string,
    taskId: string,
    amount: number,
    at: string,
  ): void {
    this.database
      .prepare(`
        INSERT OR IGNORE INTO capability_usage(
          grant_id, task_id, amount, committed_at
        )
        VALUES (?, ?, ?, ?)
      `)
      .run(grantId, taskId, amount, at);
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
    this.database
      .prepare(`
        INSERT INTO workflow_events(
          id, aggregate_id, sequence, trace_id, type, data, occurred_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.aggregateId,
        event.sequence,
        event.traceId,
        event.type,
        JSON.stringify(event),
        event.occurredAt,
      );
  }

  saveReceipt(receipt: ActionReceipt): void {
    this.database
      .prepare(`
        INSERT INTO receipts(id, task_id, data, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(
        receipt.receiptId,
        receipt.taskId,
        JSON.stringify(receipt),
        receipt.endedAt,
      );
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

  saveCertificate(certificate: ExecutionCertificate): void {
    this.database
      .prepare(`
        INSERT INTO certificates(id, task_id, data, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          id = excluded.id,
          data = excluded.data,
          created_at = excluded.created_at
      `)
      .run(
        certificate.certificateId,
        certificate.taskId,
        JSON.stringify(certificate),
        certificate.createdAt,
      );
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

  memoryCandidates(
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

  deleteMemory(id: string, scope: MemoryScope): boolean {
    const result = this.database
      .prepare("DELETE FROM memories WHERE id = ? AND scope = ?")
      .run(id, scope);
    return Number(result.changes) > 0;
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
   * A superseded row is only dropped once nothing live points at it, so
   * `supersedes_id` never dangles and a chain is removed from its tail
   * inwards across successive compactions.
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
    this.database.close();
  }
}

export type { MemoryScope, TaskRecord } from "./types.js";
