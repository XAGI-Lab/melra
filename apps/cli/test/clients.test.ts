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
  });

  it("merges into an existing JSON file and keeps a backup", async () => {
    const path = join(await scratch(), "mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: { other: { command: "x" } }, keep: 1 }));
    const { backup } = await writeClientConfig(path, clientConfig("cursor", entry));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: { other: { command: "x" }, melra: entry },
      keep: 1,
    });
    expect(backup).toBe(`${path}.bak`);
  });

  it("creates a missing file and its directory", async () => {
    const path = join(await scratch(), "nested", ".vscode", "mcp.json");
    expect(await writeClientConfig(path, clientConfig("vscode", entry))).toEqual({});
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(clientConfig("vscode", entry));
  });

  it("refuses a JSON file it would have to strip comments from", async () => {
    const path = join(await scratch(), "settings.json");
    const original = '{\n  // mine\n  "theme": "x"\n}\n';
    await writeFile(path, original);
    await expect(writeClientConfig(path, clientConfig("zed", entry))).rejects.toThrow(
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
    await writeClientConfig(path, clientConfig("codex", entry));
    await writeClientConfig(path, clientConfig("codex", entry));
    const text = await readFile(path, "utf8");
    expect(text.match(/^\[mcp_servers\.melra\]$/gm)).toHaveLength(1);
    expect(text).not.toContain('"old"');
    expect(text).toContain("[other]\nx = 1");
    expect(text.startsWith('model = "o4"')).toBe(true);
  });
});
