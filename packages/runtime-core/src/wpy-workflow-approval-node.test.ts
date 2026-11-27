// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// WPY claim [workflow-approval-node]: docs/ARCHITECTURE.md (workflow node
// table) says an `approval` node "Plans the target operation and pauses for its
// exact scoped challenge", and docs/THREAT_MODEL.md tells authors to "put a
// step that must not run without a person's yes behind an approval".
//
// OLD behaviour (6ccff05): the node's pause was only the policy's.
// `advanceNode` case "approval" called `runTask(target.request, ...,
// executePlanned = false)`; when policy let the target through without a
// challenge the task came back `planned`, which `nodeStateForTask(task,
// plannedIsComplete = true)` mapped to `verified_complete`. No challenge was
// issued, nobody was asked, no decision was recorded, and the next advance ran
// the target. Nothing at plan time refused it.
//
// FIXED: plan refuses an approval node whose target the policy would run with
// no challenge (`workflow_approval_target_not_gated:<node>`), and advance asks
// again, so a run planned under a policy that asked and advanced under one
// that no longer does is refused too, with nothing run.
//
// The adapter is a mock; the operations are harmless.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowDefinitionSchema, type TaskRequestInput } from "@melra/protocol";
import { createDefaultPolicy, type LocalPolicy } from "@melra/policy-core";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";
import { WorkflowController } from "./workflow-controller.js";

const roots: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(mode: LocalPolicy["mode"]) {
  const root = await mkdtemp(join(tmpdir(), "melra-wpy-approval-node-"));
  roots.push(root);
  const store = new SqliteStore(":memory:");
  stores.push(store);
  const dispatched: string[] = [];
  const tasks = new TaskController(
    store,
    { ...createDefaultPolicy(root), mode },
    {
      execute: async (operation) => {
        dispatched.push(`${operation.kind}`);
        return { success: true };
      },
    },
    await Verifier.create(root, {}),
    new PayloadCipher(Buffer.alloc(32, 17)),
  );
  return { root, store, tasks, dispatched, controller: new WorkflowController(store, tasks, new PayloadCipher(Buffer.alloc(32, 17))) };
}

// A read every mode's policy allows with no challenge.
const read: TaskRequestInput = {
  goal: "Read system info (gated behind an approval node by the author)",
  operation: { kind: "system", action: "info" },
  constraints: [],
  forbiddenEffects: [],
  requiredEvidence: [],
  reconciliation: [],
  budget: { maxDurationMs: 120_000, maxRetries: 0, maxSteps: 10 },
};

const gated = WorkflowDefinitionSchema.parse({
  schemaVersion: "1.0.0",
  id: "22222222-2222-4222-8222-222222222222",
  version: 1,
  name: "Read only after a person's yes",
  nodes: [
    { id: "approve-read", type: "approval", forNodeId: "read" },
    { id: "read", type: "operation", dependsOn: ["approve-read"], request: read },
  ],
});

const put: TaskRequestInput = {
  goal: "Put a key (gated behind an approval node)",
  operation: { kind: "memory", action: "put", key: "ledger", value: "ledger" },
  constraints: [],
  forbiddenEffects: [],
  requiredEvidence: [{ type: "result_equals", path: "stored", value: true }],
  reconciliation: [],
  budget: { maxDurationMs: 120_000, maxRetries: 0, maxSteps: 10 },
};

const gatedPut = WorkflowDefinitionSchema.parse({
  schemaVersion: "1.0.0",
  id: "33333333-3333-4333-8333-333333333333",
  version: 1,
  name: "Put only after a person's yes",
  nodes: [
    { id: "approve-put", type: "approval", forNodeId: "put" },
    { id: "put", type: "operation", dependsOn: ["approve-put"], request: put },
  ],
});

describe("WPY [workflow-approval-node]: an approval node over an ungated step is refused", () => {
  for (const mode of ["developer", "enforced"] as const) {
    it(`${mode} mode: plan refuses an approval node over a read the policy allows`, async () => {
      const { controller, dispatched } = await setup(mode);
      // OLD: plan accepted it, the node completed with no challenge and the read ran.
      expect(() => controller.plan(gated)).toThrow("workflow_approval_target_not_gated:approve-read");
      expect(dispatched).toEqual([]);
    });
  }

  it("advance asks again: a run planned where the step needed a yes is refused once it no longer does", async () => {
    // Planned in enforced mode, where a GET to a host allowedDomains does not
    // name needs an operator; advanced by a process whose policy lists it.
    const { root, controller, store, dispatched } = await setup("enforced");
    const fetch: TaskRequestInput = {
      ...read,
      goal: "Fetch a report (gated behind an approval node)",
      operation: { kind: "http", action: "request", method: "GET", url: "https://reports.example.test/q3" },
    };
    const definition = WorkflowDefinitionSchema.parse({
      ...gated,
      id: "44444444-4444-4444-8444-444444444444",
      nodes: [
        { id: "approve-fetch", type: "approval", forNodeId: "fetch" },
        { id: "fetch", type: "operation", dependsOn: ["approve-fetch"], request: fetch },
      ],
    });
    const planned = controller.plan(definition);
    const listed = new TaskController(
      store,
      { ...createDefaultPolicy(root), mode: "enforced", allowedDomains: ["reports.example.test"] },
      { execute: async (operation) => { dispatched.push(operation.kind); return { success: true }; } },
      await Verifier.create(root, {}),
      new PayloadCipher(Buffer.alloc(32, 17)),
    );
    const looseFlow = new WorkflowController(store, listed, new PayloadCipher(Buffer.alloc(32, 17)));
    await expect(looseFlow.advance(planned.id)).rejects.toThrow("workflow_approval_target_not_gated:approve-fetch");
    expect(looseFlow.status(planned.id).nodes["approve-fetch"]?.status).not.toBe("verified_complete");
    // Nothing was planned to run in its place, and asking again refuses again.
    expect(store.listTasks(10)).toEqual([]);
    await expect(looseFlow.advance(planned.id)).rejects.toThrow("workflow_approval_target_not_gated:approve-fetch");
    expect(dispatched).toEqual([]);
  });

  it("a gated step still pauses for its challenge", async () => {
    const { controller } = await setup("developer");
    const planned = controller.plan(gatedPut);
    const first = await controller.advance(planned.id);
    expect(first.run.nodes["approve-put"]?.status).toBe("awaiting_approval");
    expect(first.run.nodes["approve-put"]?.approval).toBeDefined();
  });
});
