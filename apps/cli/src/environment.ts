// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isSea } from "node:sea";
import type { DeploymentMode } from "@melra/protocol";
import { deploymentMode } from "@melra/protocol";
import { printable, unhingedFromEnvironment } from "@melra/server/kernel";

export interface CliEnvironment {
  workspaceRoot: string;
  /** MELRA_WORKSPACE was set, so no policy file's `workspaceRoot` replaces it. */
  workspaceSet?: boolean;
  dataDirectory: string;
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
  /** `MELRA_SOCKET`: the socket `doctor` and `status` check; `serve` needs `--socket`. */
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
