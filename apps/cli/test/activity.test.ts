// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskRecord } from "@melra/protocol";
import { taskTarget } from "../src/activity.js";

const execute = promisify(execFile);
// The approval case echoes a developer-mode phrase, whatever the shell says.
delete process.env.MELRA_MODE;
const entry = resolve(import.meta.dirname, "../dist/bin.js");
const systemInfo = resolve(import.meta.dirname, "../../../examples/01-system-info/task.json");
const fileWrite = resolve(import.meta.dirname, "../../../examples/02-verified-file-write/task.json");
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
