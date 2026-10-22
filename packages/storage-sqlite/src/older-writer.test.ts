// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// An older MELRA writing the same home. `melra setup` pins each client to the
// version that wrote its config, so after an upgrade a pinned server keeps
// running beside the new one until its config is rewritten. Every query this
// store makes must see what that one writes: a task it starts, finishes or
// plans under a key.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { SqliteStore, type TaskRecord } from "./index.js";

const stores: SqliteStore[] = [];
const closers: Array<() => void> = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const close of closers.splice(0)) close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function newHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "melra-older-writer-"));
  directories.push(directory);
  return join(directory, "melra.sqlite");
}

function open(path: string): SqliteStore {
  const store = new SqliteStore(path);
  stores.push(store);
  return store;
}

/** 0.3.0-alpha.17's two writes of a task, verbatim, on a connection of its own. */
function olderMelra(path: string) {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA busy_timeout = 5000");
  closers.push(() => database.close());
  return {
    saveTask(task: TaskRecord): void {
      database
        .prepare(`
          INSERT INTO tasks(id, data, created_at, updated_at, owner)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            data = excluded.data,
            updated_at = excluded.updated_at,
            owner = COALESCE(excluded.owner, tasks.owner)
        `)
        .run(task.id, JSON.stringify(task), task.createdAt, task.updatedAt, null);
    },
    saveTaskIf(task: TaskRecord, expected: readonly TaskRecord["status"][]): boolean {
      const result = database
        .prepare(`
          UPDATE tasks SET data = ?, updated_at = ?, owner = COALESCE(?, owner)
          WHERE id = ? AND json_extract(data, '$.status') IN (SELECT value FROM json_each(?))
        `)
        .run(JSON.stringify(task), task.updatedAt, null, task.id, JSON.stringify(expected));
      return Number(result.changes) === 1;
    },
  };
}

const UNSTARTED: TaskRecord["status"][] = ["planned", "awaiting_approval"];
const KEY = "a".repeat(64);

function task(status: TaskRecord["status"], extra: Partial<TaskRecord> = {}): TaskRecord {
  const at = "2026-10-01T00:00:00.000Z";
  return {
    id: "00000000-0000-4000-8000-000000000001",
    request: TaskRequestSchema.parse({ goal: "Inspect", operation: { kind: "system", action: "info" } }),
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

describe("an older MELRA writing the same home", () => {
  it("is seen to have planned and started a task, by status and by key", () => {
    const path = newHome();
    const store = open(path);
    const older = olderMelra(path);
    const row = task("planned", { idempotencyKey: KEY, attempt: 1 });
    older.saveTask(row);
    expect(older.saveTaskIf({ ...row, status: "running" }, UNSTARTED)).toBe(true);
    // Recovery takes it up if that process dies, and a workflow step sees its
    // key taken rather than planning the change again (#319).
    expect(store.listInterruptedTasks().map((found) => found.id)).toEqual([row.id]);
    expect(store.listTasksByKey(KEY).map((found) => found.status)).toEqual(["running"]);
    expect(store.taskStatusCounts()).toEqual({ running: 1 });
  });

  it("keeps a task it started from being started again here", () => {
    const path = newHome();
    const store = open(path);
    const older = olderMelra(path);
    const row = task("planned");
    store.saveTask(row);
    expect(older.saveTaskIf({ ...row, status: "running" }, UNSTARTED)).toBe(true);
    expect(store.saveTaskIf({ ...row, status: "running" }, UNSTARTED, store.ownerId())).toBe(false);
  });

  it("keeps a task it finished from being recovered here", () => {
    const path = newHome();
    const store = open(path);
    const older = olderMelra(path);
    const row = task("running");
    store.saveTask(row);
    older.saveTask({ ...row, status: "verified_success" });
    expect(store.listInterruptedTasks()).toEqual([]);
    expect(store.claimInterruptedTask(row.id)).toBeUndefined();
    expect(store.getTask(row.id)?.status).toBe("verified_success");
  });
});
