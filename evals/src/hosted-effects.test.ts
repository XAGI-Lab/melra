// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import {
  HOSTED_EFFECTS_MANIFEST_DIGEST,
  loadHostedEffectsManifest,
  passes,
  runHostedEffectsCase,
  runHostedEffectsEvaluation,
  summarizeHostedEffectsRuns,
  type HostedEffectsRun,
} from "./hosted-effects.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const caseIds = [
  "accepted_with_message_id",
  "refused_before_sending",
  "unknown_then_reconciled_found",
  "unknown_then_reconciled_absent",
  "unknown_then_reconcile_unreachable",
  "crash_after_dispatch",
  "duplicate_after_success",
  "accepted_then_bounced",
  "async_plan_awaited",
];

function run(caseId: string, overrides: Partial<HostedEffectsRun> = {}): HostedEffectsRun {
  return {
    schemaVersion: "1.0.0",
    caseId,
    implementationCommit: "a".repeat(40),
    manifestDigest: HOSTED_EFFECTS_MANIFEST_DIGEST,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    startedAt: "2026-11-27T00:00:00.000Z",
    endedAt: "2026-11-27T00:00:01.000Z",
    statuses: ["verified_success"],
    dispatches: 1,
    delivered: true,
    recovered: true,
    duplicateExecution: false,
    falseSuccess: false,
    ...overrides,
  };
}

async function manifestCase(id: string) {
  const found = (await loadHostedEffectsManifest()).cases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
}

describe("MELRA hosted-effects evaluation", () => {
  it("pins the immutable manifest digest", async () => {
    expect(HOSTED_EFFECTS_MANIFEST_DIGEST).toBe(
      "7920aa91236db592de226c4e70cb2064c938fc540749743219ceb57de328750e",
    );
    expect((await loadHostedEffectsManifest()).cases.map((item) => item.id)).toEqual(caseIds);
  });

  it("summarizes rates over all runs and per case", () => {
    const summary = summarizeHostedEffectsRuns([
      run("accepted_with_message_id"),
      run("accepted_with_message_id", { recovered: false }),
      run("accepted_then_bounced", { falseSuccess: true, recovered: false }),
      run("duplicate_after_success", { duplicateExecution: true, recovered: false }),
    ]);
    expect(summary).toMatchObject({
      totalRuns: 4,
      recoveryRate: 0.25,
      duplicateExecutionRate: 0.25,
      falseSuccessRate: 0.25,
      recoveryRateByCase: {
        accepted_with_message_id: 0.5,
        accepted_then_bounced: 0,
        duplicate_after_success: 0,
      },
    });
  });

  it("gates on every case recovering, no duplicate and no false success", () => {
    const clean = caseIds.map((id) => run(id));
    expect(passes(summarizeHostedEffectsRuns(clean))).toBe(true);
    expect(passes(summarizeHostedEffectsRuns([]))).toBe(false);
    for (const fault of [{ recovered: false }, { duplicateExecution: true }, { falseSuccess: true }]) {
      expect(passes(summarizeHostedEffectsRuns([...clean, run("accepted_with_message_id", fault)])), JSON.stringify(fault)).toBe(false);
    }
  });

  it(
    "runs all nine host-executor cases and passes the gate",
    async () => {
      const { runs, summary } = await runHostedEffectsEvaluation();

      expect(runs.map((item) => item.caseId)).toEqual(caseIds);
      expect(runs.filter((item) => !item.recovered), JSON.stringify(runs, null, 2)).toEqual([]);
      expect(summary).toMatchObject({
        totalRuns: 9,
        recoveryRate: 1,
        duplicateExecutionRate: 0,
        falseSuccessRate: 0,
      });
      expect(passes(summary)).toBe(true);
    },
    60_000,
  );

  // Negative controls: a kernel that breaks a guarantee must fail the gate.
  it("catches a verifier that passes a bounced message as a false success", async () => {
    vi.spyOn(Verifier.prototype, "verify").mockResolvedValue({ verified: true, evidence: [] });

    const result = await runHostedEffectsCase(await manifestCase("accepted_then_bounced"), "a".repeat(40));

    expect(result).toMatchObject({ statuses: ["verified_success"], falseSuccess: true, recovered: false });
  });

  it("catches a lost idempotency commit as a duplicate execution", async () => {
    vi.spyOn(SqliteStore.prototype, "getIdempotencyCommit").mockReturnValue(undefined);

    const result = await runHostedEffectsCase(await manifestCase("duplicate_after_success"), "a".repeat(40));

    expect(result).toMatchObject({ dispatches: 2, duplicateExecution: true, recovered: false });
  });
});
