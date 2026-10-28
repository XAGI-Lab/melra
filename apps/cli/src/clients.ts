// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseJsonc, upsertJsonc } from "./jsonc.js";

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// Every MCP client stores the same server under a different key, in a
// different shape, in a different file. A generic `mcpServers` blob pasted
// into any client below whose shape is not `mcpServers` is ignored or fails
// to parse, so emit the shape the named client actually reads.
type Shape =
  | "mcpServers"
  | "vscode"
  | "zed"
  | "opencode"
  | "codex"
  | "goose"
  | "continue"
  | "amp"
  | "openclaw"
  | "hermes"
  | "copilot"
  | "droid"
  | "kilo";

interface Client {
  label: string;
  shape: Shape;
  // Undefined for `generic`: there is no file to point at.
  path?: (workspace: string) => string;
  // The client's own executable, if it has one, so `setup` can tell a client is
  // installed before it has ever written a config file.
  bin?: string;
  // The macOS app bundle, for desktop clients with no CLI on PATH and (VS Code)
  // a config that lives in the workspace, so nothing on disk says they exist.
  app?: string;
  // What to do after `--write`, when it is more than restarting the client.
  next?: string;
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
    bin: "claude",
    path: (workspace) => join(workspace, ".mcp.json"),
    // A project .mcp.json server waits for the user's approval; until then
    // `claude mcp list` shows it as "Pending approval" and no tool appears.
    // `melra launch` is the way to start it with no other tool that changes
    // anything; a plain `claude` keeps its own Bash, Edit and Write.
    next:
      "Start claude in this workspace and approve the 'melra' server when it asks; 'claude mcp list' then shows it connected. " +
      "Or start it with 'melra launch claude-code', so MELRA's are the only tools it has that change anything.",
  },
  "claude-desktop": {
    label: "Claude Desktop",
    app: "Claude.app",
    shape: "mcpServers",
    path: () => appConfig("Claude", "claude_desktop_config.json"),
  },
  cursor: {
    label: "Cursor",
    app: "Cursor.app",
    shape: "mcpServers",
    bin: "cursor",
    path: () => home(".cursor", "mcp.json"),
  },
  windsurf: {
    label: "Windsurf",
    app: "Windsurf.app",
    shape: "mcpServers",
    bin: "windsurf",
    path: () => home(".codeium", "windsurf", "mcp_config.json"),
  },
  gemini: {
    label: "Gemini CLI",
    shape: "mcpServers",
    bin: "gemini",
    path: () => home(".gemini", "settings.json"),
  },
  kiro: {
    label: "Kiro",
    app: "Kiro.app",
    shape: "mcpServers",
    bin: "kiro",
    path: () => home(".kiro", "settings", "mcp.json"),
  },
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
    app: "Visual Studio Code.app",
    shape: "vscode",
    bin: "code",
    path: (workspace) => join(workspace, ".vscode", "mcp.json"),
  },
  zed: {
    label: "Zed",
    app: "Zed.app",
    shape: "zed",
    bin: "zed",
    path: () =>
      process.platform === "win32"
        ? appConfig("Zed", "settings.json")
        : join(process.env.XDG_CONFIG_HOME ?? home(".config"), "zed", "settings.json"),
  },
  opencode: {
    label: "OpenCode",
    shape: "opencode",
    bin: "opencode",
    path: () => home(".config", "opencode", "opencode.json"),
  },
  codex: {
    label: "Codex",
    shape: "codex",
    bin: "codex",
    path: () => join(process.env.CODEX_HOME ?? home(".codex"), "config.toml"),
  },
  // https://github.com/aaif-goose/goose/blob/main/crates/goose/src/config/paths.rs
  goose: {
    label: "Goose",
    shape: "goose",
    bin: "goose",
    // GOOSE_PATH_ROOT moves the whole tree, config under `<root>/config`, but
    // only when it is absolute; Goose ignores a relative one, and so does this.
    // Otherwise Windows keeps the old "Block" app directory.
    path: () => {
      const root = process.env.GOOSE_PATH_ROOT;
      if (root !== undefined && isAbsolute(root)) return join(root, "config", "config.yaml");
      return process.platform === "win32"
        ? appConfig("Block", "goose", "config", "config.yaml")
        : join(process.env.XDG_CONFIG_HOME ?? home(".config"), "goose", "config.yaml");
    },
  },
  continue: {
    label: "Continue",
    shape: "continue",
    // Continue loads every block file in the workspace's .continue/mcpServers,
    // so MELRA gets a file of its own rather than an edit to config.yaml.
    path: (workspace) => join(workspace, ".continue", "mcpServers", "melra.yaml"),
  },
  // https://ampcode.com/docs/cli/settings: `~/.config/amp/settings.json` or
  // `.jsonc` on every OS, `%USERPROFILE%` being home on Windows (an older guide
  // said `%APPDATA%\amp`; the settings page does not), MCP under
  // `amp.mcpServers`. Which file wins when both exist is not documented.
  amp: {
    label: "Amp",
    shape: "amp",
    bin: "amp",
    // Amp reads settings.json or settings.jsonc; edit the one already there
    // rather than create a second file beside it.
    path: () => {
      const json = home(".config", "amp", "settings.json");
      const jsonc = home(".config", "amp", "settings.jsonc");
      return !existsSync(json) && existsSync(jsonc) ? jsonc : json;
    },
  },
  // https://github.com/openclaw/openclaw/blob/main/docs/tools/mcp.md
  // https://github.com/openclaw/openclaw/blob/main/src/config/zod-schema.mcp-server.ts
  // https://github.com/openclaw/openclaw/blob/main/src/config/state-dir.ts
  // https://github.com/openclaw/openclaw/blob/main/docs/help/environment.md
  openclaw: {
    label: "OpenClaw",
    shape: "openclaw",
    bin: "openclaw",
    // JSON5 on disk. The JSONC editor covers the comments and trailing commas
    // OpenClaw itself writes; JSON5-only syntax (unquoted keys, single quotes)
    // fails the JSONC parse and is refused rather than rewritten. The gateway
    // hot-reloads the file, whereas `openclaw mcp add` refuses while it runs.
    path: () =>
      process.env.OPENCLAW_CONFIG_PATH ??
      join(
        process.env.OPENCLAW_STATE_DIR ?? join(process.env.OPENCLAW_HOME ?? homedir(), ".openclaw"),
        "openclaw.json",
      ),
  },
  // https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/mcp-config-reference.md
  // https://github.com/NousResearch/hermes-agent/blob/main/hermes_constants.py (HERMES_HOME)
  // https://github.com/NousResearch/hermes-agent/blob/main/tools/mcp_tool_config.py
  hermes: {
    label: "Hermes Agent",
    shape: "hermes",
    bin: "hermes",
    // Hermes keeps its Windows home under %LOCALAPPDATA%, without the dot.
    path: () =>
      join(
        process.env.HERMES_HOME ??
          (process.platform === "win32"
            ? join(process.env.LOCALAPPDATA ?? home("AppData", "Local"), "hermes")
            : home(".hermes")),
        "config.yaml",
      ),
  },
  // https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
  // https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
  copilot: {
    label: "GitHub Copilot CLI",
    shape: "copilot",
    bin: "copilot",
    // COPILOT_HOME replaces ~/.copilot; XDG_CONFIG_HOME is not honoured.
    path: () => join(process.env.COPILOT_HOME ?? home(".copilot"), "mcp-config.json"),
  },
  // https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/
  qwen: {
    label: "Qwen Code",
    shape: "mcpServers",
    bin: "qwen",
    path: () => home(".qwen", "settings.json"),
  },
  // https://docs.augmentcode.com/cli/integrations
  // https://docs.augmentcode.com/cli/config
  auggie: {
    label: "Auggie (Augment CLI)",
    shape: "mcpServers",
    bin: "auggie",
    path: () => home(".augment", "settings.json"),
  },
  // https://docs.warp.dev/agents/capabilities/mcp.md
  warp: {
    label: "Warp",
    app: "Warp.app",
    // Warp requires `args`, which every rendered entry carries, even if empty.
    shape: "mcpServers",
    // A desktop app with no CLI of its own: ~/.warp is how it is detected.
    path: () => home(".warp", ".mcp.json"),
  },
  // https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html
  junie: {
    label: "JetBrains Junie",
    shape: "mcpServers",
    bin: "junie",
    path: () => home(".junie", "mcp", "mcp.json"),
  },
  // https://docs.factory.com/cli/configuration/mcp
  droid: {
    label: "Factory Droid",
    shape: "droid",
    bin: "droid",
    path: () => home(".factory", "mcp.json"),
  },
  // https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html
  kimi: {
    label: "Kimi Code CLI",
    shape: "mcpServers",
    bin: "kimi",
    path: () => join(process.env.KIMI_CODE_HOME ?? home(".kimi-code"), "mcp.json"),
  },
  // https://kilo.ai/docs/automate/mcp/using-in-cli
  // https://kilo.ai/docs/getting-started/settings
  kilo: {
    label: "Kilo Code",
    shape: "kilo",
    bin: "kilo",
    // ~/.config on every OS, Windows included. Edit kilo.json when that is the
    // one already there, rather than create kilo.jsonc beside it.
    path: () => {
      const jsonc = home(".config", "kilo", "kilo.jsonc");
      const json = home(".config", "kilo", "kilo.json");
      return !existsSync(jsonc) && existsSync(json) ? json : jsonc;
    },
  },
  // https://lmstudio.ai/docs/app/mcp
  // https://lmstudio.ai/lmstudio/js-code-sandbox/files/src/findLMStudioHome.ts
  // https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1371
  lmstudio: {
    label: "LM Studio",
    app: "LM Studio.app",
    shape: "mcpServers",
    bin: "lms",
    path: () => join(lmStudioHome(), "mcp.json"),
  },
};

// LM Studio's home is not always ~/.lmstudio: a pointer file names it, and
// older installs live in ~/.cache/lm-studio. This is the order LM Studio's own
// sample code resolves it in, minus writing the pointer, which is LM Studio's
// job and not something reading a path should do.
function lmStudioHome(): string {
  try {
    const pointed = readFileSync(home(".lmstudio-home-pointer"), "utf8").trim();
    if (pointed !== "") return pointed;
  } catch {
    // No pointer yet: fall through to where LM Studio would create one.
  }
  const legacy = home(".cache", "lm-studio");
  return existsSync(legacy) ? legacy : home(".lmstudio");
}

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

// Hermes reads `mcp_servers.<name>` with the usual command/args/env.
function hermesYaml(entry: ServerEntry): string {
  return [
    "mcp_servers:",
    "  melra:",
    `    command: ${q(entry.command)}`,
    `    args: [${entry.args.map(q).join(", ")}]`,
    ...yamlMap("env", entry.env, "    "),
    "",
  ].join("\n");
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
    case "hermes":
      return hermesYaml(entry);
    case "openclaw":
      return { mcp: { servers: { melra: entry } } };
    // Copilot CLI passes a server only PATH from its own environment, so
    // MELRA's settings must all be in `env`, as they are. `tools: ["*"]`
    // exposes every MELRA tool; every documented example carries it.
    case "copilot":
      return { mcpServers: { melra: { type: "local", ...entry, tools: ["*"] } } };
    case "droid":
      return { mcpServers: { melra: { type: "stdio", ...entry } } };
    // OpenCode's format without OpenCode's $schema, which would be wrong here.
    case "kilo":
      return {
        mcp: {
          melra: {
            type: "local",
            command: [entry.command, ...entry.args],
            environment: entry.env,
            enabled: true,
          },
        },
      };
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

const isKey = (text: string) => /^ *(?:[\w.$-]+|"[^"\\]*"|'[^']*') *:(?: |$)/.test(text);
const named = (key: string, text: string) => new RegExp(`^ *(?:${key}|"${key}"|'${key}') *:`).test(text);
// A sequence item at its key's own indent, as PyYAML dumps it (an older or
// hand-edited Hermes config); Hermes's own ruamel writer puts items two deeper.
const isItem = (text: string) => /^ *-(?: |$)/.test(text);

const yamlLines = (yaml: string) =>
  yaml.split("\n").map((raw) => {
    const text = raw.replace(/\r$/, "");
    return { raw, text, content: !/^\s*(#.*)?$/.test(text), indent: text.search(/\S/) };
  });

// Put MELRA's entry under a top-level YAML map — Goose's `extensions:`,
// Hermes's `mcp_servers:` — replacing any earlier one, with a line edit that
// leaves every other byte of the file alone. `config` is the rendered block,
// whose first line names the map, and `key` the entry's own key (Hermes's
// `agent.disabled_toolsets` goes in the same way). Both clients write
// block-style YAML with one key per line, which a line edit handles; anything
// else — flow style, tabs, odd indentation, a top level that is not a plain
// mapping — is refused rather than guessed at.
function withMelraYamlEntry(path: string, yaml: string, config: string, key = "melra"): string {
  const refuse = (why: string) =>
    new Error(`${path}: ${why}; add the printed config to it by hand`);
  const cr = yaml.includes("\r\n") ? "\r" : "";
  const lines = yamlLines(yaml);
  for (const line of lines) {
    if (!line.content) continue;
    if (/^ *\t/.test(line.text)) throw refuse("it indents with tabs");
    if (line.indent === 0 && !isKey(line.text)) throw refuse("it is not a plain YAML mapping");
  }
  // MELRA's entry as rendered, without the header naming its map.
  const [header = "", ...rendered] = config.split("\n").slice(0, -1);
  const map = header.slice(0, -1);
  const entry = rendered;
  const out = (block: string[], indent: number) =>
    block.map((line) => `${" ".repeat(indent)}${line.slice(2)}${cr}`);

  const headers = lines.flatMap((line, index) =>
    line.indent === 0 && named(map, line.text) ? [index] : [],
  );
  const start = headers[0];
  if (start === undefined) {
    const separator = yaml === "" || yaml.endsWith("\n") ? "" : `${cr}\n`;
    return `${yaml}${separator}${header}${cr}\n${out(entry, 2).join("\n")}\n`;
  }
  if (headers.length > 1) throw refuse(`it has more than one \`${header}\` key`);
  if (!/^[^:]*: *(#.*)?$/.test(lines[start]?.text ?? "")) {
    throw refuse(`\`${header}\` is not a block mapping`);
  }
  const after = lines.findIndex(
    (line, index) => index > start && line.content && line.indent === 0,
  );
  const end = after === -1 ? lines.length : after;
  const children = lines.slice(start + 1, end).flatMap((line, offset) =>
    line.content ? [{ ...line, index: start + 1 + offset }] : [],
  );
  const indent = children[0]?.indent ?? 2;
  for (const [position, child] of children.entries()) {
    const sibling = child.indent === indent && (isKey(child.text) || (position > 0 && isItem(child.text)));
    if (child.indent < indent || (child.indent === indent && !sibling)) {
      throw refuse(`\`${header}\` is not a block mapping with even indentation`);
    }
  }
  // Drop every earlier entry: its key through its last deeper line or item,
  // so blank or comment lines after it stay with whatever follows.
  const drop = new Set<number>();
  let first: number | undefined;
  for (const [position, child] of children.entries()) {
    if (child.indent !== indent || !named(key, child.text)) continue;
    first ??= child.index;
    let last = child.index;
    for (const deeper of children.slice(position + 1)) {
      if (deeper.indent === indent && !isItem(deeper.text)) break;
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

const yamlScalar = (text: string): string | undefined => {
  const match = /^(?:([\w.-]+)|"([^"\\]*)"|'([^']*)')$/.exec(text.trim());
  return match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
};

/**
 * The names listed at `<map>.<key>` of a block-style YAML file, as Hermes
 * writes `agent.disabled_toolsets`: a one-line flow list or `- name` lines,
 * each a plain or quoted scalar. Undefined when the key is not there; any
 * other shape is refused.
 */
export function yamlList(path: string, yaml: string, map: string, key: string): string[] | undefined {
  const refuse = (why: string) => new Error(`${path}: ${map}.${key} ${why}`);
  const lines = yamlLines(yaml).filter((line) => line.content);
  const starts = lines.flatMap((line, index) => (line.indent === 0 && named(map, line.text) ? [index] : []));
  if (starts.length > 1) throw refuse(`is ambiguous: the file has more than one \`${map}:\``);
  const start = starts[0];
  if (start === undefined) return undefined;
  const after = lines.findIndex((line, index) => index > start && line.indent === 0);
  const block = lines.slice(start + 1, after === -1 ? lines.length : after);
  const indent = block[0]?.indent;
  const found = block.flatMap((line, index) => (line.indent === indent && named(key, line.text) ? [index] : []));
  if (found.length > 1) throw refuse("appears more than once");
  const at = found[0];
  if (at === undefined) return undefined;
  const value = (block[at]?.text ?? "").replace(/^[^:]*:/, "").replace(/\s+#.*$/, "").trim();
  if (value !== "") {
    const flow = /^\[(.*)\]$/.exec(value);
    const items = flow?.[1]?.split(",").map((each) => each.trim()).filter((each) => each !== "").map(yamlScalar);
    if (items === undefined || items.some((each) => each === undefined)) throw refuse("is not a list of names");
    return items as string[];
  }
  const items: string[] = [];
  for (const line of block.slice(at + 1)) {
    if (line.indent < (indent ?? 0) || (line.indent === indent && !isItem(line.text))) break;
    const item = yamlScalar(/^ *- +(.*?)(?:\s+#.*)?$/.exec(line.text)?.[1] ?? "");
    if (item === undefined) throw refuse("is not a list of names");
    items.push(item);
  }
  return items;
}

/**
 * `yaml` with `names` added to the list at `<map>.<key>` as a union: every
 * name already there stays first, in its order, the missing ones follow, and
 * the rest of the file is edited no more than `withMelraYamlEntry` edits it.
 */
export function withYamlListUnion(path: string, yaml: string, map: string, key: string, names: readonly string[]): string {
  const listed = yamlList(path, yaml, map, key) ?? [];
  const missing = names.filter((name) => !listed.includes(name));
  if (missing.length === 0) return yaml;
  const block = [`${map}:`, `  ${key}:`, ...[...listed, ...missing].map((name) => `    - ${q(name)}`), ""].join("\n");
  return withMelraYamlEntry(path, yaml, block, key);
}

// Every place a rendered config sets something: the `melra` entry itself,
// however deep its container sits (OpenClaw's is `mcp.servers`), and any
// non-object setting beside it (OpenCode's `$schema`).
function settings(config: Record<string, unknown>, at: string[] = []): Array<[string[], unknown]> {
  return Object.entries(config).flatMap(([key, value]) =>
    key !== "melra" && isObject(value) ? settings(value, [...at, key]) : [[[...at, key], value]],
  );
}

// An edit, applied to a parsed object as `upsertJsonc` applies it to text.
function merged(before: Record<string, unknown>, path: string[], value: unknown, keep: boolean): Record<string, unknown> {
  const [key, ...rest] = path;
  if (key === undefined) return before;
  if (rest.length === 0) {
    return !keep || !Object.hasOwn(before, key) ? { ...before, [key]: value } : before;
  }
  const inner = before[key];
  return { ...before, [key]: merged(isObject(inner) ? inner : {}, rest, value, keep) };
}

const refusal = (path: string, why: string) =>
  new Error(`${path}: ${why}; add the printed config to it by hand`);

function parsedObject(path: string, text: string): Record<string, unknown> {
  let before: unknown;
  try {
    before = parseJsonc(text).value;
  } catch (error) {
    throw refusal(path, `it is not valid JSON or JSONC (${(error as Error).message})`);
  }
  if (!isObject(before)) throw refusal(path, "it does not hold a JSON object");
  return before;
}

// Apply `[path, value, keep]` edits to a JSON or JSONC file by editing only
// the members they name; `keep` leaves a member that is already there alone.
// Plain JSON goes through the same in-place edit as JSONC rather than
// JSON.parse → JSON.stringify, so a user's formatting and key order survive
// there too, and duplicate keys (which JSON.parse silently collapses) are
// refused everywhere. The result is parsed back and compared, whole, with the
// merge it was meant to be, so a file is never written that does not say
// exactly what was intended.
function withJsonEdits(path: string, text: string, edits: Array<[string[], unknown, boolean]>): string {
  let expected = parsedObject(path, text);
  let next = text;
  try {
    for (const [at, value, keep] of edits) {
      next = upsertJsonc(next, at, value, keep);
      expected = merged(expected, at, value, keep);
    }
  } catch (error) {
    throw refusal(path, (error as Error).message);
  }
  let after: unknown;
  try {
    after = parseJsonc(next).value;
  } catch {
    after = undefined;
  }
  if (!isDeepStrictEqual(after, expected)) {
    throw refusal(path, "editing it in place did not produce the intended settings");
  }
  return next;
}

async function existingText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

/**
 * The file `writeClientConfig` would write: MELRA merged into the client's own
 * config, keeping everything else in it. JSON and JSONC files are edited in
 * place by `withJsonEdits`, the `melra` entry upserted wherever its container
 * is and a non-object setting (OpenCode's `$schema`) added only if absent, so
 * comments, trailing commas, and formatting outside MELRA's own entry survive;
 * a file that is not valid JSONC is refused. Continue's file is MELRA's alone,
 * so it is replaced whole.
 */
export async function clientConfigText(
  path: string,
  config: Record<string, unknown> | string,
  name: string,
): Promise<{ existing?: string; next: string }> {
  const existing = await existingText(path);
  const shape = CLIENTS[name]?.shape;
  let next: string;
  if (typeof config === "string" && (existing === undefined || shape === "continue")) {
    next = config;
  } else if (typeof config === "string" && (shape === "goose" || shape === "hermes")) {
    next = withMelraYamlEntry(path, existing ?? "", config);
  } else if (typeof config === "string") {
    const kept = existing === undefined ? "" : withoutMelraTables(existing);
    next = kept === "" ? config : `${kept}\n\n${config}`;
  } else if (existing === undefined || existing.trim() === "") {
    next = `${JSON.stringify(config, null, 2)}\n`;
  } else {
    next = withJsonEdits(
      path,
      existing,
      settings(config).map(([at, value]) => [at, value, at.at(-1) !== "melra"]),
    );
  }
  return { ...(existing === undefined ? {} : { existing }), next };
}

/**
 * The deny rules `rules` added to a Claude Code settings file as a union:
 * every rule already in `permissions.deny` stays where it is, the missing ones
 * follow it, and the rest of the file is edited no more than
 * `clientConfigText` edits a client config. Unlike a client config, the file
 * must be strict JSON, as Claude Code reads it.
 */
export async function denyRulesText(
  path: string,
  rules: readonly string[],
): Promise<{ existing?: string; next: string }> {
  const existing = await existingText(path);
  if (existing === undefined || existing.trim() === "") {
    const next = `${JSON.stringify({ permissions: { deny: rules } }, null, 2)}\n`;
    return { ...(existing === undefined ? {} : { existing }), next };
  }
  try {
    JSON.parse(existing);
  } catch {
    throw refusal(path, "Claude Code reads its settings as strict JSON, and this file is not; it would not load the deny rules");
  }
  return { existing, next: withJsonListUnion(path, existing, ["permissions", "deny"], rules) };
}

/**
 * `text`, a JSON or JSONC object, with `rules` added to the list of strings at
 * `at` as a union: every rule already there stays where it is, the missing
 * ones follow it, and only that list is edited, as `withJsonEdits` edits.
 */
export function withJsonListUnion(path: string, text: string, at: string[], rules: readonly string[]): string {
  const listed = at.reduce<unknown>((inner, step) => (isObject(inner) ? inner[step] : undefined), parsedObject(path, text)) ?? [];
  if (!Array.isArray(listed) || !listed.every((rule) => typeof rule === "string")) {
    throw refusal(path, `${at.join(".")} is not a list of rules`);
  }
  const missing = rules.filter((rule) => !listed.includes(rule));
  return missing.length === 0 ? text : withJsonEdits(path, text, [[at, [...listed, ...missing], false]]);
}

/**
 * Replace `path` with `next`, copying the previous file to `<file>.bak` first.
 */
export async function replaceFile(
  path: string,
  existing: string | undefined,
  next: string,
): Promise<{ backup?: string; unchanged?: true }> {
  // Already exactly this: rewriting would only replace a good .bak with a copy.
  if (next === existing) return { unchanged: true };
  await mkdir(dirname(path), { recursive: true });
  const backup = existing === undefined ? undefined : `${path}.bak`;
  if (backup !== undefined) await copyFile(path, backup);
  await writeFile(path, next);
  return backup === undefined ? {} : { backup };
}

/** `clientConfigText`, written by `replaceFile`. */
export async function writeClientConfig(
  path: string,
  config: Record<string, unknown> | string,
  name: string,
): Promise<{ backup?: string; unchanged?: true }> {
  const { existing, next } = await clientConfigText(path, config, name);
  return await replaceFile(path, existing, next);
}
