// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Verifier } from "./index.js";

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
});
