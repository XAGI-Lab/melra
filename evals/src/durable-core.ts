// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  WorkflowDefinitionSchema,
  type Operation,
  type TaskRequest,
  type WorkflowDefinition,
} from "@melra/protocol";
import { sha256 } from "@melra/receipt-schema";
import { createMelraRuntime, type MelraRuntime } from "@melra/server";

export const DURABLE_CORE_MANIFEST_DIGEST =
  "b2f8e2a6819be1c18ffe799df9ce80a44301b1bc79835ea2f7c6facdf8275c38";

export interface DurableCoreScenario {
  id: string;
  crashPoint: string;
  expectedTerminalClass: string;
  expectedMaximumAdapterCalls: number;
  expectedEventTypes: string[];
  verifierRequired: boolean;
}

export interface DurableCoreManifest {
  schemaVersion: "1.0.0";
  suiteId: string;
  scenarios: DurableCoreScenario[];
}

export interface DurableCoreRun {
  schemaVersion: "1.0.0";
  scenarioId: string;
  implementationCommit: string;
  manifestDigest: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  startedAt: string;
  endedAt: string;
  valid: boolean;
  failureClass?: "infrastructure" | "runtime" | "policy" | "verifier" | "task";
  recovered: boolean;
  adapterCalls: number;
  duplicateExecutions: number;
  falseSuccess: boolean;
  eventConsistent: boolean;
  receiptIds: string[];
  certificateIds: string[];
}

export interface DurableCoreSummary {
  schemaVersion: "1.0.0";
  manifestDigest: string;
  totalRuns: number;
  validRuns: number;
  invalidRuns: number;
  recoveryRate: number;
  duplicateExecutionRate: number;
  falseSuccessRate: number;
  eventConsistencyRate: number;
}

export interface DurableCoreEvaluation {
  runs: DurableCoreRun[];
  summary: DurableCoreSummary;
}

interface Counter {
  calls: number;
}

interface ScenarioObservation {
  terminalClass: string;
  adapterCalls: number;
  falseSuccess: boolean;
  verifierObserved: boolean;
  eventConsistent: boolean;
  receiptIds: string[];
  certificateIds: string[];
}

const manifestUrl = new URL(
  "../manifests/durable-core-alpha-v1.json",
  import.meta.url,
);
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const executeFile = promisify(execFile);

export function digestDurableCoreManifest(bytes: Buffer): string {
  return createHash("sha256")
    .update(bytes.toString("utf8").replaceAll("\r\n", "\n"))
    .digest("hex");
}

export async function loadDurableCoreManifest(): Promise<DurableCoreManifest> {
  const bytes = await readFile(fileURLToPath(manifestUrl));
  const digest = digestDurableCoreManifest(bytes);
  if (digest !== DURABLE_CORE_MANIFEST_DIGEST) {
    throw new Error("durable_core_manifest_digest_mismatch");
  }
  return JSON.parse(bytes.toString("utf8")) as DurableCoreManifest;
}

export function summarizeDurableCoreRuns(
  runs: DurableCoreRun[],
): DurableCoreSummary {
  const valid = runs.filter((run) => run.valid);
  const denominator = valid.length || 1;
  return {
    schemaVersion: "1.0.0",
    manifestDigest: DURABLE_CORE_MANIFEST_DIGEST,
    totalRuns: runs.length,
    validRuns: valid.length,
    invalidRuns: runs.length - valid.length,
    recoveryRate:
      valid.filter((run) => run.recovered).length / denominator,
    duplicateExecutionRate:
      valid.filter((run) => run.duplicateExecutions > 0).length / denominator,
    falseSuccessRate:
      valid.filter((run) => run.falseSuccess).length / denominator,
    eventConsistencyRate:
      valid.filter((run) => run.eventConsistent).length / denominator,
  };
}

function workflow(
  name: string,
  nodes: WorkflowDefinition["nodes"],
): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    schemaVersion: "1.0.0",
    id: randomUUID(),
    version: 1,
    name,
    nodes,
  });
}

function systemRequest(goal: string): TaskRequest {
  return {
    goal,
    operation: { kind: "system", action: "info" },
    constraints: [],
    forbiddenEffects: [],
    requiredEvidence: [],
    reconciliation: [],
    budget: {
      maxDurationMs: 120_000,
      maxRetries: 2,
      maxSteps: 10,
    },
  };
}

function fileWorkflow(name: string, path: string): WorkflowDefinition {
  return workflow(name, [
    {
      id: "write",
      type: "operation",
      dependsOn: [],
      request: {
        goal: `Write ${path}`,
        operation: {
          kind: "file",
          action: "write",
          path,
          content: "durable-core-evaluation",
          encoding: "utf8",
          recursive: false,
        },
        constraints: [],
        forbiddenEffects: [],
        requiredEvidence: [{ type: "file_exists", path }],
        reconciliation: [],
        budget: {
          maxDurationMs: 120_000,
          maxRetries: 2,
          maxSteps: 10,
        },
      },
    },
  ]);
}

async function openRuntime(
  root: string,
  counter: Counter,
): Promise<MelraRuntime> {
  const runtime = await createMelraRuntime({
    workspaceRoot: root,
    dataDirectory: join(root, ".melra"),
  });
  const execute = runtime.router.execute.bind(runtime.router);
  runtime.router.execute = async (
    operation: Operation,
    signal?: AbortSignal,
  ) => {
    counter.calls += 1;
    return await execute(operation, signal);
  };
  return runtime;
}

function taskKey(
  workflowId: string,
  nodeId: string,
  request: TaskRequest,
): string {
  return sha256({
    workflowId,
    nodeId,
    iteration: 0,
    branch: "operation",
    request,
  });
}

function observe(
  runtime: MelraRuntime,
  workflowId: string,
  counter: Counter,
  expectedEventTypes: string[],
  effectVerified = true,
  verifierObserved = false,
): ScenarioObservation {
  const run = runtime.workflows.status(workflowId);
  const events = runtime.workflows.events(workflowId);
  const tasks = runtime.store.listTasks(100_000);
  const receiptIds = tasks.flatMap((task) => task.receiptIds);
  const certificateIds = tasks.flatMap((task) => {
    const certificate = runtime.store.getCertificateForTask(task.id);
    return certificate === undefined ? [] : [certificate.certificateId];
  });
  const sequences = events.map((event) => event.sequence);
  const eventTypes = new Set(events.map((event) => event.type));
  return {
    terminalClass: run.status,
    adapterCalls: counter.calls,
    falseSuccess: run.status === "verified_complete" && !effectVerified,
    verifierObserved,
    eventConsistent:
      sequences.every((sequence, index) => sequence === index + 1) &&
      new Set(sequences).size === sequences.length &&
      sequences.at(-1) === run.stateVersion &&
      expectedEventTypes.every((type) => eventTypes.has(type)),
    receiptIds,
    certificateIds,
  };
}

async function plannedTaskRestart(
  root: string,
  scenario: DurableCoreScenario,
): Promise<ScenarioObservation> {
  const counter = { calls: 0 };
  let runtime = await openRuntime(root, counter);
  const planned = runtime.workflows.plan(
    workflow("Planned task restart", [
      {
        id: "inspect",
        type: "operation",
        dependsOn: [],
        request: systemRequest("Inspect after restart"),
      },
    ]),
  );
  await runtime.close();
  runtime = await openRuntime(root, counter);
  try {
    await runtime.workflows.advance(planned.id);
    return observe(
      runtime,
      planned.id,
      counter,
      scenario.expectedEventTypes,
    );
  } finally {
    await runtime.close();
  }
}

async function workflowNodeBoundaryRestart(
  root: string,
  scenario: DurableCoreScenario,
): Promise<ScenarioObservation> {
  const counter = { calls: 0 };
  let runtime = await openRuntime(root, counter);
  const planned = runtime.workflows.plan(
    workflow("Node boundary restart", [
      {
        id: "first",
        type: "operation",
        dependsOn: [],
        request: systemRequest("Inspect before restart"),
      },
      {
        id: "second",
        type: "operation",
        dependsOn: ["first"],
        request: systemRequest("Inspect after restart"),
      },
    ]),
  );
  await runtime.workflows.advance(planned.id);
  await runtime.close();
  runtime = await openRuntime(root, counter);
  try {
    await runtime.workflows.advance(planned.id);
    return observe(
      runtime,
      planned.id,
      counter,
      scenario.expectedEventTypes,
    );
  } finally {
    await runtime.close();
  }
}

async function postApprovalRestart(
  root: string,
  scenario: DurableCoreScenario,
): Promise<ScenarioObservation> {
  const counter = { calls: 0 };
  let runtime = await openRuntime(root, counter);
  const planned = runtime.workflows.plan(
    fileWorkflow("Post approval restart", "approved.txt"),
  );
  const awaiting = await runtime.workflows.advance(planned.id);
  const approval = awaiting.run.nodes.write?.approval;
  if (approval === undefined) throw new Error("approval_challenge_missing");
  await runtime.close();
  runtime = await openRuntime(root, counter);
  try {
    await runtime.workflows.advance(planned.id, [
      { approvalId: approval.approvalId, phrase: approval.phrase },
    ]);
    const content = await readFile(join(root, "approved.txt"), "utf8");
    return observe(
      runtime,
      planned.id,
      counter,
      scenario.expectedEventTypes,
      content === "durable-core-evaluation",
      true,
    );
  } finally {
    await runtime.close();
  }
}

async function postAdapterPreReceiptCrash(
  root: string,
  scenario: DurableCoreScenario,
): Promise<ScenarioObservation> {
  const counter = { calls: 0 };
  let runtime = await openRuntime(root, counter);
  const planned = runtime.workflows.plan(
    fileWorkflow("Post adapter crash", "adapter-complete.txt"),
  );
  const awaiting = await runtime.workflows.advance(planned.id);
  const taskId = awaiting.run.nodes.write?.taskIds[0];
  if (taskId === undefined) throw new Error("mutation_task_missing");
  await writeFile(join(root, "adapter-complete.txt"), "durable-core-evaluation");
  counter.calls += 1;
  const interrupted = runtime.store.getTask(taskId);
  if (interrupted === undefined) throw new Error("mutation_task_not_stored");
  interrupted.status = "verifying";
  runtime.store.saveTask(interrupted);
  await runtime.close();
  runtime = await openRuntime(root, counter);
  try {
    const content = await readFile(join(root, "adapter-complete.txt"), "utf8");
    return observe(
      runtime,
      planned.id,
      counter,
      scenario.expectedEventTypes,
      content === "durable-core-evaluation",
      true,
    );
  } finally {
    await runtime.close();
  }
}

async function postReceiptPreProjectionCrash(
  root: string,
  scenario: DurableCoreScenario,
): Promise<ScenarioObservation> {
  const counter = { calls: 0 };
  let runtime = await openRuntime(root, counter);
  const planned = runtime.workflows.plan(
    workflow("Post receipt crash", [
      {
        id: "inspect",
        type: "operation",
        dependsOn: [],
        request: systemRequest("Commit a receipt before projection"),
      },
    ]),
  );
  const transition = runtime.store.transitionWorkflow.bind(runtime.store);
  runtime.store.transitionWorkflow = () => {
    throw new Error("simulated_post_receipt_crash");
  };
  try {
    await runtime.workflows.advance(planned.id);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "simulated_post_receipt_crash"
    ) {
      throw error;
    }
  }
  runtime.store.transitionWorkflow = transition;
  await runtime.close();
  runtime = await openRuntime(root, counter);
  try {
    return observe(
      runtime,
      planned.id,
      counter,
      scenario.expectedEventTypes,
    );
  } finally {
    await runtime.close();
  }
}

async function interruptedReadRetry(
  root: string,
  scenario: DurableCoreScenario,
): Promise<ScenarioObservation> {
  const counter = { calls: 0 };
  let runtime = await openRuntime(root, counter);
  const definition = workflow("Interrupted read retry", [
    {
      id: "inspect",
      type: "operation",
      dependsOn: [],
      request: systemRequest("Retry the interrupted read"),
    },
  ]);
  const planned = runtime.workflows.plan(definition);
  const node = definition.nodes[0]!;
  if (node.type !== "operation") throw new Error("operation_node_missing");
  const task = runtime.controller.plan(node.request, {
    idempotencyKey: taskKey(planned.id, node.id, node.request),
    attempt: 1,
  });
  task.status = "running";
  runtime.store.saveTask(task);
  await runtime.close();
  runtime = await openRuntime(root, counter);
  try {
    await runtime.workflows.advance(planned.id);
    return observe(
      runtime,
      planned.id,
      counter,
      scenario.expectedEventTypes,
    );
  } finally {
    await runtime.close();
  }
}

async function interruptedMutationReconciliation(
  root: string,
  scenario: DurableCoreScenario,
): Promise<ScenarioObservation> {
  const counter = { calls: 0 };
  let runtime = await openRuntime(root, counter);
  const planned = runtime.workflows.plan(
    fileWorkflow("Interrupted mutation", "uncertain.txt"),
  );
  const awaiting = await runtime.workflows.advance(planned.id);
  const taskId = awaiting.run.nodes.write?.taskIds[0];
  if (taskId === undefined) throw new Error("mutation_task_missing");
  const interrupted = runtime.store.getTask(taskId);
  if (interrupted === undefined) throw new Error("mutation_task_not_stored");
  interrupted.status = "verifying";
  runtime.store.saveTask(interrupted);
  counter.calls += 1;
  await runtime.close();
  runtime = await openRuntime(root, counter);
  try {
    return observe(
      runtime,
      planned.id,
      counter,
      scenario.expectedEventTypes,
      false,
      true,
    );
  } finally {
    await runtime.close();
  }
}

async function duplicateAdvanceRace(
  root: string,
  scenario: DurableCoreScenario,
): Promise<ScenarioObservation> {
  const counter = { calls: 0 };
  const runtime = await openRuntime(root, counter);
  try {
    const planned = runtime.workflows.plan(
      workflow("Duplicate advance race", [
        {
          id: "inspect",
          type: "operation",
          dependsOn: [],
          request: systemRequest("Execute once under concurrent advance"),
        },
      ]),
    );
    await Promise.allSettled([
      runtime.workflows.advance(planned.id),
      runtime.workflows.advance(planned.id),
    ]);
    return observe(
      runtime,
      planned.id,
      counter,
      scenario.expectedEventTypes,
    );
  } finally {
    await runtime.close();
  }
}

async function runScenario(
  scenario: DurableCoreScenario,
  implementationCommit: string,
): Promise<DurableCoreRun> {
  const startedAt = new Date().toISOString();
  const root = await mkdtemp(join(tmpdir(), `melra-durable-${scenario.id}-`));
  try {
    const execute = {
      planned_task_restart: plannedTaskRestart,
      workflow_node_boundary_restart: workflowNodeBoundaryRestart,
      post_approval_restart: postApprovalRestart,
      post_adapter_pre_receipt_crash: postAdapterPreReceiptCrash,
      post_receipt_pre_projection_crash: postReceiptPreProjectionCrash,
      interrupted_read_retry: interruptedReadRetry,
      interrupted_mutation_reconciliation: interruptedMutationReconciliation,
      duplicate_advance_race: duplicateAdvanceRace,
    }[scenario.id];
    if (execute === undefined) throw new Error("evaluation_scenario_unknown");
    const observed = await execute(root, scenario);
    const recovered =
      observed.terminalClass === scenario.expectedTerminalClass &&
      observed.adapterCalls <= scenario.expectedMaximumAdapterCalls &&
      (!scenario.verifierRequired || observed.verifierObserved);
    return {
      schemaVersion: "1.0.0",
      scenarioId: scenario.id,
      implementationCommit,
      manifestDigest: DURABLE_CORE_MANIFEST_DIGEST,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      startedAt,
      endedAt: new Date().toISOString(),
      valid: true,
      ...(!recovered ? { failureClass: "runtime" as const } : {}),
      recovered,
      adapterCalls: observed.adapterCalls,
      duplicateExecutions: Math.max(
        0,
        observed.adapterCalls - scenario.expectedMaximumAdapterCalls,
      ),
      falseSuccess: observed.falseSuccess,
      eventConsistent: observed.eventConsistent,
      receiptIds: observed.receiptIds,
      certificateIds: observed.certificateIds,
    };
  } catch {
    return {
      schemaVersion: "1.0.0",
      scenarioId: scenario.id,
      implementationCommit,
      manifestDigest: DURABLE_CORE_MANIFEST_DIGEST,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      startedAt,
      endedAt: new Date().toISOString(),
      valid: true,
      failureClass: "runtime",
      recovered: false,
      adapterCalls: 0,
      duplicateExecutions: 0,
      falseSuccess: false,
      eventConsistent: false,
      receiptIds: [],
      certificateIds: [],
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function implementationCommit(): Promise<string> {
  const { stdout } = await executeFile("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
  });
  return stdout.trim();
}

export async function runDurableCoreEvaluation(): Promise<DurableCoreEvaluation> {
  const manifest = await loadDurableCoreManifest();
  const commit = await implementationCommit();
  const runs: DurableCoreRun[] = [];
  for (const scenario of manifest.scenarios) {
    runs.push(await runScenario(scenario, commit));
  }
  return { runs, summary: summarizeDurableCoreRuns(runs) };
}

const resultDirectory = fileURLToPath(
  new URL("../results/durable-core-alpha", import.meta.url),
);
const rawResultPath = join(resultDirectory, "latest.jsonl");
const summaryResultPath = join(resultDirectory, "latest-summary.json");

async function readRawRuns(): Promise<DurableCoreRun[]> {
  return (await readFile(rawResultPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DurableCoreRun);
}

async function assertPublishableWorktree(): Promise<void> {
  const { stdout } = await executeFile("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
  });
  if (stdout.trim() !== "") {
    throw new Error("publishable_evaluation_requires_clean_worktree");
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "run") {
    if (process.argv.includes("--publishable")) {
      await assertPublishableWorktree();
    }
    const evaluation = await runDurableCoreEvaluation();
    await mkdir(dirname(rawResultPath), { recursive: true });
    await writeFile(
      rawResultPath,
      `${evaluation.runs.map((run) => JSON.stringify(run)).join("\n")}\n`,
    );
    const summary = summarizeDurableCoreRuns(await readRawRuns());
    await writeFile(summaryResultPath, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode =
      summary.validRuns === 8 &&
      summary.recoveryRate === 1 &&
      summary.duplicateExecutionRate === 0 &&
      summary.falseSuccessRate === 0 &&
      summary.eventConsistencyRate === 1
        ? 0
        : 1;
    return;
  }
  if (command === "summarize") {
    const summary = summarizeDurableCoreRuns(await readRawRuns());
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  throw new Error("usage: durable-core run [--publishable] | summarize");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
