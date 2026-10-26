// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// What `doctor`, `setup`, and `init` show a person at a terminal, and the
// question `setup` asks when nobody named a client. Kept out of `index.ts`
// because importing that runs the CLI, and every piece here needs a test.

import { createInterface } from "node:readline/promises";
import { RUNTIME_COMMANDS } from "@melra/policy-core";
import { printable } from "@melra/server/kernel";
import { CLIENTS } from "./clients.js";
import { CLAUDE_TOOLS } from "./environment.js";
import type { ClientChoice, ClientStatus } from "./client-status.js";
import { mark, paint, table, type Status } from "./output.js";

export interface DoctorCheck {
  name: string;
  status: Status;
  detail: string;
  /** What to do about it, where that depends on more than the check's name. */
  next?: string;
}

export interface DoctorReport {
  product: string;
  version: string;
  ready: boolean;
  unhinged: boolean;
  mode: string;
  checks: DoctorCheck[];
  clients: ClientStatus[];
}

export interface InitResult {
  initialized: true;
  client: string;
  /** The directory the generated config gives the agent, as MELRA_WORKSPACE. */
  workspace: string;
  policyPath: string;
  configPath?: string;
  written?: true;
  backup?: string;
  // The file already held exactly this entry, so it was left alone.
  unchanged?: true;
  config: Record<string, unknown> | string;
  note: string;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function clientLine(status: ClientStatus): string[] {
  const symbol =
    status.problems.length > 0
      ? mark("warn")
      : status.state === "configured"
        ? mark("pass")
        : paint.dim("·");
  // A workspace config file the agent can write names the command these
  // describe, so they are spelled out before they reach the terminal.
  const extra = [...(status.note === undefined ? [] : [status.note]), ...status.problems];
  return [symbol, status.client, status.state, paint.dim(printable(extra.join("; ")))];
}

// The one thing to do next, or undefined when there is nothing to fix or the
// fix is outside MELRA's reach (a platform without a computer adapter). Fails
// before warnings; among warnings a client problem first, because repointing a
// client is the step people run doctor to find.
export function nextStep(report: DoctorReport): string | undefined {
  const broken = report.clients.find((client) => client.problems.length > 0);
  const hint = (check: DoctorCheck): string | undefined => {
    if (check.next !== undefined) return check.next;
    switch (check.name) {
      case "node":
        return "install Node.js 22 or newer";
      case "sqlite":
        return "reinstall Node.js: node:sqlite loaded but could not open a database";
      case "workspace":
        return "point MELRA_WORKSPACE at a directory you can read and write";
      case "data-directory":
        return check.status === "warn"
          ? "make MELRA_HOME private with chmod 700 (see the data-directory line above)"
          : "point MELRA_HOME at a directory you can write";
      case "data-location":
        // Inside the workspace carries its own `next`, which depends on the layout.
        return "point MELRA_WORKSPACE at a directory you can read and write";
      case "policy":
        return "fix the policy file as the policy line above says, or unset MELRA_POLICY to use the defaults";
      case "socket":
        return "fix or unset MELRA_SOCKET (see the socket line above)";
      case "isolation":
        return "run MELRA in the hardened container (https://github.com/XAGI-Lab/melra/blob/main/docs/INSTALLATION.md#docker), or another OS sandbox";
      case "mode":
        return 'drop --unsafe-local, MELRA_UNHINGED and "unhinged" in the policy file, or run in developer mode';
      case "guardrails":
        return "unset MELRA_UNHINGED and drop --unsafe-local to turn the guardrails back on";
      case "browser":
        // An attached browser warns whatever is installed, so installing clears nothing.
        return check.detail.startsWith("attached over CDP")
          ? "point MELRA_BROWSER_CDP_ENDPOINT at a browser you do not use yourself, or unset it"
          : "install Chrome, or set MELRA_BROWSER to a Chrome, Chromium, or Edge executable";
      case "clients": {
        if (broken === undefined) return undefined;
        if (broken.state === "unreadable") return `check the permissions on ${broken.path}`;
        // A stale pin names its own fix. A command missing from PATH is not
        // fixed by rewriting the config, so do not send anyone round that loop.
        const fix = broken.problems.map((problem) => /; fix: (.+)$/.exec(problem)?.[1]).find(Boolean);
        if (fix !== undefined) return fix;
        return broken.command === "melra"
          ? "put 'melra' on PATH: npm install -g @melra/cli@alpha"
          : `make '${broken.command ?? "the configured command"}' runnable from PATH`;
      }
      default:
        return undefined;
    }
  };
  const fails = report.checks.filter((check) => check.status === "fail");
  const warns = report.checks.filter((check) => check.status === "warn");
  const ordered = [
    ...fails,
    ...warns.filter((check) => check.name === "clients"),
    ...warns.filter((check) => check.name !== "clients"),
  ];
  for (const check of ordered) {
    const next = hint(check);
    if (next !== undefined) return next;
  }
  return undefined;
}

// The verdict and, when something is wrong, what to run about it.
function summary(report: DoctorReport): string[] {
  const fails = report.checks.filter((check) => check.status === "fail").length;
  const warns = report.checks.filter((check) => check.status === "warn").length;
  const verdict =
    fails > 0
      ? `${mark("fail")} ${paint.bold(`Not ready: ${plural(fails + warns, "problem")}`)}`
      : warns > 0
        ? `${mark("warn")} ${paint.bold(`Ready, with ${plural(warns, "warning")}`)}`
        : `${mark("pass")} ${paint.bold("Ready")}`;
  const next = nextStep(report);
  return [verdict, ...(next === undefined ? [] : [`Next: ${paint.bold(printable(next))}`])];
}

function checkRows(checks: DoctorCheck[], report: DoctorReport): string {
  const lines: string[] = [];
  const rows = checks.map((check) => {
    if (check.name !== "clients" || report.clients.length === 0) {
      return [mark(check.status), check.name, check.detail];
    }
    const none = !report.clients.some((client) => client.state === "configured");
    return [
      mark(check.status),
      check.name,
      none ? paint.dim("none configured yet; run 'melra setup'") : "",
    ];
  });
  lines.push(table(rows, { indent: 2 }));
  if (checks.some((check) => check.name === "clients") && report.clients.length > 0) {
    lines.push(table(report.clients.map(clientLine), { indent: 6 }));
  }
  return lines.join("\n");
}

export function renderDoctor(report: DoctorReport): string {
  return [
    paint.bold(`${report.product} ${report.version}`) + paint.dim(` · ${report.mode} mode`),
    "",
    checkRows(report.checks, report),
    "",
    ...summary(report),
  ].join("\n");
}

function snippet(config: Record<string, unknown> | string): string {
  const text = typeof config === "string" ? config.trimEnd() : JSON.stringify(config, null, 2);
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

export function renderInit(result: InitResult): string {
  const label = CLIENTS[result.client]?.label ?? result.client;
  const rows = [
    [mark("pass"), "Workspace", result.workspace],
    [mark("pass"), "Policy", result.policyPath],
  ];
  if (result.written === true && result.configPath !== undefined) {
    rows.push([mark("pass"), label, result.configPath]);
    if (result.unchanged === true) {
      rows.push(["", "", paint.dim("already set up; nothing changed")]);
    } else if (result.backup !== undefined) {
      rows.push(["", "", paint.dim(`previous file saved as ${result.backup}`)]);
    }
    const next = CLIENTS[result.client]?.next ?? `Restart ${label}, then ask it to use the melra tools.`;
    return [table(rows, { indent: 2 }), "", `Next: ${paint.bold(printable(next))}`].join("\n");
  }
  const where =
    result.configPath === undefined
      ? "Add this to your MCP client's configuration:"
      : `Add this to ${paint.bold(result.configPath)}:`;
  const instead =
    result.configPath === undefined
      ? `Or name your client to get its own format: ${paint.bold("melra setup --client <name>")}` +
        `, or run ${paint.bold("melra setup")} in a terminal to pick one.`
      : `Or let MELRA merge it in for you: ${paint.bold(`melra setup --client ${result.client} --write`)}`;
  return [table(rows, { indent: 2 }), "", where, "", snippet(result.config), "", instead].join("\n");
}

// After a setup, only what needs attention: a full doctor report is one
// command away and would bury the "restart your client" line above it.
export function renderSetup(result: InitResult, report: DoctorReport): string {
  const attention = report.checks.filter((check) => check.status !== "pass");
  return [
    renderInit(result),
    "",
    ...(attention.length === 0 ? [] : [checkRows(attention, report), ""]),
    ...summary(report),
  ].join("\n");
}

export interface LaunchSummary {
  mode: string;
  unhinged: boolean;
  workspace: string;
  policyPath?: string;
  /** What the server will allow, read as it reads them. */
  allowedCommands: readonly string[];
}

/**
 * What `melra launch claude-code` tells the person starting it before claude
 * starts: what the session can and cannot do, and who approves a change.
 */
export function renderLaunch(summary: LaunchSummary): string {
  // Unsafe-local runs any program and asks nothing, so no row may say less.
  const runtimes = summary.unhinged ? [] : RUNTIME_COMMANDS.filter((command) => summary.allowedCommands.includes(command));
  const rows = [
    ["Mode", summary.unhinged ? "UNSAFE-LOCAL: no policy, approval or confinement applies" : summary.mode],
    ["Workspace", summary.workspace],
    ["Policy", summary.unhinged ? "not applied" : (summary.policyPath ?? "safe built-in defaults")],
    ["Agent has", `${CLAUDE_TOOLS.split(",").join(", ")}, which only read the workspace, and MELRA's tools for everything else`],
    ["Off", "Bash, Edit, Write, WebFetch and the other built-in tools, every other MCP server, and your user, project and local Claude Code settings"],
    [
      "Commands",
      summary.unhinged
        ? "any program, shells included"
        : `${summary.allowedCommands.join(", ") || "none"}` +
          (runtimes.length === 0 ? "; node, npm, npx and pnpm only if the policy file lists them" : ""),
    ],
    [
      "Approve",
      summary.unhinged
        ? "nothing is asked; every change runs"
        : summary.mode === "enforced"
          ? "melra approve <task-id> or melra console, in another terminal, enforced, with this MELRA_HOME"
          : "the agent can echo MELRA's phrase itself, and an approved command runs with your rights; " +
            "launch with --mode enforced to approve each change yourself",
    ],
    ...(runtimes.length === 0
      ? []
      : [["Warning", `the policy allows ${runtimes.join(", ")}; a program they run is not limited to MELRA's tools`]]),
  ];
  return [
    "Starting Claude Code. MELRA's tools are the only ones it has that change anything.",
    table(rows, { indent: 2 }),
    "",
  ].join("\n");
}

export interface WizardIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * Why `setup` and `init` will not quietly make home, a directory holding it,
 * or `/` the workspace, and `advice` on choosing another.
 */
export function broadWorkspaceWarning(
  workspace: string,
  broad: "root" | "home" | "holds-home",
  advice: string,
): string {
  const what = {
    root: "is the root of the file system",
    home: "is your home directory",
    "holds-home": "holds your home directory",
  }[broad];
  return (
    `${workspace} ${what}, and the agent could read every file under it. ` +
    `${advice.charAt(0).toUpperCase()}${advice.slice(1)}`
  );
}

/**
 * Every question one command asks, read through one interface. Lines are read
 * through its async iterator rather than `question()`, because the iterator
 * buffers: input that arrives all at once (a paste, typing ahead, or a test)
 * is not lost between prompts, nor between the workspace question and the
 * wizard. The interface opens at the first question, so a command that asks
 * none leaves the terminal alone. Undefined once input ends or on Ctrl-C.
 */
export interface Prompter {
  ask(prompt: string): Promise<string | undefined>;
  output: NodeJS.WritableStream;
  close(): void;
}

export function prompter(io: WizardIo): Prompter {
  let rl: ReturnType<typeof createInterface> | undefined;
  let lines: AsyncIterator<string> | undefined;
  // Input can end with answers still buffered (a paste ending in EOF). Those
  // are still read, but a closed interface refuses to prompt, so the prompt is
  // then written directly.
  let closed = false;
  return {
    output: io.output,
    async ask(prompt) {
      if (rl === undefined) {
        const opened = createInterface({ input: io.input, output: io.output });
        opened.on("close", () => (closed = true));
        opened.on("SIGINT", () => opened.close());
        rl = opened;
        lines = opened[Symbol.asyncIterator]();
      }
      if (closed) {
        io.output.write(prompt);
      } else {
        // Through readline while it is live, so line editing redraws the prompt.
        rl.setPrompt(prompt);
        rl.prompt();
      }
      const line = await lines!.next();
      return line.done === true ? undefined : String(line.value).trim().toLowerCase();
    },
    close: () => rl?.close(),
  };
}

/**
 * Asked before `setup` or `init` writes a config whose workspace is broad:
 * what `npx @melra/cli@alpha setup` in a fresh terminal did without a word.
 * No unless the person types y; input that ends is a no.
 */
export async function confirmBroadWorkspace(reader: Prompter, workspace: string, warning: string): Promise<boolean> {
  reader.output.write(`${mark("warn")} ${printable(warning)}.\n`);
  const answer = await reader.ask(`Use ${printable(workspace)} as the workspace anyway? [y/N] `);
  return answer === "y" || answer === "yes";
}

/**
 * Ask which client to set up and whether to write its config. Resolves to the
 * answer, or undefined if the person pressed Ctrl-C or closed input — in which
 * case the caller writes nothing.
 */
export async function setupWizard(
  reader: Prompter,
  clients: ClientChoice[],
): Promise<{ client: string; write: boolean } | undefined> {
  const choices: ClientChoice[] = [
    ...clients.filter((client) => client.detected !== undefined),
    ...clients.filter((client) => client.detected === undefined),
    { client: "generic", label: "generic (just print the config)" },
  ];
  reader.output.write(
    `Which MCP client should use MELRA?\n\n${table(
      choices.map(({ label, detected }, index) => [
        `${index + 1})`,
        label,
        detected === undefined ? "" : paint.ok(`detected: ${detected}`),
      ]),
      { indent: 2 },
    )}\n\n`,
  );
  const fallback = choices[0]?.detected === undefined ? undefined : choices[0];
  let chosen: ClientChoice | undefined;
  while (chosen === undefined) {
    const answer = await reader.ask(`Choose 1-${choices.length}${fallback === undefined ? "" : " [1]"}: `);
    if (answer === undefined) return undefined;
    chosen =
      answer === ""
        ? fallback
        : (choices[Number(answer) - 1] ?? choices.find(({ client }) => client === answer));
    if (chosen === undefined) {
      reader.output.write(`Enter a number from 1 to ${choices.length}.\n`);
    }
  }
  if (chosen.path === undefined) return { client: chosen.client, write: false };
  for (;;) {
    const answer = await reader.ask(`Write it into ${chosen.path}? [Y/n] `);
    if (answer === undefined) return undefined;
    if (["", "y", "yes"].includes(answer)) return { client: chosen.client, write: true };
    if (["n", "no"].includes(answer)) return { client: chosen.client, write: false };
    reader.output.write("Answer y or n.\n");
  }
}

export interface ConformanceReport {
  suite: string;
  level: number;
  claimed: number;
  claim: string;
  passed: number;
  of: number;
  checks: Array<{ level: number; name: string; passed: boolean; detail: string }>;
  mode: string;
  notProven: string[];
  uncleanedProbeFile?: string;
}

// The checks by level, the level reached, and what it does not prove: the
// last part is what an operator has to read before quoting the level.
export function renderConformance(report: ConformanceReport): string {
  const rows = report.checks.map((check) => [
    mark(check.passed ? "pass" : "fail"),
    `L${check.level}`,
    check.name,
    paint.dim(check.detail),
  ]);
  const reached = report.level === 0 ? "no level reached" : report.claim;
  const verdict =
    report.level >= report.claimed
      ? `${mark("pass")} ${reached}`
      : `${mark("fail")} ${reached}, short of the L${report.claimed} claimed`;
  return [
    paint.bold(`MELRA conformance ${report.suite}`) + paint.dim(` · ${report.mode} mode`),
    "",
    table(rows, { indent: 2 }),
    "",
    `${verdict} ${paint.dim(`(${report.passed} of ${report.of} checks)`)}`,
    ...(report.uncleanedProbeFile === undefined
      ? []
      : ["", `${mark("warn")} probe file left behind: ${report.uncleanedProbeFile}`]),
    "",
    paint.dim("Not proven by this suite:"),
    ...report.notProven.map((item) => paint.dim(`  - ${item}`)),
  ].join("\n");
}
