// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// The release workflows cannot run outside GitHub, so this holds the scripts
// they call, and the workflow lines that call them, to what the release needs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const scratch = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "melra-release-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), typeof text === "string" ? text : JSON.stringify(text));
  }
  return dir;
};

const notes = (body, args = ["--notes", "notes.md"]) => {
  const dir = scratch({ "package.json": { version: "1.1.0" }, "CHANGELOG.md": changelog(body) });
  const result = node("scripts/check-changelog.mjs", args, dir);
  return { ...result, notes: () => readFileSync(join(dir, "notes.md"), "utf8") };
};

// A workflow job's text, from its key to the next job's.
const job = (workflow, name) => workflow.split(/^(?= {2}\S)/m).find((text) => text.startsWith(`  ${name}:`)) ?? "";
const before = (text, first, then) => {
  const [a, b] = [text.indexOf(first), text.indexOf(then)];
  assert.ok(a !== -1 && b !== -1 && a < b, `${first} comes before ${then}`);
};

test("the release notes are the version's CHANGELOG section, breaking changes included", () => {
  const result = notes("\n### Changed\n\n- **Breaking:** renamed `x`.\n\n### Fixed\n\n- Fixed `y`.\n");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.notes(), "### Changed\n\n- **Breaking:** renamed `x`.\n\n### Fixed\n\n- Fixed `y`.\n");
});

test("a version with no notes fails docs:check, not just the release", () => {
  for (const args of [[], ["--notes", "notes.md"]]) {
    const result = notes("", args);
    assert.equal(result.status, 1, `check-changelog.mjs ${args.join(" ")}`);
    assert.match(result.stderr, /\[1\.1\.0\] has no notes to release/);
  }
});

test("the notes join wrapped lines, which a release body would render as line breaks", () => {
  const result = notes(
    "\n### Fixed\n\n- A fix wrapped\n  across lines:\n\n  - a nested item,\n    wrapped too\n\n  ```bash\n  melra doctor\n  melra serve\n  ```\n",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.notes(),
    "### Fixed\n\n- A fix wrapped across lines:\n\n  - a nested item, wrapped too\n\n  ```bash\n  melra doctor\n  melra serve\n  ```\n",
  );
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

test("a dependency cycle lists nothing, so the release publishes nothing", () => {
  const dir = scratch({
    "packages/aaa/package.json": { name: "@x/aaa" },
    "packages/bbb/package.json": { name: "@x/bbb", dependencies: { "@x/ccc": "workspace:*" } },
    "packages/ccc/package.json": { name: "@x/ccc", peerDependencies: { "@x/bbb": "workspace:*" } },
    "apps/.keep": "",
  });
  const result = node("scripts/publish-order.mjs", [], dir);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /dependency cycle: @x\/bbb -> @x\/ccc -> @x\/bbb/);
});

test("the release channel is the prerelease id, latest without one, and nothing else", () => {
  const channel = (version) => node("scripts/release-channel.mjs", [], scratch({ "package.json": { version } }));
  for (const [version, expected] of [["0.3.0-alpha.15", "alpha"], ["0.4.0-beta.1", "beta"], ["1.0.0-rc.2", "rc"], ["1.0.0", "latest"]]) {
    assert.equal(channel(version).stdout, `${expected}\n`, version);
  }
  const preview = channel("0.4.0-preview.1");
  assert.equal(preview.status, 1);
  assert.equal(preview.stdout, "");
  // So a bump to a version the release could not publish fails here, on the pull request.
  assert.equal(node("scripts/release-channel.mjs", [], root).status, 0);
});

test("the release workflows publish in that order, gate the container, and release those notes", () => {
  const release = read(".github/workflows/release.yml");
  const dryRun = read(".github/workflows/release-dry-run.yml");
  for (const workflow of [release, dryRun]) {
    assert.ok(!/globSync\("\{apps,packages\}/.test(workflow), "packages are listed by scripts/publish-order.mjs, not a glob");
    assert.match(workflow, /node scripts\/publish-order\.mjs/);
  }

  // Everything that can stop the release runs before anything is published.
  const artifacts = job(release, "artifacts");
  before(artifacts, "node scripts/check-changelog.mjs --notes ", "- name: Publish to npm");
  before(artifacts, "node scripts/release-channel.mjs", "- name: Publish to npm");
  assert.match(artifacts, /^ {6}channel: \$\{\{ steps\.channel\.outputs\.channel \}\}$/m);
  assert.match(artifacts, /^ {8}id: channel$/m);
  assert.match(artifacts, /--tag "\$\{CHANNEL\}"/);
  assert.match(artifacts, /--notes-file "\$\{RUNNER_TEMP\}\/release-notes\.md"/);
  assert.doesNotMatch(artifacts, /--generate-notes/);

  // The image moves last, after the install smoke too, under the tags npm uses.
  const container = job(release, "container");
  assert.match(container, /^ {4}needs: \[artifacts, installed\]$/m);
  assert.doesNotMatch(container, /:alpha\b/);
  assert.match(container, /:\$\{\{ needs\.artifacts\.outputs\.channel \}\}$/m);
  assert.match(container, /contains\(github\.ref_name, '-'\) && format\('\{0\}\/\{1\}:latest'/);
  assert.match(job(release, "artifacts"), /- name: Point latest at this prerelease\n {8}if: \$\{\{ contains\(github\.ref_name, '-'\) \}\}/);

  // The dry run rehearses the same checks, then publishes under the same channel.
  const dry = job(dryRun, "dry-run");
  before(dry, "pnpm security:audit", "npm publish");
  before(dry, "node scripts/check-changelog.mjs --notes ", "npm publish");
  before(dry, 'channel="$(node scripts/release-channel.mjs)"', 'npm publish "${tarball}" --dry-run --tag "${channel}"');
  assert.doesNotMatch(dry, /--tag alpha/);
});
