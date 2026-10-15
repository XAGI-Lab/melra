// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// What `doctor`, `setup`, and `init` show a person at a terminal, and the
// question `setup` asks when nobody named a client. Kept out of `index.ts`
// because importing that runs the CLI, and every piece here needs a test.

import { createInterface } from "node:readline/promises";
import { printable } from "./approval-screen.js";
import { CLIENTS } from "./clients.js";
import type { ClientChoice, ClientStatus } from "./client-status.js";
import { mark, paint, table, type Status } from "./output.js";

export interface DoctorCheck {
  name: string;
  status: Status;
  detail: string;
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
    switch (check.name) {
      case "node":
        return "install Node.js 22 or newer";
      case "sqlite":
        return "use Node.js 22.13 or newer, which ships node:sqlite";
      case "workspace":
        return "point MELRA_WORKSPACE at a directory you can read and write";
      case "data-directory":
        return "point MELRA_HOME at a directory you can write";
      case "policy":
        return "fix the policy file's JSON, or unset MELRA_POLICY to use the defaults";
      case "socket":
        return "fix or unset MELRA_SOCKET (see the socket line above)";
      case "isolation":
        return "run MELRA in the hardened container (https://github.com/XAGI-Lab/melra/blob/main/docs/INSTALLATION.md#docker), or another OS sandbox";
      case "guardrails":
        return "unset MELRA_UNHINGED and drop --unsafe-local to turn the guardrails back on";
      case "browser":
        return "install Chrome, or set MELRA_BROWSER to a Chrome, Chromium, or Edge executable";
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
  const rows = [[mark("pass"), "Policy", result.policyPath]];
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

export interface WizardIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * Ask which client to set up and whether to write its config. Resolves to the
 * answer, or undefined if the person pressed Ctrl-C or closed input — in which
 * case the caller writes nothing.
 *
 * Lines are read through the interface's async iterator rather than
 * `question()`, because the iterator buffers: input that arrives all at once
 * (a paste, or a test) is not lost between prompts.
 */
export async function setupWizard(
  io: WizardIo,
  clients: ClientChoice[],
): Promise<{ client: string; write: boolean } | undefined> {
  const choices: ClientChoice[] = [
    ...clients.filter((client) => client.detected !== undefined),
    ...clients.filter((client) => client.detected === undefined),
    { client: "generic", label: "generic (just print the config)" },
  ];
  const rl = createInterface({ input: io.input, output: io.output });
  // Input can end with answers still buffered (a paste ending in EOF). Those
  // are still read, but a closed interface refuses to prompt, so the prompt is
  // then written directly.
  let closed = false;
  rl.on("close", () => (closed = true));
  rl.on("SIGINT", () => rl.close());
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string): Promise<string | undefined> => {
    if (closed) {
      io.output.write(prompt);
    } else {
      // Through readline while it is live, so line editing redraws the prompt.
      rl.setPrompt(prompt);
      rl.prompt();
    }
    const line = await lines.next();
    return line.done === true ? undefined : String(line.value).trim().toLowerCase();
  };
  try {
    io.output.write(
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
      const answer = await ask(`Choose 1-${choices.length}${fallback === undefined ? "" : " [1]"}: `);
      if (answer === undefined) return undefined;
      chosen =
        answer === ""
          ? fallback
          : (choices[Number(answer) - 1] ?? choices.find(({ client }) => client === answer));
      if (chosen === undefined) {
        io.output.write(`Enter a number from 1 to ${choices.length}.\n`);
      }
    }
    if (chosen.path === undefined) return { client: chosen.client, write: false };
    for (;;) {
      const answer = await ask(`Write it into ${chosen.path}? [Y/n] `);
      if (answer === undefined) return undefined;
      if (["", "y", "yes"].includes(answer)) return { client: chosen.client, write: true };
      if (["n", "no"].includes(answer)) return { client: chosen.client, write: false };
      io.output.write("Answer y or n.\n");
    }
  } finally {
    rl.close();
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
