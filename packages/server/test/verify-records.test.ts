// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from "node:fs";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { SqliteStore } from "@melra/storage-sqlite";
import { createMelraRuntime, verifyRecords } from "../src/index.js";

describe("verifyRecords", () => {
  it("reports database_not_found when database does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "melra-test-verify-missing-"));
    try {
      const result = await verifyRecords({ dataDirectory: dir, environment: {} });
      expect(result.ok).toBe(false);
      expect(result.problems?.[0]).toContain("database_not_found");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("verifies an untouched record chain successfully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "melra-test-verify-valid-"));
    const workspace = await mkdtemp(join(tmpdir(), "melra-test-verify-ws-"));
    try {
      const runtime = await createMelraRuntime({
        workspaceRoot: workspace,
        dataDirectory: dir,
        environment: {},
      });
      const task = runtime.controller.plan(
        TaskRequestSchema.parse({
          goal: "verify records test",
          operation: { kind: "system", action: "info" },
        }),
      );
      await runtime.controller.execute(task.id);
      await runtime.close();

      const result = await verifyRecords({ dataDirectory: dir, environment: {} });
      expect(result.ok).toBe(true);
      expect(result.problems).toBeUndefined();
      expect(result.report).toBeDefined();
      expect(result.report?.ok).toBe(true);
      expect(result.report?.head.sequence).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("detects tampered receipts in the database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "melra-test-verify-tamper-"));
    const workspace = await mkdtemp(join(tmpdir(), "melra-test-verify-ws-"));
    try {
      const runtime = await createMelraRuntime({
        workspaceRoot: workspace,
        dataDirectory: dir,
        environment: {},
      });
      const task = runtime.controller.plan(
        TaskRequestSchema.parse({
          goal: "tamper test",
          operation: { kind: "system", action: "info" },
        }),
      );
      await runtime.controller.execute(task.id);
      await runtime.close();

      // Tamper receipt in the database directly
      const db = new DatabaseSync(join(dir, "melra.sqlite"));
      db.exec("DROP TRIGGER IF EXISTS receipts_no_update;");
      db.exec("UPDATE receipts SET data = json_set(data, '$.principal', 'agent:tampered') WHERE rowid = 1;");
      db.close();

      const result = await verifyRecords({ dataDirectory: dir, environment: {} });
      expect(result.ok).toBe(false);
      expect(result.problems).toBeDefined();
      expect(result.problems?.length).toBeGreaterThan(0);
      expect(result.problems?.[0]).toContain("record_changed");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("detects head truncation or mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "melra-test-verify-head-"));
    const workspace = await mkdtemp(join(tmpdir(), "melra-test-verify-ws-"));
    try {
      const runtime = await createMelraRuntime({
        workspaceRoot: workspace,
        dataDirectory: dir,
        environment: {},
      });
      const task = runtime.controller.plan(
        TaskRequestSchema.parse({
          goal: "head test",
          operation: { kind: "system", action: "info" },
        }),
      );
      await runtime.controller.execute(task.id);
      await runtime.close();

      const result = await verifyRecords({
        dataDirectory: dir,
        head: { sequence: 999, link: "0".repeat(64) },
      });
      expect(result.ok).toBe(false);
      expect(result.problems).toBeDefined();
      expect(result.problems?.[0]).toContain("head_truncated");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("handles key mismatch cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "melra-test-verify-key-"));
    const workspace = await mkdtemp(join(tmpdir(), "melra-test-verify-ws-"));
    try {
      const runtime = await createMelraRuntime({
        workspaceRoot: workspace,
        dataDirectory: dir,
        environment: {},
      });
      const task = runtime.controller.plan(
        TaskRequestSchema.parse({
          goal: "key test",
          operation: { kind: "system", action: "info" },
        }),
      );
      await runtime.controller.execute(task.id);
      await runtime.close();

      // Overwrite payload.key with wrong key (valid base64url key, but wrong key)
      await writeFile(join(dir, "payload.key"), Buffer.alloc(32, 7).toString("base64url"));

      const result = await verifyRecords({ dataDirectory: dir, environment: {} });
      expect(result.ok).toBe(false);
      expect(result.problems?.[0]).toContain("payload_key_mismatch");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("never writes a payload key, even for a home with nothing sealed yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "melra-test-verify-nomint-"));
    const workspace = await mkdtemp(join(tmpdir(), "melra-test-verify-ws-"));
    try {
      await (await createMelraRuntime({ workspaceRoot: workspace, dataDirectory: dir, environment: {} })).close();
      await unlink(join(dir, "payload.key"));

      const result = await verifyRecords({ dataDirectory: dir, environment: {} });

      // mint: false: the missing key is reported, never recreated.
      expect(existsSync(join(dir, "payload.key"))).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.problems?.[0]).toContain("payload_key_missing");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("never takes the write lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "melra-test-verify-ro-"));
    const workspace = await mkdtemp(join(tmpdir(), "melra-test-verify-ws-"));
    try {
      await (await createMelraRuntime({ workspaceRoot: workspace, dataDirectory: dir, environment: {} })).close();

      // Hold the write lock for the whole call: a verifier that opened the
      // database as a writer (or took any write transaction) would fail to
      // open or verify under it. WAL readers and writers do not block each
      // other, so only a genuinely read-only verifier survives this.
      const writer = new DatabaseSync(join(dir, "melra.sqlite"));
      writer.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      try {
        expect(await verifyRecords({ dataDirectory: dir, environment: {} })).toMatchObject({ ok: true });
      } finally {
        writer.exec("ROLLBACK");
        writer.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("closes the store exactly once, on every path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "melra-test-verify-close-"));
    const workspace = await mkdtemp(join(tmpdir(), "melra-test-verify-ws-"));
    try {
      await (await createMelraRuntime({ workspaceRoot: workspace, dataDirectory: dir, environment: {} })).close();

      const close = vi.spyOn(SqliteStore.prototype, "close");
      try {
        await verifyRecords({ dataDirectory: dir, environment: {} });
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        close.mockRestore();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
