// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  WorkflowEventSchema,
  WorkflowRunSchema,
  WorkflowSnapshotSchema,
  type WorkflowEvent,
} from "@melra/protocol";
import { applyWorkflowEvent, rebuildWorkflow } from "./workflow-events.js";

const workflowId = "11111111-1111-4111-8111-111111111111";
const definitionId = "22222222-2222-4222-8222-222222222222";
const traceId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";

function event(
  sequence: number,
  type: string,
  data: Record<string, unknown>,
): WorkflowEvent {
  return WorkflowEventSchema.parse({
    schemaVersion: "1.0.0",
    id: `${sequence.toString().padStart(8, "0")}-0000-4000-8000-000000000000`,
    aggregateId: workflowId,
    sequence,
    traceId,
    type,
    data,
    occurredAt: `2026-07-30T12:00:0${sequence}.000Z`,
  });
}

const draft = WorkflowRunSchema.parse({
  schemaVersion: "1.0.0",
  id: workflowId,
  definitionId,
  definitionVersion: 1,
  status: "draft",
  stateVersion: 1,
  nodes: { inspect: { status: "pending" } },
  traceId,
  createdAt: "2026-07-30T12:00:01.000Z",
  updatedAt: "2026-07-30T12:00:01.000Z",
});

const created = event(1, "workflow.created", { run: draft });
const planned = event(2, "workflow.status_changed", {
  from: "draft",
  to: "planned",
});
const completed = event(3, "workflow.node_changed", {
  nodeId: "inspect",
  from: "pending",
  state: { status: "verified_complete", taskIds: [taskId] },
});
const finished = event(4, "workflow.status_changed", {
  from: "planned",
  to: "verified_complete",
});

describe("workflow event replay", () => {
  it("rebuilds a projection from state-bearing events", () => {
    expect(rebuildWorkflow(undefined, [created, planned, completed, finished]))
      .toEqual(
        WorkflowRunSchema.parse({
          ...draft,
          status: "verified_complete",
          stateVersion: 4,
          nodes: {
            inspect: {
              status: "verified_complete",
              taskIds: [taskId],
            },
          },
          updatedAt: finished.occurredAt,
        }),
      );
  });

  it("continues replay from a validated snapshot", () => {
    const projection = rebuildWorkflow(undefined, [created, planned]);
    const snapshot = WorkflowSnapshotSchema.parse({
      schemaVersion: "1.0.0",
      workflowId,
      sequence: 2,
      run: projection,
      createdAt: planned.occurredAt,
    });

    expect(rebuildWorkflow(snapshot, [completed]).stateVersion).toBe(3);
  });

  it.each([
    ["missing sequence", [created, completed], "workflow_event_sequence_invalid"],
    ["duplicate sequence", [created, planned, planned], "workflow_event_sequence_invalid"],
    [
      "unknown type",
      [created, event(2, "workflow.unknown", {})],
      "workflow_event_type_unknown:workflow.unknown",
    ],
    [
      "invalid node",
      [
        created,
        event(2, "workflow.node_changed", {
          nodeId: "missing",
          from: "pending",
          state: { status: "verified_complete", taskIds: [] },
        }),
      ],
      "workflow_event_node_invalid:missing",
    ],
    [
      "mismatched prior state",
      [
        created,
        event(2, "workflow.status_changed", {
          from: "running",
          to: "planned",
        }),
      ],
      "workflow_event_state_mismatch",
    ],
  ])("rejects $0", (_name, events, error) => {
    expect(() =>
      rebuildWorkflow(undefined, events as WorkflowEvent[]),
    ).toThrow(error as string);
  });

  it("rejects applying a created event to an existing projection", () => {
    expect(() => applyWorkflowEvent(draft, created)).toThrow(
      "workflow_event_sequence_invalid",
    );
  });
});
