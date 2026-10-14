// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Runs the built CLI under the hardening in examples/deploy/systemd/
// melra.service, via `systemd-run`, and checks two things: `doctor` sees the
// restrictions the unit asks for, and MELRA still works inside them
// (conformance L3, which writes, reads, and deletes a file in the workspace).
// Linux with systemd and sudo only; CI runs it on ubuntu-latest.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const unit = await readFile(join(root, "examples/deploy/systemd/melra.service"), "utf8");

// Every [Service] setting below the hardening marker, as written.
const hardening = unit
  .split("# --- hardening")[1]
  .split("[Install]")[0]
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => /^[A-Z][A-Za-z]+=/.test(line));
if (!hardening.some((line) => line.startsWith("ReadWritePaths="))) {
  throw new Error("unit has no ReadWritePaths");
}

// Not under /tmp: PrivateTmp gives the service a /tmp of its own.
const base = await mkdtemp(join(process.env.RUNNER_TEMP ?? root, "melra-systemd-"));
const workspace = join(base, "project");
const data = join(base, ".melra");
await mkdir(workspace);
await mkdir(data);

const properties = hardening.flatMap((line) => [
  "-p",
  line.startsWith("ReadWritePaths=") ? `ReadWritePaths=${workspace} ${data}` : line,
]);
const run = (...args) =>
  execFileSync(
    "sudo",
    [
      "systemd-run",
      "--wait",
      "--pipe",
      "--quiet",
      "--collect",
      "-p",
      `User=${userInfo().username}`,
      ...properties,
      `--setenv=HOME=${base}`,
      `--setenv=MELRA_WORKSPACE=${workspace}`,
      `--setenv=MELRA_HOME=${data}`,
      `--working-directory=${workspace}`,
      process.execPath,
      join(root, "apps/cli/dist/bin.js"),
      ...args,
    ],
    { encoding: "utf8", timeout: 180_000 },
  );

try {
  const doctor = JSON.parse(run("doctor", "--json"));
  const isolation = doctor.checks.find((check) => check.name === "isolation");
  const conformance = JSON.parse(run("conformance", "--json"));
  process.stdout.write(
    `${JSON.stringify({ ready: doctor.ready, isolation: isolation?.detail, level: conformance.level })}\n`,
  );
  for (const expected of ["no capabilities", "no_new_privs", "seccomp filter", "read-only root"]) {
    if (!isolation?.detail.includes(expected)) throw new Error(`systemd_smoke_isolation_missing:${expected}`);
  }
  if (!doctor.ready || conformance.level !== 3) throw new Error("systemd_smoke_failed");
} finally {
  await rm(base, { recursive: true, force: true });
}
