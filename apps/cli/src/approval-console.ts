// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { serveHttp, type MelraHttpServer, type MelraRuntime } from "@melra/server";
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
  let pairedAt: Date | undefined;
  let addressed = false;
  const approved: string[] = [];
  const pairedLine = (at: Date) =>
    `Paired with a browser tab at ${at.toTimeString().slice(0, 5)}. ` +
    `If no console tab just opened for you, press Ctrl-C now.\n`;
  const endpoint = await serveHttp({
    runtime: melra,
    port: 0,
    approver: approverLabel(env, "console"),
    onPaired: (at) => {
      pairedAt = at;
      if (addressed) terminal.say(pairedLine(at));
    },
    onApproved: (taskId) => void approved.push(taskId),
  });
  // What the operator must hear when the console closes after a tab paired
  // that no opener of theirs is known to have made.
  const unexplained = (): string =>
    pairedAt === undefined
      ? ""
      : `; a browser tab paired at ${pairedAt.toTimeString().slice(0, 5)} while the opener ran, and ` +
        (approved.length === 0
          ? "approved nothing before the console closed"
          : `approved ${approved.join(", ")}: cancel any you did not approve with 'melra approve <task-id> --deny'`);
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
      `Only the page it opened can pair with it, and reloading or leaving that page\n` +
      `ends the pairing: run 'melra console' again then. Ctrl-C closes the console.\n` +
      (melra.policy.mode === "enforced"
        ? ""
        : `Developer mode: approvals here are recorded in band, and an enforced server will not act on them.\n`),
  );
  addressed = true;
  if (pairedAt !== undefined) terminal.say(pairedLine(pairedAt));
  return endpoint;
}
