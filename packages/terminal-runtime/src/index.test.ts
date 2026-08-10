// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalOperationSchema } from "@melra/protocol";
import { TerminalRuntime, redactTerminalOutput } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
