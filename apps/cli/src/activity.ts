// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// `melra tasks`, `melra watch`, and `melra status`: the terminal's view of what
// MELRA is doing, without starting a server. Everything here reads the store
// read-only and prints only what the store already holds — the redacted copy —
// so nothing raw, and no approval phrase, can reach the screen from here.

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { connect, type NetConnectOpts } from "node:net";
import { join } from "node:path";
import {
  PRODUCT_VERSION,
  type TaskRecord,
  type TaskStatus,
  type WorkflowRun,
} from "@melra/protocol";
import { classifyOperation, loadPolicy } from "@melra/policy-core";
import { SqliteStore } from "@melra/storage-sqlite";
import type { CliEnvironment } from "./environment.js";
import { isHuman, paint, table } from "./output.js";

const DEFAULT_HTTP_PORT = 7457;
const POLL_MS = 1_000;
const APPROVAL_HINT = "approve from the agent that planned them";

/**
 * A task as an observer may see it. The approval block goes entirely, not just
 * its `phrase`: the phrase is `APPROVE ` plus the first twelve hex digits of
 * `actionDigest`, so leaving the digest would print the phrase by another name.
 * Approvals belong to the governed path; the console drops the block the same way.
 */
function visible(task: TaskRecord): Omit<TaskRecord, "approval"> {
  const copy = { ...task };
  delete copy.approval;
  return copy;
}

function databasePath(env: CliEnvironment): string {
  return join(env.dataDirectory, "melra.sqlite");
}

// Read-only, and only if the database is already there: looking at MELRA must
// not create its state, and must never hold a lock a running server waits on.
function openStore(env: CliEnvironment): SqliteStore | undefined {
  const path = databasePath(env);
  return existsSync(path) ? new SqliteStore(path, { readOnly: true }) : undefined;
}

function withStore<T>(env: CliEnvironment, empty: T, read: (store: SqliteStore) => T): T {
  const store = openStore(env);
  if (store === undefined) return empty;
  try {
    return read(store);
  } finally {
    store.close();
  }
}

// A pipe or a script gets JSON; only a person at a terminal gets the table.
// The same rule as every other command, from the one place it lives.
function humanOutput(json: boolean): boolean {
  return isHuman(json ? ["--json"] : []);
}

function write(line = ""): void {
  process.stdout.write(`${line}\n`);
}

// Status colours share `paint` with doctor and setup, so NO_COLOR, FORCE_COLOR,
// and TERM=dumb behave the same in every command.
const TONE: Partial<Record<string, (text: string) => string>> = {
  verified_success: paint.ok,
  verified_complete: paint.ok,
  failed: paint.fail,
  policy_blocked: paint.fail,
  budget_exhausted: paint.fail,
  recovery_required: paint.fail,
  partially_complete: paint.warn,
  partial: paint.warn,
  awaiting_approval: paint.warn,
  awaiting_input: paint.warn,
  waiting_user: paint.warn,
  cancelled: paint.dim,
};

function tone(text: string, status: string): string {
  return (TONE[status] ?? ((plain: string) => plain))(text);
}

function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "?";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function operationName(task: TaskRecord): string {
  const { kind, action } = task.request.operation as { kind: string; action?: string };
  return action === undefined ? kind : `${kind}.${action}`;
}

// From the one classifier policy uses, run over the stored (redacted) request,
// so the target shown is the target that was authorised. A record written by an
// older version may not classify; it still lists, just without a target.
function target(task: TaskRecord): string {
  try {
    return classifyOperation(task.request.operation).target;
  } catch {
    return "";
  }
}

function approvalHint(waiting: number): string {
  return `${waiting} waiting for approval — ${APPROVAL_HINT}`;
}

export interface TasksOptions {
  limit: number;
  status?: TaskStatus;
  json: boolean;
}

export function tasksCommand(env: CliEnvironment, options: TasksOptions): number {
  const { tasks, waiting } = withStore(
    env,
    { tasks: [] as TaskRecord[], waiting: 0 },
    (store) => ({
      tasks: store.listTasks(options.limit, options.status),
      waiting: store.taskStatusCounts().awaiting_approval ?? 0,
    }),
  );
  if (!humanOutput(options.json)) {
    // The shape `/api/tasks` answers with, minus approvals.
    write(JSON.stringify({ tasks: tasks.map(visible) }, null, 2));
    return 0;
  }
  if (tasks.length === 0) {
    write(
      options.status === undefined
        ? "No tasks yet. Try: melra run --request examples/01-system-info/task.json"
        : `No ${options.status} tasks.`,
    );
    return 0;
  }
  const header = ["ID", "STATUS", "OPERATION", "TARGET", "EFFECT", "UPDATED"];
  const rows = tasks.map((task) => [
    shortId(task.id),
    task.status,
    operationName(task),
    truncate(target(task), 48),
    `${task.policyDecision.effect}/${task.policyDecision.risk}`,
    ago(task.updatedAt),
  ]);
  // `table` measures visible width, so the status can be painted before it aligns.
  write(
    table([
      header.map((title) => paint.dim(title)),
      ...rows.map((row, index) =>
        row.map((cell, column) => (column === 1 ? tone(cell, tasks[index]?.status ?? "") : cell)),
      ),
    ]),
  );
  if (waiting > 0) {
    write();
    write(approvalHint(waiting));
  }
  return 0;
}

type WatchEvent =
  | {
      type: "task";
      at: string;
      id: string;
      status: string;
      previous?: string;
      operation: string;
      target: string;
      effect: string;
      risk: string;
    }
  | { type: "workflow"; at: string; id: string; status: string; previous?: string };

function describe(event: WatchEvent): string {
  const time = new Date(event.at).toLocaleTimeString();
  const status =
    event.previous === undefined
      ? tone(event.status, event.status)
      : `${event.previous} → ${tone(event.status, event.status)}`;
  if (event.type === "workflow") {
    return `${time}  workflow ${shortId(event.id)}  ${status}`;
  }
  return [
    `${time}  task ${shortId(event.id)}`,
    status,
    event.operation,
    truncate(event.target, 48),
    `${event.effect}/${event.risk}`,
  ]
    .filter((part) => part !== "")
    .join("  ");
}

/**
 * Polls rather than subscribes: the writer may be another process (`melra
 * serve`, a `melra run`), and SQLite has no cross-process change feed. Each poll
 * is a short autocommit read on a read-only connection; in WAL mode a reader
 * never blocks a writer, so a watch left open beside a server costs it nothing.
 * Changes are found by diffing the last status seen per id, not by an
 * `updatedAt` high-water mark, because two writes in the same millisecond would
 * share a timestamp and a strict `>` would lose one of them.
 */
export function watchCommand(env: CliEnvironment, options: { json: boolean }): Promise<number> {
  const human = humanOutput(options.json);
  const seenTasks = new Map<string, string>();
  const seenWorkflows = new Map<string, string>();
  let store: SqliteStore | undefined;
  let primed = false;

  const emit = (event: WatchEvent) => write(human ? describe(event) : JSON.stringify(event));

  const poll = () => {
    // The database appears with the first task; until then there is nothing to read.
    store ??= openStore(env);
    if (store === undefined) {
      primed = true;
      return;
    }
    // ponytail: rereads the newest 500 tasks and every workflow run each second;
    // add an `updated_at >` query to the store if that ever shows up in a profile.
    const tasks = store.listTasks(500).reverse();
    const runs: WorkflowRun[] = store.listWorkflowRuns();
    for (const task of tasks) {
      const previous = seenTasks.get(task.id);
      if (previous === task.status) continue;
      seenTasks.set(task.id, task.status);
      // The first read is the baseline: what already happened is `melra tasks`.
      if (!primed) continue;
      emit({
        type: "task",
        at: task.updatedAt,
        id: task.id,
        status: task.status,
        ...(previous === undefined ? {} : { previous }),
        operation: operationName(task),
        target: target(task),
        effect: task.policyDecision.effect,
        risk: task.policyDecision.risk,
      });
    }
    for (const run of runs) {
      const previous = seenWorkflows.get(run.id);
      if (previous === run.status) continue;
      seenWorkflows.set(run.id, run.status);
      if (!primed) continue;
      emit({
        type: "workflow",
        at: run.updatedAt,
        id: run.id,
        status: run.status,
        ...(previous === undefined ? {} : { previous }),
      });
    }
    primed = true;
  };

  return new Promise((resolveExit) => {
    let timer: NodeJS.Timeout | undefined;
    const stop = (code: number) => {
      if (timer !== undefined) clearInterval(timer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      store?.close();
      resolveExit(code);
    };
    // 128 + signal number, as a shell reports a process killed by it.
    const onInterrupt = () => stop(130);
    const onTerminate = () => stop(143);
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    const tick = () => {
      try {
        poll();
      } catch (error) {
        process.stderr.write(
          `melra: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        stop(1);
      }
    };
    tick();
    // On stderr so stdout stays pure NDJSON; it also tells a caller that the
    // baseline is taken and anything from here on will be reported.
    process.stderr.write(
      `Watching ${databasePath(env)} for task and workflow changes. Ctrl-C to stop.\n`,
    );
    timer = setInterval(tick, POLL_MS);
  });
}

// Whether something accepts a connection there. Nothing is sent — no token, no
// request — so this cannot leak a credential to whatever holds the port.
function reachable(options: NetConnectOpts): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect(options);
    const done = (ok: boolean) => {
      socket.destroy();
      resolveProbe(ok);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function httpPort(): number {
  const port = Number(process.env.MELRA_HTTP_PORT);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_HTTP_PORT;
}

async function sizeOnDisk(path: string): Promise<number> {
  // The WAL holds committed pages not yet checkpointed into the main file.
  const sizes = await Promise.all(
    [path, `${path}-wal`].map((file) => stat(file).then((s) => s.size, () => 0)),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function summary(counts: Record<string, number>): string {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total === 0) return "none";
  const parts = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([status, count]) => `${count} ${tone(status, status)}`);
  return `${total} total: ${parts.join(", ")}`;
}

export async function statusCommand(
  env: CliEnvironment,
  options: { json: boolean; policyPath?: string },
): Promise<number> {
  // The mode a server started here would run in: strictest of flag, variable,
  // and policy file, as `createMelraRuntime` decides it.
  let policyError: string | undefined;
  let policyMode: string | undefined;
  let policyUnhinged = false;
  if (options.policyPath !== undefined) {
    try {
      const loaded = await loadPolicy(options.policyPath, env.workspaceRoot);
      policyMode = loaded.mode;
      policyUnhinged = loaded.unhinged;
    } catch (error) {
      policyError = error instanceof Error ? error.message : String(error);
    }
  }
  const mode = env.mode === "enforced" || policyMode === "enforced" ? "enforced" : "developer";
  const path = databasePath(env);
  const { tasks, workflows, lastActivity } = withStore(
    env,
    { tasks: {} as Record<string, number>, workflows: {} as Record<string, number>, lastActivity: undefined as string | undefined },
    (store) => {
      const runs = store.listWorkflowRuns();
      const latest = [store.listTasks(1)[0]?.updatedAt, runs.at(-1)?.updatedAt]
        .filter((at): at is string => at !== undefined)
        .sort()
        .at(-1);
      return {
        tasks: store.taskStatusCounts(),
        workflows: countBy(runs.map((run) => run.status)),
        lastActivity: latest,
      };
    },
  );
  const port = httpPort();
  const [http, socket] = await Promise.all([
    reachable({ host: "127.0.0.1", port }),
    env.socketPath === undefined ? undefined : reachable({ path: env.socketPath }),
  ]);
  const report = {
    product: "MELRA",
    version: PRODUCT_VERSION,
    mode,
    unhinged: env.unhinged || policyUnhinged,
    workspace: env.workspaceRoot,
    dataDirectory: env.dataDirectory,
    policy: options.policyPath ?? null,
    ...(policyError === undefined ? {} : { policyError }),
    database: {
      path,
      exists: existsSync(path),
      bytes: await sizeOnDisk(path),
    },
    tasks,
    workflows,
    awaitingApproval: tasks.awaiting_approval ?? 0,
    lastActivity: lastActivity ?? null,
    server: {
      http: { address: `127.0.0.1:${port}`, state: http ? "reachable" : "not running" },
      ...(env.socketPath === undefined
        ? {}
        : { socket: { path: env.socketPath, state: socket === true ? "reachable" : "not running" } }),
    },
  };
  if (!humanOutput(options.json)) {
    write(JSON.stringify(report, null, 2));
    return 0;
  }
  const row = (label: string, value: string) => write(`  ${label.padEnd(11)} ${value}`);
  write(`MELRA ${PRODUCT_VERSION}  ${mode} mode${report.unhinged ? "  UNSAFE-LOCAL: no guardrails" : ""}`);
  row("Workspace", env.workspaceRoot);
  row("Data", env.dataDirectory);
  row(
    "Policy",
    policyError !== undefined
      ? `${options.policyPath} (invalid: ${policyError})`
      : (options.policyPath ?? "built-in defaults"),
  );
  row("Database", report.database.exists ? `${path} (${bytes(report.database.bytes)})` : `${path} (not created yet)`);
  row("Tasks", summary(tasks));
  row("Workflows", summary(workflows));
  if (report.awaitingApproval > 0) row("Waiting", approvalHint(report.awaitingApproval));
  row("Last active", lastActivity === undefined ? "never" : ago(lastActivity));
  row("HTTP", `${report.server.http.address} ${report.server.http.state}`);
  if (report.server.socket !== undefined) {
    row("Socket", `${report.server.socket.path} ${report.server.socket.state}`);
  }
  if (!http && socket !== true) {
    write();
    write("Open the console with: melra serve --http --open");
  }
  return 0;
}
