// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Characters a terminal does not show as themselves: controls (C0, C1, DEL),
 * format characters (bidi overrides, zero-width, soft hyphen, tag characters),
 * line and paragraph separators, and the ones that render as nothing at all
 * (variation selectors, Hangul fillers, the grapheme joiner).
 */
const HIDDEN =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}]/gu;

/**
 * Text a terminal shows as text and nothing else. Everything in an approval
 * render except its labels was chosen by the agent asking for approval, and a
 * raw escape sequence in it can erase the line saying so, paint a different
 * effect, and hide the real one. Each hidden character is spelled out as
 * `\uXXXX` per UTF-16 unit, which inside JSON is also a valid escape for it.
 */
export function printable(text: string, keepNewlines = false): string {
  return text.replace(HIDDEN, (character) =>
    keepNewlines && character === "\n"
      ? character
      : Array.from(
          { length: character.length },
          (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`,
        ).join(""),
  );
}

export interface ApprovalScreenView {
  task: { id: string; approval?: { expiresAt: string } };
  contract: {
    capability: string;
    target: string;
    effect: string;
    risk: string;
    operation?: unknown;
    metadata: { goal: string };
  };
  renderDigest: string;
}

/** At most `limit` characters, saying how many more there were. */
function bounded(text: string, limit = 160): string {
  const shown = printable(text);
  return shown.length > limit ? `${shown.slice(0, limit)}…(+${shown.length - limit} chars)` : shown;
}

/**
 * The operation, one bounded line per field, so what the effect actually does
 * (a command's arguments and environment, a move's destination, a request's
 * method and body) sits in the summary and not only in the dump above it.
 * Bounded so no field can push the rest off the screen, and saying so when it
 * cut something.
 */
function operationLines(operation: unknown, limit = 12): string[] {
  const lines: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${path}: []`);
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) walk(item, path === "" ? key : `${path}.${key}`);
    } else {
      lines.push(`${bounded(path, 60)}: ${bounded(typeof value === "string" ? JSON.stringify(value) : String(value))}`);
    }
  };
  walk(operation, "");
  return lines.length > limit
    ? [...lines.slice(0, limit), `…(+${lines.length - limit} more fields, all in the JSON above)`]
    : lines;
}

/**
 * The approval screen, ending with what MELRA itself vouches for: the full
 * contract first, so however long the agent's content runs it cannot push the
 * effect off the screen, then the operation and the summary, each line
 * bounded, right above the question.
 */
export function approvalScreen(view: ApprovalScreenView): string {
  const { contract } = view;
  return [
    printable(JSON.stringify(contract, null, 2), true),
    "\u001b[0m",
    `Task ${view.task.id}, waiting for approval until ${view.task.approval?.expiresAt ?? "unknown"}`,
    "Operation:",
    ...operationLines(contract.operation).map((line) => `  ${line}`),
    `Effect: ${bounded(contract.capability, 60)} on ${bounded(contract.target)} (${bounded(contract.effect, 20)}, ${bounded(contract.risk, 20)} risk)`,
    `Goal (stated by the agent, unverified): ${bounded(contract.metadata.goal, 200)}`,
    `Contract digest: ${view.renderDigest}`,
    "",
  ].join("\n");
}
