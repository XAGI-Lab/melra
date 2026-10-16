// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";

const root = JSON.parse(await readFile("package.json", "utf8"));
const expected = root.version;
const failures = [];

for await (const path of glob("{apps,packages}/*/package.json")) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest.version !== expected) {
    failures.push(`${path}: ${manifest.version ?? "missing"} != ${expected}`);
  }
}

const protocol = await readFile("packages/protocol/src/index.ts", "utf8");
if (!protocol.includes(`PRODUCT_VERSION = "${expected}"`)) {
  failures.push("packages/protocol/src/index.ts: PRODUCT_VERSION mismatch");
}

const python = await readFile("sdk-py/pyproject.toml", "utf8");
const pythonExpected = expected.replace("-alpha.", "a");
if (!python.includes(`version = "${pythonExpected}"`)) {
  failures.push(`sdk-py/pyproject.toml: expected ${pythonExpected}`);
}

// The locks record the local project's version too, and uv rewrites them on its
// next run when it disagrees. A stale lock therefore does not fail here — it
// fails during a release, as an unexplained dirty worktree three steps later.
for (const lock of ["sdk-py/uv.lock", "benchmarks/browser-agent/uv.lock"]) {
  const text = await readFile(lock, "utf8");
  if (
    !text.includes(
      `[[package]]\nname = "melra"\nversion = "${pythonExpected}"`,
    )
  ) {
    failures.push(`${lock}: melra entry is not ${pythonExpected} (run pnpm versions:set)`);
  }
}

// The Registry checks the npm package's `mcpName` against `server.json`'s name,
// case and all, and installs the version server.json names.
const server = JSON.parse(await readFile("server.json", "utf8"));
const cli = JSON.parse(await readFile("apps/cli/package.json", "utf8"));
if (server.version !== expected) failures.push(`server.json: version ${server.version} != ${expected}`);
for (const pkg of server.packages ?? []) {
  if (pkg.identifier === cli.name && pkg.version !== expected) {
    failures.push(`server.json: ${pkg.identifier} ${pkg.version} != ${expected}`);
  }
}
if (cli.mcpName !== server.name) failures.push(`apps/cli/package.json: mcpName ${cli.mcpName} != server.json name ${server.name}`);

// CURRENT_RELEASE_PROSE: the sentences that say which release the docs describe.
for (const [path, sentence] of [
  ["docs/CAPABILITIES.md", `This document describes \`${expected}\`.`],
  ["docs/COMPATIBILITY.md", `\`${expected}\` is pre-stable.`],
  ["README.md", `MELRA ${expected}  developer mode`],
]) {
  if (!(await readFile(path, "utf8")).includes(sentence)) failures.push(`${path}: does not name ${expected} as the current release`);
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`All package versions match ${expected}.\n`);
}
