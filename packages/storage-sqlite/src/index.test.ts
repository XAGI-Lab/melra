// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
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
