// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TaskRequestSchema,
  WorkflowDefinitionSchema,
  type Operation,
  type TaskRequest,
  type WorkflowRun,
} from "@melra/protocol";
import { createDefaultPolicy, type LocalPolicy } from "@melra/policy-core";
import { sha256 } from "@melra/receipt-schema";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";
import { WorkflowController } from "./workflow-controller.js";

/**
 * Workflow semantics the audit found broken: effects running before what they
 * depend on, recovery mistaking a part for the whole, approvals that could
 * never be given, branches that changed their mind, and halts that refused
 * exactly the runs that needed one.
 */
const roots: string[] = [];
const stores: SqliteStore[] = [];
const definitionId = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Every memory `put` the adapter performed, by key, in order. */
async function setup(options: { delayMs?: number; policy?: Partial<LocalPolicy> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "melra-workflow-correctness-"));
  roots.push(root);
  const store = new SqliteStore(":memory:");
  stores.push(store);
  const cipher = new PayloadCipher(Buffer.alloc(32, 23));
  const done: string[] = [];
  const execute = async (operation: Operation): Promise<Record<string, unknown>> => {
    if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (operation.kind === "memory") done.push(operation.key ?? "");
    return { success: true, stored: true };
  };
  const tasks = new TaskController(
    store,
    { ...createDefaultPolicy(root), ...options.policy },
    { execute },
    await Verifier.create(root),
    cipher,
  );
  return { root, store, cipher, tasks, done, controller: new WorkflowController(store, tasks, cipher) };
}

const put = (key: string): TaskRequest =>
  TaskRequestSchema.parse({
    goal: `Put ${key}`,
    operation: { kind: "memory", action: "put", key, value: key },
    requiredEvidence: [{ type: "result_equals", path: "stored", value: true }],
  });

const read = (): TaskRequest =>
  TaskRequestSchema.parse({ goal: "Inspect", operation: { kind: "system", action: "info" } });

const workflow = (nodes: unknown[]) =>
  WorkflowDefinitionSchema.parse({ schemaVersion: "1.0.0", id: definitionId, version: 1, name: "Correctness", nodes });

/** Approve whatever is waiting, once. */
const approvalsFor = (run: WorkflowRun) =>
  Object.values(run.nodes).flatMap((node) =>
    node.approval === undefined ? [] : [{ approvalId: node.approval.approvalId, phrase: node.approval.phrase! }],
  );

describe("workflow ordering", () => {
  it("does not run an approved effect before its other dependencies", async () => {
    const { controller, done } = await setup();
    const planned = controller.plan(
      workflow([
        { id: "backup", type: "operation", request: put("backup") },
        { id: "approve-delete", type: "approval", forNodeId: "delete" },
        { id: "delete", type: "operation", dependsOn: ["approve-delete", "backup"], request: put("delete") },
        { id: "undo-delete", type: "compensation", forNodeId: "delete", request: put("undo") },
      ]),
    );
    let run = (await controller.advance(planned.id)).run;
    // The approval is not even asked for until the backup it would overtake is done.
    expect(run.nodes["approve-delete"]?.status).toBe("pending");
    for (let step = 0; step < 6 && run.status !== "verified_complete"; step += 1) {
      run = (await controller.advance(planned.id, approvalsFor(run))).run;
    }
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["backup", "delete"]);
  });

  it("refuses a condition whose source is not one of its dependencies", async () => {
    const { controller } = await setup();
    expect(() =>
      controller.plan(
        workflow([
          { id: "inspect", type: "operation", request: read() },
          {
            id: "choose",
            type: "condition",
            sourceNodeId: "inspect",
            predicate: { type: "result_equals", path: "success", value: true },
            whenTrue: [put("a")],
            whenFalse: [],
          },
        ]),
      ),
    ).toThrow("workflow_condition_source_must_precede:choose");
  });

  it("lets every sibling finish before reporting one's error", async () => {
    const { controller, done } = await setup({ delayMs: 300 });
    const planned = controller.plan(
      workflow([
        { id: "write", type: "operation", request: put("write") },
        { id: "ask", type: "human_input", prompt: "Code?", maxLength: 5 },
      ]),
    );
    const waiting = (await controller.advance(planned.id)).run;
    await expect(
      controller.advance(planned.id, approvalsFor(waiting), [{ nodeId: "ask", value: "far too long" }]),
    ).rejects.toThrow("workflow_input_too_long");
    // The write finished before that error came back, so a retry sees it done.
    expect(done).toEqual(["write"]);
    const retried = (await controller.advance(planned.id, [], [{ nodeId: "ask", value: "ok" }])).run;
    expect(retried.nodes.write?.status).toBe("verified_complete");
    expect(retried.status).not.toBe("failed");
  });
});

describe("workflow decisions that have to stay made", () => {
  it("keeps the branch a condition started on even if its predicate changes", async () => {
    const { controller, root, done } = await setup();
    await writeFile(join(root, "flag"), "on");
    const planned = controller.plan(
      workflow([
        { id: "inspect", type: "operation", request: read() },
        {
          id: "choose",
          type: "condition",
          dependsOn: ["inspect"],
          sourceNodeId: "inspect",
          predicate: { type: "file_exists", path: "flag" },
          whenTrue: [put("patch-existing")],
          whenFalse: [put("create-new"), put("register-new")],
        },
      ]),
    );
    await controller.advance(planned.id);
    const waiting = (await controller.advance(planned.id)).run;
    expect(waiting.nodes.choose?.status).toBe("awaiting_approval");
    await unlink(join(root, "flag"));
    const after = (await controller.advance(planned.id, approvalsFor(waiting))).run;
    expect(done).toEqual(["patch-existing"]);
    expect(after.nodes.choose?.status).toBe("verified_complete");
  });

  it("asks again when an approval challenge expired before anyone answered", async () => {
    const { controller, done } = await setup({ policy: { approvalTtlMs: 50 } });
    const planned = controller.plan(workflow([{ id: "write", type: "operation", request: put("write") }]));
    const first = (await controller.advance(planned.id)).run;
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Used to throw approval_expired here, and every advance after it.
    const second = (await controller.advance(planned.id, approvalsFor(first))).run;
    expect(second.nodes.write?.status).toBe("awaiting_approval");
    expect(second.nodes.write?.approval?.approvalId).not.toBe(first.nodes.write?.approval?.approvalId);
    const third = (await controller.advance(planned.id, approvalsFor(second))).run;
    expect(third.status).toBe("verified_complete");
    expect(done).toEqual(["write"]);
  });
});

describe("workflow recovery", () => {
  it("does not fail an approved effect because a restart came between the ask and the answer", async () => {
    const { controller, store, tasks, cipher, done } = await setup();
    const planned = controller.plan(
      workflow([
        { id: "approve-write", type: "approval", forNodeId: "write" },
        { id: "write", type: "operation", dependsOn: ["approve-write"], request: put("write") },
        { id: "undo-write", type: "compensation", forNodeId: "write", request: put("undo") },
      ]),
    );
    const waiting = (await controller.advance(planned.id)).run;
    // Any CLI command builds a runtime, and building one recovers.
    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    let run = (await restarted.advance(planned.id, approvalsFor(waiting))).run;
    for (let step = 0; step < 3 && run.status !== "verified_complete"; step += 1) {
      run = (await restarted.advance(planned.id)).run;
    }
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["write"]);
  });

  it("does not call a loop finished when a crash came between its iterations", async () => {
    const { controller, store, tasks, cipher, done } = await setup();
    const body = put("step");
    const planned = controller.plan(
      workflow([{ id: "loop", type: "bounded_loop", maxIterations: 3, body: [body] }]),
    );
    // Iteration 0 ran under its own idempotency key, then the process died.
    const key = sha256({ workflowId: planned.id, nodeId: "loop", iteration: 0, branch: "loop:0", request: body });
    const first = tasks.plan(body, { idempotencyKey: key, attempt: 1 });
    await tasks.execute(first.id, { approvalId: first.approval!.approvalId, phrase: first.approval!.phrase! });
    const restarted = new WorkflowController(store, tasks, cipher);
    const [recovered] = await restarted.recoverInterrupted();
    expect(recovered?.nodes.loop?.status).toBe("pending");
    let run = recovered!;
    for (let step = 0; step < 6 && run.status !== "verified_complete"; step += 1) {
      run = (await restarted.advance(planned.id, approvalsFor(run))).run;
    }
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["step", "step", "step"]);
  });
  it("repairs a run an earlier version left running after a denial", async () => {
    const { controller, store, tasks, cipher, done } = await setup();
    const planned = controller.plan(
      workflow([
        { id: "write", type: "operation", request: put("write") },
        { id: "next", type: "operation", dependsOn: ["write"], request: put("next") },
        { id: "undo", type: "compensation", forNodeId: "write", request: put("undo") },
      ]),
    );
    let run = (await controller.advance(planned.id)).run;
    for (let step = 0; step < 4 && run.nodes.next?.status !== "awaiting_approval"; step += 1) {
      run = (await controller.advance(planned.id, approvalsFor(run))).run;
    }
    const denied = run.nodes.next!.taskIds[0]!;
    tasks.cancel(denied);
    // What an earlier version recorded on the next advance: the node
    // cancelled and the run `running`, with nothing left that could run.
    type Emit = (type: string, data: Record<string, unknown>) => void;
    const legacy = controller as unknown as {
      transition(run: WorkflowRun, change: (draft: WorkflowRun, emit: Emit) => void): WorkflowRun;
    };
    legacy.transition(run, (draft, emit) => {
      const state = { status: "cancelled" as const, taskIds: [denied] };
      emit("workflow.node_changed", { nodeId: "next", from: draft.nodes.next!.status, state });
      draft.nodes.next = state;
      emit("workflow.status_changed", { from: draft.status, to: "running" });
      draft.status = "running";
    });

    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    run = restarted.status(planned.id);
    expect(run.status).toBe("failed");
    for (let step = 0; step < 3 && run.nodes.undo?.status !== "compensated"; step += 1) {
      run = (await restarted.advance(planned.id, approvalsFor(run))).run;
    }
    expect(run.nodes.undo?.status).toBe("compensated");
    expect(done).toEqual(["write", "undo"]);
  });
});

describe("a step an operator denies", () => {
  // Pay, then two branches that each wait for approval; refunding pays back.
  const fanOut = () =>
    workflow([
      { id: "pay", type: "operation", request: put("pay") },
      { id: "fan", type: "parallel", dependsOn: ["pay"], branches: [[put("a")], [put("b")]] },
      { id: "refund", type: "compensation", forNodeId: "pay", request: put("refund") },
    ]);
  const waitingOnBoth = async (controller: WorkflowController, id: string) => {
    let run = (await controller.advance(id)).run;
    for (let step = 0; step < 4 && run.nodes.fan?.status !== "awaiting_approval"; step += 1) {
      run = (await controller.advance(id, approvalsFor(run))).run;
    }
    expect(run.nodes.fan?.status).toBe("awaiting_approval");
    return run.nodes.fan!.taskIds as [string, string];
  };

  it("ends a parallel node at its denied branch and unwinds without offering the other", async () => {
    const { controller, tasks, done } = await setup();
    const planned = controller.plan(fanOut());
    const [a, b] = await waitingOnBoth(controller, planned.id);
    tasks.cancel(a);

    let run = (await controller.advance(planned.id)).run;
    // It kept b's challenge on offer, and approving it ran b on a doomed run.
    expect(run.nodes.fan?.status).toBe("cancelled");
    expect(run.status).toBe("failed");
    expect(run.nodes.refund?.status).toBe("awaiting_approval");
    const other = tasks.status(b).approval!;
    run = (await controller.advance(planned.id, [
      ...approvalsFor(run),
      { approvalId: other.approvalId, phrase: other.phrase! },
    ])).run;
    expect(run.nodes.refund?.status).toBe("compensated");
    expect(done).toEqual(["pay", "refund"]);
  });

  it("does not read a challenge asked again as a denial when its advance did not commit", async () => {
    const { controller, tasks, done } = await setup();
    const planned = controller.plan(
      workflow([
        { id: "pay", type: "operation", request: put("pay") },
        { id: "next", type: "operation", dependsOn: ["pay"], request: put("next") },
        { id: "refund", type: "compensation", forNodeId: "pay", request: put("refund") },
      ]),
    );
    let run = (await controller.advance(planned.id)).run;
    for (let step = 0; step < 4 && run.nodes.next?.status !== "awaiting_approval"; step += 1) {
      run = (await controller.advance(planned.id, approvalsFor(run))).run;
    }
    // What an advance does with an expired challenge: cancel it and ask again.
    // Its commit was lost (a pause landed), so the run still names attempt 1.
    const first = tasks.status(run.nodes.next!.taskIds[0]!);
    tasks.cancel(first.id);
    const again = tasks.plan(put("next"), { idempotencyKey: first.idempotencyKey!, attempt: 2, stored: true });

    run = (await controller.advance(planned.id)).run;
    expect(run.status).toBe("awaiting_approval");
    expect(run.nodes.next?.taskIds).toEqual([again.id]);
    run = (await controller.advance(planned.id, approvalsFor(run))).run;
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["pay", "next"]);
  });

  it("does not run a condition's other branch once one branch committed", async () => {
    const { controller, store, tasks, cipher, done } = await setup();
    const planned = controller.plan(
      workflow([
        { id: "inspect", type: "operation", request: read() },
        {
          id: "choose",
          type: "condition",
          dependsOn: ["inspect"],
          sourceNodeId: "inspect",
          predicate: { type: "file_exists", path: "flag" },
          whenTrue: [put("patch")],
          whenFalse: [put("create")],
        },
      ]),
    );
    let run = (await controller.advance(planned.id)).run;
    expect(run.nodes.choose?.status).toBe("pending");
    // The true branch was taken and its first step ran and committed; its
    // advance then lost its commit, and the branch's own effect has since
    // made the predicate false. Nothing on the run says which branch it was.
    const key = sha256({ workflowId: planned.id, nodeId: "choose", iteration: 0, branch: "true:0", request: put("patch") });
    const ran = tasks.plan(put("patch"), { idempotencyKey: key, attempt: 1, stored: true });
    await tasks.execute(ran.id, { approvalId: ran.approval!.approvalId, phrase: ran.approval!.phrase! });

    for (let step = 0; step < 4 && run.status !== "recovery_required"; step += 1) {
      run = (await controller.advance(planned.id, approvalsFor(run))).run;
    }
    // Asking the predicate again chose the other branch and ran it too. Now
    // the committed branch is kept, its step planned again is a duplicate,
    // and the run halts for recovery.
    expect(done).toEqual(["patch"]);
    expect(run.status).toBe("recovery_required");

    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    run = restarted.status(planned.id);
    expect(run.nodes.choose?.taskIds).toEqual([ran.id]);
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["patch"]);
  });

  it("halts a loop whose iterations ran past its record, and recovery finishes it", async () => {
    const { controller, store, tasks, cipher, done, root } = await setup();
    const tick = put("tick");
    const planned = controller.plan(
      workflow([
        { id: "spin", type: "bounded_loop", maxIterations: 3, until: { type: "file_exists", path: "flag" }, body: [tick] },
        { id: "after", type: "operation", dependsOn: ["spin"], request: put("after") },
      ]),
    );
    // Two iterations ran and committed in one advance, the second creating
    // the flag that ends the loop; that advance then lost its commit.
    for (const iteration of [0, 1]) {
      const key = sha256({ workflowId: planned.id, nodeId: "spin", iteration, branch: "loop:0", request: tick });
      const ran = tasks.plan(tick, { idempotencyKey: key, attempt: 1, stored: true });
      await tasks.execute(ran.id, { approvalId: ran.approval!.approvalId, phrase: ran.approval!.phrase! });
    }
    await writeFile(join(root, "flag"), "");

    let run = (await controller.advance(planned.id)).run;
    for (let step = 0; step < 3 && run.status !== "recovery_required"; step += 1) {
      run = (await controller.advance(planned.id, approvalsFor(run))).run;
    }
    // Reusing iteration 0 and asking `until` of a workspace iteration 1 had
    // changed cut the loop short, and `after` ran on it.
    expect(run.status).toBe("recovery_required");
    expect(run.nodes.after?.status).toBe("pending");
    expect(done).toEqual(["tick", "tick"]);

    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    run = restarted.status(planned.id);
    // Both iterations kept; the next advance asks `until` of the last one.
    expect(run.nodes.spin).toMatchObject({ status: "pending", iterations: 2 });
    for (let step = 0; step < 3 && run.status !== "verified_complete"; step += 1) {
      run = (await restarted.advance(planned.id, approvalsFor(run))).run;
    }
    expect(run.nodes.spin).toMatchObject({ status: "verified_complete", iterations: 2 });
    expect(done).toEqual(["tick", "tick", "after"]);
  });

  it("does not read a stale duplicate challenge, once denied, as the step's denial", async () => {
    const { controller, store, tasks, cipher, done } = await setup();
    const planned = controller.plan(
      workflow([
        { id: "pay", type: "operation", request: put("pay") },
        { id: "next", type: "operation", dependsOn: ["pay"], request: put("next") },
        { id: "refund", type: "compensation", forNodeId: "pay", request: put("refund") },
      ]),
    );
    let run = (await controller.advance(planned.id)).run;
    run = (await controller.advance(planned.id, approvalsFor(run))).run;
    expect(run.nodes.next?.status).toBe("pending");
    // An advance planned next's challenge and lost its commit to a pause; the
    // next one planned it again, under the same key and attempt.
    const key = sha256({ workflowId: planned.id, nodeId: "next", iteration: 0, branch: "operation", request: put("next") });
    const stale = tasks.plan(put("next"), { idempotencyKey: key, attempt: 1, stored: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    run = (await controller.advance(planned.id)).run;
    const live = run.nodes.next!.taskIds[0]!;
    expect(live).not.toBe(stale.id);
    // The operator clears the stale one; any later melra process recovers.
    tasks.cancel(stale.id);
    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    run = restarted.status(planned.id);
    // Picked by last update, the cancelled stale task failed the run.
    expect(run.status).toBe("awaiting_approval");
    expect(run.nodes.next?.taskIds).toEqual([live]);
    run = (await restarted.advance(planned.id, approvalsFor(run))).run;
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["pay", "next"]);
  });

  it("flags a run an earlier version left failed past a denied compensation", async () => {
    const { controller, done } = await setup();
    const planned = controller.plan(
      workflow([
        { id: "a", type: "operation", request: put("a") },
        { id: "b", type: "operation", dependsOn: ["a"], request: put("b") },
        { id: "c", type: "operation", dependsOn: ["b"], request: put("c") },
        { id: "undo-a", type: "compensation", forNodeId: "a", request: put("undo-a") },
        { id: "undo-b", type: "compensation", forNodeId: "b", request: put("undo-b") },
      ]),
    );
    let run = (await controller.advance(planned.id)).run;
    for (let step = 0; step < 6 && run.nodes.c?.status !== "awaiting_approval"; step += 1) {
      run = (await controller.advance(planned.id, approvalsFor(run))).run;
    }
    // What an earlier version recorded: c failed, undo-b denied, the run
    // `failed`, and the next advance about to undo a past the missing undo-b.
    type Emit = (type: string, data: Record<string, unknown>) => void;
    const legacy = controller as unknown as {
      transition(run: WorkflowRun, change: (draft: WorkflowRun, emit: Emit) => void): WorkflowRun;
    };
    legacy.transition(run, (draft, emit) => {
      for (const [nodeId, status] of [["c", "failed"], ["undo-b", "cancelled"]] as const) {
        const state = { status, taskIds: [] };
        emit("workflow.node_changed", { nodeId, from: draft.nodes[nodeId]!.status, state });
        draft.nodes[nodeId] = state;
      }
      emit("workflow.status_changed", { from: draft.status, to: "failed" });
      draft.status = "failed";
    });

    run = (await controller.advance(planned.id, approvalsFor(controller.status(planned.id)))).run;
    expect(run.status).toBe("recovery_required");
    expect(run.error).toBe("workflow_compensation_incomplete:undo-b");
    expect(done).toEqual(["a", "b"]);
  });

  it("reads a denied branch the same way after a restart", async () => {
    const { controller, store, tasks, cipher, done } = await setup();
    const planned = controller.plan(fanOut());
    const [a, b] = await waitingOnBoth(controller, planned.id);
    tasks.cancel(a);

    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    let run = restarted.status(planned.id);
    expect(run.nodes.fan?.status).toBe("cancelled");
    expect(run.status).toBe("failed");
    const other = tasks.status(b).approval!;
    for (let step = 0; step < 3 && run.nodes.refund?.status !== "compensated"; step += 1) {
      run = (await restarted.advance(planned.id, [
        ...approvalsFor(run),
        { approvalId: other.approvalId, phrase: other.phrase! },
      ])).run;
    }
    expect(done).toEqual(["pay", "refund"]);
  });
});

describe("loops across a restart", () => {
  const loop = (extra: unknown[] = []) =>
    workflow([
      {
        id: "loop",
        type: "bounded_loop",
        maxIterations: 3,
        until: { type: "file_exists", path: "done.flag" },
        body: [put("step")],
      },
      ...extra,
    ]);

  it("keeps a waiting loop's place, so an approved step still runs", async () => {
    const { controller, root, store, tasks, cipher, done } = await setup();
    const planned = controller.plan(loop());
    let run = (await controller.advance(planned.id)).run;
    run = (await controller.advance(planned.id, approvalsFor(run))).run;
    expect(run.nodes.loop).toMatchObject({ status: "awaiting_approval", iterations: 1 });
    // The world moves on while iteration 1 waits for its approval.
    await writeFile(join(root, "done.flag"), "x");
    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    // Restarted at iteration 0, the loop asked `until` of iteration 0's task,
    // stopped there, and the approved step never ran.
    run = (await restarted.advance(planned.id, approvalsFor(restarted.status(planned.id)))).run;
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["step", "step"]);
  });

  it("keeps the place of a loop with several steps, at each step it can wait on", async () => {
    for (const waiting of [0, 1]) {
      const { controller, root, store, tasks, cipher, done } = await setup();
      const planned = controller.plan(
        workflow([
          {
            id: "loop",
            type: "bounded_loop",
            maxIterations: 3,
            until: { type: "file_exists", path: "done.flag" },
            body: [put("a"), put("b")],
          },
        ]),
      );
      let run = (await controller.advance(planned.id)).run;
      // Approve through iteration 0 and up to the step under test in iteration 1.
      for (let step = 0; step < 2 + waiting; step += 1) {
        run = (await controller.advance(planned.id, approvalsFor(run))).run;
      }
      const live = run.nodes.loop!;
      expect(live).toMatchObject({ status: "awaiting_approval", iterations: 1 });
      await writeFile(join(root, "done.flag"), "x");
      const restarted = new WorkflowController(store, tasks, cipher);
      await restarted.recoverInterrupted();
      const recovered = restarted.status(planned.id).nodes.loop!;
      expect([recovered.iterations, recovered.taskIds]).toEqual([live.iterations, live.taskIds]);
      run = restarted.status(planned.id);
      for (let step = 0; step < 4 && run.status !== "verified_complete"; step += 1) {
        run = (await restarted.advance(planned.id, approvalsFor(run))).run;
      }
      expect(run.status).toBe("verified_complete");
      expect(done).toEqual(["a", "b", "a", "b"]);
    }
  });

  it("finishes a loop that an older recovery recorded finished halfway", async () => {
    // alpha.12's recovery recorded whatever tasks it found as a finished
    // loop. One without `until` finishes only at maxIterations, so that record
    // is short, and is downgraded rather than trusted.
    const { controller, store, tasks, cipher, done } = await setup();
    const planned = controller.plan(
      workflow([{ id: "loop", type: "bounded_loop", maxIterations: 2, body: [put("a")] }]),
    );
    let run = (await controller.advance(planned.id)).run;
    run = (await controller.advance(planned.id, approvalsFor(run))).run;
    const [first, second] = run.nodes.loop!.taskIds;
    // As if the process died before planning iteration 1.
    store.database.prepare("DELETE FROM tasks WHERE id = ?").run(second!);
    type Emit = (type: string, data: Record<string, unknown>) => void;
    const legacy = controller as unknown as {
      transition(run: WorkflowRun, change: (draft: WorkflowRun, emit: Emit) => void): WorkflowRun;
    };
    legacy.transition(run, (draft, emit) => {
      const state = { status: "verified_complete" as const, taskIds: [first!], iterations: 1 };
      emit("workflow.node_changed", { nodeId: "loop", from: draft.nodes.loop!.status, state });
      draft.nodes.loop = state;
    });

    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    expect(restarted.status(planned.id).nodes.loop?.status).toBe("pending");
    run = restarted.status(planned.id);
    for (let step = 0; step < 4 && run.status !== "verified_complete"; step += 1) {
      run = (await restarted.advance(planned.id, approvalsFor(run))).run;
    }
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["a", "a"]);
  });

  it("finishes a loop with until that an older recovery recorded finished mid-iteration", async () => {
    // The live path checks `until` only after a whole iteration, so a loop
    // recorded finished after a0 alone came from a legacy recovery.
    const { controller, store, tasks, cipher, done } = await setup();
    const planned = controller.plan(
      workflow([
        {
          id: "loop",
          type: "bounded_loop",
          maxIterations: 2,
          until: { type: "file_exists", path: "done.flag" },
          body: [put("a"), put("b")],
        },
      ]),
    );
    let run = (await controller.advance(planned.id)).run;
    run = (await controller.advance(planned.id, approvalsFor(run))).run;
    const [first, second] = run.nodes.loop!.taskIds;
    store.database.prepare("DELETE FROM tasks WHERE id = ?").run(second!);
    type Emit = (type: string, data: Record<string, unknown>) => void;
    const legacy = controller as unknown as {
      transition(run: WorkflowRun, change: (draft: WorkflowRun, emit: Emit) => void): WorkflowRun;
    };
    legacy.transition(run, (draft, emit) => {
      const state = { status: "verified_complete" as const, taskIds: [first!], iterations: 1 };
      emit("workflow.node_changed", { nodeId: "loop", from: draft.nodes.loop!.status, state });
      draft.nodes.loop = state;
    });

    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    run = restarted.status(planned.id);
    for (let step = 0; step < 6 && run.status !== "verified_complete"; step += 1) {
      run = (await restarted.advance(planned.id, approvalsFor(run))).run;
    }
    expect(done.slice(0, 2)).toEqual(["a", "b"]);
  });

  it("keeps a condition that chose an empty branch, whatever its predicate says now", async () => {
    const { controller, root, store, tasks, cipher, done } = await setup();
    const planned = controller.plan(
      workflow([
        { id: "inspect", type: "operation", request: read() },
        {
          id: "choose",
          type: "condition",
          dependsOn: ["inspect"],
          sourceNodeId: "inspect",
          predicate: { type: "file_exists", path: "flag" },
          whenTrue: [put("taken")],
          whenFalse: [],
        },
        { id: "after", type: "operation", dependsOn: ["choose"], request: put("after") },
      ]),
    );
    let run = (await controller.advance(planned.id)).run;
    for (let step = 0; step < 3 && run.nodes.after?.status !== "awaiting_approval"; step += 1) {
      run = (await controller.advance(planned.id, approvalsFor(run))).run;
    }
    expect(run.nodes.choose).toMatchObject({ status: "verified_complete", taskIds: [] });
    await writeFile(join(root, "flag"), "x");
    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    run = restarted.status(planned.id);
    for (let step = 0; step < 4 && run.status !== "verified_complete"; step += 1) {
      run = (await restarted.advance(planned.id, approvalsFor(run))).run;
    }
    expect(run.status).toBe("verified_complete");
    // The branch not taken stays not taken.
    expect(done).toEqual(["after"]);
  });

  it("does not reopen a loop that finished early on until", async () => {
    const { controller, root, store, tasks, cipher, done } = await setup();
    await writeFile(join(root, "done.flag"), "x");
    const planned = controller.plan(
      loop([{ id: "after", type: "operation", dependsOn: ["loop"], request: put("after") }]),
    );
    let run = (await controller.advance(planned.id)).run;
    run = (await controller.advance(planned.id, approvalsFor(run))).run;
    expect(run.nodes.loop).toMatchObject({ status: "verified_complete", iterations: 1 });
    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    expect(restarted.status(planned.id).nodes.loop?.status).toBe("verified_complete");
    // Reopened, the loop would ask `until` again of a world that changed.
    await unlink(join(root, "done.flag"));
    run = restarted.status(planned.id);
    for (let step = 0; step < 4 && run.status !== "verified_complete"; step += 1) {
      run = (await restarted.advance(planned.id, approvalsFor(run))).run;
    }
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["step", "after"]);
  });
});

describe("operator halts", () => {
  it("pauses a run that needs recovery and resumes it still needing it", async () => {
    const { controller, store, tasks, cipher } = await setup();
    const planned = controller.plan(workflow([{ id: "write", type: "operation", request: put("write") }]));
    const waiting = (await controller.advance(planned.id)).run;
    const task = store.getTask(waiting.nodes.write!.taskIds[0]!)!;
    task.status = "running";
    store.saveTask(task);
    const restarted = new WorkflowController(store, tasks, cipher);
    const [recovered] = await restarted.recoverInterrupted();
    expect(recovered?.status).toBe("recovery_required");
    // Threw workflow_projection_event_mismatch: the halt dropped the error.
    expect(restarted.pause(planned.id).status).toBe("paused");
    const resumed = restarted.resume(planned.id);
    expect(resumed.status).toBe("recovery_required");
    expect(resumed.error).toBe("workflow_contains_unreconciled_mutation");
  });
});
