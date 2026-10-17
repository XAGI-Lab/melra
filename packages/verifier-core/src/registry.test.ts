// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Verifier, type PredicateVerifier } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "melra-verifier-registry-"));
  roots.push(root);
  return root;
}

// A verifier the kernel does not ship: a row in some store, read from the result.
const rowExists: PredicateVerifier<{ type: "row_exists"; id: string }> = {
  type: "row_exists",
  async check(predicate, result) {
    const passed = Array.isArray(result.rows) && result.rows.includes(predicate.id);
    // Tries to claim the strongest kind of knowing, and a different type.
    return { passed, summary: `row ${predicate.id}`, strength: "independent", type: "file_hash" } as never;
  },
};

describe("pluggable verifiers", () => {
  it("runs a registered verifier, but stamps type and strength itself", async () => {
    const verifier = await Verifier.create(await workspace(), { verifiers: [rowExists] });
    const { verified, evidence } = await verifier.verify(
      [{ type: "row_exists", id: "r1" }],
      { rows: ["r1"] },
    );
    expect(verified).toBe(true);
    // Not "independent", not "file_hash": an unrecognised type is the weakest claim.
    expect(evidence[0]).toMatchObject({ type: "row_exists", strength: "execution", passed: true });
  });

  it("fails a predicate no verifier is registered for, or whose verifier throws", async () => {
    const throwing: PredicateVerifier<{ type: "flaky" }> = {
      type: "flaky",
      async check() {
        throw new Error("store unreachable");
      },
    };
    const verifier = await Verifier.create(await workspace(), { verifiers: [throwing] });
    const { verified, evidence } = await verifier.verify(
      [{ type: "nobody_knows" }, { type: "flaky" }],
      {},
    );
    expect(verified).toBe(false);
    expect(evidence.map((item) => [item.passed, item.summary])).toEqual([
      [false, "verification_unsupported:nobody_knows"],
      [false, "store unreachable"],
    ]);
  });

  it("refuses to replace a built-in predicate", async () => {
    const lenient: PredicateVerifier<{ type: "file_hash" }> = {
      type: "file_hash",
      async check() {
        return { passed: true, summary: "trust me" };
      },
    };
    await expect(Verifier.create(await workspace(), { verifiers: [lenient] })).rejects.toThrow(
      "verifier_type_taken:file_hash",
    );
  });

  it("keeps a verifier's file reads inside the workspace", async () => {
    const root = await workspace();
    await writeFile(join(root, "inside.txt"), "x");
    const reads: PredicateVerifier<{ type: "reads"; path: string }> = {
      type: "reads",
      async check(predicate, _result, context) {
        const path = await context.workspacePath(predicate.path);
        return { passed: true, summary: "read", source: context.relative(path) };
      },
    };
    const verifier = await Verifier.create(root, { verifiers: [reads] });
    const { evidence } = await verifier.verify(
      [
        { type: "reads", path: "inside.txt" },
        { type: "reads", path: "../outside.txt" },
        { type: "reads", path: "." },
      ],
      {},
    );
    expect(evidence.map((item) => [item.passed, item.source ?? item.summary])).toEqual([
      [true, "inside.txt"],
      [false, "verification_path_outside_workspace"],
      [false, "verification_path_outside_workspace"],
    ]);
  });

  it("reaches a registered verifier through a request's `custom` predicate, and only that", async () => {
    const verifier = await Verifier.create(await workspace(), { verifiers: [rowExists] });
    expect(verifier.customVerifiers()).toEqual(["row_exists"]);
    expect(verifier.supports({ type: "custom", verifier: "row_exists", params: {} })).toBe(true);
    expect(verifier.supports({ type: "custom", verifier: "file_hash", params: {} })).toBe(false);
    expect(verifier.supports({ type: "custom", verifier: "nope", params: {} })).toBe(false);
    const { evidence } = await verifier.verify(
      [
        // `params` cannot overwrite the name the verifier is called with.
        { type: "custom", verifier: "row_exists", params: { id: "r1", type: "file_hash" } },
        { type: "custom", verifier: "file_hash", params: { path: "x", sha256: "0".repeat(64) } },
      ],
      { rows: ["r1"] },
    );
    expect(evidence.map((item) => [item.type, item.passed, item.strength])).toEqual([
      ["custom:row_exists", true, "execution"],
      ["custom:file_hash", false, "execution"],
    ]);
  });

  it("refuses names a request could not carry, and the wrapper name itself", async () => {
    const named = (type: string) => ({ type, check: rowExists.check });
    await expect(Verifier.create(await workspace(), { verifiers: [named("Row Exists")] })).rejects.toThrow(
      "verifier_name_invalid:Row Exists",
    );
    await expect(Verifier.create(await workspace(), { verifiers: [named("custom")] })).rejects.toThrow(
      "verifier_type_taken:custom",
    );
  });

  it("never answers a semantic question, and lets no verifier answer one", async () => {
    const verifier = await Verifier.create(await workspace());
    expect(verifier.supports({ type: "semantic", question: "q", artifacts: [] })).toBe(true);
    expect(verifier.supports({ type: "custom", verifier: "semantic", params: {} })).toBe(false);
    const result = await verifier.verify([{ type: "semantic", question: "Is it right?", artifacts: [] }], { ok: true });
    expect(result).toEqual({
      verified: false,
      evidence: [
        {
          type: "semantic",
          passed: false,
          inconclusive: true,
          strength: "semantic",
          summary: "semantic_judgement_unanswered",
        },
      ],
    });
    const named = { type: "semantic", check: async () => ({ passed: true, summary: "looks right" }) };
    await expect(Verifier.create(await workspace(), { verifiers: [named] })).rejects.toThrow(
      "verifier_type_taken:semantic",
    );
  });
});
