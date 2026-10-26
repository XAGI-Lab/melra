// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Verifier, type PredicateVerifier, type VerificationContext } from "./index.js";

// `after`, once set, runs when the first `stat` or `open` of its path returns;
// each still does the real one.
const lookups = vi.hoisted(() => ({
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
    stat: (...args: Parameters<typeof fs.stat>) => looked(args[0], fs.stat(...args)),
    open: (...args: Parameters<typeof fs.open>) => looked(args[0], fs.open(...args)),
  };
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Verifier", () => {
  it("checks structured fields and file effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-verifier-"));
    roots.push(root);
    await writeFile(join(root, "result.txt"), "verified");
    const verifier = await Verifier.create(root);
    const result = await verifier.verify(
      [
        { type: "result_equals", path: "written", value: true },
        { type: "file_exists", path: "result.txt" },
        {
          type: "file_hash",
          path: "result.txt",
          sha256: createHash("sha256").update("verified").digest("hex"),
        },
      ],
      { written: true },
    );
    expect(result.verified).toBe(true);
    expect(result.evidence.every((item) => item.passed)).toBe(true);
  });

  it("verifies absolute paths spelled through the configured workspace link", async () => {
    const base = await mkdtemp(join(tmpdir(), "melra-verifier-"));
    roots.push(base);
    const root = join(base, "workspace");
    const linked = join(base, "workspace-link");
    await mkdir(root);
    await writeFile(join(root, "result.txt"), "verified");
    await symlink(root, linked, process.platform === "win32" ? "junction" : "dir");
    const verifier = await Verifier.create(linked);
    const checked = await verifier.verify(
      [
        { type: "file_exists", path: join(linked, "result.txt") },
        {
          type: "file_hash",
          path: join(linked, "result.txt"),
          sha256: createHash("sha256").update("verified").digest("hex"),
        },
        { type: "file_absent", path: join(linked, "missing.txt") },
      ],
      {},
    );
    expect(checked.verified).toBe(true);
  });

  it("does not treat a mismatched predicate as success", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-verifier-"));
    roots.push(root);
    const verifier = await Verifier.create(root);
    const result = await verifier.verify(
      [{ type: "result_contains", path: "stdout", value: "expected" }],
      { stdout: "different" },
    );
    expect(result.verified).toBe(false);
  });

  it("verifies absence without allowing an escaping parent symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-verifier-"));
    roots.push(root);
    const verifier = await Verifier.create(root);
    const absent = await verifier.verify(
      [{ type: "file_absent", path: "deleted.txt" }],
      {},
    );
    expect(absent.verified).toBe(true);

    const escaped = await verifier.verify(
      [{ type: "file_absent", path: "../outside.txt" }],
      {},
    );
    expect(escaped.verified).toBe(false);
    expect(escaped.evidence[0]?.summary).toBe(
      "verification_path_outside_workspace",
    );
  });

  it("does not open a file MELRA holds locked", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-verifier-"));
    roots.push(root);
    await writeFile(join(root, "melra.sqlite"), "db");
    const verifier = await Verifier.create(root, {
      reserved: async (path) => path.endsWith("melra.sqlite"),
    });
    const hashed = await verifier.verify(
      [{ type: "file_hash", path: "melra.sqlite", sha256: "0".repeat(64) }],
      {},
    );
    expect(hashed.verified).toBe(false);
    expect(hashed.evidence[0]?.summary).toBe("verification_path_reserved");
  });

  it("asks every check of one predicate as one call, and none after it", async () => {
    // What a check compares with may be looked up once per call, never longer.
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-verifier-")));
    roots.push(root);
    await writeFile(join(root, "a.txt"), "a");
    const calls: Array<object | undefined> = [];
    let kept: VerificationContext | undefined;
    const keeps: PredicateVerifier<{ type: "keeps" }> = {
      type: "keeps",
      async check(_predicate, _result, context) {
        kept = context;
        return { passed: true, summary: "kept" };
      },
    };
    const verifier = await Verifier.create(root, {
      reserved: async (_path, call) => {
        calls.push(call);
        return false;
      },
      verifiers: [keeps],
    });
    const verification = async (...predicates: Parameters<Verifier["verify"]>[0]) => {
      calls.length = 0;
      await verifier.verify(predicates, {});
      return [...new Set(calls)];
    };
    const hash = { type: "file_hash", path: "a.txt", sha256: "0".repeat(64) } as const;
    const [first, second] = [await verification(hash), await verification(hash)];
    expect([first.length, second.length]).toEqual([1, 1]);
    expect(first[0]).toBeTypeOf("object");
    expect(first[0]).not.toBe(second[0]);
    expect(await verification(hash, { type: "file_absent", path: "b.txt" })).toHaveLength(2);
    // A context kept past its verification asks on its own.
    await verification({ type: "custom", verifier: "keeps", params: {} });
    await kept?.workspacePath("a.txt");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call === undefined)).toBe(true);
  });

  it("gives no answer about a reserved name, present or absent", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-verifier-")));
    roots.push(root);
    const owners = join(root, "melra.sqlite-owners");
    await mkdir(owners);
    await writeFile(join(owners, "live"), "");
    const asks: PredicateVerifier<{ type: "asks"; path: string }> = {
      type: "asks",
      async check(predicate, _result, context) {
        await context.workspacePath(predicate.path, { mayBeAbsent: true });
        return { passed: true, summary: "asked" };
      },
    };
    const verifier = await Verifier.create(root, {
      reserved: async (path) => path === owners || path.startsWith(`${owners}${sep}`),
      verifiers: [asks],
    });
    const { evidence } = await verifier.verify(
      [
        { type: "file_absent", path: "melra.sqlite-owners/live" },
        { type: "file_absent", path: "melra.sqlite-owners/gone" },
        { type: "file_exists", path: "melra.sqlite-owners/gone" },
        { type: "custom", verifier: "asks", params: { path: "melra.sqlite-owners/gone" } },
      ],
      {},
    );
    expect(evidence.map(({ summary, unanswerable }) => [summary, unanswerable ?? false])).toEqual(
      Array.from({ length: 4 }, () => ["verification_path_reserved", true]),
    );
  });

  it("answers the same for every reserved name, wherever a link inside it leads", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-verifier-")));
    roots.push(base);
    const root = join(base, "workspace");
    const data = join(root, ".melra");
    await mkdir(data, { recursive: true });
    await mkdir(join(base, "outside"));
    await writeFile(join(base, "outside", "f"), "outside");
    await symlink(join(base, "outside"), join(data, "out"), "junction");
    const verifier = await Verifier.create(root, {
      reserved: async (path) => path === data || path.startsWith(`${data}${sep}`),
    });
    const { evidence } = await verifier.verify(
      [".melra/out/f", ".melra/out/missing", ".melra/missing"].flatMap((path) => [
        { type: "file_exists", path },
        { type: "file_absent", path },
      ]),
      {},
    );
    expect(evidence.map(({ summary }) => summary)).toEqual(
      Array.from({ length: 6 }, () => "verification_path_reserved"),
    );
  });

  it("gives the same refusal, present or absent, for a name a link leads out to", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-verifier-")));
    roots.push(base);
    const root = join(base, "workspace");
    const data = join(base, "data");
    await mkdir(root);
    await mkdir(data);
    await symlink(data, join(root, "linked"));
    const verifier = await Verifier.create(root, {
      reserved: async (path) => path === data || path.startsWith(`${data}${sep}`),
    });
    const ask = () =>
      verifier.verify(
        [
          { type: "file_exists", path: "linked/policy.json" },
          { type: "file_hash", path: "linked/policy.json", sha256: "0".repeat(64) },
        ],
        {},
      );
    await writeFile(join(data, "policy.json"), "{}");
    const present = await ask();
    await rm(join(data, "policy.json"));
    const absent = await ask();
    expect([...present.evidence, ...absent.evidence].map(({ summary }) => summary)).toEqual(
      Array.from({ length: 4 }, () => "verification_path_outside_workspace"),
    );
  });

  it("answers a missing file as no, not as no answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-verifier-"));
    roots.push(root);
    await mkdir(join(root, "dir"));
    const verifier = await Verifier.create(root);
    const { evidence } = await verifier.verify(
      [
        { type: "file_exists", path: "missing.txt" },
        { type: "file_hash", path: "missing.txt", sha256: "0".repeat(64) },
        { type: "file_hash", path: "dir", sha256: "0".repeat(64) },
      ],
      {},
    );
    // Read as inconclusive, a reconciliation or a condition waiting on that
    // file would never decide.
    expect(evidence.map(({ passed, inconclusive }) => [passed, inconclusive ?? false])).toEqual([
      [false, false],
      [false, false],
      [false, false],
    ]);
  });

  it("marks only the kernel's own refusals as unanswerable", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-verifier-"));
    roots.push(root);
    await writeFile(join(root, "melra.sqlite"), "db");
    const http = { type: "http_resource_matches", method: "GET", path: "status", value: 200, timeoutMs: 1_000 };
    const verifier = await Verifier.create(root, {
      probe: async () => ({ status: 200 }),
      reserved: async (path) => path.endsWith("melra.sqlite"),
      verifiers: [
        {
          type: "mimic",
          async check() {
            throw new Error("verification_path_outside_workspace");
          },
        },
        {
          type: "claims",
          async check() {
            return { passed: false, summary: "no", unanswerable: true };
          },
        },
      ],
    });
    const { evidence } = await verifier.verify(
      [
        { type: "file_exists", path: "../release.flag" },
        { type: "file_absent", path: "." },
        { type: "file_hash", path: "melra.sqlite", sha256: "0".repeat(64) },
        { ...http, url: "https://files.example.test/{{fileId}}" },
        { ...http, url: "https://files.example.test/{{dir}}" },
        { type: "nobody_knows" },
        { type: "mimic" },
        { type: "claims" },
      ],
      { dir: ".." },
    );
    const { evidence: unprobed } = await (await Verifier.create(root)).verify(
      [{ ...http, url: "https://files.example.test/x" }],
      {},
    );
    // Told apart by the flag, never the summary: a verifier's own failure
    // can say anything, and is no answer for now rather than for good.
    expect(
      [...evidence, ...unprobed].map((item) => [item.summary, item.inconclusive ?? false, item.unanswerable ?? false]),
    ).toEqual([
      ["verification_path_outside_workspace", true, true],
      ["verification_path_outside_workspace", true, true],
      ["verification_path_reserved", true, true],
      ["verification_token_unresolved:fileId", true, true],
      ["verification_token_dot_segment:dir", true, true],
      ["verification_unsupported:nobody_knows", true, true],
      ["verification_path_outside_workspace", true, false],
      ["no", false, false],
      ["verification_probe_unavailable", true, true],
    ]);
  });

  // POSIX only: Windows has no FIFOs.
  it.skipIf(process.platform === "win32")("never waits on a FIFO put in place of the file it checked", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-verifier-")));
    roots.push(root);
    const path = join(root, "f.txt");
    await writeFile(path, "checked");
    const verifier = await Verifier.create(root);
    // Swapped as the first lookup by name after the check returns: a stat and
    // then a stream opened by name waited on the FIFO for a writer that never
    // came. Opened once, the file checked is the one hashed. Moved aside, not
    // removed, so on Linux the descriptor's name is still in the workspace.
    lookups.after = {
      path,
      then: async () => {
        await rename(path, join(root, "aside"));
        spawnSync("mkfifo", [path]);
      },
    };
    const outcome = verifier.verify([{ type: "file_hash", path: "f.txt", sha256: "0".repeat(64) }], {});
    try {
      const settled = await Promise.race([
        outcome.then(({ evidence }) => evidence[0]?.digest),
        new Promise((resolve) => setTimeout(() => resolve("still waiting after 5 s"), 5_000)),
      ]);
      expect(settled).toBe(createHash("sha256").update("checked").digest("hex"));
    } finally {
      lookups.after = undefined;
      // Lets a reader still waiting on the FIFO go, so nothing outlives the test.
      await open(path, constants.O_WRONLY | constants.O_NONBLOCK).then((handle) => handle.close(), () => undefined);
      await outcome.catch(() => undefined);
    }
  }, 30_000);

  // POSIX only: a link needs a privilege on Windows, where nothing checks the
  // descriptor either, and there are no FIFOs.
  it.skipIf(process.platform === "win32")("judges what it opens, not a link or a FIFO put there after the check", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-verifier-")));
    roots.push(base);
    const root = join(base, "ws");
    await mkdir(join(root, "dir"), { recursive: true });
    await mkdir(join(base, "outside"));
    const path = join(root, "dir", "f.txt");
    await writeFile(join(base, "outside", "f.txt"), "outside");
    const outside = createHash("sha256").update("outside").digest("hex");
    let swap: (() => Promise<void>) | undefined;
    let checks = 0;
    const verifier = await Verifier.create(root, {
      // The third is the last check by name: the path as spelled, the part of
      // it that exists, then the path resolved through links.
      reserved: async () => {
        checks += 1;
        if (checks === 3) await swap?.();
        return false;
      },
    });
    const swaps: Record<string, [() => Promise<void>, string]> = {
      // Opened through the link, the file outside was hashed, and matched.
      link: [
        async () => {
          await rename(join(root, "dir"), join(root, "moved"));
          await symlink(join(base, "outside"), join(root, "dir"));
        },
        "verification_path_outside_workspace",
      ],
      fifo: [
        async () => {
          await rm(path);
          spawnSync("mkfifo", [path]);
        },
        "workspace path is not a regular file",
      ],
    };
    for (const [name, [then, summary]] of Object.entries(swaps)) {
      await rm(join(root, "dir"), { recursive: true, force: true });
      await rm(join(root, "moved"), { recursive: true, force: true });
      await mkdir(join(root, "dir"));
      await writeFile(path, "checked");
      [swap, checks] = [then, 0];
      const { evidence } = await verifier.verify([{ type: "file_hash", path: "dir/f.txt", sha256: outside }], {});
      expect(evidence[0], name).toMatchObject({ passed: false, summary });
    }
  });

  // POSIX only: no Unix socket in the Windows file system.
  it.skipIf(process.platform === "win32")("fails file_hash of a Unix socket as not a regular file, not inconclusive", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-verifier-")));
    roots.push(root);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(join(root, "s.sock"), resolve));
    try {
      const verifier = await Verifier.create(root);
      const { evidence } = await verifier.verify([{ type: "file_hash", path: "s.sock", sha256: "0".repeat(64) }], {});
      // The open itself fails on a socket, and its errno read as "could not tell".
      expect(evidence[0]).toMatchObject({ passed: false, summary: "workspace path is not a regular file" });
      expect(evidence[0]?.inconclusive).toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("answers a path under a regular file as absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-verifier-"));
    roots.push(root);
    await writeFile(join(root, "build"), "a file, not a directory");
    const verifier = await Verifier.create(root);
    const { evidence } = await verifier.verify([{ type: "file_absent", path: "build/out.txt" }], {});
    // ENOTDIR: the path cannot exist, which is an answer, not a failure to ask.
    expect(evidence[0]).toMatchObject({ passed: true, summary: "workspace path is absent" });
    expect(evidence[0]?.inconclusive).toBeUndefined();
  });

  it("refuses a path the filesystem will not take whole, rather than read it as there or gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-verifier-"));
    roots.push(root);
    const verifier = await Verifier.create(root);
    const path = "a".repeat(300);
    // Where the OS says ENAMETOOLONG. The same error comes for a path past
    // PATH_MAX that does exist, so read as missing it verified a file as gone.
    if ((await lstat(join(root, path)).catch((error: NodeJS.ErrnoException) => error.code)) !== "ENAMETOOLONG") return;
    const { evidence } = await verifier.verify(
      [
        { type: "file_exists", path },
        { type: "file_absent", path },
        { type: "file_hash", path, sha256: "0".repeat(64) },
      ],
      {},
    );
    expect(evidence.map(({ passed, unanswerable, summary }) => [passed, unanswerable ?? false, summary])).toEqual([
      [false, true, "verification_path_too_long"],
      [false, true, "verification_path_too_long"],
      [false, true, "verification_path_too_long"],
    ]);
  });

  it("reads a case-only rename's old spelling as absent, and nothing else spelled differently", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-verifier-"));
    roots.push(root);
    await writeFile(join(root, "Readme.md"), "x");
    await rename(join(root, "Readme.md"), join(root, "README.md"));
    const verifier = await Verifier.create(root);
    // What a move derives, against the move's own result. On a
    // case-insensitive disk the old spelling still reached the renamed file,
    // and the move verified as partial.
    const moved = await verifier.verify(
      [
        { type: "file_absent", path: "Readme.md" },
        { type: "file_exists", path: "README.md" },
      ],
      { moved: true, path: "Readme.md", destination: "README.md" },
    );
    expect(moved.verified).toBe(true);
    // Anywhere else a path that reaches a file is that file: a guard asking
    // whether settings.json is absent beside Settings.json is told no.
    await writeFile(join(root, "Settings.json"), "{}");
    const folds = await lstat(join(root, "settings.json")).then(() => true, () => false);
    if (folds) {
      for (const result of [{}, { moved: true, path: "x", destination: "README.md" }]) {
        const guard = await verifier.verify([{ type: "file_absent", path: "settings.json" }], result);
        expect(guard.verified, JSON.stringify(result)).toBe(false);
      }
    }
    // A move rename(2) ignores, between two hard links to one file, leaves the
    // source listed: the same file as the destination, but still there.
    await writeFile(join(root, "a.txt"), "x");
    await link(join(root, "a.txt"), join(root, "b.txt"));
    const linked = await verifier.verify([{ type: "file_absent", path: "a.txt" }], {
      moved: true,
      path: "a.txt",
      destination: "b.txt",
    });
    expect(linked.verified).toBe(false);
  });

  it("reads a path as absent for a move only when it is that move's own case-renamed source", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-verifier-"));
    roots.push(root);
    await writeFile(join(root, "config.json"), "{}");
    const verifier = await Verifier.create(root);
    // A move whose destination has since gone: failing to find it made every
    // file_absent against that result pass, on any disk.
    const gone = await verifier.verify([{ type: "file_absent", path: "config.json" }], {
      moved: true,
      path: "config.json",
      destination: "gone/config.json",
    });
    expect(gone.verified).toBe(false);

    // A link renamed by case is gone under its old spelling, though what it
    // leads to is not the move's destination entry.
    await writeFile(join(root, "target.txt"), "x");
    if (await symlink("target.txt", join(root, "Link")).then(() => true, () => false)) {
      await rename(join(root, "Link"), join(root, "LINK"));
      const renamed = await verifier.verify([{ type: "file_absent", path: "Link" }], {
        moved: true,
        path: "Link",
        destination: "LINK",
      });
      expect(renamed.verified).toBe(true);
    }

    await writeFile(join(root, "Draft.md"), "x");
    await rename(join(root, "Draft.md"), join(root, "README.md"));
    if (await lstat(join(root, "readme.md")).then(() => true, () => false)) {
      // Another spelling of the destination is not the move's source.
      const variant = await verifier.verify([{ type: "file_absent", path: "readme.md" }], {
        moved: true,
        path: "Draft.md",
        destination: "README.md",
      });
      expect(variant.verified).toBe(false);
      // Nor is a hard link the move left in place, spelled in another case.
      await writeFile(join(root, "B.txt"), "x");
      await link(join(root, "B.txt"), join(root, "a.txt"));
      const linked = await verifier.verify([{ type: "file_absent", path: "b.txt" }], {
        moved: true,
        path: "b.txt",
        destination: "A.txt",
      });
      expect(linked.verified).toBe(false);
    }
  });

  it("stamps each item with how it was established", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-verifier-"));
    roots.push(root);
    await writeFile(join(root, "present.txt"), "content");
    const verifier = await Verifier.create(root);
    const { evidence } = await verifier.verify(
      [
        { type: "file_exists", path: "present.txt" },
        { type: "result_equals", path: "ok", value: true },
      ],
      { ok: true },
    );
    // Same receipt, two different claims: one re-read the disk, the other only
    // re-read what the adapter handed back.
    expect(evidence[0]?.strength).toBe("state");
    expect(evidence[1]?.strength).toBe("execution");
  });

  it("never matches an exact bytes or content on a body cut at the size cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-verifier-"));
    roots.push(root);
    const verifier = await Verifier.create(root);
    // What the http adapter returns for a body larger than maxResponseBytes:
    // the part up to the cap, counted. The whole body is longer than both.
    const cut = { status: 200, truncated: true, bytes: 1000, content: "x".repeat(1000) };
    for (const [path, value] of [["bytes", 1000], ["content", "x".repeat(1000)]] as const) {
      const { verified } = await verifier.verify([{ type: "result_equals", path, value }], cut);
      expect(verified, path).toBe(false);
    }
    // What arrived is all there is, so a body that was not cut still matches.
    const whole = await verifier.verify([{ type: "result_equals", path: "bytes", value: 1000 }], { ...cut, truncated: false });
    expect(whole.verified).toBe(true);
    // Text found in the part that arrived is in the whole body too.
    const contains = await verifier.verify([{ type: "result_contains", path: "content", value: "xxx" }], cut);
    expect(contains.verified).toBe(true);
    // A terminal send: the bytes it wrote, beside a job whose output was cut.
    const sent = await verifier.verify([{ type: "result_equals", path: "bytes", value: 6 }], {
      success: true,
      sent: true,
      bytes: 6,
      truncated: true,
    });
    expect(sent.verified).toBe(true);
  });

  it("matches a final URL against its pattern by code point, one line per star, in linear time", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-verifier-"));
    roots.push(root);
    const verifier = await Verifier.create(root);
    const matches = async (url: string, pattern: string) =>
      (await verifier.verify([{ type: "url_matches", pattern }], { url })).verified;
    expect(await matches("https://example.com/a/b.html", "https://*/*/*.html")).toBe(true);
    expect(await matches("https://example.com/b.html", "https://*/*/*.html")).toBe(false);
    expect(await matches("https://example.com/a\n/b.html", "https://*/*/*.html")).toBe(false);
    expect(await matches("https://example.com/\u{1F642}", "https://example.com/\uD83D*")).toBe(false);
    const started = performance.now();
    expect(await matches(`https://${"/".repeat(500)}`, "https://*/*/*/*.html")).toBe(false);
    // Generous, so a loaded runner does not flake: linear time is well under a
    // millisecond here.
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
