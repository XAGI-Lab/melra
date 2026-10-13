// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// Every MCP client stores the same server under a different key, in a
// different shape, in a different file. A generic `mcpServers` blob pasted
// into VS Code, Zed, OpenCode, or Codex is ignored or fails to parse, so emit
// the shape the named client actually reads.
type Shape = "mcpServers" | "vscode" | "zed" | "opencode" | "codex";

interface Client {
  label: string;
  shape: Shape;
  // Undefined for `generic`: there is no file to point at.
  path?: (workspace: string) => string;
}

// The per-OS application-config directory: where Electron apps and Zed keep
// their settings.
function appConfig(...segments: string[]): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), ...segments);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", ...segments);
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), ...segments);
}

const home = (...segments: string[]) => join(homedir(), ...segments);

export const CLIENTS: Record<string, Client> = {
  generic: { label: "your MCP client", shape: "mcpServers" },
  "claude-code": {
    label: "Claude Code",
    shape: "mcpServers",
    path: (workspace) => join(workspace, ".mcp.json"),
  },
  "claude-desktop": {
    label: "Claude Desktop",
    shape: "mcpServers",
    path: () => appConfig("Claude", "claude_desktop_config.json"),
  },
  cursor: { label: "Cursor", shape: "mcpServers", path: () => home(".cursor", "mcp.json") },
  windsurf: {
    label: "Windsurf",
    shape: "mcpServers",
    path: () => home(".codeium", "windsurf", "mcp_config.json"),
  },
  gemini: { label: "Gemini CLI", shape: "mcpServers", path: () => home(".gemini", "settings.json") },
  kiro: { label: "Kiro", shape: "mcpServers", path: () => home(".kiro", "settings", "mcp.json") },
  cline: {
    label: "Cline",
    shape: "mcpServers",
    path: () =>
      appConfig(
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      ),
  },
  vscode: {
    label: "VS Code",
    shape: "vscode",
    path: (workspace) => join(workspace, ".vscode", "mcp.json"),
  },
  zed: {
    label: "Zed",
    shape: "zed",
    path: () =>
      process.platform === "win32"
        ? appConfig("Zed", "settings.json")
        : join(process.env.XDG_CONFIG_HOME ?? home(".config"), "zed", "settings.json"),
  },
  opencode: {
    label: "OpenCode",
    shape: "opencode",
    path: () => home(".config", "opencode", "opencode.json"),
  },
  codex: {
    label: "Codex",
    shape: "codex",
    path: () => join(process.env.CODEX_HOME ?? home(".codex"), "config.toml"),
  },
};

// Older names that already appear in scripts and docs.
const ALIASES: Record<string, string> = { claude: "claude-code" };

export function resolveClient(name: string): string {
  const resolved = ALIASES[name] ?? name;
  if (!Object.hasOwn(CLIENTS, resolved)) {
    throw new Error(
      `unknown --client '${name}'; use one of: ${Object.keys(CLIENTS).join(", ")}`,
    );
  }
  return resolved;
}

// TOML basic strings take the same escapes JSON emits, so JSON.stringify is a
// correct TOML string encoder for these values.
function codexToml(entry: ServerEntry): string {
  const q = (value: string) => JSON.stringify(value);
  return [
    "[mcp_servers.melra]",
    `command = ${q(entry.command)}`,
    `args = [${entry.args.map(q).join(", ")}]`,
    "",
    "[mcp_servers.melra.env]",
    ...Object.entries(entry.env).map(([key, value]) => `${key} = ${q(value)}`),
    "",
  ].join("\n");
}

export function clientConfig(
  name: string,
  entry: ServerEntry,
): Record<string, unknown> | string {
  switch (CLIENTS[name]?.shape) {
    case "vscode":
      return { servers: { melra: { type: "stdio", ...entry } } };
    case "zed":
      return { context_servers: { melra: entry } };
    case "opencode":
      return {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          melra: {
            type: "local",
            command: [entry.command, ...entry.args],
            environment: entry.env,
            enabled: true,
          },
        },
      };
    case "codex":
      return codexToml(entry);
    default:
      return { mcpServers: { melra: entry } };
  }
}

export function clientConfigPath(name: string, workspace: string): string | undefined {
  return CLIENTS[name]?.path?.(workspace);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Drop every `[mcp_servers.melra]` table (and its subtables) so a rerun after
// an upgrade replaces the old entry instead of duplicating a TOML table, which
// Codex would reject.
function withoutMelraTables(toml: string): string {
  let skipping = false;
  return toml
    .split(/\r?\n/)
    .filter((line) => {
      const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
      if (header !== null) {
        const table = header[1] ?? "";
        skipping = table === "mcp_servers.melra" || table.startsWith("mcp_servers.melra.");
      }
      return !skipping;
    })
    .join("\n")
    .trimEnd();
}

/**
 * Merge MELRA into the client's own config file, keeping everything else in
 * it. The previous file is copied to `<file>.bak` first. A file that is not
 * plain JSON — Zed and VS Code settings often carry comments — is refused
 * rather than rewritten, because a round-trip through JSON.parse would drop
 * those comments.
 */
export async function writeClientConfig(
  path: string,
  config: Record<string, unknown> | string,
): Promise<{ backup?: string }> {
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let next: string;
  if (typeof config === "string") {
    const kept = existing === undefined ? "" : withoutMelraTables(existing);
    next = kept === "" ? config : `${kept}\n\n${config}`;
  } else {
    let parsed: unknown = {};
    if (existing !== undefined && existing.trim() !== "") {
      try {
        parsed = JSON.parse(existing);
      } catch {
        throw new Error(
          `${path} is not plain JSON (comments?); add the printed config to it by hand`,
        );
      }
    }
    if (!isObject(parsed)) throw new Error(`${path} does not hold a JSON object`);
    for (const [key, value] of Object.entries(config)) {
      const current = parsed[key];
      if (!isObject(value)) {
        parsed[key] = current ?? value;
      } else if (current === undefined || isObject(current)) {
        parsed[key] = { ...current, ...value };
      } else {
        throw new Error(`${path}: "${key}" is not an object; add the printed config by hand`);
      }
    }
    next = `${JSON.stringify(parsed, null, 2)}\n`;
  }
  await mkdir(dirname(path), { recursive: true });
  const backup = existing === undefined ? undefined : `${path}.bak`;
  if (backup !== undefined) await copyFile(path, backup);
  await writeFile(path, next);
  return backup === undefined ? {} : { backup };
}
