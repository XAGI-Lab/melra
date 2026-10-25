// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Peak-RSS sampler. Reports the highest total resident memory across all node
// processes seen while a command runs, so a memory regression in the test
// runner is measurable instead of anecdotal.
//
// Usage: node scripts/peak-rss.mjs -- <command> [args...]

import { spawn, execSync } from "node:child_process";

const separator = process.argv.indexOf("--");
const command = process.argv.slice(separator + 1);
if (separator === -1 || command.length === 0) {
  console.error("usage: node scripts/peak-rss.mjs -- <command> [args...]");
  process.exit(2);
}

let peakGib = 0;
let peakCount = 0;

function sample() {
  try {
    const rows = execSync("ps -Ao rss=,comm=", { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes("node"));
    const kib = rows.reduce(
      (total, line) => total + Number.parseInt(line.trim(), 10) || total,
      0,
    );
    const gib = kib / 1024 / 1024;
    if (gib > peakGib) {
      peakGib = gib;
      peakCount = rows.length;
    }
  } catch {
    // A sample that fails mid-run is not worth aborting the measurement over.
  }
}

const timer = setInterval(sample, 500);

const child = spawn(command[0], command.slice(1), {
  stdio: ["inherit", "ignore", "inherit"],
  shell: process.platform === "win32",
});

child.on("exit", (code) => {
  clearInterval(timer);
  console.error(
    `[peak-rss] peak ${peakGib.toFixed(2)} GiB across ${peakCount} node processes`,
  );
  process.exitCode = code ?? 1;
});
