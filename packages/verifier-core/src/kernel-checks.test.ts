// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileRuntime } from "@melra/file-runtime";
import { OperationSchema, type FileOperation } from "@melra/protocol";
import { kernelChecksFor, Verifier } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "melra-kernel-"));
  roots.push(root);
  return root;
}

const op = (input: unknown) => OperationSchema.parse(input);

describe("kernelChecksFor", () => {
  it("hashes exactly the bytes the file runtime writes, in either encoding", async () => {
    const root = await workspace();
    const files = await FileRuntime.create({ root });
    const binary = Buffer.from([0, 255, 251, 10, 13, 128, 62, 63]);
    const contents: Array<[string, "utf8" | "base64"]> = [
      ["héllo\r\nwörld\n", "utf8"],
      ["", "utf8"],
      [binary.toString("base64"), "base64"],
      // The URL-safe alphabet, wrapped as MIME wraps it: the runtime decodes both.
      [binary.toString("base64url").replace(/(.{4})/g, "$1\n"), "base64"],
    ];
    for (const [index, [content, encoding]] of contents.entries()) {
      const write = op({ kind: "file", action: "write", path: `f${index}`, content, encoding }) as FileOperation;
      await files.execute(write);
      const written = createHash("sha256").update(await readFile(join(root, `f${index}`))).digest("hex");
      expect(kernelChecksFor(write), `${encoding} ${index}`).toEqual([{ type: "file_hash", path: `f${index}`, sha256: written }]);
    }
  });

  it("finds a hard-linked file renamed by case gone under its old spelling", async ({ skip }) => {
    const root = await workspace();
    await writeFile(join(root, "a.txt"), "x");
    // Only a disk that folds case lets the old spelling reach the renamed file.
    if (!(await lstat(join(root, "A.TXT")).then(() => true, () => false))) skip();
    await link(join(root, "a.txt"), join(root, "keep"));
    const files = await FileRuntime.create({ root });
    const move = op({ kind: "file", action: "move", path: "a.txt", destination: "A.txt" }) as FileOperation;
    const result = await files.execute(move);
    const verifier = await Verifier.create(root);
    expect((await verifier.verify(kernelChecksFor(move), result)).evidence.map((item) => item.passed)).toEqual([true, true]);
    // In another folder the destination is not what the old spelling
    // reaches: a second name for the file, spelled the same, is still there.
    await mkdir(join(root, "x"));
    await mkdir(join(root, "y"));
    await writeFile(join(root, "x", "F.txt"), "x");
    await link(join(root, "x", "F.txt"), join(root, "y", "F.txt"));
    const away = { moved: true, path: join("x", "f.txt"), destination: join("y", "F.txt") };
    expect((await verifier.verify([{ type: "file_absent", path: "x/f.txt" }], away)).verified).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails a write over a file the process may not read back, which then ends partial",
    async () => {
      const root = await workspace();
      await writeFile(join(root, "wo.log"), "old");
      await chmod(join(root, "wo.log"), 0o200);
      const files = await FileRuntime.create({ root });
      const write = op({ kind: "file", action: "write", path: "wo.log", content: "new" }) as FileOperation;
      const result = await files.execute(write);
      // The runtime keeps the file's mode, so the check cannot open it: no
      // answer, which fails rather than reads as passed.
      const { verified, evidence } = await (await Verifier.create(root)).verify(kernelChecksFor(write), result);
      expect(verified).toBe(false);
      expect(evidence).toEqual([expect.objectContaining({ type: "file_hash", passed: false, inconclusive: true })]);
      await chmod(join(root, "wo.log"), 0o600);
      expect(await readFile(join(root, "wo.log"), "utf8")).toBe("new");
    },
  );

  it("derives nothing for a write the runtime refuses to decode, or one with no content", async () => {
    const files = await FileRuntime.create({ root: await workspace() });
    const invalid = op({ kind: "file", action: "write", path: "x", content: "not base64!", encoding: "base64" }) as FileOperation;
    await expect(files.execute(invalid)).rejects.toThrow("file_content_invalid_base64");
    expect(kernelChecksFor(invalid)).toEqual([]);
    expect(kernelChecksFor(op({ kind: "file", action: "write", path: "x" }))).toEqual([]);
  });

  it("derives the end state of a mkdir, delete, move and memory delete, and of nothing else", () => {
    expect(kernelChecksFor(op({ kind: "file", action: "mkdir", path: "a/b", recursive: true }))).toEqual([
      { type: "directory_exists", path: "a/b" },
    ]);
    expect(kernelChecksFor(op({ kind: "file", action: "delete", path: "old" }))).toEqual([{ type: "file_absent", path: "old" }]);
    expect(kernelChecksFor(op({ kind: "file", action: "move", path: "a", destination: "b" }))).toEqual([
      { type: "file_absent", path: "a" },
      { type: "file_present", path: "b" },
    ]);
    const id = "00000000-0000-4000-8000-0000000000d1";
    expect(kernelChecksFor(op({ kind: "memory", action: "delete", id, scope: "user" }))).toEqual([
      { type: "memory_absent", id, scope: "user" },
    ]);
    // Their end state is not in the request, or not exactly.
    for (const none of [
      { kind: "file", action: "move", path: "a" },
      ...["list", "read", "stat", "hash"].map((action) => ({ kind: "file", action, path: "a" })),
      { kind: "memory", action: "put", id, key: "k", value: "v" },
      { kind: "memory", action: "delete" },
      { kind: "memory", action: "clear" },
      { kind: "terminal", action: "run", command: "node", args: ["build.js"] },
      { kind: "browser", action: "navigate", url: "https://example.com/" },
      { kind: "http", action: "request", method: "POST", url: "https://example.com/refunds" },
      { kind: "computer", action: "click", x: 0.5, y: 0.5 },
      { kind: "system", action: "info" },
    ]) {
      expect(kernelChecksFor(op(none)), JSON.stringify(none)).toEqual([]);
    }
  });
});

describe("the kernel's own predicates", () => {
  it("tell a directory from anything else, through links", async () => {
    const root = await workspace();
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "file"), "x");
    const verifier = await Verifier.create(root);
    const checks = ["dir", "file", "missing"].map((path) => ({ type: "directory_exists", path }));
    const { evidence } = await verifier.verify(checks, {});
    expect(evidence.map((item) => item.passed)).toEqual([true, false, false]);
    expect(evidence.every((item) => item.strength === "state")).toBe(true);
    const linked = await symlink(join(root, "dir"), join(root, "link")).then(() => true, () => false);
    if (linked) expect((await verifier.verify([{ type: "directory_exists", path: "link" }], {})).verified).toBe(true);
  });

  it("find whatever entry a move left, a link that leads nowhere included", async () => {
    const root = await workspace();
    await writeFile(join(root, "file"), "x");
    const verifier = await Verifier.create(root);
    const { evidence } = await verifier.verify(
      ["file", "missing"].map((path) => ({ type: "file_present", path })),
      {},
    );
    expect(evidence.map((item) => item.passed)).toEqual([true, false]);
    expect(evidence.every((item) => item.strength === "state")).toBe(true);
    const linked = await symlink(join(root, "nowhere"), join(root, "dangling")).then(() => true, () => false);
    if (linked) expect((await verifier.verify([{ type: "file_present", path: "dangling" }], {})).verified).toBe(true);
    // Confined as every file predicate is.
    expect((await verifier.verify([{ type: "file_present", path: "../outside" }], {})).evidence[0]).toMatchObject({
      passed: false,
      unanswerable: true,
    });
  });
});
