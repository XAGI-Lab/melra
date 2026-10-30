// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { isolationCheck, parseIsolation, protectionCheck, sandboxCheck } from "../src/isolation.js";

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

describe("doctor sandbox check", () => {
  // A host where no sandbox works, such as Windows or a Linux runner without
  // bubblewrap.
  const none = async () => ({ problems: ["test: none here"] });
  const env = (mode: "developer" | "enforced") => ({ mode, unhinged: false, workspaceRoot: "/w", dataDirectory: "/d" });
  const found = (mode: "developer" | "enforced", use?: "on" | "off" | "if-available") =>
    sandboxCheck(env(mode), { symlinks: [], listen: [], readable: [], ...(use === undefined ? {} : { use }) }, { secrets: new Map() }, none);
  const check = async (mode: "developer" | "enforced", use?: "on" | "off" | "if-available") => (await found(mode, use)).check;

  it("fails where the server would refuse to start, and says how to fix it", async () => {
    for (const [mode, use] of [["enforced", undefined], ["enforced", "on"], ["developer", "on"]] as const) {
      expect(await check(mode, use), `${mode} ${use}`).toMatchObject({
        status: "fail",
        detail: expect.stringMatching(/^sandbox_unavailable: .*test: none here/),
        next: expect.stringContaining('"sandbox": {"use": "if-available"}'),
      });
    }
    expect(await check("enforced", "off")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/^enforced_mode_refuses_sandbox_off: /),
      next: expect.stringContaining("if-available"),
    });
  });

  it("warns where enforced mode starts on the opt-out, and passes in developer mode", async () => {
    expect(await check("enforced", "if-available")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("every receipt says sandbox: none (test: none here)"),
    });
    expect((await check("developer", "if-available")).status).toBe("pass");
    // Developer mode looks for one by default, and says whose choice it was to start without.
    expect(await found("developer")).toEqual({
      check: expect.objectContaining({ status: "pass", detail: expect.stringContaining(`developer mode's default "if-available"`) }),
      commands: "none",
    });
    expect(await found("developer", "off")).toEqual({
      check: expect.objectContaining({ status: "pass", detail: expect.stringContaining('off: the policy file sets "sandbox": {"use": "off"}') }),
      commands: "off",
    });
    expect((await found("enforced", "on")).commands).toBe("refused");
  });

  it("names the sandbox commands run in where one works", async () => {
    const works = async () => ({ sandbox: { backend: "seatbelt", confine: async ({ file, args }: { file: string; args: string[] }) => ({ file, args }) } });
    const settings = { symlinks: [], listen: [], readable: [] };
    expect(await sandboxCheck(env("developer"), settings, { secrets: new Map() }, works)).toEqual({
      check: { name: "sandbox", status: "pass", detail: "seatbelt: every command runs in it" },
      commands: "seatbelt",
    });
  });
});

describe("doctor protection line", () => {
  const developer = { mode: "developer" as const, unhinged: false };
  const enforced = { mode: "enforced" as const, unhinged: false };

  it("says a developer-mode approval is the agent's own, and what a command runs in", () => {
    const check = protectionCheck(developer, "seatbelt");
    expect(check).toMatchObject({ name: "protection", status: "pass" });
    expect(check.detail).toContain("the agent can approve its own changes from the plan response, so an approval is a record, not a boundary");
    expect(check.detail).toContain("commands: in seatbelt, writing only the workspace and temp");
    // Only a listed few logins are denied; the rest of home stays readable.
    expect(check.detail).toContain(
      "reading neither MELRA's files nor the logins MELRA lists under home (other files there stay readable), and off the network without the network trait;",
    );
    expect(protectionCheck(developer, "bubblewrap").detail).toContain(
      "off the network without the network trait (Unix sockets on the filesystem stay reachable);",
    );
    expect(check.detail).toContain("harness: not inspected");
    expect(protectionCheck(developer, "none").detail).toContain("commands: with MELRA's own rights (no sandbox works here)");
    expect(protectionCheck(developer, "off").detail).toContain(`commands: with MELRA's own rights (sandbox "use": "off")`);
  });

  it("names the harness tools Claude Code's settings leave it, where the harness line read them", () => {
    expect(protectionCheck(developer, "seatbelt", ["Bash", "Edit"]).detail).toContain(
      "Claude Code: its settings leave it Bash, Edit, which go around MELRA",
    );
    expect(protectionCheck(developer, "seatbelt", []).detail).toContain("Claude Code: its settings remove its own shell, file and web tools");
  });

  it("warns where enforced mode has a gap under it, and under unsafe-local", () => {
    expect(protectionCheck(enforced, "bubblewrap", [])).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("approvals: only an operator's, out of band"),
    });
    expect(protectionCheck(enforced, "none").status).toBe("warn");
    // OpenClaw's or Hermes's config leaving it a shell is a gap too.
    const native = protectionCheck(enforced, "bubblewrap", [], ["openclaw"]);
    expect(native.status).toBe("warn");
    expect(native.detail).toContain("openclaw: its config leaves it tools of its own, which go around MELRA");
    expect(protectionCheck(developer, "seatbelt", undefined, ["hermes"]).status).toBe("pass");
    expect(protectionCheck(enforced, "bubblewrap", ["Bash"]).status).toBe("warn");
    expect(protectionCheck({ mode: "developer", unhinged: true }, "off")).toMatchObject({
      status: "warn",
      detail: expect.stringMatching(/^unsafe-local: nothing is checked, approved or confined/),
    });
  });
});
