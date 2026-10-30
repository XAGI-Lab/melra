// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// `write` waits out another process's write lock by awaiting, not by blocking
// in SQLite, so this process's timers and I/O keep running meanwhile (#461).

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import type { ActionReceipt } from "@melra/receipt-schema";
import { SqliteStore, type TaskRecord } from "./index.js";

const stores: SqliteStore[] = [];
const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Two stores on one new database, as two processes sharing a home are. */
function twoProcesses(): [SqliteStore, SqliteStore] {
  const directory = mkdtempSync(join(tmpdir(), "melra-write-"));
  directories.push(directory);
  const path = join(directory, "melra.sqlite");
  const pair: [SqliteStore, SqliteStore] = [new SqliteStore(path), new SqliteStore(path)];
  stores.push(...pair);
  return pair;
}

const taskId = "00000000-0000-4000-8000-000000000001";

function task(): TaskRecord {
  const at = new Date().toISOString();
  return {
    id: taskId,
    request: TaskRequestSchema.parse({ goal: "Inspect the system", operation: { kind: "system", action: "info" } }),
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
    createdAt: at,
    updatedAt: at,
  };
}

const rows = (store: SqliteStore, table: string) =>
  (store.database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("SqliteStore.write", () => {
  it("runs in the caller's tick when nothing holds the lock", async () => {
    const [store] = twoProcesses();
    let ran = false;
    const written = store.write(() => {
      store.saveTask(task());
      ran = true;
    });
    expect(ran).toBe(true);
    await written;
    expect(store.getTask(taskId)).toBeDefined();
  });

  it("lets this process's timers run while another holds the lock, then writes", async () => {
    const [store, other] = twoProcesses();
    other.database.exec("BEGIN IMMEDIATE");
    let released = false;
    setTimeout(() => {
      other.database.exec("COMMIT");
      released = true;
    }, 50);
    await store.write(() => {
      expect(released).toBe(true);
      store.saveTask(task());
    });
    expect(other.getTask(taskId)).toBeDefined();
  });

  it("runs the callback once, retrying only the BEGIN", async () => {
    const [store, other] = twoProcesses();
    other.database.exec("BEGIN IMMEDIATE");
    setTimeout(() => other.database.exec("COMMIT"), 50);
    let calls = 0;
    await store.write(() => {
      calls += 1;
      store.saveTask(task());
    });
    expect(calls).toBe(1);

    // A busy error the callback itself meets is its own, not a BEGIN's to retry.
    other.database.exec("BEGIN IMMEDIATE");
    setTimeout(() => other.database.exec("COMMIT"), 50);
    other.database.exec("PRAGMA busy_timeout = 0");
    calls = 0;
    await expect(
      store.write(() => {
        calls += 1;
        other.database.exec("BEGIN IMMEDIATE");
      }),
    ).rejects.toThrow(/locked/);
    expect(calls).toBe(1);
  });

  it("gives up with \"database is locked\" once the busy timeout has run out", async () => {
    vi.useFakeTimers();
    const [store, other] = twoProcesses();
    other.database.exec("BEGIN IMMEDIATE");
    let outcome: unknown;
    const written = store.write(() => store.saveTask(task())).catch((error: unknown) => {
      outcome = error;
    });
    await vi.advanceTimersByTimeAsync(4990);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    expect(String(outcome)).toMatch(/locked/);
    other.database.exec("COMMIT");
    await written;
    expect(rows(store, "tasks")).toBe(0);
  });

  it("rolls back a callback that nests a write or returns a promise", async () => {
    const [store] = twoProcesses();
    await expect(
      store.write(() => {
        store.saveTask(task());
        void store.write(() => undefined);
      }),
    ).rejects.toThrow("write_nested");
    await expect(store.write(async () => store.saveTask(task()))).rejects.toThrow("write_callback_async");
    expect(rows(store, "tasks")).toBe(0);
    // Nor may a sync transaction hold one.
    expect(() => store.transaction(() => void store.write(() => undefined))).toThrow("write_nested");
  });

  it("joins the methods that open a transaction of their own", async () => {
    const [store] = twoProcesses();
    const at = new Date().toISOString();
    const memoryId = "8170fc74-9885-4ee5-973e-161fa441e510";
    store.putMemory({
      id: memoryId,
      scope: "workspace",
      key: "runtime",
      value: "MELRA uses SQLite",
      source: "test",
      confidence: 0.9,
      tags: [],
      createdAt: at,
      updatedAt: at,
    });
    await expect(
      store.write(() => {
        expect(store.deleteMemory(memoryId, "workspace")).toBe(true);
        throw new Error("undone");
      }),
    ).rejects.toThrow("undone");
    expect(store.getMemory(memoryId)).toBeDefined();
    expect(await store.write(() => store.deleteMemory(memoryId, "workspace"))).toBe(true);
    expect(store.getMemory(memoryId)).toBeUndefined();
  });

  it("commits a sealed record with its link, or neither", async () => {
    const [store] = twoProcesses();
    const key = randomBytes(32);
    store.sealRecords(key);
    const receipt = (id: string) => ({ receiptId: id, taskId, endedAt: new Date().toISOString() }) as ActionReceipt;
    await expect(
      store.write(() => {
        store.saveReceipt(receipt("00000000-0000-4000-8000-000000000002"));
        throw new Error("undone");
      }),
    ).rejects.toThrow("undone");
    expect([rows(store, "receipts"), rows(store, "record_chain")]).toEqual([0, 0]);
    await store.write(() => store.saveReceipt(receipt("00000000-0000-4000-8000-000000000003")));
    expect([rows(store, "receipts"), rows(store, "record_chain")]).toEqual([1, 1]);
    expect(store.verifyChain(key)).toMatchObject({ ok: true, unsealed: 0 });
  });
});
