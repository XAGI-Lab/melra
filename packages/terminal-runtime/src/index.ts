// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TerminalOperation } from "@melra/protocol";
import { resolveCommand } from "./resolve-command.js";

export { quoteForCmd, resolveCommand } from "./resolve-command.js";
export type { ResolvedCommand } from "./resolve-command.js";

export interface TerminalRuntimeOptions {
  root: string;
  allowedEnvironment?: string[];
  baseEnvironment?: NodeJS.ProcessEnv;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bgh[opurs]_[A-Za-z0-9]{20,}\b/g,
  /\b(?:sk|pk|api)[-_][a-z0-9_-]{16,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi,
  /\b(password|passwd|secret)\s*[:=]\s*\S+/gi,
];

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function redactTerminalOutput(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[REDACTED]"),
    value,
  );
}

interface PreparedCommand {
  /** The command as the caller spelled it — what receipts and evidence quote. */
  command: string;
  args: string[];
  /** What `spawn` is actually given; on Windows this may be `cmd.exe`. */
  file: string;
  spawnArgs: string[];
  windowsVerbatimArguments: boolean;
  executable: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputChars: number;
  /** Whether the child keeps a writable stdin for `send`. */
  interactive: boolean;
}

/**
 * `spawn` reports a missing program as a bare `ENOENT` naming only the syscall,
 * which reads as an internal fault rather than "that program is not installed".
 */
function describeSpawnError(error: unknown, command: string): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return new Error(`terminal_command_not_found:${command}`);
  if (code === "EACCES") return new Error(`terminal_command_not_executable:${command}`);
  return error instanceof Error ? error : new Error(String(error));
}

/** How long a signalled child gets to exit on its own before SIGKILL. */
const CLOSE_GRACE_MS = 2_000;

interface BackgroundJob {
  id: string;
  child: ChildProcess;
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  timer: NodeJS.Timeout;
}

export class TerminalRuntime {
  readonly root: string;
  readonly allowedEnvironment: Set<string>;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  private readonly jobs = new Map<string, BackgroundJob>();

  private constructor(
    options: TerminalRuntimeOptions,
    root: string,
  ) {
    this.root = root;
    this.allowedEnvironment = new Set(
      options.allowedEnvironment ?? ["CI", "LANG", "LC_ALL", "NO_COLOR", "TERM"],
    );
    this.baseEnvironment = options.baseEnvironment ?? process.env;
  }

  static async create(options: TerminalRuntimeOptions): Promise<TerminalRuntime> {
    return new TerminalRuntime(options, await realpath(options.root));
  }

  private async resolveCwd(cwd: string | undefined): Promise<string> {
    const candidate = resolve(this.root, cwd ?? ".");
    if (!inside(this.root, candidate)) throw new Error("cwd_outside_workspace");
    const actual = await realpath(candidate);
    if (!inside(this.root, actual)) throw new Error("cwd_outside_workspace");
    return actual;
  }

  private async prepare(operation: TerminalOperation): Promise<PreparedCommand> {
    if (operation.command === undefined) {
      throw new Error(`terminal_${operation.action}_requires_command`);
    }
    if (operation.command.includes("\0") || operation.args.some((arg) => arg.includes("\0"))) {
      throw new Error("terminal_input_contains_null");
    }
    const cwd = await this.resolveCwd(operation.cwd);
    const environment: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC"]) {
      if (this.baseEnvironment[name] !== undefined) {
        environment[name] = this.baseEnvironment[name];
      }
    }
    for (const name of this.allowedEnvironment) {
      if (this.baseEnvironment[name] !== undefined) {
        environment[name] = this.baseEnvironment[name];
      }
    }
    for (const [name, value] of Object.entries(operation.env ?? {})) {
      if (!this.allowedEnvironment.has(name)) {
        throw new Error(`environment_variable_not_allowed:${name}`);
      }
      environment[name] = value;
    }
    const resolved = await resolveCommand(operation.command, operation.args, {
      cwd,
      path: environment["PATH"] ?? environment["Path"],
      pathExt: environment["PATHEXT"],
      comspec: this.baseEnvironment["COMSPEC"],
    });
    return {
      command: operation.command,
      args: operation.args,
      file: resolved.file,
      spawnArgs: resolved.args,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      executable: resolved.executable,
      cwd,
      environment,
      timeoutMs: operation.timeoutMs,
      maxOutputChars: operation.maxOutputChars,
      interactive: operation.interactive,
    };
  }

  private async runForeground(
    prepared: PreparedCommand,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      const child = spawn(prepared.file, prepared.spawnArgs, {
        cwd: prepared.cwd,
        env: prepared.environment,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: prepared.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;

      const append = (current: string, chunk: Buffer): string => {
        const next = current + chunk.toString("utf8");
        if (next.length > prepared.maxOutputChars) {
          truncated = true;
          return next.slice(0, prepared.maxOutputChars);
        }
        return next;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
      }, prepared.timeoutMs);
      timer.unref();

      child.once("error", (error) => {
        clearTimeout(timer);
        reject(describeSpawnError(error, prepared.command));
      });
      child.once("close", (code, terminationSignal) => {
        clearTimeout(timer);
        resolvePromise({
          command: prepared.command,
          args: prepared.args,
          cwd: relative(this.root, prepared.cwd) || ".",
          exitCode: code,
          signal: terminationSignal,
          timedOut,
          stdout: redactTerminalOutput(stdout),
          stderr: redactTerminalOutput(stderr),
          truncated,
          success: code === 0 && !timedOut,
        });
      });
    });
  }

  private async startBackground(
    prepared: PreparedCommand,
  ): Promise<Record<string, unknown>> {
    const id = randomUUID();
    const child = spawn(prepared.file, prepared.spawnArgs, {
      cwd: prepared.cwd,
      env: prepared.environment,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
      stdio: [prepared.interactive ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, prepared.timeoutMs);
    timer.unref();
    const job: BackgroundJob = {
      id,
      child,
      command: prepared.command,
      args: prepared.args,
      cwd: prepared.cwd,
      stdout: "",
      stderr: "",
      truncated: false,
      startedAt: new Date().toISOString(),
      timer,
    };
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (next.length > prepared.maxOutputChars) {
        job.truncated = true;
        return next.slice(0, prepared.maxOutputChars);
      }
      return next;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      job.stdout = append(job.stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      job.stderr = append(job.stderr, chunk);
    });
    child.once("error", (error) => {
      job.error = error.message;
      job.endedAt = new Date().toISOString();
      clearTimeout(timer);
    });
    child.once("close", (exitCode, terminationSignal) => {
      job.exitCode = exitCode;
      job.signal = terminationSignal;
      job.endedAt = new Date().toISOString();
      clearTimeout(timer);
    });
    // `spawn` only reports a failed start asynchronously, so returning as soon
    // as the call came back reported `started: true` for a command that never
    // ran — the caller got a job id for a process that did not exist. Waiting
    // for whichever of `spawn`/`error` fires first makes the reported start real.
    try {
      await new Promise<void>((settled, failed) => {
        child.once("spawn", settled);
        child.once("error", failed);
      });
    } catch (error) {
      clearTimeout(timer);
      throw describeSpawnError(error, prepared.command);
    }
    this.jobs.set(id, job);
    return {
      success: true,
      started: true,
      jobId: id,
      pid: child.pid ?? null,
      command: prepared.command,
      executable: prepared.executable,
      cwd: relative(this.root, prepared.cwd) || ".",
      interactive: prepared.interactive,
    };
  }

  /**
   * Answers a prompt on a running job's stdin.
   *
   * This is a pipe, not a terminal. A program that asks `isatty` still sees a
   * non-interactive session and may keep its non-interactive behaviour — reading
   * a password without echo is the usual one, and it will not work here. A real
   * PTY needs a native addon; this covers the case that does not.
   *
   * ponytail: pipe-only. Add `node-pty` behind an optional dependency if a task
   * genuinely needs a program that refuses to run without a tty.
   */
  private sendInput(operation: TerminalOperation): Record<string, unknown> {
    const job = this.job(operation);
    if (operation.input === undefined) {
      throw new Error("terminal_send_requires_input");
    }
    if (job.endedAt !== undefined) throw new Error("terminal_job_not_running");
    const stdin = job.child.stdin;
    // `start` without `interactive: true` gets an ignored stdin, and writing to
    // a closed one throws EPIPE asynchronously — which would surface as an
    // unhandled error rather than a failed task.
    if (stdin === null || stdin.destroyed || !stdin.writable) {
      throw new Error("terminal_job_not_interactive");
    }
    const payload =
      operation.appendNewline && !operation.input.endsWith("\n")
        ? `${operation.input}\n`
        : operation.input;
    stdin.write(payload);
    return {
      success: true,
      sent: true,
      bytes: Buffer.byteLength(payload),
      ...this.jobResult(job, false),
    };
  }

  private job(operation: TerminalOperation): BackgroundJob {
    if (operation.jobId === undefined) {
      throw new Error(`terminal_${operation.action}_requires_job_id`);
    }
    const job = this.jobs.get(operation.jobId);
    if (job === undefined) throw new Error("terminal_job_not_found");
    return job;
  }

  private jobResult(job: BackgroundJob, includeOutput: boolean): Record<string, unknown> {
    return {
      jobId: job.id,
      running: job.endedAt === undefined,
      pid: job.child.pid ?? null,
      command: job.command,
      args: job.args,
      cwd: relative(this.root, job.cwd) || ".",
      startedAt: job.startedAt,
      ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
      ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
      ...(job.signal === undefined ? {} : { signal: job.signal }),
      ...(job.error === undefined ? {} : { error: job.error }),
      truncated: job.truncated,
      ...(includeOutput
        ? {
            stdout: redactTerminalOutput(job.stdout),
            stderr: redactTerminalOutput(job.stderr),
          }
        : {}),
    };
  }

  async execute(
    operation: TerminalOperation,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    switch (operation.action) {
      case "run":
        return await this.runForeground(await this.prepare(operation), signal);
      case "start":
        return await this.startBackground(await this.prepare(operation));
      case "status":
        return this.jobResult(this.job(operation), false);
      case "output":
        return this.jobResult(this.job(operation), true);
      case "send":
        return this.sendInput(operation);
      case "stop": {
        const job = this.job(operation);
        if (job.endedAt === undefined) job.child.kill("SIGTERM");
        return { stopped: true, ...this.jobResult(job, true) };
      }
    }
  }

  /**
   * Resolves once every supervised child has actually exited, not once they
   * have been signalled. A live child holds its cwd open on Windows, so a
   * caller that deletes the workspace after closing raced `rmdir` against
   * process teardown and got EBUSY.
   */
  async close(): Promise<void> {
    const exits = [...this.jobs.values()].map(async (job) => {
      clearTimeout(job.timer);
      if (job.endedAt !== undefined) return;
      const exited = new Promise<void>((done) => job.child.once("close", () => done()));
      job.child.kill("SIGTERM");
      // A child is free to trap SIGTERM, and shutdown blocking forever on one
      // that does is worse than the race this replaced.
      const escalation = setTimeout(() => job.child.kill("SIGKILL"), CLOSE_GRACE_MS);
      escalation.unref();
      await exited;
      clearTimeout(escalation);
    });
    this.jobs.clear();
    await Promise.all(exits);
  }
}
