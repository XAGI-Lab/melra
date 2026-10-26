// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

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

test("docs:check fails a row the code no longer reads, and a help line with no row", () => {
  const docs = (names) => `| Variable | Meaning |\n| --- | --- |\n${names.map((name) => `| \`${name}\` | x |`).join("\n")}\n`;
  // The last help line runs straight into the closing backtick.
  const cli = (reads) => `${reads}
function help(): void {
  process.stdout.write(\`MELRA

Environment:
  MELRA_HOME                       Data directory
  MELRA_RETIRED                    Its row was removed
  MELRA_GONE                       No longer read\`);
}
`;
  const check = (reads) =>
    node("scripts/check-env-docs.mjs", [], scratch({
      "docs/INSTALLATION.md": docs(["MELRA_HOME", "MELRA_GONE"]),
      "apps/cli/src/index.ts": cli(reads),
    }));

  // The scratch tree has none of the Windows script variables, so the
  // allowlist complains in both runs; only the lines about these two matter.
  const stale = check("const home = process.env.MELRA_HOME;");
  assert.match(stale.stderr, /MELRA_GONE is documented but nothing in \{apps,packages\}\/\*\/src reads it; remove the row/);
  assert.doesNotMatch(stale.stderr, /missing from the Environment block|could not find/);
  const retired = /MELRA_RETIRED is listed in the Environment block of 'melra help' but has no row in docs\/INSTALLATION\.md; remove the line/;
  assert.match(stale.stderr, retired);

  const read = check("const home = process.env.MELRA_HOME;\nconst gone = process.env.MELRA_GONE;");
  assert.doesNotMatch(read.stderr, /MELRA_HOME|MELRA_GONE|help\(\)/);
  assert.match(read.stderr, retired);
});

test("docs:check stops at the end of help(), not at a later \"`);\" in the file", () => {
  // help()'s template no longer ends in "`);", but main() below it has one.
  // The scan must fail loudly rather than blank main() and miss its read.
  const cli = `function help(): void {
  process.stdout.write(\`MELRA

Environment:
  MELRA_HOME                       Data directory
\` + "");
}

function main(): void {
  const home = process.env.MELRA_HOME;
  const fresh = process.env.MELRA_FRESH;
  process.stdout.write(\`\${home}\${fresh}\`);
}
`;
  const result = node("scripts/check-env-docs.mjs", [], scratch({
    "docs/INSTALLATION.md": "| Variable | Meaning |\n| --- | --- |\n| `MELRA_HOME` | x |\n",
    "apps/cli/src/index.ts": cli,
  }));
  assert.match(result.stderr, /could not find help\(\) and the end of its template literal/);
  assert.match(result.stderr, /MELRA_FRESH \(first seen at apps\/cli\/src\/index\.ts:11\) has no row/);
});

test("docs:check fails a name help() mentions in its prose that has no row", () => {
  // MELRA_HOMEDIR is a typo in a description and MELRA_KEYDIR one in an
  // Environment continuation line; neither starts an Environment line.
  const cli = `function help(): void {
  process.stdout.write(\`MELRA

  --home DIR                       Same as MELRA_HOMEDIR=DIR

Environment:
  MELRA_HOME                       Data directory
                                   (the key lives in <MELRA_KEYDIR>)\`);
}
const home = process.env.MELRA_HOME;
`;
  const result = node("scripts/check-env-docs.mjs", [], scratch({
    "docs/INSTALLATION.md": "| Variable | Meaning |\n| --- | --- |\n| `MELRA_HOME` | x |\n",
    "apps/cli/src/index.ts": cli,
  }));
  assert.match(result.stderr, /'melra help' names MELRA_HOMEDIR, which has no row in docs\/INSTALLATION\.md/);
  assert.match(result.stderr, /'melra help' names MELRA_KEYDIR, which has no row in docs\/INSTALLATION\.md/);
  assert.doesNotMatch(result.stderr, /MELRA_HOME[^D]/);
});

test("docs:check fails loudly when help() cannot be found", () => {
  // Renamed, help() would leave start and end both -1; the whole file must
  // not be blanked, so the read in main() is still reported.
  const cli = `function usage(): void {
  process.stdout.write(\`MELRA

Environment:
  MELRA_HOME                       Data directory\`);
}
const fresh = process.env.MELRA_FRESH;
`;
  const result = node("scripts/check-env-docs.mjs", [], scratch({
    "docs/INSTALLATION.md": "| Variable | Meaning |\n| --- | --- |\n| `MELRA_HOME` | x |\n",
    "apps/cli/src/index.ts": cli,
  }));
  assert.match(result.stderr, /could not find help\(\) and the end of its template literal/);
  assert.match(result.stderr, /MELRA_FRESH \(first seen at apps\/cli\/src\/index\.ts:7\) has no row/);
});

test("licenses:check holds headers, manifests and LICENSE files to the path, and --fix sets them", () => {
  const header = (mark, id) => `${mark} Copyright 2026 XAGI Labs Private Limited\n${mark} SPDX-License-Identifier: ${id}\n`;
  const manifest = (license, files) => `${JSON.stringify({ name: "x", license, files }, null, 2)}\n`;
  const dir = scratch({
    "LICENSES/AGPL-3.0-only.txt": "agpl\n",
    "LICENSES/Apache-2.0.txt": "apache\n",
    LICENSE: "agpl\n",
    NOTICE: "notice\n",
    "package.json": manifest("AGPL-3.0-only"),
    // Holds outside contributors' Apache-2.0 code, so ships NOTICE and its text.
    "packages/server/package.json": manifest("AGPL-3.0-only", ["dist", "NOTICE", "LICENSES/Apache-2.0.txt"]),
    "packages/server/LICENSE": "agpl\n",
    "packages/sdk-ts/package.json": manifest("AGPL-3.0-only"),
    // Windows line endings, which --fix keeps.
    "packages/sdk-ts/src/index.ts": `${header("//", "AGPL-3.0-only")}export {};\n`.replaceAll("\n", "\r\n"),
    "packages/core/src/index.ts": `${header("//", "Apache-2.0")}export {};\n`,
    "scripts/run.mjs": "#!/usr/bin/env node\nconsole.log(1);\n",
    "sdk-py/src/melra/__init__.py": header("#", "Apache-2.0"),
    // A byte order mark, which --fix keeps.
    "sdk-py/src/melra/bom.py": `\uFEFF${header("#", "AGPL-3.0-only")}`,
  });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  const check = (args = []) => node("scripts/check-license-headers.mjs", args, dir);

  const failed = check();
  assert.equal(failed.status, 1);
  assert.deepEqual(failed.stderr.split("\n").filter((line) => line.includes(": ")).sort(), [
    "packages/core/src/index.ts: Apache-2.0, should be AGPL-3.0-only",
    "packages/sdk-ts/LICENSE: missing or not the text of LICENSES/Apache-2.0.txt, which packages/sdk-ts/package.json ships",
    "packages/sdk-ts/package.json: license is AGPL-3.0-only, should be Apache-2.0",
    "packages/sdk-ts/src/index.ts: AGPL-3.0-only, should be Apache-2.0",
    "packages/server/LICENSES/Apache-2.0.txt: missing or not the text of LICENSES/Apache-2.0.txt, which packages/server/package.json ships for the Apache-2.0 code in it",
    "packages/server/NOTICE: missing or not the text of NOTICE, which packages/server/package.json ships for the Apache-2.0 code in it",
    'scripts/run.mjs: no "// Copyright" / "// SPDX-License-Identifier: AGPL-3.0-only" header',
    "sdk-py/src/melra/bom.py: AGPL-3.0-only, should be Apache-2.0",
  ]);

  assert.equal(check(["--fix"]).status, 0);
  const file = (path) => readFileSync(join(dir, path), "utf8");
  assert.equal(file("packages/sdk-ts/src/index.ts"), `${header("//", "Apache-2.0")}export {};\n`.replaceAll("\n", "\r\n"));
  assert.equal(file("packages/core/src/index.ts"), `${header("//", "AGPL-3.0-only")}export {};\n`);
  assert.match(file("scripts/run.mjs"), /^#!\/usr\/bin\/env node\n\/\/ Copyright \d{4} XAGI Labs Private Limited\n\/\/ SPDX-License-Identifier: AGPL-3\.0-only\n\nconsole\.log\(1\);\n$/);
  assert.equal(file("packages/sdk-ts/package.json"), manifest("Apache-2.0"));
  assert.equal(file("packages/sdk-ts/LICENSE"), "apache\n");
  assert.equal(file("packages/server/NOTICE"), "notice\n");
  assert.equal(file("packages/server/LICENSES/Apache-2.0.txt"), "apache\n");
  assert.equal(file("sdk-py/src/melra/bom.py"), `\uFEFF${header("#", "Apache-2.0")}`);
  assert.equal(check().status, 0);
  // From a subdirectory the paths still resolve against the root.
  assert.equal(node("scripts/check-license-headers.mjs", ["--fix"], join(dir, "packages/sdk-ts")).status, 0);
  assert.equal(file("packages/sdk-ts/src/index.ts"), `${header("//", "Apache-2.0")}export {};\n`.replaceAll("\n", "\r\n"));

  // A second identifier, or a copy left out of "files", is for a person: --fix
  // fails and leaves the file as it was.
  const twice = `${header("//", "AGPL-3.0-only")}\n// SPDX-License-Identifier: Apache-2.0\n`;
  writeFileSync(join(dir, "packages/core/src/twice.ts"), twice);
  writeFileSync(join(dir, "packages/server/package.json"), manifest("AGPL-3.0-only", ["dist"]));
  const refused = check(["--fix"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^packages\/core\/src\/twice\.ts: an SPDX-License-Identifier line outside the header$/m);
  assert.match(refused.stderr, /^packages\/server\/package\.json: "files" does not list NOTICE$/m);
  assert.equal(file("packages/core/src/twice.ts"), twice);
});

test("the CLA check runs no code from the pull request it is triggered for", () => {
  // pull_request_target runs with this repository's token, so a checkout or a
  // run step here would hand that token to whoever opened the pull request.
  const cla = read(".github/workflows/cla.yml");
  assert.match(cla, /^ {2}pull_request_target:$/m);
  assert.doesNotMatch(cla, /actions\/checkout|^\s*(- )?run:/m);
  assert.deepEqual(cla.match(/^\s*- uses: .*$/gm).map((line) => line.trim().split("@")[0]), ["- uses: contributor-assistant/github-action"]);
  assert.match(cla, /contributor-assistant\/github-action@[0-9a-f]{40} # v/);
  assert.match(cla, /^ {6}contents: write # commit signatures to the cla-signatures branch$/m);
  assert.match(cla, /^ {10}branch: cla-signatures$/m);
});
