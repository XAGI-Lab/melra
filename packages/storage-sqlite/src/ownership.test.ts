// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { SqliteStore, type TaskRecord } from "./index.js";

/**
 * Recovery used to take every running task as abandoned, including one a live
 * process sharing the database was still running. These pin what "abandoned"
 * now means: the process that owns the row is gone.
 */
const stores: SqliteStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function database(): string {
  const directory = mkdtempSync(join(tmpdir(), "melra-ownership-"));
  directories.push(directory);
  return join(directory, "melra.sqlite");
}

function open(path: string): SqliteStore {
  const store = new SqliteStore(path);
  stores.push(store);
  return store;
}

const request = TaskRequestSchema.parse({
  goal: "Write a file",
  operation: { kind: "file", action: "write", path: "a.txt", content: "a" },
  requiredEvidence: [{ type: "file_exists", path: "a.txt" }],
});

function task(id: string, status: TaskRecord["status"]): TaskRecord {
  const at = new Date().toISOString();
  return {
    id,
    request,
    status,
    policyDecision: {
      outcome: "confirm",
      effect: "mutate",
      risk: "medium",
      reason: "mutation_requires_approval",
      policyVersion: "1",
      traits: [],
    },
    receiptIds: [],
    createdAt: at,
    updatedAt: at,
  };
}

const ownerOf = (store: SqliteStore, id: string) =>
  (store.database.prepare("SELECT owner FROM tasks WHERE id = ?").get(id) as { owner: string | null }).owner;

describe("task ownership", () => {
  it("hands a running task to another process only once its owner is gone", () => {
    const path = database();
    const a = open(path);
    const b = open(path);
    const c = open(path);
    const id = "8d1f0f8e-6c1b-4f43-9f55-6c0a3e7d0a01";
    a.saveTask(task(id, "running"), a.ownerId());

    expect(b.claimInterruptedTask(id)).toBeUndefined();
    expect(c.claimInterruptedTask(id)).toBeUndefined();
    // Its own task is not abandoned either.
    expect(a.claimInterruptedTask(id)).toBeUndefined();
    const lock = join(`${path}-owners`, a.ownerId());
    expect(existsSync(lock)).toBe(true);

    a.close();
    expect(existsSync(lock)).toBe(false);
    expect(b.claimInterruptedTask(id)?.status).toBe("running");
    expect(ownerOf(b, id)).toBe(b.ownerId());
    // Claimed once: the next recoverer finds a live owner again.
    expect(c.claimInterruptedTask(id)).toBeUndefined();
  });

  it("keeps the owner through saves that do not name one", () => {
    const store = open(database());
    const id = "8d1f0f8e-6c1b-4f43-9f55-6c0a3e7d0a02";
    store.saveTask(task(id, "running"), store.ownerId());
    store.saveTask(task(id, "verifying"));
    expect(ownerOf(store, id)).toBe(store.ownerId());
    store.saveTask(task(id, "verified_success"));
    expect(ownerOf(store, id)).toBe(store.ownerId());
  });

  it("treats a row written before owners existed as abandoned, and a planned one never", () => {
    const store = open(database());
    store.saveTask(task("8d1f0f8e-6c1b-4f43-9f55-6c0a3e7d0a03", "running"));
    store.saveTask(task("8d1f0f8e-6c1b-4f43-9f55-6c0a3e7d0a04", "planned"));
    expect(store.claimInterruptedTask("8d1f0f8e-6c1b-4f43-9f55-6c0a3e7d0a03")?.id).toBe(
      "8d1f0f8e-6c1b-4f43-9f55-6c0a3e7d0a03",
    );
    expect(store.claimInterruptedTask("8d1f0f8e-6c1b-4f43-9f55-6c0a3e7d0a04")).toBeUndefined();
  });

  it("sees a killed process as gone", async () => {
    const path = database();
    const id = "8d1f0f8e-6c1b-4f43-9f55-6c0a3e7d0a05";
    const module = new URL("../dist/index.js", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { SqliteStore } = await import(${JSON.stringify(module)});
         // Reachable for as long as the process lives, as a runtime's store is:
         // a collected store closes its lock and the owner would read as gone.
         const store = (globalThis.store = new SqliteStore(process.argv[1]));
         store.saveTask(JSON.parse(process.argv[2]), store.ownerId());
         process.stdout.write("ready\\n");
         setInterval(() => {}, 60_000);`,
        path,
        JSON.stringify(task(id, "running")),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      const [ready] = (await once(child.stdout!, "data")) as [Buffer];
      expect(ready.toString()).toBe("ready\n");
      const survivor = open(path);
      expect(survivor.claimInterruptedTask(id)).toBeUndefined();

      child.kill("SIGKILL");
      await once(child, "exit");
      // No clock, heartbeat or PID: the kernel released the lock with the process.
      expect(survivor.claimInterruptedTask(id)?.id).toBe(id);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("adds the owner column and a status index to a version-3 database", () => {
    const path = database();
    const legacy = "8d1f0f8e-6c1b-4f43-9f55-6c0a3e7d0a06";
    const fresh = new SqliteStore(path);
    fresh.database.exec(`
      DROP INDEX tasks_status;
      ALTER TABLE tasks DROP COLUMN owner;
      DELETE FROM schema_migrations WHERE version = 4;
    `);
    fresh.database
      .prepare("INSERT INTO tasks(id, data, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(legacy, JSON.stringify(task(legacy, "running")), "t", "t");
    fresh.close();

    const store = open(path);
    expect(ownerOf(store, legacy)).toBeNull();
    const plan = store.database
      .prepare(`
        EXPLAIN QUERY PLAN SELECT data FROM tasks
        WHERE json_extract(data, '$.status') IN ('running', 'verifying')
        ORDER BY updated_at
      `)
      .all() as Array<{ detail: string }>;
    // The recovery sweep runs this every 30 s; it must not scan every task.
    expect(plan.map((row) => row.detail).join("\n")).toContain("USING INDEX tasks_status");
    expect(store.listInterruptedTasks().map((row) => row.id)).toEqual([legacy]);
  });
});
