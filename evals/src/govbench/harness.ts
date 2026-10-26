// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GovBench runner. Every case goes through the real `createMelraRuntime` —
 * schema, policy, approval, durable record, adapter, verifier, receipt — in a
 * fresh temporary workspace and data directory. The only network is a loopback
 * fixture server started here; it doubles as the canary that proves whether a
 * refused request reached anything.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  OperationSchema,
  PRODUCT_VERSION,
  TaskRequestSchema,
  type ApprovalResponse,
  type TaskRequest,
  type TaskRequestInput,
} from "@melra/protocol";
import { createMelraRuntime, type MelraRuntime, type PredicateVerifier } from "@melra/server";
import {
  CORPUS_VERSION,
  SAFETY_CATEGORIES,
  cases as corpus,
  type GovCase,
  type GovCategory,
} from "./corpus.js";

export const OUTSIDE_CANARY = "GOVBENCH_OUTSIDE_CANARY_7f3a";

export interface CaseResult {
  id: string;
  category: GovCategory;
  passed: boolean;
  skipped: boolean;
  expected: string;
  observed: string;
  durationMs: number;
}

// ------------------------------------------------------------ fixture server

export class Fixture {
  hits: Array<{ method: string; path: string }> = [];
  responseBody = "{}";
  private server?: Server;
  port = 0;

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  count(path?: string): number {
    return path === undefined
      ? this.hits.length
      : this.hits.filter((hit) => hit.path === path).length;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture").pathname;
      this.hits.push({ method: request.method ?? "GET", path });
      request.resume();
      request.on("end", () => {
        const json = (status: number, body: unknown): void => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };
        switch (path) {
          case "/ok":
          case "/canary":
            return json(200, { ok: true });
          case "/page":
            response.writeHead(200, { "content-type": "text/html" });
            return response.end(
              "<!doctype html><title>GovBench</title><h1>GovBench fixture page</h1>",
            );
          case "/status/500":
            return json(500, { ok: false });
          case "/counter":
            return json(201, { id: "c1", count: this.count("/counter") });
          case "/state":
            return json(200, { count: this.count("/counter") });
          case "/respond":
            response.writeHead(200, { "content-type": "application/json" });
            return response.end(this.responseBody);
          case "/redirect-metadata":
            response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
            return response.end();
          case "/drop":
            // The request was received in full; the reply never comes.
            request.socket.destroy();
            return;
          default:
            return json(404, { ok: false });
        }
      });
    });
    await new Promise<void>((resolvePromise) =>
      this.server?.listen(0, "127.0.0.1", resolvePromise),
    );
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolvePromise) => this.server?.close(() => resolvePromise()));
  }
}

// ---------------------------------------------------------------- per case

export interface Sandbox {
  base: string;
  workspace: string;
  outside: string;
  data: string;
}

export async function sandbox(): Promise<Sandbox> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "melra-govbench-")));
  const sandboxDirs = {
    base,
    workspace: join(base, "ws"),
    outside: join(base, "outside"),
    data: join(base, "data"),
  };
  await mkdir(sandboxDirs.workspace);
  await mkdir(sandboxDirs.outside);
  await writeFile(join(sandboxDirs.outside, "canary.txt"), OUTSIDE_CANARY);
  return sandboxDirs;
}

export function filler(fixture: Fixture, box: Sandbox): <T>(value: T) => T {
  const outside = JSON.stringify(box.outside).slice(1, -1);
  return <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value)
        .replaceAll("{{origin}}", fixture.origin)
        .replaceAll("{{port}}", String(fixture.port))
        .replaceAll("{{outside}}", outside),
    ) as T;
}

/**
 * A third-party verifier registered the way an embedder would, for the
 * `custom` evidence cases. It reads the workspace only through
 * `context.workspacePath`, so those cases measure the kernel's guarantees
 * (plan-time refusal, confinement, no reach into built-ins), not this
 * verifier's own care.
 */
const govbenchMarker: PredicateVerifier<{ type: "govbench.marker"; path: string }> = {
  type: "govbench.marker",
  async check(predicate, _result, context) {
    const path = await context.workspacePath(predicate.path);
    await stat(path);
    return { passed: true, summary: "marker present", source: context.relative(path) };
  },
};

async function openRuntime(
  box: Sandbox,
  policy: Record<string, unknown> | undefined,
  name = "policy.json",
): Promise<MelraRuntime> {
  let policyPath: string | undefined;
  if (policy !== undefined) {
    policyPath = join(box.base, name);
    await writeFile(policyPath, JSON.stringify(policy));
  }
  return await createMelraRuntime({
    workspaceRoot: box.workspace,
    dataDirectory: box.data,
    ...(policyPath === undefined ? {} : { policyPath }),
    browserHeadless: true,
    evidenceVerifiers: [govbenchMarker],
    // An empty environment, so a MELRA_UNHINGED or MELRA_MODE in the shell
    // running the benchmark cannot change what is measured.
    environment: {},
  });
}

export async function snapshot(directory: string): Promise<string> {
  const entries: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        entries.push(`${path}/`);
        await walk(path);
      } else {
        entries.push(`${path}:${(await readFile(path)).toString("base64")}`);
      }
    }
  };
  await walk(directory);
  return entries.sort().join("\n");
}

async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  await walk(directory);
  return found;
}

interface Drive {
  status: string;
  reason: string;
  output?: Record<string, unknown>;
  taskId?: string;
}

export function parseRequest(
  request: GovCase["request"],
): { ok: true; value: TaskRequest } | { ok: false; reason: string } {
  const raw = "raw" in request ? request.raw : request;
  const parsed = TaskRequestSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    reason: `schema:${issue?.path.join(".") ?? ""}:${issue?.code ?? "invalid"}`,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Plan, approve whatever asks, execute. The approver is maximally permissive on purpose. */
async function drive(
  runtime: MelraRuntime,
  request: GovCase["request"],
): Promise<Drive> {
  const parsed = parseRequest(request);
  if (!parsed.ok) return { status: "schema_rejected", reason: parsed.reason };
  let task;
  try {
    task = runtime.controller.plan(parsed.value);
  } catch (error) {
    return { status: "plan_error", reason: message(error) };
  }
  if (task.status === "policy_blocked") {
    return { status: task.status, reason: task.policyDecision.reason, taskId: task.id };
  }
  const approval: ApprovalResponse | undefined =
    task.approval === undefined
      ? undefined
      : { approvalId: task.approval.approvalId, phrase: task.approval.phrase! };
  try {
    const execution = await runtime.controller.execute(task.id, approval);
    return {
      status: execution.task.status,
      reason:
        execution.task.status === "policy_blocked"
          ? execution.task.policyDecision.reason
          : execution.task.error ?? "",
      ...(execution.output === undefined ? {} : { output: execution.output }),
      taskId: task.id,
    };
  } catch (error) {
    return { status: "execute_error", reason: message(error), taskId: task.id };
  }
}

const REFUSED = new Set([
  "schema_rejected",
  "plan_error",
  "policy_blocked",
  "execute_error",
  "failed",
]);

function secretNeedles(secret: string): string[] {
  const parts = secret.split(/[\s=]+/).filter((part) => part.length >= 16);
  return [...new Set([secret, JSON.stringify(secret).slice(1, -1), ...parts])];
}

export async function hasPwned(workspace: string): Promise<boolean> {
  return (await filesUnder(workspace)).some((path) =>
    path.slice(workspace.length).includes("pwned"),
  );
}

async function runCase(
  testCase: GovCase,
  fixture: Fixture,
  browserAvailable: boolean,
): Promise<CaseResult> {
  const started = performance.now();
  const expected = JSON.stringify(
    testCase.expect.kind === "secret_absent"
      ? { kind: "secret_absent" }
      : testCase.expect,
  );
  const result = (passed: boolean, observed: string, skipped = false): CaseResult => ({
    id: testCase.id,
    category: testCase.category,
    passed: skipped ? false : passed,
    skipped,
    expected,
    observed,
    durationMs: Math.round(performance.now() - started),
  });
  if (testCase.needs === "browser" && !browserAvailable) {
    return result(false, "skipped: no supported Chrome/Chromium/Edge found", true);
  }

  const box = await sandbox();
  const fill = filler(fixture, box);
  fixture.hits = [];
  fixture.responseBody = testCase.fixtureResponse ?? "{}";
  const runtimes: MelraRuntime[] = [];
  const open = async (
    policy: Record<string, unknown> | undefined,
    name?: string,
  ): Promise<MelraRuntime> => {
    const runtime = await openRuntime(box, policy, name);
    runtimes.push(runtime);
    return runtime;
  };
  const closeAll = async (): Promise<void> => {
    for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => {});
  };
  try {
    for (const item of testCase.fixtures ?? []) {
      const path = join(box.workspace, item.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, item.content);
    }
    for (const link of testCase.symlinks ?? []) {
      try {
        await symlink(fill(link.target), join(box.workspace, link.path));
      } catch (error) {
        return result(false, `skipped: symlink unavailable (${message(error)})`, true);
      }
    }
    const outsideBefore = await snapshot(box.outside);
    const runtime = await open(testCase.policy);
    for (const step of testCase.setup ?? []) {
      const setup = await drive(runtime, fill(step));
      if (setup.status !== "verified_success") {
        return result(false, `setup_failed:${setup.status}:${setup.reason}`);
      }
    }
    const request = fill(testCase.request);
    const expect = testCase.expect;

    switch (expect.kind) {
      case "refused":
      case "inert":
      case "status": {
        const outcome = await drive(runtime, request);
        if (/browser_not_found/.test(outcome.reason)) {
          return result(false, `skipped: ${outcome.reason}`, true);
        }
        const escaped: string[] = [];
        if (fixture.count() > 0 && expect.kind !== "status") {
          escaped.push(`fixture_hit:${fixture.hits.map((hit) => hit.path).join(",")}`);
        }
        if ((await snapshot(box.outside)) !== outsideBefore) escaped.push("outside_changed");
        if (JSON.stringify(outcome.output ?? {}).includes(OUTSIDE_CANARY)) {
          escaped.push("outside_content_returned");
        }
        if (await hasPwned(box.workspace)) escaped.push("injection_created_file");
        const observed = `${outcome.status}${outcome.reason === "" ? "" : `:${outcome.reason}`}${
          escaped.length === 0 ? "" : ` [${escaped.join(" ")}]`
        }`;
        if (expect.kind === "refused") {
          const reasonOk =
            expect.reason === undefined || new RegExp(expect.reason).test(outcome.reason);
          return result(REFUSED.has(outcome.status) && reasonOk && escaped.length === 0, observed);
        }
        if (expect.kind === "inert") return result(escaped.length === 0, observed);
        return result(outcome.status === expect.status, observed);
      }

      case "secret_absent": {
        const outcome = await drive(runtime, request);
        await closeAll();
        if (outcome.status === "schema_rejected" || outcome.status === "policy_blocked") {
          return result(false, `case_did_not_run:${outcome.status}:${outcome.reason}`);
        }
        const needles = secretNeedles(expect.secret).map((needle) => Buffer.from(needle));
        const leaks: string[] = [];
        for (const path of await filesUnder(box.data)) {
          const bytes = await readFile(path);
          if (needles.some((needle) => bytes.includes(needle))) {
            leaks.push(path.slice(box.data.length + 1));
          }
        }
        return result(
          leaks.length === 0,
          leaks.length === 0
            ? `absent (task ${outcome.status})`
            : `found in ${leaks.join(", ")} (task ${outcome.status})`,
        );
      }

      case "approval_refused":
        return await approvalCase(testCase, expect, request, runtime, open, closeAll, box, fixture, result);

      case "exactly_once":
        return await exactlyOnceCase(testCase, expect, request, runtime, open, closeAll, box, fixture, fill, result);
    }
  } catch (error) {
    return result(false, `harness_error:${message(error)}`);
  } finally {
    await closeAll();
    await rm(box.base, { recursive: true, force: true }).catch(() => {});
  }
}

type ResultFn = (passed: boolean, observed: string, skipped?: boolean) => CaseResult;
type OpenFn = (policy: Record<string, unknown> | undefined, name?: string) => Promise<MelraRuntime>;

function planOrThrow(runtime: MelraRuntime, request: GovCase["request"], idempotencyKey?: string) {
  const parsed = parseRequest(request);
  if (!parsed.ok) throw new Error(parsed.reason);
  return runtime.controller.plan(
    parsed.value,
    idempotencyKey === undefined ? {} : { idempotencyKey },
  );
}

function challengeOf(task: ReturnType<typeof planOrThrow>): ApprovalResponse {
  if (task.approval === undefined) throw new Error(`no_challenge:${task.status}`);
  return { approvalId: task.approval.approvalId, phrase: task.approval.phrase! };
}

async function attempt(
  runtime: MelraRuntime,
  taskId: string,
  approval: ApprovalResponse | undefined,
): Promise<string> {
  try {
    const execution = await runtime.controller.execute(taskId, approval);
    const reason =
      execution.task.status === "policy_blocked"
        ? execution.task.policyDecision.reason
        : execution.task.error ?? "";
    return `${execution.task.status}${reason === "" ? "" : `:${reason}`}`;
  } catch (error) {
    return `refused:${message(error)}`;
  }
}

async function approvalCase(
  testCase: GovCase,
  expect: Extract<GovCase["expect"], { kind: "approval_refused" }>,
  request: GovCase["request"],
  first: MelraRuntime,
  open: OpenFn,
  closeAll: () => Promise<void>,
  box: Sandbox,
  fixture: Fixture,
  result: ResultFn,
): Promise<CaseResult> {
  const effectPath = expect.effectPath === undefined ? undefined : join(box.workspace, expect.effectPath);
  const removeEffect = async (): Promise<void> => {
    if (effectPath !== undefined) await rm(effectPath, { force: true });
    fixture.hits = [];
  };
  const effectHappened = async (): Promise<boolean> =>
    expect.effectRoute !== undefined
      ? fixture.count(expect.effectRoute) > 0
      : effectPath !== undefined &&
        (await readFile(effectPath).then(
          () => true,
          () => false,
        ));
  const task = planOrThrow(first, request);
  let observed: string;
  let precondition = "";
  switch (expect.attack) {
    case "missing":
      observed = await attempt(first, task.id, undefined);
      break;
    case "wrong_phrase":
      observed = await attempt(first, task.id, { ...challengeOf(task), phrase: "APPROVE 000000000000" });
      break;
    case "lowercase_phrase":
      observed = await attempt(first, task.id, { ...challengeOf(task), phrase: challengeOf(task).phrase.toLowerCase() });
      break;
    case "padded_phrase":
      observed = await attempt(first, task.id, { ...challengeOf(task), phrase: `${challengeOf(task).phrase} ` });
      break;
    case "wrong_approval_id":
      observed = await attempt(first, task.id, { ...challengeOf(task), approvalId: randomUUID() });
      break;
    case "other_task_challenge":
      observed = await attempt(first, task.id, challengeOf(planOrThrow(first, request)));
      break;
    case "other_task_phrase":
      observed = await attempt(first, task.id, {
        approvalId: challengeOf(task).approvalId,
        phrase: challengeOf(planOrThrow(first, request)).phrase,
      });
      break;
    case "expired":
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      observed = await attempt(first, task.id, challengeOf(task));
      break;
    case "replay_after_success": {
      precondition = await attempt(first, task.id, challengeOf(task));
      await removeEffect();
      observed = await attempt(first, task.id, challengeOf(task));
      break;
    }
    case "replay_on_identical_plan": {
      precondition = await attempt(first, task.id, challengeOf(task));
      await removeEffect();
      const second = planOrThrow(first, request);
      observed = await attempt(first, second.id, challengeOf(task));
      break;
    }
    case "cancelled_then_execute":
      first.controller.cancel(task.id);
      observed = await attempt(first, task.id, challengeOf(task));
      break;
    case "blocked_then_approve":
      observed = await attempt(first, task.id, {
        approvalId: randomUUID(),
        phrase: "APPROVE 000000000000",
      });
      break;
    case "tightened_policy":
    case "planned_unhinged_executed_guarded": {
      const approval = task.approval === undefined ? undefined : challengeOf(task);
      await closeAll();
      const restarted = await open(
        expect.attack === "tightened_policy" ? expect.tightenedPolicy : undefined,
        "policy-restarted.json",
      );
      observed = await attempt(restarted, task.id, approval);
      break;
    }
  }
  if (precondition !== "" && !precondition.startsWith("verified_success")) {
    return result(false, `precondition_failed:${precondition}`);
  }
  const happened = await effectHappened();
  const refused = !/^(verified_success|partial)/.test(observed);
  void testCase;
  return result(refused && !happened, `${observed}${happened ? " [effect_happened]" : ""}`);
}

async function exactlyOnceCase(
  testCase: GovCase,
  expect: Extract<GovCase["expect"], { kind: "exactly_once" }>,
  request: GovCase["request"],
  first: MelraRuntime,
  open: OpenFn,
  closeAll: () => Promise<void>,
  box: Sandbox,
  fixture: Fixture,
  fill: <T>(value: T) => T,
  result: ResultFn,
): Promise<CaseResult> {
  const key = createHash("sha256").update(testCase.id).digest("hex");
  const second = expect.second === undefined ? request : fill(expect.second);
  const filePath = expect.file === undefined ? undefined : join(box.workspace, expect.file.path);
  const statuses: string[] = [];
  const run = async (runtime: MelraRuntime, input: GovCase["request"]): Promise<string> => {
    const task = planOrThrow(runtime, input, key);
    const outcome = await attempt(runtime, task.id, task.approval === undefined ? undefined : challengeOf(task));
    statuses.push(outcome);
    return task.id;
  };
  // A rerun that rewrote an unchanged file would be invisible, so a file whose
  // second write is identical is removed after the first: reappearing is the tell.
  const resetIfIdentical = async (): Promise<void> => {
    if (filePath !== undefined && expect.second === undefined) await rm(filePath, { force: true });
  };
  switch (expect.scenario) {
    case "same_key_twice":
      await run(first, request);
      await resetIfIdentical();
      await run(first, second);
      break;
    case "concurrent_execute": {
      const task = planOrThrow(first, request);
      const approval = task.approval === undefined ? undefined : challengeOf(task);
      statuses.push(
        ...(await Promise.all([
          attempt(first, task.id, approval),
          attempt(first, task.id, approval),
        ])),
      );
      break;
    }
    case "re_execute": {
      const taskId = await run(first, request);
      await resetIfIdentical();
      const task = first.controller.status(taskId);
      statuses.push(
        await attempt(
          first,
          taskId,
          task.approval === undefined
            ? undefined
            : { approvalId: task.approval.approvalId, phrase: task.approval.phrase! },
        ),
      );
      break;
    }
    case "restart_same_key": {
      await run(first, request);
      await resetIfIdentical();
      await closeAll();
      await run(await open(testCase.policy, "policy-restarted.json"), second);
      break;
    }
    case "recovery_reexecute": {
      const taskId = await run(first, request);
      statuses.push(await attempt(first, taskId, undefined));
      break;
    }
    case "mutation_not_retried":
      await run(first, request);
      break;
  }
  let count: number;
  if (expect.route !== undefined) {
    count = fixture.count(expect.route);
  } else if (filePath !== undefined && expect.file !== undefined) {
    const content = await readFile(filePath, "utf8").catch(() => undefined);
    // Identical rewrite: the file was removed, so any content means a second run.
    count =
      expect.second === undefined
        ? 1 + (content === undefined ? 0 : 1)
        : content === expect.file.content
          ? 1
          : 2;
  } else {
    // Only `same_key_twice` counts memories, and it never restarts `first`.
    const listed = (await first.router.execute(
      OperationSchema.parse({ kind: "memory", action: "list", limit: 100 }),
    )) as { memories?: Array<{ key?: string }> };
    count = (listed.memories ?? []).filter((memory) => memory.key === "once").length;
  }
  const firstOk = statuses[0]?.startsWith(
    expect.scenario === "recovery_reexecute" || expect.scenario === "mutation_not_retried"
      ? "recovery_required"
      : "verified_success",
  );
  return result(
    count === expect.count && firstOk === true,
    `effect_count=${count}; statuses=${statuses.join(" | ")}`,
  );
}

// --------------------------------------------------------------- overhead

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
  return Number(value.toFixed(3));
}

export interface OverheadRow {
  operation: string;
  iterations: number;
  rawMs: { p50: number; p95: number };
  governedMs: { p50: number; p95: number };
  overheadP50Ms: number;
}

async function measureOverhead(fixture: Fixture, iterations = 40): Promise<OverheadRow[]> {
  const box = await sandbox();
  const runtime = await openRuntime(box, undefined);
  await writeFile(join(box.workspace, "fixture.txt"), "deterministic fixture\n");
  const ops: Array<[string, (index: number) => TaskRequestInput]> = [
    ["file.read", () => ({ goal: "read", operation: { kind: "file", action: "read", path: "fixture.txt" } })],
    ["file.write (approved)", (index) => ({ goal: "write", operation: { kind: "file", action: "write", path: `out/${index}.txt`, content: "x" } })],
    ["http.get (loopback)", () => ({ goal: "get", operation: { kind: "http", action: "request", method: "GET", url: `${fixture.origin}/ok` } })],
    ["memory.put (approved)", (index) => ({ goal: "put", operation: { kind: "memory", action: "put", key: `k${index}`, value: "v" } })],
    ["terminal.run node -e (approved)", () => ({ goal: "run", operation: { kind: "terminal", action: "run", command: "node", args: ["-e", "0"] }, requiredEvidence: [{ type: "exit_code", value: 0 }] })],
  ];
  const rows: OverheadRow[] = [];
  try {
    for (const [name, build] of ops) {
      const raw: number[] = [];
      const governed: number[] = [];
      for (let index = -3; index < iterations; index += 1) {
        const request = TaskRequestSchema.parse(build(index + 10_000));
        const rawStart = performance.now();
        await runtime.router.execute(request.operation);
        const rawMs = performance.now() - rawStart;
        const governedRequest = TaskRequestSchema.parse(build(index + 20_000));
        const governedStart = performance.now();
        const task = runtime.controller.plan(governedRequest);
        const execution = await runtime.controller.execute(
          task.id,
          task.approval === undefined
            ? undefined
            : { approvalId: task.approval.approvalId, phrase: task.approval.phrase! },
        );
        const governedMs = performance.now() - governedStart;
        if (execution.task.status !== "verified_success") {
          throw new Error(`overhead_op_not_verified:${name}:${execution.task.status}`);
        }
        if (index < 0) continue; // warm-up
        raw.push(rawMs);
        governed.push(governedMs);
      }
      rows.push({
        operation: name,
        iterations,
        rawMs: { p50: percentile(raw, 0.5), p95: percentile(raw, 0.95) },
        governedMs: { p50: percentile(governed, 0.5), p95: percentile(governed, 0.95) },
        overheadP50Ms: Number((percentile(governed, 0.5) - percentile(raw, 0.5)).toFixed(3)),
      });
    }
  } finally {
    await runtime.close();
    await rm(box.base, { recursive: true, force: true });
  }
  return rows;
}

// ------------------------------------------------------------------- report

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function corpusSha256(cases: GovCase[] = corpus): string {
  return createHash("sha256").update(canonicalJson(cases)).digest("hex");
}

async function browserAvailable(fixture: Fixture): Promise<boolean> {
  const box = await sandbox();
  const runtime = await openRuntime(box, undefined);
  try {
    await runtime.router.execute(
      OperationSchema.parse({ kind: "browser", action: "navigate", url: `${fixture.origin}/page`, timeoutMs: 15_000 }),
    );
    return true;
  } catch (error) {
    if (/browser_not_found/.test(message(error))) return false;
    throw error;
  } finally {
    await runtime.close();
    await rm(box.base, { recursive: true, force: true });
  }
}

function score(results: CaseResult[]): { passed: number; total: number; skipped: number; rate: number } {
  const counted = results.filter((item) => !item.skipped);
  const passed = counted.filter((item) => item.passed).length;
  return {
    passed,
    total: counted.length,
    skipped: results.length - counted.length,
    rate: counted.length === 0 ? 0 : Number((passed / counted.length).toFixed(4)),
  };
}

export function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export interface GovBenchOptions {
  only?: string[];
  overhead?: boolean;
}

export async function runGovBench(options: GovBenchOptions = {}) {
  const started = performance.now();
  const selected =
    options.only === undefined ? corpus : corpus.filter((item) => options.only?.includes(item.id));
  const fixture = new Fixture();
  await fixture.start();
  const results: CaseResult[] = [];
  let overhead: OverheadRow[] | undefined;
  let browser = false;
  try {
    browser = selected.some((item) => item.needs === "browser")
      ? await browserAvailable(fixture)
      : false;
    for (const testCase of selected) {
      results.push(await runCase(testCase, fixture, browser));
    }
    if (options.overhead !== false) overhead = await measureOverhead(fixture);
  } finally {
    await fixture.stop();
  }
  const categories = Object.fromEntries(
    [...new Set(selected.map((item) => item.category))].map((category) => [
      category,
      score(results.filter((item) => item.category === category)),
    ]),
  );
  const status = git(["status", "--porcelain"]);
  return {
    schemaVersion: "1.0.0",
    benchmark: "MELRA GovBench",
    corpusVersion: CORPUS_VERSION,
    corpusSha256: corpusSha256(),
    corpusSize: corpus.length,
    casesRun: selected.length,
    generatedAt: new Date().toISOString(),
    melra: {
      version: PRODUCT_VERSION,
      commit: git(["rev-parse", "HEAD"]) ?? "unknown",
      // The benchmark's own files are part of the tree being measured, so a
      // run made before they are committed reports the tree as dirty.
      dirty: status === undefined ? "unknown" : status !== "",
    },
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      architecture: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      cores: cpus().length,
      totalMemoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
      browserAvailable: browser,
      modelCalls: 0,
      network: "loopback fixture only",
    },
    scores: {
      safety: score(results.filter((item) => SAFETY_CATEGORIES.includes(item.category))),
      utility: score(results.filter((item) => item.category === "utility")),
      categories,
    },
    ...(overhead === undefined ? {} : { overhead }),
    failures: results.filter((item) => !item.passed && !item.skipped),
    skipped: results.filter((item) => item.skipped).map((item) => ({ id: item.id, reason: item.observed })),
    runtimeMs: Math.round(performance.now() - started),
    claimBoundary:
      "Self-authored corpus measuring MELRA's own governance guarantees (containment, approval integrity, verification honesty, exactly-once, redaction) and false-positive rate on benign operations, through the real runtime with deterministic loopback fixtures and no model. It is a regression and transparency instrument, not a third-party benchmark: the scores are not comparable to agent task-success benchmarks or to other products, and a high score says the listed cases hold, not that MELRA is secure against attacks outside them.",
    results,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf("--output");
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex === -1 ? undefined : process.argv[onlyIndex + 1]?.split(",");
  const report = await runGovBench({
    ...(only === undefined ? {} : { only }),
    overhead: !process.argv.includes("--no-overhead"),
  });
  const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const output =
    outputIndex === -1
      ? join(
          repoRoot,
          "docs/research/results",
          `govbench-${PRODUCT_VERSION}-${report.generatedAt.slice(0, 10)}.json`,
        )
      : resolve(process.argv[outputIndex + 1] ?? "govbench.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  const { safety, utility, categories } = report.scores;
  process.stdout.write(
    [
      `MELRA GovBench ${report.corpusVersion} (corpus ${report.corpusSha256.slice(0, 12)}, ${report.casesRun} cases)`,
      `safety  ${safety.passed}/${safety.total} (${(safety.rate * 100).toFixed(1)}%)`,
      `utility ${utility.passed}/${utility.total} (${(utility.rate * 100).toFixed(1)}%)`,
      ...Object.entries(categories).map(
        ([name, value]) => `  ${name.padEnd(13)} ${value.passed}/${value.total}${value.skipped > 0 ? ` (${value.skipped} skipped)` : ""}`,
      ),
      ...report.failures.map((item) => `FAIL ${item.id}: expected ${item.expected}; observed ${item.observed}`),
      ...(report.overhead ?? []).map(
        (row) => `overhead ${row.operation}: raw p50 ${row.rawMs.p50} ms, governed p50 ${row.governedMs.p50} ms (+${row.overheadP50Ms} ms)`,
      ),
      `runtime ${report.runtimeMs} ms → ${output}`,
      "",
    ].join("\n"),
  );
}
