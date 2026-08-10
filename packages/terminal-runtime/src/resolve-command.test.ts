// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { quoteForCmd, resolveCommand } from "./resolve-command.js";

/**
 * These run the Windows branch on every host. The Windows breakage shipped green
 * through a CI matrix that *includes* `windows-latest` precisely because nothing
 * exercised the win32 path, so platform and filesystem are injected rather than
 * detected.
 */
const WINDOWS_FILES = new Set(
  [
    "C:\\Program Files\\nodejs\\npm.cmd",
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Windows\\System32\\where.exe",
    // npm also ships a POSIX shell script with no extension, right next to the
    // shim. It is not runnable on Windows.
    "C:\\Program Files\\nodejs\\npm",
  ].map((item) => item.toLowerCase()),
);

const windows = {
  cwd: "C:\\workspace",
  platform: "win32" as const,
  path: "C:\\Program Files\\nodejs;C:\\Windows\\System32",
  pathExt: ".COM;.EXE;.BAT;.CMD",
  comspec: "C:\\Windows\\System32\\cmd.exe",
  exists: async (candidate: string) =>
    WINDOWS_FILES.has(candidate.toLowerCase()),
};

describe("resolveCommand", () => {
  it("leaves POSIX commands untouched", async () => {
    await expect(
      resolveCommand("git", ["status"], {
        cwd: "/workspace",
        platform: "linux",
      }),
    ).resolves.toEqual({
      file: "git",
      args: ["status"],
      windowsVerbatimArguments: false,
      executable: "git",
    });
  });

  it("resolves a bare Windows name to its .exe", async () => {
    const resolved = await resolveCommand("node", ["-v"], windows);
    expect(resolved.file.toLowerCase()).toBe(
      "c:\\program files\\nodejs\\node.exe",
    );
    expect(resolved.args).toEqual(["-v"]);
    expect(resolved.windowsVerbatimArguments).toBe(false);
  });

  it("prefers the .cmd shim over the extension-less POSIX script", async () => {
    // The deadlock in miniature: `npm` is what policy allowlists, `npm.cmd` is
    // what Windows can actually start, and `npm` (the sh script) is a trap.
    const resolved = await resolveCommand("npm", ["install"], windows);
    expect(resolved.executable.toLowerCase()).toBe(
      "c:\\program files\\nodejs\\npm.cmd",
    );
  });

  it("runs a batch shim through cmd.exe with the payload quoted", async () => {
    const resolved = await resolveCommand("npm", ["run", "build"], windows);
    expect(resolved.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(resolved.windowsVerbatimArguments).toBe(true);
    expect(resolved.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(resolved.args[3]).toBe(
      '""C:\\Program Files\\nodejs\\npm.cmd" "run" "build""',
    );
  });

  it("keeps shell metacharacters inside the quoted argument", async () => {
    // Without quoting, cmd.exe would treat `&&` as a separator and run a second
    // program that policy never allowlisted.
    const resolved = await resolveCommand(
      "npm",
      ["install", "x && calc.exe"],
      windows,
    );
    expect(resolved.args[3]).toContain('"install" "x && calc.exe"');
  });

  it("refuses arguments cmd.exe would expand rather than quoting them wrongly", async () => {
    await expect(
      resolveCommand("npm", ["install", "%USERPROFILE%"], windows),
    ).rejects.toThrow("terminal_windows_argument_not_quotable");
  });

  it("reports a missing program by name instead of a bare ENOENT", async () => {
    await expect(resolveCommand("rg", [], windows)).rejects.toThrow(
      "terminal_command_not_found:rg",
    );
  });

  it("does not search the working directory for a bare command", async () => {
    // A `git.cmd` dropped in the workspace must not shadow the allowlisted git.
    await expect(
      resolveCommand("git", [], {
        ...windows,
        exists: async (candidate: string) =>
          candidate.toLowerCase() === "c:\\workspace\\git.cmd",
      }),
    ).rejects.toThrow("terminal_command_not_found:git");
  });

  it("still honours an explicitly directory-qualified command", async () => {
    const resolved = await resolveCommand(".\\tool", [], {
      ...windows,
      exists: async (candidate: string) =>
        candidate.toLowerCase() === "c:\\workspace\\tool.exe",
    });
    expect(resolved.file.toLowerCase()).toBe("c:\\workspace\\tool.exe");
  });
});

describe("quoteForCmd", () => {
  it("escapes embedded quotes so the program sees them literally", () => {
    expect(quoteForCmd('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("doubles a trailing backslash run before the closing quote", () => {
    expect(quoteForCmd("C:\\path\\")).toBe('"C:\\path\\\\"');
  });

  it("refuses a newline, which a command line cannot carry", () => {
    expect(() => quoteForCmd("a\nb")).toThrow(
      "terminal_windows_argument_not_quotable",
    );
  });

  it("doubles a backslash run only where a quote consumes it", () => {
    // Mid-string backslashes are literal to CommandLineToArgvW; only the run
    // that a quote (or the closing quote) eats is doubled.
    expect(quoteForCmd('a\\\\b"c')).toBe('"a\\\\b\\"c"');
  });

  it("quotes a pathological backslash run without backtracking", () => {
    // The previous regex pair was quadratic: 40k backslashes took ~11s, which
    // an allowlisted `npm install <arg>` could reach from outside.
    const started = process.hrtime.bigint();
    expect(quoteForCmd("\\".repeat(40_000) + "x")).toHaveLength(40_003);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(500);
  });
});
