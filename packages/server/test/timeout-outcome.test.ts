// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { createMelraRuntime } from "../src/index.js";

describe("a terminal mutation stopped by its own timeoutMs", () => {
  it("is an outcome nobody can know, not a failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "melra-timeout-ws-"));
    const home = await mkdtemp(join(tmpdir(), "melra-timeout-home-"));
    const policyPath = join(home, "policy.json");
    await writeFile(
      policyPath,
      JSON.stringify({
        version: "timeout-outcome",
        workspaceRoot: workspace,
        allowedCommands: [process.execPath],
        allowedDomains: [],
        allowLocalhost: false,
        mutations: "confirm",
        approvalTtlMs: 300_000,
        maxFileBytes: 1_000_000,
      }),
    );
    const runtime = await createMelraRuntime({ workspaceRoot: workspace, dataDirectory: home, policyPath, environment: {} });
    try {
      // It does its work, then outlives its timeout.
      const planned = runtime.controller.plan(
        TaskRequestSchema.parse({
          goal: "Write a file, then hang",
          operation: {
            kind: "terminal",
            action: "run",
            command: process.execPath,
            args: ["-e", "require('fs').writeFileSync('a.txt', '1'); setTimeout(() => {}, 10_000)"],
            timeoutMs: 1_000,
          },
          requiredEvidence: [{ type: "file_exists", path: "a.txt" }],
        }),
      );
      const executed = await runtime.controller.execute(planned.id, {
        approvalId: planned.approval!.approvalId,
        phrase: planned.approval!.phrase!,
      });
      expect(existsSync(join(workspace, "a.txt"))).toBe(true);
      // Recorded `failed`, a retry would run it again on top of its own effect.
      expect(executed.task.status).toBe("recovery_required");
    } finally {
      await runtime.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  }, 20_000);
});
