#!/usr/bin/env node
// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ApprovalResponseSchema,
  DenialInputSchema,
  SemanticVerdictSchema,
  TaskRequestSchema,
  TaskStatusSchema,
  WorkflowDefinitionSchema,
  WorkflowInputSchema,
  PRODUCT_VERSION,
  principalRef,
  type ApprovalResponse,
  type TaskRequest,
  type TaskStatus,
  type WorkflowDefinition,
  type WorkflowInput,
  type WorkflowRun,
} from "@melra/protocol";
// Not the package root, which loads the MCP SDK and the HTTP server: `serve`,
// `console`, `tasks`, `watch` and `status` load those when they run, and
// `conformance` its MCP client, so `version` and `doctor` start without them (#368).
import {
  assertEnforceable,
  broadWorkspace,
  confinedRoot,
  createMelraRuntime,
  dataLocationAdvice,
  environmentSecrets,
  narrowWorkspaceAdvice,
  secretFiles,
  secretInsideWorkspace,
  OAuthProvider,
  clientPrincipal,
  printable,
  unconfinedRoot,
  workspaceHoldsData,
  workspaceInsideData,
  type MelraRuntime,
} from "@melra/server/kernel";
import { detectBrowserExecutable } from "@melra/browser-runtime";
import { createSystemComputerAdapter } from "@melra/computer-runtime";
import { capabilityUsageReader, withDefaultEvidence, type ExecutionResult } from "@melra/runtime-core";
import { SqliteStore } from "@melra/storage-sqlite";
import {
  classifyOperation,
  createDefaultPolicy,
  evaluatePolicy,
  loadPolicy,
  type LocalPolicy,
} from "@melra/policy-core";
import {
  type CliEnvironment,
  approverLabel,
  claudeLaunchArgv,
  claudeProgram,
  namedDeploymentMode,
  parseCliEnvironment,
  selfCommand,
  serverLaunch,
  withoutKernelSecrets,
} from "./environment.js";
import { approvalConsole, assertConsoleTerminal, confirmInTerminal } from "./approval-console.js";
import { clientStatuses, clientsCheck, detectClients } from "./client-status.js";
import { RESTART_SAFE_WORKFLOW } from "./demo-workflow.js";
import { detectIsolation, isolationCheck, protectionCheck, sandboxCheck } from "./isolation.js";
import {
  CLAUDE_DENIED_TOOLS,
  claudeHarness,
  claudeManagedDirectory,
  claudeManagedFiles,
  harnessCheck,
  installLines,
  managedLaunch,
  within,
} from "./harness.js";
import {
  broadWorkspaceWarning,
  confirmBroadWorkspace,
  prompter,
  renderConformance,
  renderDoctor,
  renderInit,
  renderLaunch,
  renderManaged,
  renderSetup,
  setupWizard,
  type ConformanceReport,
  type DoctorCheck,
  type DoctorReport,
  type InitResult,
  type Prompter,
} from "./human.js";
import { isHuman, paint, printJsonOrHuman } from "./output.js";
import {
  CLIENTS,
  clientConfig,
  clientConfigPath,
  clientConfigText,
  denyRulesText,
  replaceFile,
  resolveClient,
} from "./clients.js";

/**
 * Fold in what the policy file says, so every command describes the server it
 * would actually start: `unhinged` if either asks for it, and the stricter
 * `mode`, exactly as the server combines them.
 *
 * The workspace is MELRA_WORKSPACE when it is set, which every config `setup`
 * writes does, and the working directory otherwise. A file the operator names
 * in MELRA_POLICY may pin it when MELRA_WORKSPACE is not set; any policy file
 * may narrow it to a directory inside, never move it outside. Older `setup`
 * runs wrote their own workspace into the shared ~/.melra/policy.json, and a
 * server for any later project was then confined to the first one instead.
 *
 * A file that does not load changes nothing here, the mode included: nothing in
 * an invalid file is trusted to mean what it seems to. `doctor`, `status` and
 * `tasks` report it, and `serve`, `run` and `approve` refuse to start on it.
 */
async function settle(env: CliEnvironment): Promise<CliEnvironment> {
  const path = await existingPolicyPath(env);
  if (path === undefined) return env;
  let file: LocalPolicy;
  try {
    file = await loadPolicy(path, env.workspaceRoot);
  } catch {
    return env;
  }
  const shared = resolve(path) === resolve(env.dataDirectory, "policy.json");
  return {
    ...env,
    workspaceRoot:
      env.workspaceSet !== true && !shared
        ? file.workspaceRoot
        : confinedRoot(env.workspaceRoot, file.workspaceRoot),
    unhinged: env.unhinged || file.unhinged,
    mode: env.mode === "enforced" || file.mode === "enforced" ? "enforced" : "developer",
  };
}

async function existingPolicyPath(env: CliEnvironment): Promise<string | undefined> {
  if (env.policyPath !== undefined) return env.policyPath;
  const candidate = join(env.dataDirectory, "policy.json");
  try {
    // Exists, not readable: an unreadable file has to fail loudly, not be
    // skipped for the built-in defaults along with its enforced mode.
    await access(candidate, constants.F_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * The banner unsafe-local mode prints before it does anything.
 *
 * It goes to stderr, which is where it has to go: in `serve` the stdout stream
 * is the MCP transport and any prose written there corrupts the protocol. stderr
 * is what MCP clients surface in their server logs, so the operator still sees
 * it. Ordinary runs get it too — the mode is per-process, not per-command, and a
 * developer who exported the variable in one shell and forgot deserves the
 * reminder on every invocation rather than only at startup.
 */
function unsafeLocalBanner(root: string): string {
  return [
    "",
    "  ############################################################",
    "  #  MELRA IS RUNNING UNSAFE-LOCAL. NO GUARDRAILS APPLY.     #",
    "  ############################################################",
    "",
    "  Disabled for every task this process runs:",
    "    - policy decisions: nothing is denied, no approval is ever asked for",
    "    - the command allowlist, including shells and sudo",
    "    - the evidence requirement on mutations and destructive operations",
    "    - the browser's block on private, loopback, and cloud-metadata hosts",
    `    - workspace confinement: files and commands can reach all of ${root}`,
    "",
    "  A caller can now delete, overwrite, exfiltrate, or execute anything this",
    "  OS user can. Receipts are still written, so you will be able to read what",
    "  happened — after it has happened.",
    "",
    "  Turn it off by unsetting MELRA_UNHINGED and dropping --unsafe-local.",
    "",
  ].join("\n");
}

async function runtime(env: CliEnvironment, environment?: NodeJS.ProcessEnv): Promise<MelraRuntime> {
  const policyPath = await existingPolicyPath(env);
  return await createMelraRuntime({
    workspaceRoot: env.workspaceRoot,
    dataDirectory: env.dataDirectory,
    unhinged: env.unhinged,
    mode: env.mode,
    ...(environment === undefined ? {} : { environment }),
    ...(policyPath === undefined ? {} : { policyPath }),
    ...(env.browserExecutablePath === undefined
      ? {}
      : { browserExecutablePath: env.browserExecutablePath }),
    ...(env.browserCdpEndpoint === undefined
      ? {}
      : { browserCdpEndpoint: env.browserCdpEndpoint }),
    ...(env.browserCdpContextIndex === undefined
      ? {}
      : { browserCdpContextIndex: env.browserCdpContextIndex }),
    ...(env.browserHarPath === undefined
      ? {}
      : { browserHarPath: env.browserHarPath }),
    ...(env.browserHarReplayPath === undefined
      ? {}
      : { browserHarReplayPath: env.browserHarReplayPath }),
    ...(env.browserProfileDir === undefined
      ? {}
      : { browserProfileDir: env.browserProfileDir }),
  });
}

function output(value: unknown): void {
  // JSON.stringify escapes C0 controls but leaves C1, DEL and the invisible
  // and reordering characters raw, and much of what is printed came from an
  // agent. Spelled out, it is still valid JSON for the same values.
  process.stdout.write(`${printable(JSON.stringify(value, null, 2), true)}\n`);
}

function argument(name: string, args: string[]): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

/**
 * The arguments that are neither a flag nor a flag's value, in order: the
 * action and the id a command acts on, wherever they sit among the flags.
 * Taking the first argument instead read `inspect --mode enforced <id>` as a
 * task named `--mode` (#402). `valued` is the command's own flags that take a
 * value; `--mode` is every command's.
 */
function positionals(args: readonly string[], valued: readonly string[] = []): string[] {
  const skipped = new Set(["--mode", ...valued]);
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) found.push(value);
    else if (skipped.has(value)) index += 1;
  }
  return found;
}

/**
 * A flag this command does not know is a typo, and a typo must not be silently
 * ignored: `melra run --requst t.json` fell through to reading stdin, which in
 * a terminal prints nothing and in a pipeline that never closes hangs forever.
 */
function rejectUnknownFlags(args: string[], known: readonly string[]): void {
  // Process-wide rather than per-command: these three describe the process, not
  // what a command does, so every command accepts them.
  const allowed = new Set([
    ...known,
    "--unsafe-local",
    "--unhinged",
    "--mode",
  ]);
  // A flag's own value can look like a flag (`--input node=--x`), so skip the
  // slot after any known flag that takes one.
  // Every known flag that takes no value. One missing here had its next
  // token skipped unchecked, so `--write --dry-run` wrote the config.
  const boolean = new Set(["--http", "--json", "--yes", "--deny", "--write", "--open", "--dry-run", "--exclusive"]);
  const valued = new Set(known.filter((flag) => !boolean.has(flag)));
  for (let index = 0; index < args.length; index += 1) {
    const argument_ = args[index];
    if (argument_ === undefined || !argument_.startsWith("--")) continue;
    if (!allowed.has(argument_)) {
      throw new Error(
        `unknown flag ${argument_}. Known here: ${[...allowed].sort().join(", ")}`,
      );
    }
    if (valued.has(argument_)) index += 1;
  }
}

// `JSON.parse` reports a character offset and nothing about where it was
// reading, so a typo in a workflow definition surfaced as a bare
// "Expected property name or '}' in JSON at position 1". Name the source.
function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${source} is not valid JSON: ${detail}`);
  }
}

async function readTaskRequest(args: string[]): Promise<TaskRequest> {
  const requestPath = argument("--request", args);
  if (requestPath !== undefined) {
    const absolute = resolve(requestPath);
    return TaskRequestSchema.parse(
      parseJson(await readFile(absolute, "utf8"), absolute),
    );
  }
  if (!process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) input += String(chunk);
    // Redirected-but-empty stdin is what a script gets wrong, and `JSON.parse`
    // answers it with "Unexpected end of JSON input" — true, and no help at
    // all. Say the same thing an interactive shell would.
    if (input.trim() === "") {
      throw new Error("provide --request <file> or pipe a JSON task request");
    }
    return TaskRequestSchema.parse(parseJson(input, "the piped task request"));
  }
  throw new Error("provide --request <file> or pipe a JSON task request");
}

async function readWorkflowDefinition(
  args: string[],
): Promise<WorkflowDefinition> {
  const definitionPath = argument("--definition", args);
  if (definitionPath === undefined) {
    throw new Error("workflow plan requires --definition <file>");
  }
  const absolute = resolve(definitionPath);
  return WorkflowDefinitionSchema.parse(
    parseJson(await readFile(absolute, "utf8"), absolute),
  );
}

function workflowExitCode(status: WorkflowRun["status"]): number {
  if (status === "awaiting_approval") return 3;
  // A run waiting on a person is not a failure — it is a prompt. Its own exit
  // code lets a script tell "answer me" apart from "approve me" and "broke".
  if (status === "awaiting_input") return 4;
  if (
    [
      "failed",
      "partially_complete",
      "cancelled",
      "recovery_required",
    ].includes(status)
  ) {
    return 2;
  }
  return 0;
}

// `--input <node-id>=<value>`. `=` rather than `:` because a node ID never
// contains one but an answer very often does (URLs, times, ratios).
function workflowInputs(args: string[]): WorkflowInput[] {
  const inputs: WorkflowInput[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--input") continue;
    const value = args[index + 1];
    if (value === undefined) throw new Error("--input requires a value");
    const separator = value.indexOf("=");
    if (separator < 1 || separator === value.length - 1) {
      throw new Error("--input must be <node-id>=<value>");
    }
    inputs.push(
      WorkflowInputSchema.parse({
        nodeId: value.slice(0, separator),
        value: value.slice(separator + 1),
      }),
    );
    index += 1;
  }
  return inputs;
}

function workflowApprovals(args: string[]): ApprovalResponse[] {
  const approvals: ApprovalResponse[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--approval") continue;
    const value = args[index + 1];
    if (value === undefined) throw new Error("--approval requires a value");
    const separator = value.indexOf(":");
    if (separator < 1 || separator === value.length - 1) {
      throw new Error(
        "--approval must be <approval-id>:<exact-phrase>",
      );
    }
    approvals.push(
      ApprovalResponseSchema.parse({
        approvalId: value.slice(0, separator),
        phrase: value.slice(separator + 1),
      }),
    );
    index += 1;
  }
  return approvals;
}

async function workflowCommand(
  args: string[],
  env: CliEnvironment,
): Promise<number> {
  // The flag readers below skip the action, so they take every argument.
  const [action, workflowId] = positionals(args, ["--definition", "--approval", "--input"]);
  const melra = await runtime(env);
  try {
    switch (action) {
      case "plan": {
        const run = melra.workflows.plan(
          await readWorkflowDefinition(args),
        );
        output(run);
        return workflowExitCode(run.status);
      }
      case "advance": {
        if (workflowId === undefined) {
          throw new Error("workflow advance requires a workflow ID");
        }
        const approvals = workflowApprovals(args);
        const inputs = workflowInputs(args);
        // As the operator, recorded on each answer: in enforced mode only an
        // operator answers a node whose answeredBy is operator, and an
        // approval refused there is the operator's, not the agent's.
        const result = await melra.workflows.advance(
          workflowId,
          approvals,
          inputs,
          inputs.length === 0 && approvals.length === 0 ? undefined : { operator: approverLabel(env) },
        );
        output(result);
        return workflowExitCode(result.run.status);
      }
      case "inspect": {
        if (workflowId === undefined) {
          throw new Error("workflow inspect requires a workflow ID");
        }
        output(melra.workflows.status(workflowId));
        return 0;
      }
      case "cancel": {
        if (workflowId === undefined) {
          throw new Error("workflow cancel requires a workflow ID");
        }
        const run = melra.workflows.cancel(workflowId);
        output(run);
        // Whether the cancel took, as `approve --deny` reports it. Read off the
        // run's status instead, a cancel that worked exited 2 and one that
        // left a finished run as it was exited 0 (#403).
        return run.status === "cancelled" ? 0 : 1;
      }
      case "pause":
      case "resume":
      case "suspend": {
        if (workflowId === undefined) {
          throw new Error(`workflow ${action} requires a workflow ID`);
        }
        // As the operator, recorded on the event: in enforced mode only an
        // operator lifts a halt an operator made.
        const by = { operator: approverLabel(env) };
        const run =
          action === "pause"
            ? melra.workflows.pause(workflowId, by)
            : action === "suspend"
              ? melra.workflows.suspend(workflowId, by)
              : melra.workflows.resume(workflowId, by);
        output(run);
        return workflowExitCode(run.status);
      }
      default:
        throw new Error(
          "workflow supports plan, advance, inspect, cancel, pause, resume, and suspend",
        );
    }
  } finally {
    await melra.close();
  }
}

async function durableCoreDemo(env: CliEnvironment): Promise<number> {
  const melra = await runtime(env);
  try {
    const definition = WorkflowDefinitionSchema.parse(RESTART_SAFE_WORKFLOW);
    const planned = melra.workflows.plan(definition);
    const advanced = await melra.workflows.advance(planned.id);
    output({
      example: definition.name,
      workflow: advanced.run,
      next:
        advanced.run.status === "verified_complete"
          ? "complete"
          : `melra workflow advance ${planned.id}`,
    });
    return workflowExitCode(advanced.run.status);
  } finally {
    await melra.close();
  }
}

/**
 * Whether `MELRA_SOCKET` names somewhere `serve --socket` can listen, and whether a
 * socket already there is one only this user can open. The mode is the whole
 * point of the transport, so a wider one is a `fail`, not a `warn`.
 */
async function socketCheck(path: string): Promise<{
  name: string;
  status: "pass" | "fail";
  detail: string;
}> {
  const name = "socket";
  if (process.platform === "win32") {
    return {
      name,
      status: "fail",
      detail: "MELRA_SOCKET is not supported on Windows; use stdio or loopback HTTP",
    };
  }
  try {
    if (!(await stat(dirname(path))).isDirectory()) throw new Error("not a directory");
  } catch {
    return { name, status: "fail", detail: `parent directory missing: ${dirname(path)}` };
  }
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return {
      name,
      status: "pass",
      detail: `${path}: not listening; 'melra serve' creates it mode 0600`,
    };
  }
  if (!stats.isSocket()) {
    return {
      name,
      status: "fail",
      detail: `${path} exists and is not a socket; 'melra serve' will refuse it`,
    };
  }
  const mode = stats.mode & 0o777;
  return (mode & 0o077) === 0
    ? { name, status: "pass", detail: `${path}: socket, mode 0${mode.toString(8)}` }
    : {
        name,
        status: "fail",
        detail: `${path}: socket, mode 0${mode.toString(8)}; other users can connect`,
      };
}

/**
 * Whether the user MELRA runs as can change the policy that governs it. A
 * `warn` in enforced mode, never a `fail`: the digest on every receipt still
 * says which file governed an effect. But a file this user can rewrite, or
 * replace through its directory, is one any process running as this user can
 * change before the next effect. In developer mode that is the ordinary setup,
 * so it passes and says so. With no file, the path is where one would be
 * loaded from on the next start.
 */
async function policyWriteCheck(path: string, mode: CliEnvironment["mode"]): Promise<DoctorCheck> {
  // Permission bits answer this on POSIX; on Windows ACLs decide it, and
  // access() does not read them.
  if (process.platform === "win32") {
    return { name: "policy-write", status: "pass", detail: "not checked on win32" };
  }
  // Read-only is not enough: the owner can chmod it back. And a folder this
  // user can change lets it swap anything below it, so every folder above the
  // file counts, along the path as given and the one its links resolve to.
  const ancestors = (from: string): string[] => (from === dirname(from) ? [from] : [from, ...ancestors(dirname(from))]);
  const uid = process.getuid?.();
  const seen = new Set<string>();
  const changeable: string[] = [];
  for (const target of [...ancestors(path), ...ancestors(await realpath(path).catch(() => path))]) {
    // Each real file or folder once, by the first name it was reached under.
    const real = await realpath(target).catch(() => target);
    if (seen.has(real)) continue;
    seen.add(real);
    const owner = await stat(target).then((stats) => stats.uid, () => undefined);
    // Missing: nothing there yet to change.
    if (owner === undefined) continue;
    const writable = await access(target, constants.W_OK).then(() => true, () => false);
    if (writable || owner === uid) changeable.push(target);
  }
  if (changeable.length === 0) {
    return { name: "policy-write", status: "pass", detail: `${path} and every folder above it are out of this user's reach` };
  }
  const detail = `${changeable.join(", ")} can be changed by the user MELRA runs as`;
  return mode === "enforced"
    ? {
        name: "policy-write",
        status: "warn",
        detail,
        // Never "make MELRA_HOME read-only": MELRA has to write it.
        next: "point MELRA_POLICY at a file another account owns, in folders this user cannot change",
      }
    : { name: "policy-write", status: "pass", detail: `${detail}: expected in developer mode, matters in enforced mode` };
}

async function doctor(env: CliEnvironment): Promise<{
  report: DoctorReport;
  failed: boolean;
}> {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    status: major >= 22 ? "pass" : "fail",
    detail: process.version,
  });
  // A `warn`, not a `fail`: the operator asked for this, so `doctor` must still
  // exit zero. But a machine running with no guardrails should never be able to
  // report a clean bill of health without saying so.
  checks.push(
    env.unhinged
      ? {
          name: "guardrails",
          status: "warn",
          detail:
            "UNSAFE-LOCAL: no policy, approval, evidence, confinement, or destination check is applied",
        }
      // Not "enforced": the next check uses that word for the deployment mode,
      // and one JSON blob saying `guardrails: enforced` beside `mode: developer`
      // reads as a contradiction that is not there.
      : { name: "guardrails", status: "pass", detail: "all applied" },
  );
  // Neither mode is a `fail` on its own. Developer mode is a legitimate choice and the
  // default; what is not legitimate is a machine that cannot say which one it is,
  // or one asking for enforced mode and unsafe-local at once, which a policy file
  // can do past the flag check and which the server then refuses to start.
  let refusal: string | undefined;
  try {
    assertEnforceable(env.mode, env.unhinged);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  checks.push({
    name: "mode",
    status: refusal === undefined ? "pass" : "fail",
    detail:
      refusal ??
      (env.mode === "enforced"
        ? "enforced: no unsafe-local, loopback or Unix socket only, no client self-registration"
        : "developer: MELRA governs what it is asked for; the harness may have another path"),
  });
  // What the server warns of when it starts in enforced mode, read from this
  // shell's environment, which a server started from it inherits.
  const exposed = env.mode === "enforced" ? environmentSecrets(process.env, env.dataDirectory) : undefined;
  if (exposed !== undefined) checks.push({ name: "environment", status: "warn", ...exposed });
  try {
    // A file passes access() too, and the runtime then fails to start on it.
    if (!(await stat(env.workspaceRoot)).isDirectory()) throw new Error("not a directory");
    await access(env.workspaceRoot, constants.R_OK | constants.W_OK);
    checks.push({
      name: "workspace",
      status: "pass",
      detail: env.workspaceRoot,
    });
  } catch {
    checks.push({
      name: "workspace",
      status: "fail",
      detail: `not readable and writable: ${env.workspaceRoot}`,
    });
  }
  try {
    await mkdir(env.dataDirectory, { recursive: true, mode: 0o700 });
    await access(env.dataDirectory, constants.R_OK | constants.W_OK);
    // Created private above. One that already existed is left as it is, but
    // said to be open: the task database inside is private, its directory not.
    const open = process.platform !== "win32" && ((await stat(env.dataDirectory)).mode & 0o077) !== 0;
    checks.push({
      name: "data-directory",
      status: open ? "warn" : "pass",
      detail: open ? `${env.dataDirectory} can be read by other users; run chmod 700 on it` : env.dataDirectory,
    });
  } catch {
    checks.push({
      name: "data-directory",
      status: "fail",
      detail: env.dataDirectory,
    });
  }
  // Only once both exist as directories: the check would create a missing
  // workspace.
  if (checks.every((check) => !["workspace", "data-directory"].includes(check.name) || check.status !== "fail")) {
    try {
      if (await workspaceInsideData(env.workspaceRoot, env.dataDirectory)) {
        checks.push({
          name: "data-location",
          // The server refuses to start this way in every mode.
          status: "fail",
          detail:
            `workspace_inside_data_directory: ${env.workspaceRoot} is inside ${env.dataDirectory}, ` +
            "where every path is MELRA's own; point MELRA_WORKSPACE at the project",
        });
      } else if (!env.unhinged) {
        // Not in unsafe-local, which reaches every file on the machine and
        // whose guardrails warning already says so.
        const inside = await workspaceHoldsData(env.workspaceRoot, env.dataDirectory);
        checks.push(
          inside
            ? {
                name: "data-location",
                // The server refuses to start this way in enforced mode.
                status: env.mode === "enforced" ? "fail" : "warn",
                detail: `${env.dataDirectory} is inside the workspace, where a recursive read reaches payload.key without naming it`,
                // As the server words its refusal.
                next: await dataLocationAdvice(env.workspaceRoot, env.dataDirectory, env.policyPath),
              }
            : { name: "data-location", status: "pass", detail: "outside the workspace" },
        );
      }
    } catch (error) {
      checks.push({
        name: "data-location",
        status: "fail",
        detail: `could not resolve the workspace: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  try {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE readiness(value TEXT)");
    database.close();
    checks.push({ name: "sqlite", status: "pass", detail: "node:sqlite available" });
  } catch (error) {
    checks.push({
      name: "sqlite",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const browser = env.browserExecutablePath ?? (await detectBrowserExecutable());
  checks.push(
    // An attached browser may be the one the operator browses and approves in.
    env.browserCdpEndpoint !== undefined
      ? {
          name: "browser",
          status: "warn",
          detail:
            `attached over CDP to ${env.browserCdpEndpoint}: any tab open there, signed-in sites included, ` +
            "is a tab_switch away from the agent; attach to a browser you do not use yourself",
        }
      : {
          name: "browser",
          status: browser === undefined ? "warn" : "pass",
          detail:
            browser ??
            "Chrome, Chromium, or Edge not found; non-browser capabilities remain available",
        },
  );
  const computer = await createSystemComputerAdapter([]).capabilities();
  checks.push({
    name: "computer",
    status: computer.available ? "pass" : "warn",
    detail: computer.available
      ? `${computer.adapter}: screenshot=${computer.screenshot}, pointer=${computer.pointer}, keyboard=${computer.keyboard}, scroll=${computer.scroll}`
      : computer.limitations.join("; "),
  });
  let credentials: LocalPolicy["credentials"] = {};
  let sandbox: { settings: LocalPolicy["sandbox"]; policyPath?: string } | undefined;
  try {
    const path = await existingPolicyPath(env);
    // The server's own parser, so a bad `mode` or grant fails here too.
    const loaded = await loadPolicy(path, env.workspaceRoot);
    credentials = loaded.credentials;
    sandbox = { settings: loaded.sandbox, ...(path === undefined ? {} : { policyPath: path }) };
    checks.push({
      name: "policy",
      status: "pass",
      detail: `${path ?? "using safe built-in defaults"} (${loaded.digest})`,
    });
    // Enforced mode keeps loopback closed unless the file opens it, so say so
    // when it does: the services this machine runs for itself are behind it.
    if (env.mode === "enforced" && loaded.allowLocalhost === true) {
      checks.push({
        name: "loopback",
        status: "warn",
        detail: `${path} sets allowLocalhost, so HTTP and browser effects can reach services on this machine's loopback`,
        next: `remove allowLocalhost from ${path} unless a task needs a service on this machine`,
      });
    }
    // With no file, the next start loads whatever appears at the default path.
    checks.push(await policyWriteCheck(path ?? join(env.dataDirectory, "policy.json"), env.mode));
  } catch (error) {
    checks.push({
      name: "policy",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  // Where the browser's and the credential broker's secret files lie, judged as
  // the server judges them before it starts. Only once the workspace exists:
  // the check would create it.
  const secrets = secretFiles(env, credentials);
  if (secrets.size > 0 && checks.some((check) => check.name === "workspace" && check.status === "pass")) {
    try {
      const profile = secrets.get("MELRA_BROWSER_PROFILE");
      if (profile !== undefined && (await workspaceInsideData(env.workspaceRoot, profile))) {
        checks.push({
          name: "secret-location",
          // The server refuses to start this way in every mode.
          status: "fail",
          detail: `workspace_inside_browser_profile: ${env.workspaceRoot} is inside ${profile}`,
          next: "point MELRA_WORKSPACE at the project, outside MELRA_BROWSER_PROFILE",
        });
      } else if (!env.unhinged) {
        // Not in unsafe-local, as for the data directory.
        const held = await secretInsideWorkspace(env.workspaceRoot, secrets);
        checks.push(
          held === undefined
            ? { name: "secret-location", status: "pass", detail: "outside the workspace" }
            : {
                name: "secret-location",
                // The server refuses to start this way in enforced mode.
                status: env.mode === "enforced" ? "fail" : "warn",
                detail: `${held} names ${secrets.get(held)}, inside the workspace, where a recursive read reaches it without naming it`,
                next: `move ${secrets.get(held)} out of the workspace`,
              },
        );
      }
    } catch (error) {
      checks.push({
        name: "secret-location",
        status: "fail",
        detail: `could not resolve the workspace: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  let commands: string | undefined;
  if (sandbox !== undefined && checks.some((check) => check.name === "workspace" && check.status === "pass")) {
    const { settings, policyPath } = sandbox;
    const found = await sandboxCheck(env, settings, { secrets, ...(policyPath === undefined ? {} : { policyPath }) });
    checks.push(found.check);
    commands = found.commands;
  }
  if (env.socketPath !== undefined) checks.push(await socketCheck(env.socketPath));
  checks.push(isolationCheck(await detectIsolation(), env.mode));
  const clients = await clientStatuses(env.workspaceRoot);
  checks.push(clientsCheck(clients));
  // Only where Claude Code is in play: melra configured for it here, managed
  // settings installed, or a settings file that already denies a pinned tool.
  const harness = await claudeHarness({ workspace: env.workspaceRoot });
  const inPlay =
    clients.some((client) => client.client === "claude-code" && client.state === "configured") ||
    harness.files.some((file) => file.scope === "managed") ||
    harness.removed.length > 0;
  if (inPlay) checks.push(harnessCheck(harness));
  // Last, as the sum of the lines above: what actually guards an effect.
  checks.push(protectionCheck(env, commands, inPlay ? harness.present : undefined));
  const failed = checks.some((check) => check.status === "fail");
  return {
    report: {
      product: "MELRA",
      version: PRODUCT_VERSION,
      ready: !failed,
      // Alongside the `guardrails` check so a script does not have to read a
      // detail string to find out whether this machine has any.
      unhinged: env.unhinged,
      mode: env.mode,
      checks,
      // Per client, so a script can find a stale pin without parsing `detail`.
      clients,
      ...(inPlay ? { harness } : {}),
    },
    failed,
  };
}

// What a client starts the server with, as `init` and `launch` write it.
function serverEnvironment(env: CliEnvironment, policyPath: string | undefined): Record<string, string> {
  return {
    MELRA_WORKSPACE: env.workspaceRoot,
    MELRA_HOME: env.dataDirectory,
    ...(policyPath === undefined ? {} : { MELRA_POLICY: policyPath }),
    // The client starts the server with this env, not with our flags: without
    // it `--mode enforced` would be reported here and a developer server run.
    ...(env.mode === "enforced" ? { MELRA_MODE: "enforced" } : {}),
  };
}

async function init(args: string[], env: CliEnvironment): Promise<InitResult> {
  // `setup --exclusive --dry-run`: nothing is written, the policy included.
  const dryRun = args.includes("--dry-run");
  if (!dryRun) await mkdir(env.dataDirectory, { recursive: true, mode: 0o700 });
  // The operator's MELRA_POLICY when there is one: writing the default path
  // into the client config instead quietly swapped their policy for ours.
  const policyPath = env.policyPath ?? join(env.dataDirectory, "policy.json");
  try {
    await access(policyPath, constants.F_OK);
  } catch {
    if (env.policyPath !== undefined) {
      throw new Error(`MELRA_POLICY names ${policyPath}, which does not exist`);
    }
    // No `workspaceRoot`: this file is shared by every project's server, and
    // each config `setup` writes names its own workspace in MELRA_WORKSPACE.
    // In the mode asked for, so `approve` and `console` run from a shell agree
    // with the server on it; a policy that already exists is the operator's.
    const { workspaceRoot: _shared, ...policy } = createDefaultPolicy(env.workspaceRoot);
    if (!dryRun) {
      await writeFile(policyPath, `${JSON.stringify({ ...policy, mode: env.mode }, null, 2)}\n`, { flag: "wx" });
    }
  }
  const client = resolveClient(argument("--client", args) ?? "generic");
  const label = CLIENTS[client]?.label ?? client;
  const exclusive = args.includes("--exclusive");
  const config = clientConfig(client, {
    ...serverLaunch(import.meta.dirname, PRODUCT_VERSION),
    // With its own tools gone, the agent finds MELRA's under names it knows.
    env: { ...serverEnvironment(env, policyPath), ...(exclusive ? { MELRA_HARNESS_TOOLS: "1" } : {}) },
  });
  const configPath = clientConfigPath(client, env.workspaceRoot);
  // Project local, beside the project's .mcp.json, rather than the shared
  // .claude/settings.json, which a commit would hand to everyone who clones
  // the project, or the user's, which reaches every project.
  const settings = exclusive
    ? { path: join(env.workspaceRoot, ".claude", "settings.local.json"), deny: CLAUDE_DENIED_TOOLS }
    : undefined;
  if (dryRun || args.includes("--write")) {
    if (configPath === undefined) {
      throw new Error("--write needs a named --client; see 'melra help' for the list");
    }
    // Both worked out before either is written, so a file refused stops both.
    const mcp = await clientConfigText(configPath, config, client);
    const local = settings === undefined ? undefined : await denyRulesText(settings.path, settings.deny);
    const base = { initialized: true as const, client, workspace: env.workspaceRoot, policyPath, configPath, config };
    if (dryRun) {
      return {
        ...base,
        ...(settings === undefined ? {} : { settings }),
        dryRun: true,
        files: [
          { path: configPath, text: mcp.next },
          ...(settings === undefined || local === undefined ? [] : [{ path: settings.path, text: local.next }]),
        ],
        note: "Nothing was written.",
      };
    }
    const { backup, unchanged } = await replaceFile(configPath, mcp.existing, mcp.next);
    const denied =
      settings === undefined || local === undefined
        ? undefined
        : { ...settings, ...(await replaceFile(settings.path, local.existing, local.next)) };
    const next = CLIENTS[client]?.next ?? `Restart ${label} to load it.`;
    return {
      ...base,
      written: true,
      ...(backup === undefined ? {} : { backup }),
      ...(unchanged === undefined ? {} : { unchanged }),
      ...(denied === undefined ? {} : { settings: denied }),
      note:
        (unchanged
          ? `${configPath} already has this melra entry; nothing changed. ${next}`
          : `Added melra to ${configPath}. ${next}`) +
        (denied === undefined ? "" : ` ${denied.path} denies Claude Code's own ${denied.deny.join(", ")} there.`),
    };
  }
  return {
    initialized: true,
    client,
    workspace: env.workspaceRoot,
    policyPath,
    ...(configPath === undefined ? {} : { configPath }),
    config,
    ...(settings === undefined ? {} : { settings }),
    note:
      configPath === undefined
        ? "Add the mcpServers.melra entry to your client's MCP configuration, " +
          "or rerun with --client <name> for that client's own format."
        : settings === undefined
          ? `Add this to ${configPath}, or rerun with --write to merge it there for you.`
          : `Add this to ${configPath} and its permissions.deny to ${settings.path}, or rerun with --write to merge both for you.`,
  };
}

// A broad workspace (home, a directory holding it, or a filesystem root) hands
// the agent every project at once, and a fresh terminal starts in home.
// MELRA_WORKSPACE naming it is a choice already made; otherwise a person at a
// terminal is asked, defaulting to no, and anything else is refused before a
// file is written.
async function workspaceAgreed(env: CliEnvironment, reader: Prompter | undefined): Promise<boolean> {
  const broad = env.workspaceSet === true ? undefined : await broadWorkspace(env.workspaceRoot);
  if (broad === undefined) return true;
  const warning = broadWorkspaceWarning(
    env.workspaceRoot,
    broad,
    narrowWorkspaceAdvice(env.dataDirectory, env.policyPath),
  );
  if (reader === undefined) {
    throw new Error(`workspace_too_broad: ${warning} (MELRA_WORKSPACE=${env.workspaceRoot} to use it anyway)`);
  }
  if (await confirmBroadWorkspace(reader, env.workspaceRoot, warning)) return true;
  process.stdout.write("Nothing was written.\n");
  return false;
}

// Only a person at a terminal on both ends is asked anything. Anything else —
// a pipe, a test, `--json` — gets the non-interactive behaviour.
function questions(args: string[]): Prompter | undefined {
  return isHuman(args) && process.stdin.isTTY ? prompter({ input: process.stdin, output: process.stdout }) : undefined;
}

// One command for the whole local setup: write the policy, emit a working
// client config, and verify the machine can actually run it.
async function setup(args: string[], env: CliEnvironment): Promise<number> {
  const exclusive = args.includes("--exclusive");
  for (const flag of ["--managed", "--dry-run"]) {
    if (!exclusive && args.includes(flag)) {
      throw new Error(`${flag} goes with --exclusive: melra setup --client claude-code --exclusive [--write | --managed <dir>] [--dry-run]`);
    }
  }
  const named = argument("--client", args);
  if (exclusive && (named === undefined || resolveClient(named) !== "claude-code")) {
    const label = named === undefined ? undefined : CLIENTS[resolveClient(named)]?.label;
    throw new Error(
      label === undefined
        ? "--exclusive needs --client claude-code"
        : `--exclusive supports only --client claude-code: MELRA does not write ${label}'s settings that take its own tools away; ` +
            `run 'melra setup --client ${named} --write' without it, or run the agent in a box ('melra probe' checks one)`,
    );
  }
  if (args.includes("--managed")) {
    const directory = argument("--managed", args);
    if (directory === undefined || directory.trim() === "" || directory.startsWith("--")) {
      throw new Error("--managed requires a directory");
    }
    if (args.includes("--write")) throw new Error("--managed writes only into its directory; leave out --write");
  }
  let chosen = args;
  // One reader for the workspace question and the wizard, so answers typed
  // ahead of the second are not dropped with the first.
  const reader = questions(args);
  try {
    if (!(await workspaceAgreed(env, reader))) return 1;
    if (argument("--client", args) === undefined && reader !== undefined) {
      const answer = await setupWizard(reader, detectClients(env.workspaceRoot));
      if (answer === undefined) {
        process.stdout.write("\nCancelled; nothing was written.\n");
        return 130;
      }
      process.stdout.write("\n");
      // The same arguments the person could have typed, so the wizard cannot
      // drift from what `--client X --write` does.
      chosen = ["--client", answer.client, ...(answer.write ? ["--write"] : [])];
    }
  } finally {
    reader?.close();
  }
  if (args.includes("--managed")) return await managedSetup(args, env);
  const initialized = await init(chosen, env);
  if (initialized.dryRun === true) {
    // No doctor either: it creates MELRA_HOME.
    printJsonOrHuman(initialized, renderInit, args);
    return 0;
  }
  const { report, failed } = await doctor(env);
  printJsonOrHuman({ ...initialized, ...report }, () => renderSetup(initialized, report), args);
  return failed ? 1 : 0;
}

/**
 * `setup --client claude-code --exclusive --managed <dir>`: Claude Code's
 * managed-settings.json and managed-mcp.json, staged in `<dir>` for an
 * administrator to install. MELRA never writes Claude Code's own managed
 * folder and never runs sudo; it prints the lines that do. A file already in
 * `<dir>` that says something else is refused, not replaced.
 */
async function managedSetup(args: string[], env: CliEnvironment): Promise<number> {
  const directory = resolve(argument("--managed", args) ?? "");
  // As written and as on disk, so neither a link nor another case gets in.
  if (within(resolve(claudeManagedDirectory()), directory)) {
    throw new Error(`--managed must name a staging folder outside ${claudeManagedDirectory()}, where Claude Code reads them; MELRA never writes there`);
  }
  const launch = serverLaunch(import.meta.dirname, PRODUCT_VERSION);
  const self = selfCommand();
  const files = claudeManagedFiles({
    ...managedLaunch(launch.command === "npx" ? launch : { command: self.command, args: [...self.args, "serve"] }, homedir()),
    // MELRA_POLICY only when one is named: the default would be in this
    // user's MELRA_HOME, which the server finds there by itself.
    env: { ...serverEnvironment(env, env.policyPath), MELRA_HARNESS_TOOLS: "1" },
  });
  const staged = Object.fromEntries(Object.keys(files).map((name) => [name, join(directory, name)]));
  const fresh: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    const path = join(directory, name);
    const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing === undefined) fresh.push(name);
    else if (existing !== text) {
      throw new Error(`managed_file_differs: ${path} already exists and says something else; move it away or name an empty folder`);
    }
  }
  const dryRun = args.includes("--dry-run");
  if (!dryRun) {
    await mkdir(directory, { recursive: true });
    for (const name of fresh) await writeFile(join(directory, name), files[name] ?? "", { flag: "wx", mode: 0o644 });
  }
  printJsonOrHuman(
    {
      client: "claude-code",
      managed: directory,
      written: !dryRun,
      files: Object.entries(files).map(([name, text]) => ({
        path: join(directory, name),
        text,
        sha256: createHash("sha256").update(text).digest("hex"),
      })),
      install: installLines(staged),
    },
    renderManaged,
    args,
  );
  return 0;
}

// Where `--dry-run` shows the config file a real launch writes and removes.
const MCP_CONFIG_PLACEHOLDER = "<mcp-config.json>";

/**
 * Starts Claude Code with melra as its only MCP server and no built-in tool
 * that changes anything, so MELRA's tools are the agent's only way to change
 * anything.
 * The server is this very melra, by absolute path, with the workspace, policy
 * and mode every other command here would use, and MELRA_LAUNCHED, so its
 * defaults leave out the commands that run any program. Exits as claude does.
 * A `claude` started any other way is unchanged.
 */
async function launch(args: string[], env: CliEnvironment): Promise<number> {
  // Everything after `--` is claude's, and refused unless it is on the list.
  const split = args.indexOf("--");
  const own = split < 0 ? args : args.slice(0, split);
  const passed = split < 0 ? [] : args.slice(split + 1);
  rejectUnknownFlags(own, ["--dry-run", "--claude-bin"]);
  if (positionals(own, ["--claude-bin"]).join(" ") !== "claude-code") {
    throw new Error("launch supports only claude-code: melra launch claude-code [--dry-run] [-- <claude arguments>]");
  }
  const named = argument("--claude-bin", own);
  if (own.includes("--claude-bin") && (named === undefined || named.trim() === "" || named.startsWith("--"))) {
    throw new Error("--claude-bin requires a path");
  }
  const claude = await claudeProgram(named ?? (process.env.CLAUDE_BIN?.trim() || "claude"));
  const planned = claudeLaunchArgv(MCP_CONFIG_PLACEHOLDER, passed);
  const reader = questions(own);
  if (!(await workspaceAgreed(env, reader).finally(() => reader?.close()))) return 1;
  if (!(await stat(env.workspaceRoot).catch(() => undefined))?.isDirectory()) {
    throw new Error(`workspace not found: ${env.workspaceRoot}`);
  }
  const policyPath = await existingPolicyPath(env);
  // Neither claude nor the server it starts gets the payload key or the HTTP
  // token. A key held only in the variable has to be in the file first, or
  // the server would be given a new one beside it (#417).
  const agentEnvironment = withoutKernelSecrets(process.env);
  const keyFile = join(env.dataDirectory, "payload.key");
  if (process.env.MELRA_PAYLOAD_KEY?.trim() && (await lstat(keyFile).catch(() => undefined)) === undefined) {
    throw new Error(`payload_key_missing: melra launch does not pass MELRA_PAYLOAD_KEY on; write the key to ${keyFile} (mode 0600)`);
  }
  // The server claude will start, opened and closed here first, so one that
  // would refuse to start stops here, not in claude's log, and the summary
  // lists what it will allow.
  const melra = await runtime(env, { ...agentEnvironment, MELRA_LAUNCHED: "1" });
  const policy = melra.policy;
  await melra.close();
  const self = selfCommand();
  const mcpConfig = clientConfig("claude-code", {
    command: self.command,
    args: [...self.args, "serve"],
    env: {
      ...serverEnvironment(env, policyPath),
      ...(env.unhinged ? { MELRA_UNHINGED: "1" } : {}),
      MELRA_HARNESS_TOOLS: "1",
      MELRA_LAUNCHED: "1",
    },
  });
  const summary = renderLaunch({
    mode: policy.mode,
    unhinged: policy.unhinged,
    workspace: env.workspaceRoot,
    allowedCommands: policy.allowedCommands,
    ...(policyPath === undefined ? {} : { policyPath }),
  });
  process.stderr.write(summary);
  if (own.includes("--dry-run")) {
    output({
      command: claude,
      args: planned,
      cwd: env.workspaceRoot,
      mcpConfig,
      note: `a launch writes mcpConfig to a private temporary file, passes its path for ${MCP_CONFIG_PLACEHOLDER}, and removes it when claude exits`,
    });
    return 0;
  }
  const directory = await mkdtemp(join(tmpdir(), "melra-launch-"));
  try {
    const file = join(directory, "mcp.json");
    await writeFile(file, `${JSON.stringify(mcpConfig, null, 2)}\n`, { mode: 0o600 });
    const child = spawn(claude, claudeLaunchArgv(file, passed), {
      cwd: env.workspaceRoot,
      env: agentEnvironment,
      stdio: "inherit",
    });
    // Ctrl-C reaches claude from the terminal, and claude decides what it
    // means; this process waits for it, so the file is removed after it.
    // A hangup stops it as SIGTERM does, or this process would die at once and
    // leave claude and the file behind.
    const wait = () => undefined;
    const stop = () => child.kill("SIGTERM");
    process.on("SIGINT", wait);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", stop);
    try {
      return await new Promise<number>((exited, failed) => {
        child.once("error", (error: NodeJS.ErrnoException) =>
          failed(
            error.code === "ENOENT"
              ? new Error(`claude_not_found: ${claude}; install Claude Code 2.1.296 or later, or name it with CLAUDE_BIN or --claude-bin`)
              : error,
          ),
        );
        child.once("exit", (code) => exited(code ?? 1));
      });
    } finally {
      process.off("SIGINT", wait);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runTask(args: string[], env: CliEnvironment): Promise<number> {
  const melra = await runtime(env);
  try {
    const task = melra.controller.plan(await readTaskRequest(args));
    if (task.status === "policy_blocked") {
      output({ task });
      return 4;
    }
    if (task.status === "awaiting_approval") {
      if (!process.stdin.isTTY) {
        output({ task, next: "rerun interactively to approve this scoped action" });
        return 3;
      }
      // Shown the effect and asked, rather than made to retype a phrase that
      // proves only that someone typed it.
      const approver = approverLabel(env);
      const view = melra.controller.approvalView(task.id);
      if (!(await confirmInTerminal(view))) return 1;
      melra.controller.decide(task.id, view.renderDigest, approver);
      return printRun(await melra.controller.execute(task.id), melra.controller.enforced);
    }
    return printRun(await melra.controller.execute(task.id), melra.controller.enforced);
  } finally {
    await melra.close();
  }
}

/**
 * Prints a task `melra run` ran and returns its exit code. One waiting on a
 * semantic question is not a failure but a person's turn, as an approval is:
 * it exits 5, not 2, and `next` holds the command that answers each of its
 * judgements, one per line (#404). A task that ran enforced takes a verdict
 * only from an enforced process, so its commands ask for one. The verdict is
 * last and left as `<yes|no|cannot_tell>`, which a shell refuses to parse:
 * pasted as `--verdict yes|no|cannot_tell`, it ran `melra judge ... --verdict
 * yes` piped into two missing commands, and so recorded a yes nobody chose.
 */
function printRun(execution: ExecutionResult, enforced: boolean): number {
  const { task } = execution;
  if (task.status === "waiting_user") {
    const mode = enforced ? " --mode enforced" : "";
    output({
      ...execution,
      next: (task.judgements ?? [])
        .map((entry) => `melra judge ${task.id} --judgement ${entry.judgementId}${mode} --verdict <yes|no|cannot_tell>`)
        .join("\n"),
    });
    return 5;
  }
  output(execution);
  // Execute's own policy check, as when a grant expired or was spent while
  // the prompt was open, blocks it as plan's does: nothing ran.
  if (task.status === "policy_blocked") return 4;
  return task.status === "verified_success" ? 0 : 2;
}

/**
 * The task a whole id or a prefix names: `melra tasks` shows the first eight
 * characters, so a prefix naming one task (in `status`, if given) is enough,
 * however old it is. A prefix two tasks share, or none, is refused rather than
 * guessed; an empty argument, as an unset `"$ID"` sends, names nothing.
 */
function resolveTaskId(melra: MelraRuntime, given: string, status?: TaskStatus): string {
  if (given.length >= 36) return given;
  const matching = given === "" ? [] : melra.store.taskIdsWithPrefix(given, 2, status);
  if (matching.length > 1) throw new Error(`task_id_ambiguous:${given}`);
  if (matching.length === 0) throw new Error(`task_not_found:${given}`);
  return matching[0]!;
}

/**
 * Records an approval for a task another process planned, without running it:
 * the agent that planned it runs it, and the decision lets it.
 */
async function approveCommand(args: string[], env: CliEnvironment): Promise<number> {
  const [given] = positionals(args, ["--reason", "--note"]);
  if (given === undefined) throw new Error("approve requires a task ID");
  const reason = argument("--reason", args);
  const note = argument("--note", args);
  if (!args.includes("--deny") && (reason !== undefined || note !== undefined)) {
    throw new Error("--reason and --note go with --deny");
  }
  // Checked before anything opens the store, so a typo records nothing.
  const denial = DenialInputSchema.parse({
    ...(reason === undefined ? {} : { reason }),
    ...(note === undefined ? {} : { note }),
  });
  const approver = approverLabel(env);
  const melra = await runtime(env);
  try {
    const taskId = resolveTaskId(melra, given, "awaiting_approval");
    const view = melra.controller.approvalView(taskId);
    if (args.includes("--deny")) {
      // Not cancelled when another process started it in the meantime.
      const task = melra.controller.deny(taskId, approver, denial);
      output({ task });
      return task.status === "cancelled" ? 0 : 1;
    }
    if (!args.includes("--yes")) {
      if (!process.stdin.isTTY || args.includes("--json")) {
        output({
          taskId,
          renderDigest: view.renderDigest,
          contract: view.contract,
          next: "rerun with --yes to approve, or in a terminal to be asked",
        });
        return 3;
      }
      if (!(await confirmInTerminal(view))) return 1;
    }
    const decision = melra.controller.decide(taskId, view.renderDigest, approver);
    if (decision.channel === "in_band") {
      process.stderr.write(
        "Recorded in band: this process is in developer mode. Set \"mode\": \"enforced\" in the policy file (or MELRA_MODE=enforced) for the server and for this command. An enforced server will not run on this decision: a workflow plans the step again once the challenge expires; a single task needs --deny and planning again.\n",
      );
    }
    output({ decision });
    return 0;
  } finally {
    await melra.close();
  }
}

/**
 * Answers a waiting task's semantic question as the operator (#54). The
 * question and the result are what `melra inspect` prints; ids are taken
 * whole, so a verdict never lands on a question nobody named.
 */
async function judgeCommand(args: string[], env: CliEnvironment): Promise<number> {
  const [taskId] = positionals(args, ["--judgement", "--verdict", "--rationale"]);
  if (taskId === undefined) throw new Error("judge requires a task ID");
  const judgementId = argument("--judgement", args);
  const given = argument("--verdict", args);
  if (judgementId === undefined || given === undefined) {
    throw new Error("judge requires --judgement <id> --verdict yes|no|cannot_tell; melra inspect <task-id> lists the judgements");
  }
  const operator = approverLabel(env);
  const verdict = SemanticVerdictSchema.parse(given);
  const rationale = argument("--rationale", args);
  const melra = await runtime(env);
  try {
    let judged: ReturnType<typeof melra.controller.judge>;
    try {
      judged = melra.controller.judge(
        { taskId, judgementId, verdict, ...(rationale === undefined ? {} : { rationale }) },
        { operator },
      );
    } catch (error) {
      // `judge` refuses the channel only once every other check held (#384),
      // so the rerun this asks for would be taken.
      if (!melra.controller.enforced && error instanceof Error && error.message === "judgement_in_band_refused") {
        throw new Error(
          "judgement_in_band_refused: the task ran in enforced mode; rerun with --mode enforced or MELRA_MODE=enforced",
        );
      }
      // This command's own startup settles an expired wait before the verdict
      // reaches `judge`, which then sees only a settled task (#383).
      if (error instanceof Error && error.message.startsWith("task_not_awaiting_judgement:")) {
        const task = melra.controller.status(taskId);
        const named = task.judgements?.find((entry) => entry.judgementId === judgementId);
        if (
          task.error === "semantic_judgement_expired" &&
          named !== undefined &&
          named.judgedBy === undefined &&
          Date.parse(named.expiresAt) <= Date.now()
        ) {
          throw new Error("judgement_expired");
        }
      }
      throw error;
    }
    const recorded = judged.task.judgements?.find((entry) => entry.judgementId === judgementId)?.judgedBy;
    if (recorded?.channel === "in_band") {
      process.stderr.write(
        "Recorded in band: this process, or the one the task ran under, is in developer mode. Set \"mode\": \"enforced\" in the policy file (or MELRA_MODE=enforced) for the server and for this command to judge out of band.\n",
      );
    }
    output(judged);
    return 0;
  } finally {
    await melra.close();
  }
}

async function inspectTask(args: string[], env: CliEnvironment): Promise<void> {
  const [given] = positionals(args);
  if (given === undefined) throw new Error("inspect requires a task ID");
  const melra = await runtime(env);
  try {
    // They only read, so the prefix `melra tasks` shows is enough, as for
    // `approve`, in any status; `judge` still takes ids whole.
    const taskId = resolveTaskId(melra, given);
    output({
      task: melra.controller.status(taskId),
      ...melra.controller.receipts({ taskId }),
    });
  } finally {
    await melra.close();
  }
}

async function policyTest(args: string[], env: CliEnvironment): Promise<void> {
  // With the evidence the server derives for a mutation that declares none, as
  // plan does: without it, a file write the server would ask approval for was
  // previewed as denied for want of evidence.
  const request = withDefaultEvidence(await readTaskRequest(args));
  // Reports what this process would actually decide, unhinged mode included —
  // a dry run that disagreed with the server it is previewing is worse than
  // none. That is also why the operator's own `policy.json` is loaded rather
  // than the defaults: `serve` reads it, so a preview that ignored it would
  // answer for a policy nobody is running.
  const policy = {
    ...(await loadPolicy(await existingPolicyPath(env), env.workspaceRoot)),
    workspaceRoot: env.workspaceRoot,
    unhinged: env.unhinged,
    mode: env.mode,
  };
  const taskId = "00000000-0000-4000-8000-000000000000";
  // Metered grants are counted from the same database the server draws them
  // down in, so a preview cannot report a budget as full when it is spent — and
  // policy refuses a metered grant outright when nothing can count it.
  const store = new SqliteStore(join(env.dataDirectory, "melra.sqlite"));
  try {
    // The decision carries effect, risk, and traits; the classification adds the
    // capability and target it was made against, so a surprising verdict can be
    // traced to what MELRA thought the request was touching.
    const { capability, target } = classifyOperation(request.operation);
    output({
      ...evaluatePolicy(taskId, request, policy, capabilityUsageReader(store)),
      classified: { capability, target },
      requiredEvidence: request.requiredEvidence,
    });
  } finally {
    store.close();
  }
}

/**
 * The clients an operator has approved over OAuth, and the way to take that
 * back. Reads the same file the server writes, so it works while the server is
 * down — which is when someone most wants to withdraw an approval.
 */
function clientsCommand(args: string[], env: CliEnvironment): number {
  const oauth = new OAuthProvider(env.dataDirectory);
  const revoke = argument("--revoke", args);
  if (args.includes("--revoke")) {
    // A bare --revoke listed the clients and exited 0, and a mistyped id
    // reported a revocation that touched nothing.
    if (revoke === undefined || revoke.trim() === "") {
      throw new Error("--revoke requires a client id, or all");
    }
    if (revoke !== "all" && !oauth.clients().some((client) => client.id === revoke)) {
      throw new Error(`no such client: ${printable(revoke)}; 'melra clients' lists them`);
    }
    const dropped = oauth.revoke(revoke === "all" ? undefined : revoke);
    process.stdout.write(
      `Revoked ${dropped} token${dropped === 1 ? "" : "s"}. ` +
        `${revoke === "all" ? "Every client" : "The client"} must be approved again before it can act.\n`,
    );
    return 0;
  }
  const clients = oauth.clients();
  if (clients.length === 0) {
    process.stdout.write("No client has registered against this data directory.\n");
    return 0;
  }
  for (const client of clients) {
    process.stdout.write(
      `${client.approvedAt === undefined ? "pending " : "approved"}  ` +
        `${client.id}  ${printable(client.name)}\n` +
        `          ${principalRef(clientPrincipal(client))}\n`,
    );
  }
  process.stdout.write(
    `\nRevoke one with 'melra clients --revoke <client-id>', or all of them\n` +
      `with 'melra clients --revoke all'.\n`,
  );
  return 0;
}

/**
 * Hands the console URL to whatever opens links here, and says whether anything
 * took it: the helper ran and, if it finished within a few seconds, succeeded.
 *
 * The URL goes on the helper's command line, which other local users can read,
 * so it carries a code that opens the console once, never the standing token:
 * `serve`'s `openUrl`, or `melra console`'s pairing code. `serve --open`
 * ignores a failure on purpose: the URL is already on screen, and a server
 * that refused to start because a desktop helper is missing would be worse
 * than one you click into. `melra console` prints no URL, so it has to know.
 */
function openInBrowser(url: string): Promise<boolean> {
  const [command, ...prefix] =
    process.platform === "darwin"
      ? ["open"]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", ""]
        : ["xdg-open"];
  const child = spawn(command!, [...prefix, url], {
    env: withoutKernelSecrets(process.env),
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return new Promise((resolveOpened) => {
    // ponytail: a helper still running after 3s is taken to have handed the URL
    // on; some xdg-open fallbacks only return when the browser closes.
    const handedOn = setTimeout(() => resolveOpened(true), 3_000);
    handedOn.unref();
    child.once("error", () => resolveOpened(false));
    child.once("exit", (code) => {
      clearTimeout(handedOn);
      resolveOpened(code === 0);
    });
  });
}

function help(): void {
  process.stdout.write(`MELRA ${PRODUCT_VERSION}

Usage:
  melra setup [--client <name>] [--write] [--json]
  melra setup --client claude-code --exclusive [--write | --managed <dir>]
              [--dry-run] [--json]
  melra doctor [--json]
  melra conformance [--url <mcp-url> --token <token>] [--level <1|2|3>]
  melra init [--client <name>] [--write] [--json]
  melra serve [--http [--port <port>] [--open]]
  melra serve --socket <path>
  melra launch claude-code [--dry-run] [--claude-bin <path>]
                           [-- <claude arguments>]
  melra probe [--socket <path> | --url <loopback-url>] [--public <host:port>]
              [--local <host:port>] [--json]
  melra run --request <task.json>
  melra approve <task-id> [--yes] [--json]
  melra approve <task-id> --deny [--reason wrong_target|too_broad|not_now|never|other]
                                 [--note <text>]
  melra judge <task-id> --judgement <id> --verdict yes|no|cannot_tell
                        [--rationale <text>]
  melra console
  melra inspect <task-id>
  melra tasks [--limit <n>] [--status <status>] [--json]
  melra watch [--json]
  melra status [--json]
  melra workflow plan --definition <workflow.json>
  melra workflow advance <workflow-id> [--approval <id>:<exact-phrase>]
                                       [--input <node-id>=<value>]
                                       (--approval: developer mode; enforced:
                                       melra approve <task-id>, then advance;
                                       --input answers as the operator)
  melra workflow inspect <workflow-id>
  melra workflow cancel <workflow-id>
  melra workflow pause|resume|suspend <workflow-id>
  melra demo durable-core
  melra clients [--revoke <client-id|all>]
  melra policy test --request <task.json>
  melra version [--json]

'melra run' exits 0 when the task is verified_success, 2 when it ran and is
not (partial, failed, recovery_required and the like), 3 when it needs an
approval and there is no terminal to ask in, 4 when policy blocks it, and 5
when it waits on a semantic judgement, with 'next' holding the 'melra judge'
command for each of its judgements, one per line, its verdict left for you to
fill in. An error, or a no at its prompt, exits 1.

'melra launch claude-code' starts Claude Code with melra as its only MCP
server and Read, Glob and Grep as its only built-in tools, so MELRA's tools
are the only ones it has that change anything. It prints what the session can
and cannot do on stderr first, and exits as claude does. After '--' it passes
on only a prompt, -p/--print, --model, --output-format, --verbose,
-c/--continue and -r/--resume, and refuses anything else. --dry-run prints the
claude command and MCP config instead of running them. CLAUDE_BIN or
--claude-bin names the claude to run, a relative path from here (default:
claude in one of PATH's absolute directories). Neither claude nor the server
it starts gets MELRA_PAYLOAD_KEY or MELRA_HTTP_TOKEN, so a payload key must be
in MELRA_HOME/payload.key.

'melra probe', run inside an agent's box before the agent starts, tries what
the box should stop and reports each as confined or open: creating and
removing a file in the workspace, opening the database and key in MELRA_HOME
(set it to the server's, as the box sees it), a TCP connection to --public
(default: 1.1.1.1:443) and to another local port (default: one it listens on
itself; --local names one), and starting the shell. It sends nothing over
those connections. Only a refusal counts as confined; what it could not try
is open, 'not tested'. It then checks that the MELRA running outside the box
answers on --socket (or MELRA_SOCKET) or --url, asking without a token. It
exits 0 only when every check is confined and MELRA answers.

'melra console', run by you in a terminal, opens an approval console in your
browser, on a server of its own with no MCP endpoint, that approves or denies
as 'melra approve' does. It pairs with the first page to use its code, normally
the tab it opens. Its one-time pairing code is never printed: it reaches the
browser on its opener's command line, and reloading or leaving the page ends
the pairing. Run it with the MELRA_HOME, MELRA_WORKSPACE and mode your agent's
server uses, and its MELRA_PAYLOAD_KEY if it sets one. Without a terminal or a
browser to open, it refuses to start.

'melra setup --client claude-code --exclusive' also denies Claude Code's own
tools that change anything or reach the network (Bash, PowerShell, Monitor,
Edit, Write, NotebookEdit, WebFetch, WebSearch and the rest of a list pinned
to its documentation) and sets MELRA_HARNESS_TOOLS=1 in the melra entry. With
--write it merges the deny list into .claude/settings.local.json in the
workspace, keeping every rule there and saving the old file as .bak; the
agent's own user can edit that file. With --managed <dir> it instead writes
managed-settings.json (the same list, plus allowManagedPermissionRulesOnly,
allowManagedHooksOnly and permissions.disableBypassPermissionsMode) and a
managed-mcp.json listing only melra, by absolute path, into <dir>, refuses to
replace a file there that says something else, and prints the 'sudo install'
lines that put them where Claude Code reads managed settings and each file's
SHA-256. It refuses an npx melra, or one or a node inside your home folder.
MELRA never writes that system folder itself. --dry-run prints what either
would write and writes nothing. 'melra doctor' then reports what Claude Code
would read (harness).

In a terminal, doctor, setup, init, and version print a readable report, and
'melra setup' with no --client asks which detected client to set up. Piped or
captured, they print JSON (version: the bare number).

The workspace setup and init write into the config is the current directory,
unless MELRA_WORKSPACE (or a MELRA_POLICY file's workspaceRoot) names one. If
that is your home directory, a directory holding it, or a filesystem root,
they ask first in a terminal, and refuse with workspace_too_broad otherwise;
setting MELRA_WORKSPACE to it skips the question.

Flags:
  --json           Print JSON even in a terminal, and never ask a question.
  --client <name>  Emit the MCP config in this client's own format and say
                   where it goes: claude-code (or claude), claude-desktop,
                   cursor, vscode, windsurf, codex, gemini, zed, cline,
                   opencode, kiro, goose, continue, amp, openclaw, hermes,
                   copilot, qwen, auggie, warp, junie, droid, kimi, kilo,
                   lmstudio, or generic (default).
  --write          With --client, merge the config into that client's file,
                   keeping everything else and saving the old file as .bak.
  --exclusive      With --client claude-code: also deny Claude Code's own
                   tools that change anything (see above).
  --managed <dir>  With --exclusive: stage Claude Code's managed settings in
                   <dir> and print the lines that install them.
  --dry-run        With --exclusive: print what would be written; write
                   nothing. For 'launch', see above.
  --unsafe-local   Run with no policy and no guardrails. Everything the OS user
                   can do, any caller can now do. Same as MELRA_UNHINGED=1.
                   Refused outright when --mode enforced. Was --unhinged, which
                   still works and warns.
  --mode <m>       developer (default) or enforced. Enforced is you asserting
                   the harness has no other path to these systems: MELRA then
                   refuses --unsafe-local, refuses any bind off loopback, and
                   admits no self-registering client. Stamped on every receipt.
  --http           Serve MCP over loopback HTTP instead of stdio, alongside a
                   read-only REST API, a workflow event stream, and the console.
                   Prints a bearer token; every request must carry it.
  --port <port>    HTTP port, with --http (default: 7457, or MELRA_HTTP_PORT).
  --socket <path>  Serve what --http serves on a Unix socket created mode 0600,
                   so only this OS user can connect; the token is still
                   required. Not on Windows. This flag, not MELRA_SOCKET,
                   moves 'serve' off stdio. For 'probe', the socket MELRA
                   should answer on (default: MELRA_SOCKET).
  --open           With --http, open the console in your browser once it is
                   listening.
  --url <mcp-url>  Endpoint for 'conformance'. Default: spawn 'melra serve'.
                   For 'probe', a loopback http:// URL; only its origin is used.
  --public <host:port>
                   For 'probe': the public address to connect to (default:
                   1.1.1.1:443).
  --local <host:port>
                   For 'probe': another local port to connect to (default:
                   one it listens on, on 127.0.0.1).
  --level <1|2|3>  Conformance level being claimed (default: 3). The run exits
                   non-zero if the endpoint falls short of it.
  --json           For tasks, watch, status, and probe: JSON (NDJSON for
                   watch) even in a terminal. Output that is not a terminal is
                   JSON anyway.
  --limit <n>      How many recent tasks 'tasks' lists (default: 20, max 500).
  --status <s>     Only tasks in this status, e.g. awaiting_approval.

Environment:
  MELRA_WORKSPACE  Workspace boundary (default: a MELRA_POLICY file's
                   workspaceRoot, else the current directory)
  MELRA_HOME       Local database and artifact directory
  MELRA_POLICY     Optional local policy JSON
  MELRA_UNHINGED   Set to 1 to disable every guardrail (see --unsafe-local)
  MELRA_MODE       developer (default) or enforced (see --mode)
  MELRA_APPROVER   Name 'melra approve', 'melra judge', 'melra console',
                   'melra workflow pause|suspend|resume' and 'melra workflow
                   advance --input' record as the approver, judge, actor or
                   answerer (default: operator)
  MELRA_HTTP_PORT  Port for 'serve --http' (default: 7457)
  MELRA_HTTP_TOKEN Fixed bearer token for 'serve --http' (default: random)
  MELRA_HTTP_OAUTH Set to 0 so only that token gets in; no client can register
  MELRA_SOCKET     Socket path 'doctor' and 'status' check and 'probe' asks
                   (serve needs --socket)
  MELRA_BROWSER    Optional Chrome/Chromium/Edge executable
  MELRA_BROWSER_CDP_ENDPOINT       Optional HTTP(S) CDP endpoint
  MELRA_BROWSER_CDP_CONTEXT_INDEX  External context index (-1 is last)
  MELRA_BROWSER_HAR_PATH           Absolute HAR output path
  MELRA_BROWSER_HAR_REPLAY         Absolute HAR to replay; nothing hits network
  MELRA_BROWSER_PROFILE            Absolute dir keeping cookies between runs
  MELRA_PAYLOAD_KEY                Payload key, base64url (default:
                                   <MELRA_HOME>/payload.key); back it up
  MELRA_HARNESS_TOOLS              Set to 1 to add read_file, run_command and
                                   the other plain tool names
  MELRA_LAUNCHED                   Set to 1 by 'melra launch': node, npm, npx
                                   and pnpm only if the policy file lists them
`);
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const parsed = parseCliEnvironment(process.env);
  // `--unsafe-local` is an alias for the variable, not a second setting: one
  // field carries the answer so no code path can consult the weaker of the two.
  // `--unhinged` was the original name and still works — it undersold what it
  // does, being a mood rather than a description, so it says so and moves on.
  const deprecated = args.includes("--unhinged");
  if (deprecated) {
    process.stderr.write(
      "melra: --unhinged is deprecated; use --unsafe-local. It is not a mood, " +
        "it is an opt-out of the entire safety model.\n",
    );
  }
  const modeFlag = argument("--mode", args);
  // `--mode "$MODE"` with MODE unset, or a --mode with nothing after it, read
  // as developer: an operator who meant enforced got a normal-looking start
  // in the mode that lets the agent approve its own effects.
  if (
    args.includes("--mode") &&
    (modeFlag === undefined || modeFlag.trim() === "" || modeFlag.startsWith("--"))
  ) {
    throw new Error("--mode requires developer or enforced");
  }
  // Only the first is read, so a second one, blank or enforced, was ignored:
  // `melra serve --mode developer "$@"` with `--mode enforced` ran developer.
  if (args.filter((value) => value === "--mode").length > 1) {
    throw new Error("--mode given more than once");
  }
  const requested: CliEnvironment = {
    ...parsed,
    unhinged:
      parsed.unhinged || deprecated || args.includes("--unsafe-local"),
    // The strictest of the flag and the variable, as for the policy file below:
    // `--mode developer` does not undo MELRA_MODE=enforced.
    ...(modeFlag === undefined || namedDeploymentMode(modeFlag, "--mode") === "developer"
      ? {}
      : { mode: "enforced" as const }),
  };
  // Before the banner: a process that refuses to start has no guardrails to warn
  // about, and printing the unsafe-local warning first would read as if it had
  // taken effect. On the flags and variables only: a policy file that asks for
  // both is the server's to refuse, naming the file, and `doctor` still runs.
  assertEnforceable(requested.mode, requested.unhinged);
  const env = await settle(requested);
  // Before the command runs, and for every command including `help` — the mode
  // is a property of the process, so there is no invocation where staying quiet
  // about it is right.
  if (env.unhinged) {
    process.stderr.write(
      `${unsafeLocalBanner(unconfinedRoot(env.workspaceRoot))}\n`,
    );
  }
  switch (command) {
    case "doctor": {
      rejectUnknownFlags(args, ["--json"]);
      const { report, failed } = await doctor(env);
      printJsonOrHuman(report, renderDoctor, args);
      process.exitCode = failed ? 1 : 0;
      return;
    }
    case "conformance": {
      rejectUnknownFlags(args, ["--url", "--token", "--level", "--json"]);
      const level = argument("--level", args);
      if (level !== undefined && !["1", "2", "3"].includes(level)) {
        throw new Error("--level must be 1, 2, or 3");
      }
      const url = argument("--url", args);
      const token = argument("--token", args);
      const { runConformance } = await import("./conformance.js");
      const { report, failed } = await runConformance({
        ...(url === undefined ? {} : { url }),
        ...(token === undefined ? {} : { token }),
        ...(level === undefined ? {} : { claim: Number(level) }),
        // This process's flags, which a server it spawns gets only as env.
        serverEnv: {
          ...(env.mode === "enforced" ? { MELRA_MODE: "enforced" } : {}),
          ...(env.unhinged ? { MELRA_UNHINGED: "1" } : {}),
        },
      });
      printJsonOrHuman(report as unknown as ConformanceReport, renderConformance, args);
      process.exitCode = failed ? 1 : 0;
      return;
    }
    case "init": {
      rejectUnknownFlags(args, ["--client", "--write", "--json"]);
      const reader = questions(args);
      if (!(await workspaceAgreed(env, reader).finally(() => reader?.close()))) {
        process.exitCode = 1;
        return;
      }
      printJsonOrHuman(await init(args, env), renderInit, args);
      return;
    }
    case "setup":
      rejectUnknownFlags(args, ["--client", "--write", "--json", "--exclusive", "--managed", "--dry-run"]);
      process.exitCode = await setup(args, env);
      return;
    case "serve": {
      rejectUnknownFlags(args, ["--http", "--port", "--open", "--socket"]);
      if (args.includes("--socket") && argument("--socket", args) === undefined) {
        throw new Error("--socket requires a path");
      }
      // Only the flag: an exported MELRA_SOCKET would otherwise move every
      // stdio client launched from that shell off stdio, to wait forever.
      const socketPath = argument("--socket", args);
      const http = args.includes("--http");
      const port = argument("--port", args);
      // One transport per process. Quietly preferring one would leave an
      // operator believing they had the other — and the difference between a
      // socket only they can open and a port anyone local can is the point.
      if (
        socketPath !== undefined &&
        // The flag, not its value: a --port with nothing after it is still one.
        (http || args.includes("--port") || args.includes("--open"))
      ) {
        throw new Error(
          "--socket replaces --http, --port, and --open; pass one transport",
        );
      }
      // The same mistake the other way round: without --http, serve speaks
      // stdio, and a port nobody listens on looks like a server that hangs.
      if (socketPath === undefined && !http && (args.includes("--port") || args.includes("--open"))) {
        throw new Error("--port and --open need --http; without it, serve speaks MCP over stdio");
      }
      // `--port "$PORT"` with PORT unset is Number(""), which is 0: a random
      // port on every start, the bug a blank MELRA_HTTP_PORT had.
      if (args.includes("--port") && (port === undefined || port.trim() === "")) {
        throw new Error(
          "--port requires a port; leave it out for the default (7457, or MELRA_HTTP_PORT), or pass 0 for any free port",
        );
      }
      const { serveHttp, serveStdio } = await import("@melra/server");
      const melra = await runtime(env);
      const server =
        http || socketPath !== undefined ? undefined : await serveStdio(melra);
      const endpoint =
        socketPath !== undefined
          ? await serveHttp({ runtime: melra, socketPath })
          : http
            ? await serveHttp({
                runtime: melra,
                ...(port === undefined ? {} : { port: Number(port) }),
              })
            : undefined;
      if (endpoint?.socketPath !== undefined) {
        process.stderr.write(
          `MELRA server listening on Unix socket ${endpoint.socketPath} (mode 0600)\n` +
            `  MCP:      ${endpoint.mcpUrl}, connecting to that socket\n` +
            `  Token:    ${endpoint.token}\n` +
            `  Try:      curl --unix-socket ${endpoint.socketPath} -H 'Authorization: Bearer <token>' http://localhost/api/capabilities\n` +
            `Only this OS user can connect; the token is still required on every\n` +
            `request. OAuth is off: no browser can reach a socket to approve a client.\n` +
            (env.mode === "enforced"
              ? `Enforced mode: --unsafe-local is refused. Every receipt says 'enforced'.\n`
              : ""),
        );
      } else if (endpoint !== undefined) {
        // stdout stays clean for the stdio transport's sake even here, so the
        // one command an operator has to copy goes where they can read it.
        process.stderr.write(
          `MELRA HTTP server listening on http://${endpoint.host}:${endpoint.port}\n` +
            `  Console:  ${endpoint.url}\n` +
            `  MCP:      ${endpoint.mcpUrl}\n` +
            `  Token:    ${endpoint.token}\n` +
            (endpoint.oauth
              ? `A client that cannot be given the token can register itself and ask\n` +
                `you to approve it in a browser, with the token above; approved clients\n` +
                `are named on every receipt. Set MELRA_HTTP_OAUTH=0 to allow only the token.\n`
              : `OAuth is off, so the token above is the only way in.\n`) +
            (env.mode === "enforced"
              ? `Enforced mode: loopback only, no client can register itself, and\n` +
                `--unsafe-local is refused. Every receipt says 'enforced'.\n`
              : "") +
            `Loopback only. Anyone who can read this token can drive this machine.\n`,
        );
        if (args.includes("--open") && endpoint.openUrl !== undefined) void openInBrowser(endpoint.openUrl);
      }
      const close = async () => {
        await server?.close();
        await endpoint?.close();
        await melra.close();
      };
      process.once("SIGINT", () => void close().finally(() => process.exit(0)));
      process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
      // A hangup (its terminal closing) too: by default it ends the process
      // with no exit event, leaving the package caches in temp.
      process.once("SIGHUP", () => void close().finally(() => process.exit(0)));
      return;
    }
    case "launch":
      process.exitCode = await launch(args, env);
      return;
    case "probe": {
      const valued = ["--socket", "--url", "--public", "--local"];
      rejectUnknownFlags(args, ["--json", ...valued]);
      for (const flag of valued) {
        const value = argument(flag, args);
        if (args.includes(flag) && (value === undefined || value.trim() === "" || value.startsWith("--"))) {
          throw new Error(`${flag} requires a value`);
        }
      }
      const url = argument("--url", args);
      const socketPath = argument("--socket", args) ?? env.socketPath;
      if (url !== undefined && args.includes("--socket")) throw new Error("--url and --socket name two endpoints; pass one");
      const publicTarget = argument("--public", args);
      const local = argument("--local", args);
      const { probeChecks, renderProbe, runProbe } = await import("./probe.js");
      const { checks, melra } = probeChecks({
        workspace: env.workspaceRoot,
        // Only a MELRA_HOME set here: the default is this box's own ~/.melra,
        // which says nothing about the server's.
        ...(env.homeSet === true ? { dataDirectory: env.dataDirectory } : {}),
        ...(publicTarget === undefined ? {} : { public: publicTarget }),
        ...(local === undefined ? {} : { local }),
        ...(url === undefined ? (socketPath === undefined ? {} : { socketPath: resolve(socketPath) }) : { url }),
      });
      const report = await runProbe(checks, melra);
      printJsonOrHuman(report, renderProbe, args);
      process.exitCode = report.passed ? 0 : 1;
      return;
    }
    case "run":
      rejectUnknownFlags(args, ["--request"]);
      // Failed until the task says otherwise: an effect that never returns
      // leaves the event loop empty, and Node exits with whatever the code is
      // then. It was 0, the code for verified_success.
      process.exitCode = 1;
      process.exitCode = await runTask(args, env);
      return;
    case "console": {
      rejectUnknownFlags(args, []);
      const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;
      // Before the runtime, which would open, and could create, the database.
      assertConsoleTerminal(interactive);
      const melra = await runtime(env);
      const endpoint = await approvalConsole(env, melra, {
        interactive,
        open: openInBrowser,
        say: (text) => process.stderr.write(text),
      }).catch(async (error: unknown) => {
        await melra.close();
        throw error;
      });
      const close = async () => {
        await endpoint.close();
        await melra.close();
      };
      process.once("SIGINT", () => void close().finally(() => process.exit(0)));
      process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
      // A hangup (its terminal closing) too: by default it ends the process
      // with no exit event, leaving the package caches in temp.
      process.once("SIGHUP", () => void close().finally(() => process.exit(0)));
      return;
    }
    case "approve":
      rejectUnknownFlags(args, ["--yes", "--deny", "--reason", "--note", "--json"]);
      process.exitCode = await approveCommand(args, env);
      return;
    case "judge":
      rejectUnknownFlags(args, ["--judgement", "--verdict", "--rationale"]);
      process.exitCode = await judgeCommand(args, env);
      return;
    case "inspect":
    case "export":
      rejectUnknownFlags(args, []);
      await inspectTask(args, env);
      return;
    case "tasks": {
      rejectUnknownFlags(args, ["--limit", "--status", "--json"]);
      // A trailing --status, as an unquoted `--status $S` sends with S unset,
      // listed every status: an unfiltered list that looked filtered.
      for (const flag of ["--limit", "--status"]) {
        const value = argument(flag, args);
        if (args.includes(flag) && (value === undefined || value.startsWith("--"))) {
          throw new Error(`${flag} requires a value`);
        }
      }
      const limit = Number(argument("--limit", args) ?? "20");
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new Error("--limit must be a whole number from 1 to 500");
      }
      const status = argument("--status", args);
      // Approvals are read by the window and mode a server started here would
      // use; a policy file that does not load leaves the defaults, and says so,
      // as status does: a server would refuse to start on it.
      const policyPath = await existingPolicyPath(env);
      let policy: LocalPolicy | undefined;
      let policyError: string | undefined;
      if (policyPath !== undefined) {
        try {
          policy = await loadPolicy(policyPath, env.workspaceRoot);
        } catch (error) {
          policyError = error instanceof Error ? error.message : String(error);
        }
      }
      const { tasksCommand } = await import("./activity.js");
      process.exitCode = tasksCommand(env, {
        limit,
        json: args.includes("--json"),
        ...(status === undefined ? {} : { status: TaskStatusSchema.parse(status) }),
        ...(policyError === undefined ? {} : { policyError }),
        window: {
          mode: env.mode === "enforced" || policy?.mode === "enforced" ? "enforced" : "developer",
          ...(policy?.approvalTtlMs === undefined ? {} : { approvalTtlMs: policy.approvalTtlMs }),
        },
      });
      return;
    }
    case "watch": {
      rejectUnknownFlags(args, ["--json"]);
      const { watchCommand } = await import("./activity.js");
      process.exitCode = await watchCommand(env, { json: args.includes("--json") });
      return;
    }
    case "status": {
      rejectUnknownFlags(args, ["--json"]);
      const policyPath = await existingPolicyPath(env);
      const { statusCommand } = await import("./activity.js");
      process.exitCode = await statusCommand(env, {
        json: args.includes("--json"),
        ...(policyPath === undefined ? {} : { policyPath }),
      });
      return;
    }
    case "workflow":
      rejectUnknownFlags(args, ["--definition", "--approval", "--input"]);
      // As for run: an advance that never returns does not exit 0.
      process.exitCode = 1;
      process.exitCode = await workflowCommand(args, env);
      return;
    case "demo":
      rejectUnknownFlags(args, []);
      // One demo today, so naming it is optional.
      if ((positionals(args)[0] ?? "durable-core") !== "durable-core") {
        throw new Error("demo supports only 'durable-core'");
      }
      process.exitCode = 1;
      process.exitCode = await durableCoreDemo(env);
      return;
    case "clients":
      rejectUnknownFlags(args, ["--revoke"]);
      process.exitCode = clientsCommand(args, env);
      return;
    case "policy":
      if (positionals(args, ["--request"])[0] !== "test") throw new Error("policy supports only 'test'");
      rejectUnknownFlags(args, ["--request"]);
      await policyTest(args, env);
      return;
    case "version":
    case "--version":
    case "-v":
      // `--json` keeps the bare version scripts already parse; a JSON object
      // here would break every `$(melra version)` in the wild.
      process.stdout.write(
        isHuman(args)
          ? `MELRA ${paint.bold(PRODUCT_VERSION)} ${paint.dim(`(Node ${process.version}, ${process.platform}-${process.arch})`)}\n`
          : `${PRODUCT_VERSION}\n`,
      );
      return;
    case "help":
    case "--help":
    case "-h":
      help();
      return;
    default:
      // No inline command list: the switch above is the only truth about what
      // exists, and a second copy here would rot the first time one is added.
      throw new Error(
        `unknown command: ${basename(command)}. Run 'melra --help' for the command list.`,
      );
  }
}

interface SchemaIssue {
  readonly path?: readonly (string | number)[];
  readonly message?: string;
}

/**
 * A schema rejection, rendered as one line per problem.
 *
 * Zod's `message` is the JSON dump of its issue array, so an input missing one
 * field used to fill the terminal with brackets and offsets. The useful part of
 * each issue is where it is and what is wrong with it.
 *
 * Detected by shape rather than `instanceof ZodError` so the CLI does not take
 * a direct zod dependency to print an error — every schema it parses comes from
 * `@melra/protocol`, and matching on `issues` also survives a major zod bump.
 */
function schemaIssues(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { issues } = error as { issues?: unknown };
  if (!Array.isArray(issues) || issues.length === 0) return undefined;
  const lines = (issues as SchemaIssue[]).map((issue) => {
    const path = (issue.path ?? [])
      .map((segment) =>
        typeof segment === "number" ? `[${segment}]` : `.${segment}`,
      )
      .join("")
      .replace(/^\./, "");
    const message = issue.message ?? "invalid value";
    return `  ${path === "" ? "(root)" : path}: ${message}`;
  });
  return ["input does not match the schema:", ...lines].join("\n");
}

main().catch((error) => {
  const message =
    schemaIssues(error) ??
    (error instanceof Error ? error.message : String(error));
  process.stderr.write(`melra: ${message}\n`);
  process.exitCode = 1;
});
