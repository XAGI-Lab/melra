// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskRequestSchema,
  WorkflowDefinitionSchema,
  outcomeUnknown,
  type Operation,
  type TaskRecord,
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
  vi.restoreAllMocks();
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
  // What a test does as a put runs: throws, or lands a pause.
  const on: { put?: (key: string) => void } = {};
  const execute = async (operation: Operation): Promise<Record<string, unknown>> => {
    if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (operation.kind === "memory") {
      on.put?.(operation.key ?? "");
      done.push(operation.key ?? "");
    }
    return { success: true, stored: true };
  };
  const tasks = new TaskController(
    store,
    { ...createDefaultPolicy(root), ...options.policy },
    { execute },
    await Verifier.create(root),
    cipher,
  );
  return { root, store, cipher, tasks, done, on, controller: new WorkflowController(store, tasks, cipher) };
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

/**
 * An operator's pause landing under an advance, as it still can once the
 * advance's lease has lapsed (a laptop's sleep; a live lease refuses it,
 * #244): it takes the run over, and the advance stops with
 * workflow_lease_lost, its commit lost.
 */
const lapseAndPause = (controller: WorkflowController, store: SqliteStore, id: string) => {
  store.renewWorkflowLease(id, store.getWorkflowLease(id)!.owner, new Date(0).toISOString());
  controller.pause(id);
};

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

describe("a parallel branch's steps, in order (#245)", () => {
  it("does not start a branch's next step when the one before it fails", async () => {
    const { controller, done } = await setup({ policy: { unhinged: true } });
    // Its evidence cannot hold: a1 runs, and fails.
    const a1 = TaskRequestSchema.parse({ ...put("a1"), requiredEvidence: [{ type: "result_equals", path: "stored", value: false }] });
    const planned = controller.plan(workflow([{ id: "fan", type: "parallel", branches: [[a1, put("a2")], [put("b1")]] }]));
    const run = (await controller.advance(planned.id)).run;
    expect(run.nodes.fan?.status).toBe("failed");
    // The other branch runs to its end.
    expect([...done].sort()).toEqual(["a1", "b1"]);
  });

  it("does not run a branch's read-back while the write before it awaits approval", async () => {
    const { controller, store, done } = await setup();
    const planned = controller.plan(workflow([{ id: "fan", type: "parallel", branches: [[put("w"), read()], [read()]] }]));
    const first = await controller.advance(planned.id);
    expect(first.run.nodes.fan?.status).toBe("awaiting_approval");
    // Only the other branch's read ran.
    expect(first.tasks.filter((task) => task.request.operation.kind === "system")).toHaveLength(1);
    let run = first.run;
    for (let step = 0; step < 4 && run.status !== "verified_complete"; step += 1) {
      run = (await controller.advance(planned.id, approvalsFor(run))).run;
    }
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["w"]);
    // Each read once: the other branch's is not run again beside the read-back.
    expect(store.listTasks(10).filter((task) => task.request.operation.kind === "system")).toHaveLength(2);
  });

  it("carries a branch on after an advance lost its commit between its steps", async () => {
    const { controller, store, done, on } = await setup({ policy: { unhinged: true } });
    const planned = controller.plan(workflow([{ id: "fan", type: "parallel", branches: [[put("a1"), put("a2")], [put("b1")]] }]));
    // The pause lands as a1 runs, so the advance stops before a2.
    on.put = (key) => {
      if (key !== "a1") return;
      delete on.put;
      lapseAndPause(controller, store, planned.id);
    };
    await expect(controller.advance(planned.id)).rejects.toThrow("workflow_lease_lost");
    controller.resume(planned.id);
    let run = controller.status(planned.id);
    for (let step = 0; step < 4 && run.status !== "verified_complete"; step += 1) {
      run = (await controller.advance(planned.id)).run;
    }
    // Recovered as complete, a2 never ran.
    expect(run.status).toBe("verified_complete");
    expect([...done].sort()).toEqual(["a1", "a2", "b1"]);
  });

  it("leaves a node pending, not complete, when a branch's next step fails to plan", async () => {
    const { controller, tasks, done } = await setup({ policy: { unhinged: true } });
    const planned = controller.plan(workflow([{ id: "fan", type: "parallel", branches: [[put("a1"), put("a2")], [put("b1")]] }]));
    // A transient store error planning a2, once: a1 and b1 have run.
    const plan = tasks.plan.bind(tasks);
    let thrown = false;
    vi.spyOn(tasks, "plan").mockImplementation((request, options) => {
      if (!thrown && request.goal === "Put a2") {
        thrown = true;
        throw new Error("database is locked");
      }
      return plan(request, options);
    });
    await expect(controller.advance(planned.id)).rejects.toThrow("database is locked");
    expect(controller.status(planned.id).nodes.fan?.status).toBe("pending");
    expect([...done].sort()).toEqual(["a1", "b1"]);

    const run = (await controller.advance(planned.id)).run;
    expect(run.status).toBe("verified_complete");
    // a2 runs once, the others not again.
    expect([...done].sort()).toEqual(["a1", "a2", "b1"]);
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
  it("keeps only the committed condition branch and cancels the abandoned challenge", async () => {
    const { controller, store, tasks, cipher, done } = await setup();
    const planned = controller.plan(
      workflow([
        { id: "inspect", type: "operation", request: read() },
        {
          id: "choose",
          type: "condition",
          dependsOn: ["inspect"],
          sourceNodeId: "inspect",
          predicate: { type: "result_equals", path: "success", value: true },
          whenTrue: [put("patch"), put("patch2")],
          whenFalse: [put("create")],
        },
      ]),
    );
    await controller.advance(planned.id);
    const trueKey = sha256({ workflowId: planned.id, nodeId: "choose", iteration: 0, branch: "true:0", request: put("patch") });
    const falseKey = sha256({ workflowId: planned.id, nodeId: "choose", iteration: 0, branch: "false:0", request: put("create") });
    const abandoned = tasks.plan(put("patch"), { idempotencyKey: trueKey, attempt: 1, stored: true });
    const committed = tasks.plan(put("create"), { idempotencyKey: falseKey, attempt: 1, stored: true });
    await tasks.execute(committed.id, {
      approvalId: committed.approval!.approvalId,
      phrase: committed.approval!.phrase!,
    });

    const restarted = new WorkflowController(store, tasks, cipher);
    const [recovered] = await restarted.recoverInterrupted();
    expect(recovered?.nodes.choose).toMatchObject({ status: "verified_complete", taskIds: [committed.id] });
    expect(tasks.status(abandoned.id).status).toBe("cancelled");
    expect(done).toEqual(["create"]);
  });

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

describe("a condition's branch not taken (#268)", () => {
  // inspect, then a branch on the flag file, then a step after it.
  const choice = (whenTrue: TaskRequest[], whenFalse: TaskRequest[]) =>
    workflow([
      { id: "inspect", type: "operation", request: read() },
      {
        id: "choose",
        type: "condition",
        dependsOn: ["inspect"],
        sourceNodeId: "inspect",
        predicate: { type: "file_exists", path: "flag" },
        whenTrue,
        whenFalse,
      },
      { id: "after", type: "operation", dependsOn: ["choose"], request: put("after") },
    ]);
  /** An advance that plans a challenge, under which an operator's pause lands before it commits. */
  const losingCommit = async (controller: WorkflowController, store: SqliteStore, tasks: TaskController, id: string) => {
    const plan = tasks.plan.bind(tasks);
    let planned: TaskRecord | undefined;
    vi.spyOn(tasks, "plan").mockImplementationOnce((request, options) => {
      const task = plan(request, options);
      planned = task;
      lapseAndPause(controller, store, id);
      return task;
    });
    await expect(controller.advance(id)).rejects.toThrow("workflow_lease_lost");
    expect(controller.status(id).nodes.choose).toMatchObject({ status: "pending", taskIds: [] });
    controller.resume(id);
    return planned!;
  };
  const settle = async (controller: WorkflowController, id: string) => {
    let run = (await controller.advance(id)).run;
    for (let step = 0; step < 6 && !["verified_complete", "recovery_required", "failed"].includes(run.status); step += 1) {
      run = (await controller.advance(id, approvalsFor(run))).run;
    }
    return run;
  };

  it("cancels the challenge a lost advance left on the branch it then did not take", async () => {
    const { controller, root, store, tasks, done } = await setup();
    await writeFile(join(root, "flag"), "on");
    const planned = controller.plan(choice([put("patch"), put("patch2")], [put("create")]));
    await controller.advance(planned.id);
    const abandoned = await losingCommit(controller, store, tasks, planned.id);
    expect(abandoned.status).toBe("awaiting_approval");
    await unlink(join(root, "flag"));

    const run = await settle(controller, planned.id);
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["create", "after"]);
    // It stayed approvable once the run had finished, and approving it ran patch.
    expect(tasks.status(abandoned.id).status).toBe("cancelled");
    await tasks
      .execute(abandoned.id, { approvalId: abandoned.approval!.approvalId, phrase: abandoned.approval!.phrase! })
      .catch(() => undefined);
    expect(done).toEqual(["create", "after"]);
  });

  it("keeps an empty branch it took across a restart, not the one a lost advance started", async () => {
    const { controller, root, store, tasks, cipher, done } = await setup();
    const planned = controller.plan(choice([], [put("create")]));
    await controller.advance(planned.id);
    // Decided false, and create's challenge planned; the pause lost it.
    const abandoned = await losingCommit(controller, store, tasks, planned.id);
    await writeFile(join(root, "flag"), "on");
    let run = (await controller.advance(planned.id)).run;
    run = (await controller.advance(planned.id)).run;
    expect(run.nodes.choose).toMatchObject({ status: "verified_complete", taskIds: [] });
    expect(run.nodes.after?.status).toBe("awaiting_approval");

    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    run = restarted.status(planned.id);
    // Read as the branch with tasks, the condition reopened on create.
    expect(run.nodes.choose).toMatchObject({ status: "verified_complete", taskIds: [] });
    expect(tasks.status(abandoned.id).status).toBe("cancelled");
    run = (await restarted.advance(planned.id, approvalsFor(run))).run;
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["after"]);
  });

  it("halts on a step a lost advance ran on the other branch until it is reconciled as never applied", async () => {
    const { controller, root, store, tasks, cipher, done, on } = await setup({ policy: { unhinged: true } });
    await writeFile(join(root, "flag"), "on");
    // Its provider can say whether it happened: here, that it did not.
    const patch = TaskRequestSchema.parse({ ...put("patch"), reconciliation: [{ type: "file_exists", path: "patched" }] });
    const planned = controller.plan(choice([patch], [put("create")]));
    await controller.advance(planned.id);
    // The true branch runs patch, whose reply is lost, and the advance's
    // commit fails (a locked database). Not a pause: one that takes a lapsed
    // advance over leaves the run to recovery first (#244).
    on.put = (key) => {
      if (key === "patch") throw outcomeUnknown("socket hang up");
    };
    vi.spyOn(store, "transitionWorkflow").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await expect(controller.advance(planned.id)).rejects.toThrow("database is locked");
    const [unknown] = store.listTasks(10, "recovery_required");
    expect(controller.status(planned.id).nodes.choose).toMatchObject({ status: "pending", taskIds: [] });
    await unlink(join(root, "flag"));

    // Read false now, the condition ran create beside a patch that may stand.
    let run = (await controller.advance(planned.id)).run;
    expect(run.nodes.choose).toMatchObject({
      status: "recovery_required",
      taskIds: [unknown!.id],
      error: "workflow_condition_branch_conflict",
    });
    expect(run.status).toBe("recovery_required");
    expect(run.error).toBe("workflow_condition_branch_conflict:choose");
    expect(done).toEqual([]);

    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    expect(restarted.status(planned.id).nodes.choose?.error).toBe("workflow_condition_branch_conflict");
    // Reconciled, it never happened: the condition is decided again and the run moves on.
    expect((await tasks.execute(unknown!.id)).task.error).toBe("reconciliation_confirms_effect_not_applied");
    run = await settle(restarted, planned.id);
    expect(run.status).toBe("verified_complete");
    expect(run.nodes.choose?.taskIds).toHaveLength(1);
    expect(done).toEqual(["create", "after"]);
  });

  it("carries on with the committed branch once a step on the other is reconciled as never applied", async () => {
    const { controller, store, tasks, cipher, done, on } = await setup();
    const patch = TaskRequestSchema.parse({ ...put("patch"), reconciliation: [{ type: "file_exists", path: "patched" }] });
    const planned = controller.plan(choice([patch], [put("create")]));
    await controller.advance(planned.id);
    const key = (branch: string, request: TaskRequest) =>
      sha256({ workflowId: planned.id, nodeId: "choose", iteration: 0, branch, request });
    // Advances that lost their commits ran both: patch, whose reply was
    // lost, and create.
    on.put = (name) => {
      if (name === "patch") throw outcomeUnknown("socket hang up");
    };
    for (const [branch, request] of [["true:0", patch], ["false:0", put("create")]] as const) {
      const task = tasks.plan(request, { idempotencyKey: key(branch, request), attempt: 1, stored: true });
      await tasks.execute(task.id, { approvalId: task.approval!.approvalId, phrase: task.approval!.phrase! });
    }
    const [unknown] = store.listTasks(10, "recovery_required");
    const created = store.getIdempotencyCommit(key("false:0", put("create")));

    const restarted = new WorkflowController(store, tasks, cipher);
    const [recovered] = await restarted.recoverInterrupted();
    expect(recovered?.nodes.choose).toMatchObject({
      status: "recovery_required",
      taskIds: [unknown!.id],
      error: "workflow_condition_branch_conflict",
    });
    expect(recovered?.error).toBe("workflow_condition_branch_conflict:choose");
    // Settled as never applied, it was still read as a conflict, for good.
    expect((await tasks.execute(unknown!.id)).task.error).toBe("reconciliation_confirms_effect_not_applied");
    const run = await settle(restarted, planned.id);
    expect(run.status).toBe("verified_complete");
    expect(run.nodes.choose?.taskIds).toEqual([created!.taskId]);
    expect(done).toEqual(["create", "after"]);
  });

  it("finds a step's task by its key where the run names another branch's or another step's", async () => {
    const { controller, tasks, done } = await setup();
    const planned = controller.plan(choice([put("patch")], [put("create"), put("register")]));
    await controller.advance(planned.id);
    const key = (branch: string, request: TaskRequest) =>
      sha256({ workflowId: planned.id, nodeId: "choose", iteration: 0, branch, request });
    const patch = tasks.plan(put("patch"), { idempotencyKey: key("true:0", put("patch")), attempt: 1, stored: true });
    const create = tasks.plan(put("create"), { idempotencyKey: key("false:0", put("create")), attempt: 1, stored: true });
    await tasks.execute(create.id, { approvalId: create.approval!.approvalId, phrase: create.approval!.phrase! });
    // What an earlier version's recovery recorded: both branches' tasks, in key order.
    type Emit = (type: string, data: Record<string, unknown>) => void;
    const legacy = controller as unknown as {
      transition(run: WorkflowRun, change: (draft: WorkflowRun, emit: Emit) => void): WorkflowRun;
    };
    legacy.transition(controller.status(planned.id), (draft, emit) => {
      const state = { status: "awaiting_approval" as const, taskIds: [patch.id, create.id], approval: patch.approval! };
      emit("workflow.node_changed", { nodeId: "choose", from: draft.nodes.choose!.status, state });
      draft.nodes.choose = state;
      emit("workflow.status_changed", { from: draft.status, to: "awaiting_approval" });
      draft.status = "awaiting_approval";
    });

    let run = (await controller.advance(planned.id)).run;
    // Not a new challenge for create, which already ran, nor a halt on the
    // committed create recorded where register belongs.
    const [first, second] = run.nodes.choose!.taskIds;
    expect(first).toBe(create.id);
    expect(tasks.status(second!).request.operation).toMatchObject({ key: "register" });
    expect(tasks.status(patch.id).status).toBe("cancelled");
    for (let step = 0; step < 4 && run.status !== "verified_complete"; step += 1) {
      run = (await controller.advance(planned.id, approvalsFor(run))).run;
    }
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["create", "register", "after"]);
  });

  it("does not drop a challenge on the other branch whose cancel did not land", async () => {
    const { controller, store, tasks, cipher, done } = await setup();
    const planned = controller.plan(choice([put("patch")], [put("create")]));
    await controller.advance(planned.id);
    const key = (branch: string, request: TaskRequest) =>
      sha256({ workflowId: planned.id, nodeId: "choose", iteration: 0, branch, request });
    const abandoned = tasks.plan(put("patch"), { idempotencyKey: key("true:0", put("patch")), attempt: 1, stored: true });
    const committed = tasks.plan(put("create"), { idempotencyKey: key("false:0", put("create")), attempt: 1, stored: true });
    await tasks.execute(committed.id, { approvalId: committed.approval!.approvalId, phrase: committed.approval!.phrase! });
    // An approver starts it through melra_execute as recovery goes to cancel it.
    vi.spyOn(tasks, "cancel").mockImplementationOnce((taskId) => {
      store.saveTask({ ...tasks.status(taskId), status: "running" });
      return tasks.status(taskId);
    });

    const restarted = new WorkflowController(store, tasks, cipher);
    const [recovered] = await restarted.recoverInterrupted();
    // Taken as cancelled, it ran under a run recovered as finished.
    expect(recovered?.nodes.choose).toMatchObject({
      status: "recovery_required",
      taskIds: [abandoned.id],
      error: "workflow_condition_branch_conflict",
    });
    expect(recovered?.status).toBe("recovery_required");
    expect(done).toEqual(["create"]);
  });

  it.each([
    ["failed", undefined],
    ["budget_exhausted", 100],
  ] as const)("carries on past a step a lost advance ran on the other branch that ended %s", async (status, maxDurationMs) => {
    // Slower than patch's budget, so its timer has fired by the time it throws.
    const { controller, root, store, done, on } = await setup({ delayMs: 150, policy: { unhinged: true } });
    await writeFile(join(root, "flag"), "on");
    const patch = TaskRequestSchema.parse({ ...put("patch"), ...(maxDurationMs === undefined ? {} : { budget: { maxDurationMs } }) });
    const planned = controller.plan(choice([patch], [put("create")]));
    await controller.advance(planned.id);
    // The adapter says patch did not happen; a pause lands meanwhile.
    on.put = (key) => {
      if (key !== "patch") return;
      lapseAndPause(controller, store, planned.id);
      throw new Error("patch_refused");
    };
    await expect(controller.advance(planned.id)).rejects.toThrow("workflow_lease_lost");
    delete on.put;
    expect(store.listTasks(10, status)).toHaveLength(1);
    controller.resume(planned.id);
    await unlink(join(root, "flag"));

    // Read as an effect that may stand, it halted the run for good.
    const run = await settle(controller, planned.id);
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["create", "after"]);
  });

  it.each([false, true])(
    "halts on a step a lost advance ran on the other branch that took effect but failed its evidence (restart first: %s)",
    async (restartFirst) => {
      const { controller, root, store, tasks, cipher, done, on } = await setup({ policy: { unhinged: true } });
      await writeFile(join(root, "flag"), "on");
      // Its effect ran, its evidence did not hold: partial, which nothing reconciles.
      const patch = TaskRequestSchema.parse({ ...put("patch"), requiredEvidence: [{ type: "result_equals", path: "stored", value: false }] });
      const planned = controller.plan(choice([patch], [put("create")]));
      await controller.advance(planned.id);
      on.put = (key) => {
        if (key === "patch") lapseAndPause(controller, store, planned.id);
      };
      await expect(controller.advance(planned.id)).rejects.toThrow("workflow_lease_lost");
      delete on.put;
      const [partial] = store.listTasks(10, "partial");
      controller.resume(planned.id);
      await unlink(join(root, "flag"));

      let current = controller;
      if (restartFirst) {
        current = new WorkflowController(store, tasks, cipher);
        await current.recoverInterrupted();
      }
      // Read by recovery as the condition's own step, failed, the run unwound
      // after a restart where without one it halted.
      const run = await settle(current, planned.id);
      expect(run.status).toBe("recovery_required");
      expect(run.error).toBe("workflow_condition_branch_conflict:choose");
      expect(run.nodes.choose?.taskIds).toEqual([partial!.id]);
      expect(done).toEqual(["patch"]);
    },
  );

  it("cancels with the run a challenge a lost advance left on an operation, and no other run's", async () => {
    const { controller, store, tasks, done } = await setup();
    const planned = controller.plan(workflow([{ id: "op", type: "operation", request: put("op") }]));
    const other = controller.plan(workflow([{ id: "op", type: "operation", request: put("op") }]));
    const waiting = (await controller.advance(other.id)).run.nodes.op!.taskIds[0]!;
    const plan = tasks.plan.bind(tasks);
    let leftover: TaskRecord | undefined;
    vi.spyOn(tasks, "plan").mockImplementationOnce((request, options) => {
      const task = plan(request, options);
      leftover = task;
      lapseAndPause(controller, store, planned.id);
      return task;
    });
    await expect(controller.advance(planned.id)).rejects.toThrow("workflow_lease_lost");
    controller.resume(planned.id);
    expect(controller.status(planned.id).nodes.op).toMatchObject({ status: "pending", taskIds: [] });
    expect(controller.cancel(planned.id).status).toBe("cancelled");
    // Left approvable, approving it ran the step on a cancelled run.
    expect(tasks.status(leftover!.id).status).toBe("cancelled");
    expect(tasks.status(waiting).status).toBe("awaiting_approval");
    expect(done).toEqual([]);
  });

  it("reports a sweep that fails once the run is cancelled, so cancelling again sweeps", async () => {
    const { controller, store, tasks, done } = await setup();
    const planned = controller.plan(workflow([{ id: "op", type: "operation", request: put("op") }]));
    const plan = tasks.plan.bind(tasks);
    let leftover: TaskRecord | undefined;
    vi.spyOn(tasks, "plan").mockImplementationOnce((request, options) => {
      const task = plan(request, options);
      leftover = task;
      lapseAndPause(controller, store, planned.id);
      return task;
    });
    await expect(controller.advance(planned.id)).rejects.toThrow("workflow_lease_lost");
    controller.resume(planned.id);
    const cancel = tasks.cancel.bind(tasks);
    vi.spyOn(tasks, "cancel").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    // Swallowed, the run read cancelled with the challenge still approvable,
    // and a second cancel returned early without sweeping. The sweep comes
    // after the run's commit, which a step's own task waits for.
    expect(() => controller.cancel(planned.id)).toThrow("database is locked");
    expect(controller.status(planned.id).status).toBe("cancelled");
    expect(tasks.status(leftover!.id).status).toBe("awaiting_approval");
    vi.mocked(tasks.cancel).mockImplementation(cancel);
    expect(controller.cancel(planned.id).status).toBe("cancelled");
    expect(tasks.status(leftover!.id).status).toBe("cancelled");
    expect(done).toEqual([]);
  });

  it("cancels no step's task when the run's cancel does not commit", async () => {
    const { controller, store, tasks, done } = await setup();
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
    const waiting = run.nodes.next!.taskIds[0]!;
    vi.spyOn(store, "transitionWorkflow").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    expect(() => controller.cancel(planned.id)).toThrow("database is locked");
    // Cancelled anyway, the challenge read as a denial on the run that went
    // on: it failed and offered the refund.
    expect(tasks.status(waiting).status).toBe("awaiting_approval");
    run = (await controller.advance(planned.id)).run;
    expect(run.status).toBe("awaiting_approval");
    expect(run.nodes.next?.taskIds).toEqual([waiting]);
    expect(controller.cancel(planned.id).status).toBe("cancelled");
    expect(tasks.status(waiting).status).toBe("cancelled");
    expect(done).toEqual(["pay"]);
  });

  it("ends a run whose definition can no longer be opened", async () => {
    const { controller, store, root } = await setup();
    await writeFile(join(root, "flag"), "on");
    const planned = controller.plan(choice([put("ship")], [put("other")]));
    await controller.advance(planned.id);
    controller.pause(planned.id);
    (store as unknown as { database: { prepare(sql: string): { run(): void } } }).database
      .prepare("DELETE FROM workflow_payloads")
      .run();
    expect(controller.cancel(planned.id).status).toBe("cancelled");
  });

  it("ends a run whose event history no longer replays, and still cancels what a lost advance left", async () => {
    const { controller, store, tasks, done } = await setup();
    const planned = controller.plan(workflow([{ id: "op", type: "operation", request: put("op") }]));
    const plan = tasks.plan.bind(tasks);
    let leftover: TaskRecord | undefined;
    vi.spyOn(tasks, "plan").mockImplementationOnce((request, options) => {
      const task = plan(request, options);
      leftover = task;
      lapseAndPause(controller, store, planned.id);
      return task;
    });
    await expect(controller.advance(planned.id)).rejects.toThrow("workflow_lease_lost");
    store.database.prepare("UPDATE workflow_events SET data = '{}' WHERE aggregate_id = ?").run(planned.id);
    // Recovery fails closed on it, and so did every cancel: the run could never end.
    expect(() => controller.cancel(planned.id)).not.toThrow();
    expect(controller.status(planned.id).status).toBe("cancelled");
    expect(tasks.status(leftover!.id).status).toBe("cancelled");
    expect(done).toEqual([]);
  });

  it("cancels with the run a challenge a lost advance left on a condition a restart left undecided", async () => {
    const { controller, root, store, tasks, cipher, done } = await setup();
    await writeFile(join(root, "flag"), "on");
    const planned = controller.plan(choice([put("ship")], [put("other")]));
    await controller.advance(planned.id);
    const challenge = await losingCommit(controller, store, tasks, planned.id);
    expect(challenge.status).toBe("awaiting_approval");

    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    // Not the condition's: adopted, it would follow ship's branch unasked.
    expect(restarted.status(planned.id).nodes.choose).toMatchObject({ status: "pending", taskIds: [] });
    expect(restarted.cancel(planned.id).status).toBe("cancelled");
    // Left approvable, approving it ran ship on a cancelled run.
    expect(tasks.status(challenge.id).status).toBe("cancelled");
    await expect(
      tasks.execute(challenge.id, { approvalId: challenge.approval!.approvalId, phrase: challenge.approval!.phrase! }),
    ).rejects.toThrow("task_not_executable:cancelled");
    expect(done).toEqual([]);
  });
});

describe("a condition step a lost advance left unknown (#270)", () => {
  // Pay, then a branch beside a step that fails; refunding pays back.
  const definition = () =>
    workflow([
      { id: "pay", type: "operation", request: put("pay") },
      {
        id: "choose",
        type: "condition",
        dependsOn: ["pay"],
        sourceNodeId: "pay",
        predicate: { type: "file_exists", path: "flag" },
        whenTrue: [put("ship")],
        whenFalse: [put("other")],
      },
      {
        id: "x",
        type: "operation",
        dependsOn: ["pay"],
        request: TaskRequestSchema.parse({ ...put("x"), requiredEvidence: [{ type: "result_equals", path: "stored", value: false }] }),
      },
      { id: "refund", type: "compensation", forNodeId: "pay", request: put("refund") },
    ]);

  it("halts after a restart rather than unwind past it when a pause lost its commit", async () => {
    const { controller, root, store, tasks, cipher, done, on } = await setup({ policy: { unhinged: true } });
    await writeFile(join(root, "flag"), "on");
    const planned = controller.plan(definition());
    await controller.advance(planned.id);
    on.put = (key) => {
      if (key !== "ship") return;
      lapseAndPause(controller, store, planned.id);
      throw outcomeUnknown("socket hang up");
    };
    await expect(controller.advance(planned.id)).rejects.toThrow("workflow_lease_lost");
    delete on.put;
    const [ship] = store.listTasks(10, "recovery_required");
    controller.resume(planned.id);

    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    // Left pending, x's failure read as the run's and refund ran while ship may have shipped.
    expect(restarted.status(planned.id).nodes.choose).toMatchObject({ status: "recovery_required", taskIds: [ship!.id] });
    const run = (await restarted.advance(planned.id)).run;
    expect(run.status).toBe("recovery_required");
    expect(done).toEqual(["pay", "x"]);
  });

  it("halts after a crash rather than unwind past it", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-workflow-correctness-"));
    roots.push(root);
    await writeFile(join(root, "flag"), "on");
    const path = join(root, "melra.sqlite");
    const cipher = new PayloadCipher(Buffer.alloc(32, 23));
    const done: string[] = [];
    let entered!: () => void;
    const shipping = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const side = async (store: SqliteStore, hangOnShip: boolean) =>
      new TaskController(
        store,
        { ...createDefaultPolicy(root), unhinged: true },
        {
          execute: async (operation: Operation) => {
            if (operation.kind === "memory") {
              if (hangOnShip && operation.key === "ship") {
                entered();
                await new Promise(() => undefined);
              }
              done.push(operation.key ?? "");
            }
            return { success: true, stored: true };
          },
        },
        await Verifier.create(root),
        cipher,
      );
    // A short lease, so the next process need not wait long for the dead one's.
    const storeA = new SqliteStore(path);
    const a = new WorkflowController(storeA, await side(storeA, true), cipher, 200);
    const planned = a.plan(definition());
    await a.advance(planned.id);
    void a.advance(planned.id).catch(() => undefined);
    await shipping;
    await vi.waitFor(() => expect(storeA.listTasks(10, "partial")).toHaveLength(1));
    storeA.close();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const storeB = new SqliteStore(path);
    stores.push(storeB);
    const b = new WorkflowController(storeB, await side(storeB, false), cipher);
    await b.recoverInterrupted();
    expect(b.status(planned.id).status).toBe("recovery_required");
    const run = (await b.advance(planned.id)).run;
    expect(run.status).toBe("recovery_required");
    expect(done).toEqual(["pay", "x"]);
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
    const { controller, tasks, done } = await setup();
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

    run = (await controller.advance(planned.id)).run;
    // Asking the predicate again chose the other branch and ran it too. Now
    // the committed branch is kept and its step found by its key, where it
    // was planned again: a second challenge for an effect already done.
    expect(run.nodes.choose?.taskIds).toEqual([ran.id]);
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["patch"]);
  });

  it("takes up a loop's iterations that ran past its record, and asks until only of the last", async () => {
    const { controller, tasks, done, root } = await setup();
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
    for (let step = 0; step < 3 && run.status !== "verified_complete"; step += 1) {
      run = (await controller.advance(planned.id, approvalsFor(run))).run;
    }
    // Reusing iteration 0 and asking `until` of a workspace iteration 1 had
    // changed cut the loop short, and `after` ran on it. Planning iteration 0
    // afresh halted the run on a duplicate until recovery came. Both are
    // taken up, and `until` is asked of the last.
    expect(run.status).toBe("verified_complete");
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
    // An advance planned next's challenge and lost its commit to a pause; an
    // earlier version's next advance planned it again, under the same key and
    // attempt, and this one takes up the newer.
    const key = sha256({ workflowId: planned.id, nodeId: "next", iteration: 0, branch: "operation", request: put("next") });
    const stale = tasks.plan(put("next"), { idempotencyKey: key, attempt: 1, stored: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const live = tasks.plan(put("next"), { idempotencyKey: key, attempt: 1, stored: true }).id;
    run = (await controller.advance(planned.id)).run;
    expect(run.nodes.next?.taskIds).toEqual([live]);
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

describe("a halt or cancel while an advance runs a step (#244)", () => {
  it.each(["pause", "suspend", "cancel"] as const)(
    "refuses %s from this process or another until the advance has recorded its step",
    async (action) => {
      const { controller, store, tasks, cipher, done, on } = await setup({ policy: { unhinged: true } });
      const peer = new WorkflowController(store, tasks, cipher);
      const planned = controller.plan(
        workflow([
          { id: "a", type: "operation", request: put("a") },
          { id: "b", type: "operation", dependsOn: ["a"], request: put("b") },
        ]),
      );
      const refused: string[] = [];
      on.put = (key) => {
        if (key !== "a") return;
        for (const operator of [controller, peer]) {
          try {
            operator[action](planned.id);
          } catch (error) {
            refused.push((error as Error).message);
          }
        }
      };
      // Landed, it failed the advance's commit, and a ran with no task on the run.
      let run = (await controller.advance(planned.id)).run;
      expect(refused).toEqual(["workflow_lease_held", "workflow_lease_held"]);
      expect(run.nodes.a?.status).toBe("verified_complete");
      const ran = run.nodes.a!.taskIds;
      // Between advances it lands, and the run carries on from where it was.
      run = peer[action](planned.id);
      if (action !== "cancel") {
        peer.resume(planned.id);
        run = (await controller.advance(planned.id)).run;
      }
      expect(run.status).toBe(action === "cancel" ? "cancelled" : "verified_complete");
      expect(run.nodes.a).toMatchObject({ status: "verified_complete", taskIds: ran });
      expect(done).toEqual(action === "cancel" ? ["a"] : ["a", "b"]);
    },
  );

  it("takes over an advance whose lease lapsed, which stops before its next step, and is recovered first", async () => {
    const { controller, store, tasks, cipher, done, on } = await setup({ policy: { unhinged: true } });
    const peer = new WorkflowController(store, tasks, cipher);
    const planned = controller.plan(
      workflow([{ id: "loop", type: "bounded_loop", maxIterations: 2, body: [put("a")] }]),
    );
    on.put = () => {
      delete on.put;
      lapseAndPause(peer, store, planned.id);
    };
    // Paused beside the lease, the advance ran the next iteration on a paused run.
    await expect(controller.advance(planned.id)).rejects.toThrow("workflow_lease_lost");
    expect(done).toEqual(["a"]);
    // Left expired, as the advance left it: the run is recovered before it is advanced again.
    expect(store.expiredWorkflowLeases(new Date().toISOString())).toContain(planned.id);
    peer.resume(planned.id);
    const run = (await controller.advance(planned.id)).run;
    expect(run.status).toBe("verified_complete");
    expect(run.nodes.loop?.taskIds).toHaveLength(2);
    expect(done).toEqual(["a", "a"]);
  });

  it.each(["stalled mid-step", "a pause took over once it stalled", "died before its commit", "lost its commit"] as const)(
    "records on a run it cancels the step of an advance that %s",
    async (how) => {
      const { controller, store, tasks, cipher, done, on } = await setup({ policy: { unhinged: true } });
      const peer = new WorkflowController(store, tasks, cipher);
      const planned = controller.plan(
        workflow([
          { id: "a", type: "operation", request: put("a") },
          { id: "b", type: "operation", dependsOn: ["a"], request: put("b") },
        ]),
      );
      const lapse = () => store.renewWorkflowLease(planned.id, store.getWorkflowLease(planned.id)!.owner, new Date(0).toISOString());
      let cancelled: WorkflowRun | undefined;
      if (how === "died before its commit") {
        vi.spyOn(store, "transitionWorkflow").mockImplementationOnce(() => {
          throw new Error("killed");
        });
        // Its lease stays behind, and expires.
        vi.spyOn(store, "releaseWorkflowLease").mockImplementationOnce(() => undefined);
        await expect(controller.advance(planned.id)).rejects.toThrow("killed");
        lapse();
      } else if (how === "lost its commit") {
        vi.spyOn(store, "transitionWorkflow").mockImplementationOnce(() => {
          throw new Error("database is locked");
        });
        // Released on the way out, so the cancel takes no lease over.
        await expect(controller.advance(planned.id)).rejects.toThrow("database is locked");
        expect(store.getWorkflowLease(planned.id)).toBeUndefined();
      } else {
        on.put = () => {
          delete on.put;
          if (how === "stalled mid-step") {
            lapse();
            cancelled = peer.cancel(planned.id);
          } else lapseAndPause(peer, store, planned.id);
        };
        await expect(controller.advance(planned.id)).rejects.toThrow("workflow_lease_lost");
      }
      cancelled ??= peer.cancel(planned.id);
      await peer.recoverInterrupted();
      const [ran] = store.listTasks(10, "verified_success");
      // Cancelled as the run read, before anything recovered it: a never
      // named the task that ran, and nothing recovers a cancelled run.
      expect(cancelled.status).toBe("cancelled");
      // Stopped mid-step by the cancel, a step ignoring the stop is recorded as it ended.
      expect(peer.status(planned.id).nodes.a).toEqual({ status: "verified_complete", taskIds: [ran!.id] });
      expect(peer.status(planned.id).nodes.b).toEqual({ status: "cancelled", taskIds: [] });
      expect(done).toEqual(["a"]);
    },
  );

  it("records nothing of its own recovery but a step its approval ran when it cancels a run whose record is whole", async () => {
    const { controller, store, tasks } = await setup();
    const planned = controller.plan(
      workflow([
        { id: "pay", type: "operation", request: put("pay") },
        { id: "loop", type: "bounded_loop", dependsOn: ["pay"], maxIterations: 2, body: [put("l")] },
        { id: "par", type: "parallel", dependsOn: ["pay"], branches: [[put("p0")], [put("p1")]] },
        { id: "ask", type: "approval", dependsOn: ["pay"], forNodeId: "gated" },
        { id: "gated", type: "operation", dependsOn: ["ask"], request: put("gated") },
        { id: "refund", type: "compensation", forNodeId: "pay", request: put("refund") },
      ]),
    );
    let run = (await controller.advance(planned.id)).run;
    run = (await controller.advance(planned.id, approvalsFor(run))).run;
    run = (await controller.advance(planned.id)).run;
    // The loop's first iteration, one parallel branch and the approved step
    // run; the rest wait.
    const p0 = tasks.status(run.nodes.par!.taskIds[0]!).approval!;
    run = (
      await controller.advance(planned.id, [
        ...approvalsFor({ ...run, nodes: { loop: run.nodes.loop!, ask: run.nodes.ask! } }),
        { approvalId: p0.approvalId, phrase: p0.phrase! },
      ])
    ).run;
    expect(run.nodes.loop).toMatchObject({ status: "awaiting_approval", iterations: 1 });
    expect(run.nodes.loop!.taskIds).toHaveLength(2);
    expect(run.nodes.par?.status).toBe("awaiting_approval");
    expect(tasks.status(run.nodes.par!.taskIds[0]!).status).toBe("verified_success");
    // An approval runs its step's task; the step reads it on the next wave.
    expect(run.nodes.ask?.status).toBe("verified_complete");
    expect(run.nodes.gated).toEqual({ status: "pending", taskIds: [] });
    const cancelled = controller.cancel(planned.id);
    expect(store.listWorkflowEvents(planned.id, run.stateVersion).map(({ type, data }) => [type, data.nodeId])).toEqual([
      ["workflow.node_changed", "gated"],
      ["workflow.node_changed", "loop"],
      ["workflow.node_changed", "par"],
      ["workflow.node_changed", "refund"],
      ["workflow.cancelled", undefined],
    ]);
    // Done, as that wave would have recorded it; not cancelled, nor left pending.
    expect(cancelled.nodes.gated).toEqual({ status: "verified_complete", taskIds: run.nodes.ask!.taskIds });
    expect(cancelled.nodes.pay).toEqual(run.nodes.pay);
    expect(cancelled.nodes.loop).toEqual({ ...run.nodes.loop, status: "cancelled" });
    expect(cancelled.nodes.par).toEqual({ ...run.nodes.par, status: "cancelled" });
  });
});

describe("a step whose advance lost its commit (#319)", () => {
  // The run names none of the tasks an advance planned or ran when its commit
  // fails (a locked database), or when a pause landed under it before #244;
  // runs an earlier version left that way still have them.
  const failNextCommit = (store: SqliteStore) =>
    vi.spyOn(store, "transitionWorkflow").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
  const waiting = (store: SqliteStore) => store.listTasks(10, "awaiting_approval").map((task) => task.id).sort();

  it.each([
    ["an operation", [{ id: "step", type: "operation", request: put("step") }], ["step"]],
    [
      "an approval",
      [
        { id: "ask", type: "approval", forNodeId: "step" },
        { id: "step", type: "operation", dependsOn: ["ask"], request: put("step") },
      ],
      ["step"],
    ],
    ["a parallel branch", [{ id: "step", type: "parallel", branches: [[put("step")], [put("other")]] }], ["other", "step"]],
    ["a loop", [{ id: "step", type: "bounded_loop", maxIterations: 2, body: [put("step")] }], ["step", "step"]],
  ] as const)("offers the challenge it left on %s again, not a second one", async (_, nodes, effects) => {
    const { controller, store, done } = await setup();
    const planned = controller.plan(workflow([...nodes]));
    failNextCommit(store);
    await expect(controller.advance(planned.id)).rejects.toThrow("database is locked");
    const left = waiting(store);
    expect(left.length).toBeGreaterThan(0);
    expect(Object.values(controller.status(planned.id).nodes).every((node) => node.taskIds.length === 0)).toBe(true);

    let run = (await controller.advance(planned.id)).run;
    // Planned afresh: two challenges for each step, both approvable.
    expect(waiting(store)).toEqual(left);
    expect(Object.values(run.nodes).flatMap((node) => node.taskIds).sort()).toEqual(left);
    for (let step = 0; step < 6 && run.status !== "verified_complete"; step += 1) {
      run = (await controller.advance(planned.id, approvalsFor(run))).run;
    }
    expect(run.status).toBe("verified_complete");
    expect([...done].sort()).toEqual(effects);
  });

  // Its evidence fails: the effect happened, and nothing reconciles it.
  const partial = (key: string) =>
    TaskRequestSchema.parse({ ...put(key), requiredEvidence: [{ type: "result_equals", path: "stored", value: false }] });

  it.each([
    ["an operation that verified", [{ id: "a", type: "operation", request: put("a") }, { id: "b", type: "operation", dependsOn: ["a"], request: put("b") }], "a", "verified_complete"],
    ["an operation", [{ id: "step", type: "operation", request: partial("step") }], "step", "failed"],
    ["a parallel branch", [{ id: "step", type: "parallel", branches: [[partial("step")], [put("other")]] }], "step", "failed"],
    ["a loop", [{ id: "step", type: "bounded_loop", maxIterations: 2, body: [partial("step")] }], "step", "failed"],
    [
      "a compensation",
      [
        { id: "pay", type: "operation", request: put("pay") },
        { id: "ship", type: "operation", dependsOn: ["pay"], request: partial("ship") },
        { id: "refund", type: "compensation", forNodeId: "pay", request: partial("refund") },
      ],
      "refund",
      "recovery_required",
    ],
  ] as const)("takes up a step it ran on %s rather than run it again", async (_, nodes, target, settled) => {
    const { controller, store, done, on } = await setup({ policy: { unhinged: true } });
    const planned = controller.plan(workflow([...nodes]));
    // The advance that runs the step loses its commit.
    on.put = (key) => {
      if (key !== target) return;
      delete on.put;
      failNextCommit(store);
    };
    let run = controller.status(planned.id);
    for (let step = 0; step < 6 && !["verified_complete", "failed", "recovery_required"].includes(run.status); step += 1) {
      run = await controller.advance(planned.id).then(
        (result) => result.run,
        () => controller.status(planned.id),
      );
    }
    // Planned afresh, a partial step ran a second time, and a verified one
    // was cancelled as its own duplicate and halted the run.
    expect(done.filter((key) => key === target)).toEqual([target]);
    expect(run.status).toBe(settled);
  });

  const saga = () =>
    workflow([
      { id: "pay", type: "operation", request: put("pay") },
      { id: "ship", type: "operation", dependsOn: ["pay"], request: put("ship") },
      { id: "refund", type: "compensation", forNodeId: "pay", request: put("refund") },
    ]);

  it("reads a step it ran that failed as failed, and the compensation it ran as done", async () => {
    const { controller, store, done, on } = await setup({ policy: { unhinged: true } });
    const planned = controller.plan(saga());
    await controller.advance(planned.id);
    // ship did not happen, so the advance refunded pay; its commit is lost.
    on.put = (key) => {
      if (key !== "ship") return;
      delete on.put;
      throw new Error("ship_refused");
    };
    failNextCommit(store);
    await expect(controller.advance(planned.id)).rejects.toThrow("database is locked");
    let run = controller.status(planned.id);
    for (let step = 0; step < 4 && !["verified_complete", "failed", "recovery_required"].includes(run.status); step += 1) {
      run = (await controller.advance(planned.id)).run;
    }
    // Planned afresh, ship ran a second time, and the run completed with
    // the refund it had issued recorded as skipped.
    expect(run.status).toBe("failed");
    expect(run.nodes.ship?.status).toBe("failed");
    expect(run.nodes.refund?.status).toBe("compensated");
    expect(done).toEqual(["pay", "refund"]);
  });

  it("reads an operator's deny of the challenge it left as a denial", async () => {
    const { controller, store, tasks, done } = await setup();
    const planned = controller.plan(saga());
    let run = (await controller.advance(planned.id)).run;
    run = (await controller.advance(planned.id, approvalsFor(run))).run;
    failNextCommit(store);
    await expect(controller.advance(planned.id)).rejects.toThrow("database is locked");
    const [left] = store.listTasks(10, "awaiting_approval");
    // `melra approve --deny`, or the console's Deny.
    tasks.cancel(left!.id);
    run = (await controller.advance(planned.id)).run;
    // Planned afresh: ship's challenge offered again, the deny ignored.
    expect(run.nodes.ship).toEqual({ status: "cancelled", taskIds: [left!.id] });
    expect(run.nodes.refund?.status).toBe("awaiting_approval");
    expect(done).toEqual(["pay"]);
  });

  it("asks again for the challenge it left once that expired, and offers what it asked again", async () => {
    const { controller, store, done } = await setup({ policy: { approvalTtlMs: 50 } });
    const planned = controller.plan(workflow([{ id: "step", type: "operation", request: put("step") }]));
    failNextCommit(store);
    await expect(controller.advance(planned.id)).rejects.toThrow("database is locked");
    const [left] = store.listTasks(10, "awaiting_approval");
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Not a denial: the expired challenge is cancelled and asked again, and
    // that advance's commit is lost too.
    failNextCommit(store);
    await expect(controller.advance(planned.id)).rejects.toThrow("database is locked");
    const [again] = store.listTasks(10, "awaiting_approval");
    expect(store.getTask(left!.id)?.status).toBe("cancelled");
    expect(again?.attempt).toBe(2);
    let run = (await controller.advance(planned.id)).run;
    expect(run.nodes.step).toMatchObject({ status: "awaiting_approval", taskIds: [again!.id] });
    run = (await controller.advance(planned.id, approvalsFor(run))).run;
    expect(run.status).toBe("verified_complete");
    expect(done).toEqual(["step"]);
  });
});

describe("a step's task looked up by its key", () => {
  it("does not read every task in the home for each step an advance plans", async () => {
    const { controller, store, root, done } = await setup({ policy: { unhinged: true } });
    await writeFile(join(root, "flag"), "on");
    const planned = controller.plan(
      workflow([
        { id: "inspect", type: "operation", request: read() },
        {
          id: "loop",
          type: "bounded_loop",
          maxIterations: 3,
          until: { type: "file_exists", path: "never" },
          body: [put("l")],
        },
        { id: "par", type: "parallel", branches: [[put("p0")], [put("p1")]] },
        {
          id: "choose",
          type: "condition",
          dependsOn: ["inspect"],
          sourceNodeId: "inspect",
          predicate: { type: "file_exists", path: "flag" },
          whenTrue: [put("t")],
          whenFalse: [put("f")],
        },
      ]),
    );
    const listed = vi.spyOn(store, "listTasks");
    let run = (await controller.advance(planned.id)).run;
    for (let step = 0; step < 4 && run.status !== "verified_complete"; step += 1) {
      run = (await controller.advance(planned.id)).run;
    }
    expect(run.status).toBe("verified_complete");
    expect(done.sort()).toEqual(["l", "l", "l", "p0", "p1", "t"]);
    // Each new step, and each loop iteration, parsed the whole task table:
    // seconds per advance in a home with a long history.
    expect(listed).not.toHaveBeenCalled();
  });

  it("does not read every task in the home to recover, settle or cancel a run", async () => {
    const { controller, store, tasks, on } = await setup();
    // Its provider can say whether it happened: here, that it did not.
    const patch = TaskRequestSchema.parse({ ...put("patch"), reconciliation: [{ type: "file_exists", path: "patched" }] });
    const planned = controller.plan(
      workflow([
        { id: "patch", type: "operation", request: patch },
        { id: "par", type: "parallel", branches: [[put("p0")], [put("p1")]] },
      ]),
    );
    let run = (await controller.advance(planned.id)).run;
    const [p0, p1] = run.nodes.par!.taskIds;
    const first = tasks.status(p0!).approval!;
    on.put = (key) => {
      if (key === "patch") throw outcomeUnknown("socket hang up");
    };
    // patch's reply is lost; one branch of par runs and the other still waits.
    run = (
      await controller.advance(planned.id, [
        ...approvalsFor({ ...run, nodes: { patch: run.nodes.patch! } }),
        { approvalId: first.approvalId, phrase: first.phrase! },
      ])
    ).run;
    expect(run.status).toBe("recovery_required");
    const listed = vi.spyOn(store, "listTasks");

    await controller.recoverInterrupted();
    run = controller.status(planned.id);
    expect(run.nodes.par).toMatchObject({ status: "awaiting_approval", taskIds: [p0, p1] });
    // Reconciled as never applied, the parked step settles on the next advance.
    expect((await tasks.execute(run.nodes.patch!.taskIds[0]!)).task.status).toBe("failed");
    expect((await controller.advance(planned.id)).run.nodes.patch?.status).toBe("failed");
    expect(controller.cancel(planned.id).nodes.par).toMatchObject({ status: "cancelled", taskIds: [p0, p1] });
    // Capped at the newest 100,000 tasks, a long history also dropped a
    // step's task from the read, and a half-approved node read as complete.
    expect(listed).not.toHaveBeenCalled();
  });
});
