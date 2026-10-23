// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  DURABLE_CORE_MANIFEST_DIGEST,
  digestDurableCoreManifest,
  runDurableCoreEvaluation,
  summarizeDurableCoreRuns,
  type DurableCoreRun,
} from "./durable-core.js";

const scenarioIds = [
  "planned_task_restart",
  "workflow_node_boundary_restart",
  "post_approval_restart",
  "post_adapter_pre_receipt_crash",
  "post_receipt_pre_projection_crash",
  "interrupted_read_retry",
  "interrupted_mutation_reconciliation",
  "duplicate_advance_race",
];

function run(
  scenarioId: string,
  overrides: Partial<DurableCoreRun> = {},
): DurableCoreRun {
  return {
    schemaVersion: "1.0.0",
    scenarioId,
    implementationCommit: "a".repeat(40),
    manifestDigest: DURABLE_CORE_MANIFEST_DIGEST,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    startedAt: "2026-07-30T00:00:00.000Z",
    endedAt: "2026-07-30T00:00:01.000Z",
    valid: true,
    recovered: true,
    adapterCalls: 1,
    duplicateExecutions: 0,
    falseSuccess: false,
    eventConsistent: true,
    receiptIds: [],
    certificateIds: [],
    ...overrides,
  };
}

describe("MELRA Durable Core Alpha evaluation", () => {
  it("pins the immutable manifest digest", () => {
    expect(DURABLE_CORE_MANIFEST_DIGEST).toBe(
      "3d9a072dad1945104edbfe2cea606d624d3df369250bd29052754fb284327986",
    );
  });

  it("keeps the manifest identity stable across checkout line endings", () => {
    expect(digestDurableCoreManifest(Buffer.from("{\r\n}\r\n"))).toBe(
      digestDurableCoreManifest(Buffer.from("{\n}\n")),
    );
  });

  it("summarizes valid recovery evidence and excludes infrastructure runs", () => {
    const runs = [
      ...scenarioIds.map((scenarioId) => run(scenarioId)),
      run("planned_task_restart", {
        valid: false,
        recovered: false,
        failureClass: "infrastructure",
      }),
    ];

    expect(summarizeDurableCoreRuns(runs)).toMatchObject({
      totalRuns: 9,
      validRuns: 8,
      invalidRuns: 1,
      recoveryRate: 1,
      duplicateExecutionRate: 0,
      falseSuccessRate: 0,
      eventConsistencyRate: 1,
    });
  });

  it(
    "runs all eight deterministic crash and concurrency scenarios",
    async () => {
      const { runs, summary } = await runDurableCoreEvaluation();

      expect(runs.map((item) => item.scenarioId)).toEqual(scenarioIds);
      expect(summary).toMatchObject({
        validRuns: 8,
        invalidRuns: 0,
        recoveryRate: 1,
        duplicateExecutionRate: 0,
        falseSuccessRate: 0,
        eventConsistencyRate: 1,
      });
    },
    60_000,
  );
});
