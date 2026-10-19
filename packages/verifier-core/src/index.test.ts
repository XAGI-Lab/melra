// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
