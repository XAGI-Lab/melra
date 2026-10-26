// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENTS,
  clientConfig,
  clientConfigPath,
  denyRulesText,
  replaceFile,
  resolveClient,
  writeClientConfig,
} from "../src/clients.js";
import { parseJsonc } from "../src/jsonc.js";

const entry = { command: "melra", args: ["serve"], env: { MELRA_WORKSPACE: 'C:\\w "x"' } };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "melra-clients-"));
  roots.push(root);
  return root;
}

describe("client configs", () => {
  it("names a file for every client but generic, and rejects unknown names", () => {
    for (const name of Object.keys(CLIENTS)) {
      expect(clientConfigPath(name, "/ws") === undefined).toBe(name === "generic");
    }
    expect(resolveClient("claude")).toBe("claude-code");
    expect(() => resolveClient("bogus")).toThrow(/unknown --client 'bogus'/);
    expect(() => resolveClient("__proto__")).toThrow(/unknown --client/);
  });

  it("emits each client's own shape", () => {
    expect(clientConfig("cursor", entry)).toEqual({ mcpServers: { melra: entry } });
    expect(clientConfig("vscode", entry)).toEqual({
      servers: { melra: { type: "stdio", ...entry } },
    });
    expect(clientConfig("zed", entry)).toEqual({ context_servers: { melra: entry } });
    expect(clientConfig("opencode", entry)).toMatchObject({
      mcp: { melra: { type: "local", command: ["melra", "serve"], environment: entry.env } },
    });
    // JSON string escapes are valid TOML basic-string escapes.
    expect(clientConfig("codex", entry)).toContain('MELRA_WORKSPACE = "C:\\\\w \\"x\\""');
    expect(clientConfig("amp", entry)).toEqual({ "amp.mcpServers": { melra: entry } });
    // JSON-quoted scalars are valid YAML double-quoted scalars.
    expect(clientConfig("goose", entry)).toBe(
      [
        "extensions:",
        "  melra:",
        "    name: melra",
        "    type: stdio",
        "    enabled: true",
        '    cmd: "melra"',
        '    args: ["serve"]',
        "    envs:",
        '      "MELRA_WORKSPACE": "C:\\\\w \\"x\\""',
        "    timeout: 300",
        "",
      ].join("\n"),
    );
    expect(clientConfig("continue", entry)).toBe(
      [
        "name: MELRA",
        "version: 0.0.1",
        "schema: v1",
        "mcpServers:",
        "  - name: melra",
        '    command: "melra"',
        '    args: ["serve"]',
        "    env:",
        '      "MELRA_WORKSPACE": "C:\\\\w \\"x\\""',
        "",
      ].join("\n"),
    );
    expect(clientConfig("continue", { ...entry, env: {} })).toContain("    env: {}\n");
  });

  it("merges into an existing JSON file and keeps a backup", async () => {
    const path = join(await scratch(), "mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: { other: { command: "x" } }, keep: 1 }));
    const { backup } = await writeClientConfig(path, clientConfig("cursor", entry), "cursor");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: { other: { command: "x" }, melra: entry },
      keep: 1,
    });
    expect(backup).toBe(`${path}.bak`);
  });

  it("creates a missing file and its directory", async () => {
    const path = join(await scratch(), "nested", ".vscode", "mcp.json");
    expect(await writeClientConfig(path, clientConfig("vscode", entry), "vscode")).toEqual({});
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(clientConfig("vscode", entry));
  });

  it("keeps a plain JSON file's own formatting and is idempotent", async () => {
    const path = join(await scratch(), "mcp.json");
    await writeFile(path, '{"mcpServers":{"other":{"command":"x"}},"keep":1}');
    await writeClientConfig(path, clientConfig("cursor", entry), "cursor");
    const once = await readFile(path, "utf8");
    expect(once).toBe(
      `{"mcpServers":{"other":{"command":"x"}, "melra": ${JSON.stringify(entry)}},"keep":1}`,
    );
    await writeClientConfig(path, clientConfig("cursor", entry), "cursor");
    expect(await readFile(path, "utf8")).toBe(once);
  });

  it("adds MELRA to a commented Zed settings file without touching any other byte", async () => {
    const path = join(await scratch(), "settings.json");
    const original = [
      "// Zed settings",
      "//",
      "// see https://zed.dev/docs/configuring-zed",
      "{",
      '  "theme": "One Dark", // trailing note',
      "  /* block",
      '     comment with "quotes" and { braces } */',
      '  "terminal": { "font_family": "Fira // Code", "shell": "/* nor this */ \\" // x" },',
      '  "context_servers": {',
      "    // my own server",
      '    "other": {',
      '      "command": "x",',
      '      "args": [],',
      "    },",
      "  },",
      '  "vim_mode": true,',
      "}",
      "",
    ].join("\n");
    await writeFile(path, original);
    const { backup } = await writeClientConfig(path, clientConfig("zed", entry), "zed");
    expect(await readFile(backup ?? "", "utf8")).toBe(original);
    const text = await readFile(path, "utf8");
    const at = original.indexOf("    },\n  },") + "    },".length;
    const inserted = `\n    "melra": ${JSON.stringify(entry, null, 2).replaceAll("\n", "\n    ")},`;
    expect(text).toBe(`${original.slice(0, at)}${inserted}${original.slice(at)}`);
    expect(parseJsonc(text).value).toMatchObject({
      terminal: { font_family: "Fira // Code", shell: '/* nor this */ " // x' },
      context_servers: { other: { command: "x" }, melra: entry },
    });
  });

  it("replaces an existing MELRA entry in place, keeping comments around it", async () => {
    const path = join(await scratch(), "settings.json");
    const old = '{ "command": "old", /* stale */ }';
    const original = `{\n  "context_servers": {\n    "melra": ${old}, // keep me\n  },\n}\n`;
    await writeFile(path, original);
    await writeClientConfig(path, clientConfig("zed", entry), "zed");
    const rendered = JSON.stringify(entry, null, 2).replaceAll("\n", "\n    ");
    expect(await readFile(path, "utf8")).toBe(original.replace(old, rendered));
  });

  it("creates context_servers when a commented file has none", async () => {
    const path = join(await scratch(), "settings.json");
    await writeFile(path, '{\n  // only mine\n  "theme": "x" // why\n}\n');
    await writeClientConfig(path, clientConfig("zed", entry), "zed");
    const block = JSON.stringify({ melra: entry }, null, 2).replaceAll("\n", "\n  ");
    expect(await readFile(path, "utf8")).toBe(
      `{\n  // only mine\n  "theme": "x", // why\n  "context_servers": ${block}\n}\n`,
    );
  });

  it("adds MELRA to a commented VS Code mcp.json", async () => {
    const path = join(await scratch(), ".vscode", "mcp.json");
    await mkdir(join(path, ".."), { recursive: true });
    const github = '"github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" }';
    const original = `{\n  // workspace servers\n  "servers": {\n    ${github} // remote\n  },\n  "inputs": []\n}\n`;
    await writeFile(path, original);
    await writeClientConfig(path, clientConfig("vscode", entry), "vscode");
    const melra = JSON.stringify({ type: "stdio", ...entry }, null, 2).replaceAll("\n", "\n    ");
    expect(await readFile(path, "utf8")).toBe(
      original.replace(`${github} // remote\n`, `${github}, // remote\n    "melra": ${melra}\n`),
    );
  });

  it("keeps CRLF line endings and tab indentation", async () => {
    const dir = await scratch();
    const crlf = join(dir, "crlf.json");
    await writeFile(crlf, '{\r\n  // c\r\n  "context_servers": {},\r\n}\r\n');
    await writeClientConfig(crlf, clientConfig("zed", entry), "zed");
    const block = JSON.stringify(entry, null, 2).replaceAll("\n", "\r\n    ");
    expect(await readFile(crlf, "utf8")).toBe(
      `{\r\n  // c\r\n  "context_servers": {\r\n    "melra": ${block}\r\n  },\r\n}\r\n`,
    );

    const tabs = join(dir, "tabs.json");
    await writeFile(tabs, '{\n\t// c\n\t"context_servers": {\n\t\t"other": {},\n\t},\n}\n');
    await writeClientConfig(tabs, clientConfig("zed", entry), "zed");
    const tabbed = JSON.stringify(entry, null, "\t").replaceAll("\n", "\n\t\t");
    expect(await readFile(tabs, "utf8")).toBe(
      `{\n\t// c\n\t"context_servers": {\n\t\t"other": {},\n\t\t"melra": ${tabbed},\n\t},\n}\n`,
    );
  });

  it("never overwrites OpenCode's $schema, but adds it when absent", async () => {
    const dir = await scratch();
    const custom = join(dir, "custom.json");
    const original = '{\n  // mine\n  "$schema": "https://example.com/s.json",\n  "mcp": {}\n}\n';
    await writeFile(custom, original);
    await writeClientConfig(custom, clientConfig("opencode", entry), "opencode");
    const text = await readFile(custom, "utf8");
    expect(text.startsWith('{\n  // mine\n  "$schema": "https://example.com/s.json",\n')).toBe(true);
    expect(parseJsonc(text).value).toMatchObject({
      $schema: "https://example.com/s.json",
      mcp: { melra: { type: "local" } },
    });
    const bare = join(dir, "bare.json");
    await writeFile(bare, '{ "mcp": {} } // c\n');
    await writeClientConfig(bare, clientConfig("opencode", entry), "opencode");
    expect(parseJsonc(await readFile(bare, "utf8")).value).toEqual(clientConfig("opencode", entry));
  });

  it.each([
    ["duplicate keys", '{ "context_servers": {}, "context_servers": {} } // c', /more than once/],
    ["a duplicate melra", '{ "context_servers": { "melra": 1, "melra": 2 } }', /more than once/],
    ["invalid JSONC", '{\n  // c\n  "a": 1 "b": 2\n}\n', /not valid JSON or JSONC .*line 3/],
    ["an unterminated comment", '{ "a": 1 } /* c', /not valid JSON or JSONC/],
    ["a non-object root", "[1] // c\n", /does not hold a JSON object/],
    ["a non-object path step", '{ "context_servers": [], }', /"context_servers" is not an object/],
  ])("refuses a file with %s and leaves it untouched", async (_, original, message) => {
    const path = join(await scratch(), "settings.json");
    await writeFile(path, original);
    const write = writeClientConfig(path, clientConfig("zed", entry), "zed");
    await expect(write).rejects.toThrow(message);
    await expect(write).rejects.toThrow(/by hand/);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("parses JSONC: comments, trailing commas, escapes, and source spans", () => {
    const text = '/* a */ {"k": "a // \\"b\\" /* c */", "n": [1, -2.5e3, true, null,], } // z';
    const root = parseJsonc(text);
    expect(root.value).toEqual({ k: 'a // "b" /* c */', n: [1, -2500, true, null] });
    expect(text.slice(root.start, root.end)).toBe(text.slice(8, -5));
    const [k, n] = root.members ?? [];
    expect(text.slice(k?.keyStart, k?.value.end)).toBe('"k": "a // \\"b\\" /* c */"');
    expect(text.slice(n?.value.start, n?.value.end)).toBe("[1, -2.5e3, true, null,]");
    expect(root.trailingComma).toBe(text.lastIndexOf(","));
    for (const bad of ["", "// only", "{,}", "[1,,]", "{'a': 1}", '{"a": 01}', '"\\x"', "{} {}"]) {
      expect(() => parseJsonc(bad), bad).toThrow();
    }
  });

  it("replaces rather than duplicates the Codex table on a rerun", async () => {
    const path = join(await scratch(), "config.toml");
    await writeFile(
      path,
      'model = "o4"\r\n\r\n[mcp_servers.melra]\r\ncommand = "old"\r\n\r\n' +
        '[mcp_servers.melra.env]\r\nA = "1"\r\n\r\n[other]\r\nx = 1\r\n',
    );
    await writeClientConfig(path, clientConfig("codex", entry), "codex");
    await writeClientConfig(path, clientConfig("codex", entry), "codex");
    const text = await readFile(path, "utf8");
    expect(text.match(/^\[mcp_servers\.melra\]$/gm)).toHaveLength(1);
    expect(text).not.toContain('"old"');
    expect(text).toContain("[other]\nx = 1");
    expect(text.startsWith('model = "o4"')).toBe(true);
  });

  it("adds MELRA to Goose's extensions and leaves the rest of the file alone", async () => {
    const path = join(await scratch(), "config.yaml");
    const before = "GOOSE_PROVIDER: openai\nextensions:\n  developer:\n    args:\n    - x\n";
    const after = "\n# tail\nGOOSE_MODEL: gpt-4o\n";
    await writeFile(path, `${before}${after}`);
    const { backup } = await writeClientConfig(path, clientConfig("goose", entry), "goose");
    expect(backup).toBe(`${path}.bak`);
    const melra = clientConfig("goose", entry).toString().replace("extensions:\n", "");
    expect(await readFile(path, "utf8")).toBe(`${before}${melra}${after}`);
  });

  it("replaces rather than duplicates the Goose entry on a rerun", async () => {
    const path = join(await scratch(), "config.yaml");
    await writeFile(
      path,
      "extensions:\r\n    melra:\r\n        cmd: old\r\n\r\n        args: []\r\n" +
        "    other:\r\n        cmd: keep\r\n",
    );
    expect(await writeClientConfig(path, clientConfig("goose", entry), "goose")).toHaveProperty("backup");
    // Second time the file is already right: nothing is written, and the
    // backup of the original is not overwritten with a copy of the result.
    await writeFile(`${path}.bak`, "original");
    expect(await writeClientConfig(path, clientConfig("goose", entry), "goose")).toEqual({
      unchanged: true,
    });
    expect(await readFile(`${path}.bak`, "utf8")).toBe("original");
    const text = await readFile(path, "utf8");
    expect(text.match(/melra:/g)).toHaveLength(1);
    expect(text).not.toContain("old");
    // Nested at the file's own four spaces, with its line endings.
    expect(text).toContain("extensions:\r\n    melra:\r\n      name: melra\r\n");
    expect(text.endsWith("      timeout: 300\r\n    other:\r\n        cmd: keep\r\n")).toBe(true);
  });

  it("creates the Goose file, or adds extensions to one without it", async () => {
    const path = join(await scratch(), "goose", "config.yaml");
    await writeClientConfig(path, clientConfig("goose", entry), "goose");
    expect(await readFile(path, "utf8")).toBe(clientConfig("goose", entry));
    await writeFile(path, "GOOSE_MODEL: x");
    await writeClientConfig(path, clientConfig("goose", entry), "goose");
    expect(await readFile(path, "utf8")).toBe(`GOOSE_MODEL: x\n${clientConfig("goose", entry)}`);
  });

  it.each([
    ["flow-style extensions", "extensions: {developer: {cmd: x}}\n"],
    ["a sequence under extensions", "extensions:\n  - developer\n"],
    ["uneven indentation", "extensions:\n    developer:\n      cmd: x\n  other:\n    cmd: y\n"],
    ["tab indentation", "extensions:\n\tdeveloper: {}\n"],
    ["a non-mapping top level", "- extensions\n"],
  ])("refuses a Goose file with %s and leaves it untouched", async (_, original) => {
    const path = join(await scratch(), "config.yaml");
    await writeFile(path, original);
    await expect(
      writeClientConfig(path, clientConfig("goose", entry), "goose"),
    ).rejects.toThrow(/by hand/);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("emits OpenClaw's mcp.servers and Hermes's mcp_servers", () => {
    expect(clientConfig("openclaw", entry)).toEqual({ mcp: { servers: { melra: entry } } });
    expect(clientConfig("hermes", entry)).toBe(
      [
        "mcp_servers:",
        "  melra:",
        '    command: "melra"',
        '    args: ["serve"]',
        "    env:",
        '      "MELRA_WORKSPACE": "C:\\\\w \\"x\\""',
        "",
      ].join("\n"),
    );
  });

  it("finds Goose's file under an absolute GOOSE_PATH_ROOT, as Goose does", () => {
    const saved = process.env.GOOSE_PATH_ROOT;
    try {
      const root = resolve("/g");
      process.env.GOOSE_PATH_ROOT = root;
      expect(clientConfigPath("goose", "/ws")).toBe(join(root, "config", "config.yaml"));
      // Goose ignores a relative root, so the default location still applies.
      process.env.GOOSE_PATH_ROOT = "relative";
      expect(clientConfigPath("goose", "/ws")).not.toContain("relative");
    } finally {
      if (saved === undefined) delete process.env.GOOSE_PATH_ROOT;
      else process.env.GOOSE_PATH_ROOT = saved;
    }
  });

  it("finds OpenClaw's and Hermes's files through their own overrides", () => {
    const saved = { ...process.env };
    try {
      delete process.env.OPENCLAW_CONFIG_PATH;
      process.env.OPENCLAW_STATE_DIR = join("/s");
      expect(clientConfigPath("openclaw", "/ws")).toBe(join("/s", "openclaw.json"));
      process.env.OPENCLAW_CONFIG_PATH = join("/c", "oc.json5");
      expect(clientConfigPath("openclaw", "/ws")).toBe(join("/c", "oc.json5"));
      process.env.HERMES_HOME = join("/h");
      expect(clientConfigPath("hermes", "/ws")).toBe(join("/h", "config.yaml"));
    } finally {
      for (const key of ["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR", "HERMES_HOME"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it("adds MELRA under OpenClaw's nested mcp.servers, keeping comments and other servers", async () => {
    const path = join(await scratch(), "openclaw.json");
    const original = [
      "// OpenClaw config",
      "{",
      '  "agents": { "defaults": { "model": "x" } },',
      '  "mcp": {',
      '    "servers": {',
      '      "context7": { "command": "uvx", "args": ["context7-mcp"] }, // docs',
      "    },",
      "  },",
      "}",
      "",
    ].join("\n");
    await writeFile(path, original);
    await writeClientConfig(path, clientConfig("openclaw", entry), "openclaw");
    await writeClientConfig(path, clientConfig("openclaw", entry), "openclaw");
    const text = await readFile(path, "utf8");
    expect(text.match(/"melra":/g)).toHaveLength(1);
    expect(text).toContain('"context7": { "command": "uvx", "args": ["context7-mcp"] }, // docs');
    expect(parseJsonc(text).value).toEqual({
      agents: { defaults: { model: "x" } },
      mcp: { servers: { context7: { command: "uvx", args: ["context7-mcp"] }, melra: entry } },
    });

    // No `mcp` key yet: the whole path is added and nothing else changes.
    await writeFile(path, '{\n  "gateway": { "port": 1 },\n}\n');
    await writeClientConfig(path, clientConfig("openclaw", entry), "openclaw");
    expect(parseJsonc(await readFile(path, "utf8")).value).toEqual({
      gateway: { port: 1 },
      mcp: { servers: { melra: entry } },
    });
  });

  it.each([
    ["JSON5 unquoted keys", "{ mcp: { servers: {} } }\n", /not valid JSON or JSONC/],
    ["a non-object mcp", '{ "mcp": true }\n', /"mcp" is not an object/],
    ["a non-object mcp.servers", '{ "mcp": { "servers": [] } }\n', /"mcp.servers" is not an object/],
  ])("refuses an OpenClaw file with %s and leaves it untouched", async (_, original, message) => {
    const path = join(await scratch(), "openclaw.json");
    await writeFile(path, original);
    const write = writeClientConfig(path, clientConfig("openclaw", entry), "openclaw");
    await expect(write).rejects.toThrow(message);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("adds MELRA to Hermes's mcp_servers, replaces it on a rerun, and keeps the rest", async () => {
    const path = join(await scratch(), "config.yaml");
    const before = "model:\n  default: hermes-4\nmcp_servers:\n  docs:\n    command: npx\n";
    const after = "# tail\nterminal:\n  backend: local\n";
    await writeFile(path, `${before}${after}`);
    const { backup } = await writeClientConfig(path, clientConfig("hermes", entry), "hermes");
    expect(backup).toBe(`${path}.bak`);
    const melra = clientConfig("hermes", entry).toString().replace("mcp_servers:\n", "");
    expect(await readFile(path, "utf8")).toBe(`${before}${melra}${after}`);
    await writeClientConfig(path, clientConfig("hermes", { ...entry, command: "npx" }), "hermes");
    const text = await readFile(path, "utf8");
    expect(text.match(/melra:/g)).toHaveLength(1);
    expect(text).toContain('    command: "npx"');
    expect(text.startsWith(before) && text.endsWith(after)).toBe(true);
  });

  it("creates Hermes's file, or adds mcp_servers to one without it", async () => {
    const path = join(await scratch(), ".hermes", "config.yaml");
    await writeClientConfig(path, clientConfig("hermes", entry), "hermes");
    expect(await readFile(path, "utf8")).toBe(clientConfig("hermes", entry));
    await writeFile(path, "model:\n  default: x");
    await writeClientConfig(path, clientConfig("hermes", entry), "hermes");
    expect(await readFile(path, "utf8")).toBe(`model:\n  default: x\n${clientConfig("hermes", entry)}`);
  });

  it.each([
    ["flow-style mcp_servers", "mcp_servers: {docs: {command: x}}\n"],
    ["two mcp_servers keys", "mcp_servers:\n  a:\n    command: x\nmcp_servers:\n  b: {}\n"],
    ["tab indentation", "mcp_servers:\n\tdocs: {}\n"],
  ])("refuses a Hermes file with %s and leaves it untouched", async (_, original) => {
    const path = join(await scratch(), "config.yaml");
    await writeFile(path, original);
    await expect(
      writeClientConfig(path, clientConfig("hermes", entry), "hermes"),
    ).rejects.toThrow(/by hand/);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("emits Copilot CLI's, Factory Droid's, and Kilo Code's own entries", () => {
    expect(clientConfig("copilot", entry)).toEqual({
      mcpServers: { melra: { type: "local", ...entry, tools: ["*"] } },
    });
    expect(clientConfig("droid", entry)).toEqual({ mcpServers: { melra: { type: "stdio", ...entry } } });
    // OpenCode's shape, but never OpenCode's $schema.
    expect(clientConfig("kilo", entry)).toEqual({
      mcp: {
        melra: { type: "local", command: ["melra", "serve"], environment: entry.env, enabled: true },
      },
    });
    for (const name of ["qwen", "auggie", "warp", "junie", "kimi", "lmstudio"]) {
      expect(clientConfig(name, entry), name).toEqual({ mcpServers: { melra: entry } });
    }
    // Warp requires `args` even when there are none.
    expect(clientConfig("warp", { ...entry, args: [] })).toMatchObject({
      mcpServers: { melra: { args: [] } },
    });
  });

  it("puts each new client's file where that client reads it", async () => {
    const root = await scratch();
    const saved = { ...process.env };
    const keys = ["HOME", "USERPROFILE", "COPILOT_HOME", "KIMI_CODE_HOME"];
    try {
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      delete process.env.COPILOT_HOME;
      delete process.env.KIMI_CODE_HOME;
      const at = (name: string) => clientConfigPath(name, "/ws");
      expect(at("copilot")).toBe(join(root, ".copilot", "mcp-config.json"));
      expect(at("qwen")).toBe(join(root, ".qwen", "settings.json"));
      expect(at("auggie")).toBe(join(root, ".augment", "settings.json"));
      expect(at("warp")).toBe(join(root, ".warp", ".mcp.json"));
      expect(at("junie")).toBe(join(root, ".junie", "mcp", "mcp.json"));
      expect(at("droid")).toBe(join(root, ".factory", "mcp.json"));
      expect(at("kimi")).toBe(join(root, ".kimi-code", "mcp.json"));
      process.env.COPILOT_HOME = join(root, "cp");
      process.env.KIMI_CODE_HOME = join(root, "km");
      expect(at("copilot")).toBe(join(root, "cp", "mcp-config.json"));
      expect(at("kimi")).toBe(join(root, "km", "mcp.json"));

      // Kilo: kilo.jsonc, unless only a kilo.json is there.
      expect(at("kilo")).toBe(join(root, ".config", "kilo", "kilo.jsonc"));
      await mkdir(join(root, ".config", "kilo"), { recursive: true });
      await writeFile(join(root, ".config", "kilo", "kilo.json"), "{}");
      expect(at("kilo")).toBe(join(root, ".config", "kilo", "kilo.json"));

      // LM Studio: the pointer file, else the legacy cache home, else ~/.lmstudio.
      expect(at("lmstudio")).toBe(join(root, ".lmstudio", "mcp.json"));
      await mkdir(join(root, ".cache", "lm-studio"), { recursive: true });
      expect(at("lmstudio")).toBe(join(root, ".cache", "lm-studio", "mcp.json"));
      await writeFile(join(root, ".lmstudio-home-pointer"), `${join(root, "lms")}\n`);
      expect(at("lmstudio")).toBe(join(root, "lms", "mcp.json"));
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it("merges Copilot CLI's entry beside other servers and replaces it on a rerun", async () => {
    const path = join(await scratch(), "mcp-config.json");
    const other = { type: "local", command: "npx", args: ["@playwright/mcp@latest"], env: {}, tools: ["*"] };
    await writeFile(path, JSON.stringify({ mcpServers: { playwright: other } }, null, 2));
    await writeClientConfig(path, clientConfig("copilot", { ...entry, command: "old" }), "copilot");
    await writeClientConfig(path, clientConfig("copilot", entry), "copilot");
    const text = await readFile(path, "utf8");
    expect(text.match(/"melra":/g)).toHaveLength(1);
    expect(JSON.parse(text)).toEqual({
      mcpServers: { playwright: other, melra: { type: "local", ...entry, tools: ["*"] } },
    });
    await writeFile(path, '{ "mcpServers": [] }');
    await expect(
      writeClientConfig(path, clientConfig("copilot", entry), "copilot"),
    ).rejects.toThrow(/"mcpServers" is not an object/);
  });

  it("adds MELRA to a commented kilo.jsonc without a $schema, keeping the rest", async () => {
    const path = join(await scratch(), "kilo.jsonc");
    const original = '{\n  // mine\n  "model": "x",\n  "mcp": {\n    "docs": { "type": "remote", "url": "https://d" }, // remote\n  },\n}\n';
    await writeFile(path, original);
    await writeClientConfig(path, clientConfig("kilo", entry), "kilo");
    await writeClientConfig(path, clientConfig("kilo", entry), "kilo");
    const text = await readFile(path, "utf8");
    expect(text.startsWith('{\n  // mine\n  "model": "x",\n')).toBe(true);
    expect(text).toContain('"docs": { "type": "remote", "url": "https://d" }, // remote');
    expect(text).not.toContain("$schema");
    expect(text.match(/"melra":/g)).toHaveLength(1);
    expect(parseJsonc(text).value).toMatchObject({
      model: "x",
      mcp: { docs: { type: "remote" }, melra: { type: "local", command: ["melra", "serve"] } },
    });
  });

  it("writes Continue's block file whole, backing up an earlier one", async () => {
    const path = clientConfigPath("continue", await scratch()) ?? "";
    expect(path.endsWith(join(".continue", "mcpServers", "melra.yaml"))).toBe(true);
    expect(await writeClientConfig(path, clientConfig("continue", entry), "continue")).toEqual({});
    await writeFile(path, "name: stale\n");
    const { backup } = await writeClientConfig(path, clientConfig("continue", entry), "continue");
    expect(await readFile(path, "utf8")).toBe(clientConfig("continue", entry));
    expect(await readFile(backup ?? "", "utf8")).toBe("name: stale\n");
  });

  it("adds deny rules to Claude Code settings as a union, keeping every rule and key there", async () => {
    const folder = join(await scratch(), ".claude");
    const path = join(folder, "settings.local.json");
    expect(await denyRulesText(path, ["Bash", "Edit"])).toEqual({
      next: '{\n  "permissions": {\n    "deny": [\n      "Bash",\n      "Edit"\n    ]\n  }\n}\n',
    });
    const original = '{\n  "model": "x",\n  "permissions": {\n    "allow": ["Bash(npm test)"],\n    "deny": ["Read(./.env)", "Edit"]\n  }\n}\n';
    await mkdir(folder);
    await writeFile(path, original);
    const { existing, next } = await denyRulesText(path, ["Bash", "Edit", "Write"]);
    expect(existing).toBe(original);
    expect(next.startsWith('{\n  "model": "x",\n  "permissions": {\n    "allow": ["Bash(npm test)"],\n')).toBe(true);
    expect(JSON.parse(next)).toEqual({
      model: "x",
      permissions: { allow: ["Bash(npm test)"], deny: ["Read(./.env)", "Edit", "Bash", "Write"] },
    });
    expect(await replaceFile(path, existing, next)).toEqual({ backup: `${path}.bak` });
    expect(await readFile(`${path}.bak`, "utf8")).toBe(original);
    // Every rule already there: the file is left as it is.
    const again = await denyRulesText(path, ["Write", "Bash"]);
    expect(again.next).toBe(next);
    expect(await replaceFile(path, again.existing, again.next)).toEqual({ unchanged: true });
  });

  it("refuses Claude Code settings it cannot merge into exactly", async () => {
    const path = join(await scratch(), "settings.local.json");
    for (const [text, why] of [
      ['{"permissions": {"deny": ["Edit"]}, "permissions": {}}', /"permissions" appears more than once/],
      ['{"permissions": {"deny": "Bash"}}', /permissions\.deny is not a list of rules/],
      ['{"permissions": []}', /"permissions" is not an object/],
      ["[]", /it does not hold a JSON object/],
      // Claude Code reads it as strict JSON, and would load none of it.
      ['{\n// note\n"permissions": {}\n}', /strict JSON/],
      ['{"permissions": {},}', /strict JSON/],
    ] as const) {
      await writeFile(path, text);
      await expect(denyRulesText(path, ["Bash"])).rejects.toThrow(why);
    }
  });
});
