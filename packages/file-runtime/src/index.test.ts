// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, parse } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileOperationSchema } from "@melra/protocol";
import { FileRuntime } from "./index.js";

// Counts the runtime's link and identity lookups; each still does the real one.
// `after`, once set, runs when the first `stat` or `open` of its path returns.
const lookups = vi.hoisted(() => ({
  realpath: 0,
  stat: 0,
  after: undefined as { path: string; then: () => Promise<void> } | undefined,
}));
vi.mock("node:fs/promises", async (actual) => {
  const fs = await actual<typeof import("node:fs/promises")>();
  const looked = async <T>(path: unknown, answer: Promise<T>): Promise<T> => {
    const value = await answer;
    const after = lookups.after;
    if (after !== undefined && String(path) === after.path) {
      lookups.after = undefined;
      await after.then();
    }
    return value;
  };
  return {
    ...fs,
    realpath: (...args: Parameters<typeof fs.realpath>) => {
      lookups.realpath += 1;
      return fs.realpath(...args);
    },
    stat: (...args: Parameters<typeof fs.stat>) => {
      lookups.stat += 1;
      return looked(args[0], fs.stat(...args));
    },
    open: (...args: Parameters<typeof fs.open>) => looked(args[0], fs.open(...args)),
  };
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileRuntime", () => {
  it("writes atomically and returns a content hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-file-"));
    roots.push(root);
    const runtime = await FileRuntime.create({ root });
    const result = await runtime.execute(
      FileOperationSchema.parse({
        kind: "file",
        action: "write",
        path: "artifacts/result.txt",
        content: "verified",
      }),
    );
    expect(result.written).toBe(true);
    expect(await readFile(join(root, "artifacts/result.txt"), "utf8")).toBe("verified");
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the permissions of the file it replaces, and writes a name as long as the file system allows", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-file-"));
    roots.push(root);
    const runtime = await FileRuntime.create({ root });
    const write = (path: string, content: string) =>
      runtime.execute(FileOperationSchema.parse({ kind: "file", action: "write", path, content }));
    if (process.platform !== "win32") {
      for (const [name, mode] of [["secret.env", 0o600], ["run.sh", 0o755]] as const) {
        await writeFile(join(root, name), "before");
        await chmod(join(root, name), mode);
        await write(name, "after");
        expect(await readFile(join(root, name), "utf8")).toBe("after");
        expect((await stat(join(root, name))).mode & 0o777).toBe(mode);
      }
    }
    // 255 bytes, the usual limit for one name: the temporary copy's name
    // used to add 47 more.
    const long = `${"n".repeat(251)}.txt`;
    await write(long, "fits");
    expect(await readFile(join(root, long), "utf8")).toBe("fits");
    expect((await readdir(root)).filter((name) => name.includes(".melra-"))).toEqual([]);
  });

  it("never treats a differently cased spelling of the root as somewhere else", async () => {
    // On Windows `..\\WS` and `ws` are the same directory. The guard compared
    // strings, so a recursive delete of that spelling removed the workspace.
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    const runtime = await FileRuntime.create({ root });
    await expect(
      runtime.execute(
        FileOperationSchema.parse({
          kind: "file",
          action: "delete",
          path: join("..", basename(root).toUpperCase()),
          recursive: true,
        }),
      ),
    ).rejects.toThrow();
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it("hashes only a regular file", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-file-"));
    roots.push(root);
    const runtime = await FileRuntime.create({ root });
    if (process.platform !== "win32") {
      // A FIFO never ends: reading it to hash it blocked forever.
      spawnSync("mkfifo", [join(root, "pipe")]);
      await expect(
        runtime.execute(FileOperationSchema.parse({ kind: "file", action: "hash", path: "pipe" })),
      ).rejects.toThrow("file_hash_requires_regular_file");
    }
    await mkdir(join(root, "dir"));
    await expect(
      runtime.execute(FileOperationSchema.parse({ kind: "file", action: "hash", path: "dir" })),
    ).rejects.toThrow("file_hash_requires_regular_file");
  });

  // POSIX only: no Unix socket in the Windows file system.
  it.skipIf(process.platform === "win32")("refuses a Unix socket as not a regular file, not with the open's errno", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-file-"));
    roots.push(root);
    const runtime = await FileRuntime.create({ root });
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(join(root, "s.sock"), resolve));
    try {
      for (const action of ["read", "hash"] as const) {
        await expect(
          runtime.execute(FileOperationSchema.parse({ kind: "file", action, path: "s.sock" })),
          action,
        ).rejects.toThrow(`file_${action}_requires_regular_file`);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // POSIX only: Windows has no FIFOs.
  it.skipIf(process.platform === "win32")("reads the file it checked, not a FIFO put in its place after", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    const runtime = await FileRuntime.create({ root });
    const path = join(root, "f.txt");
    for (const action of ["read", "hash"] as const) {
      await rm(path, { force: true });
      await writeFile(path, "checked");
      // Swapped as the first lookup by name after the check returns: a check
      // by name and then an open by name blocked on the FIFO, waiting for a
      // writer that never came. Moved aside, not removed, so on Linux the
      // descriptor's name is still in the workspace.
      lookups.after = {
        path,
        then: async () => {
          await rename(path, join(root, "aside"));
          spawnSync("mkfifo", [path]);
        },
      };
      const outcome = runtime.execute(FileOperationSchema.parse({ kind: "file", action, path: "f.txt" }));
      try {
        const settled = await Promise.race([
          outcome.then((result) => result.sha256, (error: unknown) => String(error)),
          new Promise((resolve) => setTimeout(() => resolve("still waiting after 5 s"), 5_000)),
        ]);
        expect(settled, action).toBe(createHash("sha256").update("checked").digest("hex"));
      } finally {
        lookups.after = undefined;
        // Lets a reader still waiting on the FIFO go, so nothing outlives the test.
        await open(path, constants.O_WRONLY | constants.O_NONBLOCK).then((handle) => handle.close(), () => undefined);
        await outcome.catch(() => undefined);
      }
    }
  }, 30_000);

  // POSIX only: a link needs a privilege on Windows, where nothing checks
  // the descriptor either.
  it.skipIf(process.platform === "win32")("never reads through a link put in the path after the check", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(base);
    const root = join(base, "ws");
    await mkdir(join(root, "dir"), { recursive: true });
    await mkdir(join(base, "outside"));
    await writeFile(join(root, "dir", "f.txt"), "checked");
    await writeFile(join(base, "outside", "f.txt"), "outside");
    const runtime = await FileRuntime.create({ root });
    const resolvePath = runtime.resolvePath.bind(runtime);
    const swap = async () => {
      await rename(join(root, "dir"), join(root, "moved"));
      await symlink(join(base, "outside"), join(root, "dir"));
    };
    for (const action of ["read", "hash"] as const) {
      let checks = 0;
      runtime.resolvePath = async (...args: Parameters<typeof resolvePath>) => {
        const resolved = await resolvePath(...args);
        checks += 1;
        if (checks === 1) await swap();
        return resolved;
      };
      // Opened through the link, it was read outside the workspace. macOS
      // judges where the link leads before opening, Linux what was opened.
      await expect(
        runtime.execute(FileOperationSchema.parse({ kind: "file", action, path: "dir/f.txt" })),
        action,
      ).rejects.toThrow("path_outside_workspace");
      runtime.resolvePath = resolvePath;
      await rm(join(root, "dir"));
      await rename(join(root, "moved"), join(root, "dir"));
    }
  });

  it.runIf(process.platform === "darwin")("on macOS, follows no link put in the path between the last check and the open", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(base);
    const root = join(base, "ws");
    await mkdir(join(root, "dir"), { recursive: true });
    await mkdir(join(base, "outside"));
    await writeFile(join(root, "dir", "f.txt"), "checked");
    await writeFile(join(base, "outside", "f.txt"), "outside");
    const runtime = await FileRuntime.create({ root });
    const resolvePath = runtime.resolvePath.bind(runtime);
    // The second check is the last before the open: for a read, of the path
    // with its links resolved; for a write, of the folder the temporary is
    // created in.
    const swapAtSecondCheck = () => {
      let checks = 0;
      runtime.resolvePath = async (...args: Parameters<typeof resolvePath>) => {
        const resolved = await resolvePath(...args);
        checks += 1;
        if (checks === 2) {
          await rename(join(root, "dir"), join(root, "moved"));
          await symlink(join(base, "outside"), join(root, "dir"));
        }
        return resolved;
      };
    };
    const restore = async () => {
      runtime.resolvePath = resolvePath;
      await rm(join(root, "dir"));
      await rename(join(root, "moved"), join(root, "dir"));
    };
    swapAtSecondCheck();
    await expect(
      runtime.execute(FileOperationSchema.parse({ kind: "file", action: "read", path: "dir/f.txt" })),
    ).rejects.toThrow("path_changed");
    await restore();
    swapAtSecondCheck();
    await expect(
      runtime.execute(FileOperationSchema.parse({ kind: "file", action: "write", path: "dir/new.txt", content: "x" })),
    ).rejects.toThrow("path_changed");
    await restore();
    expect(await readdir(join(base, "outside"))).toEqual(["f.txt"]);
  });

  it("leaves no temporary copy behind when a write cannot land", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-file-"));
    roots.push(root);
    const runtime = await FileRuntime.create({ root });
    await mkdir(join(root, "dir"));
    await expect(
      runtime.execute(
        FileOperationSchema.parse({ kind: "file", action: "write", path: "dir", content: "API_KEY=secret" }),
      ),
    ).rejects.toThrow();
    expect((await readdir(root)).filter((name) => name.includes(".melra-"))).toEqual([]);
  });

  it("keeps every operation away from the files MELRA holds locked", async () => {
    // `serve` started from home has the data directory inside its workspace.
    // Opening and closing one of these in the server's process would drop its
    // POSIX locks on it, so even a read is refused.
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    const data = join(root, ".melra");
    await mkdir(join(data, "melra.sqlite-owners"), { recursive: true });
    await writeFile(join(data, "melra.sqlite"), "db");
    await writeFile(join(data, "melra.sqlite-owners", "owner"), "lock");
    await writeFile(join(data, "notes.txt"), "fine");
    await symlink(data, join(root, "alias"));
    const runtime = await FileRuntime.create({
      root,
      reserved: [join(data, "melra.sqlite"), join(data, "melra.sqlite-owners")],
    });
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(FileOperationSchema.parse({ kind: "file", ...operation }));
    for (const operation of [
      { action: "read", path: ".melra/melra.sqlite" },
      { action: "hash", path: ".melra/melra.sqlite-owners/owner" },
      { action: "read", path: "alias/melra.sqlite" },
      { action: "write", path: ".melra/melra.sqlite-owners/new", content: "x" },
      { action: "move", path: ".melra/notes.txt", destination: ".melra/melra.sqlite" },
      { action: "delete", path: ".melra/melra.sqlite-owners", recursive: true },
      // The directory holding them goes with them.
      { action: "delete", path: ".melra", recursive: true },
      { action: "move", path: ".melra", destination: "elsewhere" },
    ]) {
      await expect(run(operation)).rejects.toThrow("path_reserved");
    }
    expect(await readFile(join(data, "melra.sqlite"), "utf8")).toBe("db");
    // The rest of the data directory is still an ordinary place.
    expect((await run({ action: "read", path: ".melra/notes.txt" })).content).toBe("fine");
  });

  it("answers the same for every reserved name, wherever a link inside it leads", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(base);
    const root = join(base, "workspace");
    const data = join(root, ".melra");
    await mkdir(data, { recursive: true });
    await mkdir(join(base, "outside"));
    await writeFile(join(base, "outside", "f"), "outside");
    await symlink(join(base, "outside"), join(data, "out"), "junction");
    const runtime = await FileRuntime.create({ root, reserved: [data] });
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(FileOperationSchema.parse({ kind: "file", ...operation }));
    for (const path of [".melra/out", ".melra/out/f", ".melra/out/missing", ".melra/missing"]) {
      await expect(run({ action: "stat", path }), path).rejects.toThrow("path_reserved");
      await expect(run({ action: "write", path, content: "x" }), path).rejects.toThrow("path_reserved");
    }
    expect(await readdir(join(base, "outside"))).toEqual(["f"]);
  });

  it.skipIf(process.platform === "win32")("answers the same for a link to a reserved name, whether that name exists or not", async () => {
    // A link to a missing name used to be judged by its own name and get an
    // ordinary answer, where one to a present name was refused.
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(base);
    for (const [root, data] of [
      [join(base, "in"), join(base, "in", ".melra")],
      [join(base, "out"), join(base, "out-data")],
    ] as const) {
      await mkdir(data, { recursive: true });
      await mkdir(root, { recursive: true });
      await writeFile(join(data, "melra.db"), "db");
      await writeFile(join(root, "plain.txt"), "plain");
      const runtime = await FileRuntime.create({ root, reserved: [data, join(data, "melra.db")] });
      const run = (operation: Record<string, unknown>) =>
        runtime.execute(FileOperationSchema.parse({ kind: "file", ...operation }));
      const paths: string[] = [];
      for (const name of ["missing", "melra.db"]) {
        await symlink(join(data, name), join(root, `to-${name}`));
        // Through another link, relative, with a trailing separator, and
        // climbing back out: each followed as the kernel would.
        await symlink(`./to-${name}/`, join(root, `via-${name}`));
        await symlink(join("..", basename(root), `to-${name}`), join(root, `up-${name}`));
        // Longer than the kernel follows: refused without telling where it ends.
        for (let hop = 40; hop >= 0; hop -= 1) {
          await symlink(hop === 40 ? join(data, name) : `chain-${name}-${hop + 1}`, join(root, `chain-${name}-${hop}`));
        }
        paths.push(`to-${name}`, `to-${name}/x`, `via-${name}`, `up-${name}`, `chain-${name}-0`);
      }
      for (const path of paths) {
        for (const operation of [
          { action: "stat", path },
          { action: "read", path },
          { action: "write", path, content: "x" },
          { action: "mkdir", path, recursive: true },
          { action: "delete", path },
          { action: "move", path: "plain.txt", destination: path },
        ]) {
          await expect(run(operation), JSON.stringify(operation)).rejects.toThrow("path_reserved");
        }
      }
      expect(await readdir(data)).toEqual(["melra.db"]);
      // A loop leads nowhere reserved, and stays an ordinary path.
      await symlink("loop-b", join(root, "loop-a"));
      await symlink("loop-a", join(root, "loop-b"));
      await expect(run({ action: "stat", path: "loop-a" })).resolves.toMatchObject({ type: "symlink" });
      await expect(run({ action: "delete", path: "loop-a" })).resolves.toMatchObject({ deleted: true });
    }
  });

  it("lets a directory holding a reserved file be made again, and never replaced", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    const policy = join(root, "config", "policy.json");
    await mkdir(join(root, "config"));
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await writeFile(policy, "{}");
    await writeFile(join(root, "plain.txt"), "plain");
    const runtime = await FileRuntime.create({ root, reserved: [policy] });
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(FileOperationSchema.parse({ kind: "file", ...operation }));
    // Making it again changes nothing.
    await expect(run({ action: "mkdir", path: "config", recursive: true })).resolves.toMatchObject({ created: true });
    // Nothing can be renamed onto a directory that is not empty.
    for (const operation of [
      { action: "write", path: "config", content: "x" },
      { action: "move", path: "plain.txt", destination: "config" },
      { action: "move", path: "src", destination: "config" },
    ]) {
      await expect(run(operation), JSON.stringify(operation)).rejects.toThrow();
    }
    // Moving or removing it would take the reserved file along.
    for (const operation of [
      { action: "delete", path: "config", recursive: true },
      { action: "move", path: "config", destination: "elsewhere" },
    ]) {
      await expect(run(operation), JSON.stringify(operation)).rejects.toThrow("path_reserved");
    }
    expect(await readFile(policy, "utf8")).toBe("{}");
    expect((await readdir(root)).sort()).toEqual(["config", "plain.txt", "src"]);
  });

  it("never writes into a git directory, however the path reaches it", async () => {
    // A repository's config and hooks name programs git runs during a read
    // that needs no approval; nothing the file capability writes may land there.
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "config"), "[core]\n");
    await mkdir(join(root, "vendor", "lib"), { recursive: true });
    await writeFile(join(root, "notes.txt"), "fine");
    await symlink(join(root, ".git"), join(root, "meta"));
    const runtime = await FileRuntime.create({ root });
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(FileOperationSchema.parse({ kind: "file", ...operation }));
    const caseInsensitive = await realpath(join(root, ".GIT")).then(() => true, () => false);
    for (const operation of [
      { action: "write", path: ".git/config", content: "x" },
      { action: "write", path: ".git/info/attributes", content: "x" },
      { action: "mkdir", path: ".git/hooks", recursive: true },
      { action: "write", path: "meta/config", content: "x" },
      // A nested repository, or a gitfile pointing at one.
      { action: "write", path: "vendor/lib/.git/config", content: "x" },
      { action: "write", path: "vendor/lib/.git", content: "gitdir: ../../elsewhere" },
      { action: "move", path: "notes.txt", destination: ".git/config" },
      ...(caseInsensitive ? [{ action: "write", path: ".GIT/config", content: "x" }] : []),
    ]) {
      await expect(run(operation)).rejects.toThrow("path_git_metadata");
    }
    expect(await readFile(join(root, ".git", "config"), "utf8")).toBe("[core]\n");
    // Reading it, and files that only look like it, stay ordinary.
    expect((await run({ action: "read", path: ".git/config" })).content).toBe("[core]\n");
    await run({ action: "write", path: ".gitignore", content: "dist\n" });
    await run({ action: "write", path: ".github/workflows/ci.yml", content: "on: push\n" });
    await run({ action: "write", path: ".gitattributes", content: "* text=auto\n" });
  });

  it("never changes a coding agent's own configuration, however the path reaches it", async () => {
    // A harness loads its permissions, hooks and MCP servers from these when
    // its next session starts; nothing the file capability does may change one.
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    const listed = [
      ".mcp.json",
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".vscode/settings.json",
      ".vscode/tasks.json",
      ".vscode/mcp.json",
      ".codex/config.toml",
      ".codex/managed_config.toml",
      ".codex/requirements.toml",
      ".codex/hooks.json",
      ".codex/rules/default.rules",
      // Every file in these folders is loaded, whatever its name.
      ".codex/rules/extra.rules",
      ".gemini/settings.json",
      ".cursor/mcp.json",
      // Where `melra setup` writes for the other clients, as under a home.
      "home/Library/Application Support/Claude/claude_desktop_config.json",
      "home/.codeium/windsurf/mcp_config.json",
      "home/.kiro/settings/mcp.json",
      "home/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
      "home/.config/zed/settings.json",
      "home/.config/opencode/opencode.json",
      "home/.config/goose/config.yaml",
      "home/AppData/Roaming/Block/goose/config/config.yaml",
      ".continue/mcpServers/melra.yaml",
      ".continue/mcpServers/other.yaml",
      "home/.config/amp/settings.json",
      "home/.config/amp/settings.jsonc",
      "home/.openclaw/openclaw.json",
      "home/.hermes/config.yaml",
      "home/AppData/Local/hermes/config.yaml",
      "home/.copilot/mcp-config.json",
      "home/.qwen/settings.json",
      "home/.augment/settings.json",
      "home/.warp/.mcp.json",
      "home/.junie/mcp/mcp.json",
      "home/.factory/mcp.json",
      "home/.kimi-code/mcp.json",
      "home/.config/kilo/kilo.jsonc",
      "home/.config/kilo/kilo.json",
      "home/.lmstudio/mcp.json",
      "home/.cache/lm-studio/mcp.json",
      // A nested project's own.
      "packages/app/.claude/settings.json",
    ];
    for (const path of listed) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), "{}");
    }
    await writeFile(join(root, "notes.txt"), "fine");
    await mkdir(join(root, "staged"));
    await writeFile(join(root, "staged", "settings.json"), "{}");
    await symlink(join(root, ".claude"), join(root, "harness"));
    await symlink(join(root, ".vscode", "tasks.json"), join(root, "tasks-link.json"));
    const runtime = await FileRuntime.create({ root });
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(FileOperationSchema.parse({ kind: "file", ...operation }));
    for (const path of listed) {
      for (const operation of [
        { action: "write", path, content: "x" },
        { action: "mkdir", path, recursive: true },
        { action: "delete", path },
        { action: "move", path, destination: "moved.json" },
        { action: "move", path: "notes.txt", destination: path },
      ]) {
        await expect(run(operation), JSON.stringify(operation)).rejects.toThrow("path_harness_config");
      }
    }
    for (const operation of [
      // The folder one sits in, removed or moved whole, or moved into place.
      { action: "delete", path: ".claude", recursive: true },
      { action: "move", path: ".vscode", destination: "old-vscode" },
      { action: "move", path: "staged", destination: "packages/web/.claude" },
      { action: "move", path: "staged", destination: "home/.config/opencode" },
      { action: "delete", path: ".codex/rules", recursive: true },
      { action: "delete", path: "home/.config/zed", recursive: true },
      // The folder a one-name entry sits in, where its client keeps it.
      { action: "delete", path: "home/.openclaw", recursive: true },
      { action: "move", path: "home/.config/kilo", destination: "gone-kilo" },
      { action: "delete", path: "home/Library/Application Support/Claude", recursive: true },
      // Through a link to the folder or to the file, and in another case,
      // which a case-insensitive filesystem opens as the same file.
      { action: "write", path: "harness/settings.json", content: "x" },
      { action: "write", path: "tasks-link.json", content: "x" },
      { action: "write", path: ".Claude/Settings.JSON", content: "x" },
      { action: "write", path: ".VSCODE/tasks.json", content: "x" },
    ]) {
      await expect(run(operation), JSON.stringify(operation)).rejects.toThrow("path_harness_config");
    }
    if (process.platform !== "win32") {
      // A link to a folder that does not exist yet is judged where it leads.
      await symlink(join(root, "packages", "web", ".gemini"), join(root, "planned"));
      await expect(run({ action: "write", path: "planned/settings.json", content: "x" })).rejects.toThrow(
        "path_harness_config",
      );
    }
    // The refusal names the file and says where to change it.
    await expect(run({ action: "write", path: ".mcp.json", content: "x" })).rejects.toThrow(
      /^path_harness_config: \.mcp\.json .*edit it yourself, outside the agent$/,
    );
    // Rooted where unsafe-local mode roots it, the same: this is not policy.
    const unconfined = await FileRuntime.create({ root: parse(root).root });
    await expect(
      unconfined.execute(
        FileOperationSchema.parse({ kind: "file", action: "write", path: join(root, ".claude", "settings.json"), content: "x" }),
      ),
    ).rejects.toThrow("path_harness_config");
    for (const path of listed) expect(await readFile(join(root, path), "utf8"), path).toBe("{}");
    // Reading them stays ordinary, and so do files and folders that only look like them.
    expect((await run({ action: "read", path: ".claude/settings.json" })).content).toBe("{}");
    expect((await run({ action: "hash", path: "harness/settings.json" })).size).toBe(2);
    await run({ action: "stat", path: ".mcp.json" });
    await run({ action: "list", path: ".vscode" });
    await run({ action: "write", path: ".claude/agents/reviewer.md", content: "x" });
    await run({ action: "move", path: ".claude/agents", destination: ".claude/reviewers" });
    await run({ action: "mkdir", path: ".cursor/rules", recursive: true });
    await run({ action: "write", path: ".claude/settings.json.bak", content: "{}" });
    await run({ action: "write", path: "settings.json", content: "{}" });
    await run({ action: "write", path: ".vscode/launch.json", content: "{}" });
    await run({ action: "write", path: "docs/example.mcp.json", content: "{}" });
    await run({ action: "write", path: "config.toml", content: "" });
    // A client's folder name under any other parent is not that client's.
    await run({ action: "write", path: "assets/zed/settings.json", content: "{}" });
    await run({ action: "write", path: "fixtures/goose/config.yaml", content: "" });
    await run({ action: "mkdir", path: "src/amp", recursive: true });
    await run({ action: "delete", path: "src/amp", recursive: true });
    await run({ action: "mkdir", path: "node_modules/.cache/lm-tools", recursive: true });
    await run({ action: "delete", path: "node_modules/.cache", recursive: true });
    await run({ action: "delete", path: "staged", recursive: true });
  });

  it("follows a link from a listed name back to where it leads", async () => {
    // A listed name at the root or in the home folder that is a link: where it
    // leads is the harness's configuration too, under another name.
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    await mkdir(join(root, "shared", "claude", "agents"), { recursive: true });
    await writeFile(join(root, "shared", "claude", "settings.json"), "{}");
    await symlink(join(root, "shared", "claude"), join(root, ".claude"));
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", "mcp.json"), "{}");
    await symlink(join(root, "config", "mcp.json"), join(root, ".mcp.json"));
    // A home whose settings folders a dotfile manager links elsewhere.
    const home = join(root, "home");
    await mkdir(join(home, "dotfiles", "claude"), { recursive: true });
    await writeFile(join(home, "dotfiles", "claude", "settings.json"), "{}");
    await symlink(join(home, "dotfiles", "claude"), join(home, ".claude"));
    await mkdir(join(home, "dotfiles", "config", "zed"), { recursive: true });
    await writeFile(join(home, "dotfiles", "config", "zed", "settings.json"), "{}");
    await symlink(join(home, "dotfiles", "config"), join(home, ".config"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    try {
      const runtime = await FileRuntime.create({ root });
      const run = (operation: Record<string, unknown>) =>
        runtime.execute(FileOperationSchema.parse({ kind: "file", ...operation }));
      for (const operation of [
        { action: "write", path: "shared/claude/settings.json", content: "x" },
        { action: "delete", path: "shared/claude", recursive: true },
        { action: "move", path: "shared", destination: "elsewhere" },
        { action: "write", path: "config/mcp.json", content: "x" },
        { action: "delete", path: "config/mcp.json" },
        { action: "delete", path: "config", recursive: true },
        { action: "write", path: "home/dotfiles/claude/settings.json", content: "x" },
        { action: "write", path: "home/dotfiles/config/zed/settings.json", content: "x" },
        { action: "delete", path: "home/dotfiles", recursive: true },
      ]) {
        await expect(run(operation), JSON.stringify(operation)).rejects.toThrow("path_harness_config");
      }
      for (const path of [
        "shared/claude/settings.json",
        "config/mcp.json",
        "home/dotfiles/claude/settings.json",
        "home/dotfiles/config/zed/settings.json",
      ]) {
        expect(await readFile(join(root, path), "utf8"), path).toBe("{}");
      }
      // The rest of where they lead stays ordinary.
      await run({ action: "write", path: "shared/claude/agents/reviewer.md", content: "x" });
      await run({ action: "write", path: "config/other.json", content: "{}" });
      await run({ action: "write", path: "home/dotfiles/config/git/config", content: "" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("knows the reserved files by where they are, not how they are spelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-file-"));
    roots.push(root);
    // Named before the data directory exists, through the unresolved tmpdir
    // spelling (on macOS /var, which is really /private/var).
    const data = join(root, ".melra");
    const runtime = await FileRuntime.create({
      root,
      reserved: [join(data, "melra.sqlite"), join(data, "melra.sqlite-journal")],
    });
    await mkdir(data);
    await writeFile(join(data, "melra.sqlite"), "db");
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(FileOperationSchema.parse({ kind: "file", ...operation }));
    await expect(run({ action: "read", path: ".melra/melra.sqlite" })).rejects.toThrow("path_reserved");
    // The same file on a case-insensitive disk, and one that does not exist yet.
    await expect(run({ action: "read", path: ".melra/MELRA.sqlite" })).rejects.toThrow(/path_reserved|ENOENT/);
    await expect(
      run({ action: "write", path: ".melra/MELRA.SQLITE-JOURNAL", content: "x" }),
    ).rejects.toThrow("path_reserved");
  });

  it.skipIf(process.platform === "win32")("sees a reserved file through this process's descriptors", async () => {
    // On macOS realpath leaves /dev/fd/N as /dev/fd/<name>, and opening it
    // duplicates, then closing drops the locks on, whatever the server holds.
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    const held = join(root, "melra.sqlite");
    await writeFile(held, "db");
    const handle = await open(held, "r");
    try {
      const runtime = await FileRuntime.create({ root: "/", reserved: [held] });
      await expect(
        runtime.execute(
          FileOperationSchema.parse({ kind: "file", action: "hash", path: `/dev/fd/${handle.fd}` }),
        ),
      ).rejects.toThrow("path_reserved");
    } finally {
      await handle.close();
    }
  });

  it("sees a reserved file under another name: a hard link, or macOS's /.vol", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    const owners = join(root, ".melra", "melra.sqlite-owners");
    await mkdir(owners, { recursive: true });
    await writeFile(join(root, ".melra", "melra.sqlite"), "db");
    await writeFile(join(owners, "lock"), "lock");
    await link(join(root, ".melra", "melra.sqlite"), join(root, "copy.db"));
    await link(join(owners, "lock"), join(root, "copy.lock"));
    const runtime = await FileRuntime.create({
      root: process.platform === "darwin" ? "/" : root,
      reserved: [join(root, ".melra", "melra.sqlite"), owners],
    });
    const hash = (path: string) =>
      runtime.execute(FileOperationSchema.parse({ kind: "file", action: "hash", path }));
    await expect(hash(join(root, "copy.db"))).rejects.toThrow("path_reserved");
    await expect(hash(join(root, "copy.lock"))).rejects.toThrow("path_reserved");
    if (process.platform === "darwin") {
      const held = await stat(join(root, ".melra", "melra.sqlite"));
      await expect(hash(`/.vol/${held.dev}/${held.ino}`)).rejects.toThrow("path_reserved");
      // The reserved directory by its own inode, and a file put inside it.
      const directory = await stat(owners);
      const byInode = `/.vol/${directory.dev}/${directory.ino}`;
      await expect(
        runtime.execute(
          FileOperationSchema.parse({ kind: "file", action: "write", path: `${byInode}/planted`, content: "x" }),
        ),
      ).rejects.toThrow("path_reserved");
      await expect(
        runtime.execute(
          FileOperationSchema.parse({ kind: "file", action: "move", path: byInode, destination: join(root, "moved") }),
        ),
      ).rejects.toThrow("path_reserved");
      // A directory deeper inside, whose inode is none of those compared.
      await mkdir(join(owners, "a", "b"), { recursive: true });
      const deeper = await stat(join(owners, "a", "b"));
      await expect(
        runtime.execute(
          FileOperationSchema.parse({
            kind: "file",
            action: "write",
            path: `/.vol/${deeper.dev}/${deeper.ino}/planted`,
            content: "x",
          }),
        ),
      ).rejects.toThrow("path_reserved");
      expect(await readdir(join(owners, "a", "b"))).toEqual([]);
    }
  });

  it("looks at the reserved files again on each call, so one made or replaced since is caught", async () => {
    // One look serves every check in a call; a cached look would let these by.
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    const data = join(root, "home", ".melra");
    const db = join(data, "melra.sqlite");
    const runtime = await FileRuntime.create({ root, reserved: [data, db] });
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(FileOperationSchema.parse({ kind: "file", ...operation }));
    // Each kind of look taken before the data directory, or its holder, exists.
    await mkdir(join(root, "empty"));
    await run({ action: "delete", path: "empty", recursive: true });
    await run({ action: "write", path: "early.txt", content: "x" });
    await mkdir(data, { recursive: true });
    await writeFile(db, "db");
    await link(db, join(root, "made.db"));
    await expect(run({ action: "hash", path: "made.db" })).rejects.toThrow("path_reserved");
    await expect(run({ action: "write", path: "home/.MELRA/x", content: "x" })).rejects.toThrow("path_reserved");
    await expect(run({ action: "delete", path: "home", recursive: true })).rejects.toThrow("path_reserved");
    await rm(db);
    await writeFile(db, "replaced");
    await link(db, join(root, "replaced.db"));
    await expect(run({ action: "hash", path: "replaced.db" })).rejects.toThrow("path_reserved");
  });

  it("folds a reserved name the way a case-insensitive disk does", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    await mkdir(join(root, ".melra"));
    const runtime = await FileRuntime.create({
      root,
      reserved: [join(root, ".melra", "melra.sqlite-journal")],
    });
    // U+017F, the long s, is "s" to APFS but unchanged by toLowerCase.
    await expect(
      runtime.execute(
        FileOperationSchema.parse({
          kind: "file",
          action: "write",
          path: ".melra/melra.\u017Fqlite-journal",
          content: "x",
        }),
      ),
    ).rejects.toThrow("path_reserved");
  });

  it("knows a directory that holds a reserved file, by identity", async () => {
    // What a recursive reader given that directory reaches without naming the file.
    const base = await mkdtemp(join(tmpdir(), "melra-file-"));
    roots.push(base);
    const home = join(base, "home");
    const data = join(home, ".melra");
    const root = join(home, "proj");
    await mkdir(data, { recursive: true });
    await mkdir(root);
    await mkdir(join(base, "other"));
    await writeFile(join(data, "payload.key"), "secret");
    await symlink(home, join(root, "up"), "junction");
    const runtime = await FileRuntime.create({ root, reserved: [join(data, "payload.key")] });
    for (const holder of [data, home, base, parse(base).root, join(root, "up")]) {
      expect(await runtime.holdsReserved(holder), holder).toBe(true);
    }
    for (const other of [root, join(data, "payload.key"), join(base, "other"), join(base, "missing")]) {
      expect(await runtime.holdsReserved(other), other).toBe(false);
    }
    // The identity walk goes root first and stops where the path stops existing.
    expect(await runtime.isReserved(join(base, ...Array.from({ length: 500 }, () => "a")))).toBe(false);
    expect(await runtime.isReserved(join(data, "payload.key", "x"))).toBe(true);
  });

  it("finds where a deep path stops existing in a few lookups, and still follows a link there", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    const data = join(root, ".melra");
    await mkdir(join(data, "a", "b"), { recursive: true });
    const deep = join(root, ...Array.from({ length: 300 }, () => "d"));
    await mkdir(deep, { recursive: true });
    // Two levels inside the reserved directory: no name or identity on the
    // spelled path matches, only where the link leads does.
    await symlink(join(data, "a", "b"), join(deep, "link"), "junction");
    const runtime = await FileRuntime.create({ root, reserved: [data] });
    const before = lookups.realpath;
    expect(await runtime.isReserved(join(deep, "link", "missing", "x"))).toBe(true);
    expect(await runtime.isReserved(join(deep, "missing", "x"))).toBe(false);
    // One per part was 600 here, and quadratic in the depth.
    expect(lookups.realpath - before).toBeLessThan(40);
  });

  it("judges a deep path once", async () => {
    // Judging it again after resolving its links repeated the first judgement,
    // one identity lookup per part, twice.
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    await mkdir(join(root, ".melra"));
    const deep = join(...Array.from({ length: 300 }, () => "d"));
    await mkdir(join(root, deep), { recursive: true });
    await writeFile(join(root, deep, "f"), "x");
    const runtime = await FileRuntime.create({ root, reserved: [join(root, ".melra")] });
    const before = lookups.stat;
    await runtime.execute(FileOperationSchema.parse({ kind: "file", action: "stat", path: join(deep, "f") }));
    expect(lookups.stat - before).toBeLessThan(450);
  });

  it.skipIf(process.platform === "win32")("judges a deep chain of links with each part looked up once", async () => {
    // Each link on the way was judged from scratch: every part looked up again,
    // and the rest of the chain followed again, once per link.
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    await mkdir(join(root, ".melra"));
    await writeFile(join(root, ".melra", "melra.db"), "db");
    const deep = join(root, ...Array.from({ length: 300 }, () => "d"));
    await mkdir(deep, { recursive: true });
    for (let hop = 39; hop >= 0; hop -= 1) {
      await symlink(join(deep, hop === 39 ? "missing" : `link-${hop + 1}`), join(deep, `link-${hop}`));
    }
    const runtime = await FileRuntime.create({ root, reserved: [join(root, ".melra"), join(root, ".melra", "melra.db")] });
    const [stats, links] = [lookups.stat, lookups.realpath];
    expect(await runtime.isReserved(join(deep, "link-0", "x"))).toBe(false);
    expect(lookups.stat - stats).toBeLessThan(1_000);
    expect(lookups.realpath - links).toBeLessThan(100);
  });

  it("knows a directory holds a reserved file before that file's directory exists", async () => {
    // As `melra doctor` asks it, before the first start: a link spells the way there.
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(base);
    await mkdir(join(base, "real", "home"), { recursive: true });
    await mkdir(join(base, "links"));
    await symlink(join(base, "real", "home"), join(base, "links", "home"), "junction");
    const runtime = await FileRuntime.create({
      root: base,
      reserved: [join(base, "links", "home", ".melra", "payload.key")],
    });
    expect(await runtime.holdsReserved(join(base, "real"))).toBe(true);
    if (process.platform === "darwin") {
      // The data volume, mounted whole, holds what its firmlinks hold.
      for (const holder of ["/System/Volumes/Data", "/System/Volumes", "/System"]) {
        expect(await runtime.holdsReserved(holder), holder).toBe(true);
      }
    }
  });

  it.skipIf(process.platform !== "darwin")("sees a reserved file through a macOS firmlink", async () => {
    // /System/Volumes/Data/<path> is the same directory as <path>, and realpath
    // keeps whichever spelling it was given.
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-file-")));
    roots.push(root);
    await writeFile(join(root, "payload.key"), "secret");
    const runtime = await FileRuntime.create({ root: "/", reserved: [join(root, "payload.key")] });
    await expect(
      runtime.execute(
        FileOperationSchema.parse({
          kind: "file",
          action: "read",
          path: join("/System/Volumes/Data", root, "payload.key"),
        }),
      ),
    ).rejects.toThrow("path_reserved");
  });

  it("blocks traversal and escaping symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-file-"));
    const outside = await mkdtemp(join(tmpdir(), "melra-outside-"));
    roots.push(root, outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "escape"));
    const runtime = await FileRuntime.create({ root });
    await expect(
      runtime.execute(
        FileOperationSchema.parse({
          kind: "file",
          action: "read",
          path: "../secret.txt",
        }),
      ),
    ).rejects.toThrow("path_outside_workspace");
    await expect(
      runtime.execute(
        FileOperationSchema.parse({
          kind: "file",
          action: "read",
          path: "escape/secret.txt",
        }),
      ),
    ).rejects.toThrow("path_outside_workspace");
  });

  it("writes base64 only when it is base64, and nothing when it is not", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-file-"));
    roots.push(root);
    const runtime = await FileRuntime.create({ root });
    const write = (path: string, content: string) =>
      runtime.execute(FileOperationSchema.parse({ kind: "file", action: "write", path, content, encoding: "base64" }));
    // Two chunks joined, text that is not base64, nothing decodable, and one
    // whose last character carries bits a real encoder never sets.
    for (const [index, content] of ["aGVsbG8=d29ybGQ=", "plain text, not encoded", "!!!!", "QR=="].entries()) {
      await expect(write(`bad-${index}.bin`, content), content).rejects.toThrow("file_content_invalid_base64");
    }
    expect(await readdir(root)).toEqual([]);
    // Wrapped as MIME wraps it, unpadded, or URL-safe, it is still base64.
    await write("wrapped.txt", "aGVs\nbG8=");
    await write("unpadded.txt", "aGk");
    await write("url-safe.bin", Buffer.from([0xfb, 0xff]).toString("base64url"));
    expect([...(await readFile(join(root, "url-safe.bin")))]).toEqual([0xfb, 0xff]);
    expect(await readFile(join(root, "wrapped.txt"), "utf8")).toBe("hello");
    expect(await readFile(join(root, "unpadded.txt"), "utf8")).toBe("hi");
  });

  it.skipIf(process.platform === "win32")("writes through a symlink in the workspace, and refuses a dangling one", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-file-"));
    roots.push(root);
    await mkdir(join(root, "configs"));
    await writeFile(join(root, "configs", "dev.json"), "orig");
    await chmod(join(root, "configs", "dev.json"), 0o600);
    await symlink(join("configs", "dev.json"), join(root, "config.json"));
    const runtime = await FileRuntime.create({ root });
    await runtime.execute(FileOperationSchema.parse({ kind: "file", action: "write", path: "config.json", content: "new" }));
    // The link survives and its target gets the content, keeping its mode. It
    // used to be replaced by a plain file, the target keeping "orig".
    expect((await lstat(join(root, "config.json"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(root, "configs", "dev.json"), "utf8")).toBe("new");
    expect((await stat(join(root, "configs", "dev.json"))).mode & 0o777).toBe(0o600);
    // Checked as the link is when written, not as it was when first resolved:
    // swapped for one into .git meanwhile, the write is refused.
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "orig");
    await symlink(join(".git", "config"), join(root, "swap"));
    await writeFile(join(root, "plain.txt"), "plain");
    const resolvePath = runtime.resolvePath.bind(runtime);
    let swapped = false;
    runtime.resolvePath = async (...args: Parameters<typeof resolvePath>) => {
      const resolved = await resolvePath(...args);
      if (!swapped) {
        swapped = true;
        await rename(join(root, "swap"), join(root, "plain.txt"));
      }
      return resolved;
    };
    await expect(
      runtime.execute(FileOperationSchema.parse({ kind: "file", action: "write", path: "plain.txt", content: "x" })),
    ).rejects.toThrow("path_git_metadata");
    expect(await readFile(join(root, ".git", "config"), "utf8")).toBe("orig");
    runtime.resolvePath = resolvePath;
    // A dangling link has no target to check, wherever it points.
    await symlink(join(tmpdir(), "melra-nowhere", "x"), join(root, "dangling.json"));
    await expect(
      runtime.execute(FileOperationSchema.parse({ kind: "file", action: "write", path: "dangling.json", content: "x" })),
    ).rejects.toThrow("file_write_dangling_symlink");
  });

  it("lists the root however it is spelled, and nothing else takes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-file-"));
    roots.push(root);
    await mkdir(join(root, "sub"));
    const runtime = await FileRuntime.create({ root });
    // The absolute spelling as the runtime resolved its root (macOS's tmpdir
    // is behind a /var -> /private/var link).
    for (const path of [".", "./", "sub/..", await realpath(root)]) {
      const listed = await runtime.execute(FileOperationSchema.parse({ kind: "file", action: "list", path }));
      expect(listed, path).toMatchObject({ path: ".", entries: [{ name: "sub", type: "directory" }] });
    }
    await expect(
      runtime.execute(FileOperationSchema.parse({ kind: "file", action: "delete", path: "./", recursive: true })),
    ).rejects.toThrow("path_outside_workspace");
  });

  it("accepts absolute paths spelled through the configured workspace link", async () => {
    const base = await mkdtemp(join(tmpdir(), "melra-file-"));
    roots.push(base);
    const root = join(base, "workspace");
    const linked = join(base, "workspace-link");
    await mkdir(join(root, "sub"), { recursive: true });
    await symlink(root, linked, process.platform === "win32" ? "junction" : "dir");
    const runtime = await FileRuntime.create({ root: linked });
    const source = join(linked, "source.txt");
    const destination = join(linked, "sub", "moved.txt");

    await expect(
      runtime.execute(FileOperationSchema.parse({ kind: "file", action: "list", path: linked })),
    ).resolves.toMatchObject({ path: ".", entries: [{ name: "sub", type: "directory" }] });
    await runtime.execute(FileOperationSchema.parse({ kind: "file", action: "write", path: source, content: "linked" }));
    await runtime.execute(FileOperationSchema.parse({ kind: "file", action: "move", path: source, destination }));

    expect(await readFile(join(root, "sub", "moved.txt"), "utf8")).toBe("linked");

    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "protected");
    await writeFile(join(root, "plain.txt"), "plain");
    await symlink(join(linked, ".git", "config"), join(root, "swap"));
    const resolvePath = runtime.resolvePath.bind(runtime);
    let swapped = false;
    runtime.resolvePath = async (...args: Parameters<typeof resolvePath>) => {
      const resolved = await resolvePath(...args);
      if (!swapped) {
        swapped = true;
        await rename(join(root, "swap"), join(root, "plain.txt"));
      }
      return resolved;
    };
    await expect(
      runtime.execute(
        FileOperationSchema.parse({ kind: "file", action: "write", path: join(linked, "plain.txt"), content: "x" }),
      ),
    ).rejects.toThrow("path_git_metadata");
    expect(await readFile(join(root, ".git", "config"), "utf8")).toBe("protected");
  });

  it("keeps a path spelled through the configured root confined", async () => {
    // Reached through a directory link above it, as macOS's /tmp is (a
    // junction on Windows), beside a real sibling whose name starts the same.
    const base = await mkdtemp(join(tmpdir(), "melra-file-"));
    roots.push(base);
    const real = join(base, "real", "ws");
    await mkdir(join(base, "real", "ws-evil"), { recursive: true });
    await mkdir(real);
    await writeFile(join(base, "real", "ws-evil", "secret.txt"), "secret");
    const link = process.platform === "win32" ? "junction" : "dir";
    await symlink(join(base, "real"), join(base, "alias"), link);
    await symlink(join(base, "real", "ws-evil"), join(real, "escape"), link);
    const configured = join(base, "alias", "ws");
    const runtime = await FileRuntime.create({ root: configured });
    const file = (action: "read" | "write" | "delete", path: string) =>
      runtime.execute(
        FileOperationSchema.parse({ kind: "file", action, path, ...(action === "write" ? { content: "x" } : {}) }),
      );

    await file("write", join(configured, "a.txt"));
    expect(await readFile(join(real, "a.txt"), "utf8")).toBe("x");
    for (const path of [join(`${configured}-evil`, "secret.txt"), join(configured, "escape", "secret.txt")]) {
      for (const action of ["read", "write", "delete"] as const) {
        await expect(file(action, path)).rejects.toThrow("path_outside_workspace");
      }
    }
    await expect(file("delete", configured)).rejects.toThrow("path_outside_workspace");
    await expect(
      runtime.execute(
        FileOperationSchema.parse({
          kind: "file",
          action: "move",
          path: join(configured, "a.txt"),
          destination: join(`${configured}-evil`, "a.txt"),
        }),
      ),
    ).rejects.toThrow("path_outside_workspace");
    expect(await readFile(join(base, "real", "ws-evil", "secret.txt"), "utf8")).toBe("secret");
    expect(await readFile(join(real, "a.txt"), "utf8")).toBe("x");
  });

  it("creates a missing root but accepts one it cannot create", async () => {
    // A workspace the user has not made yet is created for them.
    const parent = await mkdtemp(join(tmpdir(), "melra-file-"));
    roots.push(parent);
    const nested = join(parent, "workspace", "inner");
    expect((await FileRuntime.create({ root: nested })).root).toBe(
      await realpath(nested),
    );

    // Unhinged mode roots this runtime at the filesystem root. That directory
    // always exists, but Windows answers `mkdir C:\` with EPERM instead of the
    // no-op POSIX gives for an existing directory, so `create` must not ask.
    const driveRoot = parse(tmpdir()).root;
    expect((await FileRuntime.create({ root: driveRoot })).root).toBe(
      await realpath(driveRoot),
    );
  });
});
