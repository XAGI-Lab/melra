// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { accessSync, constants, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, extname, join } from "node:path";
import { PRODUCT_VERSION } from "@melra/protocol";
import { CLIENTS, isObject } from "./clients.js";

export interface ClientStatus {
  client: string;
  path: string;
  // `not inspected`: the file exists but this build has no reader for its
  // format, so saying either configured or not would be a guess.
  state: "configured" | "not configured" | "unreadable" | "not inspected";
  // The executable only, never the arguments: doctor output gets pasted into
  // issues, and arguments are where a user would put a token.
  command?: string;
  pin?: string;
  note?: string;
  problems: string[];
}

// Where each JSON shape keeps its servers, matching what `clientConfig` writes.
const SERVER_KEYS: Record<string, string> = {
  mcpServers: "mcpServers",
  vscode: "servers",
  zed: "context_servers",
  opencode: "mcp",
};

function isExecutable(path: string): boolean {
  try {
    // Windows has no execute bit; X_OK there is F_OK, so the extension is
    // what makes a file runnable and PATHEXT below decides that.
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// What the client would find when it spawns `command`. This sees doctor's own
// PATH, which a GUI client started from the dock may not share, so a hit is
// necessary rather than sufficient.
export function resolvesOnPath(command: string): boolean {
  if (/[\\/]/.test(command)) return isExecutable(command);
  // Windows spawns `melra` as `melra.cmd`: a bare name is tried with every
  // PATHEXT extension, a name that already has one is tried as written.
  const extensions =
    process.platform === "win32" && extname(command) === ""
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((directory) =>
      extensions.some((extension) => isExecutable(join(directory, command + extension))),
    );
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function launchOf(entry: unknown): string[] | undefined {
  if (!isObject(entry)) return undefined;
  // OpenCode keeps the whole argv in `command`.
  if (Array.isArray(entry.command)) return strings(entry.command);
  return typeof entry.command === "string" ? [entry.command, ...strings(entry.args)] : undefined;
}

// Line-based rather than a TOML parser, to stay dependency-free: it reads the
// single-line `command =` / `args =` inside [mcp_servers.melra] that `setup`
// writes, and leaves anything fancier unchecked instead of guessing.
function codexLaunch(toml: string): string[] | undefined {
  let inside = false;
  let command: string | undefined;
  let args: string[] = [];
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header !== null) {
      inside = header[1] === "mcp_servers.melra";
      continue;
    }
    if (!inside) continue;
    const value = /^\s*(command|args)\s*=\s*(.+?)\s*$/.exec(line);
    try {
      // TOML basic strings and arrays of them are valid JSON.
      if (value?.[1] === "command") command = JSON.parse(value[2] ?? "") as string;
      if (value?.[1] === "args") args = strings(JSON.parse(value[2] ?? ""));
    } catch {
      // A literal string or multi-line array: leave it unchecked.
    }
  }
  return typeof command === "string" ? [command, ...args] : undefined;
}

function configured(base: { client: string; path: string }, launch: string[] | undefined): ClientStatus {
  const [command] = launch ?? [];
  if (command === undefined) {
    return { ...base, state: "configured", note: "no command to check", problems: [] };
  }
  const problems: string[] = [];
  if (!resolvesOnPath(command)) problems.push(`'${command}' not found on PATH`);
  const pin = launch?.map((arg) => /^@melra\/cli@(\d\S*)$/.exec(arg)?.[1]).find(Boolean);
  // A pin is what keeps an npx launch on one version, so after an upgrade it
  // keeps launching the old server until the config is rewritten.
  if (pin !== undefined && pin !== PRODUCT_VERSION) {
    problems.push(
      `pinned to @melra/cli@${pin}, this is ${PRODUCT_VERSION}; fix: melra setup --client ${base.client} --write`,
    );
  }
  return {
    ...base,
    state: "configured",
    command,
    ...(pin === undefined ? {} : { pin }),
    problems,
  };
}

function inspect(client: string, shape: string, path: string, text: string): ClientStatus {
  const base = { client, path };
  if (shape === "codex") {
    return /^\s*\[\s*mcp_servers\.melra\s*\]/m.test(text)
      ? configured(base, codexLaunch(text))
      : { ...base, state: "not configured", problems: [] };
  }
  const key = SERVER_KEYS[shape];
  if (key === undefined) {
    return { ...base, state: "not inspected", note: `present; ${shape} format not inspected`, problems: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Zed and VS Code settings are usually JSONC. A text search still answers
    // the question people ask, just not what the entry launches.
    return /"melra"\s*:/.test(text)
      ? { ...base, state: "configured", note: "not plain JSON, found by text search; command not checked", problems: [] }
      : { ...base, state: "not configured", note: "not plain JSON, searched as text", problems: [] };
  }
  const servers = isObject(parsed) ? parsed[key] : undefined;
  const entry = isObject(servers) ? servers.melra : undefined;
  return entry === undefined
    ? { ...base, state: "not configured", problems: [] }
    : configured(base, launchOf(entry));
}

// Read-only by construction: this only ever reads the files `setup --write`
// would write, so doctor can run against a machine without changing it.
export async function clientStatuses(workspace: string): Promise<ClientStatus[]> {
  const statuses: ClientStatus[] = [];
  for (const [client, { shape, path: pathOf }] of Object.entries(CLIENTS)) {
    const path = pathOf?.(workspace);
    if (path === undefined) continue;
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      statuses.push({ client, path, state: "unreadable", problems: [`unreadable: ${code ?? String(error)}`] });
      continue;
    }
    statuses.push(inspect(client, shape, path, text));
  }
  return statuses;
}

// `warn` at worst: a machine with no client configured is how SDK users run,
// and a client problem never stops MELRA itself from working.
export function clientsCheck(statuses: ClientStatus[]): {
  name: string;
  status: "pass" | "warn";
  detail: string;
} {
  const hint = "run 'melra setup --client <name> --write' to add MELRA to one";
  if (statuses.length === 0) {
    return { name: "clients", status: "pass", detail: `no MCP client config files found; ${hint}` };
  }
  const lines = statuses.map(({ client, state, note, problems }) => {
    const extra = [...(note === undefined ? [] : [note]), ...problems];
    return `${client}: ${state}${extra.length === 0 ? "" : ` (${extra.join("; ")})`}`;
  });
  if (!statuses.some((status) => status.state === "configured")) lines.push(hint);
  return {
    name: "clients",
    status: statuses.some((status) => status.problems.length > 0) ? "warn" : "pass",
    detail: lines.join("; "),
  };
}
