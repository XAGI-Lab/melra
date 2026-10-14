// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENTS,
  clientConfig,
  clientConfigPath,
  resolveClient,
  writeClientConfig,
} from "../src/clients.js";

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

  it("refuses a JSON file it would have to strip comments from", async () => {
    const path = join(await scratch(), "settings.json");
    const original = '{\n  // mine\n  "theme": "x"\n}\n';
    await writeFile(path, original);
    await expect(writeClientConfig(path, clientConfig("zed", entry), "zed")).rejects.toThrow(
      /not plain JSON/,
    );
    expect(await readFile(path, "utf8")).toBe(original);
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
    await writeClientConfig(path, clientConfig("goose", entry), "goose");
    await writeClientConfig(path, clientConfig("goose", entry), "goose");
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

  it("writes Continue's block file whole, backing up an earlier one", async () => {
    const path = clientConfigPath("continue", await scratch()) ?? "";
    expect(path.endsWith(join(".continue", "mcpServers", "melra.yaml"))).toBe(true);
    expect(await writeClientConfig(path, clientConfig("continue", entry), "continue")).toEqual({});
    await writeFile(path, "name: stale\n");
    const { backup } = await writeClientConfig(path, clientConfig("continue", entry), "continue");
    expect(await readFile(path, "utf8")).toBe(clientConfig("continue", entry));
    expect(await readFile(backup ?? "", "utf8")).toBe("name: stale\n");
  });
});
