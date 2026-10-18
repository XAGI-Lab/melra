// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Bounded recursive script runner: `node scripts/run-recursive.mjs <script>`.
//
// Every recursive fan-out in this workspace multiplies. `pnpm -r test` runs N
// packages in flight and each one starts a bare `vitest run` that sizes its own
// fork pool from the core count, so a 10-core machine peaked near 40 Node
// processes and exhausted memory. `pnpm -r build` and `pnpm -r typecheck` have
// one level instead of two, but each `tsc` holds a whole program graph in
// memory, so pnpm's default of four in flight is several GiB on its own.
//
// This caps the fan-out from one place and derives the cap from the machine
// rather than a number that happens to fit the author's laptop.

import { spawn } from "node:child_process";
import { cpus, totalmem } from "node:os";

const script = process.argv[2];
if (script === undefined) {
  console.error("usage: node scripts/run-recursive.mjs <script> [pnpm args...]");
  process.exit(2);
}
const passthrough = process.argv.slice(3);

// Measured peaks in this workspace: a test fork sits near 400 MB (SQLite,
// playwright-core, MCP servers), a `tsc` program near 1.5 GiB. Budget a quarter
// of RAM for the fan-out so the rest of the machine keeps running, and never let
// it exceed the cores that would actually serve it.
const GIB = 1024 ** 3;
const isTest = script === "test";
const perProcessGiB = isTest ? 0.4 : 1.5;
const ramBudget = Math.floor(((totalmem() / GIB) * 0.25) / perProcessGiB);
const processBudget = Math.max(1, Math.min(cpus().length - 2, ramBudget));

// Tests split the budget across two levels. Package-level concurrency buys less
// than fork-level does (each package pays a fresh vitest startup), so keep it
// small and give the remainder to forks. Every other script has one level only.
const workspaceConcurrency = isTest ? (processBudget >= 4 ? 2 : 1) : processBudget;
const maxWorkers = isTest ? Math.max(1, Math.floor(processBudget / workspaceConcurrency)) : 1;

console.error(
  `[run-recursive] ${script}: ${cpus().length} cores, ` +
    `${(totalmem() / GIB).toFixed(1)} GiB RAM -> ` +
    `${workspaceConcurrency} package(s)` +
    (isTest ? ` x ${maxWorkers} worker(s)` : ""),
);

// The fork cap goes to each package's `vitest run` as a flag, not as
// VITEST_MAX_WORKERS: vitest applies that variable after
// `--no-file-parallelism`, so it undid the one file at a time browser-runtime
// and storage-sqlite ask for (#238). The flag is read before it, so they keep
// one worker and every other package gets the cap. An inherited variable would
// override both, so it is dropped.
const { VITEST_MAX_WORKERS: _inherited, ...env } = process.env;
const child = spawn(
  "pnpm",
  [
    "-r",
    `--workspace-concurrency=${workspaceConcurrency}`,
    ...passthrough,
    // `run`, so the flag reaches the script: `pnpm test` parses it as its own.
    "run",
    script,
    ...(isTest ? [`--maxWorkers=${maxWorkers}`] : []),
  ],
  { stdio: "inherit", shell: process.platform === "win32", env },
);

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
