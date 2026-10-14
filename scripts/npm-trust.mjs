// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Registers `.github/workflows/release.yml` in XAGI-Lab/melra as the trusted
// publisher for every public @melra/* package, so releases publish over OIDC
// with no npm token (docs/RELEASES.md). Run by a package owner, once, and again
// for any package added later:
//
//   npm login            # an owner account with 2FA; npm refuses tokens here
//   node scripts/npm-trust.mjs
//
// Needs npm 11.15+ (`npm trust`). Each package already trusted is left alone,
// so the script is safe to rerun.

import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const names = globSync("{apps,packages}/*/package.json")
  .map((path) => JSON.parse(readFileSync(path, "utf8")))
  .filter((manifest) => !manifest.private)
  .map((manifest) => manifest.name)
  .sort();

for (const name of names) {
  let existing = "";
  try {
    existing = execFileSync(npm, ["trust", "list", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    });
  } catch {
    // No trust configured yet reads the same as "not trusted": create it.
  }
  if (existing.includes("release.yml")) {
    process.stdout.write(`${name}: already trusted\n`);
    continue;
  }
  process.stdout.write(`${name}: trusting XAGI-Lab/melra release.yml\n`);
  // Inherits the terminal, so npm can ask for a one-time password.
  execFileSync(
    npm,
    ["trust", "github", name, "--file", "release.yml", "--repo", "XAGI-Lab/melra", "--allow-publish", "--yes"],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
}
process.stdout.write(`\n${names.length} packages trust XAGI-Lab/melra .github/workflows/release.yml\n`);
