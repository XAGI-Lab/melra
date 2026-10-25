// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { createCertificate } from "@melra/receipt-schema";
import { SqliteStore } from "./index.js";

let store: SqliteStore | undefined;
let tempDirectory: string | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (tempDirectory !== undefined) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});


describe("the database's file modes", () => {
  it("are private, a new database and one left wider alike", () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "melra-storage-private-"));
    try {
      const path = join(directory, "home", "melra.sqlite");
      const store = new SqliteStore(path);
      store.ownerId();
      store.close();
      expect(statSync(join(directory, "home")).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(`${path}-owners`).mode & 0o777).toBe(0o700);
      // One an older version left readable by others is made private again.
      chmodSync(path, 0o644);
      new SqliteStore(path).close();
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("SqliteStore", () => {
  it("migrates an existing alpha database exactly once", () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "melra-storage-migration-"));
    const databasePath = join(tempDirectory, "melra.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE receipts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE certificates (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE memories (
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
    `);
    legacy.close();

    store = new SqliteStore(databasePath);

    const applied = (
      store.database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>
    ).map((row) => row.version);
    // Recorded once each, in order, with no gaps — the property this test is
    // about. A literal list would only restate which migrations exist today and
    // would fail on every unrelated one added afterwards.
    expect(applied.length).toBeGreaterThanOrEqual(2);
    expect(applied).toEqual(applied.map((_, index) => index + 1));
  });

  it("grants a workflow lease to one owner and expires it", () => {
    store = new SqliteStore(":memory:");
    const workflowId = "11111111-1111-4111-8111-111111111111";
    const soon = new Date(Date.now() + 60_000).toISOString();
    const now = new Date().toISOString();

    expect(store.acquireWorkflowLease(workflowId, "a", now, soon)).toBe(true);
    expect(store.acquireWorkflowLease(workflowId, "b", now, soon)).toBe(false);
    // The holder re-entering is not contention.
    expect(store.acquireWorkflowLease(workflowId, "a", now, soon)).toBe(true);
    expect(store.getWorkflowLease(workflowId)?.owner).toBe("a");

    // Renewal only works for the holder, so a loser cannot extend a lease it
    // never won.
    expect(store.renewWorkflowLease(workflowId, "b", soon)).toBe(false);
    expect(store.renewWorkflowLease(workflowId, "a", soon)).toBe(true);

    // A dead holder's lease lapses rather than stranding the workflow.
    const past = new Date(Date.now() - 1_000).toISOString();
    store.renewWorkflowLease(workflowId, "a", past);
    expect(store.acquireWorkflowLease(workflowId, "b", now, soon)).toBe(true);

    store.releaseWorkflowLease(workflowId, "b");
    expect(store.getWorkflowLease(workflowId)).toBeUndefined();
  });

  it("persists tasks and scoped memories", () => {
    store = new SqliteStore(":memory:");
    const now = new Date().toISOString();
    const request = TaskRequestSchema.parse({
      goal: "Inspect the system",
      operation: { kind: "system", action: "info" },
    });
    store.saveTask({
      id: "605a411d-d39d-494b-a6de-0e8c3b96a564",
      request,
      status: "planned",
      policyDecision: {
        outcome: "allow",
        effect: "read",
        risk: "low",
        reason: "read_only_operation",
        policyVersion: "1",
        traits: [],
      },
      receiptIds: [],
      createdAt: now,
      updatedAt: now,
    });
    expect(
      store.getTask("605a411d-d39d-494b-a6de-0e8c3b96a564")?.request.goal,
    ).toBe("Inspect the system");

    store.putMemory({
      id: "8170fc74-9885-4ee5-973e-161fa441e510",
      scope: "workspace",
      key: "runtime",
      value: "MELRA uses SQLite",
      source: "test",
      confidence: 0.9,
      tags: ["runtime"],
      createdAt: now,
      updatedAt: now,
    });
    expect(store.memoryCandidates("workspace", 5)).toHaveLength(1);
    expect(store.listMemories("user", 5)).toHaveLength(0);
  });

  it("opens read-only beside a writer without blocking it", () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "melra-storage-readonly-"));
    const databasePath = join(tempDirectory, "melra.sqlite");
    // An observer must not create the database it was pointed at.
    expect(() => new SqliteStore(databasePath, { readOnly: true })).toThrow();
    store = new SqliteStore(databasePath);
    const now = new Date().toISOString();
    const task = {
      id: "605a411d-d39d-494b-a6de-0e8c3b96a564",
      request: TaskRequestSchema.parse({
        goal: "Inspect the system",
        operation: { kind: "system", action: "info" },
      }),
      status: "planned" as const,
      policyDecision: {
        outcome: "allow" as const,
        effect: "read" as const,
        risk: "low" as const,
        reason: "read_only_operation",
        policyVersion: "1",
        traits: [],
      },
      receiptIds: [],
      createdAt: now,
      updatedAt: now,
    };
    store.saveTask(task);
    const reader = new SqliteStore(databasePath, { readOnly: true });
    try {
      expect(reader.taskStatusCounts()).toEqual({ planned: 1 });
      // The writer is not held up by the open reader.
      store.saveTask({ ...task, status: "verified_success" });
      expect(reader.listTasks(1)[0]?.status).toBe("verified_success");
      expect(() => reader.saveTask(task)).toThrow(/readonly/i);
    } finally {
      reader.close();
    }
  });

  it("compacts only memories no read path can return", () => {
    store = new SqliteStore(":memory:");
    // `supersedeMemory` stamps `updated_at` from the real clock, so `now` has to
    // come from the same clock — a pinned instant made the test pass or fail on
    // the time of day it happened to run at.
    const now = new Date(Date.now() + 1_000);
    const old = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const base = {
      scope: "workspace" as const,
      source: "test",
      confidence: 0.9,
      tags: [],
      createdAt: old,
    };
    // Expired: filtered out of every query already, so nothing can miss it.
    store.putMemory({
      ...base,
      id: "11111111-1111-4111-8111-111111111111",
      key: "expired",
      value: "gone",
      expiresAt: "2026-08-01T00:00:00.000Z",
      updatedAt: old,
    });
    // A superseded chain: `stale` -> `middle` -> `head`, `head` still live.
    store.putMemory({
      ...base,
      id: "22222222-2222-4222-8222-222222222222",
      key: "stale",
      value: "v1",
      updatedAt: old,
    });
    store.putMemory({
      ...base,
      id: "33333333-3333-4333-8333-333333333333",
      key: "middle",
      value: "v2",
      supersedesId: "22222222-2222-4222-8222-222222222222",
      updatedAt: old,
    });
    store.putMemory({
      ...base,
      id: "44444444-4444-4444-8444-444444444444",
      key: "head",
      value: "v3",
      supersedesId: "33333333-3333-4333-8333-333333333333",
      updatedAt: old,
    });
    store.supersedeMemory(
      "22222222-2222-4222-8222-222222222222",
      "workspace",
      "33333333-3333-4333-8333-333333333333",
    );
    store.supersedeMemory(
      "33333333-3333-4333-8333-333333333333",
      "workspace",
      "44444444-4444-4444-8444-444444444444",
    );
    // Live and untouched by compaction at the default ceiling of none.
    store.putMemory({
      ...base,
      id: "55555555-5555-4555-8555-555555555555",
      key: "live",
      value: "keep me",
      updatedAt: old,
    });

    // `supersedeMemory` stamps `updated_at`, so the chain is only as old as the
    // supersession — measure age from now rather than from the seeded dates.
    const compacted = store.compactMemories(
      "workspace",
      { maxAgeDays: 0, maxPerScope: 0 },
      now,
    );
    expect(compacted.expired).toBe(1);
    // `stale` goes; `middle` stays because live `head` still points at it, so
    // `supersedesId` never dangles.
    expect(compacted.superseded).toBe(1);
    expect(compacted.evicted).toBe(0);
    expect(
      store.getMemory("22222222-2222-4222-8222-222222222222"),
    ).toBeUndefined();
    expect(
      store.getMemory("33333333-3333-4333-8333-333333333333"),
    ).toBeDefined();
    expect(store.listMemories("workspace", 10).map((row) => row.key)).toEqual([
      "head",
      "live",
    ]);

    // An opt-in ceiling evicts live memories, oldest first.
    expect(
      store.compactMemories(
        "workspace",
        { maxAgeDays: 30, maxPerScope: 1 },
        now,
      ).evicted,
    ).toBe(1);
    expect(store.listMemories("workspace", 10)).toHaveLength(1);
  });

  it("migrates existing memory tables before persisting episode metadata", () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "melra-memory-migration-"));
    const databasePath = join(tempDirectory, "melra.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT,
        supersedes_id TEXT,
        superseded_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    store = new SqliteStore(databasePath);
    const now = new Date().toISOString();
    store.putMemory({
      id: "4a9b5e8d-0b5b-4fe4-8db4-e2275c733f11",
      scope: "workspace",
      key: "answer",
      value: "Adoption agencies.",
      source: "test",
      confidence: 1,
      tags: [],
      speaker: "Alex",
      episodeId: "conversation-a",
      sequence: 11,
      createdAt: now,
      updatedAt: now,
    });

    expect(
      store.getMemory("4a9b5e8d-0b5b-4fe4-8db4-e2275c733f11"),
    ).toMatchObject({
      speaker: "Alex",
      episodeId: "conversation-a",
      sequence: 11,
    });
  });

  it("keeps a superseded record while something live still points at it", () => {
    store = new SqliteStore(":memory:");
    const old = "5f1c1c30-0f3a-4a70-8f52-1b0a3d5d9c01";
    const ancient = "2000-01-01T00:00:00.000Z";
    store.putMemory({
      id: old,
      scope: "workspace",
      key: "city",
      value: "Chennai",
      source: "test",
      confidence: 1,
      tags: [],
      supersededBy: "5f1c1c30-0f3a-4a70-8f52-1b0a3d5d9c02",
      createdAt: ancient,
      updatedAt: ancient,
    });
    store.putMemory({
      id: "5f1c1c30-0f3a-4a70-8f52-1b0a3d5d9c02",
      scope: "workspace",
      key: "city",
      value: "Bengaluru",
      source: "test",
      confidence: 1,
      tags: [],
      supersedesId: old,
      createdAt: ancient,
      updatedAt: ancient,
    });

    // Deleting the old row here would leave the live record's `supersedesId`
    // pointing at nothing, so the history it claims to have could not be read.
    expect(
      store.compactMemories("workspace", { maxAgeDays: 0, maxPerScope: 0 }),
    ).toMatchObject({ superseded: 0 });
    expect(store.getMemory(old)).toBeDefined();
  });

  it("evicts the oldest live memories only once a ceiling is set", () => {
    store = new SqliteStore(":memory:");
    const ids = ["a", "b", "c"].map(
      (suffix, index) => `6d2e0000-0000-4000-8000-00000000000${index}${suffix}`,
    );
    ids.forEach((id, index) => {
      const stamp = new Date(1_700_000_000_000 + index * 1_000).toISOString();
      store!.putMemory({
        id,
        scope: "workspace",
        key: `k${index}`,
        value: "v",
        source: "test",
        confidence: 1,
        tags: [],
        createdAt: stamp,
        updatedAt: stamp,
      });
    });

    // `maxPerScope` deletes records that are still readable, so the default of
    // 0 has to mean "no ceiling" rather than "keep nothing".
    expect(
      store.compactMemories("workspace", { maxAgeDays: 30, maxPerScope: 0 }),
    ).toMatchObject({ evicted: 0 });
    expect(store.listMemories("workspace", 10)).toHaveLength(3);

    expect(
      store.compactMemories("workspace", { maxAgeDays: 30, maxPerScope: 2 }),
    ).toMatchObject({ evicted: 1 });
    expect(store.getMemory(ids[0]!)).toBeUndefined();
    expect(store.getMemory(ids[2]!)).toBeDefined();
  });
});

describe("the records an effect leaves", () => {
  const taskId = "7a1d0000-0000-4000-8000-000000000001";
  const otherTask = "7a1d0000-0000-4000-8000-000000000002";
  const thirdTask = "7a1d0000-0000-4000-8000-000000000003";
  const issue = (result: "PARTIAL" | "VERIFIED_SUCCESS", createdAt: string, task = taskId) =>
    createCertificate({ taskId: task, goal: "Inspect", result, policyVersion: "1", receiptIds: [], evidence: [], createdAt });

  it("refuse to be changed, removed or replaced, by this store or any other writer", () => {
    store = new SqliteStore(":memory:");
    store.database.exec(`
      INSERT INTO receipts VALUES ('r', '${taskId}', '{}', 'at');
      INSERT INTO workflow_events VALUES ('e', 'w', 1, 'trace', 'workflow.planned', '{}', 'at');
      INSERT INTO approval_decisions VALUES ('a', '${taskId}', 'digest', 'out_of_band', 'cli:operator', 'at');
      INSERT INTO capability_usage VALUES ('g', '${taskId}', 0, 'at');
      INSERT INTO idempotency_commits VALUES ('k', '${taskId}', 1, 'at');
      INSERT INTO certificate_history VALUES ('c', '${taskId}', '{}', 'at', 'at');
      INSERT INTO certified_tasks VALUES ('${taskId}');
      INSERT INTO approval_denials VALUES ('d', '${taskId}', 'digest', 'op', 'out_of_band', 'cli:operator', 'never', NULL, 'at');
      INSERT INTO refusals VALUES ('${taskId}', 'approval_in_band_refused', 'task', 'enforced', NULL, NULL, 'at');
    `);
    // Each row a REPLACE would put in place of the stored one on its key, and
    // whether it is refused or, for a table MELRA writes with INSERT OR
    // IGNORE, ignored; then a row under a new key that names the stored row's
    // rowid, which every table refuses.
    for (const [table, column, replacements, refused, fresh] of [
      ["receipts", "data", [`('r', '${taskId}', '{"a":2}', 'at')`], true, `'r2', '${taskId}', '{}', 'at'`],
      [
        "workflow_events",
        "data",
        [
          `('e', 'w', 2, 'trace', 'workflow.planned', '{"a":2}', 'at')`,
          `('e2', 'w', 1, 'trace', 'workflow.planned', '{"a":2}', 'at')`,
        ],
        true,
        `'e2', 'w', 2, 'trace', 'workflow.planned', '{}', 'at'`,
      ],
      [
        "approval_decisions",
        "approver",
        [`('a', '${taskId}', 'digest', 'out_of_band', 'cli:other', 'at')`],
        false,
        `'a2', '${taskId}', 'digest', 'out_of_band', 'cli:other', 'at'`,
      ],
      ["capability_usage", "amount", [`('g', '${taskId}', 5, 'at')`], false, `'g2', '${taskId}', 5, 'at'`],
      ["idempotency_commits", "attempt", [`('k', '${taskId}', 9, 'at')`], false, `'k2', '${taskId}', 9, 'at'`],
      ["certificate_history", "data", [], true, `'c2', '${taskId}', '{}', 'at', 'at'`],
      ["certified_tasks", "task_id", [`('${taskId}')`], false, `'${otherTask}'`],
      [
        "approval_denials",
        "reason",
        [`('d', '${taskId}', 'digest', 'op', 'out_of_band', 'cli:other', 'other', NULL, 'at')`],
        false,
        `'d2', '${taskId}', 'digest', 'op', 'out_of_band', 'cli:other', 'other', NULL, 'at'`,
      ],
      [
        "refusals",
        "mode",
        [`('${taskId}', 'approval_in_band_refused', 'task', 'developer', NULL, NULL, 'later')`],
        false,
        `'${otherTask}', 'approval_in_band_refused', 'task', 'enforced', NULL, NULL, 'at'`,
      ],
    ] as const) {
      const stored = store.database.prepare(`SELECT rowid, * FROM ${table}`).all();
      expect(() => store!.database.exec(`UPDATE ${table} SET ${column} = 2`)).toThrow("record_append_only");
      expect(() => store!.database.exec(`DELETE FROM ${table}`)).toThrow("record_append_only");
      for (const row of replacements) {
        const replace = () => store!.database.exec(`INSERT OR REPLACE INTO ${table} VALUES ${row}`);
        if (refused) expect(replace).toThrow("record_append_only");
        else replace();
      }
      const columns = store.database
        .prepare("SELECT name FROM pragma_table_info(?)")
        .all(table)
        .map(({ name }) => name)
        .join(", ");
      expect(() =>
        store!.database.exec(
          `INSERT OR REPLACE INTO ${table}(rowid, ${columns}) VALUES ((SELECT rowid FROM ${table}), ${fresh})`,
        ),
      ).toThrow("record_append_only");
      expect(store.database.prepare(`SELECT rowid, * FROM ${table}`).all()).toEqual(stored);
    }
  });

  it("keep taking new rows after another writer stores one at rowid -1", () => {
    store = new SqliteStore(":memory:");
    // -1 is what an insert that names no rowid sees, so a row there must not
    // look like the one every later insert collides with.
    store.database.exec(`
      INSERT INTO receipts(rowid, id, task_id, data, created_at) VALUES (-1, 'stray', '${otherTask}', '{}', 'at');
      INSERT INTO certificates(rowid, id, task_id, data, created_at) VALUES (-1, 'stray', '${otherTask}', '{}', 'at');
      INSERT INTO certificate_history(rowid, certificate_id, task_id, data, created_at, replaced_at)
        VALUES (-1, 'stray', '${otherTask}', '{}', 'at', 'at');
    `);
    store.database.exec(`INSERT INTO receipts VALUES ('r', '${taskId}', '{}', 'at')`);
    store.saveCertificate(issue("PARTIAL", "2026-10-01T00:00:00.000Z"));
    const settled = store.saveCertificate(issue("VERIFIED_SUCCESS", "2026-10-02T00:00:00.000Z"));
    expect(store.getCertificateForTask(taskId)).toEqual(settled);
    expect(store.database.prepare("SELECT count(*) AS n FROM certificate_history").get()).toEqual({ n: 2 });
  });

  it("keep each certificate a judgement or settle replaced, and let no other write remove one", () => {
    store = new SqliteStore(":memory:");
    const first = store.saveCertificate(issue("PARTIAL", "2026-10-01T00:00:00.000Z"));
    // A second process certifying the same outcome is handed the first.
    expect(store.saveCertificate(issue("PARTIAL", "2026-10-01T00:00:00.000Z"), { ifAbsent: true })).toEqual(first);
    const second = store.saveCertificate(issue("VERIFIED_SUCCESS", "2026-10-02T00:00:00.000Z"));
    store.saveCertificate(issue("PARTIAL", "2026-10-03T00:00:00.000Z", otherTask));

    expect(store.getCertificateForTask(taskId)).toEqual(second);
    const history = () =>
      store!.database
        .prepare("SELECT certificate_id AS id, task_id AS taskId, data, created_at AS createdAt FROM certificate_history")
        .all();
    expect(history()).toEqual([
      { id: first.certificateId, taskId, data: JSON.stringify(first), createdAt: first.createdAt },
    ]);
    const certificates = () => store!.database.prepare("SELECT rowid, * FROM certificates").all();
    const stored = certificates();
    const rowid = `(SELECT rowid FROM certificates WHERE task_id = '${taskId}')`;
    // A REPLACE removes the row it collides with on rowid, id or task without
    // firing a delete trigger, and outside the upsert would keep no history.
    for (const write of [
      "DELETE FROM certificates",
      `INSERT OR REPLACE INTO certificates VALUES ('${second.certificateId}', '${otherTask}', '{}', 'at')`,
      `INSERT OR REPLACE INTO certificates VALUES ('${second.certificateId}', '${thirdTask}', '{}', 'at')`,
      `INSERT OR REPLACE INTO certificates VALUES ('${second.certificateId}', '${taskId}', '{}', 'at')`,
      `INSERT OR REPLACE INTO certificates VALUES ('fresh', '${taskId}', '{}', 'at')`,
      `INSERT OR REPLACE INTO certificates(rowid, id, task_id, data, created_at)
        VALUES (${rowid}, 'fresh', '${thirdTask}', '{}', 'at')`,
      `INSERT INTO certificates VALUES ('${second.certificateId}', '${otherTask}', '{}', 'at')
        ON CONFLICT(task_id) DO UPDATE SET id = excluded.id`,
      `UPDATE OR REPLACE certificates SET id = '${second.certificateId}' WHERE task_id = '${otherTask}'`,
      `UPDATE OR REPLACE certificates SET task_id = '${taskId}' WHERE task_id = '${otherTask}'`,
      `UPDATE OR REPLACE certificates SET rowid = ${rowid} WHERE task_id = '${otherTask}'`,
    ]) {
      expect(() => store!.database.exec(write), write).toThrow("record_append_only");
    }
    expect(certificates()).toEqual(stored);
    expect(history()).toHaveLength(1);
  });

  it("hold a certificate written before migration 7 to the same rules", () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "melra-certified-"));
    const path = join(tempDirectory, "melra.sqlite");
    const before = new DatabaseSync(path);
    before.exec(`
      CREATE TABLE certificates (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO certificates VALUES ('c', '${taskId}', '{}', 'at');
    `);
    before.close();
    store = new SqliteStore(path);

    expect(() =>
      store!.database.exec(`INSERT OR REPLACE INTO certificates VALUES ('fresh', '${taskId}', '{}', 'at')`),
    ).toThrow("record_append_only");
    const settled = store.saveCertificate(issue("VERIFIED_SUCCESS", "2026-10-02T00:00:00.000Z"));
    expect(store.getCertificateForTask(taskId)).toEqual(settled);
    expect(store.database.prepare("SELECT certificate_id AS id, data FROM certificate_history").all()).toEqual([
      { id: "c", data: "{}" },
    ]);
  });
});

describe("refused answers (#424)", () => {
  const refusal = (subjectId: string, code: string, refusedAt: string) => ({
    kind: "task" as const,
    subjectId,
    code,
    mode: "enforced",
    client: "operator",
    refusedAt,
  });

  it("keep one row per task or run and code, however often the same answer is sent", () => {
    store = new SqliteStore(":memory:");
    const [task, other] = ["7a1d0000-0000-4000-8000-00000000000a", "7a1d0000-0000-4000-8000-00000000000b"];
    // An agent sending the same refused answer in a loop.
    for (let index = 0; index < 1_000; index += 1) {
      store.recordRefusal(refusal(task, "approval_in_band_refused", new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString()));
    }
    expect(store.refusalCount()).toBe(1);
    // The first is the one kept.
    expect(store.listRefusals(10)).toEqual([refusal(task, "approval_in_band_refused", "2026-10-01T00:00:00.000Z")]);
    store.recordRefusal(refusal(task, "approval_render_mismatch", "2026-10-02T00:00:00.000Z"));
    store.recordRefusal(refusal(other, "approval_in_band_refused", "2026-10-03T00:00:00.000Z"));
    expect(store.refusalCount()).toBe(3);
    expect(store.listRefusals(10).map((entry) => [entry.subjectId, entry.code])).toEqual([
      [other, "approval_in_band_refused"],
      [task, "approval_render_mismatch"],
      [task, "approval_in_band_refused"],
    ]);
    expect(store.listRefusals(10, [task]).map((entry) => entry.code)).toEqual([
      "approval_render_mismatch",
      "approval_in_band_refused",
    ]);
  });

  it("read as none from a home no store of this version has migrated yet", () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "melra-storage-refusals-"));
    const path = join(tempDirectory, "melra.sqlite");
    new SqliteStore(path).close();
    // As an older MELRA leaves it: no refusals table.
    const older = new DatabaseSync(path);
    older.exec("DROP TABLE refusals");
    older.close();
    // An observer never migrates.
    store = new SqliteStore(path, { readOnly: true });
    expect(store.refusalCount()).toBe(0);
    expect(store.listRefusals(5)).toEqual([]);
  });
});
