// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskRecord, WorkflowRun } from "@melra/protocol";
import { SqliteStore } from "@melra/storage-sqlite";
import { taskTarget } from "../src/activity.js";

const execute = promisify(execFile);
// The approval case echoes a developer-mode phrase, whatever the shell says.
delete process.env.MELRA_MODE;
const entry = resolve(import.meta.dirname, "../dist/bin.js");
const systemInfo = resolve(import.meta.dirname, "../../../examples/01-system-info/task.json");
const fileWrite = resolve(import.meta.dirname, "../../../examples/02-verified-file-write/task.json");
const restartSafe = resolve(import.meta.dirname, "../../../examples/workflows/restart-safe.json");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    // Windows holds the SQLite handle briefly after the subprocess exits.
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

interface Listed {
  tasks: Array<{ id: string; status: string }>;
}

// A port nothing listens on, so "not running" does not depend on whether this
// machine happens to have a MELRA on 7457.
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise((done) => server.close(done));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "melra-activity-"));
  roots.push(root);
  const options = {
    cwd: root,
    env: {
      ...process.env,
      MELRA_HOME: join(root, ".melra"),
      MELRA_WORKSPACE: root,
      MELRA_HTTP_PORT: String(await freePort()),
    },
  };
  // Every task is planned and run through the real CLI, so what is read back is
  // exactly what the pipeline stored.
  const run = async (request: string) => {
    const result = await execute(process.execPath, [entry, "run", "--request", request], options).catch(
      (error: { stdout: string; code: number }) => error,
    );
    return JSON.parse(result.stdout) as { task: { id: string; approval?: { phrase: string } } };
  };
  return { root, options, run };
}

describe("melra tasks, status, and watch", () => {
  it("lists newest first, filters, and summarises without approval phrases", async () => {
    const { root, options, run } = await workspace();
    const blockedRequest = join(root, "blocked.json");
    await writeFile(
      blockedRequest,
      JSON.stringify({
        goal: "Run a shell",
        operation: { kind: "terminal", action: "run", command: "bash", args: ["-c", "true"] },
        requiredEvidence: [{ type: "exit_code", value: 0 }],
      }),
    );
    const read = await run(systemInfo);
    const blocked = await run(blockedRequest);
    const awaiting = await run(fileWrite);
    const phrase = awaiting.task.approval?.phrase;
    expect(phrase).toMatch(/^APPROVE [a-f0-9]{12}$/);

    const listed = await execute(process.execPath, [entry, "tasks", "--json"], options);
    expect((JSON.parse(listed.stdout) as Listed).tasks.map((task) => [task.id, task.status])).toEqual([
      [awaiting.task.id, "awaiting_approval"],
      [blocked.task.id, "policy_blocked"],
      [read.task.id, "verified_success"],
    ]);
    // Neither the phrase nor the digest it is cut from: one is the other.
    expect(listed.stdout).not.toContain(phrase);
    expect(listed.stdout).not.toContain(phrase!.slice("APPROVE ".length));
    expect(listed.stdout).not.toContain('"approval"');

    // Not a TTY, so JSON without asking for it.
    const filtered = await execute(
      process.execPath,
      [entry, "tasks", "--status", "policy_blocked"],
      options,
    );
    expect((JSON.parse(filtered.stdout) as Listed).tasks.map((task) => task.id)).toEqual([
      blocked.task.id,
    ]);
    await expect(
      execute(process.execPath, [entry, "tasks", "--status", "nonsense"], options),
    ).rejects.toMatchObject({ code: 1 });

    const status = JSON.parse(
      (await execute(process.execPath, [entry, "status", "--json"], options)).stdout,
    ) as {
      tasks: Record<string, number>;
      awaitingApproval: number;
      database: { exists: boolean; bytes: number };
      server: { http: { state: string } };
    };
    expect(status.tasks).toEqual({ awaiting_approval: 1, policy_blocked: 1, verified_success: 1 });
    expect(status.awaitingApproval).toBe(1);
    expect(status.database.exists).toBe(true);
    expect(status.database.bytes).toBeGreaterThan(0);
    expect(status.server.http.state).toBe("not running");
  });

  it("counts an approval that expired apart from one still waiting", async () => {
    const { root, options, run } = await workspace();
    await writeFile(join(root, "policy.json"), JSON.stringify({ approvalTtlMs: 300 }));
    const short = { ...options, env: { ...options.env, MELRA_POLICY: join(root, "policy.json") } };
    const first = await execute(process.execPath, [entry, "run", "--request", fileWrite], short).catch(
      (error: { stdout: string }) => error,
    );
    expect((JSON.parse(first.stdout) as { task: { status: string } }).task.status).toBe("awaiting_approval");
    await new Promise((resolve) => setTimeout(resolve, 600));
    await run(fileWrite);
    // The first can no longer be approved: counted as waiting, it was reported
    // forever and pointed at `melra approve`, which refused it.
    const status = JSON.parse((await execute(process.execPath, [entry, "status", "--json"], options)).stdout) as {
      awaitingApproval: number;
      expiredApprovals: number;
    };
    expect([status.awaitingApproval, status.expiredApprovals]).toEqual([1, 1]);
  });

  /** Moves a task's challenge into the past, and records `decidedAt` if given. */
  function lapse(root: string, taskId: string, decidedAt?: number) {
    const store = new SqliteStore(join(root, ".melra", "melra.sqlite"));
    try {
      const task = store.getTask(taskId)!;
      const expiresAt = Date.now() - 1_000;
      store.saveTask({ ...task, approval: { ...task.approval!, expiresAt: new Date(expiresAt).toISOString() } });
      if (decidedAt !== undefined) {
        store.recordApprovalDecision({
          approvalId: task.approval!.approvalId,
          taskId,
          renderDigest: task.approval!.actionDigest,
          channel: "in_band",
          approver: "operator",
          decidedAt: new Date(expiresAt - decidedAt).toISOString(),
        });
      }
    } finally {
      store.close();
    }
  }

  const statusOf = async (options: Awaited<ReturnType<typeof workspace>>["options"]) =>
    JSON.parse((await execute(process.execPath, [entry, "status", "--json"], options)).stdout) as {
      awaitingApproval: number;
      expiredApprovals: number;
      expiredWorkflowSteps: number;
    };

  it("counts an approval given in time, not yet acted on, as neither waiting nor expired", async () => {
    const { root, options, run } = await workspace();
    const { task } = await run(fileWrite);
    // Approved a second before its challenge lapsed: the agent can still run
    // it, so the hint to plan again or deny would have cancelled it.
    lapse(root, task.id, 1_000);
    const status = await statusOf(options);
    expect([status.awaitingApproval, status.expiredApprovals]).toEqual([0, 0]);
  });

  it("counts an expired workflow step apart, since its next advance asks again", async () => {
    const { root, options } = await workspace();
    // An advance that stops at an approval exits non-zero, its run on stdout.
    const workflow = async (...args: string[]) =>
      JSON.parse(
        (
          await execute(process.execPath, [entry, "workflow", ...args], options).catch(
            (error: { stdout: string }) => error,
          )
        ).stdout,
      ) as { id: string; run: WorkflowRun };
    const { id } = await workflow("plan", "--definition", restartSafe);
    await workflow("advance", id);
    const { run } = await workflow("advance", id);
    lapse(root, run.nodes.write!.taskIds[0]!);
    // A deny, as the expired hint advises for a single task, would fail the run.
    const status = await statusOf(options);
    expect([status.expiredApprovals, status.expiredWorkflowSteps]).toEqual([0, 1]);
  });

  it("counts an expired step of a run that is not over as a step, a failed one included", async () => {
    const { root, options } = await workspace();
    const write = (path: string) => ({
      goal: `Write ${path}`,
      operation: { kind: "file", action: "write", path, content: "x" },
      requiredEvidence: [{ type: "file_exists", path }],
    });
    const definition = join(root, "two-writes.json");
    await writeFile(
      definition,
      JSON.stringify({
        schemaVersion: "1.0.0",
        id: "6f0c1a52-3b9e-4c7d-9a1f-2e8b5d4c3a10",
        version: 1,
        name: "two-writes",
        nodes: [
          { id: "a", type: "operation", request: write("a.txt") },
          { id: "b", type: "operation", request: write("b.txt") },
        ],
      }),
    );
    const cli = async (...args: string[]) =>
      (await execute(process.execPath, [entry, ...args], options).catch((error: { stdout: string }) => error)).stdout;
    const { id } = JSON.parse(await cli("workflow", "plan", "--definition", definition)) as { id: string };
    const { run } = JSON.parse(await cli("workflow", "advance", id)) as { run: WorkflowRun };
    await cli("approve", run.nodes.a!.taskIds[0]!, "--deny");
    expect((JSON.parse(await cli("workflow", "advance", id)) as { run: WorkflowRun }).run.status).toBe("failed");
    // Whether its advance asks again depends on the run, failed here, so the
    // step is pointed at the run rather than told to plan again or deny.
    lapse(root, run.nodes.b!.taskIds[0]!);
    const status = await statusOf(options);
    expect([status.expiredApprovals, status.expiredWorkflowSteps]).toEqual([0, 1]);
  });

  it("counts a step left waiting on a run that is over the plain way, since nothing advances it", async () => {
    const { root, options } = await workspace();
    const write = (path: string) => ({
      goal: `Write ${path}`,
      operation: { kind: "file", action: "write", path, content: "x" },
      requiredEvidence: [{ type: "file_exists", path }],
    });
    const definition = join(root, "parallel.json");
    await writeFile(
      definition,
      JSON.stringify({
        schemaVersion: "1.0.0",
        id: "7a1d2b63-4c0e-4d8f-8b2a-3f9c6e5d4b21",
        version: 1,
        name: "parallel-writes",
        nodes: [{ id: "p", type: "parallel", branches: [[write("a.txt")], [write("b.txt")]] }],
      }),
    );
    const cli = async (...args: string[]) =>
      (await execute(process.execPath, [entry, ...args], options).catch((error: { stdout: string }) => error)).stdout;
    const { id } = JSON.parse(await cli("workflow", "plan", "--definition", definition)) as { id: string };
    const { run } = JSON.parse(await cli("workflow", "advance", id)) as { run: WorkflowRun };
    const [first, second] = run.nodes.p!.taskIds;
    // One branch denied, the run cancelled: the other branch's task is left
    // waiting on a run that never advances again.
    await cli("approve", first!, "--deny");
    await cli("workflow", "advance", id);
    await cli("workflow", "cancel", id);
    lapse(root, second!);
    const status = await statusOf(options);
    expect([status.expiredApprovals, status.expiredWorkflowSteps]).toEqual([1, 0]);
  });

  it("does not count as waiting what enforced mode will not take an answer for", async () => {
    const { options, run } = await workspace();
    const { task } = await run(fileWrite);
    // Answered in band while the deployment was in developer mode; enforced
    // now, that answer counts for nothing and a second one is refused.
    await execute(process.execPath, [entry, "approve", task.id, "--yes"], options).catch(() => undefined);
    const enforced = { ...options, env: { ...options.env, MELRA_MODE: "enforced" } };
    const status = await statusOf(enforced);
    expect([status.awaitingApproval, status.expiredApprovals]).toEqual([0, 1]);
  });

  it("refuses a --status or --limit with nothing after it", async () => {
    const { options } = await workspace();
    // What an unquoted `--status $S` sends with S unset: it listed everything.
    for (const args of [["--status"], ["--limit"], ["--status", "--json"]]) {
      await expect(execute(process.execPath, [entry, "tasks", ...args], options), args.join(" ")).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("requires a value"),
      });
    }
  });

  it("previews a mutation with the evidence the server would derive for it", async () => {
    const { root, options } = await workspace();
    const request = join(root, "write.json");
    await writeFile(
      request,
      JSON.stringify({ goal: "Write a file", operation: { kind: "file", action: "write", path: "notes.txt", content: "hi" } }),
    );
    // It said deny, mutation_requires_evidence, where `run` asks for approval.
    const preview = JSON.parse(
      (await execute(process.execPath, [entry, "policy", "test", "--request", request], options)).stdout,
    ) as { decision: { outcome: string }; requiredEvidence: unknown[] };
    expect(preview.decision.outcome).toBe("confirm");
    expect(preview.requiredEvidence).toEqual([{ type: "file_exists", path: "notes.txt" }]);
  });

  it("reports an empty home without creating a database", async () => {
    const { options } = await workspace();
    const listed = await execute(process.execPath, [entry, "tasks"], options);
    expect(JSON.parse(listed.stdout)).toEqual({ tasks: [] });
    const status = JSON.parse(
      (await execute(process.execPath, [entry, "status"], options)).stdout,
    ) as { database: { exists: boolean } };
    expect(status.database.exists).toBe(false);
  });

  it("streams a task created while watch is running", async () => {
    const { options, run } = await workspace();
    await run(systemInfo);
    const watcher = spawn(process.execPath, [entry, "watch", "--json"], {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((done) => watcher.once("exit", (code) => done(code)));
    try {
      // The ready line goes out once the baseline is taken; a task created
      // before it would count as history, not news.
      await new Promise<void>((ready, failed) => {
        watcher.stderr.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("Watching")) ready();
        });
        watcher.once("exit", () => failed(new Error("watch exited early")));
      });
      let buffered = "";
      const verified = new Promise<Record<string, unknown>>((found) => {
        watcher.stdout.on("data", (chunk: Buffer) => {
          buffered += chunk.toString();
          for (const line of buffered.split("\n").slice(0, -1)) {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.status === "verified_success") found(event);
          }
        });
      });
      const created = await run(systemInfo);
      expect(await verified).toMatchObject({
        type: "task",
        id: created.task.id,
        status: "verified_success",
        operation: "system.info",
      });
      // Only the new task: the one seeded before watch started is history.
      for (const line of buffered.split("\n").filter((entry_) => entry_ !== "")) {
        expect((JSON.parse(line) as { id: string }).id).toBe(created.task.id);
      }
    } finally {
      watcher.kill("SIGINT");
    }
    const code = await exited;
    // Windows has no SIGINT to deliver; kill() there terminates outright.
    if (process.platform !== "win32") expect(code).toBe(130);
  });
});

describe("task targets", () => {
  it("shows a command as what ran, arguments included", () => {
    const task = (operation: Record<string, unknown>) =>
      ({ request: { operation } }) as unknown as TaskRecord;
    // Not the classifier's `command:pnpm`; the stored arguments are redacted already.
    expect(
      taskTarget(task({ kind: "terminal", action: "run", command: "pnpm", args: ["check", "--token=[REDACTED_SENSITIVE_ARG]"] })),
    ).toBe("pnpm check --token=[REDACTED_SENSITIVE_ARG]");
    expect(taskTarget(task({ kind: "file", action: "list", path: "." }))).toBe(".");
  });
});
