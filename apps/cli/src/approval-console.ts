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
  // The page can pair before the opener returns; its line waits for the
  // address, so the terminal always reads address, then pairing.
  let held: string | undefined;
  let addressed = false;
  const endpoint = await serveHttp({
    runtime: melra,
    port: 0,
    approver: approverLabel(env, "console"),
    onPaired: (at) => {
      const line =
        `Paired with a browser tab at ${at.toTimeString().slice(0, 5)}. ` +
        `If no console tab just opened for you, press Ctrl-C now.\n`;
      if (addressed) terminal.say(line);
      else held = line;
    },
  });
  let opened: boolean;
  try {
    opened = await terminal.open(endpoint.url);
  } catch (error) {
    // An opener that throws must not leave the console listening behind it.
    if (held !== undefined) terminal.say(held);
    await endpoint.close();
    throw error;
  }
  if (!opened) {
    // A tab can have paired while the opener ran and still report failure:
    // that is exactly what the operator must hear about.
    if (held !== undefined) terminal.say(held);
    await endpoint.close();
    throw new Error(
      held === undefined
        ? "console_needs_a_browser: nothing here opens a browser, and the console's pairing code is never printed; use 'melra approve <task-id>'"
        : "console_needs_a_browser: the browser opener reported failure, yet a tab paired while it ran; check pending approvals and receipts ('melra tasks') before trusting them, and use 'melra approve <task-id>'",
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
  if (held !== undefined) terminal.say(held);
  return endpoint;
}
