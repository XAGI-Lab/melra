// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { unhingedFromEnvironment } from "@melra/server";

export interface CliEnvironment {
  workspaceRoot: string;
  dataDirectory: string;
  unhinged: boolean;
  policyPath?: string;
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
export function serverLaunch(
  moduleDirectory: string,
  version: string,
): { command: string; args: string[] } {
  return /[\\/]_npx[\\/]/.test(moduleDirectory)
    ? { command: "npx", args: ["-y", `@melra/cli@${version}`, "serve"] }
    : { command: "melra", args: ["serve"] };
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
    workspaceRoot: resolve(
      source.MELRA_WORKSPACE ?? defaults.cwd,
    ),
    dataDirectory: resolve(
      source.MELRA_HOME ?? join(defaults.home, ".melra"),
    ),
    unhinged: unhingedFromEnvironment(source),
    ...(source.MELRA_POLICY === undefined
      ? {}
      : { policyPath: resolve(source.MELRA_POLICY) }),
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
