// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Terminal output for people, without changing it for programs.
//
// The CLI's contract with scripts, tests, and MCP clients is JSON on stdout,
// and that has to stay byte-for-byte what it was. A person at a terminal gets
// a readable report instead, decided by one rule: stdout is a TTY and `--json`
// was not passed. Anything piped or captured never sees a single ANSI byte.

import { printable } from "@melra/server/kernel";

export type Status = "pass" | "warn" | "fail";

/** A readable report for this invocation, rather than JSON. */
export function isHuman(
  args: readonly string[],
  stream: { isTTY?: boolean } = process.stdout,
): boolean {
  return !args.includes("--json") && stream.isTTY === true;
}

// https://no-color.org: a non-empty NO_COLOR turns colour off whatever else is
// set. FORCE_COLOR follows Node's own reading ("0"/"false" off, anything else
// on). Checked here rather than through `tty.WriteStream.hasColors()`, which
// answers the same but prints a process warning when both are set.
function colorEnabled(): boolean {
  const { NO_COLOR, FORCE_COLOR, TERM } = process.env;
  if (NO_COLOR !== undefined && NO_COLOR !== "") return false;
  if (FORCE_COLOR !== undefined) return FORCE_COLOR !== "0" && FORCE_COLOR !== "false";
  return process.stdout.isTTY === true && TERM !== "dumb";
}

// Read per call, not once at load, so a test can change the environment. An
// empty string stays empty, so a blank table cell leaves no trailing codes.
const sgr = (open: number, close: number) => (text: string) =>
  text !== "" && colorEnabled() ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export const paint = {
  ok: sgr(32, 39),
  warn: sgr(33, 39),
  fail: sgr(31, 39),
  dim: sgr(2, 22),
  bold: sgr(1, 22),
};

// The legacy Windows console renders ✓ ⚠ ✗ as boxes. Windows Terminal (which
// sets WT_SESSION) and VS Code's terminal do not, so only the old one gets ASCII.
function unicode(): boolean {
  return (
    process.platform !== "win32" ||
    process.env.WT_SESSION !== undefined ||
    process.env.TERM_PROGRAM === "vscode"
  );
}

/** The coloured status symbol: ✓ ⚠ ✗, or [ok] [warn] [fail] where those would not render. */
export function mark(status: Status): string {
  const [symbol, ascii, color] =
    status === "pass"
      ? (["✓", "[ok]", paint.ok] as const)
      : status === "warn"
        ? (["⚠", "[warn]", paint.warn] as const)
        : (["✗", "[fail]", paint.fail] as const);
  return color(unicode() ? symbol : ascii);
}

// Colour codes take no columns on screen, so alignment measures without them.
const width = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "").length;

/**
 * Rows as aligned columns, one line per row. Every column but the last is
 * padded to its widest cell, so a two-column table is a key/value list.
 */
export function table(
  rows: readonly (readonly string[])[],
  options: { indent?: number } = {},
): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, width(cell));
    });
  }
  const indent = " ".repeat(options.indent ?? 0);
  return rows
    .map((row) =>
      indent +
      row
        .map((cell, column) =>
          column === row.length - 1
            ? cell
            : cell + " ".repeat((widths[column] ?? 0) - width(cell)),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/**
 * The one place a command decides between its JSON and its human report. The
 * JSON branch is exactly what the CLI has always written, so a script cannot
 * tell this function exists.
 */
export function printJsonOrHuman<T>(
  value: T,
  renderHuman: (value: T) => string,
  args: readonly string[],
): void {
  process.stdout.write(
    isHuman(args) ? `${renderHuman(value)}\n` : `${printable(JSON.stringify(value, null, 2), true)}\n`,
  );
}
