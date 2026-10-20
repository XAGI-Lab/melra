// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalOperationSchema } from "@melra/protocol";
import { TerminalRuntime, hardenGitRead, redactTerminalOutput } from "./index.js";

// Counts link lookups; each still does the real one.
const lookups = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (actual) => {
  const fs = await actual<typeof import("node:fs/promises")>();
  return {
    ...fs,
    realpath: (...args: Parameters<typeof fs.realpath>) => {
      lookups.count += 1;
      return fs.realpath(...args);
    },
    readlink: (...args: Parameters<typeof fs.readlink>) => {
      lookups.count += 1;
      return fs.readlink(...args);
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  // A stopped process can hold its cwd a moment longer on Windows, where the
  // tree is stopped by `taskkill`, and rmdir then fails EBUSY.
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
  );
});

describe("TerminalRuntime", () => {
  it("runs executable and argument arrays without a shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    const result = await runtime.execute(
      TerminalOperationSchema.parse({
        kind: "terminal",
        action: "run",
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.argv[1])", "hello; touch nope"],
      }),
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("hello; touch nope");
  });

  it("accepts a cwd spelled through the configured workspace link", async () => {
    const base = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(base);
    const root = join(base, "workspace");
    const sub = join(root, "sub");
    const linked = join(base, "workspace-link");
    await mkdir(sub, { recursive: true });
    await symlink(root, linked, process.platform === "win32" ? "junction" : "dir");
    const runtime = await TerminalRuntime.create({ root: linked });
    const result = await runtime.execute(
      TerminalOperationSchema.parse({
        kind: "terminal",
        action: "run",
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.cwd())"],
        cwd: join(linked, "sub"),
      }),
    );
    expect(result.stdout).toBe(await realpath(sub));
  });

  it("keeps a cwd spelled through the configured root confined", async () => {
    // Reached through a directory link above it, as macOS's /tmp is (a
    // junction on Windows), beside a real sibling whose name starts the same.
    const base = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(base);
    const real = join(base, "real", "ws");
    await mkdir(join(base, "real", "ws-evil"), { recursive: true });
    await mkdir(real);
    const link = process.platform === "win32" ? "junction" : "dir";
    await symlink(join(base, "real"), join(base, "alias"), link);
    await symlink(join(base, "real", "ws-evil"), join(real, "escape"), link);
    const configured = join(base, "alias", "ws");
    const runtime = await TerminalRuntime.create({ root: configured });
    const run = (cwd: string) =>
      runtime.execute(
        TerminalOperationSchema.parse({
          kind: "terminal",
          action: "run",
          command: process.execPath,
          args: ["-e", "process.stdout.write(process.cwd())"],
          cwd,
        }),
      );

    expect((await run(configured)).stdout).toBe(await realpath(real));
    for (const cwd of [`${configured}-evil`, join(configured, "escape"), join(configured, "..", "ws-evil")]) {
      await expect(run(cwd)).rejects.toThrow("cwd_outside_workspace");
    }
  });

  it("calls a run cancelled after it started an unknown outcome, not a failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    const controller = new AbortController();
    // Does its work at once, then hangs, as a deploy script or `git push` can.
    const running = runtime.execute(
      TerminalOperationSchema.parse({
        kind: "terminal",
        action: "run",
        command: process.execPath,
        args: ["-e", "require('fs').writeFileSync('deployed.txt', '1'); setTimeout(() => {}, 10000)"],
      }),
      controller.signal,
    );
    const done = join(root, "deployed.txt");
    for (let waited = 0; !existsSync(done) && waited < 5000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort(new Error("task_budget_exhausted"));
    await expect(running).rejects.toThrow(/effect_outcome_unknown:task_budget_exhausted/);
    expect(existsSync(done)).toBe(true);
  });

  const op = (fields: Record<string, unknown>) =>
    TerminalOperationSchema.parse({ kind: "terminal", action: "run", command: process.execPath, ...fields });
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (check: () => boolean, ms = 5000): Promise<void> => {
    for (let waited = 0; !check() && waited < ms; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it("finishes when the program does, even if something it started holds the output", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    const started = Date.now();
    const result = await runtime.execute(
      op({
        args: [
          "-e",
          "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'inherit' }).unref(); console.log('done')",
        ],
        timeoutMs: 20_000,
      }),
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toContain("done");
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("stops a cancelled program that ignores SIGTERM, and what it started", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    const controller = new AbortController();
    const pidFile = join(root, "pid");
    const running = runtime.execute(
      op({
        args: [
          "-e",
          "process.on('SIGTERM', () => {}); require('fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000)",
        ],
      }),
      controller.signal,
    );
    await until(() => existsSync(pidFile));
    const pid = Number(await readFile(pidFile, "utf8"));
    controller.abort(new Error("task_cancelled"));
    await expect(running).rejects.toThrow(/effect_outcome_unknown/);
    await until(() => !alive(pid), 4_000);
    expect(alive(pid)).toBe(false);
  });

  // POSIX only: a Windows pipe takes the write into its buffer rather than
  // failing it, so there is no EPIPE to survive there.
  it.skipIf(process.platform === "win32")("refuses input to a job whose reader has gone, without taking the process down", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    try {
      // Says when its stdin is closed, rather than the test guessing how long a
      // loaded machine takes to start Node and get there.
      const started = await runtime.execute(
        op({
          action: "start",
          interactive: true,
          args: ["-e", "const fs = require('fs'); fs.closeSync(0); fs.writeFileSync('closed', ''); setTimeout(() => {}, 10000)"],
        }),
      );
      const jobId = started.jobId as string;
      await until(() => existsSync(join(root, "closed")));
      const send = () =>
        runtime.execute(TerminalOperationSchema.parse({ kind: "terminal", action: "send", jobId, input: "hello" }));
      // Back to back, as a caller sending twice would. The write fails at once
      // and its EPIPE event comes a tick later; that event used to be
      // unhandled and kill this whole process, and the refusal in between
      // read "not interactive".
      const outcome = () => send().then(() => "sent", (error: unknown) => String(error));
      const outcomes = [await outcome(), await outcome(), await outcome()];
      for (let waited = 0; waited < 5000 && outcomes.at(-1) === "sent"; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        outcomes.push(await outcome());
      }
      // Refused because its reader went away, not because it is not interactive.
      expect(outcomes.at(-1)).toMatch(/terminal_job_stdin_closed/);
      expect(outcomes.filter((result) => result !== "sent").every((result) => /terminal_job_stdin_closed/.test(result))).toBe(true);
    } finally {
      // Also after a failure: the job would otherwise outlive the test.
      await runtime.close();
    }
  }, 15_000);

  it.skipIf(process.platform === "win32")("refuses input to a job whose program exited as not running, before its pipes close", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    try {
      // What it starts holds its output open, so the job's close (and so
      // endedAt) waits, while Node destroys the job's stdin on exit. It holds
      // stdin too, so a write never fails before Node has seen the exit.
      const started = await runtime.execute(
        op({
          action: "start",
          interactive: true,
          args: [
            "-e",
            "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'inherit' }).unref(); require('fs').writeFileSync('spawned', '')",
          ],
        }),
      );
      await until(() => existsSync(join(root, "spawned")));
      const send = () =>
        runtime
          .execute(TerminalOperationSchema.parse({ kind: "terminal", action: "send", jobId: started.jobId, input: "hi" }))
          .then(() => "sent", (error: unknown) => String(error));
      let refused = await send();
      for (let waited = 0; waited < 3000 && refused === "sent"; waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        refused = await send();
      }
      // In that window it read "not interactive" for a job started interactive.
      expect(refused).toMatch(/terminal_job_not_running/);
    } finally {
      await runtime.close();
    }
  }, 15_000);

  it("keeps a bounded number of jobs, making room from the finished ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    const ids: unknown[] = [];
    for (let index = 0; index < 66; index += 1) {
      const started = await runtime.execute(op({ action: "start", args: ["-e", ""] }));
      ids.push(started.jobId);
      const status = () =>
        runtime.execute(TerminalOperationSchema.parse({ kind: "terminal", action: "status", jobId: started.jobId }));
      for (let waited = 0; waited < 5000 && (await status()).running === true; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    // The oldest finished jobs made room; the newest are still there.
    const status = (jobId: unknown) =>
      runtime.execute(TerminalOperationSchema.parse({ kind: "terminal", action: "status", jobId }));
    await expect(status(ids[0])).rejects.toThrow("terminal_job_not_found");
    await expect(status(ids.at(-1))).resolves.toMatchObject({ running: false });
    await runtime.close();
  }, 60_000);

  it("keeps multi-byte characters whole across pipe reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    const result = await runtime.execute(
      op({ args: ["-e", "process.stdout.write('€'.repeat(60000))"], maxOutputChars: 100_000 }),
    );
    expect(result.stdout).toBe("€".repeat(60000));
  });

  it("redacts secret-shaped output", () => {
    expect(
      redactTerminalOutput("password=hunter2 ghp_123456789012345678901234"),
    ).not.toContain("hunter2");
  });

  it("stops commands at the configured timeout, as an outcome it cannot know", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    // Stopped mid-run, it may have done its work: the same answer a cancel gets.
    await expect(
      runtime.execute(
        TerminalOperationSchema.parse({
          kind: "terminal",
          action: "run",
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, 10_000)"],
          timeoutMs: 150,
        }),
      ),
    ).rejects.toThrow("effect_outcome_unknown:terminal_timeout:150ms");
  });

  it("supervises bounded background jobs and output", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    const started = await runtime.execute(
      TerminalOperationSchema.parse({
        kind: "terminal",
        action: "start",
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write('background-ready'); setTimeout(() => {}, 150)",
        ],
        timeoutMs: 2_000,
      }),
    );
    expect(started.started).toBe(true);
    // The child writes its output and then exits on its own. How long that
    // takes depends on process startup under CI load, so poll for completion
    // rather than assuming it finishes within a fixed wall-clock delay.
    const deadline = Date.now() + 10_000;
    const readOutput = async () =>
      runtime.execute(
        TerminalOperationSchema.parse({
          kind: "terminal",
          action: "output",
          jobId: started.jobId,
        }),
      );
    let output = await readOutput();
    while (output.running === true && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      output = await readOutput();
    }
    expect(output.stdout).toContain("background-ready");
    expect(output.running).toBe(false);
    await runtime.close();
  }, 30_000);

  it("answers a running job's prompt and refuses one that cannot be answered", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    const script =
      "process.stdout.write('name? ');" +
      "process.stdin.once('data', (d) => { process.stdout.write('hello ' + String(d).trim()); process.exit(0); })";
    const start = (interactive: boolean) =>
      runtime.execute(
        TerminalOperationSchema.parse({
          kind: "terminal",
          action: "start",
          command: process.execPath,
          args: ["-e", script],
          interactive,
          timeoutMs: 5_000,
        }),
      );

    const interactive = await start(true);
    const sent = await runtime.execute(
      TerminalOperationSchema.parse({
        kind: "terminal",
        action: "send",
        jobId: interactive.jobId,
        input: "melra",
      }),
    );
    expect(sent.sent).toBe(true);
    const deadline = Date.now() + 10_000;
    const readOutput = async (jobId: unknown) =>
      runtime.execute(
        TerminalOperationSchema.parse({
          kind: "terminal",
          action: "output",
          jobId,
        }),
      );
    let output = await readOutput(interactive.jobId);
    while (output.running === true && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 25));
      output = await readOutput(interactive.jobId);
    }
    expect(output.stdout).toContain("hello melra");

    // Without `interactive`, stdin is ignored rather than piped. Writing to it
    // would throw EPIPE asynchronously and surface as an unhandled error, so
    // the refusal has to come first and name the reason.
    const plain = await start(false);
    await expect(
      runtime.execute(
        TerminalOperationSchema.parse({
          kind: "terminal",
          action: "send",
          jobId: plain.jobId,
          input: "melra",
        }),
      ),
    ).rejects.toThrow("terminal_job_not_interactive");
    await runtime.close();
  }, 30_000);

  it("names a missing program instead of surfacing a bare ENOENT", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    await expect(
      runtime.execute(
        TerminalOperationSchema.parse({
          kind: "terminal",
          action: "run",
          command: "melra-program-that-does-not-exist",
        }),
      ),
    ).rejects.toThrow("terminal_command_not_found");
    await runtime.close();
  });

  it("does not report a background job that never started", async () => {
    // `spawn` reports a failed start asynchronously, so this used to resolve
    // with `started: true` and a job id for a process that never existed.
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    await expect(
      runtime.execute(
        TerminalOperationSchema.parse({
          kind: "terminal",
          action: "start",
          command: "melra-program-that-does-not-exist",
        }),
      ),
    ).rejects.toThrow("terminal_command_not_found");
    await runtime.close();
  });

  // POSIX only: Windows has no process groups to find them by.
  it.skipIf(process.platform === "win32")("still stops what a job's program left in its group once the program exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    // The program starts a process in its own group and exits at once. That
    // process ignores SIGTERM, as a server it started might.
    const leftover =
      "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
    const leave = async (name: string, fields: Record<string, unknown> = {}) => {
      const started = await runtime.execute(
        op({
          action: "start",
          args: ["-e", `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leftover)}, '${name}'], { stdio: 'ignore' }).unref()`],
          ...fields,
        }),
      );
      const status = () =>
        runtime.execute(TerminalOperationSchema.parse({ kind: "terminal", action: "status", jobId: started.jobId }));
      await until(() => existsSync(join(root, name)));
      for (let waited = 0; waited < 5000 && (await status()).running === true; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await status()).toMatchObject({ running: false });
      const pid = Number(await readFile(join(root, name), "utf8"));
      expect(alive(pid)).toBe(true);
      return { jobId: started.jobId, pid };
    };
    try {
      const stopped = await leave("stopped");
      const timed = await leave("timed", { timeoutMs: 1_000 });
      const closed = await leave("closed");
      await runtime.execute(TerminalOperationSchema.parse({ kind: "terminal", action: "stop", jobId: stopped.jobId }));
      await until(() => !alive(stopped.pid) && !alive(timed.pid), 6_000);
      expect(alive(stopped.pid)).toBe(false);
      expect(alive(timed.pid)).toBe(false);
      expect(alive(closed.pid)).toBe(true);
      await runtime.close();
      // Killed before close() resolved; macOS reaps the zombie a moment later.
      await until(() => !alive(closed.pid), 1_000);
      expect(alive(closed.pid)).toBe(false);
    } finally {
      // Whatever an early failure left running: close() stops each job's group.
      await runtime.close();
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("keeps a job's timeout on what it left behind across a wall-clock jump", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    const started = await runtime.execute(
      op({
        action: "start",
        timeoutMs: 1_000,
        args: [
          "-e",
          `require('child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('fs').writeFileSync('left', String(process.pid)); setInterval(() => {}, 1000)"], { stdio: 'ignore' }).unref()`,
        ],
      }),
    );
    const status = () =>
      runtime.execute(TerminalOperationSchema.parse({ kind: "terminal", action: "status", jobId: started.jobId }));
    await until(() => existsSync(join(root, "left")));
    for (let waited = 0; waited < 5000 && (await status()).running === true; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const pid = Number(await readFile(join(root, "left"), "utf8"));
    // A laptop waking from sleep: the wall clock leaps, the job's timer has not.
    const now = Date.now.bind(Date);
    const jump = vi.spyOn(Date, "now").mockImplementation(() => now() + 3_600_000);
    try {
      await until(() => !alive(pid), 6_000);
      expect(alive(pid)).toBe(false);
    } finally {
      jump.mockRestore();
      await runtime.close();
    }
  }, 30_000);

  it("does not resolve close until its children have actually exited", async () => {
    // A signalled-but-live child holds its cwd open on Windows, so a caller
    // deleting the workspace right after close raced rmdir and got EBUSY.
    // Signalling is not exiting; this asserts the difference.
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    const started = await runtime.execute(
      TerminalOperationSchema.parse({
        kind: "terminal",
        action: "start",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 30_000)"],
        timeoutMs: 30_000,
      }),
    );
    const pid = started.pid as number;
    await runtime.close();
    // Signal 0 tests for the process rather than signalling it: ESRCH means it
    // is gone, and no throw means close resolved while it was still running.
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  }, 30_000);
});

describe("arguments", () => {
  const run = (runtime: TerminalRuntime, spelling: string) =>
    runtime.execute(
      TerminalOperationSchema.parse({
        kind: "terminal",
        action: "run",
        command: process.execPath,
        args: ["-e", "", "--", spelling],
      }),
    );

  it("refuses every spelling that reaches MELRA's files, before anything runs", async () => {
    const base = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(base);
    const ws = join(base, "ws");
    const data = join(base, "data");
    await mkdir(ws);
    await mkdir(join(data, "sub"), { recursive: true });
    await writeFile(join(data, "payload.key"), "secret");
    const realData = await realpath(data);
    const realKey = join(realData, "payload.key");
    const runtime = await TerminalRuntime.create({
      root: ws,
      reserved: async (path) => [realKey, realData, join(realData, "melra.sqlite-journal")].includes(path),
    });
    const key = join(data, "payload.key");
    const spellings = [key, join("..", "data", "payload.key"), `--file=${key}`, `-f${key}`, join(data, "payload.*")];
    if (process.platform !== "win32") {
      // The program resolves `l/..` through the link, to data/, not to ws/.
      await symlink(join(data, "sub"), join(ws, "l"));
      spellings.push("l/../payload.key", "l/../melra.sqlite-journal");
    }
    for (const spelling of spellings) {
      await expect(run(runtime, spelling), spelling).rejects.toThrow(/terminal_path_reserved/);
    }
    await expect(run(runtime, "ok.txt")).resolves.toMatchObject({ success: true });
  });

  it.skipIf(process.platform === "win32")("answers the same for a path that passes a reserved name and climbs back out", async () => {
    // Folded, such a path names nothing reserved, but the program looks up
    // every part before a `..`, and whether that part is there is an answer.
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-terminal-")));
    roots.push(base);
    const ws = join(base, "ws");
    const data = join(base, "data");
    await mkdir(join(ws, "sub"), { recursive: true });
    await mkdir(join(base, "elsewhere"));
    await mkdir(data);
    await writeFile(join(data, "payload.key"), "secret");
    await writeFile(join(ws, "ok.txt"), "ok");
    // A link is climbed out of from where it leads, not from where it sits.
    await symlink(join(base, "elsewhere"), join(ws, "l"));
    const runtime = await TerminalRuntime.create({
      root: ws,
      reserved: async (path) => path === data || path.startsWith(`${data}${sep}`),
    });
    for (const name of ["payload.key", "missing"]) {
      for (const spelling of [`${data}/${name}/../../ws/ok.txt`, `../data/${name}/../../ws/ok.txt`, `l/../data/${name}/../ws/ok.txt`]) {
        await expect(run(runtime, spelling), spelling).rejects.toThrow(/terminal_path_reserved/);
      }
    }
    for (const spelling of ["../ws/ok.txt", "sub/../ok.txt", "l/../ws/ok.txt"]) {
      await expect(run(runtime, spelling), spelling).resolves.toMatchObject({ success: true });
    }
  });

  /** A workspace dependency linked as pnpm links one, with MELRA's data beside the workspace. */
  async function pnpmLayout() {
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-terminal-")));
    roots.push(base);
    const ws = join(base, "ws");
    const data = join(base, ".melra");
    await mkdir(data);
    await mkdir(join(ws, "packages", "protocol"), { recursive: true });
    await mkdir(join(ws, "apps", "cli", "node_modules", "@melra"), { recursive: true });
    const link = "apps/cli/node_modules/@melra/protocol";
    await symlink(join("..", "..", "..", "..", "packages", "protocol"), join(ws, link));
    const reserved = async (path: string) => path === data || path.startsWith(`${data}${sep}`);
    return { base, ws, data, link, reserved };
  }
  const mkdirP = (runtime: TerminalRuntime, spelling: string) =>
    runtime.execute(TerminalOperationSchema.parse({ kind: "terminal", action: "run", command: "mkdir", args: ["-p", spelling] }));

  it.skipIf(process.platform === "win32")("answers the same for a path climbing out of a link, present or absent", async () => {
    // Folded as text, `link/../../..` lands in apps/cli; the program climbs
    // from where the link leads and lands beside the workspace.
    const { ws, data, link, reserved } = await pnpmLayout();
    const runtime = await TerminalRuntime.create({ root: ws, reserved });
    for (const name of ["payload.key", "melra.sqlite-journal"]) {
      const spelling = `${link}/../../../.melra/${name}/x`;
      await expect(run(runtime, spelling), `${spelling} absent`).rejects.toThrow(/terminal_path_reserved/);
      await writeFile(join(data, name), "x");
      await expect(run(runtime, spelling), `${spelling} present`).rejects.toThrow(/terminal_path_reserved/);
    }
    await expect(run(runtime, `${link}/../../../ws/packages`)).resolves.toMatchObject({ success: true });
  });

  it.skipIf(process.platform === "win32")("makes nothing in MELRA's data through a link and `..`", async () => {
    const { ws, data, link, reserved } = await pnpmLayout();
    const runtime = await TerminalRuntime.create({ root: ws, reserved });
    // The second makes `new` on the way, then climbs back out of it.
    for (const spelling of [`${link}/../../../.melra/made/x`, `${link}/new/../../../../.melra/made`]) {
      await expect(mkdirP(runtime, spelling), spelling).rejects.toThrow(/terminal_path_reserved/);
    }
    expect(await readdir(data)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("in enforced mode, refuses a creating argument that climbs out of a link and leaves", async () => {
    const { base, ws, link } = await pnpmLayout();
    const confined = await TerminalRuntime.create({ root: ws, confineArguments: true });
    await expect(mkdirP(confined, `${link}/../../../outside/made/x`)).rejects.toThrow(/terminal_path_outside_workspace/);
    expect(existsSync(join(base, "outside"))).toBe(false);
    await expect(mkdirP(confined, `${link}/../../made/x`)).resolves.toMatchObject({ success: true });
    expect(existsSync(join(ws, "made", "x"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("in enforced mode, refuses a creating argument that leaves on the way and comes back", async () => {
    const { base, ws, link } = await pnpmLayout();
    await mkdir(join(base, "outside"));
    await symlink(join(base, "outside"), join(ws, "out"));
    const confined = await TerminalRuntime.create({ root: ws, confineArguments: true });
    // `mkdir -p` makes every part it climbs out of, not only where it ends.
    for (const spelling of ["../made/../ws/x", "out/made/../../ws/y", `${link}/../../../outside/made/../../ws/z`]) {
      await expect(mkdirP(confined, spelling), spelling).rejects.toThrow(/terminal_path_outside_workspace/);
    }
    expect((await readdir(base)).sort()).toEqual([".melra", "outside", "ws"]);
    expect(await readdir(join(base, "outside"))).toEqual([]);
    await expect(mkdirP(confined, "new/../made")).resolves.toMatchObject({ success: true });
    expect(existsSync(join(ws, "new")) && existsSync(join(ws, "made"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("in enforced mode, refuses a link to a name not there yet that leads out", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-terminal-")));
    roots.push(base);
    const ws = join(base, "ws");
    await mkdir(ws);
    await mkdir(join(base, "outside"));
    await symlink(join(base, "outside", "made"), join(ws, "absolute"));
    await symlink(join("..", "outside", "made"), join(ws, "relative"));
    await symlink("inner", join(ws, "within"));
    const confined = await TerminalRuntime.create({ root: ws, confineArguments: true });
    // `touch` makes the file a link to a missing name points at.
    const touch = (spelling: string) =>
      confined.execute(TerminalOperationSchema.parse({ kind: "terminal", action: "run", command: "touch", args: [spelling] }));
    for (const spelling of ["absolute", "relative"]) {
      await expect(touch(spelling), spelling).rejects.toThrow(/terminal_path_outside_workspace/);
    }
    expect(await readdir(join(base, "outside"))).toEqual([]);
    await expect(touch("within")).resolves.toMatchObject({ success: true });
    expect(existsSync(join(ws, "inner"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("judges an argument where a program that folds `..` as text reads it", async () => {
    // As git reads a pathspec: `pkg/..` lands beside the link, not beside its
    // target, so this names the data directory there, and proj/.melra here.
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-terminal-")));
    roots.push(root);
    const data = join(root, ".melra");
    await mkdir(data);
    await mkdir(join(root, "proj", "node_modules", ".pnpm", "pkg"), { recursive: true });
    await symlink(join(".pnpm", "pkg"), join(root, "proj", "node_modules", "pkg"));
    const runtime = await TerminalRuntime.create({
      root,
      reserved: async (path) => path === data || path.startsWith(`${data}${sep}`),
      holdsReserved: async (path) => path === root,
    });
    const inProj = (spelling: string) =>
      runtime.execute(
        TerminalOperationSchema.parse({
          kind: "terminal",
          action: "run",
          command: process.execPath,
          args: ["-e", "", "--", spelling],
          cwd: "proj",
        }),
      );
    for (const present of [false, true]) {
      if (present) await mkdir(join(root, "proj", ".melra"));
      for (const spelling of ["node_modules/pkg/../../../.melra/payload.key", "node_modules/pkg/../../.."]) {
        await expect(inProj(spelling), `${spelling}, proj/.melra there: ${present}`).rejects.toThrow(/terminal_path_reserved/);
      }
    }
    await expect(inProj("node_modules/pkg/../../ok.txt")).resolves.toMatchObject({ success: true });
  });

  it.skipIf(process.platform === "win32")("in enforced mode, judges where `..` folded as text lands from a cwd through a link", async () => {
    // The workspace sits in an enclosing repository, and its cwd `a/up` is the
    // workspace itself, a level shallower than spelled: git, folding
    // `l3/../..` as text, reads the repository's missing/y.
    const repo = await realpath(await mkdtemp(join(tmpdir(), "melra-terminal-")));
    roots.push(repo);
    const ws = join(repo, "ws");
    await mkdir(join(ws, "sub", "deep"), { recursive: true });
    await mkdir(join(ws, "a"));
    await mkdir(join(repo, "missing"));
    await writeFile(join(repo, "missing", "y"), "committed\n");
    for (const args of [["init", "-q"], ["add", "."], ["commit", "-qm", "x"]]) {
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
    }
    await writeFile(join(repo, "missing", "y"), "edited\n");
    await symlink("..", join(ws, "a", "up"));
    await symlink(join("sub", "deep"), join(ws, "l3"));
    const confined = await TerminalRuntime.create({ root: ws, confineArguments: true });
    const git = (...args: string[]) =>
      confined.execute(TerminalOperationSchema.parse({ kind: "terminal", action: "run", command: "git", args, cwd: "a/up" }));
    for (const action of ["diff", "checkout"]) {
      await expect(git(action, "--", "l3/../../missing/y"), action).rejects.toThrow(/terminal_path_outside_workspace/);
    }
    expect(await readFile(join(repo, "missing", "y"), "utf8")).toBe("edited\n");
    await expect(git("diff", "--", "l3/../deep")).resolves.toMatchObject({ success: true });
  });

  it.skipIf(process.platform === "win32")("follows a link to a missing name once per command, and not around a loop", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-terminal-")));
    roots.push(root);
    await mkdir(join(root, "d"));
    // Each step along these links costs a lookup per `..` in its target.
    const climb = "d/../".repeat(50);
    await symlink(`${climb}loop2`, join(root, "loop1"));
    await symlink(`${climb}loop1`, join(root, "loop2"));
    for (let n = 0; n < 20; n++) await symlink(`${climb}chain${n + 1}`, join(root, `chain${n}`));
    await symlink(`${climb}missing`, join(root, "chain20"));
    const runtime = await TerminalRuntime.create({ root, confineArguments: true });
    // Each argument also climbs out of a place through the same link.
    const cost = async (into: string, count: number) => {
      const before = lookups.count;
      const args = ["-e", "", "--", ...Array.from({ length: count }, (_, n) => `${into}/${n}/../x`)];
      await runtime.execute(TerminalOperationSchema.parse({ kind: "terminal", action: "run", command: process.execPath, args }));
      return lookups.count - before;
    };
    // Fewer than one step around the loop per argument.
    expect(await cost("loop1", 20)).toBeLessThan(20 * 50);
    // Twenty arguments through the chain cost little more than one.
    expect(await cost("chain0", 20)).toBeLessThan(2 * (await cost("chain0", 1)));
  });

  it("bounds how many places one command may climb out of", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-terminal-")));
    roots.push(root);
    let asked = 0;
    const runtime = await TerminalRuntime.create({
      root,
      reserved: async () => {
        asked += 1;
        return false;
      },
    });
    // Each `<n>/..` climbs out of a directory of its own.
    const climbing = (count: number) => Array.from({ length: count }, (_, n) => `${n}${sep}..`).join(sep);
    await expect(run(runtime, climbing(128))).resolves.toMatchObject({ success: true });
    asked = 0;
    await expect(run(runtime, climbing(500))).rejects.toThrow(/terminal_path_too_complex/);
    // The working directory, the program's other arguments and 128 places.
    expect(asked).toBeLessThanOrEqual(5 + 128);
  });

  it("answers the same for a reserved working directory, present or absent", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-terminal-")));
    roots.push(root);
    const data = join(root, ".melra");
    await mkdir(join(data, "present"), { recursive: true });
    const runtime = await TerminalRuntime.create({
      root,
      reserved: async (path) => path === data || path.startsWith(`${data}${sep}`),
    });
    for (const cwd of [".melra/present", ".melra/missing"]) {
      await expect(
        runtime.execute(
          TerminalOperationSchema.parse({ kind: "terminal", action: "run", command: process.execPath, args: ["-e", ""], cwd }),
        ),
        cwd,
      ).rejects.toThrow(/terminal_path_reserved/);
    }
  });

  it("in enforced mode, refuses an argument spelled inside that leads out", async () => {
    const base = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(base);
    const ws = join(base, "ws");
    await mkdir(ws);
    await mkdir(join(base, "outside"));
    await symlink(join(base, "outside"), join(ws, "out"), "junction");
    // Spelled outside, policy already asked a person; spelled inside, it did not.
    const confined = await TerminalRuntime.create({ root: ws, confineArguments: true });
    // However many parts past the link are not there yet: `mkdir -p` makes them all.
    for (const spelling of [join("out", "f"), join("out", "new", "f")]) {
      await expect(run(confined, spelling), spelling).rejects.toThrow(/terminal_path_outside_workspace/);
    }
    await expect(run(confined, join(base, "outside", "f"))).resolves.toMatchObject({ success: true });
    const developer = await TerminalRuntime.create({ root: ws });
    for (const spelling of [join("out", "f"), join(base, "outside", "f")]) {
      await expect(run(developer, spelling)).resolves.toMatchObject({ success: true });
    }
  });
});

describe("hardenGitRead", () => {
  // Portable: it asserts the hardening decision, not a spawned POSIX program, so
  // it runs on every OS. The null device differs per platform.
  const nullConfig = process.platform === "win32" ? "NUL" : "/dev/null";
  const env = { GIT_CONFIG_SYSTEM: nullConfig, GIT_CONFIG_GLOBAL: nullConfig, GIT_NO_LAZY_FETCH: "1" };
  // Hooks, signature verifiers and fsmonitor off by `-c`s that beat local config.
  const switches = [
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${nullConfig}`,
    "-c", `gpg.program=${nullConfig}`,
    "-c", `gpg.ssh.program=${nullConfig}`,
    "-c", `gpg.x509.program=${nullConfig}`,
  ];

  it("turns off every config-defined program channel on a git read", () => {
    // fsmonitor off by a `-c` that beats local config; external-diff and
    // textconv off by the flags the diff-emitting subcommands take; system and
    // global config nulled in the env.
    expect(hardenGitRead("git", ["show", "HEAD"])).toEqual({
      args: [...switches, "show", "--no-ext-diff", "--no-textconv", "HEAD"],
      env,
    });
    expect(hardenGitRead("git", ["log", "-p"])).toEqual({
      args: [...switches, "log", "--no-ext-diff", "--no-textconv", "-p"],
      env,
    });
    expect(hardenGitRead("git", ["diff", "--stat"])).toEqual({
      args: [...switches, "diff", "--no-ext-diff", "--no-textconv", "--stat"],
      env,
    });
  });

  it("omits the diff flags on reads that do not accept them", () => {
    // `git status --no-ext-diff` is an error, so the flags go only on diff/log/show.
    for (const sub of [["status"], ["rev-parse", "HEAD"], ["branch"], ["tag"]]) {
      expect(hardenGitRead("git", sub)).toEqual({
        args: [...switches, ...sub],
        env,
      });
    }
  });

  it("hardens a path-qualified git, since it is still the git program", () => {
    expect(hardenGitRead("/usr/bin/git", ["log"])).toBeDefined();
    expect(hardenGitRead("C:\\Program Files\\Git\\bin\\git.exe", ["status"])).toBeDefined();
  });

  it("leaves mutations, global-option-first calls, and other programs alone", () => {
    // A mutation keeps its global config (a committer's identity, credentials).
    expect(hardenGitRead("git", ["commit", "-m", "x"])).toBeUndefined();
    expect(hardenGitRead("git", ["push"])).toBeUndefined();
    // A global option before the subcommand is not a read to policy either.
    expect(hardenGitRead("git", ["-c", "core.pager=cat", "status"])).toBeUndefined();
    // Only git itself, not a lookalike.
    expect(hardenGitRead("git-foo", ["show"])).toBeUndefined();
    expect(hardenGitRead("cat", ["show", "HEAD"])).toBeUndefined();
  });
});
