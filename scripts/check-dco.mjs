// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from "node:child_process";

const base = process.env.DCO_BASE_SHA;
const head = process.env.DCO_HEAD_SHA ?? "HEAD";
if (base === undefined || !/^[a-f0-9]{40}$/i.test(base)) {
  throw new Error("DCO_BASE_SHA must be a full commit SHA");
}
if (!/^[a-f0-9]{40}$/i.test(head) && head !== "HEAD") {
  throw new Error("DCO_HEAD_SHA must be a full commit SHA or HEAD");
}

const output = execFileSync(
  "git",
  ["log", `${base}..${head}`, "--format=%H%x00%an%x00%ae%x00%P%x00%ce%x00%B%x00"],
  { encoding: "utf8" },
);
const fields = output.split("\0");
const failures = [];

for (let index = 0; index + 5 < fields.length; index += 6) {
  const [sha, authorName, authorEmail, parents, committerEmail, body] = fields.slice(index, index + 6);
  const normalizedSha = sha.trim();
  if (normalizedSha === "") continue;
  if (authorName.endsWith("[bot]")) continue;
  // GitHub's "Update branch" button merges the base into a pull request and
  // commits as GitHub itself, with no sign-off and nothing the author wrote.
  // Only that mechanical merge is exempt: a merge someone made by hand can
  // carry conflict-resolution edits, so it still needs its author's sign-off.
  const isMerge = parents.trim().split(" ").length > 1;
  if (isMerge && committerEmail.trim().toLowerCase() === "noreply@github.com") continue;
  const signoffs = [...body.matchAll(/^Signed-off-by:\s*(.+?)\s*<([^<>]+)>$/gim)];
  const authorSigned = signoffs.some(
    (match) => match[2].trim().toLowerCase() === authorEmail.trim().toLowerCase(),
  );
  if (!authorSigned) {
    failures.push(
      `${normalizedSha.slice(0, 12)} ${authorName} <${authorEmail}>`,
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `DCO sign-off missing for:\n${failures.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("All non-bot commits carry an author DCO sign-off.\n");
}
