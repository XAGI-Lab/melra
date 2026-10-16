// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Versions move in lockstep across every manifest, the protocol constant, and
// the Python project. `check-versions.mjs` already knows where they all are;
// this writes the same set rather than making a release edit seventeen files by
// hand and discover the one it missed in CI.

import { glob, readFile, writeFile } from "node:fs/promises";

const next = process.argv[2];
if (next === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(next)) {
  process.stderr.write("usage: node scripts/set-version.mjs <semver>\n");
  process.exit(1);
}

const written = [];

async function edit(path, replace) {
  const before = await readFile(path, "utf8");
  const after = replace(before);
  if (after !== before) {
    await writeFile(path, after, "utf8");
    written.push(path);
  }
}

// Only the manifest's own top-level `version` moves. Workspace dependencies use
// `workspace:*` and published ranges belong to whoever set them.
const setManifestVersion = (text) =>
  text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${next}"`);

await edit("package.json", setManifestVersion);
for await (const path of glob("{apps,packages}/*/package.json")) {
  await edit(path, setManifestVersion);
}
await edit("packages/protocol/src/index.ts", (text) =>
  text.replace(
    /PRODUCT_VERSION = "[^"]*"/,
    `PRODUCT_VERSION = "${next}"`,
  ),
);
await edit("sdk-py/pyproject.toml", (text) =>
  text.replace(
    /^version = "[^"]*"/m,
    `version = "${next.replace("-alpha.", "a")}"`,
  ),
);
// A uv lock records the local project's own version, and `uv` rewrites the file
// the first time it runs against a changed `pyproject.toml`. Left behind, that
// rewrite lands mid-release: `pnpm check` runs pytest through uv, the worktree
// goes dirty, and the next step refuses to publish from it. Cheaper to move the
// recorded version with everything else than to explain the failure later.
const pythonVersion = next.replace("-alpha.", "a");
for (const lock of ["sdk-py/uv.lock", "benchmarks/browser-agent/uv.lock"]) {
  await edit(lock, (text) =>
    text.replace(
      /(\[\[package\]\]\nname = "melra"\nversion = )"[^"]*"/,
      `$1"${pythonVersion}"`,
    ),
  );
}

// The MCP Registry metadata names the release and the npm package it installs.
await edit("server.json", (text) => text.replace(/("version":\s*)"[^"]*"/g, `$1"${next}"`));
// The prose that names the current release (CURRENT_RELEASE_PROSE in
// check-versions.mjs); dated evidence elsewhere keeps the version it was for.
await edit("docs/CAPABILITIES.md", (text) => text.replace(/^This document describes `[^`]*`\./m, `This document describes \`${next}\`.`));
await edit("docs/COMPATIBILITY.md", (text) => text.replace(/^`[^`]*` is pre-stable\./m, `\`${next}\` is pre-stable.`));
await edit("README.md", (text) => text.replace(/^MELRA \S+ {2}developer mode$/m, `MELRA ${next}  developer mode`));

process.stdout.write(`${next}\n${written.map((p) => `  ${p}`).join("\n")}\n`);
