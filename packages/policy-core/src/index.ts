// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { evidenceStrength } from "@melra/receipt-schema";
import { hostOf } from "./network-policy.js";
import type {
  ApprovalChallenge,
  ApprovalResponse,
  CapabilityGrant,
  CapabilityTrait,
  CredentialDefinition,
  DeploymentMode,
  Effect,
  EvidencePredicate,
  HttpOperation,
  Identity,
  Operation,
  PolicyDecision,
  PolicyFileInput,
  Risk,
  TaskRequest,
} from "@melra/protocol";
import {
  deploymentMode,
  LOCAL_IDENTITY,
  PolicyFileSchema,
  principalRef,
  terminalArgumentPaths,
} from "@melra/protocol";

export interface LocalPolicy {
  version: string;
  workspaceRoot: string;
  allowedCommands: string[];
  allowedDomains: string[];
  allowLocalhost: boolean;
  /**
   * What to do with a window a page opens by itself.
   *
   * `"block"` closes it and reports it on the action that provoked it, which is
   * the honest default for an unattended agent: a popup nobody asked for is the
   * page deciding what the caller looks at next. `"allow"` keeps it as an
   * addressable tab. Either way it is reported — this governs whether it stays,
   * not whether the caller is told. `assertSafeUrl` still governs where it may
   * load from.
   */
  popups: "allow" | "block";
  mutations: "deny" | "confirm";
  /**
   * How long an approval challenge stays open, and a recorded decision usable.
   * Absent, it follows the mode (`approvalTtl`): an operator approving out of
   * band in enforced mode needs longer than someone answering in the chat.
   * It also bounds how long a semantic judgement waits (#54).
   */
  approvalTtlMs?: number;
  maxFileBytes: number;
  /**
   * How long unreachable memory rows are kept before compaction reclaims them,
   * and an optional hard ceiling on live memories per scope.
   *
   * `maxPerScope: 0` means no ceiling, which is the default: evicting a live
   * memory throws away something the caller stored and can still read, so it
   * is opt-in. Expired and superseded rows are reclaimed regardless — no read
   * path can return them.
   */
  memoryRetention: { maxAgeDays: number; maxPerScope: number };
  /**
   * Traits an operation may not carry. Empty by default — the shipped policy
   * still confirms every mutation, so nothing runs unattended, and denying
   * installs or the network outright is a choice only some installs want.
   *
   * `["package-install"]` lets a task run `npm test` but not `npm install`,
   * which `allowedCommands` cannot express because it matches on the basename.
   * `["network"]` refuses anything that reaches another host, browsing
   * included.
   */
  deniedTraits: CapabilityTrait[];
  /**
   * Bounded authority the operator has issued, matched against the effect and
   * the immediate principal before any allowlist is consulted.
   *
   * Empty by default, which means no capability narrowing: policy behaves as it
   * always has. A non-empty list is a closed world — an effect with no matching
   * grant is denied with `capability_not_granted`. This is how a caller ends up
   * holding authority over one directory rather than over the whole workspace.
   */
  capabilities: CapabilityGrant[];
  /**
   * Secrets the kernel injects on the caller's behalf, keyed by a name the
   * caller may see in a receipt. Empty by default.
   *
   * The agent never holds one. It names an operation; if a definition's `hosts`
   * cover the destination *and* its `capability` covers the operation, the
   * kernel reads the secret at send time and puts it on the wire. See
   * `CredentialBroker` for why those two lists behave differently on a miss.
   */
  credentials: Record<string, CredentialDefinition>;
  /**
   * Stops a task from re-running an operation whose target keeps failing.
   *
   * A retry inside one task only covers a transient blip; nothing carried the
   * knowledge that the last three tasks against this same file, host, or command
   * all failed, so a workflow would keep spending its budget rediscovering it.
   * After `threshold` consecutive failures against one target, the next task
   * touching it fails immediately with `circuit_open:<target>` until
   * `cooldownMs` has passed; the first task after the cooldown is the trial, and
   * one success clears the count. `threshold: 0` switches it off.
   */
  circuitBreaker: { threshold: number; cooldownMs: number };
  /**
   * Switches off every guardrail this policy exists to apply: allowlists,
   * evidence requirements, approval challenges, and — through the runtimes
   * constructed from this policy — workspace confinement and the browser's
   * private-destination block.
   *
   * Off unless the operator asks for it twice, once through `MELRA_UNHINGED=1`
   * or `--unhinged` and once by accepting the banner the CLI prints. Nothing
   * derives it from another setting.
   */
  unhinged: boolean;
  /**
   * How this kernel is deployed, and therefore what it refuses about its own
   * setup rather than about a caller's request.
   *
   * `developer` is the default and changes nothing: MELRA governs the effects it
   * is asked for, and the operator accepts that the harness may have another way
   * to the same disk. `enforced` is the operator asserting there is no other way
   * — the harness is sandboxed, holds no privileged secrets, and reaches systems
   * only through here. MELRA cannot verify that assertion, so what it does
   * instead is remove every door it owns that would contradict it: no
   * `--unsafe-local`, no bind outside loopback, no client registering itself.
   *
   * Named on every receipt, because "was this effect governed by the only door
   * or by one of several" is not something an auditor should have to infer.
   */
  mode: DeploymentMode;
}

// The file and the policy it becomes name the same keys, checked both ways at
// compile time: a key added to one alone is a type error naming it, rather than
// one the file refuses or one it can never set.
type NoKeys<Keys extends never> = Keys;
type _PolicyFileKeysMatch = [
  NoKeys<Exclude<keyof LocalPolicy, keyof PolicyFileInput>>,
  NoKeys<Exclude<keyof PolicyFileInput, keyof LocalPolicy>>,
];

export interface PolicyEvaluation {
  decision: PolicyDecision;
  challenge?: ApprovalChallenge;
  /**
   * The grant that authorised this, when `policy.capabilities` is non-empty.
   * What the commit meters against — absent means no grants are configured and
   * there is nothing to draw down.
   */
  grantId?: string;
}

const READ_ONLY_GIT_ACTIONS = new Set([
  "branch",
  "diff",
  "log",
  "rev-parse",
  "show",
  "status",
  "tag",
]);

const ALWAYS_DENIED_COMMANDS = new Set([
  "bash",
  "cmd",
  "fish",
  "osascript",
  "powershell",
  "pwsh",
  "sh",
  "sudo",
  "su",
  "zsh",
]);

/**
 * Defaults tuned so a fresh install is usable without editing `policy.json`.
 *
 * `allowedDomains: ["*"]` is not the SSRF boundary and never was. `assertSafeUrl`
 * in `./network-policy.js` independently rejects non-http(s) protocols, URL
 * credentials, private ranges, and cloud metadata (169.254/16), and it resolves
 * DNS before allowing a navigation so a public name cannot be rebound to a
 * private address. The domain list is a *narrowing* control on top of that guard,
 * for operators who want to restrict which public sites are reachable — it is not
 * what stops a browser or an HTTP call from reaching the loopback interface.
 *
 * Defaulting it to `[]` made every single navigation fail with
 * `destination_domain_not_allowed` out of the box, which is why browser use was
 * reported as unusable. Operators who want an allowlist set one explicitly.
 */
/**
 * Reduce a command to the name the allowlist is written in.
 *
 * On Windows an executable is spelled with an extension (`npm.cmd`, `node.exe`,
 * `git.exe`), while allowlists are written bare. Comparing the raw basename made
 * every extension-qualified spelling fail, so Windows users had no working
 * spelling at all: bare `npm` passed policy but is a `.cmd` shim that does not
 * spawn, and `npm.cmd` spawns but was denied. Only the executable suffixes in
 * PATHEXT are stripped, so a command that merely contains a dot (`python3.11`)
 * is left intact.
 */
const EXECUTABLE_SUFFIXES = [".exe", ".cmd", ".bat", ".com", ".ps1"];

export function normalizeCommandName(command: string): string {
  const name = basename(command.replaceAll("\\", "/")).toLowerCase();
  const suffix = EXECUTABLE_SUFFIXES.find((item) => name.endsWith(item));
  return suffix === undefined ? name : name.slice(0, -suffix.length);
}

/**
 * What an operation does beyond changing local state, named so a policy can
 * refuse it.
 *
 * `effect` answers "does this write" and `risk` answers "how badly could it
 * go", but neither distinguishes `npm test` from `npm install left-pad`, and
 * `allowedCommands` matches on the basename so it cannot either. An operator
 * who wants a package manager for its scripts but not for fetching code from
 * a registry had no way to say so. Traits are that missing axis.
 *
 * - `package-install` — resolves and installs third-party code, which is the
 *   one terminal action that can add executable content the operator never
 *   reviewed.
 * - `network` — reaches a host outside this machine. Browser navigation
 *   carries it too, because it is true: `deniedTraits: ["network"]` means no
 *   network at all, not "no network except the browser".
 */
export type { CapabilityTrait } from "@melra/protocol";

export {
  CredentialBroker,
  type BrokeredHeaders,
} from "./credentials.js";

/**
 * Subcommands that install, per package manager, and the ones that only read.
 *
 * Anything unlisted falls in between: a mutation, but not an install — `npm
 * run build` writes to the workspace and reaches nothing.
 *
 * Only npm has reads. Every other manager checked has a way for a "read" to
 * run code or write, through its own options or a file a cloned repository
 * carries: pnpm runs .pnpmfile.cjs and yarn its `yarnPath` on every command;
 * go switches to the toolchain go.mod names and rustup to the one
 * rust-toolchain.toml names, downloading and running it; `pip --python` runs
 * that interpreter and `--log` writes anywhere; `gem --config-file` loads
 * plugins; `brew outdated` updates Homebrew; `apt -o` sets hooks that run shell
 * commands; uv and cargo write their lockfiles. A read skips approval, so it
 * has to be one for every argument and every repository.
 */
const PACKAGE_MANAGERS: Record<
  string,
  { install: Set<string>; read?: Set<string> }
> = {
  npm: {
    install: new Set(["install", "i", "add", "ci", "update", "up", "publish"]),
    // `config` is a read only as `config get`/`config list`; see readOnlyCall.
    read: new Set(["ls", "list", "view", "info", "outdated", "why", "config"]),
  },
  pnpm: { install: new Set(["install", "i", "add", "update", "up", "publish", "dlx"]) },
  yarn: { install: new Set(["install", "add", "up", "upgrade", "publish", "dlx"]) },
  pip: { install: new Set(["install", "download", "wheel"]) },
  pip3: { install: new Set(["install", "download", "wheel"]) },
  uv: { install: new Set(["add", "sync", "install", "pip", "tool", "publish"]) },
  cargo: { install: new Set(["install", "add", "update", "publish", "fetch"]) },
  gem: { install: new Set(["install", "update", "push"]) },
  brew: { install: new Set(["install", "upgrade", "reinstall", "tap"]) },
  apt: { install: new Set(["install", "upgrade", "full-upgrade", "update"]) },
  "apt-get": { install: new Set(["install", "upgrade", "dist-upgrade", "update"]) },
  go: { install: new Set(["install", "get", "mod"]) },
};

/** `npx`/`pnpx` fetch and execute a package by name; there is no read form. */
const ALWAYS_INSTALLING = new Set(["npx", "pnpx", "uvx", "pipx"]);

/** Programs whose whole purpose is to talk to another host. */
const NETWORK_COMMANDS = new Set([
  "curl",
  "wget",
  "scp",
  "sftp",
  "ssh",
  "rsync",
  "nc",
  "ncat",
  "telnet",
  "ftp",
]);

/** `git` subcommands that contact a remote. */
const NETWORK_GIT_ACTIONS = new Set([
  "clone",
  "fetch",
  "pull",
  "push",
  "submodule",
  "ls-remote",
]);

/**
 * Flags that take their value as the next argument, so that argument is not
 * the subcommand. `git -c core.pager=cat push` pushes; a naive "first
 * non-flag" scan reads `core.pager=cat` as the subcommand and calls it local.
 *
 * The list is short on purpose: it covers the value-taking flags of the
 * commands this module classifies. An unlisted one costs an unrecognised
 * subcommand, which falls back to `mutate`/`medium` — the cautious answer.
 */
const VALUE_TAKING_FLAGS = new Set([
  "-c",
  "-C",
  "--config",
  "--cwd",
  "--dir",
  "--prefix",
  "--workspace",
  "-w",
  "--filter",
  "--registry",
]);

function subcommandOf(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (VALUE_TAKING_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    // `--filter=foo` carries its value inline, so nothing is skipped.
    if (arg.startsWith("-")) continue;
    return arg.toLowerCase();
  }
  return undefined;
}

/**
 * Classify a terminal command by what it does, not just by its name.
 *
 * Exported because the accurate answer is worth having outside policy — the
 * CLI's `policy test` prints it, and it is the only place `npm ls` and `npm
 * install` are told apart.
 */
export function classifyCommand(
  command: string,
  args: readonly string[],
): { read: boolean; traits: CapabilityTrait[] } {
  const name = normalizeCommandName(command);
  const subcommand = subcommandOf(args);
  const traits = new Set<CapabilityTrait>();

  if (NETWORK_COMMANDS.has(name)) traits.add("network");
  if (name === "git" && subcommand !== undefined && NETWORK_GIT_ACTIONS.has(subcommand)) {
    traits.add("network");
  }
  if (ALWAYS_INSTALLING.has(name)) {
    traits.add("package-install");
    traits.add("network");
  }

  const manager = PACKAGE_MANAGERS[name];
  if (manager !== undefined && subcommand !== undefined) {
    if (manager.install.has(subcommand)) {
      traits.add("package-install");
      traits.add("network");
    }
    if (manager.read?.has(subcommand) === true && readOnlyCall(command, name, subcommand, args)) {
      // A read subcommand of a package manager still queries the registry in
      // the general case, so it keeps `network` while dropping the mutation.
      return { read: true, traits: [...traits, "network"] };
    }
  }

  const READ_COMMANDS = new Set([
    "cat",
    "findstr",
    "head",
    "ls",
    "pwd",
    "rg",
    "tail",
    "tasklist",
    "wc",
    "where",
  ]);
  const read =
    (READ_COMMANDS.has(name) || name === "git") &&
    readOnlyCall(command, name, subcommand, args);
  return { read, traits: [...traits] };
}

/**
 * Whether a call to a read-classified program is still only a read once its
 * arguments are taken into account.
 *
 * A read is the one classification that skips approval, so it is a positive
 * claim that has to hold for the whole argument list, not just the program
 * name or subcommand. Before this, `git -c core.fsmonitor=<cmd> status` and
 * `rg --pre <cmd>` ran commands, `git log --output=<path>` wrote anywhere,
 * `git branch -D` deleted refs, and `npm config set` rewrote configuration,
 * all classified as reads and run with no approval. Anything not proven
 * harmless here falls back to a mutation, which needs approval: the cautious
 * answer, at the cost of an approval for an unusual but harmless spelling.
 *
 * Reading outside the workspace through these tools stays a developer-mode
 * residual. Enforced mode asks a person first (`read_outside_workspace`), and
 * the terminal runtime refuses MELRA's own files in every mode.
 */
function readOnlyCall(
  command: string,
  name: string,
  subcommand: string | undefined,
  args: readonly string[],
): boolean {
  // A path-qualified program is whatever file sits at that path, which the
  // name says nothing about: `tools/ls` can be a link to `/bin/sh`.
  if (/[\\/]/.test(command)) return false;
  if (args.some(namesNetworkPath)) return false;
  if (name === "git") return gitReadOnly(args);
  if (name === "rg") return !args.some(rgRunsOrDecompresses);
  // `/D:` and `/F:` take the directories and files to search from a list no
  // argument shows, and `--files0-from` the files to count.
  if (name === "findstr" && args.some((arg) => /^[-/][df]:/i.test(arg))) return false;
  if (name === "wc" && args.some((arg) => /^--files0-from(=|$)/.test(arg))) return false;
  // `/s <computer>` queries another machine, as the logged-on user.
  if (name === "tasklist") return !args.some((arg) => /^[-/][sup](:|$)/i.test(arg));
  // `--logs-dir <path>` creates that directory and writes npm's log into it.
  if (name === "npm" && args.some((arg) => /^--logs-dir(=|$)/i.test(arg))) return false;
  if (subcommand === "config" && PACKAGE_MANAGERS[name] !== undefined) {
    const action = args[args.findIndex((arg) => arg.toLowerCase() === "config") + 1];
    return action !== undefined && ["get", "list", "ls"].includes(action.toLowerCase());
  }
  return true;
}

/**
 * A Windows UNC or device path (`\\host\share`, `//host/share`, `\\?\UNC\...`,
 * `\??\UNC\...`), alone or inside an option (`--file=`, `/G:`, `-f\\host`).
 * Opening one connects to that host over SMB or WebDAV and authenticates as the
 * logged-on user, so a "read" of it sends the user's credentials to whoever the
 * caller named. Two separators in a row anywhere count, which also catches a
 * URL in a search pattern (`rg https://x`); that then needs approval, the
 * cautious side.
 */
function namesNetworkPath(arg: string): boolean {
  return /[\\/]{2}/.test(arg) || arg.includes("\\??\\");
}

/**
 * `--pre <cmd>` and `--hostname-bin <cmd>` run programs; `-z` runs
 * decompressors; `-L`/`--follow` follow links to files no argument names, the
 * data directory included.
 */
function rgRunsOrDecompresses(arg: string): boolean {
  if (/^--(pre|pre-glob|hostname-bin|search-zip|follow)(=|$)/i.test(arg)) return true;
  return /^-[^-]/.test(arg) && /[zL]/.test(arg.slice(1));
}

/**
 * Whether a terminal command names a path outside the workspace, by spelling.
 * Links are the runtime's half, and so are file references (`@x`): no read
 * this judges takes one, and a program that does is not a read.
 */
function namesPathOutside(operation: Operation, root: string): boolean {
  if (operation.kind !== "terminal") return false;
  const cwd = resolve(root, operation.cwd ?? ".");
  return terminalArgumentPaths(operation.args).some((path) => {
    // A bare switch (`/S`, `/I`, `/?`) is not a path on Windows. One with a
    // value attached (`/G:x`) still has that value judged.
    if (process.platform === "win32" && /^\/[a-z?]+$/i.test(path)) return false;
    const rel = relative(root, resolve(cwd, path));
    return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  });
}

/** `diff`/`log`/`show` options that write files, run configured programs, or leave the repository. */
const GIT_UNSAFE_OPTION = /^--(output|ext-diff|textconv|no-index|exec|upload-pack|receive-pack)(=|$)/i;

/**
 * Options of `git branch` and `git tag` that only list. Any other option
 * creates, moves, deletes, or signs. `--color`, `--column` and `--abbrev` take
 * a value only when it is attached (`--color=always`): git reads
 * `--color -D x` as two options and a name, so the next argument is never theirs.
 */
const GIT_LISTING_FLAGS = new Set([
  "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "-n", "-i",
  "--ignore-case", "--show-current", "--color", "--no-color", "--column",
  "--no-column", "--abbrev", "--no-abbrev", "--omit-empty",
]);
/**
 * Listing options that take a value. Unless it is attached, git takes the next
 * argument as the value whatever it looks like (`--contains -D` asks about a
 * commit named `-D`); only as the last argument does `--contains` and the like
 * default to HEAD.
 */
const GIT_LISTING_VALUE_FLAGS = new Set([
  "--sort", "--format", "--contains", "--no-contains", "--merged", "--no-merged",
  "--points-at",
]);

function gitReadOnly(args: readonly string[]): boolean {
  // Global options (`-c`, `-C`, `--exec-path`, `--git-dir`, ...) come before
  // the subcommand and change what any subcommand does, so a read is only a
  // call that names the subcommand first.
  const [first, ...rest] = args;
  if (first === undefined || first.startsWith("-")) return false;
  const subcommand = first.toLowerCase();
  if (!READ_ONLY_GIT_ACTIONS.has(subcommand)) return false;
  if (rest.some((arg) => GIT_UNSAFE_OPTION.test(arg))) return false;
  if (subcommand !== "branch" && subcommand !== "tag") return true;
  // `git branch x` and `git tag v1` create; listing is the read. Arguments are
  // split the way git's option parser splits them, and only then is a name
  // allowed, as a pattern under `-l`/`--list`. Deciding "listing" from the raw
  // list let `--format -l x` through: git takes `-l` as the format and creates x.
  //
  // `git tag -l` has always listed, but `git branch -l` meant --create-reflog
  // before git 2.20 (Ubuntu 18.04 ships 2.17), so there `-l x` creates x. Only
  // `--list` turns on listing for a branch name; a bare `-l` with no name is a
  // listing either way.
  let listing = false;
  let names = 0;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (arg === "--list" || (arg === "-l" && subcommand === "tag")) listing = true;
    else if (arg === "-l" || GIT_LISTING_FLAGS.has(arg) || /^-n\d+$/.test(arg)) continue;
    else if (equals !== -1 && /^--(color|column|abbrev)$/.test(flag)) continue;
    else if (GIT_LISTING_VALUE_FLAGS.has(flag)) {
      if (equals === -1) index += 1;
    } else if (arg.startsWith("-")) return false;
    else names += 1;
  }
  return listing || names === 0;
}

export function createDefaultPolicy(workspaceRoot: string): LocalPolicy {
  return {
    version: "1",
    workspaceRoot: resolve(workspaceRoot),
    // One list for every platform. An entry naming a program the host does not
    // have is inert — it fails at spawn with `terminal_command_not_found`, not
    // at policy — so the Windows and POSIX read tools can both sit here rather
    // than making the same policy mean different things on different machines.
    allowedCommands: [
      "cat",
      "echo",
      "findstr",
      "git",
      "head",
      "ls",
      "node",
      "npm",
      "npx",
      "pnpm",
      "pwd",
      "rg",
      "tail",
      "tasklist",
      "wc",
      "where",
    ],
    allowedDomains: ["*"],
    allowLocalhost: true,
    popups: "block",
    mutations: "confirm",
    maxFileBytes: 10 * 1024 * 1024,
    memoryRetention: { maxAgeDays: 30, maxPerScope: 0 },
    deniedTraits: [],
    capabilities: [],
    credentials: {},
    circuitBreaker: { threshold: 3, cooldownMs: 60_000 },
    unhinged: false,
    mode: "developer",
  };
}

/** The approval window a policy gives: its own, or 5 minutes in developer mode and 30 in enforced. */
export function approvalTtl(policy: Pick<LocalPolicy, "approvalTtlMs" | "mode">): number {
  return policy.approvalTtlMs ?? (policy.mode === "enforced" ? 30 * 60_000 : 5 * 60_000);
}

export async function loadPolicy(
  path: string | undefined,
  workspaceRoot: string,
): Promise<LocalPolicy> {
  const defaults = createDefaultPolicy(workspaceRoot);
  if (path === undefined) return defaults;
  const text = await readFile(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Where, never what: V8 quotes the text around the error, and a file that
    // holds a token would put it in `doctor --json`, `status` and every bug
    // report the message is pasted into. A V8 that gives no position gets none.
    const position = /at position (\d+)/.exec(error.message)?.[1];
    const before = position === undefined ? undefined : text.slice(0, Number(position));
    throw new Error(
      `policy_invalid: ${path}: not valid JSON${
        before === undefined
          ? ""
          : ` at line ${before.split("\n").length} column ${before.length - before.lastIndexOf("\n")}`
      }`,
    );
  }
  // Every problem at once, each by its path, so one edit fixes the file.
  const result = PolicyFileSchema.safeParse(raw);
  if (!result.success) {
    // A record key that is not an identifier goes in brackets, so
    // `credentials["a.b"]` cannot read as a key `b` inside `a`.
    const at = (segments: readonly PropertyKey[]) =>
      segments
        .map((segment) =>
          typeof segment === "string" && /^[A-Za-z_$][\w$]*$/.test(segment)
            ? `.${segment}`
            : `[${typeof segment === "number" ? segment : JSON.stringify(String(segment))}]`,
        )
        .join("")
        .replace(/^\./, "") || "(root)";
    const problems = result.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => `${at([...issue.path, key])}: unknown key`)
        : [`${at(issue.path)}: ${issue.message}`],
    );
    throw new Error(`policy_invalid: ${path}: ${problems.join("; ")}`);
  }
  const parsed = result.data;
  return {
    ...defaults,
    ...parsed,
    // A relative root is relative to the file, not to whatever directory the
    // server happened to start in: Claude Desktop starts servers in `/`.
    workspaceRoot:
      parsed.workspaceRoot === undefined
        ? resolve(workspaceRoot)
        : resolve(dirname(path), parsed.workspaceRoot),
    allowedCommands: parsed.allowedCommands ?? defaults.allowedCommands,
    allowedDomains: parsed.allowedDomains ?? defaults.allowedDomains,
    // Spread, not replace: a file naming only `maxPerScope` should not silently
    // drop `maxAgeDays` to `undefined` and make compaction delete everything.
    memoryRetention: { ...defaults.memoryRetention, ...parsed.memoryRetention },
    circuitBreaker: { ...defaults.circuitBreaker, ...parsed.circuitBreaker },
    deniedTraits: parsed.deniedTraits ?? defaults.deniedTraits,
    // Through `PolicyFileSchema`, never spread raw: a grant is the file claiming
    // authority exists, and a malformed grant or credential definition must
    // fail loudly rather than land as an object that matches nothing or — worse
    // — everything.
    capabilities: parsed.capabilities ?? defaults.capabilities,
    credentials: parsed.credentials ?? defaults.credentials,
    // Through the same parser the environment variable and the flag go through,
    // so `"mode": "enfroced"` in a policy file fails loudly instead of leaving a
    // machine in developer mode with a file that claims otherwise.
    mode: deploymentMode(parsed.mode),
  };
}

export function classifyOperation(operation: Operation): {
  effect: Effect;
  risk: Risk;
  capability: string;
  target: string;
  traits: CapabilityTrait[];
  /** What the caller declared this operation moves, when it declared one. */
  spend?: DeclaredSpend;
  /** Where a move puts the file; a grant has to cover it as well as `target`. */
  destination?: string;
} {
  switch (operation.kind) {
    case "file": {
      const read = new Set(["list", "read", "stat", "hash"]).has(operation.action);
      const destructive = operation.action === "delete";
      return {
        effect: destructive ? "destructive" : read ? "read" : "mutate",
        risk: destructive ? "high" : read ? "low" : "medium",
        capability: `file.${operation.action}`,
        target: grantPath(operation.path),
        ...(operation.action === "move" && operation.destination !== undefined
          ? { destination: grantPath(operation.destination) }
          : {}),
        traits: [],
      };
    }
    case "terminal": {
      if (operation.action === "status" || operation.action === "output") {
        return {
          effect: "read",
          risk: "low",
          capability: `terminal.${operation.action}`,
          target: `job:${operation.jobId ?? "unknown"}`,
          traits: [],
        };
      }
      // `send` writes to a running process's stdin. It carries no command of
      // its own, so it cannot be classified by one: whatever the input does is
      // the already-approved job's doing, and answering a prompt is a mutation.
      if (operation.action === "send") {
        return {
          effect: "mutate",
          risk: "medium",
          capability: "terminal.send",
          target: `job:${operation.jobId ?? "unknown"}`,
          traits: [],
        };
      }
      const command = normalizeCommandName(operation.command ?? "");
      const { read, traits } = classifyCommand(
        operation.command ?? "",
        operation.args,
      );
      return {
        effect: read ? "read" : "mutate",
        // Installing third-party code is the high-risk case, not the package
        // manager's name: `npm run build` is an ordinary mutation and `npm ls`
        // is a read, which the old blanket rule called high-risk alongside it.
        risk: traits.includes("package-install")
          ? "high"
          : read
            ? "low"
            : "medium",
        capability: `terminal.${operation.action}`,
        target:
          operation.action === "stop"
            ? `job:${operation.jobId ?? "unknown"}`
            : `command:${command}`,
        traits,
      };
    }
    case "browser": {
      // Navigation and observation read the world; only actions that drive the
      // page (click, type, upload, ...) change anything. `tab_new` and
      // `tab_switch` are classified with `navigate` for the same reason it is:
      // they move where we are looking, they do not act on a document. `wait`
      // joins them — it blocks until the page reaches a state, and blocking is
      // not acting.
      const read = new Set([
        "navigate",
        "back",
        "forward",
        "reload",
        "inspect",
        "wait",
        "screenshot",
        "tabs",
        "tab_new",
        "tab_switch",
        "scroll",
      ]).has(operation.action);
      return {
        effect: read ? "read" : "mutate",
        risk: read ? "low" : "medium",
        capability: `browser.${operation.action}`,
        target:
          operation.url === undefined
            ? operation.target?.selector ??
              operation.target?.name ??
              "active-page"
            : (() => {
                const target = new URL(operation.url);
                target.search = "";
                target.hash = "";
                return target.toString();
              })(),
        // Driving a page is a network act whether or not the caller named a
        // URL: a click can fetch, and a stale tab is still a live connection.
        traits: ["network"],
      };
    }
    case "memory": {
      const read = operation.action === "search" || operation.action === "list";
      const destructive = operation.action === "delete" || operation.action === "clear";
      return {
        effect: destructive ? "destructive" : read ? "read" : "mutate",
        risk: destructive ? "high" : read ? "low" : "medium",
        capability: `memory.${operation.action}`,
        target: `${operation.scope}:${operation.action}:${
          operation.id ?? operation.key ?? "*"
        }`,
        traits: [],
      };
    }
    case "computer": {
      const read =
        operation.action === "capabilities" ||
        operation.action === "inspect" ||
        operation.action === "screenshot";
      const positional =
        operation.action === "click" ||
        operation.action === "move" ||
        operation.action === "drag";
      return {
        effect: read ? "read" : "mutate",
        risk: read ? "low" : "high",
        capability: `computer.${operation.action}`,
        // A named target is what the caller asked for, so it is what a
        // capability pattern gets to match. Reporting the pixel it resolves to
        // would name a coordinate the caller never wrote, and the resolution
        // happens after policy anyway.
        target: operation.target
          ? `element:${operation.target.role ?? "*"}:${operation.target.name ?? "*"}`
          : positional
            ? `${operation.coordinateSpace}:${operation.x ?? "?"},${operation.y ?? "?"}`
            : "active-desktop",
        traits: [],
      };
    }
    case "http": {
      // The method is the classification. A GET that a server treats as a write
      // is that server misusing HTTP, and MELRA cannot see it — which is why a
      // read still gets no approval but also no retry-into-a-duplicate: the
      // guarantee comes from the effect, and the effect comes from here.
      const read = operation.method === "GET" || operation.method === "HEAD";
      const target = new URL(operation.url);
      target.search = "";
      target.hash = "";
      return {
        effect: read ? "read" : "mutate",
        risk: read ? "low" : "medium",
        capability: `http.${operation.method.toLowerCase()}`,
        target: target.toString(),
        traits: ["network"],
        ...(operation.spend === undefined ? {} : { spend: operation.spend }),
      };
    }
    case "system":
      return {
        effect: "read",
        risk: "low",
        capability: "system.info",
        target: "local-system",
        traits: [],
      };
  }
}

/**
 * Evidence a mutation must satisfy when the caller declared none.
 *
 * Mutations still require evidence — that rule is the product's verification
 * thesis and is not relaxed here. What changed is the failure mode: previously a
 * caller who omitted `requiredEvidence` got a flat `mutation_requires_evidence`
 * deny and had to guess the right predicate, so most callers simply gave up. Now
 * the obvious post-condition is derived from the operation itself, and the task
 * is held to it exactly as if the caller had written it.
 *
 * Returns `[]` when no post-condition is derivable from the request alone (for
 * example a `terminal run`, whose effect depends on the command). Those still
 * deny, because a mutation nobody can check is precisely what should not run
 * unattended.
 */
export function defaultEvidenceFor(
  operation: Operation,
): EvidencePredicate[] {
  // Reads are never denied for missing evidence and already fall back to a
  // synthetic `operation_completed` item, so synthesizing a predicate for them
  // would only invent a way for a successful read to verify as `partial`.
  if (classifyOperation(operation).effect === "read") return [];
  switch (operation.kind) {
    case "file":
      switch (operation.action) {
        case "write":
        case "mkdir":
          return [{ type: "file_exists", path: operation.path }];
        case "delete":
          return [{ type: "file_absent", path: operation.path }];
        case "move":
          return operation.destination === undefined
            ? []
            : [
                { type: "file_absent", path: operation.path },
                { type: "file_exists", path: operation.destination },
              ];
        default:
          return [];
      }
    case "memory":
      // Field names differ per action; each is the adapter's own report that the
      // record actually changed, so a silent no-op cannot pass as a success.
      // `clear` returns a count rather than a flag, so it has no boolean
      // post-condition to assert.
      return operation.action === "put"
        ? [{ type: "result_equals", path: "stored", value: true }]
        : operation.action === "delete"
          ? [{ type: "result_equals", path: "deleted", value: true }]
          : [];
    case "browser":
    case "computer":
    case "http":
      // These adapters report an explicit `success` flag; hold the task to it
      // rather than letting a silent no-op pass as a completed action. For HTTP
      // that flag is the response status, which is the far end's own word — the
      // independent re-read that would be stronger is a caller's to declare.
      return [{ type: "result_equals", path: "success", value: true }];
    case "terminal":
      // `run`/`start` say nothing about what the command should leave behind,
      // so there is no honest post-condition. `send` does: the runtime reports
      // whether the bytes reached a job that was still running and accepting
      // input, and a write to a dead or non-interactive job throws instead.
      return operation.action === "send"
        ? [{ type: "result_equals", path: "sent", value: true }]
        : [];
    default:
      return [];
  }
}

function isCommandAllowed(operation: Operation, policy: LocalPolicy): boolean {
  if (operation.kind !== "terminal") return true;
  if (operation.action === "status" || operation.action === "output") {
    return operation.jobId !== undefined;
  }
  // `stop` and `send` act on a job the allowlist already cleared when it
  // started, so the job id is the whole gate — there is no command to match.
  if (operation.action === "stop" || operation.action === "send") {
    return operation.jobId !== undefined;
  }
  if (operation.command === undefined) return false;
  const command = normalizeCommandName(operation.command);
  // Normalized on both sides so `powershell.exe` cannot slip past a deny entry
  // written as `powershell`, and an operator's allowlist matches either spelling.
  if (ALWAYS_DENIED_COMMANDS.has(command)) return false;
  // A bare entry (`ls`) allows the program found on PATH, never a file that
  // happens to share its name: `tools/ls` may be a link to `/bin/sh`. A
  // path-qualified command is allowed only by an entry naming that same path.
  if (/[\\/]/.test(operation.command)) {
    const spelled = operation.command.replaceAll("\\", "/");
    return policy.allowedCommands.some(
      (allowed) => /[\\/]/.test(allowed) && allowed.replaceAll("\\", "/") === spelled,
    );
  }
  return policy.allowedCommands.some(
    (allowed) => normalizeCommandName(allowed) === command,
  );
}

function domainAllowed(operation: Operation, policy: LocalPolicy): boolean {
  // Every kind that names a destination is checked by the same allowlist. The
  // browser and the HTTP adapter reach the same hosts; a policy that let one
  // through and not the other would only describe which package made the call.
  const raw =
    operation.kind === "browser" || operation.kind === "http"
      ? operation.url
      : undefined;
  if (raw === undefined) return true;
  // `close` and `tab_switch` go nowhere: their url names the tab they act on,
  // which can be `about:blank` or a page that redirected off the allowlist.
  if (operation.kind === "browser" && (operation.action === "close" || operation.action === "tab_switch")) return true;
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) return false;
  const host = hostOf(url);
  if (host === "localhost" || host.endsWith(".localhost")) return policy.allowLocalhost;
  return policy.allowedDomains.some(
    (domain) =>
      domain === "*" ||
      // Empty, `.${domain}` is "." and every host spelled with a trailing dot
      // ends with it.
      (domain !== "" && (host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`))),
  );
}

/**
 * `*` stands for any run of characters; everything else is literal. Enough for
 * `file.*` and `/repo/build/*`, and small enough that a policy author can
 * predict what it matches.
 */
/**
 * A file path as the file runtime will resolve it, for matching against a
 * grant's target. Raw, `docs/../.env` matched a `docs/*` grant and then read
 * `.env`. Normalised by this platform's rules, the ones the runtime resolves
 * with: a backslash separates on Windows and is part of a name elsewhere, and
 * splitting on one where the runtime does not let a `..` cancel a different
 * segment than the one the runtime cancels. A trailing slash names the
 * directory itself, so it goes too.
 */
function grantPath(path: string): string {
  return normalize(path).split(sep).join("/").replace(/(?<=.)\/$/, "");
}

/** A file grant's target in the same spelling `grantPath` gives the path. */
function grantTarget(pattern: string, classified: ClassifiedForGrant): string {
  return classified.capability.startsWith("file.") ? grantPath(pattern) : pattern;
}

function patternMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("\\*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * What a grant has already drawn down, read from wherever commits are counted.
 *
 * A lookup rather than a number because policy is evaluated more than once per
 * task and a grant may be metered by any of several bounds; the caller that
 * owns the durable count decides how to answer.
 */
/**
 * What an operation declared it moves. Taken from the schema that defines it
 * rather than restated, so a field added there cannot go unnoticed here.
 */
export type DeclaredSpend = NonNullable<HttpOperation["spend"]>;

export type CapabilityUsageReader = (grantId: string) => {
  /** Operations committed against this grant, ever. */
  operations: number;
  /** Declared amounts committed against it in the last 24 hours. */
  amountToday: number;
};

/** What the issued grants say about one effect. */
export interface CapabilityCheck {
  /** Why they do not cover it, or `undefined` if they do. */
  refusal?: string;
  /** The grant it will be metered against, when a grant was needed at all. */
  grantId?: string;
}

type ClassifiedForGrant = {
  effect: Effect;
  capability: string;
  target: string;
  destination?: string;
  spend?: DeclaredSpend;
};

/**
 * Whether a provider-shaped grant covers what this operation declared.
 *
 * Exact comparison, not patterns: `stripe` and `stripe-test` are different
 * providers, and a grant meaning one must not quietly cover the other. A grant
 * with money bounds and an operation that declared nothing do not match — an
 * undeclared spend is an ungranted one, not a free one.
 */
function providerCovers(
  grant: CapabilityGrant,
  spend: ClassifiedForGrant["spend"],
): boolean {
  if (grant.provider === undefined) return true;
  if (spend === undefined) return false;
  return (
    grant.provider.name === spend.provider &&
    (grant.provider.account === undefined ||
      grant.provider.account === spend.account)
  );
}

/** Milliseconds in the rolling window `provider.dailyMax` is measured over. */
export const CAPABILITY_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Why a matching, unexpired grant still cannot pay for this effect.
 *
 * Fails closed when a metered grant is evaluated without a way to read its
 * count: a budget nobody can count is not a budget, and treating an
 * uncountable one as full would make the metered grant the loosest kind there
 * is.
 */
function meteringRefusal(
  grant: CapabilityGrant,
  spend: ClassifiedForGrant["spend"],
  usage: CapabilityUsageReader | undefined,
): string | undefined {
  const { amountMax, dailyMax } = grant.provider ?? {};
  if (
    grant.maxOperations === undefined &&
    amountMax === undefined &&
    dailyMax === undefined
  ) {
    return undefined;
  }
  if (usage === undefined) return `capability_usage_unmeterable:${grant.id}`;
  const amount = spend?.amount ?? 0;
  if (amountMax !== undefined && amount > amountMax) {
    return `capability_amount_exceeded:${grant.id}`;
  }
  const drawn = usage(grant.id);
  if (
    grant.maxOperations !== undefined &&
    drawn.operations >= grant.maxOperations
  ) {
    return `capability_usage_exhausted:${grant.id}`;
  }
  if (dailyMax !== undefined && drawn.amountToday + amount > dailyMax) {
    return `capability_daily_limit_exceeded:${grant.id}`;
  }
  return undefined;
}

/**
 * Which issued grant covers this effect, or why none does.
 *
 * An empty grant list is not a closed world — it means the operator has not
 * issued grants at all, and the rest of policy decides on its own.
 */
export function capabilityCheck(
  classified: ClassifiedForGrant,
  identity: Identity,
  policy: LocalPolicy,
  usage?: CapabilityUsageReader,
): CapabilityCheck {
  if (policy.capabilities.length === 0) return {};
  const holder = principalRef(identity.principal);
  const candidates = policy.capabilities.filter(
    (grant) =>
      patternMatches(grant.capability, classified.capability) &&
      grant.effects.includes(classified.effect) &&
      patternMatches(grantTarget(grant.target, classified), classified.target) &&
      (classified.destination === undefined ||
        patternMatches(grantTarget(grant.target, classified), classified.destination)) &&
      patternMatches(grant.principal, holder),
  );
  const matching = candidates.filter((grant) =>
    providerCovers(grant, classified.spend),
  );
  if (matching.length === 0) {
    // A grant did cover the effect and was turned away on the money block
    // alone. Saying `not_granted` there would send the caller looking for a
    // grant it already holds, so name the two fixes apart: declare a spend, or
    // declare the right one.
    if (candidates.some((grant) => grant.provider !== undefined)) {
      return {
        refusal:
          classified.spend === undefined
            ? `capability_spend_not_declared:${classified.capability}`
            : `capability_provider_mismatch:${classified.spend.provider}`,
      };
    }
    return { refusal: `capability_not_granted:${classified.capability}` };
  }
  const usable = matching.filter(
    (grant) =>
      (grant.validUntil === undefined ||
        Date.parse(grant.validUntil) > Date.now()) &&
      (grant.policyVersion === undefined ||
        grant.policyVersion === policy.version),
  );
  if (usable.length === 0) {
    // Every candidate matched the effect and was refused for a reason the
    // holder can act on, so name it rather than reporting a missing grant.
    const stale = matching.find(
      (grant) => grant.policyVersion !== policy.version,
    );
    return {
      refusal:
        stale?.policyVersion !== undefined
          ? `capability_policy_version_mismatch:${stale.id}`
          : `capability_expired:${matching[0]?.id ?? classified.capability}`,
    };
  }
  // A grant list is a set of authorities, not a single budget: one that is
  // spent out does not refuse work another still covers. Only when every
  // usable grant is exhausted does the first one's reason become the answer.
  let exhausted: string | undefined;
  for (const grant of usable) {
    const refusal = meteringRefusal(grant, classified.spend, usage);
    if (refusal === undefined) return { grantId: grant.id };
    exhausted ??= refusal;
  }
  return exhausted === undefined ? {} : { refusal: exhausted };
}

/**
 * Why the issued capabilities do not cover this effect, or `undefined` if they
 * do. `capabilityCheck` also reports which grant covered it.
 */
export function capabilityRefusal(
  classified: ClassifiedForGrant,
  identity: Identity,
  policy: LocalPolicy,
  usage?: CapabilityUsageReader,
): string | undefined {
  return capabilityCheck(classified, identity, policy, usage).refusal;
}

/** Browser actions that send a page input or act on a tab. */
const PAGE_DRIVING: ReadonlySet<string> = new Set([
  "click",
  "type",
  "fill_form",
  "select",
  "press",
  "upload",
  "download",
  "close",
  "tab_switch",
]);

export function evaluatePolicy(
  taskId: string,
  request: TaskRequest,
  policy: LocalPolicy,
  usage?: CapabilityUsageReader,
): PolicyEvaluation {
  const classified = classifyOperation(request.operation);
  // Every decision reports the same classification it was made from, including
  // the traits, so an approver reading a `confirm` sees that the command
  // installs packages and reaches a registry before echoing the phrase back.
  const decide = (
    outcome: PolicyDecision["outcome"],
    reason: string,
    risk: Risk = classified.risk,
  ): PolicyDecision => ({
    outcome,
    effect: classified.effect,
    risk,
    reason,
    policyVersion: policy.version,
    traits: classified.traits,
  });

  if (request.constraints.length > 0) {
    return {
      decision: decide("deny", "freeform_constraints_not_enforceable"),
    };
  }

  if (request.forbiddenEffects.includes(classified.effect)) {
    return { decision: decide("deny", "effect_forbidden_by_request") };
  }

  // Reconciliation settles whether an effect happened; it cannot settle a
  // question about meaning, so a contract promising reconciliation beside one
  // would be false (#54). A rule about the request's own shape, not MELRA's
  // judgement of it, so unhinged mode keeps it.
  if (
    request.reconciliation.length > 0 &&
    [...request.requiredEvidence, ...request.reconciliation].some((predicate) => predicate.type === "semantic")
  ) {
    return { decision: decide("deny", "semantic_evidence_not_reconcilable") };
  }

  // Unhinged mode allows everything the operator did not forbid in this very
  // request. It sits after the `forbiddenEffects` check on purpose: that field
  // is the caller declaring a limit on its own task, not a guardrail MELRA
  // imposes, and a caller that asked for no destructive effects should still get
  // none. Everything below — allowlists, evidence, approval — is MELRA's own
  // judgement, and unhinged mode is the operator saying they do not want it.
  if (policy.unhinged) {
    return { decision: decide("allow", "unhinged_mode_no_guardrails") };
  }

  // In enforced mode every action that drives a page names the page, so the
  // person approving it sees where it lands and a grant always has a page to
  // match; the runtime then holds the action to that page. A rule about the
  // request's shape, published for every caller, so it comes before grants:
  // a url-less request would otherwise be refused as ungranted by a grant
  // scoped to pages.
  if (
    policy.mode === "enforced" &&
    request.operation.kind === "browser" &&
    PAGE_DRIVING.has(request.operation.action) &&
    request.operation.url === undefined
  ) {
    return { decision: decide("deny", "browser_action_requires_url") };
  }

  // Authority before rules: a caller that was never granted this effect is
  // refused without consulting the allowlists, which describe what the grant
  // holder may do, not whether they hold one.
  const granted = capabilityCheck(
    classified,
    request.identity ?? LOCAL_IDENTITY,
    policy,
    usage,
  );
  if (granted.refusal !== undefined) {
    return { decision: decide("deny", granted.refusal, "critical") };
  }
  // Carried on every non-deny outcome so the commit knows what to meter. A deny
  // never reaches an adapter, so it never draws anything down.
  const metered =
    granted.grantId === undefined ? {} : { grantId: granted.grantId };

  const deniedTrait = classified.traits.find((trait) =>
    policy.deniedTraits.includes(trait),
  );
  if (deniedTrait !== undefined) {
    return { decision: decide("deny", `trait_denied:${deniedTrait}`) };
  }

  if (!isCommandAllowed(request.operation, policy)) {
    return {
      decision: decide("deny", "command_not_allowlisted", "critical"),
    };
  }

  if (!domainAllowed(request.operation, policy)) {
    return {
      decision: decide("deny", "destination_domain_not_allowed", "high"),
    };
  }

  if (classified.effect !== "read" && request.requiredEvidence.length === 0) {
    return { decision: decide("deny", "mutation_requires_evidence") };
  }

  // A judgement about meaning is never the deciding vote on a destructive
  // effect (#54): beside it there must be evidence the kernel re-read itself
  // or got from another channel. The actor's own report (result_equals,
  // exit_code, custom) does not count.
  if (
    classified.effect === "destructive" &&
    request.requiredEvidence.some((predicate) => predicate.type === "semantic") &&
    !request.requiredEvidence.some((predicate) => ["state", "independent"].includes(evidenceStrength(predicate.type)))
  ) {
    return { decision: decide("deny", "semantic_only_destructive") };
  }

  if (classified.effect === "read") {
    // Enforced mode asserts MELRA is the only door, so a read that leaves the
    // workspace is shown to a person first.
    if (policy.mode !== "enforced" || !namesPathOutside(request.operation, policy.workspaceRoot)) {
      return { decision: decide("allow", "read_only_operation"), ...metered };
    }
  } else if (policy.mutations === "deny") {
    return { decision: decide("deny", "mutations_disabled") };
  }

  const digest = digestOperation(taskId, request.operation);
  const approvalId = randomUUID();
  const phrase = `APPROVE ${digest.slice(0, 12)}`;
  return {
    decision: decide(
      "confirm",
      classified.effect === "read" ? "read_outside_workspace" : "explicit_approval_required",
    ),
    ...metered,
    challenge: {
      approvalId,
      taskId,
      actionDigest: digest,
      ...(policy.mode === "enforced" ? {} : { phrase }),
      expiresAt: new Date(Date.now() + approvalTtl(policy)).toISOString(),
    },
  };
}

export function digestOperation(taskId: string, operation: Operation): string {
  return createHash("sha256")
    .update(stableJson({ taskId, operation }))
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

export function validateApproval(
  challenge: ApprovalChallenge | undefined,
  response: ApprovalResponse | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (challenge === undefined || response === undefined) {
    return { ok: false, reason: "approval_required" };
  }
  if (challenge.approvalId !== response.approvalId) {
    return { ok: false, reason: "approval_id_mismatch" };
  }
  if (challenge.phrase === undefined || challenge.phrase !== response.phrase) {
    return { ok: false, reason: "approval_phrase_mismatch" };
  }
  if (Date.parse(challenge.expiresAt) <= Date.now()) {
    return { ok: false, reason: "approval_expired" };
  }
  return { ok: true };
}

export * from "./network-policy.js";
