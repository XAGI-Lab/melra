// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
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
  /**
   * Directories inside a reserved one whose contents may still be read
   * (`isReserved` with `reading`), recognised the same way: MELRA's artifacts.
   * Nothing may change them, or the directory itself.
   */
  readable?: string[];
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * A name as a case-insensitive filesystem, or Windows' trailing-dot rule, sees
 * it. Upper then lower is closer to the filesystem's case folding than lower
 * alone: it takes `ſ` to `s` and the Kelvin sign to `k`, as APFS does.
 */
function spelling(name: string): string {
  const lower = name.toUpperCase().toLowerCase();
  if (process.platform !== "win32") return lower;
  // A loop, not /[. ]+$/: that pattern backtracks quadratically on a long
  // run of spaces, and the name is the caller's.
  let end = lower.length;
  while (end > 0 && (lower[end - 1] === "." || lower[end - 1] === " ")) end -= 1;
  return lower.slice(0, end);
}

function identity(entry: { dev: bigint; ino: bigint }): string {
  return `${entry.dev}:${entry.ino}`;
}

async function sameEntry(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([stat(left, { bigint: true }), stat(right, { bigint: true })]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/** `path` with the deepest part of it that exists resolved through links, and the rest as written. */
async function realSpelling(path: string): Promise<string> {
  const whole = await realpath(path).catch(() => undefined);
  if (whole !== undefined) return whole;
  // A part resolves only if every part above it does, so the deepest one that
  // does is found by halving: about log2(depth) lookups, not one per part.
  // ponytail: each realpath still walks its whole prefix, so 100 arguments 300
  // parts deep cost ~1 s here (12 s at one lookup per part). Memoise resolved
  // prefixes across a call's arguments if that ever shows up.
  const chain: string[] = [];
  for (let probe = path; ; probe = dirname(probe)) {
    chain.unshift(probe);
    if (dirname(probe) === probe) break;
  }
  let real = path;
  let [resolves, fails] = [-1, chain.length - 1];
  while (fails - resolves > 1) {
    const middle = (resolves + fails) >> 1;
    const probe = chain[middle] as string;
    const actual = await realpath(probe).catch(() => undefined);
    if (actual === undefined) fails = middle;
    else [resolves, real] = [middle, join(actual, relative(probe, path))];
  }
  return real;
}

/**
 * The bytes a write's content stands for. Node's base64 decoder is lenient: it
 * stops at the first padding, skips what is not base64, and decoded two joined
 * chunks as the first, plain text as noise and "!!!!" as nothing, each written
 * as a success. So base64 is checked to be canonical first; line breaks and
 * spaces are allowed, as MIME wraps it.
 */
function decodeContent(content: string, encoding: "utf8" | "base64"): Buffer {
  if (encoding !== "base64") return Buffer.from(content, encoding);
  // The URL-safe alphabet too, which Node always decoded the same way.
  const compact = content.replace(/\s+/g, "").replaceAll("-", "+").replaceAll("_", "/");
  const decoded = Buffer.from(compact, "base64");
  const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || decoded.toString("base64") !== padded) {
    throw new Error("file_content_invalid_base64");
  }
  return decoded;
}

export class FileRuntime {
  readonly root: string;
  readonly maxFileBytes: number;
  readonly maxEntries: number;
  private readonly lexicalRoot: string;
  private readonly reserved: string[];
  private readonly readable: string[];

  private constructor(options: FileRuntimeOptions, root: string) {
    this.root = root;
    this.lexicalRoot = resolve(options.root);
    this.reserved = (options.reserved ?? []).map((path) => resolve(path));
    this.readable = (options.readable ?? []).map((path) => resolve(path));
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

  private inputPath(input: string): string {
    if (!isAbsolute(input)) return input;
    const candidate = resolve(input);
    return inside(this.lexicalRoot, candidate)
      ? resolve(this.root, relative(this.lexicalRoot, candidate))
      : input;
  }

  /**
   * `creating` refuses a path that is, or is inside, a git directory: a
   * repository's config, attributes and hooks name programs git runs while
   * serving a read that needs no approval, so content written there by an
   * innocent-looking approved write would run later with none. Judged on the
   * resolved path, by the filesystem's spelling, so a link or a case variant
   * reaches the same refusal.
   *
   * ponytail: by name, so an NTFS stream spelling of `.git` is not caught; the
   * reserved-file check has the same Windows follow-up.
   */
  async resolvePath(input: string, allowRoot = false, creating = false, changing = creating): Promise<string> {
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
    if (await this.isReserved(real, !changing)) throw new Error("path_reserved");
    // A directory holding reserved data takes it along when it is moved,
    // replaced or removed, so nothing may change it either.
    if (changing && (await this.holdsReserved(real))) throw new Error("path_reserved");
    if (creating && relative(this.root, real).split(sep).some((part) => spelling(part) === ".git")) {
      throw new Error("path_git_metadata");
    }
    return lexical;
  }

  /**
   * Whether `path` is one of `entries`: by a case-insensitive name and the
   * identity of the directory holding it. On a case-sensitive filesystem a
   * sibling whose name differs from an entry only in case, such as a twin of
   * the data directory, is matched too; that refuses more, never less.
   */
  private async named(path: string, entries: string[]): Promise<boolean> {
    const name = spelling(basename(path));
    for (const entry of entries) {
      // Only a matching name costs a stat, so ordinary paths cost nothing.
      if (spelling(basename(entry)) === name && (await sameEntry(dirname(path), dirname(entry)))) return true;
    }
    return false;
  }

  /**
   * Whether `path` is, or is inside, one of the reserved entries. `reading`
   * says nothing will change it, so the contents of a readable directory are
   * judged only below that directory, where a link to reserved data is still
   * refused. Judged as spelled and again with the part that exists resolved
   * through links: a link may lead below a reserved directory, where neither
   * the names nor the identities compared here would recognise the path.
   */
  async isReserved(path: string, reading = false): Promise<boolean> {
    const spelled = resolve(path);
    if (await this.reservedAsSpelled(spelled, reading)) return true;
    const real = await realSpelling(spelled);
    return real !== spelled && (await this.reservedAsSpelled(real, reading));
  }

  private async reservedAsSpelled(path: string, reading: boolean): Promise<boolean> {
    // A descriptor path names whatever this process has open, MELRA's locked
    // files included, and on macOS realpath leaves it under /dev/fd.
    if (process.platform !== "win32" && inside("/dev/fd", resolve(path))) return true;
    // macOS's /.vol/<dev>/<ino> names any file or directory by its inode
    // alone, so below it no name or identity compared here need match.
    if (process.platform === "darwin" && inside("/.vol", resolve(path))) return true;
    let above: string | undefined;
    for (let current = resolve(path); reading && above === undefined; current = dirname(current)) {
      if (await this.named(current, this.readable)) above = current;
      if (dirname(current) === current) break;
    }
    // ponytail: one stat per name match, so `payload.key/` repeated 340 times
    // across 100 arguments still costs about 0.9 s. Cache the reserved
    // identities if that ever shows up.
    for (let current = resolve(path); current !== above; current = dirname(current)) {
      if (await this.named(current, this.reserved)) return true;
      if (dirname(current) === current) break;
    }
    // The same thing under another name, a hard link: so the target and each
    // directory above it are compared by identity with every reserved entry
    // and every file inside a reserved directory.
    const identities = new Set<string>();
    for (const entry of this.reserved) {
      const found = await stat(entry, { bigint: true }).catch(() => undefined);
      if (found === undefined) continue;
      identities.add(identity(found));
      if (!found.isDirectory()) continue;
      for (const name of await readdir(entry).catch(() => [])) {
        const file = await stat(join(entry, name), { bigint: true }).catch(() => undefined);
        if (file !== undefined) identities.add(identity(file));
      }
    }
    if (identities.size === 0) return false;
    // Root first, stopping at the first missing directory: nothing below it
    // exists, and a 4 KB argument would otherwise cost thousands of failed stats.
    const chain: string[] = [];
    for (let current = resolve(path); current !== above; current = dirname(current)) {
      chain.unshift(current);
      if (dirname(current) === current) break;
    }
    for (const current of chain) {
      const found = await stat(current, { bigint: true }).catch(() => undefined);
      if (found !== undefined && identities.has(identity(found))) return true;
      if (found === undefined) return false;
    }
    return false;
  }

  /** Whether `path` is a directory holding a reserved entry at any depth: a recursive reader given it reaches them unnamed. */
  async holdsReserved(path: string): Promise<boolean> {
    const target = await stat(path, { bigint: true }).catch(() => undefined);
    if (target?.isDirectory() !== true) return false;
    for (const holder of new Set(this.reserved.map((entry) => dirname(entry)))) {
      // Lexically and through links, so a holder under a symlinked home is
      // still found, even before the holder itself exists.
      const real = await realSpelling(holder);
      // macOS also mounts the data volume whole at /System/Volumes/Data, so a
      // directory there, or above it, holds what a firmlinked directory such as
      // /Users or /private holds, though no `..` from those leads to it. For
      // data on another volume this may count those system directories as
      // holders too, which only refuses more.
      const firmlinked = process.platform === "darwin" ? [join("/System/Volumes/Data", real)] : [];
      // ponytail: a second bind mount of an ancestor placed inside the target
      // is on none of these chains; reading the mount table would find it.
      for (const start of new Set([holder, real, ...firmlinked])) {
        for (let current = start; ; current = dirname(current)) {
          const found = await stat(current, { bigint: true }).catch(() => undefined);
          if (found !== undefined && identity(found) === identity(target)) return true;
          if (dirname(current) === current) break;
        }
      }
    }
    return false;
  }

  async execute(operation: FileOperation): Promise<Record<string, unknown>> {
    const path = await this.resolvePath(
      this.inputPath(operation.path),
      // The root however it is spelled ("./", its absolute path), not only
      // ".": the others were refused as outside the workspace.
      operation.action === "list",
      operation.action === "write" || operation.action === "mkdir",
      !["list", "read", "stat", "hash"].includes(operation.action),
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
        const buffer = decodeContent(operation.content, operation.encoding);
        if (buffer.byteLength > this.maxFileBytes) throw new Error("file_size_limit_exceeded");
        // A link inside the workspace is written through, as `read` reads
        // through it: renaming onto the link replaced it with a plain file and
        // left its target as it was. A dangling one has no target to check.
        const target = (await lstat(path).catch(() => undefined))?.isSymbolicLink() === true
          ? await realpath(path).catch(() => {
              throw new Error("file_write_dangling_symlink");
            })
          : path;
        // Checked again as it is now, not as resolvePath found it: the link may
        // have changed since. The rename below replaces whatever is at the
        // checked target without following it.
        if (target !== path) await this.resolvePath(target, false, true);
        await mkdir(dirname(target), { recursive: true });
        // A short name beside it, not one built from it: the target's own name
        // may already be as long as the file system allows.
        const temporary = join(dirname(target), `.melra-${randomBytes(6).toString("hex")}.tmp`);
        // The file it replaces keeps its permissions: a private one stays
        // private and a script stays executable. Written private, then set
        // exactly, past the umask; the setuid, setgid and sticky bits are not
        // carried over. A new file gets the default mode, as before.
        const replaced = await stat(target).catch(() => undefined);
        const kept = replaced?.isFile() === true ? replaced.mode & 0o777 : undefined;
        // Only the exclusive create is outside the cleanup: a name already
        // taken is not ours to remove.
        const handle = await open(temporary, "wx", kept === undefined ? 0o666 : 0o600);
        try {
          try {
            await handle.writeFile(buffer);
            // Through the descriptor: nothing after the create looks the
            // name up again, so a link put in its place is never followed.
            if (kept !== undefined) await handle.chmod(kept);
          } finally {
            await handle.close();
          }
          await rename(temporary, target);
        } catch (error) {
          // A write that failed partway (a full disk), or a rename that failed
          // (the target is a directory, or held open on Windows), would
          // otherwise leave the content, secrets and all, beside it in the
          // workspace, one copy per retry.
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
        const destination = await this.resolvePath(this.inputPath(operation.destination), false, true);
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
