// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// The release workflows cannot run outside GitHub, so this holds the scripts
// they call, and the workflow lines that call them, to what the release needs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const node = (script, args, cwd) => spawnSync(process.execPath, [join(root, script), ...args], { cwd, encoding: "utf8" });

const changelog = (body) => `# Changelog

## [Unreleased]

## [1.1.0] - 2026-10-20
${body}
## [1.0.0] - 2026-10-01

### Added

- The first release.

[Unreleased]: https://example.test/compare/v1.1.0...HEAD
[1.1.0]: https://example.test/compare/v1.0.0...v1.1.0
[1.0.0]: https://example.test/releases/tag/v1.0.0
`;

const notes = (body) => {
  const dir = mkdtempSync(join(tmpdir(), "melra-notes-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.1.0" }));
  writeFileSync(join(dir, "CHANGELOG.md"), changelog(body));
  const result = node("scripts/check-changelog.mjs", ["--notes", "notes.md"], dir);
  return { ...result, notes: () => readFileSync(join(dir, "notes.md"), "utf8") };
};

test("the release notes are the version's CHANGELOG section, breaking changes included", () => {
  const result = notes("\n### Changed\n\n- **Breaking:** renamed `x`.\n\n### Fixed\n\n- Fixed `y`.\n");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.notes(), "### Changed\n\n- **Breaking:** renamed `x`.\n\n### Fixed\n\n- Fixed `y`.\n");
});

test("a version with no notes stops the release", () => {
  const result = notes("");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[1\.1\.0\] has no notes to release/);
});

test("every package publishes after the @melra/* packages it depends on, the CLI last", () => {
  const result = node("scripts/publish-order.mjs", [], root);
  assert.equal(result.status, 0, result.stderr);
  const order = result.stdout.trim().split("\n").map((line) => line.split(" "));
  const position = new Map(order.map(([, name], index) => [name, index]));
  for (const [dir, name] of order) {
    const { dependencies = {} } = JSON.parse(read(`${dir}/package.json`));
    for (const dependency of Object.keys(dependencies).filter((d) => position.has(d))) {
      assert.ok(position.get(dependency) < position.get(name), `${dependency} publishes before ${name}`);
    }
  }
  const firstApp = order.findIndex(([dir]) => dir.startsWith("apps/"));
  assert.ok(firstApp > 0 && order.slice(firstApp).every(([dir]) => dir.startsWith("apps/")));
  assert.deepEqual(order.at(-1), ["apps/cli", "@melra/cli"]);
});

test("the release workflows publish in that order, gate the container, and release those notes", () => {
  const release = read(".github/workflows/release.yml");
  const dryRun = read(".github/workflows/release-dry-run.yml");
  for (const workflow of [release, dryRun]) {
    assert.ok(!/globSync\("\{apps,packages\}/.test(workflow), "packages are listed by scripts/publish-order.mjs, not a glob");
    assert.match(workflow, /node scripts\/publish-order\.mjs/);
    assert.match(workflow, /node scripts\/check-changelog\.mjs --notes /);
  }
  const container = release.split(/^(?= {2}\S)/m).find((job) => job.startsWith("  container:"));
  assert.match(container, /^ {4}needs: artifacts$/m);
  assert.doesNotMatch(container, /:alpha\b/);
  assert.match(container, /needs\.artifacts\.outputs\.channel/);
  assert.match(release, /--notes-file "\$\{RUNNER_TEMP\}\/release-notes\.md"/);
  assert.doesNotMatch(release, /--generate-notes/);
  assert.match(dryRun, /pnpm security:audit/);
});
