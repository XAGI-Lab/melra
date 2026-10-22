// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Every MELRA_* variable the shipped code reads must have a row in an
// environment table in docs/INSTALLATION.md, and every row must name a variable
// the code still reads. A variable the docs never mention is a feature nobody
// can find; a row for one nothing reads is a knob that does nothing.

import { glob, readFile } from "node:fs/promises";

const DOC = "docs/INSTALLATION.md";

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

const readBy = new Map();
for await (const path of glob("{apps,packages}/*/src/**/*.{ts,mts,cts,js,mjs}")) {
  if (isTest(path)) continue;
  const lines = (await readFile(path, "utf8")).split(/\r?\n/);
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

const failures = [];
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
    `All ${readBy.size - INTERNAL.size} MELRA_* configuration variables are documented in ${DOC}.\n`,
  );
}
