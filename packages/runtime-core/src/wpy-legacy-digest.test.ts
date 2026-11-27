// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// WPY [legacy-digest] ("Who Pressed Yes?" approval-integrity probe).
//
// Claim: `execute` accepted the legacy, unkeyed render digest
// (decision.renderDigest === sha256(contract)) for ANY task, not only tasks a
// 0.3.0-alpha.17/18 process planned. So someone who can write `melra.sqlite`
// but does NOT hold the payload key could insert a decision row that
// `execute` honoured, in enforced mode too, where it then counted as an
// operator's out-of-band yes.
//
// OLD behaviour (6ccff05): the planted plain-digest row below ran the effect
// to verified_success with approver "planted:sqlite".
// FIXED: execute compares the row with `approvalRender`'s digest only, which
// is the plain form for a legacy task and the keyed form otherwise, so the
// planted row is refused with approval_render_mismatch and nothing runs.
// Residual (not fixed here): task rows are not sealed, so a writer who also
// rewrites the task's stored actionDigest to the plain form makes it read as
// legacy.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRequestSchema, effectContract, type Operation, type TaskRequest } from "@melra/protocol";
import { classifyOperation, createDefaultPolicy, digestOperation } from "@melra/policy-core";
import { sha256 } from "@melra/receipt-schema";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";

const roots: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(mode: "developer" | "enforced") {
  const root = await mkdtemp(join(tmpdir(), "melra-wpy-legacy-"));
  roots.push(root);
  const store = new SqliteStore(":memory:");
  stores.push(store);
  const calls: Operation[] = [];
  const tasks = new TaskController(
    store,
    { ...createDefaultPolicy(root), mode },
    { execute: async (operation: Operation) => (calls.push(operation), { success: true, stored: true }) },
    await Verifier.create(root),
    // The home's payload key. The attacker below never touches this object.
    new PayloadCipher(Buffer.alloc(32, 9)),
  );
  return { store, tasks, calls };
}

// A mutation that needs approval under the default policy.
const pin: TaskRequest = TaskRequestSchema.parse({
  goal: "Store the door code",
  operation: { kind: "memory", action: "put", key: "door", value: "0000" },
  requiredEvidence: [{ type: "result_equals", path: "stored", value: true }],
});

/**
 * What a key-less writer computes: the plain SHA-256 of the effect contract,
 * from the (unencrypted) task row plus the request the agent itself sent.
 * No PayloadCipher, no payload.key.
 */
function keylessRender(store: SqliteStore, taskId: string, request: TaskRequest): string {
  const task = store.getTask(taskId)!;
  const { authorization: _a, policy: _p, ...contract } = effectContract(
    { ...task, request },
    classifyOperation(request.operation),
  );
  return sha256(contract);
}

/** A raw INSERT, as any SQLite client would do it: no `sealing`, no record_chain link. */
function plantDecision(store: SqliteStore, row: { approvalId: string; taskId: string; renderDigest: string; channel: string }) {
  store.database
    .prepare(
      `INSERT INTO approval_decisions(approval_id, task_id, render_digest, channel, approver, decided_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(row.approvalId, row.taskId, row.renderDigest, row.channel, "planted:sqlite", new Date().toISOString());
}

describe("WPY [legacy-digest]: a key-less SQLite writer's planted decision is refused", () => {
  for (const mode of ["developer", "enforced"] as const) {
    it(`refuses a NEW (keyed) challenge a planted plain-digest row (${mode})`, async () => {
      const { store, tasks, calls } = await setup(mode);
      const planned = await tasks.plan(pin);
      expect(planned.status).toBe("awaiting_approval");

      // The task is a current one, not a 0.3.0-alpha.17/18 one: its stored
      // action digest is keyed, so it is NOT the plain digest of its operation.
      const row = store.getTask(planned.id)!;
      expect(row.approval!.actionDigest).not.toBe(digestOperation(planned.id, pin.operation));
      // And the render an operator is shown is keyed, not the plain one.
      const plain = keylessRender(store, planned.id, pin);
      expect(tasks.approvalView(planned.id).renderDigest).not.toBe(plain);

      // Control: a row the writer cannot bind (no key -> a guessed keyed digest) is refused.
      const control = await tasks.plan(pin);
      plantDecision(store, {
        approvalId: control.approval!.approvalId,
        taskId: control.id,
        renderDigest: "0".repeat(64),
        channel: "out_of_band",
      });
      await expect(tasks.execute(control.id)).rejects.toThrow("approval_render_mismatch");
      expect(calls).toHaveLength(0);

      // Plant the plain digest (computable with no key) and the approvalId
      // (read off the task row). OLD: execute ran it, approver planted:sqlite.
      plantDecision(store, {
        approvalId: row.approval!.approvalId,
        taskId: planned.id,
        renderDigest: plain,
        channel: "out_of_band",
      });
      await expect(tasks.execute(planned.id)).rejects.toThrow("approval_render_mismatch");
      expect(calls).toHaveLength(0);
      expect(store.getTask(planned.id)!.status).toBe("awaiting_approval");
    });
  }
});
