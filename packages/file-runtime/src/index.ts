// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
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

/** `look`, asked once per path for as long as `answers` is kept. */
function remembered<T>(answers: Map<string, Promise<T>>, look: (at: string) => Promise<T>): (at: string) => Promise<T> {
  return (at) => {
    const answer = answers.get(at) ?? look(at);
    answers.set(at, answer);
    return answer;
  };
}

/**
 * `look`, asked once for every check made with the same `call` and again for
 * a new one; without one, every time. A caller makes a new object per call
 * and drops it when the call ends, so an answer lives no longer than that.
 */
function perCall<T>(answers: WeakMap<object, Promise<T>>, call: object | undefined, look: () => Promise<T>): Promise<T> {
  if (call === undefined) return look();
  const answer = answers.get(call) ?? look();
  answers.set(call, answer);
  return answer;
}

/** What a path is compared with: see `reservedIdentities`. */
interface ReservedIdentities {
  entries: Set<string>;
  look: (at: string) => Promise<BigIntStats | undefined>;
}

/**
 * More links than the kernel follows in one lookup (40 on Linux, 32 on
 * macOS): a path that needs them opens nothing.
 */
const MAX_LINKS = 40;

/** How many parts of a path the identity walk looks up together: most paths are no deeper. */
const CHAIN_STEP = 16;

/**
 * `real`: `path` with the deepest part of it that exists resolved through
 * links, and the rest as written. `next`: when the first part that does not
 * exist is a link, `path` with that link replaced by its target, where the
 * kernel would go on. `resolved` keeps each lookup's answer, or why it failed,
 * for the next spelling of a chain.
 */
async function realSpelling(
  path: string,
  resolved = new Map<string, Promise<string | NodeJS.ErrnoException>>(),
): Promise<{ real: string; next?: string }> {
  const resolveLinks = remembered(resolved, (at) => realpath(at).catch((error: NodeJS.ErrnoException) => error));
  const whole = await resolveLinks(path);
  if (typeof whole === "string") return { real: whole };
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
  let parent: string | undefined;
  let [resolves, fails] = [-1, chain.length - 1];
  while (fails - resolves > 1) {
    const middle = (resolves + fails) >> 1;
    const probe = chain[middle] as string;
    const actual = await resolveLinks(probe);
    if (typeof actual !== "string") fails = middle;
    else [resolves, real, parent] = [middle, join(actual, relative(probe, path)), actual];
  }
  if (parent === undefined) return { real };
  // By its bare name in its resolved directory: a trailing separator would
  // follow the link instead of naming it.
  const link = chain[fails] as string;
  const at = join(parent, basename(link));
  if ((await lstat(at).catch(() => undefined))?.isSymbolicLink() !== true) return { real };
  const target = await readlink(at).catch(() => undefined);
  if (target === undefined) return { real };
  // Joined as written, not normalised: the kernel takes a `..` in it after
  // following the links before it. ponytail: judged where it leads, not at
  // each part it passes on the way; judge those as the terminal judges its
  // arguments (`climbedFrom`) to answer the same there too.
  const joined = isAbsolute(target) ? target : `${parent}${sep}${target}`;
  const next = `${joined}${path.slice(link.length)}`;
  // Nothing through a part that does not resolve does, so the next spelling
  // need not ask again; each ask follows the rest of the chain. The target of
  // a link to a missing name is missing too; after too many links, one fewer
  // may resolve, so that is asked once.
  const failure = await resolveLinks(link);
  const missing = typeof failure !== "string" && (failure.code === "ENOENT" || failure.code === "ENOTDIR");
  const onward = missing ? failure : await resolveLinks(joined);
  if (typeof onward !== "string") {
    for (let through = next; through.length >= joined.length; through = dirname(through)) {
      resolved.set(through, Promise.resolve(onward));
      if (dirname(through) === through) break;
    }
  }
  return { real, next };
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
  private readonly identities = new WeakMap<object, Promise<ReservedIdentities>>();
  private readonly holding = new WeakMap<object, Promise<Set<string>>>();

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
   *
   * `call`, as `isReserved` takes it.
   */
  async resolvePath(
    input: string,
    allowRoot = false,
    creating = false,
    changing = creating,
    call?: object,
  ): Promise<string> {
    const lexical = resolve(this.root, input);
    // "Is it the root" asked the way `inside` asks "is it within": through
    // `relative`, which ignores case on Windows. A string compare let `..\\WS`
    // past it for a root spelled `ws`, and a recursive delete took everything.
    if (!inside(this.root, lexical) || (!allowRoot && relative(this.root, lexical) === "")) {
      throw new Error("path_outside_workspace");
    }
    // Before following links, so every reserved name gets the same answer,
    // wherever a link inside it leads. `isReserved` follows them itself, the
    // same way as below, so the path found there needs no second judgement.
    if (await this.isReserved(lexical, !changing, call)) throw new Error("path_reserved");

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
    // A directory holding reserved data takes it along when it is moved or
    // removed, so neither may happen to it. Making it again changes nothing,
    // and nothing can be renamed onto it while it holds anything.
    if (changing && !creating && (await this.holdsReserved(real, call))) throw new Error("path_reserved");
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
  private async named(
    path: string,
    entries: string[],
    known: ReservedIdentities,
    lookup: (at: string) => Promise<BigIntStats | undefined>,
  ): Promise<boolean> {
    const name = spelling(basename(path));
    for (const entry of entries) {
      // Only a matching name costs a stat, so ordinary paths cost nothing.
      if (spelling(basename(entry)) !== name) continue;
      const [a, b] = await Promise.all([lookup(dirname(path)), known.look(dirname(entry))]);
      if (a !== undefined && b !== undefined && identity(a) === identity(b)) return true;
    }
    return false;
  }

  /**
   * What `isReserved` compares a path with, as the filesystem has it now.
   * `entries`: each reserved entry and each file in a reserved directory, by
   * identity, which a hard link shares; each looked up independently of the
   * others, so all together. `look`: the same lookup, each path asked once,
   * for the directories holding them when a name matches.
   */
  private async reservedIdentities(): Promise<ReservedIdentities> {
    const look = remembered(new Map<string, Promise<BigIntStats | undefined>>(), (at) =>
      stat(at, { bigint: true }).catch(() => undefined),
    );
    const held = await Promise.all(
      this.reserved.map(async (entry) => {
        const found = await look(entry);
        if (found?.isDirectory() !== true) return [found];
        const names = await readdir(entry).catch(() => []);
        return [found, ...(await Promise.all(names.map((name) => look(join(entry, name)))))];
      }),
    );
    return { entries: new Set(held.flat().flatMap((found) => (found === undefined ? [] : [identity(found)]))), look };
  }

  /**
   * Whether `path` is, or is inside, one of the reserved entries. `reading`
   * says nothing will change it, so the contents of a readable directory are
   * judged only below that directory, where a link to reserved data is still
   * refused. Judged as spelled and again with the part that exists resolved
   * through links: a link may lead below a reserved directory, where neither
   * the names nor the identities compared here would recognise the path. A
   * link whose target does not exist is followed too, so a link to a missing
   * reserved name is refused like one to a present name.
   *
   * `call`: every check made with the same object compares with one look at
   * the reserved entries, taken at the first; a new object takes a new look,
   * so a reserved file made or replaced since is caught there. Each call
   * makes its own and drops it when it ends. Without one, each check looks.
   */
  async isReserved(path: string, reading = false, call?: object): Promise<boolean> {
    const spelled = resolve(path);
    // Each part looked up once per call: the spellings a chain of links
    // passes through share most of their parts.
    const lookup = remembered(new Map<string, Promise<BigIntStats | undefined>>(), (at) =>
      stat(at, { bigint: true }).catch(() => undefined),
    );
    const resolved = new Map<string, Promise<string | NodeJS.ErrnoException>>();
    // The same thing under another name, a hard link: so the target and each
    // directory above it are compared by identity with every reserved entry
    // and every file inside a reserved directory.
    const known = await perCall(this.identities, call, () => this.reservedIdentities());
    const judge = (at: string) => this.reservedAsSpelled(at, reading, known, lookup);
    if (await judge(spelled)) return true;
    const seen = new Set<string>();
    for (let next: string | undefined = spelled; next !== undefined && !seen.has(next); ) {
      // No lookup follows a chain this long, but the answer would still tell
      // where it ends: refused, whatever is there. ponytail: deleting or moving
      // the link itself is refused too; allowing that needs a chain to a
      // present name refused at the same length first.
      if (seen.size > MAX_LINKS) return true;
      seen.add(next);
      const step = await realSpelling(next, resolved);
      if (step.real !== spelled && (await judge(step.real))) return true;
      next = step.next;
    }
    // Every spelling on the way judged, or a loop, which opens nothing.
    return false;
  }

  private async reservedAsSpelled(
    path: string,
    reading: boolean,
    known: ReservedIdentities,
    lookup: (at: string) => Promise<BigIntStats | undefined>,
  ): Promise<boolean> {
    // A descriptor path names whatever this process has open, MELRA's locked
    // files included, and on macOS realpath leaves it under /dev/fd.
    if (process.platform !== "win32" && inside("/dev/fd", resolve(path))) return true;
    // macOS's /.vol/<dev>/<ino> names any file or directory by its inode
    // alone, so below it no name or identity compared here need match.
    if (process.platform === "darwin" && inside("/.vol", resolve(path))) return true;
    let above: string | undefined;
    for (let current = resolve(path); reading && above === undefined; current = dirname(current)) {
      if (await this.named(current, this.readable, known, lookup)) above = current;
      if (dirname(current) === current) break;
    }
    // ponytail: one stat of the path's own side per name match, so
    // `payload.key/` repeated 340 times across 98 arguments still costs about
    // 0.7 s. Ask the matches together if that ever shows up.
    for (let current = resolve(path); current !== above; current = dirname(current)) {
      if (await this.named(current, this.reserved, known, lookup)) return true;
      if (dirname(current) === current) break;
    }
    if (known.entries.size === 0) return false;
    // Root first, stopping at the first missing directory: nothing below it
    // exists, and a 4 KB argument would otherwise cost thousands of failed
    // stats. A few at a time, together, which costs at most that many more.
    const chain: string[] = [];
    for (let current = resolve(path); current !== above; current = dirname(current)) {
      chain.unshift(current);
      if (dirname(current) === current) break;
    }
    for (let start = 0; start < chain.length; start += CHAIN_STEP) {
      for (const found of await Promise.all(chain.slice(start, start + CHAIN_STEP).map((at) => lookup(at)))) {
        if (found !== undefined && known.entries.has(identity(found))) return true;
        if (found === undefined) return false;
      }
    }
    return false;
  }

  /**
   * Whether `path` is a directory holding a reserved entry at any depth: a
   * recursive reader given it reaches them unnamed. `call`, as `isReserved`
   * takes it.
   */
  async holdsReserved(path: string, call?: object): Promise<boolean> {
    const target = await stat(path, { bigint: true }).catch(() => undefined);
    if (target?.isDirectory() !== true) return false;
    return (await perCall(this.holding, call, () => this.holdingReserved())).has(identity(target));
  }

  /** The identity of each directory holding a reserved entry and of each directory above one. */
  private async holdingReserved(): Promise<Set<string>> {
    const places = new Set<string>();
    for (const holder of new Set(this.reserved.map((entry) => dirname(entry)))) {
      // Lexically and through links, so a holder under a symlinked home is
      // still found, even before the holder itself exists.
      const { real } = await realSpelling(holder);
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
          places.add(current);
          if (dirname(current) === current) break;
        }
      }
    }
    // Each place once, and all of them together: no answer depends on another.
    const found = await Promise.all([...places].map((place) => stat(place, { bigint: true }).catch(() => undefined)));
    return new Set(found.flatMap((entry) => (entry === undefined ? [] : [identity(entry)])));
  }

  async execute(operation: FileOperation): Promise<Record<string, unknown>> {
    // Every check below is made before anything changes, so one look at the
    // reserved entries serves them all.
    const call = {};
    const path = await this.resolvePath(
      this.inputPath(operation.path),
      // The root however it is spelled ("./", its absolute path), not only
      // ".": the others were refused as outside the workspace.
      operation.action === "list",
      operation.action === "write" || operation.action === "mkdir",
      !["list", "read", "stat", "hash"].includes(operation.action),
      call,
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
        if (target !== path) await this.resolvePath(target, false, true, true, call);
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
        const destination = await this.resolvePath(this.inputPath(operation.destination), false, true, true, call);
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
