// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskRequestSchema,
  WorkflowDefinitionSchema,
  WorkflowEventSchema,
  outcomeUnknown,
  type Operation,
  type TaskRequest,
  type WorkflowDefinition,
  type WorkflowRun,
} from "@melra/protocol";
import { createDefaultPolicy, type LocalPolicy } from "@melra/policy-core";
import { sha256 } from "@melra/receipt-schema";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";
import { applyWorkflowEvent } from "./workflow-events.js";
import { WorkflowController } from "./workflow-controller.js";

const roots: string[] = [];
const stores: SqliteStore[] = [];
const definitionId = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(
  execute: (
    operation: Operation,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>> = async () => ({ success: true }),
  policy: Partial<LocalPolicy> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "melra-workflow-controller-"));
  roots.push(root);
  const store = new SqliteStore(":memory:");
  stores.push(store);
  const cipher = new PayloadCipher(Buffer.alloc(32, 17));
  const tasks = new TaskController(
    store,
    { ...createDefaultPolicy(root), ...policy },
    { execute },
    await Verifier.create(root),
    cipher,
  );
  return {
    store,
    cipher,
    tasks,
    controller: new WorkflowController(store, tasks, cipher),
  };
}

function request(goal: string): TaskRequest {
  return {
    goal,
    operation: { kind: "system", action: "info" },
    constraints: [],
    forbiddenEffects: [],
    requiredEvidence: [],
    reconciliation: [],
    budget: {
      maxDurationMs: 120_000,
      maxRetries: 2,
      maxSteps: 10,
    },
  };
}

function mutationRequest(goal: string): TaskRequest {
  return TaskRequestSchema.parse({
    goal,
    operation: {
      kind: "memory",
      action: "put",
      key: "project",
      value: "MELRA",
    },
    requiredEvidence: [
      { type: "result_equals", path: "stored", value: true },
    ],
  });
}

function fileRequest(goal: string, path: string): TaskRequest {
  return TaskRequestSchema.parse({
    goal,
    operation: { kind: "file", action: "read", path },
  });
}

function definition(goal = "one-time-workflow-secret"): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    schemaVersion: "1.0.0",
    id: definitionId,
    version: 1,
    name: "Durable workflow",
    nodes: [
      {
        id: "inspect",
        type: "operation",
        request: request(goal),
      },
    ],
  });
}

describe("WorkflowController planning", () => {
  it("persists a redacted projection and sealed exact definition", async () => {
    const { controller, store, cipher } = await setup();
    const exact = definition();

    const run = controller.plan(exact);

    expect(run.status).toBe("planned");
    expect(
      Object.values(run.nodes).every((node) => node.status === "pending"),
    ).toBe(true);
    expect(store.listWorkflowEvents(run.id).map((event) => event.type)).toEqual([
      "workflow.created",
      "workflow.status_changed",
    ]);
    expect(
      store.getWorkflowDefinition(definitionId, 1)?.nodes[0],
    ).not.toEqual(exact.nodes[0]);
    expect(
      cipher.open(
        store.getWorkflowPayload(definitionId, 1)!,
        `workflow:${definitionId}:1:definition`,
      ),
    ).toEqual(exact);
    expect(JSON.stringify(store.listWorkflowEvents(run.id))).not.toContain(
      "one-time-workflow-secret",
    );
  });

  it("plans the same definition again as a new run, and refuses a different one under its id", async () => {
    const { controller, store } = await setup();
    const first = controller.plan(definition());
    // `melra demo` twice, or `workflow plan --definition` on the same file:
    // this used to fail with a raw SQLite UNIQUE constraint.
    const second = controller.plan(definition());
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("planned");
    expect(store.listWorkflowEvents(second.id)).toHaveLength(2);

    // The goal is redacted before storage, so the stored copies of these two
    // look identical. The comparison is against the sealed exact definition,
    // so a change only a secret carried is still caught.
    expect(() => controller.plan(definition("a-different-secret"))).toThrow(
      /^workflow_definition_conflict:/,
    );
  });

  it("refuses an unused browser list in a new workflow, and keeps running one accepted before", async () => {
    const { controller, tasks } = await setup();
    const browser = WorkflowDefinitionSchema.parse({
      schemaVersion: "1.0.0",
      id: definitionId,
      version: 1,
      name: "Click",
      nodes: [
        {
          id: "click",
          type: "operation",
          request: {
            goal: "Click",
            operation: { kind: "browser", action: "click", target: { selector: "#ok" }, values: [] },
          },
        },
      ],
    });
    expect(() => controller.plan(browser)).toThrow("browser_field_unused:values");
    // A definition stored by a version without the check: its steps are
    // planned again as the run advances, and must not stop it there.
    const preflight = tasks.preflight.bind(tasks);
    const spy = vi.spyOn(tasks, "preflight").mockImplementation((request) => preflight(request, { stored: true }));
    const run = controller.plan(browser);
    spy.mockRestore();
    const advanced = await controller.advance(run.id);
    expect(advanced.run.nodes.click?.status).not.toBe("pending");
  });

  it("rejects a denied nested request before writing anything", async () => {
    const { controller, store } = await setup();
    const denied = WorkflowDefinitionSchema.parse({
      schemaVersion: "1.0.0",
      id: definitionId,
      version: 1,
      name: "Denied branch",
      nodes: [
        {
          id: "branch",
          type: "condition",
          sourceNodeId: "inspect",
          dependsOn: ["inspect"],
          predicate: { type: "result_equals", path: "success", value: true },
          whenTrue: [
            {
              goal: "Run a forbidden shell",
              operation: {
                kind: "terminal",
                action: "run",
                command: "bash",
              },
            },
          ],
          whenFalse: [],
        },
        {
          id: "inspect",
          type: "operation",
          request: request("Inspect first"),
        },
      ],
    });

    expect(() => controller.plan(denied)).toThrow(
      "workflow_policy_blocked:branch",
    );
    expect(store.getWorkflowDefinition(definitionId, 1)).toBeUndefined();
    expect(store.getWorkflowPayload(definitionId, 1)).toBeUndefined();
    expect(store.listTasks()).toEqual([]);
    expect(
      store.database.prepare("SELECT count(*) AS count FROM workflow_runs").get(),
    ).toEqual({ count: 0 });
  });

  it("reads status and events and rejects unknown workflow IDs", async () => {
    const { controller } = await setup();
    const run = controller.plan(definition());

    expect(controller.status(run.id)).toEqual(run);
    expect(controller.events(run.id, 1)).toHaveLength(1);
    expect(() =>
      controller.status("99999999-9999-4999-8999-999999999999"),
    ).toThrow("workflow_not_found");
    expect(() =>
      controller.events("99999999-9999-4999-8999-999999999999"),
    ).toThrow("workflow_not_found");
  });

  it("cancels nonterminal nodes once and preserves completed workflows", async () => {
    const { controller, store } = await setup();
    const run = controller.plan(definition());

    const cancelled = controller.cancel(run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.nodes.inspect?.status).toBe("cancelled");
    expect(store.listWorkflowEvents(run.id).map((event) => event.type)).toEqual([
      "workflow.created",
      "workflow.status_changed",
      "workflow.node_changed",
      "workflow.cancelled",
    ]);
    expect(controller.cancel(run.id)).toEqual(cancelled);

    const second = controller.plan(
      WorkflowDefinitionSchema.parse({
        ...definition("another secret"),
        id: "22222222-2222-4222-8222-222222222222",
      }),
    );
    const completedEvent = WorkflowEventSchema.parse({
      schemaVersion: "1.0.0",
      id: "33333333-3333-4333-8333-333333333333",
      aggregateId: second.id,
      sequence: 3,
      traceId: second.traceId,
      type: "workflow.status_changed",
      data: { from: "planned", to: "verified_complete" },
      occurredAt: "2026-07-30T12:00:03.000Z",
    });
    const completed = applyWorkflowEvent(second, completedEvent);
    store.transitionWorkflow(second.id, 2, completed, [completedEvent]);

    expect(controller.cancel(second.id)).toEqual(completed);
    expect(store.listWorkflowEvents(second.id)).toHaveLength(3);
  });

  it("surfaces a stale projection conflict without retrying", async () => {
    const { controller, store } = await setup();
    const run = controller.plan(definition());
    const transition = store.transitionWorkflow.bind(store);
    let injected = false;
    vi.spyOn(store, "transitionWorkflow").mockImplementation(
      (id, expectedVersion, next, events) => {
        if (!injected) {
          injected = true;
          const externalEvent = WorkflowEventSchema.parse({
            schemaVersion: "1.0.0",
            id: "44444444-4444-4444-8444-444444444444",
            aggregateId: run.id,
            sequence: 3,
            traceId: run.traceId,
            type: "workflow.status_changed",
            data: { from: "planned", to: "paused" },
            occurredAt: "2026-07-30T12:00:03.000Z",
          });
          transition(
            run.id,
            run.stateVersion,
            applyWorkflowEvent(run, externalEvent),
            [externalEvent],
          );
        }
        transition(id, expectedVersion, next, events);
      },
    );

    expect(() => controller.cancel(run.id)).toThrow(
      "workflow_state_conflict",
    );
    expect(store.getWorkflowRun(run.id)?.status).toBe("paused");
    expect(store.listWorkflowEvents(run.id)).toHaveLength(3);
  });
});

describe("WorkflowController execution", () => {
  it("advances one governed layer at a time through approval and checkpoint", async () => {
    const { controller, store } = await setup(async (operation) =>
      operation.kind === "memory"
        ? { success: true, stored: true }
        : { success: true },
    );
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: "1.0.0",
      id: definitionId,
      version: 1,
      name: "Governed checkpoint",
      nodes: [
        {
          id: "inspect",
          type: "operation",
          request: request("Inspect"),
        },
        {
          id: "approve-write",
          type: "approval",
          dependsOn: ["inspect"],
          forNodeId: "write",
        },
        {
          id: "write",
          type: "operation",
          dependsOn: ["approve-write"],
          request: mutationRequest("Write"),
        },
        {
          id: "checkpoint",
          type: "checkpoint",
          dependsOn: ["write"],
        },
      ],
    });
    const planned = controller.plan(workflow);

    const inspected = await controller.advance(planned.id);
    expect(inspected.run.nodes.inspect?.status).toBe("verified_complete");
    expect(inspected.run.nodes.write?.status).toBe("pending");

    const waiting = await controller.advance(planned.id);
    expect(waiting.run.nodes["approve-write"]?.status).toBe(
      "awaiting_approval",
    );
    expect(waiting.run.status).toBe("awaiting_approval");
    const challenge = waiting.run.nodes["approve-write"]!.approval!;

    const approved = await controller.advance(planned.id, [
      {
        approvalId: challenge.approvalId,
        phrase: challenge.phrase!,
      },
    ]);
    expect(approved.run.nodes["approve-write"]?.status).toBe(
      "verified_complete",
    );

    const written = await controller.advance(planned.id);
    expect(written.run.nodes.write?.status).toBe("verified_complete");

    const completed = await controller.advance(planned.id);
    expect(completed.run.nodes.checkpoint?.status).toBe("verified_complete");
    expect(completed.run.status).toBe("verified_complete");
    expect(store.getLatestWorkflowSnapshot(planned.id)?.run).toEqual(
      completed.run,
    );
    expect(store.listTasks()).toHaveLength(2);
    expect(
      store
        .listTasks()
        .every(
          (task) =>
            task.idempotencyKey?.length === 64 && task.attempt === 1,
        ),
    ).toBe(true);
  });

  it("executes only the condition branch selected from persisted evidence", async () => {
    const executed: string[] = [];
    const { controller } = await setup(async (operation) => {
      if (operation.kind !== "file") throw new Error("unexpected_operation");
      executed.push(operation.path);
      return {
        success: true,
        ...(operation.path === "inspect" ? { route: "yes" } : {}),
      };
    });
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Conditional",
        nodes: [
          {
            id: "inspect",
            type: "operation",
            request: fileRequest("Inspect", "inspect"),
          },
          {
            id: "choose",
            type: "condition",
            dependsOn: ["inspect"],
            sourceNodeId: "inspect",
            predicate: {
              type: "result_equals",
              path: "route",
              value: "yes",
            },
            whenTrue: [fileRequest("True branch", "true-branch")],
            whenFalse: [fileRequest("False branch", "false-branch")],
          },
        ],
      }),
    );

    await controller.advance(planned.id);
    const result = await controller.advance(planned.id);

    expect(executed).toEqual(["inspect", "true-branch"]);
    expect(result.run.nodes.choose?.status).toBe("verified_complete");
    expect(result.run.status).toBe("verified_complete");
  });

  it("executes independent parallel branches concurrently", async () => {
    let active = 0;
    let maxConcurrent = 0;
    const { controller, store } = await setup(async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { success: true };
    });
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Parallel",
        nodes: [
          {
            id: "parallel",
            type: "parallel",
            branches: [
              [fileRequest("Branch A", "a")],
              [fileRequest("Branch B", "b")],
            ],
          },
        ],
      }),
    );

    const result = await controller.advance(planned.id);

    expect(maxConcurrent).toBe(2);
    expect(result.run.nodes.parallel?.taskIds).toHaveLength(2);
    expect(result.run.status).toBe("verified_complete");
    expect(
      new Set(store.listTasks().map((task) => task.idempotencyKey)).size,
    ).toBe(2);
  });

  it("serializes concurrent advances for the same workflow", async () => {
    let calls = 0;
    const { controller, store } = await setup(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { success: true };
    });
    const planned = controller.plan(definition("Concurrent advance"));

    const results = await Promise.all([
      controller.advance(planned.id),
      controller.advance(planned.id),
    ]);

    expect(calls).toBe(1);
    expect(
      results.every((result) => result.run.status === "verified_complete"),
    ).toBe(true);
    expect(store.listTasks()).toHaveLength(1);
  });

  it("runs a bounded loop sequentially to its hard limit", async () => {
    let calls = 0;
    const { controller } = await setup(async () => {
      calls += 1;
      return { success: true };
    });
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Bounded loop",
        nodes: [
          {
            id: "loop",
            type: "bounded_loop",
            body: [fileRequest("Loop body", "loop")],
            maxIterations: 3,
          },
        ],
      }),
    );

    const result = await controller.advance(planned.id);

    expect(calls).toBe(3);
    expect(result.run.nodes.loop?.iterations).toBe(3);
    expect(result.run.status).toBe("verified_complete");
  });

  it("stops a bounded loop when its persisted result satisfies until", async () => {
    let calls = 0;
    const { controller } = await setup(async () => {
      calls += 1;
      return { success: true, done: calls >= 2 };
    });
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Bounded loop with condition",
        nodes: [
          {
            id: "loop",
            type: "bounded_loop",
            body: [fileRequest("Loop body", "loop")],
            maxIterations: 5,
            until: { type: "result_equals", path: "done", value: true },
          },
        ],
      }),
    );

    const result = await controller.advance(planned.id);

    expect(calls).toBe(2);
    expect(result.run.nodes.loop?.iterations).toBe(2);
    expect(result.run.status).toBe("verified_complete");
  });

  it("compensates verified work once when a later operation fails", async () => {
    const executed: string[] = [];
    const { controller, tasks } = await setup(async (operation) => {
      if (operation.kind !== "file") throw new Error("unexpected_operation");
      executed.push(operation.path);
      return { success: operation.path !== "fail" };
    });
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Compensated failure",
        nodes: [
          {
            id: "first",
            type: "operation",
            request: fileRequest("First", "first"),
          },
          {
            id: "second",
            type: "operation",
            dependsOn: ["first"],
            request: fileRequest("Fail", "fail"),
          },
          {
            id: "undo-first",
            type: "compensation",
            forNodeId: "first",
            request: fileRequest("Undo", "undo"),
          },
        ],
      }),
    );

    await controller.advance(planned.id);
    const result = await controller.advance(planned.id);

    expect(executed).toEqual(["first", "fail", "undo"]);
    expect(result.run.nodes["undo-first"]?.status).toBe("compensated");
    expect(result.run.status).toBe("failed");
    const compensationTaskId =
      result.run.nodes["undo-first"]?.taskIds[0];
    expect(compensationTaskId).toBeDefined();
    expect(tasks.receipts({ taskId: compensationTaskId! }).receipts).toHaveLength(
      1,
    );
  });

  it("skips compensation without execution after verified success", async () => {
    const executed: string[] = [];
    const { controller } = await setup(async (operation) => {
      if (operation.kind !== "file") throw new Error("unexpected_operation");
      executed.push(operation.path);
      return { success: true };
    });
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Successful compensation skip",
        nodes: [
          {
            id: "first",
            type: "operation",
            request: fileRequest("First", "first"),
          },
          {
            id: "undo-first",
            type: "compensation",
            forNodeId: "first",
            request: fileRequest("Undo", "undo"),
          },
        ],
      }),
    );

    const result = await controller.advance(planned.id);

    expect(executed).toEqual(["first"]);
    expect(result.run.nodes["undo-first"]?.status).toBe("skipped");
    expect(result.run.status).toBe("verified_complete");
  });

  it("resumes approval-required compensation on a failed workflow", async () => {
    let memoryCalls = 0;
    const { controller } = await setup(async (operation) => {
      if (operation.kind === "memory") {
        memoryCalls += 1;
        return { success: true, stored: true };
      }
      if (operation.kind !== "file") throw new Error("unexpected_operation");
      return { success: operation.path !== "fail" };
    });
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Governed compensation",
        nodes: [
          {
            id: "first",
            type: "operation",
            request: fileRequest("First", "first"),
          },
          {
            id: "second",
            type: "operation",
            dependsOn: ["first"],
            request: fileRequest("Fail", "fail"),
          },
          {
            id: "undo-first",
            type: "compensation",
            forNodeId: "first",
            request: mutationRequest("Undo"),
          },
        ],
      }),
    );

    await controller.advance(planned.id);
    const failed = await controller.advance(planned.id);
    expect(failed.run.status).toBe("failed");
    expect(failed.run.nodes["undo-first"]?.status).toBe("awaiting_approval");
    expect(memoryCalls).toBe(0);
    const challenge = failed.run.nodes["undo-first"]!.approval!;

    const compensated = await controller.advance(planned.id, [
      {
        approvalId: challenge.approvalId,
        phrase: challenge.phrase!,
      },
    ]);

    expect(compensated.run.status).toBe("failed");
    expect(compensated.run.nodes["undo-first"]?.status).toBe("compensated");
    expect(memoryCalls).toBe(1);
  });

  const PAYMENTS = "https://payments.example.test";
  const LOGISTICS = "https://logistics.example.test";

  function call(goal: string, url: string): TaskRequest {
    return TaskRequestSchema.parse({
      goal,
      operation: { kind: "http", action: "request", method: "POST", url },
    });
  }

  /**
   * Advance until nothing changes, approving whatever the run stops on.
   *
   * Every step here is a mutation, so each one parks for approval — which is
   * the point being preserved: an unwind that needed five approvals still ran
   * in one order, and the helper never volunteers an approval for a node the
   * run did not stop on.
   */
  /** Approves every challenge until nothing moves, denying those of `deny.nodeIds`. */
  async function settle(
    controller: WorkflowController,
    id: string,
    deny?: { tasks: TaskController; nodeIds: string[] },
  ) {
    let result = await controller.advance(id);
    for (let round = 0; round < 12; round += 1) {
      const approvals = Object.entries(result.run.nodes).flatMap(([nodeId, state]) => {
        if (state.status !== "awaiting_approval" || state.approval === undefined) return [];
        if (deny?.nodeIds.includes(nodeId) === true) {
          // What Deny and melra_task_cancel reach: the step's task, cancelled.
          deny.tasks.cancel(state.taskIds[0]!);
          return [];
        }
        return [{ approvalId: state.approval.approvalId, phrase: state.approval.phrase! }];
      });
      const next = await controller.advance(id, approvals);
      if (next.events.length === 0) return next;
      result = next;
    }
    throw new Error("workflow_did_not_settle");
  }

  /** `host/path`, so an assertion reads as "which provider, which endpoint". */
  function saga(
    failing: string,
  ): { calls: string[]; execute: (operation: Operation) => Promise<Record<string, unknown>> } {
    const calls: string[] = [];
    return {
      calls,
      async execute(operation) {
        if (operation.kind !== "http") throw new Error("unexpected_operation");
        const url = new URL(operation.url);
        const seen = `${url.host}${url.pathname}`;
        calls.push(seen);
        return { success: seen !== failing };
      },
    };
  }

  function sagaDefinition(): WorkflowDefinition {
    return WorkflowDefinitionSchema.parse({
      schemaVersion: "1.0.0",
      id: definitionId,
      version: 1,
      name: "Charge, ship, notify",
      nodes: [
        {
          id: "charge",
          type: "operation",
          request: call("Charge", `${PAYMENTS}/charges`),
        },
        {
          id: "ship",
          type: "operation",
          dependsOn: ["charge"],
          request: call("Ship", `${LOGISTICS}/shipments`),
        },
        {
          id: "notify",
          type: "operation",
          dependsOn: ["ship"],
          request: call("Notify", `${PAYMENTS}/notify`),
        },
        // Declared in forward order; the unwind reverses them.
        {
          id: "undo-charge",
          type: "compensation",
          forNodeId: "charge",
          request: call("Refund", `${PAYMENTS}/refunds`),
        },
        {
          id: "undo-ship",
          type: "compensation",
          forNodeId: "ship",
          request: call("Cancel shipment", `${LOGISTICS}/cancellations`),
        },
      ],
    });
  }

  it("unwinds two providers newest-effect-first when a later step fails", async () => {
    const { calls, execute } = saga("payments.example.test/notify");
    const { controller } = await setup(execute);
    const planned = controller.plan(sagaDefinition());

    const result = await settle(controller, planned.id);

    // The shipment is cancelled before the charge that paid for it is refunded,
    // and the two land at different hosts through the same governed path.
    expect(calls).toEqual([
      "payments.example.test/charges",
      "logistics.example.test/shipments",
      "payments.example.test/notify",
      "logistics.example.test/cancellations",
      "payments.example.test/refunds",
    ]);
    expect(result.run.nodes["undo-ship"]?.status).toBe("compensated");
    expect(result.run.nodes["undo-charge"]?.status).toBe("compensated");
    expect(result.run.status).toBe("failed");
  });

  it("halts and flags the saga when a compensation cannot complete", async () => {
    const { calls, execute } = saga("logistics.example.test/cancellations");
    const { controller } = await setup(async (operation) => {
      const result = await execute(operation);
      if (operation.kind === "http" && operation.url.endsWith("/notify")) {
        return { success: false };
      }
      return result;
    });
    const planned = controller.plan(sagaDefinition());

    const result = await settle(controller, planned.id);

    // Refunding the charge while the shipment is still outstanding would give
    // away the goods. Stop, and say which inverse is missing.
    expect(calls).not.toContain("payments.example.test/refunds");
    expect(result.run.status).toBe("recovery_required");
    expect(result.run.error).toBe("workflow_compensation_incomplete:undo-ship");
    expect(result.run.nodes["undo-charge"]?.status).toBe("pending");
  });
  it("unwinds the steps already done when an operator denies a later one", async () => {
    const { calls, execute } = saga("none");
    const { controller, tasks } = await setup(execute);
    const planned = controller.plan(sagaDefinition());

    const result = await settle(controller, planned.id, { tasks, nodeIds: ["ship"] });

    // The shipment never happened, so only the charge is undone. The run used
    // to read `running` for good, with nothing left that could run.
    expect(calls).toEqual(["payments.example.test/charges", "payments.example.test/refunds"]);
    expect(result.run.status).toBe("failed");
    expect(result.run.nodes.ship?.status).toBe("cancelled");
    expect(result.run.nodes.notify?.status).toBe("pending");
    expect(result.run.nodes["undo-ship"]?.status).toBe("skipped");
    expect(result.run.nodes["undo-charge"]?.status).toBe("compensated");
  });

  it("stops the unwind at a compensation the operator denies", async () => {
    const { calls, execute } = saga("payments.example.test/notify");
    const { controller, tasks } = await setup(execute);
    const planned = controller.plan(sagaDefinition());

    const result = await settle(controller, planned.id, { tasks, nodeIds: ["undo-ship"] });

    // As for a compensation that fails: the shipment was not cancelled, so the
    // charge that paid for it is not refunded either.
    expect(calls).not.toContain("payments.example.test/refunds");
    expect(result.run.status).toBe("recovery_required");
    expect(result.run.error).toBe("workflow_compensation_incomplete:undo-ship");
    expect(result.run.nodes["undo-ship"]?.status).toBe("cancelled");
    expect(result.run.nodes["undo-charge"]?.status).toBe("pending");
  });

  it("halts, not unwinds, at a step that ran though its advance was not committed", async () => {
    const { calls, execute } = saga("none");
    const { controller, tasks, store, cipher } = await setup(execute);
    const definition = sagaDefinition();
    const planned = controller.plan(definition);
    let run = (await controller.advance(planned.id)).run;
    const charge = run.nodes.charge!.approval!;
    run = (await controller.advance(planned.id, [{ approvalId: charge.approvalId, phrase: charge.phrase! }])).run;
    expect(run.nodes.ship?.status).toBe("pending");
    // Ship ran and committed, then its advance lost its commit (a pause
    // landed), so the run still shows it pending with no task.
    const ship = definition.nodes.find((node) => node.id === "ship");
    if (ship?.type !== "operation") throw new Error("expected_operation_node");
    const key = sha256({ workflowId: planned.id, nodeId: "ship", iteration: 0, branch: "operation", request: ship.request });
    const ran = tasks.plan(ship.request, { idempotencyKey: key, attempt: 1, stored: true });
    await tasks.execute(ran.id, { approvalId: ran.approval!.approvalId, phrase: ran.approval!.phrase! });

    // Planned again, ship is cancelled as a duplicate. That is not a denial:
    // read as one, it refunded the charge while the shipment stood.
    const halted = await settle(controller, planned.id);
    expect(halted.run.status).toBe("recovery_required");
    expect(calls).toEqual(["payments.example.test/charges", "logistics.example.test/shipments"]);

    // Recovery reads every attempt, keeps the one that committed, and the run
    // carries on from there.
    const restarted = new WorkflowController(store, tasks, cipher);
    await restarted.recoverInterrupted();
    expect(restarted.status(planned.id).nodes.ship).toMatchObject({ status: "verified_complete", taskIds: [ran.id] });
    const result = await settle(restarted, planned.id);
    expect(result.run.status).toBe("verified_complete");
    expect(calls).toEqual([
      "payments.example.test/charges",
      "logistics.example.test/shipments",
      "payments.example.test/notify",
    ]);
  });

  it("does not read a step still verifying as failed", async () => {
    const { calls, execute } = saga("none");
    const { controller, store } = await setup(execute);
    const planned = controller.plan(sagaDefinition());
    let run = (await controller.advance(planned.id)).run;
    for (let step = 0; step < 3 && run.nodes.ship?.status !== "awaiting_approval"; step += 1) {
      const waiting = Object.values(run.nodes).flatMap((state) =>
        state.status === "awaiting_approval" && state.approval !== undefined
          ? [{ approvalId: state.approval.approvalId, phrase: state.approval.phrase! }]
          : [],
      );
      run = (await controller.advance(planned.id, waiting)).run;
    }
    // Interrupted after its effect, before its final save: it may stand.
    const shipping = store.getTask(run.nodes.ship!.taskIds[0]!)!;
    shipping.status = "verifying";
    store.saveTask(shipping);

    run = (await controller.advance(planned.id)).run;
    // Read as failed, it started the unwind and offered the refund.
    expect(run.status).toBe("recovery_required");
    expect(run.nodes.ship?.status).toBe("recovery_required");
    expect(run.nodes["undo-charge"]?.status).toBe("pending");
    expect(calls).toEqual(["payments.example.test/charges"]);
  });

  it("does not skip the compensation of a step its approval node already ran", async () => {
    const { calls, execute } = saga("none");
    const { controller, tasks } = await setup(execute);
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Charge, approve and ship, notify",
        nodes: [
          { id: "charge", type: "operation", request: call("Charge", `${PAYMENTS}/charges`) },
          { id: "approve-ship", type: "approval", forNodeId: "ship", dependsOn: ["charge"] },
          { id: "ship", type: "operation", dependsOn: ["approve-ship"], request: call("Ship", `${LOGISTICS}/shipments`) },
          { id: "notify", type: "operation", dependsOn: ["charge"], request: call("Notify", `${PAYMENTS}/notify`) },
          { id: "undo-charge", type: "compensation", forNodeId: "charge", request: call("Refund", `${PAYMENTS}/refunds`) },
          { id: "undo-ship", type: "compensation", forNodeId: "ship", request: call("Cancel shipment", `${LOGISTICS}/cancellations`) },
        ],
      }),
    );

    // The approval node runs the shipment; `ship` would only read it next wave.
    const result = await settle(controller, planned.id, { tasks, nodeIds: ["notify"] });

    // Read as not done, its cancellation was skipped and the charge refunded
    // while the goods were on their way.
    expect(calls).toEqual([
      "payments.example.test/charges",
      "logistics.example.test/shipments",
      "logistics.example.test/cancellations",
      "payments.example.test/refunds",
    ]);
    expect(result.run.nodes["undo-ship"]?.status).toBe("compensated");
    expect(result.run.status).toBe("failed");
  });

  it("does not undo a step its approval only let through, unrun", async () => {
    const calls: string[] = [];
    const { controller } = await setup(
      async (operation) => {
        if (operation.kind !== "http") throw new Error("unexpected_operation");
        const path = new URL(operation.url).pathname;
        calls.push(path);
        return { success: path !== "/notify" };
      },
      // The approval passes ship's task through planned; ship would run it next wave.
      { unhinged: true },
    );
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Charge, approve and ship, notify",
        nodes: [
          { id: "charge", type: "operation", request: call("Charge", `${PAYMENTS}/charges`) },
          { id: "approve-ship", type: "approval", forNodeId: "ship", dependsOn: ["charge"] },
          { id: "ship", type: "operation", dependsOn: ["approve-ship"], request: call("Ship", `${LOGISTICS}/shipments`) },
          { id: "notify", type: "operation", dependsOn: ["charge"], request: call("Notify", `${PAYMENTS}/notify`) },
          { id: "undo-charge", type: "compensation", forNodeId: "charge", request: call("Refund", `${PAYMENTS}/refunds`) },
          { id: "undo-ship", type: "compensation", forNodeId: "ship", request: call("Cancel shipment", `${LOGISTICS}/cancellations`) },
        ],
      }),
    );
    let run = (await controller.advance(planned.id)).run;
    for (let step = 0; step < 6 && run.status !== "failed"; step += 1) {
      run = (await controller.advance(planned.id)).run;
    }
    // Notify failed in the wave the approval passed ship through: nothing was
    // shipped, so there is nothing to cancel, only the charge to refund.
    expect(calls).not.toContain("/shipments");
    expect(calls).not.toContain("/cancellations");
    expect(calls).toContain("/refunds");
    expect(run.nodes["undo-ship"]?.status).toBe("skipped");
  });

  it("does not undo, on a later advance, a read its approval only let through", async () => {
    const calls: string[] = [];
    const { controller } = await setup(async (operation) => {
      if (operation.kind !== "http") throw new Error("unexpected_operation");
      const path = new URL(operation.url).pathname;
      calls.push(path);
      return { success: path !== "/notify" };
    });
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Charge, approve and look up the shipment, notify",
        nodes: [
          { id: "charge", type: "operation", request: call("Charge", `${PAYMENTS}/charges`) },
          { id: "approve-ship", type: "approval", forNodeId: "ship", dependsOn: ["charge"] },
          {
            id: "ship",
            type: "operation",
            dependsOn: ["approve-ship"],
            // A read: policy lets the approval pass its task through planned.
            request: TaskRequestSchema.parse({
              goal: "Look up the shipment",
              operation: { kind: "http", action: "request", method: "GET", url: `${LOGISTICS}/shipments` },
            }),
          },
          { id: "notify", type: "operation", dependsOn: ["charge"], request: call("Notify", `${PAYMENTS}/notify`) },
          // In this order the refund is offered first and parks for approval,
          // so the shipment's compensation is decided by the next advance.
          { id: "undo-ship", type: "compensation", forNodeId: "ship", request: call("Cancel shipment", `${LOGISTICS}/cancellations`) },
          { id: "undo-charge", type: "compensation", forNodeId: "charge", request: call("Refund", `${PAYMENTS}/refunds`) },
        ],
      }),
    );

    const result = await settle(controller, planned.id);

    expect(calls).toEqual(["/charges", "/notify", "/refunds"]);
    expect(result.run.status).toBe("failed");
  });

  it("stops an unwind when the run is cancelled under it", async () => {
    let cancelRun = () => {};
    const calls: string[] = [];
    const { controller } = await setup(
      async (operation) => {
        if (operation.kind !== "http") throw new Error("unexpected_operation");
        const path = new URL(operation.url).pathname;
        calls.push(path);
        if (path === "/refunds") cancelRun();
        return { success: path !== "/shipments" };
      },
      // Every compensation runs without waiting for an approval.
      { unhinged: true },
    );
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Reserve, charge, ship",
        nodes: [
          { id: "reserve", type: "operation", request: call("Reserve", `${LOGISTICS}/reservations`) },
          { id: "charge", type: "operation", dependsOn: ["reserve"], request: call("Charge", `${PAYMENTS}/charges`) },
          { id: "ship", type: "operation", dependsOn: ["charge"], request: call("Ship", `${LOGISTICS}/shipments`) },
          { id: "undo-reserve", type: "compensation", forNodeId: "reserve", request: call("Release", `${LOGISTICS}/releases`) },
          { id: "undo-charge", type: "compensation", forNodeId: "charge", request: call("Refund", `${PAYMENTS}/refunds`) },
        ],
      }),
    );
    // `workflow cancel` lands while the refund runs, the first step undone.
    cancelRun = () => controller.cancel(planned.id);
    for (let step = 0; step < 6 && controller.status(planned.id).status !== "cancelled"; step += 1) {
      await controller.advance(planned.id).catch(() => undefined);
    }

    expect(controller.status(planned.id).status).toBe("cancelled");
    expect(calls).toContain("/refunds");
    expect(calls).not.toContain("/releases");
  });

  /** Charge, then ship and notify side by side; only the charge is undone. */
  function fanOutSaga(): WorkflowDefinition {
    return WorkflowDefinitionSchema.parse({
      schemaVersion: "1.0.0",
      id: definitionId,
      version: 1,
      name: "Charge, then ship and notify",
      nodes: [
        { id: "charge", type: "operation", request: call("Charge", `${PAYMENTS}/charges`) },
        { id: "ship", type: "operation", dependsOn: ["charge"], request: call("Ship", `${LOGISTICS}/shipments`) },
        { id: "notify", type: "operation", dependsOn: ["charge"], request: call("Notify", `${PAYMENTS}/notify`) },
        { id: "undo-charge", type: "compensation", forNodeId: "charge", request: call("Refund", `${PAYMENTS}/refunds`) },
      ],
    });
  }

  it("halts rather than unwind past a step whose outcome is unknown when another is denied", async () => {
    const calls: string[] = [];
    const { controller, tasks } = await setup(async (operation) => {
      if (operation.kind !== "http") throw new Error("unexpected_operation");
      const url = new URL(operation.url);
      calls.push(`${url.host}${url.pathname}`);
      // The shipment may or may not exist; refunding its charge now could
      // give the goods away.
      if (url.pathname === "/shipments") throw outcomeUnknown("socket hang up");
      return { success: true };
    });
    const planned = controller.plan(fanOutSaga());

    const result = await settle(controller, planned.id, { tasks, nodeIds: ["notify"] });

    expect(calls).not.toContain("payments.example.test/refunds");
    expect(result.run.status).toBe("recovery_required");
    expect(result.run.nodes.notify?.status).toBe("cancelled");
    expect(result.run.nodes["undo-charge"]?.status).toBe("pending");
  });

  it("plans no compensation for a run cancelled while its advance was running", async () => {
    let shipping!: () => void;
    const started = new Promise<void>((resolve) => {
      shipping = resolve;
    });
    const { controller, store } = await setup(async (operation, signal) => {
      if (operation.kind === "http" && operation.url.endsWith("/shipments")) {
        shipping();
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
      }
      return { success: true };
    });
    const planned = controller.plan(fanOutSaga());
    const approve = (run: WorkflowRun, only?: string) =>
      Object.entries(run.nodes).flatMap(([nodeId, state]) =>
        state.status === "awaiting_approval" && state.approval !== undefined && (only === undefined || only === nodeId)
          ? [{ approvalId: state.approval.approvalId, phrase: state.approval.phrase! }]
          : [],
      );
    let run = (await controller.advance(planned.id)).run;
    run = (await controller.advance(planned.id, approve(run))).run;
    for (let step = 0; step < 3 && run.nodes.ship?.status !== "awaiting_approval"; step += 1) {
      run = (await controller.advance(planned.id)).run;
    }

    // `workflow cancel` lands while the shipment runs, and aborts it.
    const advancing = controller.advance(planned.id, approve(run, "ship"));
    await started;
    controller.cancel(planned.id);
    await advancing.catch(() => undefined);

    // A refund planned now would be a live challenge on a run its operator
    // ended without compensating.
    expect(controller.status(planned.id).status).toBe("cancelled");
    expect(store.listTasks(100, "awaiting_approval")).toEqual([]);
  });
});

describe("WorkflowController recovery", () => {
  it("retries an interrupted read through its original governed task", async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const { controller, store, tasks, cipher } = await setup(execute);
    const exact = definition("Retry read");
    const planned = controller.plan(exact);
    const operationNode = exact.nodes[0]!;
    if (operationNode.type !== "operation") {
      throw new Error("expected_operation_node");
    }
    const task = tasks.plan(operationNode.request, {
      idempotencyKey: sha256({
        workflowId: planned.id,
        nodeId: operationNode.id,
        iteration: 0,
        branch: "operation",
        request: operationNode.request,
      }),
      attempt: 1,
    });
    const interrupted = store.getTask(task.id)!;
    interrupted.status = "running";
    store.saveTask(interrupted);

    const restarted = new WorkflowController(store, tasks, cipher);
    const [recovered] = await restarted.recoverInterrupted();
    expect(recovered?.nodes.inspect).toMatchObject({
      status: "pending",
      taskIds: [task.id],
    });

    const completed = await restarted.advance(planned.id);
    expect(completed.run.status).toBe("verified_complete");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("repairs a projection after a verified task committed first", async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const { controller, store, tasks, cipher } = await setup(execute);
    const planned = controller.plan(definition("Recover projection"));
    const crash = vi
      .spyOn(store, "transitionWorkflow")
      .mockImplementationOnce(() => {
        throw new Error("simulated_projection_crash");
      });

    await expect(controller.advance(planned.id)).rejects.toThrow(
      "simulated_projection_crash",
    );
    crash.mockRestore();
    expect(store.listTasks()[0]?.status).toBe("verified_success");
    expect(store.getWorkflowRun(planned.id)?.nodes.inspect?.status).toBe(
      "pending",
    );

    const restarted = new WorkflowController(store, tasks, cipher);
    const [recovered] = await restarted.recoverInterrupted();

    expect(recovered?.nodes.inspect?.status).toBe("verified_complete");
    expect(recovered?.status).toBe("verified_complete");
    expect(
      store.listWorkflowEvents(planned.id).at(-1)?.type,
    ).toBe("workflow.recovered");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("raises an unresolved interrupted mutation to workflow recovery", async () => {
    const execute = vi.fn(async () => ({ success: true, stored: true }));
    const { controller, store, tasks, cipher } = await setup(execute);
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Interrupted mutation",
        nodes: [
          {
            id: "write",
            type: "operation",
            request: mutationRequest("Write"),
          },
        ],
      }),
    );
    const waiting = await controller.advance(planned.id);
    const taskId = waiting.run.nodes.write!.taskIds[0]!;
    const task = store.getTask(taskId)!;
    task.status = "running";
    store.saveTask(task);

    const restarted = new WorkflowController(store, tasks, cipher);
    const [recovered] = await restarted.recoverInterrupted();

    expect(recovered?.nodes.write?.status).toBe("recovery_required");
    expect(recovered?.status).toBe("recovery_required");
    expect(
      store.listWorkflowEvents(planned.id).at(-1)?.type,
    ).toBe("workflow.recovery_required");
    expect(execute).not.toHaveBeenCalled();
  });

  it("ignores a corrupt snapshot only when full event replay succeeds", async () => {
    const { controller, store } = await setup();
    const planned = controller.plan(definition("Snapshot fallback"));
    store.database
      .prepare(`
        INSERT INTO workflow_snapshots(workflow_id, sequence, data, created_at)
        VALUES (?, 999, '{}', ?)
      `)
      .run(planned.id, planned.updatedAt);

    await expect(controller.recoverInterrupted()).resolves.toHaveLength(1);
    expect(store.getWorkflowRun(planned.id)?.status).toBe("running");
  });

  it("fails closed when workflow event history is corrupt", async () => {
    const { controller, store } = await setup();
    const planned = controller.plan(definition("Corrupt history"));
    store.database
      .prepare(
        "UPDATE workflow_events SET data = '{}' WHERE aggregate_id = ?",
      )
      .run(planned.id);

    await expect(controller.recoverInterrupted()).rejects.toThrow(
      "workflow_event_history_invalid",
    );
  });
});

describe("WorkflowController operator controls", () => {
  it("refuses to advance a paused workflow and resumes where it stopped", async () => {
    const { controller } = await setup();
    const planned = controller.plan(definition("Pause me"));

    expect(controller.pause(planned.id).status).toBe("paused");
    await expect(controller.advance(planned.id)).rejects.toThrow(
      "workflow_halted:paused",
    );

    expect(controller.resume(planned.id).status).toBe("running");
    const advanced = await controller.advance(planned.id);
    expect(advanced.run.status).toBe("verified_complete");
  });

  it("suspends indefinitely and reports the halt in the event log", async () => {
    const { controller } = await setup();
    const planned = controller.plan(definition("Suspend me"));

    expect(controller.suspend(planned.id).status).toBe("suspended");
    await expect(controller.advance(planned.id)).rejects.toThrow(
      "workflow_halted:suspended",
    );
    expect(
      controller.events(planned.id).map((event) => event.type),
    ).toContain("workflow.suspended");

    controller.resume(planned.id);
    expect(
      controller.events(planned.id).map((event) => event.type),
    ).toContain("workflow.resumed");
  });

  it("is idempotent on repeat halts and rejects resuming a live run", async () => {
    const { controller } = await setup();
    const planned = controller.plan(definition("Idempotent halt"));

    expect(controller.pause(planned.id).status).toBe("paused");
    expect(controller.pause(planned.id).status).toBe("paused");
    controller.resume(planned.id);
    expect(() => controller.resume(planned.id)).toThrow(
      "workflow_not_paused",
    );
  });

  it("refuses to halt a finished workflow", async () => {
    const { controller } = await setup();
    const planned = controller.plan(definition("Already done"));
    await controller.advance(planned.id);

    expect(() => controller.pause(planned.id)).toThrow(
      "workflow_not_haltable",
    );
  });
});

describe("WorkflowController human input and delegation", () => {
  it("waits on a human_input node and clears it when the answer arrives", async () => {
    const { controller } = await setup();
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Ask first",
        nodes: [
          {
            id: "ask",
            type: "human_input",
            prompt: "Ship it?",
            choices: ["yes", "no"],
          },
          {
            id: "act",
            type: "operation",
            dependsOn: ["ask"],
            request: request("after the answer"),
          },
        ],
      }),
    );

    const waiting = await controller.advance(planned.id);
    expect(waiting.run.status).toBe("awaiting_input");
    expect(waiting.run.nodes.ask?.status).toBe("awaiting_input");
    expect(waiting.run.nodes.ask?.prompt).toBe("Ship it?");
    expect(waiting.run.nodes.act?.status).toBe("pending");

    // An unlisted answer is rejected, so a workflow can branch on a value it
    // actually enumerated rather than on arbitrary prose.
    await expect(
      controller.advance(planned.id, [], [{ nodeId: "ask", value: "maybe" }]),
    ).rejects.toThrow("workflow_input_not_a_choice:ask");

    const answered = await controller.advance(
      planned.id,
      [],
      [{ nodeId: "ask", value: "yes" }],
    );
    expect(answered.run.nodes.ask?.status).toBe("verified_complete");
    expect(answered.run.nodes.ask?.input).toBe("yes");

    const finished = await controller.advance(planned.id);
    expect(finished.run.status).toBe("verified_complete");
  });

  it("fails a delegation whose declared evidence does not hold", async () => {
    const { controller } = await setup();
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Hand it off",
        nodes: [
          {
            id: "handoff",
            type: "delegation",
            assignee: "outside-worker",
            goal: "write the report",
            requiredEvidence: [{ type: "file_exists", path: "report.md" }],
          },
        ],
      }),
    );

    expect((await controller.advance(planned.id)).run.status).toBe(
      "awaiting_input",
    );

    // The delegate says done; the file it promised is not there. A delegate's
    // word is not evidence, so the node fails rather than completing.
    const reported = await controller.advance(
      planned.id,
      [],
      [{ nodeId: "handoff", value: "done" }],
    );
    expect(reported.run.nodes.handoff?.status).toBe("failed");
    expect(reported.run.nodes.handoff?.error).toBe(
      "workflow_delegation_unverified:handoff",
    );
    expect(reported.run.status).toBe("failed");
  });

  it("refuses an answer longer than the node allows", async () => {
    const { controller } = await setup();
    const planned = controller.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Short answers only",
        nodes: [
          {
            id: "ask",
            type: "human_input",
            prompt: "Initials?",
            maxLength: 4,
          },
        ],
      }),
    );
    await controller.advance(planned.id);

    await expect(
      controller.advance(planned.id, [], [{ nodeId: "ask", value: "far too long" }]),
    ).rejects.toThrow("workflow_input_too_long:ask");
  });
});

describe("WorkflowController leases", () => {
  it("refuses a second process while one holds the workflow lease", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { store, tasks, cipher, controller } = await setup(async () => {
      started();
      await held;
      return { success: true };
    });
    // A distinct controller stands in for a second process: separate owner id,
    // separate in-process advance map, same SQLite file.
    const other = new WorkflowController(store, tasks, cipher);
    const planned = controller.plan(definition("Leased work"));

    const first = controller.advance(planned.id);
    await running;
    await expect(other.advance(planned.id)).rejects.toThrow(
      "workflow_lease_held",
    );

    release();
    expect((await first).run.status).toBe("verified_complete");
    // The lease is released with the advance, so the next process gets in.
    expect(store.getWorkflowLease(planned.id)).toBeUndefined();
  });
});
