// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Characters a terminal does not show as themselves: controls (C0, C1, DEL),
 * format characters (bidi overrides, zero-width, soft hyphen, tag characters),
 * line and paragraph separators, the ones that render as nothing at all
 * (variation selectors, Hangul fillers, the grapheme joiner), and unassigned
 * code points, which a renderer may draw as nothing too.
 */
const HIDDEN =
  /[\p{Cc}\p{Cf}\p{Cn}\p{Zl}\p{Zp}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}]/gu;

/**
 * Combining marks past the second on one character: a long run of them draws
 * outside its own line, over the lines around it, the effect line included.
 * Only an approval screen spells them out, since it is the one place where
 * what sits around the agent's text must stay legible; elsewhere scripts that
 * stack more, such as Tibetan or pointed Hebrew, show as written.
 */
const STACKED = /(?<=[\p{Mn}\p{Me}]{2})[\p{Mn}\p{Me}]/gu;

const spelled = (character: string): string =>
  Array.from({ length: character.length }, (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`).join(
    "",
  );

/**
 * Text a terminal shows as text and nothing else. Everything in an approval
 * render except its labels was chosen by the agent asking for approval, and a
 * raw escape sequence in it can erase the line saying so, paint a different
 * effect, and hide the real one. Each hidden character is spelled out as
 * `\uXXXX` per UTF-16 unit, which inside JSON is also a valid escape for it.
 */
export function printable(text: string, keepNewlines = false): string {
  return text.replace(HIDDEN, (character) => (keepNewlines && character === "\n" ? character : spelled(character)));
}

/** `printable` for an approval screen: stacked combining marks spelled out too. */
function screened(text: string, keepNewlines = false): string {
  return printable(text, keepNewlines).replace(STACKED, spelled);
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
  const shown = screened(text);
  return shown.length > limit ? `${shown.slice(0, limit)}…(+${shown.length - limit} chars)` : shown;
}

/**
 * The operation, one bounded line per leaf, so what the effect actually does
 * (a command's arguments and environment, a move's destination, a request's
 * method and body) sits in the summary and not only in the dump above it.
 *
 * Every operation schema is strict, so its top-level fields are a fixed set.
 * Each list or record (args, env, headers, values, fields, filePaths) shows
 * whole entries from both ends, the first and last always, within its own
 * budget of lines, and says how many entries it left out, so no entry is shown
 * in part. Lists print first, then objects (a browser target, env, headers),
 * then plain values (a url, a cwd, a typed value) right above the effect: the
 * fields of fixed size sit below everything an agent can make longer.
 * Planning refuses a browser list its action never reads, so a list on screen
 * is the action's own and never padding.
 */
function operationLines(operation: unknown, fieldLimit = 8): string[] {
  const leaf = (path: string, value: unknown): string =>
    `${bounded(path, 60)}: ${bounded(typeof value === "string" ? JSON.stringify(value) : String(value))}`;
  const leaves = (value: unknown, path: string, into: string[]): string[] => {
    if (Array.isArray(value)) {
      if (value.length === 0) into.push(`${bounded(path, 60)}: []`);
      value.forEach((item, index) => leaves(item, `${path}[${index}]`, into));
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 0) into.push(`${bounded(path, 60)}: {}`);
      for (const [key, item] of entries) leaves(item, `${path}.${key}`, into);
    } else {
      into.push(leaf(path, value));
    }
    return into;
  };
  const summarise = (field: string, value: unknown): string[] => {
    if (value === null || typeof value !== "object") return [leaf(field, value)];
    const entries = Array.isArray(value)
      ? value.map((item, index) => leaves(item, `${field}[${index}]`, []))
      : Object.entries(value).map(([key, item]) => leaves(item, `${field}.${key}`, []));
    if (entries.length === 0) return [`${bounded(field, 60)}: ${Array.isArray(value) ? "[]" : "{}"}`];
    // Whole entries, alternately from each end, while they fit; when one end's
    // next entry does not, the other end goes on alone.
    let head = 1;
    let tail = entries.length > 1 ? 1 : 0;
    let used = entries[0]!.length + (tail === 1 ? entries.at(-1)!.length : 0);
    let headOpen = true;
    let tailOpen = true;
    while (head + tail < entries.length && (headOpen || tailOpen)) {
      const fromHead = headOpen && (!tailOpen || head <= tail);
      const next = entries[fromHead ? head : entries.length - 1 - tail]!;
      if (used + next.length > fieldLimit) {
        if (fromHead) headOpen = false;
        else tailOpen = false;
        continue;
      }
      used += next.length;
      if (fromHead) head += 1;
      else tail += 1;
    }
    const hidden = entries.slice(head, entries.length - tail);
    return [
      ...entries.slice(0, head).flat(),
      // A note as tall as what it stands for saves nothing: show that instead.
      ...(hidden.flat().length <= 1
        ? hidden.flat()
        : [`…(+${hidden.length} more ${bounded(field, 60)} entries, all in the JSON above)`]),
      ...entries.slice(entries.length - tail).flat(),
    ];
  };
  if (operation === null || typeof operation !== "object") return operation === undefined ? [] : [leaf("operation", operation)];
  const rank = (value: unknown): number => (Array.isArray(value) ? 0 : value !== null && typeof value === "object" ? 1 : 2);
  return Object.entries(operation)
    .sort(([, a], [, b]) => rank(a) - rank(b))
    .flatMap(([field, value]) => summarise(field, value));
}

/**
 * What MELRA itself vouches for, each line bounded: the task, the operation,
 * the effect, the agent's goal, and the digest. However long the agent's
 * content runs, its height is bounded, so a page can put it right above its
 * buttons, and the contract dump wherever it fits.
 */
export function approvalSummary(view: ApprovalScreenView): string {
  const { contract } = view;
  return [
    `Task ${view.task.id}, waiting for approval until ${view.task.approval?.expiresAt ?? "unknown"}`,
    "Operation:",
    ...operationLines(contract.operation).map((line) => `  ${line}`),
    `Effect: ${bounded(contract.capability, 60)} on ${bounded(contract.target)} (${bounded(contract.effect, 20)}, ${bounded(contract.risk, 20)} risk)`,
    `Goal (stated by the agent, unverified): ${bounded(contract.metadata.goal, 200)}`,
    `Contract digest: ${view.renderDigest}`,
    "",
  ].join("\n");
}

/**
 * The approval screen, ending with what MELRA itself vouches for: the full
 * contract first, so however long the agent's content runs it cannot push the
 * effect off the screen, then the summary right above the question. `terminal`
 * adds a reset after the contract, which only a terminal has any use for, and
 * `columns`, that terminal's width, wraps every line to it (`wrapToColumns`).
 */
export function approvalScreen(view: ApprovalScreenView, terminal = false, columns?: number): string {
  const screen = [
    screened(JSON.stringify(view.contract, null, 2), true),
    ...(terminal ? ["\u001b[0m"] : []),
    approvalSummary(view),
  ].join("\n");
  return terminal && columns !== undefined ? wrapToColumns(screen, columns) : screen;
}

/**
 * Every line wrapped to `columns` here, each continuation indented, so the
 * terminal has none to wrap itself: its wrap would start the rest at column 0,
 * where agent text padded to the right length reads like a line MELRA wrote,
 * the Effect line included. Anything past ASCII counts as two columns, the
 * most a terminal draws one in (one set to draw ambiguous-width characters
 * wide draws even Greek or Cyrillic in two), so no row comes out wider than
 * the terminal was when it was printed. Below 20 columns nothing is wrapped:
 * there is no room to indent.
 */
export function wrapToColumns(text: string, columns: number, indent = 4): string {
  if (!Number.isInteger(columns) || columns < 20) return text;
  const limit = columns - 1;
  const pad = " ".repeat(indent);
  return text
    .split("\n")
    .map((line) => {
      const rows: string[] = [];
      let row = "";
      let width = 0;
      for (const character of line) {
        const cells = character.codePointAt(0)! < 0x80 ? 1 : 2;
        if (width + cells > limit) {
          rows.push(row);
          row = pad;
          width = indent;
        }
        row += character;
        width += cells;
      }
      rows.push(row);
      return rows.join("\n");
    })
    .join("\n");
}
