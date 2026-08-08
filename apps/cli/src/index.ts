#!/usr/bin/env node
// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import {
  ApprovalResponseSchema,
  TaskRequestSchema,
  WorkflowDefinitionSchema,
  WorkflowInputSchema,
  PRODUCT_VERSION,
  principalRef,
  type ApprovalResponse,
  type TaskRequest,
  type WorkflowDefinition,
  type WorkflowInput,
  type WorkflowRun,
} from "@melra/protocol";
import {
  createMelraRuntime,
  serveHttp,
  OAuthProvider,
  clientPrincipal,
  serveStdio,
  unconfinedRoot,
  type MelraRuntime,
} from "@melra/server";
import { detectBrowserExecutable } from "@melra/browser-runtime";
import { createSystemComputerAdapter } from "@melra/computer-runtime";
import {
  classifyOperation,
  createDefaultPolicy,
  evaluatePolicy,
  loadPolicy,
} from "@melra/policy-core";
import {
  type CliEnvironment,
  parseCliEnvironment,
  serverLaunch,
} from "./environment.js";

async function existingPolicyPath(env: CliEnvironment): Promise<string | undefined> {
  if (env.policyPath !== undefined) return env.policyPath;
  const candidate = join(env.dataDirectory, "policy.json");
  try {
    await access(candidate, constants.R_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * The banner unhinged mode prints before it does anything.
 *
 * It goes to stderr, which is where it has to go: in `serve` the stdout stream
 * is the MCP transport and any prose written there corrupts the protocol. stderr
 * is what MCP clients surface in their server logs, so the operator still sees
 * it. Ordinary runs get it too — the mode is per-process, not per-command, and a
 * developer who exported the variable in one shell and forgot deserves the
 * reminder on every invocation rather than only at startup.
 */
function unhingedBanner(root: string): string {
  return [
    "",
    "  ############################################################",
    "  #  MELRA IS RUNNING UNHINGED. NO GUARDRAILS ARE APPLIED.   #",
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
    "  Turn it off by unsetting MELRA_UNHINGED and dropping --unhinged.",
    "",
  ].join("\n");
}

async function runtime(env: CliEnvironment): Promise<MelraRuntime> {
  const policyPath = await existingPolicyPath(env);
  return await createMelraRuntime({
    workspaceRoot: env.workspaceRoot,
    dataDirectory: env.dataDirectory,
    unhinged: env.unhinged,
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
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
  const allowed = new Set([...known, "--unhinged"]);
  // A flag's own value can look like a flag (`--input node=--x`), so skip the
  // slot after any known flag that takes one.
  const valued = new Set(known.filter((flag) => flag !== "--http"));
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
  const examplePath = resolve(
    import.meta.dirname,
    "../../../examples/workflows/restart-safe.json",
  );
  const melra = await runtime(env);
  try {
    const definition = WorkflowDefinitionSchema.parse(
      JSON.parse(await readFile(examplePath, "utf8")),
    );
    const planned = melra.workflows.plan(definition);
    const advanced = await melra.workflows.advance(planned.id);
    output({
      examplePath,
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

async function doctor(env: CliEnvironment): Promise<{
  report: Record<string, unknown>;
  failed: boolean;
}> {
  const checks: Array<{
    name: string;
    status: "pass" | "warn" | "fail";
    detail: string;
  }> = [];
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
            "UNHINGED: no policy, approval, evidence, confinement, or destination check is applied",
        }
      : { name: "guardrails", status: "pass", detail: "enforced" },
  );
  try {
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
    await mkdir(env.dataDirectory, { recursive: true });
    await access(env.dataDirectory, constants.R_OK | constants.W_OK);
    checks.push({
      name: "data-directory",
      status: "pass",
      detail: env.dataDirectory,
    });
  } catch {
    checks.push({
      name: "data-directory",
      status: "fail",
      detail: env.dataDirectory,
    });
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
  checks.push({
    name: "browser",
    status: browser === undefined ? "warn" : "pass",
    detail:
      browser ??
      "Chrome, Chromium, or Edge not found; non-browser capabilities remain available",
  });
  const computer = await createSystemComputerAdapter().capabilities();
  checks.push({
    name: "computer",
    status: computer.available ? "pass" : "warn",
    detail: computer.available
      ? `${computer.adapter}: screenshot=${computer.screenshot}, pointer=${computer.pointer}, keyboard=${computer.keyboard}, scroll=${computer.scroll}`
      : computer.limitations.join("; "),
  });
  try {
    const path = await existingPolicyPath(env);
    if (path !== undefined) JSON.parse(await readFile(path, "utf8"));
    checks.push({
      name: "policy",
      status: "pass",
      detail: path ?? "using safe built-in defaults",
    });
  } catch (error) {
    checks.push({
      name: "policy",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const failed = checks.some((check) => check.status === "fail");
  return {
    report: {
      product: "MELRA",
      version: PRODUCT_VERSION,
      ready: !failed,
      // Alongside the `guardrails` check so a script does not have to read a
      // detail string to find out whether this machine has any.
      unhinged: env.unhinged,
      checks,
    },
    failed,
  };
}

async function init(
  args: string[],
  env: CliEnvironment,
): Promise<Record<string, unknown>> {
  await mkdir(env.dataDirectory, { recursive: true });
  const policyPath = join(env.dataDirectory, "policy.json");
  try {
    await access(policyPath, constants.F_OK);
  } catch {
    await writeFile(
      policyPath,
      `${JSON.stringify(createDefaultPolicy(env.workspaceRoot), null, 2)}\n`,
      { flag: "wx" },
    );
  }
  const client = argument("--client", args) ?? "generic";
  const config = {
    mcpServers: {
      melra: {
        ...serverLaunch(import.meta.dirname, PRODUCT_VERSION),
        env: {
          MELRA_WORKSPACE: env.workspaceRoot,
          MELRA_HOME: env.dataDirectory,
          MELRA_POLICY: policyPath,
        },
      },
    },
  };
  return {
    initialized: true,
    client,
    policyPath,
    config,
    note: `Add the mcpServers.melra entry to ${client}'s MCP configuration.`,
  };
}

// One command for the whole local setup: write the policy, emit a working
// client config, and verify the machine can actually run it.
async function setup(args: string[], env: CliEnvironment): Promise<number> {
  const initialized = await init(args, env);
  const { report, failed } = await doctor(env);
  output({ ...initialized, ...report });
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
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      const phrase = await prompt.question(
        `Type the exact approval phrase '${task.approval!.phrase}' to continue: `,
      );
      prompt.close();
      const execution = await melra.controller.execute(task.id, {
        approvalId: task.approval!.approvalId,
        phrase,
      });
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
  const request = await readTaskRequest(args);
  // Reports what this process would actually decide, unhinged mode included —
  // a dry run that disagreed with the server it is previewing is worse than
  // none. That is also why the operator's own `policy.json` is loaded rather
  // than the defaults: `serve` reads it, so a preview that ignored it would
  // answer for a policy nobody is running.
  const policy = {
    ...(await loadPolicy(await existingPolicyPath(env), env.workspaceRoot)),
    unhinged: env.unhinged,
  };
  const taskId = "00000000-0000-4000-8000-000000000000";
  // The decision carries effect, risk, and traits; the classification adds the
  // capability and target it was made against, so a surprising verdict can be
  // traced to what MELRA thought the request was touching.
  const { capability, target } = classifyOperation(request.operation);
  output({
    ...evaluatePolicy(taskId, request, policy),
    classified: { capability, target },
  });
}

/**
 * The clients an operator has approved over OAuth, and the way to take that
 * back. Reads the same file the server writes, so it works while the server is
 * down — which is when someone most wants to withdraw an approval.
 */
function clientsCommand(args: string[], env: CliEnvironment): number {
  const oauth = new OAuthProvider(env.dataDirectory);
  const revoke = argument("--revoke", args);
  if (revoke !== undefined) {
    const dropped = oauth.revoke(revoke === "all" ? undefined : revoke);
    process.stdout.write(
      `Revoked ${dropped} token${dropped === 1 ? "" : "s"}. ` +
        `The client must be approved again before it can act.\n`,
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
        `${client.id}  ${client.name}\n` +
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
 * Hands the console URL to whatever opens links here.
 *
 * The URL carries the token, so this is the difference between copying a secret
 * out of a terminal and the console simply being open. Failure is silent on
 * purpose: the URL is already on screen, and a server that refused to start
 * because a desktop helper is missing would be worse than one you click into.
 */
function openInBrowser(url: string): void {
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
  child.on("error", () => {});
  child.unref();
}

function help(): void {
  process.stdout.write(`MELRA ${PRODUCT_VERSION}

Usage:
  melra setup [--client <claude|cursor|vscode|codex|generic>]
  melra doctor
  melra init --client <claude|cursor|vscode|codex|generic>
  melra serve [--http] [--port <port>] [--open]
  melra run --request <task.json>
  melra inspect <task-id>
  melra workflow plan --definition <workflow.json>
  melra workflow advance <workflow-id> [--approval <id>:<exact-phrase>]
                                       [--input <node-id>=<value>]
  melra workflow inspect <workflow-id>
  melra workflow cancel <workflow-id>
  melra workflow pause|resume|suspend <workflow-id>
  melra demo durable-core
  melra clients [--revoke <client-id|all>]
  melra policy test --request <task.json>
  melra version

Flags:
  --unhinged       Run with no policy and no guardrails. Everything the OS user
                   can do, any caller can now do. Same as MELRA_UNHINGED=1.
  --http           Serve MCP over loopback HTTP instead of stdio, alongside a
                   read-only REST API, a workflow event stream, and the console.
                   Prints a bearer token; every request must carry it.
  --port <port>    HTTP port (default: 7457, or MELRA_HTTP_PORT).
  --open           Open the console in your browser once it is listening.

Environment:
  MELRA_WORKSPACE  Workspace boundary (default: current directory)
  MELRA_HOME       Local database and artifact directory
  MELRA_POLICY     Optional local policy JSON
  MELRA_UNHINGED   Set to 1 to disable every guardrail (see --unhinged)
  MELRA_HTTP_PORT  Port for 'serve --http' (default: 7457)
  MELRA_HTTP_TOKEN Fixed bearer token for 'serve --http' (default: random)
  MELRA_HTTP_OAUTH Set to 0 so only that token gets in; no client can register
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
  // `--unhinged` is an alias for the variable, not a second setting: one field
  // carries the answer so no code path can consult the weaker of the two.
  const env: CliEnvironment = args.includes("--unhinged")
    ? { ...parsed, unhinged: true }
    : parsed;
  // Before the command runs, and for every command including `help` — the mode
  // is a property of the process, so there is no invocation where staying quiet
  // about it is right.
  if (env.unhinged) {
    process.stderr.write(
      `${unhingedBanner(unconfinedRoot(env.workspaceRoot))}\n`,
    );
  }
  switch (command) {
    case "doctor": {
      rejectUnknownFlags(args, []);
      const { report, failed } = await doctor(env);
      output(report);
      process.exitCode = failed ? 1 : 0;
      return;
    }
    case "init":
      rejectUnknownFlags(args, ["--client"]);
      output(await init(args, env));
      return;
    case "setup":
      rejectUnknownFlags(args, ["--client"]);
      process.exitCode = await setup(args, env);
      return;
    case "serve": {
      rejectUnknownFlags(args, ["--http", "--port", "--open"]);
      const melra = await runtime(env);
      const http = args.includes("--http");
      const port = argument("--port", args);
      const server = http
        ? undefined
        : await serveStdio(melra);
      const endpoint = http
        ? await serveHttp({
            runtime: melra,
            ...(port === undefined ? {} : { port: Number(port) }),
          })
        : undefined;
      if (endpoint !== undefined) {
        // stdout stays clean for the stdio transport's sake even here, so the
        // one command an operator has to copy goes where they can read it.
        process.stderr.write(
          `MELRA HTTP server listening on http://${endpoint.host}:${endpoint.port}\n` +
            `  Console:  ${endpoint.url}\n` +
            `  MCP:      ${endpoint.mcpUrl}\n` +
            `  Token:    ${endpoint.token}\n` +
            (endpoint.oauth
              ? `A client that cannot be given the token can register itself and ask\n` +
                `you to approve it in a browser; approved clients are named on every\n` +
                `receipt. Set MELRA_HTTP_OAUTH=0 to allow only the token above.\n`
              : `OAuth is off, so the token above is the only way in.\n`) +
            `Loopback only. Anyone who can read this token can drive this machine.\n`,
        );
        if (args.includes("--open")) openInBrowser(endpoint.url);
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
    case "inspect":
    case "export":
      rejectUnknownFlags(args, []);
      await inspectTask(args, env);
      return;
    case "workflow":
      rejectUnknownFlags(args, ["--definition", "--approval", "--input"]);
      process.exitCode = await workflowCommand(args, env);
      return;
    case "demo":
      rejectUnknownFlags(args, []);
      if (args[0] !== "durable-core") {
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
      process.stdout.write(`${PRODUCT_VERSION}\n`);
      return;
    case "help":
    case "--help":
    case "-h":
      help();
      return;
    default:
      throw new Error(`unknown command: ${basename(command)}`);
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
