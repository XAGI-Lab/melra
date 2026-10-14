// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
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
// into VS Code, Zed, OpenCode, Codex, Goose, Continue, or Amp is ignored or
// fails to parse, so emit the shape the named client actually reads.
type Shape =
  | "mcpServers"
  | "vscode"
  | "zed"
  | "opencode"
  | "codex"
  | "goose"
  | "continue"
  | "amp";

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
  goose: {
    label: "Goose",
    shape: "goose",
    // Goose keeps its Windows config under the old "Block" app directory.
    path: () =>
      process.platform === "win32"
        ? appConfig("Block", "goose", "config", "config.yaml")
        : join(process.env.XDG_CONFIG_HOME ?? home(".config"), "goose", "config.yaml"),
  },
  continue: {
    label: "Continue",
    shape: "continue",
    // Continue loads every block file in the workspace's .continue/mcpServers,
    // so MELRA gets a file of its own rather than an edit to config.yaml.
    path: (workspace) => join(workspace, ".continue", "mcpServers", "melra.yaml"),
  },
  amp: {
    label: "Amp",
    shape: "amp",
    // Amp reads settings.json or settings.jsonc; edit the one already there
    // rather than create a second file beside it.
    path: () => {
      const json = home(".config", "amp", "settings.json");
      const jsonc = home(".config", "amp", "settings.jsonc");
      return !existsSync(json) && existsSync(jsonc) ? jsonc : json;
    },
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

// TOML basic strings and YAML double-quoted scalars take the same escapes JSON
// emits, so JSON.stringify is a correct string encoder for both, and YAML needs
// no dependency.
const q = (value: string) => JSON.stringify(value);

// A flat string map as a YAML block mapping nested `indent` deep, or `{}`.
function yamlMap(key: string, map: Record<string, string>, indent: string): string[] {
  const pairs = Object.entries(map);
  if (pairs.length === 0) return [`${indent}${key}: {}`];
  return [
    `${indent}${key}:`,
    ...pairs.map(([name, value]) => `${indent}  ${q(name)}: ${q(value)}`),
  ];
}

function gooseYaml(entry: ServerEntry): string {
  return [
    "extensions:",
    "  melra:",
    "    name: melra",
    "    type: stdio",
    "    enabled: true",
    `    cmd: ${q(entry.command)}`,
    `    args: [${entry.args.map(q).join(", ")}]`,
    ...yamlMap("envs", entry.env, "    "),
    "    timeout: 300",
    "",
  ].join("\n");
}

// A Continue block file carries its own name, version, and schema.
function continueYaml(entry: ServerEntry): string {
  return [
    "name: MELRA",
    "version: 0.0.1",
    "schema: v1",
    "mcpServers:",
    "  - name: melra",
    `    command: ${q(entry.command)}`,
    `    args: [${entry.args.map(q).join(", ")}]`,
    ...yamlMap("env", entry.env, "    "),
    "",
  ].join("\n");
}

function codexToml(entry: ServerEntry): string {
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
    case "goose":
      return gooseYaml(entry);
    case "continue":
      return continueYaml(entry);
    case "amp":
      return { "amp.mcpServers": { melra: entry } };
    default:
      return { mcpServers: { melra: entry } };
  }
}

export function clientConfigPath(name: string, workspace: string): string | undefined {
  return CLIENTS[name]?.path?.(workspace);
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
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

// Put MELRA's entry under Goose's `extensions:` map, replacing any earlier
// one, with a line edit that leaves every other byte of the file alone. Goose
// writes block-style YAML with one key per line, which a line edit handles;
// anything else — flow style, tabs, odd indentation, a top level that is not a
// plain mapping — is refused rather than guessed at.
function withMelraExtension(path: string, yaml: string, config: string): string {
  const refuse = (why: string) =>
    new Error(`${path}: ${why}; add the printed config to it by hand`);
  const cr = yaml.includes("\r\n") ? "\r" : "";
  const lines = yaml.split("\n").map((raw) => {
    const text = raw.replace(/\r$/, "");
    return { raw, text, content: !/^\s*(#.*)?$/.test(text), indent: text.search(/\S/) };
  });
  const isKey = (text: string) => /^ *(?:[\w.$-]+|"[^"\\]*"|'[^']*') *:(?: |$)/.test(text);
  const named = (key: string, text: string) =>
    new RegExp(`^ *(?:${key}|"${key}"|'${key}') *:`).test(text);
  for (const line of lines) {
    if (!line.content) continue;
    if (/^ *\t/.test(line.text)) throw refuse("it indents with tabs");
    if (line.indent === 0 && !isKey(line.text)) throw refuse("it is not a plain YAML mapping");
  }
  // MELRA's entry as rendered by gooseYaml, without the `extensions:` header.
  const entry = config.split("\n").slice(1, -1);
  const out = (block: string[], indent: number) =>
    block.map((line) => `${" ".repeat(indent)}${line.slice(2)}${cr}`);

  const headers = lines.flatMap((line, index) =>
    line.indent === 0 && named("extensions", line.text) ? [index] : [],
  );
  const start = headers[0];
  if (start === undefined) {
    const separator = yaml === "" || yaml.endsWith("\n") ? "" : `${cr}\n`;
    return `${yaml}${separator}extensions:${cr}\n${out(entry, 2).join("\n")}\n`;
  }
  if (headers.length > 1) throw refuse("it has more than one `extensions:` key");
  if (!/^[^:]*: *(#.*)?$/.test(lines[start]?.text ?? "")) {
    throw refuse("`extensions:` is not a block mapping");
  }
  const after = lines.findIndex(
    (line, index) => index > start && line.content && line.indent === 0,
  );
  const end = after === -1 ? lines.length : after;
  const children = lines.slice(start + 1, end).flatMap((line, offset) =>
    line.content ? [{ ...line, index: start + 1 + offset }] : [],
  );
  const indent = children[0]?.indent ?? 2;
  for (const child of children) {
    if (child.indent < indent || (child.indent === indent && !isKey(child.text))) {
      throw refuse("`extensions:` is not a block mapping with even indentation");
    }
  }
  // Drop every earlier `melra:` entry: its key through its last deeper line,
  // so blank or comment lines after it stay with whatever follows.
  const drop = new Set<number>();
  let first: number | undefined;
  for (const [position, child] of children.entries()) {
    if (child.indent !== indent || !named("melra", child.text)) continue;
    first ??= child.index;
    let last = child.index;
    for (const deeper of children.slice(position + 1)) {
      if (deeper.indent === indent) break;
      last = deeper.index;
    }
    for (let index = child.index; index <= last; index++) drop.add(index);
  }
  const at = first ?? (children.at(-1)?.index ?? start) + 1;
  const result = lines.flatMap((line, index) => {
    const placed = index === at ? out(entry, indent) : [];
    return drop.has(index) ? placed : [...placed, line.raw];
  });
  if (at === lines.length) result.push(...out(entry, indent));
  return result.join("\n");
}

/**
 * Merge MELRA into the client's own config file, keeping everything else in
 * it. The previous file is copied to `<file>.bak` first. A file that is not
 * plain JSON — Zed and VS Code settings often carry comments — is refused
 * rather than rewritten, because a round-trip through JSON.parse would drop
 * those comments. Continue's file is MELRA's alone, so it is replaced whole.
 */
export async function writeClientConfig(
  path: string,
  config: Record<string, unknown> | string,
  name: string,
): Promise<{ backup?: string }> {
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const shape = CLIENTS[name]?.shape;
  let next: string;
  if (typeof config === "string" && (existing === undefined || shape === "continue")) {
    next = config;
  } else if (typeof config === "string" && shape === "goose") {
    next = withMelraExtension(path, existing ?? "", config);
  } else if (typeof config === "string") {
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
