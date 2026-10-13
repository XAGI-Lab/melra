// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// CHANGELOG.md is edited by every pull request at the same spot, so parallel
// branches collide there and a hand-resolved conflict can leave a duplicate
// `### Added`, a stray marker, or a release with no notes. This keeps it in
// Keep a Changelog shape (https://keepachangelog.com/en/1.1.0/).

import { readFileSync } from "node:fs";

const KINDS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];
const lines = readFileSync("CHANGELOG.md", "utf8").split(/\r?\n/);
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const failures = [];
const fail = (line, message) => failures.push(`CHANGELOG.md:${line}: ${message}`);

const releases = [];
let release;
let section;
let fence = false;
lines.forEach((text, index) => {
  const line = index + 1;
  if (/^(`{3,}|~{3,})/.test(text)) fence = !fence;
  if (fence) return;
  if (/^(<{7}|={7}|>{7})( |$)/.test(text)) fail(line, "merge conflict marker");
  const heading = /^## \[([^\]]+)\](.*)$/.exec(text);
  if (heading) {
    const [, name, rest] = heading;
    release = { name, line, sections: new Map(), date: undefined };
    releases.push(release);
    section = undefined;
    if (name === "Unreleased") {
      if (rest !== "") fail(line, "[Unreleased] takes no date");
    } else {
      const date = /^ - (\d{4}-\d{2}-\d{2})$/.exec(rest);
      if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(name)) fail(line, `[${name}] is not a semantic version`);
      if (date === null) fail(line, `[${name}] needs " - YYYY-MM-DD" after it`);
      else release.date = date[1];
    }
    return;
  }
  const kind = /^### (.+)$/.exec(text);
  if (kind) {
    if (release === undefined) return fail(line, `### ${kind[1]} before any release heading`);
    if (!KINDS.includes(kind[1])) fail(line, `### ${kind[1]} is not one of ${KINDS.join(", ")}`);
    if (release.sections.has(kind[1])) {
      fail(line, `second ### ${kind[1]} in [${release.name}] (first at line ${release.sections.get(kind[1]).line}); merge them`);
    }
    section = { line, entries: 0 };
    release.sections.set(kind[1], section);
    return;
  }
  if (section !== undefined && /^\s*[-*] /.test(text)) section.entries += 1;
});

for (const { name, sections } of releases) {
  for (const [kind, { line, entries }] of sections) {
    if (entries === 0) fail(line, `### ${kind} in [${name}] has no entries`);
  }
}

if (releases[0]?.name !== "Unreleased") fail(releases[0]?.line ?? 1, "the first release heading must be ## [Unreleased]");
const unreleased = releases.find(({ name }) => name === "Unreleased");
if (unreleased !== undefined) {
  // Order is only enforced where new entries go; history keeps the order it shipped with.
  const order = [...unreleased.sections.keys()];
  const sorted = [...order].sort((a, b) => KINDS.indexOf(a) - KINDS.indexOf(b));
  if (order.join() !== sorted.join()) fail(unreleased.line, `[Unreleased] sections should run ${sorted.join(", ")}`);
}

const dated = releases.filter(({ date }) => date !== undefined);
for (let i = 1; i < dated.length; i += 1) {
  if (dated[i].date > dated[i - 1].date) fail(dated[i].line, `[${dated[i].name}] is dated after the release above it`);
}

if (!releases.some(({ name }) => name === version)) {
  fail(1, `package.json is ${version} but there is no ## [${version}] section`);
}

const links = new Set(lines.flatMap((text) => /^\[([^\]]+)\]: \S/.exec(text)?.[1] ?? []));
for (const { name, line } of releases) {
  if (!links.has(name)) fail(line, `[${name}] has no link reference at the bottom of the file`);
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`CHANGELOG.md: ${releases.length} releases in Keep a Changelog shape.\n`);
}
