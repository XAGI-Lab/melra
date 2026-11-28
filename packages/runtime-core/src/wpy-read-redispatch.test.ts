// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// WPY claim [read-redispatch]: an approval was single use per TASK, not per
// dispatch. An approved read that a crash cut off was reset to `planned`
// (`interrupted_read_ready_for_retry`) and the next `execute` ran it again on
// the SAME stored operator decision: nothing marked the decision spent, and
// `usable()` checks only its age.
//
// Only reads reach this: in developer mode a read never needs approval, so the
// approved read here is an enforced-mode HTTP GET to a host the policy admits
// only through "*" (`network_read_unlisted_host`, the outbound-data case),
// approved out of band by an operator. The adapter is a mock: nothing leaves
// the machine.
//
// OLD behaviour (6ccff05): after the crash the read went back to `planned`
// and a plain execute dispatched it a second time on the one yes.
// FIXED: an interrupted read that ran on an approval is parked as
// `recovery_required` with `approval_consumed`; execute refuses it, and a new
// dispatch needs a new plan and a new yes. An unapproved interrupted read is
// still retried. Retries inside one execute (maxRetries) are unchanged: the
// budget is part of the rendered contract the operator approved.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { createDefaultPolicy, type LocalPolicy } from "@melra/policy-core";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const cipher = () => new PayloadCipher(Buffer.alloc(32, 21));
const enforced = (root: string): LocalPolicy => ({ ...createDefaultPolicy(root), mode: "enforced" });

async function temp(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A GET to an unlisted (reserved, fictional) host: enforced mode asks an operator. */
const unlistedRead = (maxRetries = 0) =>
  TaskRequestSchema.parse({
    goal: "Fetch a report from an unlisted host",
    operation: { kind: "http", action: "request", method: "GET", url: "https://example.com/report" },
    budget: { maxRetries },
  });

describe("WPY [read-redispatch]: one approval, one interrupted dispatch", () => {
  it("parks an interrupted approved read as approval_consumed instead of re-running it on the same decision", async () => {
    const root = await temp("melra-wpy-redispatch-");
    const path = join(root, ".melra", "melra.sqlite");
    const crashed = join(root, "crashed.sqlite");

    // Process A: plan, operator approves once, execute. At the moment the
    // adapter is dispatched we snapshot the DB: that is what a crash leaves.
    const storeA = new SqliteStore(path);
    const reader = new DatabaseSync(path, { readOnly: true });
    const adapterA = vi.fn(async () => {
      reader.exec(`VACUUM INTO '${crashed}'`);
      return { success: true, content: "first dispatch" };
    });
    const a = new TaskController(storeA, enforced(root), { execute: adapterA }, await Verifier.create(root), cipher());
    const planned = await a.plan(unlistedRead());
    expect(planned.status).toBe("awaiting_approval");
    expect(planned.policyDecision.reason).toBe("network_read_unlisted_host");
    expect(planned.approval?.phrase).toBeUndefined(); // enforced: no phrase

    const decision = await a.decide(planned.id, a.approvalView(planned.id).renderDigest, "cli:operator");
    await a.execute(planned.id); // dispatch #1 (crash snapshot taken inside it)
    expect(adapterA).toHaveBeenCalledTimes(1);
    reader.close();
    storeA.close();

    // Process B opens what the crash left: the task was `running`.
    const storeB = new SqliteStore(crashed);
    const adapterB = vi.fn(async () => ({ success: true, content: "second dispatch" }));
    const b = new TaskController(storeB, enforced(root), { execute: adapterB }, await Verifier.create(root), cipher());
    expect(storeB.getTask(planned.id)?.status).toBe("running");

    await b.recoverInterrupted();
    // OLD: planned / interrupted_read_ready_for_retry, and the next execute
    // dispatched it again on the same decision.
    expect(b.status(planned.id)).toMatchObject({ status: "recovery_required", error: "approval_consumed" });
    expect(storeB.getApprovalDecision(planned.approval!.approvalId)?.decidedAt).toBe(decision.decidedAt);

    // Executing a parked task only reconciles it; the adapter is not run.
    expect((await b.execute(planned.id)).task).toMatchObject({ status: "recovery_required", error: "approval_consumed" });
    expect(adapterB).not.toHaveBeenCalled();
    storeB.close();

    // The operator said yes once; the effect was dispatched once.
    expect(adapterA.mock.calls.length + adapterB.mock.calls.length).toBe(1);
  });

  it("still retries an interrupted read that needed no approval", async () => {
    const root = await temp("melra-wpy-redispatch-open-");
    const path = join(root, ".melra", "melra.sqlite");
    const crashed = join(root, "crashed.sqlite");
    const storeA = new SqliteStore(path);
    const reader = new DatabaseSync(path, { readOnly: true });
    const a = new TaskController(
      storeA,
      { ...enforced(root), allowedDomains: ["example.com"] },
      { execute: async () => (reader.exec(`VACUUM INTO '${crashed}'`), { success: true }) },
      await Verifier.create(root),
      cipher(),
    );
    const planned = await a.plan(unlistedRead());
    expect(planned.status).toBe("planned");
    await a.execute(planned.id);
    reader.close();
    storeA.close();
    const storeB = new SqliteStore(crashed);
    const b = new TaskController(storeB, { ...enforced(root), allowedDomains: ["example.com"] }, { execute: async () => ({ success: true }) }, await Verifier.create(root), cipher());
    await b.recoverInterrupted();
    expect(b.status(planned.id)).toMatchObject({ status: "planned", error: "interrupted_read_ready_for_retry" });
    expect((await b.execute(planned.id)).task.status).toBe("verified_success");
    storeB.close();
  });

  it("dispatches an approved read up to the maxRetries+1 its approved contract shows", async () => {
    const root = await temp("melra-wpy-retries-");
    const store = new SqliteStore(":memory:");
    const adapter = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockRejectedValueOnce(new Error("EIO: transient"))
      .mockRejectedValueOnce(new Error("EIO: transient"))
      .mockResolvedValueOnce({ success: true, content: "third dispatch" });
    const tasks = new TaskController(store, enforced(root), { execute: adapter }, await Verifier.create(root), cipher());
    const planned = await tasks.plan(unlistedRead(2));
    expect(planned.status).toBe("awaiting_approval");
    await tasks.decide(planned.id, tasks.approvalView(planned.id).renderDigest, "cli:operator");

    // Unchanged, by design: the retry budget is in the contract the operator
    // approved (its renderDigest covers `budget`).
    expect(JSON.stringify(tasks.approvalView(planned.id).contract)).toContain('"maxRetries":2');
    const done = await tasks.execute(planned.id);
    expect(done.task.status).toBe("verified_success");
    expect(adapter).toHaveBeenCalledTimes(3); // one yes, three dispatches
    expect(done.task.attempts).toBe(3);

    // Per task, though: once settled the same decision cannot start it again.
    await expect(tasks.execute(planned.id)).rejects.toThrow("task_not_executable:verified_success");
    store.close();
  });
});
