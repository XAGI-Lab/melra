// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// A `custom` evidence predicate through the whole kernel: registered with the
// runtime, refused at plan time when it is not, and never stronger than the
// weakest claim whatever the verifier says.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { capabilitiesPayload, createMelraRuntime, type PredicateVerifier } from "../src/index.js";
import type { MelraRuntime } from "../src/runtime.js";

let runtime: MelraRuntime;
let root: string;
/** What the "store" holds; the verifier reads it, as one would a database. */
const rows = new Set<string>();

const rowExists: PredicateVerifier<{ type: "row_exists"; id: string }> = {
  type: "row_exists",
  async check(predicate) {
    const passed = rows.has(predicate.id);
    // Claims more than it may: the kernel must not believe it.
    return { passed, summary: `row ${predicate.id}`, strength: "independent" } as never;
  },
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "melra-custom-evidence-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({
      version: "custom-evidence",
      workspaceRoot: root,
      allowedCommands: [],
      mutations: "confirm",
      approvalTtlMs: 300_000,
      maxFileBytes: 1_000_000,
    }),
  );
  runtime = await createMelraRuntime({
    workspaceRoot: root,
    dataDirectory: join(root, ".melra"),
    policyPath: join(root, "policy.json"),
    evidenceVerifiers: [rowExists],
  });
});

afterAll(async () => {
  await runtime.close();
  await rm(root, { recursive: true, force: true });
});

const write = (verifier: string, id: string) =>
  TaskRequestSchema.parse({
    goal: "write and record a row",
    operation: { kind: "file", action: "write", path: `${id}.txt`, content: "x" },
    requiredEvidence: [{ type: "custom", verifier, params: { id } }],
  });

async function run(verifier: string, id: string) {
  const planned = runtime.controller.plan(write(verifier, id));
  return await runtime.controller.execute(
    planned.id,
    planned.approval && { approvalId: planned.approval.approvalId, phrase: planned.approval.phrase },
  );
}

describe("custom evidence", () => {
  it("is listed in capabilities, so an agent can offer it", () => {
    expect((capabilitiesPayload(runtime) as { customEvidence: string[] }).customEvidence).toEqual([
      "row_exists",
    ]);
  });

  it("decides success through the registered verifier, at the weakest strength", async () => {
    rows.add("r1");
    const done = await run("row_exists", "r1");
    expect(done.task.status).toBe("verified_success");
    expect(done.certificate?.evidence).toContainEqual(
      expect.objectContaining({ type: "custom:row_exists", passed: true, strength: "execution" }),
    );
    // The effect ran but the verifier says no: partial, never success.
    expect((await run("row_exists", "r2")).task.status).toBe("partial");
  });

  it("refuses at plan time a verifier this runtime does not have", () => {
    expect(() => runtime.controller.plan(write("not_registered", "r3"))).toThrow(
      "evidence_verifier_unavailable:not_registered",
    );
    // `custom` is not a way round a built-in's own schema.
    expect(() => runtime.controller.plan(write("file_hash", "r4"))).toThrow(
      "evidence_verifier_unavailable:file_hash",
    );
  });
});
