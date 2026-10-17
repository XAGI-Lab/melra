// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import {
  approvalScreen,
  serveHttp,
  type ApprovalScreenView,
  type MelraHttpServer,
  type MelraRuntime,
} from "@melra/server";
import { approverLabel, type CliEnvironment } from "./environment.js";

/** What `melra console` needs from the terminal it was started in. */
export interface ConsoleTerminal {
  /** Both stdin and stderr are a terminal. */
  interactive: boolean;
  /** Hands a URL to the desktop's browser; false when nothing took it. */
  open(url: string): Promise<boolean>;
  /** Writes to the operator, on stderr. */
  say(text: string): void;
}

/**
 * The approval screen on the terminal it is written to, wrapped to that
 * terminal's width: taken from any other stream, a piped stdout say, the
 * width is missing and the terminal wraps the screen itself (#210).
 */
export function showApprovalScreen(view: ApprovalScreenView, terminal: { columns?: number; write(text: string): unknown }): void {
  terminal.write(approvalScreen(view, true, terminal.columns));
}

/**
 * `melra run`'s and `melra approve`'s question: the effect as an approver
 * needs to see it, then y/N, on the operator's terminal (stderr, answered on
 * stdin), so nothing an agent reads from stdout carries it. Anything but a
 * yes is answered there with "Not approved.".
 */
export async function confirmInTerminal(
  view: ApprovalScreenView,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream & { columns?: number } = process.stderr,
): Promise<boolean> {
  showApprovalScreen(view, output);
  const prompt = createInterface({ input, output });
  try {
    // Input that ends before an answer (Ctrl-D or Ctrl-C, or the end of a
    // stdin that is not a terminal) is a no, never a question left open.
    let answered = false;
    const answer = await Promise.race([
      prompt.question("Approve this effect? [y/N] ").then(
        (said) => {
          answered = true;
          return said;
        },
        () => "",
      ),
      once(prompt, "close").then(
        () => "",
        () => "",
      ),
    ]);
    // Nothing was typed to end the line, so end it here.
    if (!answered) output.write("\n");
    const said = answer.trim().toLowerCase();
    const approved = said === "y" || said === "yes";
    if (!approved) output.write("Not approved.\n");
    return approved;
  } finally {
    prompt.close();
  }
}

/** Refuses anywhere but an operator's terminal, before anything is opened. */
export function assertConsoleTerminal(interactive: boolean): void {
  if (!interactive) {
    throw new Error(
      "console_needs_a_terminal: run 'melra console' yourself, in a terminal; from a script, use 'melra approve <task-id>'",
    );
  }
}

/**
 * Starts the approval console: a loopback server with no MCP endpoint, on the
 * same data directory as the agent's server, whose pairing code is never
 * printed. Not stdout, not stderr, not a file: a harness reads what a process
 * it started prints, and pipes are how it would, so this refuses to start
 * anywhere but in an operator's terminal. The code reaches the browser on its
 * opener's command line, where a process that can list processes can read it
 * until the page spends it (THREAT_MODEL.md, "A pairing race").
 */
export async function approvalConsole(
  env: CliEnvironment,
  melra: MelraRuntime,
  terminal: ConsoleTerminal,
): Promise<MelraHttpServer> {
  assertConsoleTerminal(terminal.interactive);
  // A tab can pair before the opener returns. On success its line waits for
  // the address, so the terminal reads address, then pairing; if the opener
  // then fails, the pairing is reported with what it approved, since nothing
  // the operator opened made it.
  // Every approval is printed the moment it is made, the opener still running
  // included, so however the console ends the terminal names what to cancel.
  let pairedAt: Date | undefined;
  let addressed = false;
  const approved: string[] = [];
  const pairedLine = (at: Date) =>
    `Paired with a browser tab at ${at.toTimeString().slice(0, 5)}. ` +
    `If no console tab just opened for you, press Ctrl-C now.\n`;
  const approvedLine = (taskId: string, at: Date) =>
    `Approved ${taskId} at ${at.toTimeString().slice(0, 5)} in the paired tab. ` +
    `If that was not you, run 'melra approve ${taskId} --deny', with this console's MELRA_HOME, before the agent runs it.\n`;
  const endpoint = await serveHttp({
    runtime: melra,
    port: 0,
    approver: approverLabel(env, "console"),
    onPaired: (at) => {
      pairedAt = at;
      if (addressed) terminal.say(pairedLine(at));
    },
    onApproved: (taskId) => {
      approved.push(taskId);
      terminal.say(approvedLine(taskId, new Date()));
    },
  });
  // What the operator must hear when the console closes after a tab paired
  // that no opener of theirs is known to have made.
  const unexplained = (): string =>
    pairedAt === undefined
      ? ""
      : `; a browser tab paired at ${pairedAt.toTimeString().slice(0, 5)} while the opener ran, and ` +
        (approved.length === 0
          ? "approved nothing before the console closed"
          : `approved ${approved.join(", ")}: cancel any you did not approve with 'melra approve <task-id> --deny', with this console's MELRA_HOME`);
  let opened: boolean;
  try {
    opened = await terminal.open(endpoint.url);
  } catch (error) {
    // An opener that throws must not leave the console listening behind it.
    await endpoint.close();
    if (pairedAt === undefined) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)}${unexplained()}`);
  }
  if (!opened) {
    await endpoint.close();
    throw new Error(
      pairedAt === undefined
        ? "console_needs_a_browser: nothing here opens a browser, and the console's pairing code is never printed; use 'melra approve <task-id>'"
        : `console_needs_a_browser: the browser opener reported failure${unexplained()}`,
    );
  }
  terminal.say(
    `Approval console on http://${endpoint.host}:${endpoint.port}, opened in your browser.\n` +
      `One page can pair with it, the first to use its code, which should be the one it\n` +
      `opened: if yours says another tab already paired, press Ctrl-C and cancel each\n` +
      `task this terminal lists as approved. Reloading or leaving the page ends the\n` +
      `pairing: run 'melra console' again then. Ctrl-C closes the console.\n` +
      (melra.policy.mode === "enforced"
        ? ""
        : `Developer mode: approvals here are recorded in band, and an enforced server will not act on them.\n`),
  );
  addressed = true;
  if (pairedAt !== undefined) terminal.say(pairedLine(pairedAt));
  return endpoint;
}
