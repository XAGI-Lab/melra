// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Runs the built CLI under examples/deploy/macos/melra.sb with sandbox-exec and
// checks both sides: MELRA works inside it (doctor ready, conformance L3,
// which writes, reads, and deletes a workspace file), and the kernel refuses a
// write outside the workspace from a process MELRA could run. macOS only; CI
// runs it on macos-latest.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const profile = join(root, "examples/deploy/macos/melra.sb");
// Outside /tmp and /var/folders, which the profile allows for scratch files.
const base = await mkdtemp(join(process.env.RUNNER_TEMP ?? homedir(), "melra-sandbox-"));
const workspace = join(base, "project");
const data = join(base, ".melra");
await mkdir(workspace);
await mkdir(data);
const escape = join(homedir(), `melra-sandbox-escape-${process.pid}.txt`);

const sandboxed = (command, args) => [
  "sandbox-exec",
  ["-f", profile, "-D", `WORKSPACE=${workspace}`, "-D", `MELRA_HOME=${data}`, command, ...args],
];
const env = { ...process.env, MELRA_WORKSPACE: workspace, MELRA_HOME: data };
const melra = (...args) => {
  const [command, argv] = sandboxed(process.execPath, [join(root, "apps/cli/dist/bin.js"), ...args]);
  return JSON.parse(execFileSync(command, argv, { env, cwd: workspace, encoding: "utf8", timeout: 180_000 }));
};
// What a terminal task could run: plain Node writing a file.
const write = (path) => {
  const [command, argv] = sandboxed(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(path)}, "x")`]);
  return spawnSync(command, argv, { encoding: "utf8" });
};

try {
  const doctor = melra("doctor", "--json");
  const conformance = melra("conformance", "--json");
  const inside = write(join(workspace, "inside.txt"));
  const outside = write(escape);
  const result = {
    ready: doctor.ready,
    level: conformance.level,
    insideWrite: inside.status === 0,
    outsideRefused: outside.status !== 0 && /EPERM|not permitted/i.test(outside.stderr),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (existsSync(escape)) throw new Error("macos_sandbox_smoke_escaped");
  if (!result.ready || result.level !== 3 || !result.insideWrite || !result.outsideRefused) {
    throw new Error("macos_sandbox_smoke_failed");
  }
} finally {
  await rm(escape, { force: true });
  await rm(base, { recursive: true, force: true });
}
