// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { isSea } from "node:sea";
import type { DeploymentMode } from "@melra/protocol";
import { deploymentMode } from "@melra/protocol";
import { printable, unhingedFromEnvironment } from "@melra/server/kernel";

export interface CliEnvironment {
  workspaceRoot: string;
  /** MELRA_WORKSPACE was set, so no policy file's `workspaceRoot` replaces it. */
  workspaceSet?: boolean;
  dataDirectory: string;
  /** MELRA_HOME was set, so `dataDirectory` is not this machine's default. */
  homeSet?: boolean;
  /**
   * `MELRA_APPROVER`, as set: the name `melra approve` records as the
   * approver, `melra judge` as the judge, `melra workflow pause`,
   * `suspend` and `resume` as who acted, and `melra workflow advance --input`
   * as who answered, as `cli:<name>`. Receipts carry it and an agent can read
   * receipts, so it is a label the operator chooses, never the OS account
   * name. Checked by `approverLabel` only where it is used, so a bad value
   * cannot stop `serve` or `help`.
   */
  approver: string;
  unhinged: boolean;
  mode: DeploymentMode;
  policyPath?: string;
  /**
   * `MELRA_SOCKET`: the socket `doctor` and `status` check and `probe` asks;
   * `serve` needs `--socket`.
   */
  socketPath?: string;
  browserExecutablePath?: string;
  browserCdpEndpoint?: string;
  browserCdpContextIndex?: number;
  browserHarPath?: string;
  browserHarReplayPath?: string;
  browserProfileDir?: string;
}

export interface CliEnvironmentDefaults {
  cwd: string;
  home: string;
}

// A generated client config has to name a command the client can actually
// spawn. `npx` runs the CLI out of its own cache and leaves nothing on PATH,
// so `melra` would fail to start for exactly the users who took the shortest
// install path. Pin the version that wrote the config, so the client keeps
// launching the same server until someone changes it.
//
// A single-executable build (`melra` with Node inside, #76) is neither: the
// client must spawn this very binary, by absolute path, since it may well not
// be on the PATH a client launches with.
export function serverLaunch(
  moduleDirectory: string,
  version: string,
  singleExecutable = isSea(),
): { command: string; args: string[] } {
  if (singleExecutable) return { command: process.execPath, args: ["serve"] };
  return /[\\/]_npx[\\/]/.test(moduleDirectory)
    ? { command: "npx", args: ["-y", `@melra/cli@${version}`, "serve"] }
    : { command: "melra", args: ["serve"] };
}

/**
 * This very `melra`, by absolute path, for a child to run: Node and the entry
 * script with its loaders, so it works from `dist/bin.js` and from `tsx
 * src/index.ts` alike, or a single executable on its own. Never a bare name or
 * `npx`, which run whatever `PATH` finds when the child starts.
 */
export function selfCommand(singleExecutable = isSea()): { command: string; args: string[] } {
  return { command: process.execPath, args: singleExecutable ? [] : [...process.execArgv, process.argv[1] ?? ""] };
}

/**
 * The claude `melra launch` runs, by absolute path. It starts in the
 * workspace, where a spawn would look for a bare or relative name first:
 * Windows always does, POSIX for a relative path or an empty or relative
 * `PATH` entry. So a name with a directory in it is taken from where it was
 * typed, and a bare one is looked up only in `PATH`'s absolute directories,
 * with `PATHEXT` on Windows, whose batch files need a shell and are refused.
 */
export async function claudeProgram(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
  windows = process.platform === "win32",
): Promise<string> {
  if (basename(name) !== name) return resolve(name);
  // Windows tries the name as given only when it has an extension, as a spawn
  // does, so the extensionless script npm puts beside `claude.cmd` is skipped.
  const names = windows
    ? [
        ...(extname(name) === "" ? [] : [name]),
        ...(environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((extension) => name + extension),
      ]
    : [name];
  for (const directory of (environment.PATH ?? "").split(delimiter).filter((entry) => isAbsolute(entry))) {
    for (const candidate of names.map((each) => join(directory, each))) {
      if (!(await stat(candidate).catch(() => undefined))?.isFile()) continue;
      if (!(await access(candidate, constants.X_OK).then(() => true, () => false))) continue;
      if (/\.(bat|cmd)$/i.test(candidate)) {
        throw new Error(`claude_not_runnable: ${candidate} is a batch file, which needs a shell; name claude.exe with CLAUDE_BIN or --claude-bin`);
      }
      return candidate;
    }
  }
  throw new Error(
    `claude_not_found: ${name} is in no absolute PATH directory; install Claude Code 2.1.296 or later, or name it with CLAUDE_BIN or --claude-bin`,
  );
}

/** The built-in tools `melra launch claude-code` leaves Claude Code: it can read, and change nothing. */
export const CLAUDE_TOOLS = "Read,Glob,Grep";

// The only flags passed on to claude: none can hand back a tool, a settings
// file or an MCP server. `--resume` takes an optional session id.
const CLAUDE_FLAGS = new Set(["-p", "--print", "-c", "--continue", "-r", "--resume", "--verbose"]);
const CLAUDE_VALUED = new Set(["--model", "--output-format"]);

/**
 * The arguments `melra launch claude-code` starts claude with. `--tools`
 * leaves it no built-in tool that changes anything, `--strict-mcp-config`
 * and `--mcp-config` no MCP server but melra, and `--restricted` turns off
 * the code-running tools and ignores the user, project and local settings
 * files, where hooks, permissions and servers would come from. The flags
 * that take a list come first and a plain one last, so a prompt after them is
 * not read as one more tool or config file.
 *
 * Of `passed`, the caller's own, only a prompt and `CLAUDE_FLAGS` and
 * `CLAUDE_VALUED` go through; anything else is refused rather than dropped.
 */
export function claudeLaunchArgv(mcpConfig: string, passed: readonly string[]): string[] {
  let prompt = false;
  for (let index = 0; index < passed.length; index += 1) {
    const value = passed[index]!;
    if (CLAUDE_VALUED.has(value)) {
      const next = passed[index + 1];
      if (next === undefined || next.startsWith("-")) throw new Error(`${value} requires a value`);
      index += 1;
    } else if (["-r", "--resume"].includes(value) && !(passed[index + 1] ?? "-").startsWith("-")) {
      index += 1;
    } else if (value.startsWith("-") && !CLAUDE_FLAGS.has(value)) {
      throw new Error(
        `launch_argument_refused: ${value}; melra launch passes claude only a prompt, ` +
          "-p/--print, --model <model>, --output-format <format>, --verbose, -c/--continue and -r/--resume [id]",
      );
    } else if (!value.startsWith("-") && !prompt) {
      // claude reads a first word it has a subcommand for (`mcp`, `plugin`,
      // `purge`, ...) as that subcommand, which no session restricts.
      if (/^[a-z][a-z-]*$/.test(value)) {
        throw new Error(`launch_argument_refused: ${value}; a one-word prompt can name a claude subcommand, so say more`);
      }
      prompt = true;
    }
  }
  return ["--tools", CLAUDE_TOOLS, "--mcp-config", mcpConfig, "--strict-mcp-config", "--restricted", ...passed];
}

/**
 * The approver as receipts record it: the surface it was given on (`cli:` or
 * `console:`), then a label nothing can disguise.
 */
export function approverLabel(env: CliEnvironment, surface: "cli" | "console" = "cli"): string {
  if (!/^[\p{L}\p{N}_.@-]{1,64}$/u.test(env.approver) || printable(env.approver) !== env.approver) {
    throw new Error("MELRA_APPROVER must be 1 to 64 letters, digits, '.', '_', '@' or '-'");
  }
  return `${surface}:${env.approver}`;
}

function cdpEndpoint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("browser_cdp_endpoint_invalid");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("browser_cdp_endpoint_invalid");
  }
  return parsed.href;
}

function cdpContextIndex(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) {
    throw new Error("browser_cdp_context_index_invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < -1) {
    throw new Error("browser_cdp_context_index_invalid");
  }
  return parsed;
}

function harPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) {
    throw new Error("browser_har_path_must_be_absolute");
  }
  return resolve(value);
}

/**
 * `deploymentMode`, refused with where the value came from and what it may
 * be: a bare `deployment_mode_unknown` named neither.
 */
export function namedDeploymentMode(value: string | undefined, source: string): DeploymentMode {
  try {
    return deploymentMode(value);
  } catch {
    throw new Error(`deployment_mode_unknown: ${source} must be developer or enforced`);
  }
}

export function parseCliEnvironment(
  source: NodeJS.ProcessEnv,
  defaults: CliEnvironmentDefaults = {
    cwd: process.cwd(),
    home: homedir(),
  },
): CliEnvironment {
  const endpoint = cdpEndpoint(source.MELRA_BROWSER_CDP_ENDPOINT);
  const contextIndex = cdpContextIndex(
    source.MELRA_BROWSER_CDP_CONTEXT_INDEX,
  );
  const recordHarPath = harPath(source.MELRA_BROWSER_HAR_PATH);
  const replayHarPath = harPath(source.MELRA_BROWSER_HAR_REPLAY);
  const profileDir = source.MELRA_BROWSER_PROFILE;
  if (profileDir !== undefined && !isAbsolute(profileDir)) {
    throw new Error("browser_profile_must_be_absolute");
  }
  if (endpoint !== undefined && profileDir !== undefined) {
    // An attached browser already has whatever profile it was started with;
    // pointing at a second one would silently do nothing.
    throw new Error("browser_cdp_cannot_use_profile");
  }
  if (endpoint !== undefined && recordHarPath !== undefined) {
    throw new Error("browser_cdp_cannot_start_har_recording");
  }
  if (endpoint !== undefined && replayHarPath !== undefined) {
    // Replay serves requests from the archive, which means never opening the
    // socket an attached browser is already holding open.
    throw new Error("browser_cdp_cannot_replay_har");
  }
  if (recordHarPath !== undefined && replayHarPath !== undefined) {
    throw new Error("browser_har_replay_cannot_record");
  }
  if (contextIndex !== undefined && endpoint === undefined) {
    throw new Error("browser_cdp_context_requires_endpoint");
  }
  return {
    // Empty counts as unset for these too: `MELRA_POLICY=${P}` with P unset
    // otherwise names the working directory as the policy file.
    workspaceRoot: resolve(source.MELRA_WORKSPACE?.trim() || defaults.cwd),
    workspaceSet: (source.MELRA_WORKSPACE ?? "").trim() !== "",
    // Empty is unset here too, or the database and payload key would land in
    // the working directory, inside the workspace a confined agent can write.
    dataDirectory: resolve(source.MELRA_HOME?.trim() || join(defaults.home, ".melra")),
    homeSet: (source.MELRA_HOME ?? "").trim() !== "",
    approver: source.MELRA_APPROVER?.trim() || "operator",
    unhinged: unhingedFromEnvironment(source),
    mode: namedDeploymentMode(source.MELRA_MODE, "MELRA_MODE"),
    ...(source.MELRA_POLICY === undefined || source.MELRA_POLICY.trim() === ""
      ? {}
      : { policyPath: resolve(source.MELRA_POLICY) }),
    // Empty counts as unset, so `MELRA_SOCKET=` in a unit file turns it off
    // rather than asking for a socket named after the working directory.
    ...(source.MELRA_SOCKET === undefined || source.MELRA_SOCKET.trim() === ""
      ? {}
      : { socketPath: resolve(source.MELRA_SOCKET) }),
    ...(source.MELRA_BROWSER === undefined
      ? {}
      : { browserExecutablePath: resolve(source.MELRA_BROWSER) }),
    ...(endpoint === undefined ? {} : { browserCdpEndpoint: endpoint }),
    ...(contextIndex === undefined
      ? {}
      : { browserCdpContextIndex: contextIndex }),
    ...(recordHarPath === undefined ? {} : { browserHarPath: recordHarPath }),
    ...(replayHarPath === undefined
      ? {}
      : { browserHarReplayPath: replayHarPath }),
    ...(profileDir === undefined
      ? {}
      : { browserProfileDir: resolve(profileDir) }),
  };
}
