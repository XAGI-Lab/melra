// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Which license a file is under depends on where it lives (LICENSING.md). The
// SDKs, the protocol they import and the examples stay Apache-2.0, so code that
// only calls MELRA can take any license; everything else is AGPL-3.0-only. This
// holds three things to that one table, so a file copied from one side to the
// other, or a package scaffolded from the wrong neighbour, fails here instead
// of shipping under the wrong license:
//
// - the Copyright / SPDX-License-Identifier header at the top of every source
//   file, tracked or new (untracked and not ignored);
// - the "license" of every package.json and pyproject.toml;
// - the LICENSE file beside each of those manifests, which npm and hatchling
//   put in the package: it must be the text in LICENSES/<id>.txt;
// - in the AGPL packages that hold outside contributors' Apache-2.0 code
//   (NOTICE), copies of NOTICE and LICENSES/Apache-2.0.txt, listed in "files".
//
//   node scripts/check-license-headers.mjs [--fix]
//
// --fix rewrites the header's identifier, adds a missing header (after any
// shebang), sets the manifest field and copies the license texts. It keeps a
// file's CRLF line endings and byte order mark, and leaves a second identifier
// line, or a "files" list that leaves a copy out, for a person to resolve.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// First prefix that matches wins.
const LICENSES = [
  ["packages/sdk-ts/", "Apache-2.0"],
  ["packages/protocol/", "Apache-2.0"],
  ["sdk-py/", "Apache-2.0"],
  ["examples/", "Apache-2.0"],
  ["", "AGPL-3.0-only"],
];
const licenseOf = (path) => LICENSES.find(([prefix]) => path.startsWith(prefix))[1];

// Outside contributors' Apache-2.0 code ships inside these AGPL packages.
const APACHE_PORTIONS = ["packages/server", "packages/browser-runtime", "apps/cli"];

const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;
const MANIFEST = /(?:^|\/)(?:package\.json|pyproject\.toml)$/;
const fix = process.argv.includes("--fix");
const failures = [];
let unfixable = false;
const report = (path, problem) => failures.push(`${path}: ${problem}`);
const copy = (target, source, why) => {
  const expected = readFileSync(source, "utf8");
  if (existsSync(target) && readFileSync(target, "utf8").replaceAll("\r\n", "\n") === expected.replaceAll("\r\n", "\n")) return;
  report(target, `missing or not the text of ${source}, ${why}`);
  if (fix) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, expected);
  }
};

// Every path below, and LICENSES/, is relative to the repository root.
process.chdir(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0")
  .map((path) => path.replaceAll("\\", "/"))
  .filter((path) => path !== "" && existsSync(path));

for (const path of paths.filter((path) => SOURCE.test(path))) {
  const id = licenseOf(path);
  const raw = readFileSync(path, "utf8");
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = raw.slice(bom.length);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const mark = path.endsWith(".py") ? "#" : "//";
  const spdx = `${mark} SPDX-License-Identifier: `;
  const at = lines[0].startsWith("#!") ? 1 : 0;
  const hasCopyright = new RegExp(`^${mark} Copyright \\d{4}(-\\d{4})? XAGI Labs Private Limited$`).test(lines[at] ?? "");
  const found = lines[at + 1]?.startsWith(spdx) ? lines[at + 1].slice(spdx.length) : undefined;
  // Any comment form: a second identifier in a block or JSDoc comment conflicts too.
  if (lines.some((line, i) => i !== at + 1 && /^\s*(?:\/\/|#|\/?\*+!?)\s*SPDX-License-Identifier:/.test(line))) {
    report(path, "an SPDX-License-Identifier line outside the header");
    unfixable = true;
    continue;
  }
  if (hasCopyright && found === id) continue;
  if (!hasCopyright) {
    report(path, `no "${mark} Copyright" / "${spdx}${id}" header`);
    const blank = (lines[at] ?? "").trim() === "" ? [] : [""];
    lines.splice(at, 0, `${mark} Copyright ${new Date().getFullYear()} XAGI Labs Private Limited`, spdx + id, ...blank);
  } else if (found === undefined) {
    report(path, `no "${spdx}${id}" line after the copyright`);
    lines.splice(at + 1, 0, spdx + id);
  } else {
    report(path, `${found}, should be ${id}`);
    lines[at + 1] = spdx + id;
  }
  if (fix) writeFileSync(path, bom + lines.join(eol));
}

for (const manifest of paths.filter((path) => MANIFEST.test(path))) {
  const id = licenseOf(manifest);
  const text = readFileSync(manifest, "utf8");
  const field = manifest.endsWith(".json")
    ? { pattern: /^( {2}"license": )"([^"]*)"/m, value: `"${id}"` }
    : { pattern: /^(license = )\{ text = "([^"]*)" \}/m, value: `{ text = "${id}" }` };
  const found = field.pattern.exec(text)?.[2];
  if (found !== id) {
    report(manifest, `license is ${found ?? "missing"}, should be ${id}`);
    if (found === undefined) unfixable = true;
    else if (fix) writeFileSync(manifest, text.replace(field.pattern, `$1${field.value}`));
  }
  // The root's LICENSE is the repository's, and checked like any other.
  const dir = dirname(manifest) === "." ? "" : `${dirname(manifest)}/`;
  copy(`${dir}LICENSE`, `LICENSES/${id}.txt`, `which ${manifest} ships`);
  if (APACHE_PORTIONS.includes(dirname(manifest))) {
    const files = JSON.parse(text).files ?? [];
    for (const name of ["NOTICE", "LICENSES/Apache-2.0.txt"]) {
      copy(dir + name, name, `which ${manifest} ships for the Apache-2.0 code in it`);
      if (!files.includes(name)) {
        report(manifest, `"files" does not list ${name}`);
        unfixable = true;
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `${failures.join("\n")}\n` +
      (fix ? "fixed what --fix can; review the changes\n" : "the license follows the path (LICENSING.md); run with --fix to correct these\n"),
  );
  process.exitCode = fix && !unfixable ? 0 : 1;
} else {
  process.stdout.write("Every source header, manifest license and package LICENSE matches LICENSING.md.\n");
}
