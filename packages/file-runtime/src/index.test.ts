// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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
    }
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
    // A root given through a link, as MELRA reports it: macOS's tmpdir is
    // behind /var -> /private/var, and a junction needs no privilege on Windows.
    const alias = `${root}-alias`;
    roots.push(alias);
    await symlink(root, alias, "junction");
    for (const given of [root, alias]) {
      const runtime = await FileRuntime.create({ root: given });
      for (const path of [".", "./", "sub/..", given, `${given}/`, await realpath(root)]) {
        const listed = await runtime.execute(FileOperationSchema.parse({ kind: "file", action: "list", path }));
        expect(listed, path).toMatchObject({ path: ".", entries: [{ name: "sub", type: "directory" }] });
      }
      await expect(
        runtime.execute(FileOperationSchema.parse({ kind: "file", action: "delete", path: given, recursive: true })),
      ).rejects.toThrow("path_outside_workspace");
    }
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
