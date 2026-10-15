// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileOperationSchema } from "@melra/protocol";
import { FileRuntime } from "./index.js";

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
    ]) {
      await expect(run(operation)).rejects.toThrow("path_reserved");
    }
    expect(await readFile(join(data, "melra.sqlite"), "utf8")).toBe("db");
    // The rest of the data directory is still an ordinary place.
    expect((await run({ action: "read", path: ".melra/notes.txt" })).content).toBe("fine");
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
