// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Migration 7: a task's status and idempotency key as indexed columns. A
// database an earlier version wrote upgrades in place and answers every
// query as before, and each query reads an index rather than every task.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRequestSchema, TaskStatusSchema } from "@melra/protocol";
import { SqliteStore, type TaskRecord } from "./index.js";

const stores: SqliteStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function open(path: string): SqliteStore {
  const store = new SqliteStore(path);
  stores.push(store);
  return store;
}

const request = TaskRequestSchema.parse({ goal: "Inspect", operation: { kind: "system", action: "info" } });
const KEYS = ["a".repeat(64), "b".repeat(64)];

function task(index: number, status: TaskRecord["status"], extra: Partial<TaskRecord> = {}): TaskRecord {
  // Distinct times, so an order by `updated_at` has no ties for two plans to
  // break differently.
  const at = new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    request,
    status,
    policyDecision: {
      outcome: "allow",
      effect: "read",
      risk: "low",
      reason: "read_only_operation",
      policyVersion: "1",
      traits: [],
    },
    receiptIds: [],
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

/** Every status, keyed and not, and waits whose judgements have and have not expired. */
function rows(): TaskRecord[] {
  const judged = (expiresAt: string) => ({ judgements: [{ judgementId: "j", predicateIndex: 0, expiresAt }] });
  const all = TaskStatusSchema.options.flatMap((status, index) => [
    task(index * 3, status),
    task(index * 3 + 1, status, { idempotencyKey: KEYS[index % 2]!, attempt: 1 }),
  ]);
  return [
    ...all,
    task(100, "waiting_user", judged("2026-10-01T00:00:00.000Z")),
    task(101, "waiting_user", judged("2099-01-01T00:00:00.000Z")),
  ];
}

/** A home as migration 6 left it: the latest schema with migration 7 undone. */
function atMigration6(): string {
  const directory = mkdtempSync(join(tmpdir(), "melra-task-columns-"));
  directories.push(directory);
  const path = join(directory, "melra.sqlite");
  const store = new SqliteStore(path);
  store.database.exec(`
    DROP INDEX tasks_status;
    DROP INDEX tasks_idempotency_key;
    ALTER TABLE tasks DROP COLUMN status;
    ALTER TABLE tasks DROP COLUMN idempotency_key;
    CREATE INDEX tasks_status ON tasks(json_extract(data, '$.status'));
    CREATE INDEX tasks_idempotency_key ON tasks(json_extract(data, '$.idempotencyKey'));
    DELETE FROM schema_migrations WHERE version = 7;
  `);
  // Written as 0.3.0-alpha.17's saveTask writes a task.
  const insert = store.database.prepare(
    "INSERT INTO tasks(id, data, created_at, updated_at, owner) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows()) insert.run(row.id, JSON.stringify(row), row.createdAt, row.updatedAt, null);
  store.close();
  return path;
}

const NOW = "2026-10-22T00:00:00.000Z";

/** What each listing returns, asked the way 0.3.0-alpha.17 asked it. */
function answeredBefore(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  const ids = (sql: string, ...params: string[]) =>
    (database.prepare(sql).all(...params) as Array<{ data: string }>).map((row) => (JSON.parse(row.data) as TaskRecord).id);
  try {
    return {
      byStatus: Object.fromEntries(
        TaskStatusSchema.options.map((status) => [
          status,
          ids("SELECT data FROM tasks WHERE json_extract(data, '$.status') = ? ORDER BY updated_at DESC LIMIT 100", status),
        ]),
      ),
      interrupted: ids(
        "SELECT data FROM tasks WHERE json_extract(data, '$.status') IN ('running', 'verifying') ORDER BY updated_at",
      ),
      expired: ids(
        `SELECT data FROM tasks WHERE json_extract(data, '$.status') = 'waiting_user'
           AND coalesce(json_extract(data, '$.judgements[0].expiresAt'), '') <= ? ORDER BY updated_at ASC`,
        NOW,
      ),
      byKey: [...KEYS, "c".repeat(64)].map((key) =>
        ids("SELECT data FROM tasks WHERE json_extract(data, '$.idempotencyKey') = ?", key).sort(),
      ),
      counts: Object.fromEntries(
        (
          database
            .prepare("SELECT json_extract(data, '$.status') AS status, COUNT(*) AS count FROM tasks GROUP BY 1")
            .all() as Array<{ status: string; count: number }>
        ).map((row) => [row.status, Number(row.count)]),
      ),
    };
  } finally {
    database.close();
  }
}

/** Rows whose columns say something other than their JSON. */
const outOfStep = (store: SqliteStore) =>
  (
    store.database
      .prepare(`
        SELECT count(*) AS count FROM tasks
        WHERE status IS NOT json_extract(data, '$.status')
          OR idempotency_key IS NOT json_extract(data, '$.idempotencyKey')
      `)
      .get() as { count: number }
  ).count;

/** SQLite's plan for each statement `call` prepares, one line per step. */
function plans(store: SqliteStore, call: () => unknown): string[] {
  const statements: string[] = [];
  const prepare = store.database.prepare.bind(store.database);
  const spy = vi.spyOn(store.database, "prepare").mockImplementation((sql: string) => {
    statements.push(sql);
    return prepare(sql);
  });
  try {
    call();
  } finally {
    spy.mockRestore();
  }
  return statements.map((sql) =>
    (store.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
      .map((row) => row.detail)
      .join("\n"),
  );
}

describe("migration 7", () => {
  it("upgrades a migration-6 home in place and answers every listing as before", () => {
    const path = atMigration6();
    const before = answeredBefore(path);
    // Sanity: the fixture has something in each answer.
    expect(before.interrupted).toHaveLength(4);
    // The expired one, and the two with no judgement to wait for.
    expect(before.expired).toHaveLength(3);
    expect(before.byKey[0]!.length).toBeGreaterThan(1);

    const store = open(path);
    const ids = (tasks: TaskRecord[]) => tasks.map((found) => found.id);
    expect(
      Object.fromEntries(TaskStatusSchema.options.map((status) => [status, ids(store.listTasks(100, status))])),
    ).toEqual(before.byStatus);
    expect(ids(store.listInterruptedTasks())).toEqual(before.interrupted);
    expect(ids(store.listExpiredJudgements(NOW))).toEqual(before.expired);
    expect([...KEYS, "c".repeat(64)].map((key) => ids(store.listTasksByKey(key)).sort())).toEqual(before.byKey);
    expect(store.taskStatusCounts()).toEqual(before.counts);
    expect(outOfStep(store)).toBe(0);
    // The expression indexes are gone, and so is their cost on every write.
    const indexes = store.database
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND sql IS NOT NULL")
      .all() as Array<{ name: string; sql: string }>;
    expect(indexes.map((index) => index.name).sort()).toEqual(["tasks_idempotency_key", "tasks_status"]);
    expect(indexes.some((index) => index.sql.includes("json_extract"))).toBe(false);

    // Upgraded rows take part in the compare-and-sets as before.
    const [planned] = store.listTasks(1, "planned");
    expect(store.saveTaskIf({ ...planned!, status: "running" }, ["planned"], store.ownerId())).toBe(true);
    expect(store.saveTaskIf({ ...planned!, status: "cancelled" }, ["planned"])).toBe(false);
    const [abandoned] = store.listTasks(1, "verifying");
    expect(store.claimInterruptedTask(abandoned!.id)?.id).toBe(abandoned!.id);
  });

  it("lets an observer read a home only an older MELRA has opened, without migrating it", () => {
    const path = atMigration6();
    const before = answeredBefore(path);
    const observer = new SqliteStore(path, { readOnly: true });
    stores.push(observer);
    expect(observer.taskStatusCounts()).toEqual(before.counts);
    expect(observer.listTasks(100, "running").map((found) => found.id)).toEqual(before.byStatus.running);
    expect(observer.listTasksByKey(KEYS[1]!).map((found) => found.id).sort()).toEqual(before.byKey[1]);
    const applied = observer.database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as {
      version: number;
    };
    expect(applied.version).toBe(6);
  });

  it("keeps the columns in step with every write of a task", () => {
    const store = open(":memory:");
    const row = task(1, "planned", { idempotencyKey: KEYS[0]!, attempt: 1 });
    store.saveTask(row);
    store.saveTask({ ...row, status: "awaiting_approval" });
    expect(store.saveTaskIf({ ...row, status: "running" }, ["awaiting_approval"], store.ownerId())).toBe(true);
    store.saveTask(task(2, "verified_success"));
    expect(outOfStep(store)).toBe(0);
    expect(store.taskStatusCounts()).toEqual({ running: 1, verified_success: 1 });
    expect(store.listTasksByKey(KEYS[0]!).map((found) => found.status)).toEqual(["running"]);
  });

  it("reads each listing from an index, and sorts none of them", () => {
    const store = open(":memory:");
    for (const row of rows()) store.saveTask(row);
    const status = /USING (COVERING )?INDEX tasks_status/;
    for (const [call, sorted] of [
      [() => store.listTasks(10, "running"), false],
      [() => store.listExpiredJudgements(NOW), false],
      [() => store.taskStatusCounts(), false],
      // Two statuses: the index finds both, and only those rows are sorted.
      [() => store.listInterruptedTasks(), true],
    ] as const) {
      const [plan] = plans(store, call);
      expect(plan).toMatch(status);
      expect(plan).not.toMatch(/^SCAN tasks$/m);
      if (!sorted) expect(plan).not.toContain("TEMP B-TREE");
    }
    const [byKey] = plans(store, () => store.listTasksByKey(KEYS[0]!));
    expect(byKey).toContain("USING INDEX tasks_idempotency_key (idempotency_key=?)");
  });
});
