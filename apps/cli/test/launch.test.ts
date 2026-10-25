// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// `melra launch claude-code`, against a stand-in `claude` that records what it
// was started with, so no real Claude Code, login or network is needed.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { claudeLaunchArgv, claudeProgram } from "../src/environment.js";
import { renderLaunch } from "../src/human.js";

const execute = promisify(execFile);
const entry = resolve(import.meta.dirname, "../dist/bin.js");
const roots: string[] = [];
const FIXED = ["--tools", "Read,Glob,Grep", "--mcp-config", "c.json", "--strict-mcp-config", "--restricted"];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

// A workspace and a home of their own, and an environment holding no MELRA_*
// setting of the shell's, so each run sees only what it sets.
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "melra-launch-test-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(workspace);
  await mkdir(home, { mode: 0o700 });
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (pair): pair is [string, string] => pair[1] !== undefined && !pair[0].startsWith("MELRA_"),
    ),
  );
  return { root, workspace, home, env: { ...inherited, MELRA_WORKSPACE: workspace, MELRA_HOME: home } };
}

async function launch(args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  try {
    const { stdout, stderr } = await execute(process.execPath, [entry, "launch", "claude-code", ...args], {
      env,
      ...(cwd === undefined ? {} : { cwd }),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

// A stand-in claude in `directory` that records what it was started with, and
// which one it was, in STUB_RECORD, then exits 7. A script with a shebang,
// which Windows will not run.
async function stub(directory: string, label = "claude") {
  const path = join(directory, "claude");
  await writeFile(
    path,
    [
      "#!/usr/bin/env node",
      'const { readFileSync, writeFileSync } = require("node:fs");',
      "const argv = process.argv.slice(2);",
      'const config = argv[argv.indexOf("--mcp-config") + 1];',
      "writeFileSync(process.env.STUB_RECORD, JSON.stringify({",
      `  label: ${JSON.stringify(label)}, argv, cwd: process.cwd(), config, content: readFileSync(config, 'utf8'),`,
      "  launched: process.env.MELRA_LAUNCHED ?? null,",
      "}));",
      "process.exit(7);",
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return path;
}

describe("claudeProgram", () => {
  it("finds a bare name only in PATH's absolute directories, and refuses a Windows batch file", async () => {
    const { root, workspace } = await sandbox();
    const bin = join(root, "bin");
    await mkdir(bin);
    for (const name of ["claude", "claude.cmd"]) {
      await writeFile(join(bin, name), "");
      await chmod(join(bin, name), 0o755);
    }
    // An empty or relative entry is a directory relative to wherever claude
    // starts, the workspace.
    expect(await claudeProgram("claude", { PATH: ["", ".", "workspace", bin].join(delimiter) }, false)).toBe(
      join(bin, "claude"),
    );
    await expect(claudeProgram("claude", { PATH: workspace }, false)).rejects.toThrow("claude_not_found");
    // npm's extensionless script is skipped, and the .cmd beside it needs a shell.
    await expect(claudeProgram("claude", { PATH: bin, PATHEXT: ".exe;.cmd" }, true)).rejects.toThrow(
      "claude_not_runnable",
    );
    // A name with a directory in it is resolved where it was typed.
    expect(await claudeProgram(join("x", "claude"))).toBe(resolve("x", "claude"));
  });
});

describe("claudeLaunchArgv", () => {
  it("starts claude with read-only built-in tools, melra as its only MCP server, and restricted", () => {
    expect(claudeLaunchArgv("c.json", [])).toEqual(FIXED);
    // A prompt goes last, after a flag that takes no list, so it is not read
    // as one more tool or config file.
    expect(claudeLaunchArgv("c.json", ["-p", "list the files", "--model", "sonnet", "--output-format", "json"])).toEqual([
      ...FIXED,
      "-p",
      "list the files",
      "--model",
      "sonnet",
      "--output-format",
      "json",
    ]);
    expect(claudeLaunchArgv("c.json", ["--resume", "0f0e", "-c", "--verbose", "fix the build"]).slice(FIXED.length)).toEqual([
      "--resume",
      "0f0e",
      "-c",
      "--verbose",
      "fix the build",
    ]);
  });

  it("refuses every other flag, a valued flag with no value, and a prompt that names a subcommand", () => {
    for (const refused of [
      "--tools",
      "--allowedTools",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "--settings",
      "--mcp-config",
      "--add-dir",
      "--plugin-dir",
      "--model=opus",
      "-pc",
      "--",
    ]) {
      expect(() => claudeLaunchArgv("c.json", [refused, "x y"])).toThrow(`launch_argument_refused: ${refused}`);
    }
    // Taken as its value, `--restricted` would be lost.
    expect(() => claudeLaunchArgv("c.json", ["--model", "--restricted"])).toThrow("--model requires a value");
    expect(() => claudeLaunchArgv("c.json", ["--output-format"])).toThrow("--output-format requires a value");
    expect(() => claudeLaunchArgv("c.json", ["-p", "mcp"])).toThrow("launch_argument_refused: mcp");
  });
});

describe("renderLaunch", () => {
  it("warns when the policy still allows a program that runs any other", () => {
    const quiet = renderLaunch({ mode: "developer", unhinged: false, workspace: "/w", allowedCommands: ["git"] });
    expect(quiet).not.toContain("Warning");
    expect(quiet).toContain("node, npm, npx and pnpm only if the policy file lists them");
    const loud = renderLaunch({ mode: "developer", unhinged: false, workspace: "/w", allowedCommands: ["git", "node", "npm"] });
    expect(loud).toMatch(/Warning\s+the policy allows node, npm/);
  });

  it("says what unsafe-local does: any program, nothing asked, no policy", () => {
    const text = renderLaunch({ mode: "developer", unhinged: true, workspace: "/w", allowedCommands: ["git", "node"] });
    expect(text).toMatch(/Mode\s+UNSAFE-LOCAL/);
    expect(text).toMatch(/Policy\s+not applied/);
    expect(text).toMatch(/Commands\s+any program, shells included/);
    expect(text).toMatch(/Approve\s+nothing is asked/);
    expect(text).not.toContain("only if the policy file lists them");
    expect(text).not.toContain("Warning");
  });
});

describe("melra launch claude-code", () => {
  it("prints the claude command and its melra-only MCP config with --dry-run, and runs nothing", async () => {
    const { workspace, home, env } = await sandbox();
    const run = await launch(["--dry-run", "--", "-p", "list the files", "--model", "sonnet"], {
      ...env,
      CLAUDE_BIN: join(home, "no-such-claude"),
    });
    expect(run.code).toBe(0);
    const planned = JSON.parse(run.stdout) as {
      command: string;
      args: string[];
      cwd: string;
      mcpConfig: { mcpServers: Record<string, unknown> };
    };
    expect(planned.command).toBe(join(home, "no-such-claude"));
    expect(planned.args).toEqual([
      "--tools",
      "Read,Glob,Grep",
      "--mcp-config",
      "<mcp-config.json>",
      "--strict-mcp-config",
      "--restricted",
      "-p",
      "list the files",
      "--model",
      "sonnet",
    ]);
    expect(planned.cwd).toBe(workspace);
    // melra alone, by absolute path, never a bare name or npx.
    expect(planned.mcpConfig).toEqual({
      mcpServers: {
        melra: {
          command: process.execPath,
          args: [entry, "serve"],
          env: { MELRA_WORKSPACE: workspace, MELRA_HOME: home, MELRA_HARNESS_TOOLS: "1", MELRA_LAUNCHED: "1" },
        },
      },
    });
    expect(run.stderr).toContain("MELRA's tools are the only ones it has that change anything");
    expect(run.stderr).toMatch(/Mode\s+developer/);
    expect(run.stderr).toContain(`Workspace  ${workspace}`);
    expect(run.stderr).toContain("Bash, Edit, Write, WebFetch");
    expect(run.stderr).toContain("--mode enforced to approve each change yourself");
    expect(run.stderr).not.toContain("Warning");
  });

  it("follows the mode and policy file every other command would use", async () => {
    const { home, env } = await sandbox();
    const policy = join(home, "policy.json");
    await writeFile(policy, JSON.stringify({ mode: "enforced", allowedCommands: ["git", "node"] }));
    const run = await launch(["--dry-run"], { ...env, CLAUDE_BIN: join(home, "no-such-claude") });
    expect(run.code).toBe(0);
    const { mcpConfig } = JSON.parse(run.stdout) as { mcpConfig: { mcpServers: { melra: { env: Record<string, string> } } } };
    expect(mcpConfig.mcpServers.melra.env).toMatchObject({ MELRA_POLICY: policy, MELRA_MODE: "enforced" });
    expect(run.stderr).toMatch(/Mode\s+enforced/);
    expect(run.stderr).toContain("melra approve <task-id> or melra console");
    // Listed in the file, so kept, and said out loud.
    expect(run.stderr).toMatch(/Warning\s+the policy allows node/);
  });

  it("refuses a claude argument off the list, another harness, or a claude that is not there", async () => {
    const { home, env } = await sandbox();
    // Had it got as far as starting claude, this one would be claude_not_found.
    const withBin = { ...env, CLAUDE_BIN: join(home, "no-such-claude") };
    const refused = await launch(["--", "--dangerously-skip-permissions"], withBin);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("launch_argument_refused: --dangerously-skip-permissions");
    const flag = await launch(["--tools", "Bash"], withBin);
    expect(flag.stderr).toContain("unknown flag --tools");
    // --dry-run takes no value, so the flag after it is still checked.
    const after = await launch(["--dry-run", "--bogus"], withBin);
    expect(after.code).toBe(1);
    expect(after.stderr).toContain("unknown flag --bogus");
    const other = await execute(process.execPath, [entry, "launch", "codex"], { env: withBin }).catch(
      (error: { stderr: string }) => error,
    );
    expect(other.stderr).toContain("launch supports only claude-code");
    const missing = await launch([], withBin);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("claude_not_found");
  });

  it("passes unsafe-local on to the server it names", async () => {
    const { home, env } = await sandbox();
    const run = await launch(["--unsafe-local", "--dry-run"], { ...env, CLAUDE_BIN: join(home, "no-such-claude") });
    expect(run.code).toBe(0);
    const { mcpConfig } = JSON.parse(run.stdout) as { mcpConfig: { mcpServers: { melra: { env: Record<string, string> } } } };
    expect(mcpConfig.mcpServers.melra.env.MELRA_UNHINGED).toBe("1");
    expect(run.stderr).toMatch(/Mode\s+UNSAFE-LOCAL/);
  });

  it("asks about a workspace that is home before anything else, as setup does", async () => {
    const { workspace, home, env } = await sandbox();
    const { MELRA_WORKSPACE: _unset, ...unset } = env;
    const real = await realpath(workspace);
    const run = await launch(
      ["--dry-run"],
      { ...unset, HOME: real, USERPROFILE: real, CLAUDE_BIN: join(home, "no-such-claude") },
      real,
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("workspace_too_broad");
    expect(run.stderr).not.toContain("Starting Claude Code");
  });

  it("stops before claude when the server it names would refuse to start", async () => {
    const { workspace, home, env } = await sandbox();
    // Had it got as far as starting claude, this would be claude_not_found.
    const run = await launch(["--mode", "enforced"], {
      ...env,
      MELRA_HOME: join(workspace, ".melra"),
      CLAUDE_BIN: join(home, "no-such-claude"),
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("enforced_mode_refuses_data_inside_workspace");
    expect(run.stderr).not.toContain("Starting Claude Code");
  });

  it("runs the claude named from where it was typed, and a bare one only from PATH's absolute directories", async () => {
    if (process.platform === "win32") return;
    const { root, workspace, env } = await sandbox();
    const record = join(root, "claude-was-run.json");
    const caller = join(root, "caller");
    const bin = join(root, "bin");
    await mkdir(caller);
    await mkdir(bin);
    // claude starts in the workspace, so one there must not be the one run.
    await stub(workspace, "workspace");
    await stub(caller, "caller");
    await stub(bin, "path");
    const ran = async (args: string[], extra: NodeJS.ProcessEnv) => {
      await rm(record, { force: true });
      await launch(args, { ...env, ...extra, STUB_RECORD: record }, caller);
      return (JSON.parse(await readFile(record, "utf8")) as { label: string }).label;
    };
    expect(await ran(["--claude-bin", "./claude"], {})).toBe("caller");
    expect(await ran([], { CLAUDE_BIN: "./claude" })).toBe("caller");
    // An empty PATH entry is the directory claude starts in.
    expect(await ran([], { PATH: `${delimiter}${bin}${delimiter}${process.env.PATH ?? ""}` })).toBe("path");
  });

  it("stops claude and removes its config when told to stop or hung up on", async () => {
    if (process.platform === "win32") return;
    const { root, env } = await sandbox();
    // A claude that says it is up, then runs until SIGTERM and exits 5.
    const waiter = join(root, "claude");
    await writeFile(
      waiter,
      [
        "#!/usr/bin/env node",
        "const argv = process.argv.slice(2);",
        'process.on("SIGTERM", () => process.exit(5));',
        'console.log(`ready ${process.pid} ${argv[argv.indexOf("--mcp-config") + 1]}`);',
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    await chmod(waiter, 0o755);
    for (const signal of ["SIGTERM", "SIGHUP"] as const) {
      const launcher = spawn(process.execPath, [entry, "launch", "claude-code", "--claude-bin", waiter], {
        env,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const exited = new Promise<number | null>((done) => launcher.once("exit", (code) => done(code)));
      // claude shares the launcher's stdout.
      const [pid, config] = await new Promise<[string, string]>((ready) => {
        let text = "";
        launcher.stdout.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          const line = /^ready (\d+) (.+)\n/m.exec(text);
          if (line !== null) ready([line[1]!, line[2]!]);
        });
      });
      launcher.kill(signal);
      try {
        // claude's exit code is the launcher's: claude was stopped and waited for.
        expect(await exited, signal).toBe(5);
        expect(existsSync(dirname(config)), signal).toBe(false);
      } finally {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // Already gone, as it should be.
        }
      }
    }
  });

  it("runs claude with exactly those flags, and the server it names drops node, npm, npx and pnpm", async () => {
    if (process.platform === "win32") return;
    const { root, workspace, env } = await sandbox();
    const record = join(root, "claude-was-run.json");
    const run = await launch(["--claude-bin", await stub(root), "--", "-p", "list the files"], {
      ...env,
      STUB_RECORD: record,
    });
    // claude's exit code is the launcher's.
    expect(run.code).toBe(7);
    const seen = JSON.parse(await readFile(record, "utf8")) as {
      argv: string[];
      cwd: string;
      config: string;
      content: string;
      launched: string | null;
    };
    expect(seen.argv).toEqual([
      "--tools",
      "Read,Glob,Grep",
      "--mcp-config",
      seen.config,
      "--strict-mcp-config",
      "--restricted",
      "-p",
      "list the files",
    ]);
    // In the workspace, where `--restricted` confines claude's own file tools.
    expect(seen.cwd).toBe(await realpath(workspace));
    // Only the server it starts is told; claude's own environment is the shell's.
    expect(seen.launched).toBeNull();
    // Removed once claude has exited.
    expect(existsSync(seen.config)).toBe(false);
    const { mcpServers } = JSON.parse(seen.content) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(Object.keys(mcpServers)).toEqual(["melra"]);
    const server = mcpServers.melra!;
    // Started as claude would start it, the server allows no runtime.
    const client = new Client({ name: "launch-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: server.command,
        args: server.args,
        cwd: workspace,
        env: { ...env, ...server.env },
        stderr: "pipe",
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["melra_plan", "read_file", "run_command"]));
      const result = await client.callTool({ name: "melra_capabilities", arguments: {} });
      const text = (result.content as { text: string }[])[0]!.text;
      const { policy } = JSON.parse(text) as { policy: { allowedCommands: string[]; mode: string } };
      expect(policy.mode).toBe("developer");
      expect(policy.allowedCommands).toContain("git");
      for (const command of ["node", "npm", "npx", "pnpm"]) expect(policy.allowedCommands).not.toContain(command);
    } finally {
      await client.close();
    }
  });
});
