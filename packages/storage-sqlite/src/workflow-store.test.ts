// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EncryptedPayloadSchema,
  TaskRequestSchema,
  WorkflowDefinitionSchema,
  WorkflowEventSchema,
  WorkflowRunSchema,
  WorkflowSnapshotSchema,
  type EncryptedPayload,
  type TaskRecord,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowRun,
} from "@melra/protocol";
import { SqliteStore } from "./index.js";

const now = "2026-07-30T12:00:00.000Z";
const definitionId = "11111111-1111-4111-8111-111111111111";
const workflowId = "22222222-2222-4222-8222-222222222222";
const traceId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];
const stores: SqliteStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function envelope(seed: string): EncryptedPayload {
  return EncryptedPayloadSchema.parse({
    version: 1,
    algorithm: "aes-256-gcm",
    iv: Buffer.from(`iv-${seed}`).toString("base64url"),
    ciphertext: Buffer.from(`ciphertext-${seed}`).toString("base64url"),
    tag: Buffer.from(`tag-${seed}`).toString("base64url"),
  });
}

function definition(goal = "Inspect the runtime"): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    schemaVersion: "1.0.0",
    id: definitionId,
    version: 1,
    name: "restart-safe",
    nodes: [
      {
        id: "inspect",
        type: "operation",
        dependsOn: [],
        request: {
          goal,
          operation: { kind: "system", action: "info" },
        },
      },
    ],
  });
}

function run(stateVersion = 1, status: WorkflowRun["status"] = "draft") {
  return WorkflowRunSchema.parse({
    schemaVersion: "1.0.0",
    id: workflowId,
    definitionId,
    definitionVersion: 1,
    status,
    stateVersion,
    nodes: { inspect: { status: "pending" } },
    traceId,
    createdAt: now,
    updatedAt: now,
  });
}

function event(
  sequence: number,
  id: string,
  type = "workflow.created",
): WorkflowEvent {
  return WorkflowEventSchema.parse({
    schemaVersion: "1.0.0",
    id,
    aggregateId: workflowId,
    sequence,
    traceId,
    type,
    data: { nodeId: "inspect" },
    occurredAt: now,
  });
}

function task(status: TaskRecord["status"] = "verifying"): TaskRecord {
  return {
    id: taskId,
    request: TaskRequestSchema.parse({
      goal: "[REDACTED]",
      operation: { kind: "system", action: "info" },
    }),
    status,
    policyDecision: {
      outcome: "allow",
      effect: "read",
      risk: "low",
      reason: "read_only_operation",
      policyVersion: "1",
      traits: [],
    },
    receiptIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe("durable workflow storage", () => {
  it("stores only sealed execution payloads and reads validated records", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-workflow-store-"));
    roots.push(root);
    const databasePath = join(root, "melra.sqlite");
    const store = new SqliteStore(databasePath);
    stores.push(store);
    const initialRun = run();
    const created = event(
      1,
      "55555555-5555-4555-8555-555555555555",
    );

    store.saveTask(task("planned"));
    store.saveTaskPayload(taskId, envelope("one-time-secret-request"), now);
    store.saveTaskExecutionResult(task(), envelope("one-time-secret-result"));
    store.createWorkflow(
      definition("[REDACTED]"),
      envelope("one-time-secret-workflow"),
      initialRun,
      [created],
    );
    store.saveWorkflowSnapshot(
      WorkflowSnapshotSchema.parse({
        schemaVersion: "1.0.0",
        workflowId,
        sequence: 1,
        run: initialRun,
        createdAt: now,
      }),
    );

    expect(store.getTaskPayload(taskId)).toEqual(
      envelope("one-time-secret-request"),
    );
    expect(store.getTaskResult(taskId)).toEqual(
      envelope("one-time-secret-result"),
    );
    expect(store.getWorkflowDefinition(definitionId, 1)?.name).toBe(
      "restart-safe",
    );
    expect(store.getWorkflowPayload(definitionId, 1)).toEqual(
      envelope("one-time-secret-workflow"),
    );
    expect(store.getWorkflowRun(workflowId)).toEqual(initialRun);
    expect(store.listWorkflowEvents(workflowId)).toEqual([created]);
    expect(store.getLatestWorkflowSnapshot(workflowId)?.sequence).toBe(1);
    expect(store.listInterruptedTasks()).toEqual([task()]);
    expect(store.commitIdempotency("stable-key", taskId, 1, now)).toBe(true);
    expect(store.commitIdempotency("stable-key", taskId, 2, now)).toBe(false);
    expect(store.getIdempotencyCommit("stable-key")).toEqual({
      taskId,
      attempt: 1,
      committedAt: now,
    });
    store.deleteTaskPayload(taskId);
    expect(store.getTaskPayload(taskId)).toBeUndefined();
    expect(store.getTaskResult(taskId)).toBeUndefined();

    store.close();
    stores.splice(stores.indexOf(store), 1);
    expect((await readFile(databasePath)).toString()).not.toContain(
      "one-time-secret",
    );
  });

  it("seals each event in the transaction that writes it", () => {
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const key = randomBytes(32);
    store.sealRecords(key);
    store.createWorkflow(definition("[REDACTED]"), envelope("workflow"), run(), [
      event(1, "55555555-5555-4555-8555-555555555555"),
    ]);
    store.transitionWorkflow(workflowId, 1, run(2, "running"), [
      event(2, "66666666-6666-4666-8666-666666666666", "workflow.started"),
    ]);
    // A stale transition rolls back with its events, and seals none.
    expect(() =>
      store.transitionWorkflow(workflowId, 1, run(2, "running"), [
        event(2, "77777777-7777-4777-8777-777777777777", "workflow.started"),
      ]),
    ).toThrow("workflow_state_conflict");
    expect(store.verifyChain(key)).toMatchObject({ ok: true, unsealed: 0, head: { sequence: 2 } });
  });

  it("appends events monotonically and rejects stale projections", () => {
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const initialRun = run();
    const created = event(
      1,
      "55555555-5555-4555-8555-555555555555",
    );
    store.createWorkflow(
      definition("[REDACTED]"),
      envelope("workflow"),
      initialRun,
      [created],
    );

    const nextRun = run(2, "planned");
    const planned = event(
      2,
      "66666666-6666-4666-8666-666666666666",
      "workflow.status_changed",
    );
    store.transitionWorkflow(workflowId, 1, nextRun, [planned]);

    expect(
      store.listWorkflowEvents(workflowId).map((item) => item.sequence),
    ).toEqual([1, 2]);
    expect(
      store
        .listWorkflowEvents(workflowId, 1)
        .map((item) => item.sequence),
    ).toEqual([2]);
    expect(() =>
      store.transitionWorkflow(workflowId, 1, nextRun, [
        event(
          2,
          "77777777-7777-4777-8777-777777777777",
          "workflow.status_changed",
        ),
      ]),
    ).toThrow("workflow_state_conflict");
  });

  it("rolls back the projection and every event when an append fails", () => {
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const initialRun = run();
    const created = event(
      1,
      "55555555-5555-4555-8555-555555555555",
    );
    store.createWorkflow(
      definition("[REDACTED]"),
      envelope("workflow"),
      initialRun,
      [created],
    );
    const blocking = event(
      3,
      "99999999-9999-4999-8999-999999999999",
      "workflow.node_ready",
    );
    store.database
      .prepare(`
        INSERT INTO workflow_events(
          id, aggregate_id, sequence, trace_id, type, data, occurred_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        blocking.id,
        blocking.aggregateId,
        blocking.sequence,
        blocking.traceId,
        blocking.type,
        JSON.stringify(blocking),
        blocking.occurredAt,
      );

    expect(() =>
      store.transitionWorkflow(workflowId, 1, run(3, "running"), [
        event(
          2,
          "88888888-8888-4888-8888-888888888888",
          "workflow.status_changed",
        ),
        event(3, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "workflow.node_ready"),
      ]),
    ).toThrow();
    expect(store.getWorkflowRun(workflowId)).toEqual(initialRun);
    expect(
      store.listWorkflowEvents(workflowId).map((item) => item.sequence),
    ).toEqual([1, 3]);
  });

  it("rolls back the task projection when result payload storage fails", () => {
    const store = new SqliteStore(":memory:");
    stores.push(store);

    expect(() =>
      store.saveTaskExecutionResult(task(), envelope("result")),
    ).toThrow("task_payload_not_found");
    expect(store.getTask(taskId)).toBeUndefined();
  });

  it("lists the tasks under one idempotency key, any status, from an index", () => {
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const key = "a".repeat(64);
    const second = "55555555-5555-4555-8555-555555555555";
    store.saveTask({ ...task("cancelled"), idempotencyKey: key });
    store.saveTask({ ...task("awaiting_approval"), id: second, idempotencyKey: key, attempt: 2 });
    store.saveTask({ ...task("planned"), id: "66666666-6666-4666-8666-666666666666", idempotencyKey: "b".repeat(64) });
    store.saveTask({ ...task("planned"), id: "77777777-7777-4777-8777-777777777777" });
    expect(store.listTasksByKey(key).map((found) => found.id).sort()).toEqual([taskId, second]);
    expect(store.listTasksByKey("c".repeat(64))).toEqual([]);
    const plan = store.database
      .prepare("EXPLAIN QUERY PLAN SELECT data FROM tasks WHERE json_extract(data, '$.idempotencyKey') = ?")
      .all(key) as Array<{ detail: string }>;
    // A workflow step asks this for every task it plans; it must not scan every task.
    expect(plan.map((row) => row.detail).join("\n")).toContain("USING INDEX tasks_idempotency_key");
  });

  it("rejects mismatched definition and event identities", () => {
    const definitionMismatch = new SqliteStore(":memory:");
    stores.push(definitionMismatch);
    const otherDefinition = WorkflowDefinitionSchema.parse({
      ...definition("[REDACTED]"),
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    expect(() =>
      definitionMismatch.createWorkflow(
        otherDefinition,
        envelope("workflow"),
        run(),
        [event(1, "55555555-5555-4555-8555-555555555555")],
      ),
    ).toThrow("workflow_definition_mismatch");
    expect(definitionMismatch.getWorkflowRun(workflowId)).toBeUndefined();

    const traceMismatch = new SqliteStore(":memory:");
    stores.push(traceMismatch);
    const wrongTrace = WorkflowEventSchema.parse({
      ...event(1, "66666666-6666-4666-8666-666666666666"),
      traceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(() =>
      traceMismatch.createWorkflow(
        definition("[REDACTED]"),
        envelope("workflow"),
        run(),
        [wrongTrace],
      ),
    ).toThrow("workflow_event_identity_invalid");
    expect(traceMismatch.getWorkflowRun(workflowId)).toBeUndefined();

    const projectionMismatch = new SqliteStore(":memory:");
    stores.push(projectionMismatch);
    const initialRun = run();
    projectionMismatch.createWorkflow(
      definition("[REDACTED]"),
      envelope("workflow"),
      initialRun,
      [event(1, "77777777-7777-4777-8777-777777777777")],
    );
    const wrongTraceRun = WorkflowRunSchema.parse({
      ...run(2, "planned"),
      traceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    const wrongTraceEvent = WorkflowEventSchema.parse({
      ...event(
        2,
        "88888888-8888-4888-8888-888888888888",
        "workflow.status_changed",
      ),
      traceId: wrongTraceRun.traceId,
    });
    expect(() =>
      projectionMismatch.transitionWorkflow(
        workflowId,
        1,
        wrongTraceRun,
        [wrongTraceEvent],
      ),
    ).toThrow("workflow_projection_identity_mismatch");
    expect(projectionMismatch.getWorkflowRun(workflowId)).toEqual(initialRun);
  });

  it.each([
    [
      "workflow definition",
      "UPDATE workflow_definitions SET data = '{}'",
      "stored_workflow_definition_invalid",
      (store: SqliteStore) => store.getWorkflowDefinition(definitionId, 1),
    ],
    [
      "workflow run",
      "UPDATE workflow_runs SET data = '{}'",
      "stored_workflow_run_invalid",
      (store: SqliteStore) => store.getWorkflowRun(workflowId),
    ],
    [
      "workflow event",
      // The events refuse an edit, so this one drops their trigger first.
      "DROP TRIGGER workflow_events_no_update; UPDATE workflow_events SET data = '{}'",
      "stored_workflow_event_invalid",
      (store: SqliteStore) => store.listWorkflowEvents(workflowId),
    ],
    [
      "workflow payload",
      "UPDATE workflow_payloads SET payload = '{}'",
      "stored_workflow_payload_invalid",
      (store: SqliteStore) => store.getWorkflowPayload(definitionId, 1),
    ],
    [
      "workflow snapshot",
      "UPDATE workflow_snapshots SET data = '{}'",
      "stored_workflow_snapshot_invalid",
      (store: SqliteStore) => store.getLatestWorkflowSnapshot(workflowId),
    ],
    [
      "task request payload",
      "UPDATE task_payloads SET request_payload = '{}'",
      "stored_task_payload_invalid",
      (store: SqliteStore) => store.getTaskPayload(taskId),
    ],
    [
      "task result payload",
      "UPDATE task_payloads SET result_payload = '{}'",
      "stored_task_result_invalid",
      (store: SqliteStore) => store.getTaskResult(taskId),
    ],
  ])("rejects corrupt %s JSON", (_record, update, expected, read) => {
    const store = new SqliteStore(":memory:");
    stores.push(store);
    store.saveTask(task("planned"));
    store.saveTaskPayload(taskId, envelope("request"), now);
    store.saveTaskExecutionResult(task(), envelope("result"));
    const initialRun = run();
    store.createWorkflow(
      definition("[REDACTED]"),
      envelope("workflow"),
      initialRun,
      [event(1, "55555555-5555-4555-8555-555555555555")],
    );
    store.saveWorkflowSnapshot(
      WorkflowSnapshotSchema.parse({
        schemaVersion: "1.0.0",
        workflowId,
        sequence: 1,
        run: initialRun,
        createdAt: now,
      }),
    );
    store.database.exec(update);

    expect(() => read(store)).toThrow(expected);
  });
});
