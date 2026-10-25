// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { isolationCheck, parseIsolation } from "../src/isolation.js";

// Trimmed from a container started with the docs/INSTALLATION.md#docker recipe.
const HARDENED_STATUS = "Name:\tnode\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t2\n";
const HARDENED_MOUNTS =
  "612 548 0:52 / / ro,relatime master:1 - overlay overlay rw,lowerdir=/x\n" +
  "613 612 0:55 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw\n" +
  "640 612 254:1 /ws /workspace rw,relatime - ext4 /dev/vda1 rw\n";
// A root shell on an ordinary host.
const HOST_STATUS = "Name:\tnode\nCapEff:\t000001ffffffffff\nNoNewPrivs:\t0\nSeccomp:\t0\n";
const HOST_MOUNTS = "29 1 254:1 / / rw,relatime shared:1 - ext4 /dev/vda1 rw\n";

describe("doctor isolation check", () => {
  it("reads every restriction the hardened container recipe applies", () => {
    expect(parseIsolation(HARDENED_STATUS, HARDENED_MOUNTS, true)).toEqual({
      noCapabilities: true,
      noNewPrivileges: true,
      seccomp: true,
      readOnlyRoot: true,
      container: true,
    });
    const check = isolationCheck(parseIsolation(HARDENED_STATUS, HARDENED_MOUNTS, true), "enforced");
    expect(check).toEqual({
      name: "isolation",
      status: "pass",
      detail: "container, no capabilities, no_new_privs, seccomp filter, read-only root",
    });
  });

  it("warns only when enforced mode has nothing underneath it", () => {
    const none = parseIsolation(HOST_STATUS, HOST_MOUNTS, false);
    expect(Object.values(none).some(Boolean)).toBe(false);
    expect(isolationCheck(none, "developer").status).toBe("pass");
    expect(isolationCheck(none, "enforced")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("none in effect"),
    });
    // Not Linux: nothing is readable, which is not the same as nothing in effect.
    expect(isolationCheck(undefined, "enforced")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("not visible"),
    });
    expect(isolationCheck(undefined, "developer").status).toBe("pass");
    // Native Windows gets no recipe of its own; doctor names the ones that work.
    if (process.platform === "win32") {
      expect(isolationCheck(undefined, "developer").detail).toContain("WSL2");
    }
  });
});
