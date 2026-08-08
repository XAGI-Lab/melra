// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReplayComputerAdapter,
  type ComputerTrace,
} from "@melra/computer-runtime";
import { createMelraRuntime } from "@melra/server";
import { TaskRequestSchema } from "@melra/protocol";
import { scenarios, type EvaluationScenario } from "./scenarios.js";

export {
  runDurableCoreEvaluation,
  summarizeDurableCoreRuns,
} from "./durable-core.js";

export interface EvaluationResult {
  id: string;
  category: EvaluationScenario["category"];
  passed: boolean;
  durationMs: number;
  observedPlan?: string;
  observedFinal?: string;
  error?: string;
}

export interface EvaluationReport {
  schemaVersion: "1.0.0";
  generatedAt: string;
  total: number;
  passed: number;
  failed: number;
  results: EvaluationResult[];
}

async function runScenario(scenario: EvaluationScenario): Promise<EvaluationResult> {
  const started = performance.now();
  const root = await mkdtemp(join(tmpdir(), `melra-eval-${scenario.id}-`));
  let policyPath: string | undefined;
  if (scenario.policy !== undefined) {
    policyPath = join(root, "policy.json");
    await writeFile(policyPath, JSON.stringify(scenario.policy));
  }
  // A recorded desktop replaces the machine's own, so a scenario can be
  // approved and executed anywhere instead of stopping at the approval to avoid
  // taking hold of the mouse on whoever is running the suite.
  const desktop =
    scenario.desktop === undefined
      ? undefined
      : new ReplayComputerAdapter(
          JSON.parse(
            await readFile(
              fileURLToPath(
                new URL(`../scenarios/${scenario.desktop}.json`, import.meta.url),
              ),
              "utf8",
            ),
          ) as ComputerTrace,
        );
  const runtime = await createMelraRuntime({
    workspaceRoot: root,
    dataDirectory: join(root, ".melra"),
    ...(policyPath === undefined ? {} : { policyPath }),
    ...(desktop === undefined ? {} : { computerAdapter: desktop }),
  });
  try {
    for (const fixture of scenario.fixtures ?? []) {
      const path = join(root, fixture.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, fixture.content);
    }
    const task = runtime.controller.plan(TaskRequestSchema.parse(scenario.request));
    if (task.status !== scenario.expectedPlan) {
      throw new Error(
        `plan_status:${task.status}; expected:${scenario.expectedPlan}`,
      );
    }
    let observedFinal: string | undefined;
    if (scenario.cancel === true) {
      observedFinal = runtime.controller.cancel(task.id).status;
    } else if (scenario.expectedFinal !== undefined) {
      const approval =
        scenario.approve === true && task.approval !== undefined
          ? {
              approvalId: task.approval.approvalId,
              phrase: task.approval.phrase,
            }
          : undefined;
      const execution = await runtime.controller.execute(task.id, approval);
      observedFinal = execution.task.status;
    }
    if (
      scenario.expectedFinal !== undefined &&
      observedFinal !== scenario.expectedFinal
    ) {
      throw new Error(
        `final_status:${observedFinal}; expected:${scenario.expectedFinal}`,
      );
    }
    return {
      id: scenario.id,
      category: scenario.category,
      passed: true,
      durationMs: Math.round(performance.now() - started),
      observedPlan: task.status,
      ...(observedFinal === undefined ? {} : { observedFinal }),
    };
  } catch (error) {
    return {
      id: scenario.id,
      category: scenario.category,
      passed: false,
      durationMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}

export async function runEvaluations(): Promise<EvaluationReport> {
  const results: EvaluationResult[] = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario));
  const passed = results.filter((result) => result.passed).length;
  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await runEvaluations();
  const path = new URL("../results/latest.json", import.meta.url);
  await mkdir(dirname(fileURLToPath(path)), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.failed === 0 ? 0 : 1;
}
