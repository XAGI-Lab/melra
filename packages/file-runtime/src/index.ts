// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileOperation } from "@melra/protocol";

export interface FileRuntimeOptions {
  root: string;
  maxFileBytes?: number;
  maxEntries?: number;
  /**
   * Files and directories no operation may reach, even inside the root: the
   * ones MELRA itself holds open or locked. Opening and closing one of those in
   * this process would drop this process's POSIX locks on it. Recognised by
   * the identity of the directory holding them and a case-insensitive name,
   * not by spelling, so a firmlink, a bind mount or a case variant of that
   * directory still reaches the same refusal.
   */
  reserved?: string[];
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** A name as a case-insensitive filesystem, or Windows' trailing-dot rule, sees it. */
function spelling(name: string): string {
  const lower = name.toLowerCase();
  return process.platform === "win32" ? lower.replace(/[. ]+$/, "") : lower;
}

async function sameEntry(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([stat(left, { bigint: true }), stat(right, { bigint: true })]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

export class FileRuntime {
  readonly root: string;
  readonly maxFileBytes: number;
  readonly maxEntries: number;
  private readonly reserved: string[];

  private constructor(options: FileRuntimeOptions, root: string) {
    this.root = root;
    this.reserved = (options.reserved ?? []).map((path) => resolve(path));
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 1_000;
  }

  static async create(options: FileRuntimeOptions): Promise<FileRuntime> {
    // A workspace that does not exist yet is created for the caller. A drive
    // root already exists, and Windows answers `mkdir C:\` with EPERM instead
    // of the no-op POSIX gives for an existing directory — which is exactly
    // where unhinged mode roots this runtime. Only create what is missing.
    const exists = await stat(options.root).then(
      (entry) => entry.isDirectory(),
      () => false,
    );
    if (!exists) await mkdir(options.root, { recursive: true });
    return new FileRuntime(options, await realpath(options.root));
  }

  async resolvePath(input: string, allowRoot = false): Promise<string> {
    const lexical = resolve(this.root, input);
    // "Is it the root" asked the way `inside` asks "is it within": through
    // `relative`, which ignores case on Windows. A string compare let `..\\WS`
    // past it for a root spelled `ws`, and a recursive delete took everything.
    if (!inside(this.root, lexical) || (!allowRoot && relative(this.root, lexical) === "")) {
      throw new Error("path_outside_workspace");
    }

    let probe = lexical;
    let real = lexical;
    while (true) {
      try {
        const actual = await realpath(probe);
        if (!inside(this.root, actual)) {
          throw new Error("path_outside_workspace");
        }
        real = join(actual, relative(probe, lexical));
        break;
      } catch (error) {
        if (error instanceof Error && error.message === "path_outside_workspace") {
          throw error;
        }
        const parent = dirname(probe);
        if (parent === probe) throw new Error("path_outside_workspace");
        probe = parent;
      }
    }
    if (await this.isReserved(real)) throw new Error("path_reserved");
    return lexical;
  }

  /** Whether `path` is, or is inside, one of the reserved entries. */
  async isReserved(path: string): Promise<boolean> {
    for (let current = resolve(path); ; current = dirname(current)) {
      const name = spelling(basename(current));
      for (const entry of this.reserved) {
        // Only a matching name costs a stat, so ordinary paths cost nothing.
        if (spelling(basename(entry)) === name && (await sameEntry(dirname(current), dirname(entry)))) {
          return true;
        }
      }
      if (dirname(current) === current) return false;
    }
  }

  async execute(operation: FileOperation): Promise<Record<string, unknown>> {
    const path = await this.resolvePath(
      operation.path,
      operation.action === "list" && operation.path === ".",
    );
    switch (operation.action) {
      case "list": {
        const entries = await readdir(path, { withFileTypes: true });
        const truncated = entries.length > this.maxEntries;
        return {
          path: relative(this.root, path) || ".",
          entries: entries.slice(0, this.maxEntries).map((entry) => ({
            name: entry.name,
            type: entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : entry.isSymbolicLink()
                  ? "symlink"
                  : "other",
          })),
          truncated,
        };
      }
      case "read": {
        const metadata = await stat(path);
        if (!metadata.isFile()) throw new Error("file_read_requires_regular_file");
        if (metadata.size > this.maxFileBytes) throw new Error("file_size_limit_exceeded");
        const buffer = await readFile(path);
        return {
          path: relative(this.root, path),
          content:
            operation.encoding === "base64"
              ? buffer.toString("base64")
              : buffer.toString("utf8"),
          encoding: operation.encoding,
          size: buffer.byteLength,
          sha256: createHash("sha256").update(buffer).digest("hex"),
        };
      }
      case "stat": {
        const metadata = await lstat(path);
        return {
          path: relative(this.root, path),
          exists: true,
          type: metadata.isDirectory()
            ? "directory"
            : metadata.isFile()
              ? "file"
              : metadata.isSymbolicLink()
                ? "symlink"
                : "other",
          size: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
        };
      }
      case "hash": {
        // Checked before reading, as `read` does: hashing a 1.5 GB pack file
        // read it all into memory first, and a FIFO blocked forever.
        const metadata = await stat(path);
        if (!metadata.isFile()) throw new Error("file_hash_requires_regular_file");
        if (metadata.size > this.maxFileBytes) throw new Error("file_size_limit_exceeded");
        const buffer = await readFile(path);
        return {
          path: relative(this.root, path),
          size: buffer.byteLength,
          sha256: createHash("sha256").update(buffer).digest("hex"),
        };
      }
      case "write": {
        if (operation.content === undefined) throw new Error("file_write_requires_content");
        const buffer = Buffer.from(operation.content, operation.encoding);
        if (buffer.byteLength > this.maxFileBytes) throw new Error("file_size_limit_exceeded");
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.melra-${randomUUID()}.tmp`;
        await writeFile(temporary, buffer, { flag: "wx" });
        try {
          await rename(temporary, path);
        } catch (error) {
          // A rename that failed (the target is a directory, or held open on
          // Windows) would otherwise leave the content, secrets and all,
          // beside it in the workspace, one copy per retry.
          await rm(temporary, { force: true });
          throw error;
        }
        return {
          written: true,
          path: relative(this.root, path),
          size: buffer.byteLength,
          sha256: createHash("sha256").update(buffer).digest("hex"),
        };
      }
      case "move": {
        if (operation.destination === undefined) {
          throw new Error("file_move_requires_destination");
        }
        const destination = await this.resolvePath(operation.destination);
        await mkdir(dirname(destination), { recursive: true });
        await rename(path, destination);
        return {
          moved: true,
          path: relative(this.root, path),
          destination: relative(this.root, destination),
        };
      }
      case "delete":
        await rm(path, { recursive: operation.recursive, force: false });
        return { deleted: true, path: relative(this.root, path) };
      case "mkdir":
        await mkdir(path, { recursive: operation.recursive });
        return { created: true, path: relative(this.root, path) };
    }
  }
}
