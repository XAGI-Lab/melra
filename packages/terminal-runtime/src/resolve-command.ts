// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { win32 } from "node:path";

export interface ResolvedCommand {
  /** Executable actually handed to `spawn`. */
  file: string;
  args: string[];
  /** True when `args` is an already-quoted Windows command line. */
  windowsVerbatimArguments: boolean;
  /** Absolute path of the program the caller named, for the receipt. */
  executable: string;
}

export interface ResolveCommandOptions {
  cwd: string;
  platform?: NodeJS.Platform;
  path?: string | undefined;
  pathExt?: string | undefined;
  comspec?: string | undefined;
  /** Seam for tests: decides whether a candidate path is a runnable file. */
  exists?: (candidate: string) => Promise<boolean>;
}

/** What `cmd.exe` itself assumes when PATHEXT is unset. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Batch shims cannot be executed by `CreateProcess`, so Node refuses to spawn
 * them without a shell (CVE-2024-27980). They have to go through `cmd.exe`.
 */
const BATCH_SUFFIXES = [".bat", ".cmd"];

async function isFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Quote one argument so `cmd.exe /s /c` passes it through unchanged.
 *
 * Two layers have to agree. `cmd.exe` treats `& | < > ^ ( )` as syntax, but not
 * inside double quotes, so quoting neutralises them. The program's own
 * `CommandLineToArgvW` then unquotes, which is why backslashes before a quote
 * are doubled and a trailing backslash run is doubled before the closing quote.
 *
 * `%` and `!` are the exception: `cmd.exe` expands those *inside* quotes, and no
 * escape survives the round trip reliably. Rather than ship a
 * quoting scheme with a hole in it, an argument containing them is refused —
 * the allowlist would otherwise be bypassable by `npm install "%FOO%"`.
 * Newlines are refused for the same reason: a command line cannot carry one.
 *
 * Written as a scan rather than `/(\\*)"/g` + `/(\\*)$/`: both of those
 * backtrack quadratically, and an argument of 40k backslashes took 11s to quote
 * before this. An attacker-supplied argument is exactly the input this sees.
 */
export function quoteForCmd(value: string): string {
  if (/[%!\r\n]/.test(value)) {
    throw new Error("terminal_windows_argument_not_quotable");
  }
  let escaped = "";
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") {
      slashes += 1;
      continue;
    }
    // A backslash run doubles only when a quote consumes it. Anywhere else
    // `CommandLineToArgvW` reads it literally, so it passes through as written.
    escaped +=
      character === '"'
        ? `${"\\".repeat(slashes * 2)}\\"`
        : `${"\\".repeat(slashes)}${character}`;
    slashes = 0;
  }
  // The run at the end is followed by the closing quote, so it doubles too.
  return `"${escaped}${"\\".repeat(slashes * 2)}"`;
}

function spellings(command: string, pathExt: string): string[] {
  const extensions = pathExt
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const lowered = command.toLowerCase();
  // An explicit extension is honoured as written. Otherwise only the PATHEXT
  // spellings are tried and never the bare name — npm ships a *POSIX* `npm`
  // shell script next to `npm.cmd`, and preferring the bare name would find the
  // one Windows cannot run.
  return extensions.some((extension) => lowered.endsWith(extension.toLowerCase()))
    ? [command]
    // PATHEXT is conventionally uppercase, and Windows filenames are matched
    // case-insensitively, so the appended suffix is lowercased purely so the
    // path recorded in the receipt looks like the file on disk.
    : extensions.map((extension) => `${command}${extension.toLowerCase()}`);
}

async function findExecutable(
  command: string,
  options: ResolveCommandOptions,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string | undefined> {
  const directoryQualified = /[\\/]/.test(command);
  // The current directory is deliberately not searched for a bare command.
  // Windows `CreateProcess` does search it, which would let a `git.cmd` dropped
  // in the workspace shadow the real `git` that policy actually allowlisted.
  //
  // `win32` rather than the ambient path module: these are Windows paths whether
  // or not the host is Windows, and pinning it is what lets the win32 branch be
  // tested from any machine.
  const directories = directoryQualified
    ? [win32.resolve(options.cwd, win32.dirname(command))]
    : (options.path ?? "")
        .split(win32.delimiter)
        .filter((item) => item.length > 0);
  const name = directoryQualified ? win32.basename(command) : command;
  for (const directory of directories) {
    for (const spelling of spellings(name, options.pathExt ?? DEFAULT_PATHEXT)) {
      const candidate = win32.resolve(options.cwd, win32.join(directory, spelling));
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Turn an allowlisted command name into something `spawn` can actually start.
 *
 * On POSIX the name is already runnable and is returned untouched. On Windows it
 * usually is not: `spawn` runs without a shell, so `npm` never resolves to
 * `npm.cmd`, and a `.cmd` cannot be executed directly at all. That is the whole
 * Windows deadlock — the bare name passed policy but could not run, and the
 * `.cmd` spelling could run but was denied by policy. Resolving here (and
 * normalising the extension in the policy allowlist) fixes both ends.
 */
export async function resolveCommand(
  command: string,
  args: string[],
  options: ResolveCommandOptions,
): Promise<ResolvedCommand> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      file: command,
      args,
      windowsVerbatimArguments: false,
      executable: command,
    };
  }
  const found = await findExecutable(command, options, options.exists ?? isFile);
  if (found === undefined) {
    throw new Error(`terminal_command_not_found:${command}`);
  }
  const isBatch = BATCH_SUFFIXES.some((suffix) =>
    found.toLowerCase().endsWith(suffix),
  );
  if (!isBatch) {
    return {
      file: found,
      args,
      windowsVerbatimArguments: false,
      executable: found,
    };
  }
  return {
    file: options.comspec ?? "cmd.exe",
    // `/d` skips AutoRun registry commands, `/s` makes cmd strip exactly the
    // outer quote pair and leave everything between them alone.
    args: ["/d", "/s", "/c", `"${[found, ...args].map(quoteForCmd).join(" ")}"`],
    windowsVerbatimArguments: true,
    executable: found,
  };
}
