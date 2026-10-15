// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { outcomeUnknown, terminalArgumentPaths, type TerminalOperation } from "@melra/protocol";
import { redactSecrets } from "@melra/receipt-schema";
import { resolveCommand } from "./resolve-command.js";

export { quoteForCmd, resolveCommand } from "./resolve-command.js";
export type { ResolvedCommand } from "./resolve-command.js";

export interface TerminalRuntimeOptions {
  root: string;
  allowedEnvironment?: string[];
  baseEnvironment?: NodeJS.ProcessEnv;
  /** Whether a path is, or is inside, one of MELRA's own files, which no argument may reach in any mode. Absent, nothing is. */
  reserved?: (path: string) => Promise<boolean>;
  /** Whether a path is a directory holding one of them, which a recursive reader given it reaches unnamed. Absent, none is. */
  holdsReserved?: (path: string) => Promise<boolean>;
  /** Refuse an argument spelled inside the root that leads out: policy asked approval only for ones spelled outside. */
  confineArguments?: boolean;
}

/**
 * Programs that print names, never contents, so a directory holding MELRA's
 * files is safe to give them: `ls ..` from a project under home keeps working.
 * Naming the files themselves is still refused.
 */
const NAME_LISTERS = new Set(["ls", "pwd", "where"]);

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

// The shared list, so terminal output is redacted for exactly the shapes a
// receipt or a memory value would be.
export function redactTerminalOutput(value: string): string {
  return redactSecrets(value).value;
}

/** Where a path leads: through every link, or for one not there yet, through its directory's. */
async function leadsTo(spelled: string): Promise<string> {
  return await realpath(spelled).catch(async () =>
    join(await realpath(dirname(spelled)).catch(() => resolve(dirname(spelled))), basename(spelled)));
}

/** The null device, so git's system/global config files resolve to nothing. */
const GIT_NULL_CONFIG = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * git subcommands policy classifies as approval-free reads (the same set as
 * `READ_ONLY_GIT_ACTIONS` in policy-core). Kept here, not imported, because this
 * is the spawn boundary and it has to decide for itself what git it is about to
 * run — policy cannot see what the .git/config of the repo will do.
 */
const GIT_READ_SUBCOMMANDS = new Set(["branch", "diff", "log", "rev-parse", "show", "status", "tag"]);
/** The read subcommands that emit diffs — the only ones that accept the diff flags below. */
const GIT_DIFF_SUBCOMMANDS = new Set(["diff", "log", "show"]);

/** Whether a command, path-qualified or not, is the git program by name. */
function isGitCommand(command: string): boolean {
  return (
    basename(command.replaceAll("\\", "/")).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "") ===
    "git"
  );
}

/**
 * Policy classifies several `git` subcommands (diff, show, log, status, ...) as
 * approval-free reads, but git runs programs named in the repository's *own*
 * config and attributes while serving one: a diff `textconv` or external-diff
 * driver bound through `.gitattributes` + `.git/config`, and a `core.fsmonitor`
 * program on `git status`. Those program paths live in config, not in the
 * terminal arguments, so `checkArguments` never sees them — a single approved,
 * innocuous file write can plant one, and a later approval-free read then runs
 * an arbitrary program, which can read payload.key or melra.sqlite. Policy
 * cannot see .git/config either; the spawn is the only place that can close it.
 *
 * So when the program is git and the call is read-shaped (subcommand first, as
 * policy requires for a read), spawn it with those channels off: system and
 * global config nulled, fsmonitor disabled by a highest-precedence `-c` that
 * beats local config, and external-diff/textconv turned off on the subcommands
 * that emit diffs (the only ones that accept the flags). Mutations — commit,
 * push, or a global option before the subcommand — are left untouched, so a
 * committer's identity and credentials from global config still apply.
 *
 * Pure and exported for unit testing. The caller's `operation.args` are never
 * touched, only the spawned argv, so receipts still quote what was asked.
 */
export function hardenGitRead(
  command: string,
  args: readonly string[],
): { args: string[]; env: Record<string, string> } | undefined {
  if (!isGitCommand(command)) return undefined;
  const first = args[0];
  if (first === undefined || !GIT_READ_SUBCOMMANDS.has(first.toLowerCase())) return undefined;
  const diffFlags = GIT_DIFF_SUBCOMMANDS.has(first.toLowerCase())
    ? ["--no-ext-diff", "--no-textconv"]
    : [];
  return {
    args: ["-c", "core.fsmonitor=false", first, ...diffFlags, ...args.slice(1)],
    env: { GIT_CONFIG_SYSTEM: GIT_NULL_CONFIG, GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG },
  };
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
/** How long a SIGTERM gets before SIGKILL when a run times out or is cancelled. */
const KILL_GRACE_MS = 1_000;
/**
 * How long after the command exits its output pipes may stay open. A process
 * it started can inherit them and keep them open for as long as it lives,
 * which held a run, its timeout and its cancel, until that process ended.
 */
const EXIT_DRAIN_MS = 250;
/** Jobs kept at once, running or finished; the oldest finished one makes room. */
const MAX_JOBS = 64;

/**
 * Each command leads its own process group on POSIX, so a timeout, a cancel
 * or `stop` reaches what it started too, not only the program itself. Windows
 * has no process groups to signal; `taskkill /T` walks the tree instead.
 */
const OWN_GROUP = process.platform !== "win32";

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (!OWN_GROUP) {
    // `/F` because Windows has no SIGTERM to trap: TerminateProcess is all
    // `child.kill` did there too.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      .on("error", () => child.kill(signal));
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}

/** SIGTERM to the tree now and SIGKILL shortly after, unless it has all exited. */
function stopTree(child: ChildProcess, graceMs: number): NodeJS.Timeout {
  signalTree(child, "SIGTERM");
  const escalation = setTimeout(() => signalTree(child, "SIGKILL"), graceMs);
  escalation.unref();
  return escalation;
}

/** Once the command exits, its pipes get a moment to drain and are then closed. */
function closePipesAfterExit(child: ChildProcess): void {
  child.once("exit", () => {
    setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, EXIT_DRAIN_MS).unref();
  });
}

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
  /** Why the job's stdin stopped taking input, once it has. */
  stdinError?: string;
  timer: NodeJS.Timeout;
}

export class TerminalRuntime {
  readonly root: string;
  readonly allowedEnvironment: Set<string>;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  /** The root as policy spelled it, which is what "spelled inside" is measured against. */
  private readonly lexicalRoot: string;
  private readonly reserved: (path: string) => Promise<boolean>;
  private readonly holdsReserved: (path: string) => Promise<boolean>;
  private readonly confineArguments: boolean;
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
    this.lexicalRoot = resolve(options.root);
    this.reserved = options.reserved ?? (async () => false);
    this.holdsReserved = options.holdsReserved ?? (async () => false);
    this.confineArguments = options.confineArguments ?? false;
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

  private async checkArguments(operation: TerminalOperation, cwd: string): Promise<void> {
    const lexicalCwd = resolve(this.lexicalRoot, operation.cwd ?? ".");
    // A path-qualified program is whatever file sits at that path, so only a
    // bare name is taken at its word.
    const command = operation.command ?? "";
    const listsNames =
      !/[\\/]/.test(command) &&
      NAME_LISTERS.has(command.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, ""));
    for (const path of [".", ...terminalArgumentPaths(operation.args)]) {
      // Unnormalised: the program resolves `link/..` through the link.
      const real = await leadsTo(isAbsolute(path) ? path : `${cwd}${sep}${path}`);
      // findstr and where expand their own wildcards, reading the directory.
      for (const probe of /[*?]/.test(path) ? [real, dirname(real)] : [real]) {
        if ((await this.reserved(probe)) || (!listsNames && (await this.holdsReserved(probe)))) {
          throw new Error("terminal_path_reserved");
        }
      }
      const spelledInside = inside(this.lexicalRoot, resolve(lexicalCwd, path));
      if (this.confineArguments && spelledInside && !inside(this.root, real)) {
        throw new Error("terminal_path_outside_workspace");
      }
    }
  }

  private async prepare(operation: TerminalOperation): Promise<PreparedCommand> {
    if (operation.command === undefined) {
      throw new Error(`terminal_${operation.action}_requires_command`);
    }
    if (operation.command.includes("\0") || operation.args.some((arg) => arg.includes("\0"))) {
      throw new Error("terminal_input_contains_null");
    }
    const cwd = await this.resolveCwd(operation.cwd);
    // Before the program is looked up, so a refusal never depends on whether
    // it is installed.
    await this.checkArguments(operation, cwd);
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
    // Disable git's config-defined program channels on a read at the spawn
    // boundary, since policy cannot see .git/config (see hardenGitRead).
    // Skipped when resolveCommand wrapped the call in cmd.exe, where `args` is an
    // already-quoted command line rather than git's own arguments.
    const hardened = resolved.windowsVerbatimArguments
      ? undefined
      : hardenGitRead(resolved.executable, resolved.args);
    return {
      command: operation.command,
      args: operation.args,
      file: resolved.file,
      spawnArgs: hardened?.args ?? resolved.args,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      executable: resolved.executable,
      cwd,
      environment: hardened === undefined ? environment : { ...environment, ...hardened.env },
      timeoutMs: operation.timeoutMs,
      maxOutputChars: operation.maxOutputChars,
      interactive: operation.interactive,
    };
  }

  private async runForeground(
    prepared: PreparedCommand,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted === true) throw new Error("task_cancelled");
    return await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      const child = spawn(prepared.file, prepared.spawnArgs, {
        cwd: prepared.cwd,
        env: prepared.environment,
        shell: false,
        detached: OWN_GROUP,
        windowsHide: true,
        windowsVerbatimArguments: prepared.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let settled = false;

      // Decoded across chunks, so a character split between two reads stays one.
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const append = (current: string, chunk: string): string => {
        const next = current + chunk;
        if (next.length > prepared.maxOutputChars) {
          truncated = true;
          return next.slice(0, prepared.maxOutputChars);
        }
        return next;
      };
      child.stdout.on("data", (chunk: string) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = append(stderr, chunk);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        stopTree(child, KILL_GRACE_MS);
      }, prepared.timeoutMs);
      timer.unref();

      // Not spawn's own `signal` option: that sends SIGTERM to the program
      // alone, and its listener is gone once the program exits, so a program
      // that traps SIGTERM, or anything it started, outlived the cancel.
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopTree(child, KILL_GRACE_MS);
        // It may well have done its work (written the file, pushed the
        // branch) before it was stopped, so this is not "it did not happen".
        const reason = signal?.reason instanceof Error ? signal.reason.message : "task_cancelled";
        reject(outcomeUnknown(reason));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      closePipesAfterExit(child);
      // A foreground run is over when its program is; whatever it left behind
      // in its group goes with it.
      child.once("exit", () => {
        if (OWN_GROUP) signalTree(child, "SIGTERM");
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(describeSpawnError(error, prepared.command));
      });
      child.once("close", (code, terminationSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
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
    // Jobs are kept for their output after they end, so a caller looping
    // `start` grew memory and processes for the life of the server.
    if (this.jobs.size >= MAX_JOBS) {
      const finished = [...this.jobs.values()].find((candidate) => candidate.endedAt !== undefined);
      if (finished === undefined) throw new Error("terminal_too_many_jobs");
      this.jobs.delete(finished.id);
    }
    const id = randomUUID();
    const child = spawn(prepared.file, prepared.spawnArgs, {
      cwd: prepared.cwd,
      env: prepared.environment,
      shell: false,
      detached: OWN_GROUP,
      windowsHide: true,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
      stdio: [prepared.interactive ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => stopTree(child, KILL_GRACE_MS), prepared.timeoutMs);
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
    const append = (current: string, chunk: string): string => {
      const next = current + chunk;
      if (next.length > prepared.maxOutputChars) {
        job.truncated = true;
        return next.slice(0, prepared.maxOutputChars);
      }
      return next;
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      job.stdout = append(job.stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      job.stderr = append(job.stderr, chunk);
    });
    // A write to a reader that has gone fails later, as an error event on the
    // pipe. Unheard, that event took the whole server down.
    child.stdin?.on("error", (error) => {
      job.stdinError = error.message;
    });
    closePipesAfterExit(child);
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
    if (job.stdinError !== undefined) throw new Error("terminal_job_stdin_closed");
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
        if (job.endedAt === undefined) stopTree(job.child, CLOSE_GRACE_MS);
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
      // A child is free to trap SIGTERM, and shutdown blocking forever on one
      // that does is worse than the race this replaced.
      const escalation = stopTree(job.child, CLOSE_GRACE_MS);
      await exited;
      clearTimeout(escalation);
    });
    this.jobs.clear();
    await Promise.all(exits);
  }
}
