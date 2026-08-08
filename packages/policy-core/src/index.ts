// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  ApprovalChallenge,
  ApprovalResponse,
  CapabilityGrant,
  CapabilityTrait,
  Effect,
  EvidencePredicate,
  Identity,
  Operation,
  PolicyDecision,
  Risk,
  TaskRequest,
} from "@melra/protocol";
import {
  CapabilityGrantSchema,
  LOCAL_IDENTITY,
  principalRef,
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
  approvalTtlMs: number;
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
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  challenge?: ApprovalChallenge;
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
 * in `@melra/browser-runtime` independently rejects non-http(s) protocols, URL
 * credentials, private ranges, and cloud metadata (169.254/16), and it resolves
 * DNS before allowing a navigation so a public name cannot be rebound to a
 * private address. The domain list is a *narrowing* control on top of that guard,
 * for operators who want to restrict which public sites are reachable — it is not
 * what stops a browser from reaching the loopback interface.
 *
 * Defaulting it to `[]` made every single navigation fail with
 * `browser_domain_not_allowed` out of the box, which is why browser use was
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

/**
 * Subcommands that install, per package manager, and the ones that only read.
 *
 * Anything unlisted falls in between: a mutation, but not an install — `npm
 * run build` writes to the workspace and reaches nothing.
 */
const PACKAGE_MANAGERS: Record<
  string,
  { install: Set<string>; read: Set<string> }
> = {
  npm: {
    install: new Set(["install", "i", "add", "ci", "update", "up", "publish"]),
    read: new Set(["ls", "list", "view", "info", "outdated", "why", "config"]),
  },
  pnpm: {
    install: new Set(["install", "i", "add", "update", "up", "publish", "dlx"]),
    read: new Set(["ls", "list", "view", "info", "outdated", "why", "licenses"]),
  },
  yarn: {
    install: new Set(["install", "add", "up", "upgrade", "publish", "dlx"]),
    read: new Set(["info", "why", "list", "outdated"]),
  },
  pip: {
    install: new Set(["install", "download", "wheel"]),
    read: new Set(["list", "show", "freeze", "check"]),
  },
  pip3: {
    install: new Set(["install", "download", "wheel"]),
    read: new Set(["list", "show", "freeze", "check"]),
  },
  uv: {
    install: new Set(["add", "sync", "install", "pip", "tool", "publish"]),
    read: new Set(["tree", "lock", "version"]),
  },
  cargo: {
    install: new Set(["install", "add", "update", "publish", "fetch"]),
    read: new Set(["tree", "metadata", "search"]),
  },
  gem: {
    install: new Set(["install", "update", "push"]),
    read: new Set(["list", "info", "which"]),
  },
  brew: {
    install: new Set(["install", "upgrade", "reinstall", "tap"]),
    read: new Set(["list", "info", "search", "outdated"]),
  },
  apt: {
    install: new Set(["install", "upgrade", "full-upgrade", "update"]),
    read: new Set(["list", "show", "search", "policy"]),
  },
  "apt-get": {
    install: new Set(["install", "upgrade", "dist-upgrade", "update"]),
    read: new Set(["show", "download"]),
  },
  go: {
    install: new Set(["install", "get", "mod"]),
    read: new Set(["list", "version", "env", "vet"]),
  },
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
    if (manager.read.has(subcommand)) {
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
    READ_COMMANDS.has(name) ||
    (name === "git" &&
      subcommand !== undefined &&
      READ_ONLY_GIT_ACTIONS.has(subcommand));
  return { read, traits: [...traits] };
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
    approvalTtlMs: 5 * 60_000,
    maxFileBytes: 10 * 1024 * 1024,
    memoryRetention: { maxAgeDays: 30, maxPerScope: 0 },
    deniedTraits: [],
    capabilities: [],
    circuitBreaker: { threshold: 3, cooldownMs: 60_000 },
    unhinged: false,
  };
}

export async function loadPolicy(
  path: string | undefined,
  workspaceRoot: string,
): Promise<LocalPolicy> {
  const defaults = createDefaultPolicy(workspaceRoot);
  if (path === undefined) return defaults;
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LocalPolicy>;
  return {
    ...defaults,
    ...parsed,
    workspaceRoot: resolve(parsed.workspaceRoot ?? workspaceRoot),
    allowedCommands: parsed.allowedCommands ?? defaults.allowedCommands,
    allowedDomains: parsed.allowedDomains ?? defaults.allowedDomains,
    // Spread, not replace: a file naming only `maxPerScope` should not silently
    // drop `maxAgeDays` to `undefined` and make compaction delete everything.
    memoryRetention: { ...defaults.memoryRetention, ...parsed.memoryRetention },
    circuitBreaker: { ...defaults.circuitBreaker, ...parsed.circuitBreaker },
    deniedTraits: parsed.deniedTraits ?? defaults.deniedTraits,
    // Parsed, not spread: a grant is the file claiming authority exists, so a
    // malformed one has to fail loudly rather than land as an object that
    // matches nothing or — worse — everything.
    capabilities:
      parsed.capabilities === undefined
        ? defaults.capabilities
        : CapabilityGrantSchema.array().max(200).parse(parsed.capabilities),
  };
}

export function classifyOperation(operation: Operation): {
  effect: Effect;
  risk: Risk;
  capability: string;
  target: string;
  traits: CapabilityTrait[];
} {
  switch (operation.kind) {
    case "file": {
      const read = new Set(["list", "read", "stat", "hash"]).has(operation.action);
      const destructive = operation.action === "delete";
      return {
        effect: destructive ? "destructive" : read ? "read" : "mutate",
        risk: destructive ? "high" : read ? "low" : "medium",
        capability: `file.${operation.action}`,
        target: operation.path,
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
      // These adapters report an explicit `success` flag; hold the task to it
      // rather than letting a silent no-op pass as a completed action.
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
  return policy.allowedCommands.some(
    (allowed) => normalizeCommandName(allowed) === command,
  );
}

function domainAllowed(operation: Operation, policy: LocalPolicy): boolean {
  if (operation.kind !== "browser" || operation.url === undefined) return true;
  const url = new URL(operation.url);
  if (!["http:", "https:"].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return policy.allowLocalhost;
  return policy.allowedDomains.some(
    (domain) =>
      domain === "*" ||
      host === domain.toLowerCase() ||
      host.endsWith(`.${domain.toLowerCase()}`),
  );
}

/**
 * `*` stands for any run of characters; everything else is literal. Enough for
 * `file.*` and `/repo/build/*`, and small enough that a policy author can
 * predict what it matches.
 */
function patternMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("\\*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * Why the issued capabilities do not cover this effect, or `undefined` if they
 * do. An empty grant list is not a closed world — it means the operator has not
 * issued grants at all, and the rest of policy decides on its own.
 */
export function capabilityRefusal(
  classified: { effect: Effect; capability: string; target: string },
  identity: Identity,
  policy: LocalPolicy,
): string | undefined {
  if (policy.capabilities.length === 0) return undefined;
  const holder = principalRef(identity.principal);
  const matching = policy.capabilities.filter(
    (grant) =>
      patternMatches(grant.capability, classified.capability) &&
      grant.effects.includes(classified.effect) &&
      patternMatches(grant.target, classified.target) &&
      patternMatches(grant.principal, holder),
  );
  if (matching.length === 0) {
    return `capability_not_granted:${classified.capability}`;
  }
  const usable = matching.filter(
    (grant) =>
      (grant.validUntil === undefined ||
        Date.parse(grant.validUntil) > Date.now()) &&
      (grant.policyVersion === undefined ||
        grant.policyVersion === policy.version),
  );
  if (usable.length > 0) return undefined;
  // Every candidate matched the effect and was refused for a reason the holder
  // can act on, so name it rather than reporting a missing grant.
  const stale = matching.find((grant) => grant.policyVersion !== policy.version);
  return stale?.policyVersion !== undefined
    ? `capability_policy_version_mismatch:${stale.id}`
    : `capability_expired:${matching[0]?.id ?? classified.capability}`;
}

export function evaluatePolicy(
  taskId: string,
  request: TaskRequest,
  policy: LocalPolicy,
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

  // Unhinged mode allows everything the operator did not forbid in this very
  // request. It sits after the `forbiddenEffects` check on purpose: that field
  // is the caller declaring a limit on its own task, not a guardrail MELRA
  // imposes, and a caller that asked for no destructive effects should still get
  // none. Everything below — allowlists, evidence, approval — is MELRA's own
  // judgement, and unhinged mode is the operator saying they do not want it.
  if (policy.unhinged) {
    return { decision: decide("allow", "unhinged_mode_no_guardrails") };
  }

  // Authority before rules: a caller that was never granted this effect is
  // refused without consulting the allowlists, which describe what the grant
  // holder may do, not whether they hold one.
  const ungranted = capabilityRefusal(
    classified,
    request.identity ?? LOCAL_IDENTITY,
    policy,
  );
  if (ungranted !== undefined) {
    return { decision: decide("deny", ungranted, "critical") };
  }

  const deniedTrait = classified.traits.find((trait) =>
    policy.deniedTraits.includes(trait),
  );  if (deniedTrait !== undefined) {
    return { decision: decide("deny", `trait_denied:${deniedTrait}`) };
  }

  if (!isCommandAllowed(request.operation, policy)) {
    return {
      decision: decide("deny", "command_not_allowlisted", "critical"),
    };
  }

  if (!domainAllowed(request.operation, policy)) {
    return {
      decision: decide("deny", "browser_domain_not_allowed", "high"),
    };
  }

  if (classified.effect !== "read" && request.requiredEvidence.length === 0) {
    return { decision: decide("deny", "mutation_requires_evidence") };
  }

  if (classified.effect === "read") {
    return { decision: decide("allow", "read_only_operation") };
  }

  if (policy.mutations === "deny") {
    return { decision: decide("deny", "mutations_disabled") };
  }

  const digest = digestOperation(taskId, request.operation);
  const approvalId = randomUUID();
  const phrase = `APPROVE ${digest.slice(0, 12)}`;
  return {
    decision: decide("confirm", "explicit_approval_required"),
    challenge: {
      approvalId,
      taskId,
      actionDigest: digest,
      phrase,
      expiresAt: new Date(Date.now() + policy.approvalTtlMs).toISOString(),
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
  if (challenge.phrase !== response.phrase) {
    return { ok: false, reason: "approval_phrase_mismatch" };
  }
  if (Date.parse(challenge.expiresAt) <= Date.now()) {
    return { ok: false, reason: "approval_expired" };
  }
  return { ok: true };
}
