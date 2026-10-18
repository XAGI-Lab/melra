// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalOperationSchema } from "@melra/protocol";
import { TerminalRuntime, hardenGitRead, redactTerminalOutput } from "./index.js";

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
    // The first write may be accepted; its EPIPE arrives afterwards. That used
    // to be an unhandled error event, which killed this whole process. Asked
    // again until refused, so the test waits for the EPIPE rather than a guess.
    await send().catch(() => undefined);
    let refused: unknown;
    for (let waited = 0; waited < 5000 && refused === undefined; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      refused = await send().then(() => undefined, (error: unknown) => error);
    }
    expect(String(refused)).toMatch(/terminal_job_(stdin_closed|not_interactive|not_running)/);
    await runtime.close();
  });

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

  it("stops commands at the configured timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(root);
    const runtime = await TerminalRuntime.create({ root });
    const result = await runtime.execute(
      TerminalOperationSchema.parse({
        kind: "terminal",
        action: "run",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
        timeoutMs: 150,
      }),
    );
    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
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

  it("in enforced mode, refuses an argument spelled inside that leads out", async () => {
    const base = await mkdtemp(join(tmpdir(), "melra-terminal-"));
    roots.push(base);
    const ws = join(base, "ws");
    await mkdir(ws);
    await mkdir(join(base, "outside"));
    await symlink(join(base, "outside"), join(ws, "out"), "junction");
    // Spelled outside, policy already asked a person; spelled inside, it did not.
    const confined = await TerminalRuntime.create({ root: ws, confineArguments: true });
    await expect(run(confined, join("out", "f"))).rejects.toThrow(/terminal_path_outside_workspace/);
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
