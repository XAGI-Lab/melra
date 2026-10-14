// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Checks a `pnpm build:sea` binary the way a user without Node would meet it:
// a PATH holding only the system directories, a fresh home and workspace.
// `conformance` spawns the binary again as its own MCP server, so passing L3
// proves the stdio server, the kernel, and SQLite all run from the one file.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

try {
  const version = run("version").trim();
  const doctor = JSON.parse(run("doctor", "--json"));
  const conformance = JSON.parse(run("conformance", "--json"));
  const result = { version, doctorReady: doctor.ready, level: conformance.level, passed: `${conformance.passed}/${conformance.of}` };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!doctor.ready || conformance.level !== 3 || conformance.target.command !== binary) {
    throw new Error("sea_smoke_failed");
  }
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
