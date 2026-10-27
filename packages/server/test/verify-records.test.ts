// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { createMelraRuntime, verifyRecords } from "../src/index.js";

describe("verifyRecords", () => {
  it("reports database_not_found when database does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "melra-test-verify-missing-"));
    try {
      const result = await verifyRecords({ dataDirectory: dir });
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

      const result = await verifyRecords({ dataDirectory: dir });
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

      const result = await verifyRecords({ dataDirectory: dir });
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

      const result = await verifyRecords({ dataDirectory: dir });
      expect(result.ok).toBe(false);
      expect(result.problems?.[0]).toContain("payload_key_mismatch");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
