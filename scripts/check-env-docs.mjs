// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Every MELRA_* variable the shipped code reads must have a row in an
// environment table in docs/INSTALLATION.md, and every row must name a variable
// the code still reads. A variable the docs never mention is a feature nobody
// can find; a row for one nothing reads is a knob that does nothing. Every
// documented variable must also be listed in the Environment block of
// `melra help`, where a terminal user looks first, and every variable listed
// there must be documented.

import { glob, readFile } from "node:fs/promises";

const DOC = "docs/INSTALLATION.md";
const HELP = "apps/cli/src/index.ts";

// Runtime plumbing, not configuration: values MELRA sets on its own child
// processes. Documenting them as knobs would be wrong. Keep this a literal
// list, so adding a variable here is a decision someone makes on purpose.
const INTERNAL = new Map([
  ["MELRA_KEYS", "keystrokes handed to the Windows SendKeys PowerShell script"],
  ["MELRA_PATH", "screenshot output path handed to the Windows PowerShell script"],
  ["MELRA_X", "pointer x coordinate handed to the Windows PowerShell script"],
  ["MELRA_Y", "pointer y coordinate handed to the Windows PowerShell script"],
  ["MELRA_TO_X", "drag destination x handed to the Windows PowerShell script"],
  ["MELRA_TO_Y", "drag destination y handed to the Windows PowerShell script"],
  ["MELRA_NORMALIZED", "whether those coordinates are normalized, for the same script"],
  ["MELRA_MOVE", "move-the-pointer flag for the Windows PowerShell script"],
  ["MELRA_CLICK", "click flag for the Windows PowerShell script"],
  ["MELRA_DRAG", "drag flag for the Windows PowerShell script"],
  ["MELRA_WHEEL", "scroll amount handed to the Windows PowerShell script"],
]);

// Test files are skipped: a variable only a test sets (MELRA_TEST_STRIPE_KEY is
// a fake credential fixture) is not something an operator can configure. Test
// directories sit beside src/, so the src/ glob already leaves them out; the
// path check covers a test/ directory nested under src/ as well.
const isTest = (path) => /\.test\.[cm]?[jt]sx?$/.test(path) || /(^|[\\/])test[\\/]/.test(path);

// help() prints the Environment block, so the names in it are not reads: were
// they counted, a row would stay "read" after the code stopped reading it and
// the "remove the row" failure below could never fire. Its body is blanked,
// line breaks kept, before the scan, and also searched for the block.
const HELP_START = "function help(): void {";
const failures = [];
let helpEnvironment;
// Every name help() prints, prose and continuation lines included: blanked out
// of the read scan, they are checked against the docs here instead.
let helpNames = new Set();
const withoutHelp = (source) => {
  const start = source.indexOf(HELP_START);
  // Search within help() itself: a later "`);" in main() must not stand in for
  // the end of its template, or the scan would blank code that reads variables.
  const close = start === -1 ? -1 : source.indexOf("\n}\n", start);
  const end = close === -1 ? -1 : source.lastIndexOf("`);", close);
  if (end === -1 || end < start) {
    failures.push(`${HELP}: could not find help() and the end of its template literal`);
    return source;
  }
  const body = source.slice(start + HELP_START.length, end);
  helpEnvironment = /\nEnvironment:\n([\s\S]*)$/.exec(body)?.[1];
  helpNames = new Set(body.match(/MELRA_[A-Z0-9_]+/g) ?? []);
  return source.slice(0, start + HELP_START.length) + body.replace(/[^\n]/g, "") + source.slice(end);
};

const readBy = new Map();
for await (const path of glob("{apps,packages}/*/src/**/*.{ts,mts,cts,js,mjs}")) {
  if (isTest(path)) continue;
  const source = await readFile(path, "utf8");
  const lines = (path.replaceAll("\\", "/") === HELP ? withoutHelp(source) : source).split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [name] of line.matchAll(/MELRA_[A-Z0-9_]+/g)) {
      if (!readBy.has(name)) readBy.set(name, `${path.replaceAll("\\", "/")}:${index + 1}`);
    }
  });
}

// A row is a table line whose first cell is a backticked variable name.
const documented = new Map();
(await readFile(DOC, "utf8")).split(/\r?\n/).forEach((line, index) => {
  const name = /^\|\s*`(MELRA_[A-Z0-9_]+)`\s*\|/.exec(line)?.[1];
  if (name && !documented.has(name)) documented.set(name, index + 1);
});

for (const [name, where] of [...readBy].sort()) {
  if (!INTERNAL.has(name) && !documented.has(name)) {
    failures.push(`${name} (first seen at ${where}) has no row in the environment table in ${DOC}`);
  }
}
for (const [name, line] of documented) {
  if (!readBy.has(name)) {
    failures.push(`${DOC}:${line}: ${name} is documented but nothing in {apps,packages}/*/src reads it; remove the row`);
  }
}
// The Environment block is the tail of the help() template literal: each
// variable starts a line indented by two spaces; continuation lines are
// indented further and never start with a name.
const listed = new Set([...(helpEnvironment ?? "").matchAll(/^ {2}(MELRA_[A-Z0-9_]+)/gm)].map(([, name]) => name));
if (helpEnvironment === undefined) {
  failures.push(`${HELP}: could not find the Environment block of help()`);
} else {
  for (const [name, line] of documented) {
    if (!listed.has(name)) {
      failures.push(`${DOC}:${line}: ${name} is documented but missing from the Environment block of 'melra help' in ${HELP}`);
    }
  }
  // The other direction: a line for a variable with no row advertises a knob
  // that was retired, or one the docs never describe.
  for (const name of listed) {
    if (!documented.has(name)) {
      failures.push(`${HELP}: ${name} is listed in the Environment block of 'melra help' but has no row in ${DOC}; remove the line`);
    }
  }
}
// Named anywhere else in help(), in its usage text or a description, a name
// with no row is a typo or a retired knob all the same.
for (const name of helpNames) {
  if (!documented.has(name) && !listed.has(name)) {
    failures.push(`${HELP}: 'melra help' names ${name}, which has no row in ${DOC}`);
  }
}
for (const name of INTERNAL.keys()) {
  if (!readBy.has(name)) {
    failures.push(`${name} is allowlisted as internal in scripts/check-env-docs.mjs but no longer appears in the code; remove it`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `All ${readBy.size - INTERNAL.size} MELRA_* configuration variables are documented in ${DOC} and listed by 'melra help'.\n`,
  );
}
