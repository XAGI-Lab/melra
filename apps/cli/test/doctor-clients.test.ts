// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_VERSION } from "@melra/protocol";

const execute = promisify(execFile);
const entry = resolve(import.meta.dirname, "../dist/bin.js");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

async function put(path: string, text: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, mode === undefined ? {} : { mode });
}

// Every client path hangs off one of these, so pointing them all at a scratch
// directory keeps the real machine's configs out of the assertions. Windows
// reads the home directory from USERPROFILE, everything else from HOME.
async function doctor(root: string, extraPath = "") {
  // Windows spells it `Path`; adding a second `PATH` key would leave which
  // one the child sees up to the platform.
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const result = await execute(process.execPath, [entry, "doctor"], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      APPDATA: join(root, "AppData"),
      XDG_CONFIG_HOME: join(root, ".config"),
      CODEX_HOME: join(root, ".codex"),
      MELRA_HOME: join(root, ".melra"),
      MELRA_WORKSPACE: root,
      [pathKey]: `${extraPath}${delimiter}${process.env[pathKey] ?? ""}`,
    },
  });
  return JSON.parse(result.stdout) as {
    ready: boolean;
    checks: Array<{ name: string; status: string; detail: string }>;
    clients: Array<{ client: string; state: string; command?: string; pin?: string; problems: string[] }>;
  };
}

describe("doctor clients check", () => {
  it("says when no client config exists, and passes", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-doctor-"));
    roots.push(root);
    const report = await doctor(root);
    const check = report.checks.find((item) => item.name === "clients");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("no MCP client config files found");
    expect(check?.detail).toContain("melra setup --client <name> --write");
    expect(report.clients).toEqual([]);
  });

  it("reports configured, stale, missing, unparsed, and absent entries without writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-doctor-"));
    roots.push(root);
    // A `melra` on PATH, so the configured cursor entry resolves.
    const bin = join(root, "bin");
    if (process.platform === "win32") await put(join(bin, "melra.cmd"), "@echo off\r\n");
    else await put(join(bin, "melra"), "#!/bin/sh\n", 0o755);

    const server = (command: string, args: string[]) =>
      JSON.stringify({ mcpServers: { melra: { command, args, env: {} } } });
    await put(join(root, ".cursor", "mcp.json"), server("melra", ["serve"]));
    await put(
      join(root, ".gemini", "settings.json"),
      server("npx", ["-y", "@melra/cli@0.0.1-alpha.1", "serve"]),
    );
    await put(join(root, ".kiro", "settings", "mcp.json"), server("melra-not-installed", ["serve"]));
    await put(
      join(root, ".codeium", "windsurf", "mcp_config.json"),
      JSON.stringify({ mcpServers: { other: { command: "other" } } }),
    );
    await put(
      join(root, ".codex", "config.toml"),
      [
        'model = "x"',
        "",
        "[mcp_servers.melra]",
        'command = "npx"',
        `args = ["-y", "@melra/cli@${PRODUCT_VERSION}", "serve"]`,
        "",
      ].join("\n"),
    );
    const zed =
      process.platform === "win32"
        ? join(root, "AppData", "Zed", "settings.json")
        : join(root, ".config", "zed", "settings.json");
    await put(
      zed,
      '// Zed settings\n{\n  "context_servers": {\n    "melra": { "command": "melra", "args": ["serve"] },\n  },\n}\n',
    );
    await put(
      join(root, ".config", "amp", "settings.json"),
      JSON.stringify({ "amp.mcpServers": { melra: { command: "melra", args: ["serve"], env: {} } } }),
    );
    const goose =
      process.platform === "win32"
        ? join(root, "AppData", "Block", "goose", "config", "config.yaml")
        : join(root, ".config", "goose", "config.yaml");
    await put(
      goose,
      [
        "GOOSE_PROVIDER: x",
        "extensions:",
        "  developer:",
        "    cmd: \"other\"",
        "  melra:",
        "    type: stdio",
        "    cmd: \"npx\"",
        "    args: [\"-y\", \"@melra/cli@0.0.1-alpha.1\", \"serve\"]",
        "GOOSE_MODEL: y",
        "",
      ].join("\n"),
    );
    await put(
      join(root, ".continue", "mcpServers", "melra.yaml"),
      'name: MELRA\nmcpServers:\n  - name: melra\n    command: "melra"\n    args: ["serve"]\n',
    );
    const before = (await readdir(root, { recursive: true })).sort();

    const report = await doctor(root, bin);
    const byName = Object.fromEntries(report.clients.map((status) => [status.client, status]));
    expect(byName.cursor).toMatchObject({ state: "configured", command: "melra", problems: [] });
    expect(byName.gemini).toMatchObject({ state: "configured", pin: "0.0.1-alpha.1" });
    expect(byName.gemini?.problems.join()).toContain("fix: melra setup --client gemini --write");
    expect(byName.kiro?.problems).toEqual(["'melra-not-installed' not found on PATH"]);
    expect(byName.windsurf).toMatchObject({ state: "not configured", problems: [] });
    expect(byName.codex).toMatchObject({ state: "configured", command: "npx", pin: PRODUCT_VERSION });
    expect(byName.codex?.problems.join()).not.toContain("pinned");
    expect(byName.zed).toMatchObject({
      state: "configured",
      note: "not plain JSON, found by text search; command not checked",
      problems: [],
    });

    expect(byName.amp).toMatchObject({ state: "configured", command: "melra", problems: [] });
    expect(byName.goose).toMatchObject({ state: "configured", command: "npx", pin: "0.0.1-alpha.1" });
    expect(byName.continue).toMatchObject({ state: "configured", command: "melra", problems: [] });

    const check = report.checks.find((item) => item.name === "clients");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain(
      `gemini: configured (pinned to @melra/cli@0.0.1-alpha.1, this is ${PRODUCT_VERSION}; fix: melra setup --client gemini --write)`,
    );
    // A client problem is advice, never a reason to call the machine unready.
    expect(report.ready).toBe(true);
    // Read-only: nothing new beside the data directory doctor already makes.
    const after = await readdir(root, { recursive: true });
    expect(after.filter((path) => !path.startsWith(".melra")).sort()).toEqual(before);
  });
});
