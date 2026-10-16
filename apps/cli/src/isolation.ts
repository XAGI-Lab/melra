// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

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
          ? "not visible on win32, and MELRA has no native Windows recipe; run it under Docker or WSL2 for OS isolation (examples/deploy)"
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
