// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { sandboxUse, type LocalPolicy } from "@melra/policy-core";
import { commandSandbox } from "@melra/server/kernel";
import type { CliEnvironment } from "./environment.js";
import type { DoctorCheck } from "./human.js";

/**
 * Which OS-level restrictions this process is actually running under, as far
 * as it can see from inside. Enforced mode closes the doors MELRA owns; these
 * are the ones only the kernel can close, so `doctor` reports them rather than
 * leaving `MELRA_MODE=enforced` to stand as an unbacked assertion (#52).
 */
export interface Isolation {
  /** Effective capability set is empty. */
  noCapabilities: boolean;
  /** `no_new_privs`: setuid binaries and file capabilities cannot raise privilege. */
  noNewPrivileges: boolean;
  /** A seccomp filter is installed. */
  seccomp: boolean;
  /** The root filesystem is mounted read-only. */
  readOnlyRoot: boolean;
  /** Running in a Docker or Podman container. */
  container: boolean;
}

/**
 * Read the restrictions out of `/proc/self/status` and `/proc/self/mountinfo`.
 * Pure, so the parsing is testable without a container.
 */
export function parseIsolation(status: string, mountinfo: string, container: boolean): Isolation {
  const field = (name: string) => new RegExp(`^${name}:\\s*(\\S+)`, "m").exec(status)?.[1];
  const capabilities = field("CapEff");
  // mountinfo: id parent major:minor root mount-point options ...
  const root = mountinfo
    .split("\n")
    .map((line) => line.split(" "))
    .filter((parts) => parts[4] === "/")
    .at(-1); // the last mount over / is the one in effect
  return {
    noCapabilities: capabilities !== undefined && /^0+$/.test(capabilities),
    noNewPrivileges: field("NoNewPrivs") === "1",
    seccomp: field("Seccomp") === "2",
    readOnlyRoot: root?.[5]?.split(",").includes("ro") ?? false,
    container,
  };
}

export async function detectIsolation(): Promise<Isolation | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const [status, mountinfo] = await Promise.all([
      readFile("/proc/self/status", "utf8"),
      readFile("/proc/self/mountinfo", "utf8"),
    ]);
    return parseIsolation(
      status,
      mountinfo,
      existsSync("/.dockerenv") || existsSync("/run/.containerenv"),
    );
  } catch {
    return undefined;
  }
}

/**
 * The doctor line. Never a `fail`: isolation is the operator's to arrange, and
 * a laptop in developer mode needs none. Enforced mode with nothing in effect
 * is a `warn`, because that is the case the operator should know about.
 */
export function isolationCheck(
  isolation: Isolation | undefined,
  mode: "developer" | "enforced",
): { name: string; status: "pass" | "warn"; detail: string } {
  const name = "isolation";
  const unbacked = mode === "enforced" ? "warn" : "pass";
  if (isolation === undefined) {
    return {
      name,
      status: unbacked,
      detail:
        process.platform === "win32"
          ? "not visible on win32, and MELRA has no native Windows recipe; for enforced mode run it under WSL2 with bubblewrap (the systemd unit) or in the container pair (examples/deploy/compose)"
          : `not visible on ${process.platform}; a sandbox profile cannot be read from inside`,
    };
  }
  const active = [
    isolation.container && "container",
    isolation.noCapabilities && "no capabilities",
    isolation.noNewPrivileges && "no_new_privs",
    isolation.seccomp && "seccomp filter",
    isolation.readOnlyRoot && "read-only root",
  ].filter((item): item is string => item !== false);
  return active.length === 0
    ? { name, status: unbacked, detail: "none in effect: full capabilities, no seccomp filter, writable root" }
    : { name, status: "pass", detail: active.join(", ") };
}

/**
 * Which OS sandbox commands run in here, or why none would and how to fix
 * that, found as the server finds it at startup (`detect` absent, this host's
 * own). A `fail` where the server would refuse to start; a `warn` where the
 * policy file's `if-available` lets enforced mode start without one.
 */
export async function sandboxCheck(
  env: Pick<CliEnvironment, "mode" | "unhinged" | "workspaceRoot" | "dataDirectory">,
  settings: LocalPolicy["sandbox"],
  paths: { policyPath?: string; secrets: Map<string, string> },
  detect?: Parameters<typeof commandSandbox>[2],
): Promise<DoctorCheck> {
  const name = "sandbox";
  const use = sandboxUse({ sandbox: settings, mode: env.mode, unhinged: env.unhinged });
  const off = env.unhinged ? "off under unsafe-local" : 'off in developer mode unless the policy file sets "sandbox": {"use": "on"}';
  if (env.mode === "enforced" && use === "off") {
    return {
      name,
      status: "fail",
      detail: 'enforced_mode_refuses_sandbox_off: the policy file sets "sandbox": {"use": "off"}',
      next: 'drop "use": "off", or set it to "if-available" to start without one where none works',
    };
  }
  const found = await commandSandbox(
    settings,
    { workspaceRoot: env.workspaceRoot, dataDirectory: env.dataDirectory, ...paths },
    detect,
  );
  if ("sandbox" in found) {
    return {
      name,
      status: "pass",
      detail:
        use === "off" ? `${found.sandbox.backend} works here; ${off}` : `${found.sandbox.backend}: every command runs in it`,
    };
  }
  const why = found.problems.join("; ");
  if (use === "off") return { name, status: "pass", detail: `${off}, and none would work here: ${why}` };
  if (use === "on") {
    return {
      name,
      status: "fail",
      detail: `sandbox_unavailable: the server refuses to start: ${why}`,
      next: 'fix one of those, or set "sandbox": {"use": "if-available"} in the policy file to start without one',
    };
  }
  return {
    name,
    status: env.mode === "enforced" ? "warn" : "pass",
    detail: `none works here, so the policy file's "if-available" starts without one: every command has MELRA's own rights, and every receipt says sandbox: none (${why})`,
    next: "fix what the sandbox line above names, so commands run in a sandbox",
  };
}
