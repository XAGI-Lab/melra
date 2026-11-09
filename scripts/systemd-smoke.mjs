// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Runs the built CLI under the hardening in examples/deploy/systemd/
// melra.service, via `systemd-run`, and checks three things: `doctor` sees the
// restrictions the unit asks for, MELRA still works inside them (conformance
// L3, which writes, reads, and deletes a file in the workspace), and what
// enforced mode does about commands. By default it must refuse to start and
// name bubblewrap's problem, as on a runner without it; with `--bubblewrap`,
// once it is installed and may make its namespaces, doctor must name it and
// conformance reach L3 in enforced mode too. Never a command with MELRA's own
// rights. Linux with systemd and sudo only; CI runs it on ubuntu-latest, once
// each way.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = process.argv.includes("--bubblewrap") ? "bubblewrap" : "refused";
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
const run = (args, setenv = []) =>
  execFileSync(
    "sudo",
    [
      "systemd-run",
      ...setenv.map((variable) => `--setenv=${variable}`),
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

// doctor exits 1 when a check fails, with the report still on stdout.
const report = (args, setenv) => {
  try {
    return JSON.parse(run(args, setenv));
  } catch (error) {
    if (typeof error.stdout === "string" && error.stdout.startsWith("{")) return JSON.parse(error.stdout);
    throw error;
  }
};

try {
  const doctor = JSON.parse(run(["doctor", "--json"]));
  const isolation = doctor.checks.find((check) => check.name === "isolation");
  const conformance = JSON.parse(run(["conformance", "--json"]));
  const enforced = ["MELRA_MODE=enforced"];
  const sandbox = report(["doctor", "--json"], enforced).checks.find((check) => check.name === "sandbox");
  const confined = sandbox?.status === "pass" ? JSON.parse(run(["conformance", "--json"], enforced)) : undefined;
  process.stdout.write(
    `${JSON.stringify({
      ready: doctor.ready,
      isolation: isolation?.detail,
      level: conformance.level,
      enforced: { expected, sandbox: sandbox?.detail, level: confined?.level },
    })}\n`,
  );
  for (const expected of ["no capabilities", "no_new_privs", "seccomp filter", "read-only root"]) {
    if (!isolation?.detail.includes(expected)) throw new Error(`systemd_smoke_isolation_missing:${expected}`);
  }
  if (!doctor.ready || conformance.level !== 3) throw new Error("systemd_smoke_failed");
  const refused = sandbox?.status === "fail" && sandbox.detail.startsWith("sandbox_unavailable: ") && /bubblewrap: /.test(sandbox.detail);
  const inBubblewrap = sandbox?.status === "pass" && sandbox.detail.startsWith("bubblewrap") && confined?.level === 3;
  if (!(expected === "bubblewrap" ? inBubblewrap : refused)) {
    throw new Error(`systemd_smoke_enforced_sandbox:${expected}:${JSON.stringify(sandbox)}`);
  }
} finally {
  await rm(base, { recursive: true, force: true });
}
