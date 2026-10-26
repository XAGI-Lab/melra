// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Checks a `pnpm build:sea` binary the way a user without Node would meet it:
// a PATH holding only the system directories, a fresh home and workspace.
// `conformance` spawns the binary again as its own MCP server, so passing L3
// proves the stdio server, the kernel, and SQLite all run from the one file.
// The enforced run spawns it a third way, as the suite's out-of-band
// `approve`, which is the only check of that path from a single executable.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binary = join(root, "dist-sea", process.platform === "win32" ? "melra.exe" : "melra");
const home = await mkdtemp(join(tmpdir(), "melra-sea-smoke-"));
const systemPath =
  process.platform === "win32"
    ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32"), process.env.SystemRoot ?? "C:\\Windows"].join(";")
    : "/usr/bin:/bin";
const env = {
  PATH: systemPath,
  HOME: home,
  USERPROFILE: home,
  ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
  MELRA_HOME: join(home, ".melra"),
  MELRA_WORKSPACE: home,
};
const run = (...args) => execFileSync(binary, args, { env, cwd: home, encoding: "utf8", timeout: 180_000 });
// Enforced mode refuses a data directory inside the workspace, so this one
// works one level down from the home that holds it.
const workspace = join(home, "workspace");

try {
  const version = run("version").trim();
  const doctor = JSON.parse(run("doctor", "--json"));
  const conformance = JSON.parse(run("conformance", "--json"));
  await mkdir(workspace);
  const enforced = JSON.parse(
    execFileSync(binary, ["conformance", "--json"], {
      env: { ...env, MELRA_WORKSPACE: workspace, MELRA_MODE: "enforced" },
      cwd: workspace,
      encoding: "utf8",
      timeout: 180_000,
    }),
  );
  // With node:sqlite turned off, the binary names the cause instead of
  // crashing at load, as the npm CLI does.
  let refused;
  try {
    execFileSync(binary, ["version"], {
      env: { ...env, NODE_OPTIONS: "--no-experimental-sqlite" },
      cwd: home,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
  } catch (error) {
    refused = error;
  }
  if (refused?.status !== 1 || !String(refused.stderr).includes("has node:sqlite turned off")) {
    throw new Error(`sea_smoke_sqlite_off_failed: ${refused?.status} ${String(refused?.stderr ?? "").slice(0, 300)}`);
  }
  const result = {
    version,
    doctorReady: doctor.ready,
    level: conformance.level,
    passed: `${conformance.passed}/${conformance.of}`,
    enforced: { mode: enforced.mode, level: enforced.level, passed: `${enforced.passed}/${enforced.of}` },
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!doctor.ready || conformance.level !== 3 || conformance.target.command !== binary) {
    throw new Error("sea_smoke_failed");
  }
  // L3 in enforced mode is earned only with an operator's out-of-band yes, so
  // a passing provenance check means the suite's own `approve` ran.
  const approved = enforced.checks.some((check) => check.name === "approval-provenance-recorded" && check.passed);
  if (enforced.mode !== "enforced" || enforced.level !== 3 || enforced.passed !== enforced.of || !approved) {
    throw new Error("sea_smoke_enforced_failed");
  }
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
