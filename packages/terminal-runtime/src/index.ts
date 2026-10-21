// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readlink, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { outcomeUnknown, terminalArgumentPaths, terminalArgumentReferences, type TerminalOperation } from "@melra/protocol";
import { redactSecrets } from "@melra/receipt-schema";
import { resolveCommand } from "./resolve-command.js";

export { quoteForCmd, resolveCommand } from "./resolve-command.js";
export type { ResolvedCommand } from "./resolve-command.js";

export interface TerminalRuntimeOptions {
  root: string;
  allowedEnvironment?: string[];
  baseEnvironment?: NodeJS.ProcessEnv;
  /**
   * Whether a path is, or is inside, one of MELRA's own files, which no
   * argument may reach in any mode. Absent, nothing is. `call` is one object
   * for every check one command makes and a new one for the next, so what the
   * checks compare with may be looked up once per command.
   */
  reserved?: (path: string, call?: object) => Promise<boolean>;
  /** Whether a path is a directory holding one of them, which a recursive reader given it reaches unnamed. Absent, none is. `call` as for `reserved`. */
  holdsReserved?: (path: string, call?: object) => Promise<boolean>;
  /** Refuse an argument spelled inside the root that leads out: policy asked approval only for ones spelled outside. */
  confineArguments?: boolean;
  /**
   * The workspace no PATH entry may lead into, as spelled or through links: a
   * program a bare name finds there is one an approved write may have left,
   * run later by a read that needs no approval. Empty and relative entries,
   * which name the working directory, are dropped too. Absent, PATH passes as
   * given.
   */
  pathOutside?: string;
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

/**
 * Where a path with no `..` in it leads: its deepest part that is there,
 * through every link, then the rest as written, which `mkdir -p` would make
 * there, however many parts that is. `links` keeps where each link to a name
 * not there yet leads, so one check follows it once, however many arguments
 * and places go through it.
 */
async function leadsTo(spelled: string, links: Map<string, { to: string; there: boolean }>, hops = 0): Promise<string> {
  let code: unknown;
  const failed = (error: NodeJS.ErrnoException) => {
    code = error.code;
    return undefined;
  };
  const whole = await realpath(spelled).catch(failed);
  if (whole !== undefined) return whole;
  const chain: string[] = [];
  for (let at = spelled; ; at = dirname(at)) {
    chain.unshift(at);
    if (dirname(at) === at) break;
  }
  // A part resolves only if every part above it does, so the deepest one that
  // does is found by halving: about log2(depth) lookups, not one per part.
  let [resolves, fails, leads] = [-1, chain.length - 1, spelled];
  let parent: string = sep;
  while (fails - resolves > 1) {
    const middle = (resolves + fails) >> 1;
    const at = chain[middle] as string;
    const real = await realpath(at).catch(failed);
    if (real === undefined) fails = middle;
    else [resolves, leads, parent] = [middle, join(real, relative(at, spelled)), real];
  }
  // A link to a name not there yet: `touch link` makes its target, so it
  // leads where the link points, as the file adapter follows one. A loop, or
  // more links than one lookup follows, fails the lookup and makes nothing.
  if (code === "ELOOP" || hops >= 40) return leads;
  const link = join(parent, basename(chain[fails] as string));
  let known = links.get(link);
  if (known === undefined) {
    const target = await readlink(link).catch(() => undefined);
    if (target === undefined) return leads;
    const to = await leadsTo((await climbedFrom(isAbsolute(target) ? target : `${parent}${sep}${target}`)).end, links, hops + 1);
    known = { to, there: await realpath(to).then(() => true, () => false) };
    links.set(link, known);
  }
  // Nothing is below a name that is not there, so the rest is as written;
  // below one that is, it is looked up.
  const rest = spelled.slice((chain[fails] as string).length);
  return known.there && rest !== "" ? await leadsTo(`${known.to}${rest}`, links, hops + 1) : `${known.to}${rest}`;
}

/**
 * Where a lookup of `spelled` stands at each `..` in it (`places`), and where
 * it ends (`end`, with no `..` left), its links followed as the kernel follows
 * them: folding `link/..` as text would land beside the link, not beside its
 * target. Every part before a `..` is looked up, so whether it is there is an
 * answer, though folding the path drops it. Windows folds `..` away before
 * any lookup.
 */
async function climbedFrom(spelled: string): Promise<{ places: string[]; end: string }> {
  if (process.platform === "win32") return { places: [], end: resolve(spelled) };
  const places: string[] = [];
  let at: string = sep;
  for (const part of spelled.split(sep)) {
    if (part !== "..") {
      at = join(at, part);
      continue;
    }
    places.push(at);
    // A part that is not there does not end the walk: `mkdir -p` makes it,
    // then climbs back out, to its directory as that directory leads.
    const from = at;
    at = await realpath(from).then(dirname, () => realpath(dirname(from)).catch(() => dirname(from)));
  }
  return { places, end: at };
}

/**
 * Distinct places one command may climb out of. Each is judged on its own,
 * which for a 4 KB argument costs milliseconds, so arguments built to climb
 * out of thousands would cost minutes; ordinary ones climb out of a few.
 */
const MAX_CLIMBED_PLACES = 128;

/**
 * `path` without the entries a bare name may not be found through: empty and
 * relative ones, and ones inside any of `protect`, as spelled or where they
 * lead. ponytail: a spelling realpath does not fold (macOS's
 * /System/Volumes/Data, a bind mount) is judged as written; compare
 * identities, as the file runtime does, if a PATH ever spells it that way.
 */
async function searchPath(path: string, protect: string[]): Promise<string> {
  const links = new Map<string, { to: string; there: boolean }>();
  const kept: string[] = [];
  for (const entry of path.split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    const leads = await leadsTo((await climbedFrom(entry)).end, links);
    if (protect.some((root) => inside(root, resolve(entry)) || inside(root, leads))) continue;
    kept.push(entry);
  }
  return kept.join(delimiter);
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
 * Settings that each turn off a whole family of programs git can run while
 * serving a read: hooks (every hook, through one hooks path), signature
 * verifiers (every format's program), and fetching objects a partial clone is
 * missing (every transport, proxy and credential program behind it). Each is a
 * `-c` or an environment variable, so it also reaches any git a read starts in
 * turn, such as a submodule's.
 *
 * ponytail: GIT_NO_LAZY_FETCH needs git 2.45; an older git ignores it.
 */
const GIT_READ_SWITCHES = [
  "-c", "core.fsmonitor=false",
  "-c", `core.hooksPath=${GIT_NULL_CONFIG}`,
  "-c", `gpg.program=${GIT_NULL_CONFIG}`,
  "-c", `gpg.ssh.program=${GIT_NULL_CONFIG}`,
  "-c", `gpg.x509.program=${GIT_NULL_CONFIG}`,
];

/**
 * Policy classifies several `git` subcommands (diff, show, log, status, ...) as
 * approval-free reads, but git runs programs the repository's own config and
 * attributes name while serving one. Those live in the git directory, not in
 * the terminal arguments, so `checkArguments` never sees them, and policy
 * cannot either.
 *
 * The guarantee is that nothing MELRA writes lands in a git directory: the
 * file runtime refuses it (`path_git_metadata`), so only a person approving a
 * command that does so can change what git's config makes it run. This is
 * defence in depth on top: a read-shaped call (subcommand first, as policy
 * requires for a read) spawns with system and global config nulled, the
 * switches above, and external diff and textconv off on the subcommands that
 * emit diffs (the only ones that accept the flags). Mutations — commit, push,
 * or a global option before the subcommand — are left untouched, so a
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
    args: [...GIT_READ_SWITCHES, first, ...diffFlags, ...args.slice(1)],
    env: { GIT_CONFIG_SYSTEM: GIT_NULL_CONFIG, GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG, GIT_NO_LAZY_FETCH: "1" },
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
/** How often a job whose program has exited checks whether its group is empty. */
const GROUP_POLL_MS = 100;

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

/**
 * Whether anything is left in the child's process group. A background job's
 * program can exit and leave what it started running in its group, and that
 * is still the job's. POSIX only: Windows has no groups, and `taskkill /T`
 * cannot find the children of a process that has already exited.
 */
function groupAlive(child: ChildProcess): boolean {
  if (!OWN_GROUP || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    // ESRCH: empty. EPERM: a process we may not signal, which nothing here can stop.
    return false;
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
  /**
   * Set while the program has exited and processes it started are still in
   * its group; gone once the group is empty. Only while it is set is the group
   * signalled: an empty group's id can be reused by an unrelated one.
   */
  watch?: NodeJS.Timeout;
  /**
   * Set once the job's timeout has sent its SIGKILL. Supervision ends there
   * regardless: whatever still answers in the group is a zombie nothing reaps
   * (node as PID 1 in a container without an init) or a process no signal of
   * ours can end, and waiting on it would hold the job, and its slot among
   * MAX_JOBS, for as long as the server runs. Set by the timer itself rather
   * than read off the wall clock, which a sleeping laptop or a clock step
   * moves past a timeout that has not fired.
   */
  expired?: boolean;
}

/** Whether the job's program has exited and left processes in its group. */
function leftBehind(job: BackgroundJob): boolean {
  return job.watch !== undefined && groupAlive(job.child);
}

/**
 * Once a job's program has exited, keeps its timeout on what the program left
 * in its group, until the group is empty.
 */
function releaseWhenEmpty(job: BackgroundJob): void {
  if (!groupAlive(job.child)) {
    clearTimeout(job.timer);
    return;
  }
  job.watch = setInterval(() => {
    if (groupAlive(job.child) && job.expired !== true) return;
    clearTimeout(job.timer);
    clearInterval(job.watch);
    delete job.watch;
  }, GROUP_POLL_MS);
  job.watch.unref();
}

export class TerminalRuntime {
  readonly root: string;
  readonly allowedEnvironment: Set<string>;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  /** The root as policy spelled it, which is what "spelled inside" is measured against. */
  private readonly lexicalRoot: string;
  private readonly reserved: (path: string, call?: object) => Promise<boolean>;
  private readonly holdsReserved: (path: string, call?: object) => Promise<boolean>;
  private readonly confineArguments: boolean;
  /** The protected workspace, as spelled and resolved; absent, PATH is not filtered. */
  private readonly pathOutside: string[] | undefined;
  private readonly jobs = new Map<string, BackgroundJob>();
  private closed = false;

  private constructor(
    options: TerminalRuntimeOptions,
    root: string,
    pathOutside: string[] | undefined,
  ) {
    this.root = root;
    this.pathOutside = pathOutside;
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
    const outside = options.pathOutside;
    return new TerminalRuntime(
      options,
      await realpath(options.root),
      outside === undefined ? undefined : [resolve(outside), await realpath(outside).catch(() => resolve(outside))],
    );
  }

  private async resolveCwd(cwd: string | undefined, call: object): Promise<string> {
    const spelled = cwd !== undefined && isAbsolute(cwd) ? resolve(cwd) : undefined;
    const input =
      spelled !== undefined && inside(this.lexicalRoot, spelled)
        ? resolve(this.root, relative(this.lexicalRoot, spelled))
        : cwd ?? ".";
    const candidate = resolve(this.root, input);
    if (!inside(this.root, candidate)) throw new Error("cwd_outside_workspace");
    // Before the lookup, so a reserved name gets the same answer whether it
    // exists or not.
    if (await this.reserved(candidate, call)) throw new Error("terminal_path_reserved");
    const actual = await realpath(candidate);
    if (!inside(this.root, actual)) throw new Error("cwd_outside_workspace");
    return actual;
  }

  private async checkArguments(operation: TerminalOperation, cwd: string, call: object): Promise<void> {
    const lexicalCwd = resolve(this.lexicalRoot, operation.cwd ?? ".");
    // A path-qualified program is whatever file sits at that path, so only a
    // bare name is taken at its word.
    const command = operation.command ?? "";
    const listsNames =
      !/[\\/]/.test(command) &&
      NAME_LISTERS.has(command.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, ""));
    const climbed = new Set<string>();
    const confined = new Set<string>();
    const links = new Map<string, { to: string; there: boolean }>();
    const judged = [
      ...[".", ...terminalArgumentPaths(operation.args)].map((path) => ({ path, reference: false })),
      // A reference names one file to read, never a directory to walk, so only
      // that file is judged: `rg "@/" src` searches for text.
      ...terminalArgumentReferences(operation.args).map((path) => ({ path, reference: true })),
    ];
    // ponytail: a program's own path syntax (git's `:/x`, `:(top)x`) is judged as a plain path.
    for (const { path, reference } of judged) {
      // Unnormalised: the program resolves `link/..` through the link.
      const spelled = isAbsolute(path) ? path : `${cwd}${sep}${path}`;
      const { places, end } = await climbedFrom(spelled);
      for (const place of places) {
        if (climbed.has(place)) continue;
        climbed.add(place);
        if (climbed.size > MAX_CLIMBED_PLACES) throw new Error("terminal_path_too_complex");
        if (await this.reserved(place, call)) throw new Error("terminal_path_reserved");
      }
      const real = await leadsTo(end, links);
      // Some programs fold `..` as text first (git pathspecs, path.resolve),
      // so the argument is judged where that leads too.
      const folded = resolve(cwd, path);
      // findstr and where expand their own wildcards, reading the directory.
      const probes = [...new Set([real, folded])].flatMap((at) => (/[*?]/.test(path) ? [at, dirname(at)] : [at]));
      // Each refuses the same way, so they are asked together.
      const answers = await Promise.all(
        probes.flatMap((probe) => [
          this.reserved(probe, call),
          ...(listsNames || reference ? [] : [this.holdsReserved(probe, call)]),
        ]),
      );
      if (answers.some(Boolean)) throw new Error("terminal_path_reserved");
      // After the reserved checks, so a reserved path gets that refusal.
      if (!this.confineArguments || !inside(this.lexicalRoot, resolve(lexicalCwd, path))) continue;
      // `mkdir -p` makes each place it climbs out of, not only where it ends.
      for (const place of places) {
        if (confined.has(place)) continue;
        confined.add(place);
        if (!inside(this.root, await leadsTo(place, links))) throw new Error("terminal_path_outside_workspace");
      }
      if (!inside(this.root, real)) throw new Error("terminal_path_outside_workspace");
      // Folded as text from where it runs, too: a cwd through a link can stand
      // at another depth than the one it is spelled at.
      if (folded !== end && !inside(this.root, await leadsTo(folded, links))) {
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
    // One per command, for every check below and no later one: see `reserved`.
    const call = {};
    const cwd = await this.resolveCwd(operation.cwd, call);
    // Before the program is looked up, so a refusal never depends on whether
    // it is installed.
    await this.checkArguments(operation, cwd, call);
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
    if (this.pathOutside !== undefined) {
      // Before the lookup, and for the spawn, so the program's own lookups get
      // the same PATH, under every name Windows may spell it.
      const names = Object.keys(environment).filter((key) => key.toUpperCase() === "PATH");
      // An empty PATH searches the working directory again, and so can none
      // at all: a shell fills in a default (macOS sh ends it in `.`). So a
      // path-qualified program is refused too, by a cause the operator can see.
      if (names.length === 0) throw new Error("terminal_path_empty_after_filter");
      for (const name of names) {
        const kept = await searchPath(environment[name] ?? "", this.pathOutside);
        if (kept === "") throw new Error("terminal_path_empty_after_filter");
        environment[name] = kept;
      }
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
        // Already exited, with only its pipes left to drain: it finished.
        if (child.exitCode !== null || child.signalCode !== null) return;
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
        // Stopped by its own timeout, as by a cancel, it may well have done
        // its work first: not "it did not happen". Reads are exempt upstream.
        if (timedOut) {
          reject(outcomeUnknown(`terminal_timeout:${prepared.timeoutMs}ms`));
          return;
        }
        resolvePromise({
          command: prepared.command,
          args: prepared.args,
          cwd: relative(this.root, prepared.cwd) || ".",
          exitCode: code,
          signal: terminationSignal,
          stdout: redactTerminalOutput(stdout),
          stderr: redactTerminalOutput(stderr),
          truncated,
          success: code === 0,
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
      // Not one whose program left processes behind: they would go unsupervised.
      const finished = [...this.jobs.values()].find(
        (candidate) => candidate.endedAt !== undefined && !leftBehind(candidate),
      );
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
    const timer = setTimeout(() => {
      signalTree(child, "SIGTERM");
      setTimeout(() => {
        signalTree(child, "SIGKILL");
        job.expired = true;
      }, KILL_GRACE_MS).unref();
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
      // After close() the job is no longer ours to watch: close() has already
      // stopped what it could and waited for it.
      if (this.closed) clearTimeout(timer);
      else releaseWhenEmpty(job);
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
    // Exited counts, not only closed: Node destroys stdin on exit, and the
    // close waits for anything the program started that holds its output.
    if (job.endedAt !== undefined || job.child.exitCode !== null || job.child.signalCode !== null) {
      throw new Error("terminal_job_not_running");
    }
    const stdin = job.child.stdin;
    // Before the test below: a failed write marks the pipe errored at once and
    // is heard a tick later, and either way a job whose reader went away was
    // reported as not interactive.
    if (job.stdinError !== undefined || (stdin?.errored ?? null) !== null) {
      throw new Error("terminal_job_stdin_closed");
    }
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
    // A write to a pipe whose reader closed fails on the spot (on POSIX), so
    // it was not sent, whatever the error event later says.
    if (stdin.errored !== null) throw new Error("terminal_job_stdin_closed");
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
        // Its program may have exited and left processes in its group.
        if (job.endedAt === undefined || leftBehind(job)) stopTree(job.child, CLOSE_GRACE_MS);
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
    this.closed = true;
    const exits = [...this.jobs.values()].map(async (job) => {
      clearTimeout(job.timer);
      // Exited, but what it started may still be running in its group.
      const left = leftBehind(job);
      clearInterval(job.watch);
      if (job.endedAt !== undefined && !left) return;
      const exited =
        job.endedAt === undefined
          ? new Promise<void>((done) => job.child.once("close", () => done()))
          : Promise.resolve();
      // A child is free to trap SIGTERM, and shutdown blocking forever on one
      // that does is worse than the race this replaced.
      const escalation = stopTree(job.child, CLOSE_GRACE_MS);
      // Monotonic: a clock step must not cut the wait short and cancel the
      // SIGKILL still owed to something that ignored SIGTERM.
      const deadline = performance.now() + CLOSE_GRACE_MS + 1_000;
      await exited;
      // The rest of the group gets SIGKILL with the program; a process that
      // outlasts even that (uninterruptible, or not ours to signal) is not
      // waited on past the deadline.
      while (groupAlive(job.child) && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
      }
      clearTimeout(escalation);
    });
    this.jobs.clear();
    await Promise.all(exits);
  }
}
