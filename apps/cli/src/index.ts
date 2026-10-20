#!/usr/bin/env node
// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { access, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ApprovalResponseSchema,
  TaskRequestSchema,
  TaskStatusSchema,
  WorkflowDefinitionSchema,
  WorkflowInputSchema,
  PRODUCT_VERSION,
  deploymentMode,
  principalRef,
  type ApprovalResponse,
  type TaskRequest,
  type WorkflowDefinition,
  type WorkflowInput,
  type WorkflowRun,
} from "@melra/protocol";
import {
  assertEnforceable,
  broadWorkspace,
  confinedRoot,
  createMelraRuntime,
  dataLocationAdvice,
  narrowWorkspaceAdvice,
  secretFiles,
  secretInsideWorkspace,
  serveHttp,
  OAuthProvider,
  clientPrincipal,
  printable,
  serveStdio,
  unconfinedRoot,
  workspaceHoldsData,
  workspaceInsideData,
  type MelraRuntime,
} from "@melra/server";
import { detectBrowserExecutable } from "@melra/browser-runtime";
import { createSystemComputerAdapter } from "@melra/computer-runtime";
import { capabilityUsageReader, withDefaultEvidence } from "@melra/runtime-core";
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
  parseCliEnvironment,
  serverLaunch,
} from "./environment.js";
import { approvalConsole, assertConsoleTerminal, confirmInTerminal } from "./approval-console.js";
import { runConformance } from "./conformance.js";
import { statusCommand, tasksCommand, watchCommand } from "./activity.js";
import { clientStatuses, clientsCheck, detectClients } from "./client-status.js";
import { RESTART_SAFE_WORKFLOW } from "./demo-workflow.js";
import { detectIsolation, isolationCheck } from "./isolation.js";
import {
  broadWorkspaceWarning,
  confirmBroadWorkspace,
  prompter,
  renderConformance,
  renderDoctor,
  renderInit,
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
  resolveClient,
  writeClientConfig,
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

async function runtime(env: CliEnvironment): Promise<MelraRuntime> {
  const policyPath = await existingPolicyPath(env);
  return await createMelraRuntime({
    workspaceRoot: env.workspaceRoot,
    dataDirectory: env.dataDirectory,
    unhinged: env.unhinged,
    mode: env.mode,
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
  const boolean = new Set(["--http", "--json", "--yes", "--deny", "--write", "--open"]);
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
  const [action, ...actionArgs] = args;
  const melra = await runtime(env);
  try {
    switch (action) {
      case "plan": {
        const run = melra.workflows.plan(
          await readWorkflowDefinition(actionArgs),
        );
        output(run);
        return workflowExitCode(run.status);
      }
      case "advance": {
        const workflowId = actionArgs[0];
        if (workflowId === undefined) {
          throw new Error("workflow advance requires a workflow ID");
        }
        const rest = actionArgs.slice(1);
        const result = await melra.workflows.advance(
          workflowId,
          workflowApprovals(rest),
          workflowInputs(rest),
        );
        output(result);
        return workflowExitCode(result.run.status);
      }
      case "inspect": {
        const workflowId = actionArgs[0];
        if (workflowId === undefined) {
          throw new Error("workflow inspect requires a workflow ID");
        }
        output(melra.workflows.status(workflowId));
        return 0;
      }
      case "cancel": {
        const workflowId = actionArgs[0];
        if (workflowId === undefined) {
          throw new Error("workflow cancel requires a workflow ID");
        }
        const run = melra.workflows.cancel(workflowId);
        output(run);
        return workflowExitCode(run.status);
      }
      case "pause":
      case "resume":
      case "suspend": {
        const workflowId = actionArgs[0];
        if (workflowId === undefined) {
          throw new Error(`workflow ${action} requires a workflow ID`);
        }
        const run =
          action === "pause"
            ? melra.workflows.pause(workflowId)
            : action === "suspend"
              ? melra.workflows.suspend(workflowId)
              : melra.workflows.resume(workflowId);
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
  const computer = await createSystemComputerAdapter().capabilities();
  checks.push({
    name: "computer",
    status: computer.available ? "pass" : "warn",
    detail: computer.available
      ? `${computer.adapter}: screenshot=${computer.screenshot}, pointer=${computer.pointer}, keyboard=${computer.keyboard}, scroll=${computer.scroll}`
      : computer.limitations.join("; "),
  });
  let credentials: LocalPolicy["credentials"] = {};
  try {
    const path = await existingPolicyPath(env);
    let allowLocalhost: boolean | undefined;
    // The server's own parser, so a bad `mode` or grant fails here too.
    if (path !== undefined) ({ credentials, allowLocalhost } = await loadPolicy(path, env.workspaceRoot));
    checks.push({
      name: "policy",
      status: "pass",
      detail: path ?? "using safe built-in defaults",
    });
    // Enforced mode keeps loopback closed unless the file opens it, so say so
    // when it does: the services this machine runs for itself are behind it.
    if (env.mode === "enforced" && allowLocalhost === true) {
      checks.push({
        name: "loopback",
        status: "warn",
        detail: `${path} sets allowLocalhost, so HTTP and browser effects can reach services on this machine's loopback`,
        next: `remove allowLocalhost from ${path} unless a task needs a service on this machine`,
      });
    }
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
  if (env.socketPath !== undefined) checks.push(await socketCheck(env.socketPath));
  checks.push(isolationCheck(await detectIsolation(), env.mode));
  const clients = await clientStatuses(env.workspaceRoot);
  checks.push(clientsCheck(clients));
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
    },
    failed,
  };
}

async function init(args: string[], env: CliEnvironment): Promise<InitResult> {
  await mkdir(env.dataDirectory, { recursive: true, mode: 0o700 });
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
    await writeFile(policyPath, `${JSON.stringify({ ...policy, mode: env.mode }, null, 2)}\n`, { flag: "wx" });
  }
  const client = resolveClient(argument("--client", args) ?? "generic");
  const label = CLIENTS[client]?.label ?? client;
  const config = clientConfig(client, {
    ...serverLaunch(import.meta.dirname, PRODUCT_VERSION),
    env: {
      MELRA_WORKSPACE: env.workspaceRoot,
      MELRA_HOME: env.dataDirectory,
      MELRA_POLICY: policyPath,
      // The client starts the server with this env, not with our flags: without
      // it `--mode enforced` would be reported here and a developer server run.
      ...(env.mode === "enforced" ? { MELRA_MODE: "enforced" } : {}),
    },
  });
  const configPath = clientConfigPath(client, env.workspaceRoot);
  if (args.includes("--write")) {
    if (configPath === undefined) {
      throw new Error("--write needs a named --client; see 'melra help' for the list");
    }
    const { backup, unchanged } = await writeClientConfig(configPath, config, client);
    const next = CLIENTS[client]?.next ?? `Restart ${label} to load it.`;
    return {
      initialized: true,
      client,
      workspace: env.workspaceRoot,
      policyPath,
      configPath,
      written: true,
      ...(backup === undefined ? {} : { backup }),
      ...(unchanged === undefined ? {} : { unchanged }),
      config,
      note: unchanged
        ? `${configPath} already has this melra entry; nothing changed. ${next}`
        : `Added melra to ${configPath}. ${next}`,
    };
  }
  return {
    initialized: true,
    client,
    workspace: env.workspaceRoot,
    policyPath,
    ...(configPath === undefined ? {} : { configPath }),
    config,
    note:
      configPath === undefined
        ? "Add the mcpServers.melra entry to your client's MCP configuration, " +
          "or rerun with --client <name> for that client's own format."
        : `Add this to ${configPath}, or rerun with --write to merge it there for you.`,
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
  const initialized = await init(chosen, env);
  const { report, failed } = await doctor(env);
  printJsonOrHuman({ ...initialized, ...report }, () => renderSetup(initialized, report), args);
  return failed ? 1 : 0;
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
      const execution = await melra.controller.execute(task.id);
      output(execution);
      return execution.task.status === "verified_success" ? 0 : 2;
    }
    const execution = await melra.controller.execute(task.id);
    output(execution);
    return execution.task.status === "verified_success" ? 0 : 2;
  } finally {
    await melra.close();
  }
}

/**
 * Records an approval for a task another process planned, without running it:
 * the agent that planned it runs it, and the decision lets it.
 */
async function approveCommand(args: string[], env: CliEnvironment): Promise<number> {
  // `--mode` is the one flag here that takes a value.
  const given = args.find((value, index) => !value.startsWith("--") && args[index - 1] !== "--mode");
  if (given === undefined) throw new Error("approve requires a task ID");
  const approver = approverLabel(env);
  const melra = await runtime(env);
  try {
    // `melra tasks` shows the first eight characters, so a prefix naming one
    // waiting task is enough.
    const waiting = melra.store
      .listTasks(500, "awaiting_approval")
      .filter((task) => task.id.startsWith(given));
    if (given.length < 36 && waiting.length > 1) throw new Error(`task_id_ambiguous:${given}`);
    const taskId = given.length < 36 && waiting.length === 1 ? waiting[0]!.id : given;
    const view = melra.controller.approvalView(taskId);
    if (args.includes("--deny")) {
      melra.controller.cancel(taskId);
      // Read back: another process may have started it in the meantime.
      const task = melra.controller.status(taskId);
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

async function inspectTask(args: string[], env: CliEnvironment): Promise<void> {
  const taskId = args[0];
  if (taskId === undefined) throw new Error("inspect requires a task ID");
  const melra = await runtime(env);
  try {
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
 * The URL carries the token, so this is the difference between copying a secret
 * out of a terminal and the console simply being open. `serve --open` ignores a
 * failure on purpose: the URL is already on screen, and a server that refused
 * to start because a desktop helper is missing would be worse than one you
 * click into. `melra console` prints no URL, so it has to know.
 */
function openInBrowser(url: string): Promise<boolean> {
  const [command, ...prefix] =
    process.platform === "darwin"
      ? ["open"]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", ""]
        : ["xdg-open"];
  const child = spawn(command!, [...prefix, url], {
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
  melra doctor [--json]
  melra conformance [--url <mcp-url> --token <token>] [--level <1|2|3>]
  melra init [--client <name>] [--write] [--json]
  melra serve [--http [--port <port>] [--open]]
  melra serve --socket <path>
  melra run --request <task.json>
  melra approve <task-id> [--yes] [--deny] [--json]
  melra console
  melra inspect <task-id>
  melra tasks [--limit <n>] [--status <status>] [--json]
  melra watch [--json]
  melra status [--json]
  melra workflow plan --definition <workflow.json>
  melra workflow advance <workflow-id> [--approval <id>:<exact-phrase>]
                                       [--input <node-id>=<value>]
                                       (--approval: developer mode; enforced:
                                       melra approve <task-id>, then advance)
  melra workflow inspect <workflow-id>
  melra workflow cancel <workflow-id>
  melra workflow pause|resume|suspend <workflow-id>
  melra demo durable-core
  melra clients [--revoke <client-id|all>]
  melra policy test --request <task.json>
  melra version [--json]

'melra console', run by you in a terminal, opens an approval console in your
browser, on a server of its own with no MCP endpoint, that approves or denies
as 'melra approve' does. It pairs with the first page to use its code, normally
the tab it opens. Its one-time pairing code is never printed: it reaches the
browser on its opener's command line, and reloading or leaving the page ends
the pairing. Run it with the MELRA_HOME, MELRA_WORKSPACE and mode your agent's
server uses. Without a terminal or a browser to open, it refuses to start.

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
                   moves 'serve' off stdio.
  --open           With --http, open the console in your browser once it is
                   listening.
  --url <mcp-url>  Endpoint for 'conformance'. Default: spawn 'melra serve'.
  --level <1|2|3>  Conformance level being claimed (default: 3). The run exits
                   non-zero if the endpoint falls short of it.
  --json           For tasks, watch, and status: JSON (NDJSON for watch) even
                   in a terminal. Output that is not a terminal is JSON anyway.
  --limit <n>      How many recent tasks 'tasks' lists (default: 20, max 500).
  --status <s>     Only tasks in this status, e.g. awaiting_approval.

Environment:
  MELRA_WORKSPACE  Workspace boundary (default: a MELRA_POLICY file's
                   workspaceRoot, else the current directory)
  MELRA_HOME       Local database and artifact directory
  MELRA_POLICY     Optional local policy JSON
  MELRA_UNHINGED   Set to 1 to disable every guardrail (see --unsafe-local)
  MELRA_MODE       developer (default) or enforced (see --mode)
  MELRA_APPROVER   Name 'melra approve' and 'melra console' record as the
                   approver (default: operator)
  MELRA_HTTP_PORT  Port for 'serve --http' (default: 7457)
  MELRA_HTTP_TOKEN Fixed bearer token for 'serve --http' (default: random)
  MELRA_HTTP_OAUTH Set to 0 so only that token gets in; no client can register
  MELRA_SOCKET     Socket path 'doctor' and 'status' check (serve needs --socket)
  MELRA_BROWSER    Optional Chrome/Chromium/Edge executable
  MELRA_BROWSER_CDP_ENDPOINT       Optional HTTP(S) CDP endpoint
  MELRA_BROWSER_CDP_CONTEXT_INDEX  External context index (-1 is last)
  MELRA_BROWSER_HAR_PATH           Absolute HAR output path
  MELRA_BROWSER_HAR_REPLAY         Absolute HAR to replay; nothing hits network
  MELRA_BROWSER_PROFILE            Absolute dir keeping cookies between runs
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
  const requested: CliEnvironment = {
    ...parsed,
    unhinged:
      parsed.unhinged || deprecated || args.includes("--unsafe-local"),
    // The strictest of the flag and the variable, as for the policy file below:
    // `--mode developer` does not undo MELRA_MODE=enforced.
    ...(modeFlag === undefined || deploymentMode(modeFlag) === "developer"
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
      rejectUnknownFlags(args, ["--client", "--write", "--json"]);
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
        if (args.includes("--open")) void openInBrowser(endpoint.url);
      }
      const close = async () => {
        await server?.close();
        await endpoint?.close();
        await melra.close();
      };
      process.once("SIGINT", () => void close().finally(() => process.exit(0)));
      process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
      return;
    }
    case "run":
      rejectUnknownFlags(args, ["--request"]);
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
      return;
    }
    case "approve":
      rejectUnknownFlags(args, ["--yes", "--deny", "--json"]);
      process.exitCode = await approveCommand(args, env);
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
    case "watch":
      rejectUnknownFlags(args, ["--json"]);
      process.exitCode = await watchCommand(env, { json: args.includes("--json") });
      return;
    case "status": {
      rejectUnknownFlags(args, ["--json"]);
      const policyPath = await existingPolicyPath(env);
      process.exitCode = await statusCommand(env, {
        json: args.includes("--json"),
        ...(policyPath === undefined ? {} : { policyPath }),
      });
      return;
    }
    case "workflow":
      rejectUnknownFlags(args, ["--definition", "--approval", "--input"]);
      process.exitCode = await workflowCommand(args, env);
      return;
    case "demo":
      rejectUnknownFlags(args, []);
      // One demo today, so naming it is optional.
      if ((args[0] ?? "durable-core") !== "durable-core") {
        throw new Error("demo supports only 'durable-core'");
      }
      process.exitCode = await durableCoreDemo(env);
      return;
    case "clients":
      rejectUnknownFlags(args, ["--revoke"]);
      process.exitCode = clientsCommand(args, env);
      return;
    case "policy":
      if (args[0] !== "test") throw new Error("policy supports only 'test'");
      rejectUnknownFlags(args.slice(1), ["--request"]);
      await policyTest(args.slice(1), env);
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
