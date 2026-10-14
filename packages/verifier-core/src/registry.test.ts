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
});
