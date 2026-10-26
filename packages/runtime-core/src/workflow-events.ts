// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import {
  WorkflowEventSchema,
  WorkflowNodeIdSchema,
  WorkflowNodeStateSchema,
  WorkflowRunSchema,
  WorkflowSnapshotSchema,
  WorkflowStatusSchema,
  type WorkflowEvent,
  type WorkflowRun,
  type WorkflowSnapshot,
} from "@melra/protocol";

export function applyWorkflowEvent(
  current: WorkflowRun | undefined,
  event: WorkflowEvent,
): WorkflowRun {
  const parsed = WorkflowEventSchema.parse(event);
  const expectedSequence = current === undefined ? 1 : current.stateVersion + 1;
  if (parsed.sequence !== expectedSequence) {
    throw new Error("workflow_event_sequence_invalid");
  }

  if (parsed.type === "workflow.created") {
    if (current !== undefined) throw new Error("workflow_event_sequence_invalid");
    const data = record(parsed.data, parsed.type);
    const run = WorkflowRunSchema.safeParse(data.run);
    if (!run.success) throw invalidData(parsed.type);
    if (
      run.data.id !== parsed.aggregateId ||
      run.data.traceId !== parsed.traceId ||
      run.data.stateVersion !== parsed.sequence
    ) {
      throw new Error("workflow_event_identity_invalid");
    }
    return run.data;
  }

  if (current === undefined) {
    throw new Error("workflow_event_history_missing_created");
  }
  if (
    current.id !== parsed.aggregateId ||
    current.traceId !== parsed.traceId
  ) {
    throw new Error("workflow_event_identity_invalid");
  }
  const next = structuredClone(current);
  const data = record(parsed.data, parsed.type);

  switch (parsed.type) {
    case "workflow.status_changed":
    case "workflow.cancelled":
    case "workflow.recovered":
    case "workflow.recovery_required":
    // Operator halts and their reversal are ordinary status transitions: the
    // reducer checks `from` matches and applies `to`, same as the rest. Their
    // own types exist so an audit reads "an operator paused this" rather than
    // an anonymous status change.
    case "workflow.paused":
    case "workflow.suspended":
    case "workflow.resumed": {
      const from = status(data.from, parsed.type);
      const to = status(data.to, parsed.type);
      if (
        current.status !== from ||
        (parsed.type === "workflow.cancelled" && to !== "cancelled") ||
        (parsed.type === "workflow.recovery_required" &&
          to !== "recovery_required") ||
        (parsed.type === "workflow.paused" && to !== "paused") ||
        (parsed.type === "workflow.suspended" && to !== "suspended")
      ) {
        throw new Error("workflow_event_state_mismatch");
      }
      next.status = to;
      if (data.error === undefined) {
        delete next.error;
      } else if (typeof data.error === "string") {
        next.error = data.error;
      } else {
        throw invalidData(parsed.type);
      }
      break;
    }
    case "workflow.node_changed": {
      const nodeId = WorkflowNodeIdSchema.safeParse(data.nodeId);
      const state = WorkflowNodeStateSchema.safeParse(data.state);
      if (!nodeId.success || !state.success) throw invalidData(parsed.type);
      const previous = current.nodes[nodeId.data];
      if (previous === undefined) {
        throw new Error(`workflow_event_node_invalid:${nodeId.data}`);
      }
      if (previous.status !== data.from) {
        throw new Error("workflow_event_state_mismatch");
      }
      next.nodes[nodeId.data] = state.data;
      break;
    }
    case "workflow.checkpoint_saved":
      if (
        !Number.isInteger(data.sequence) ||
        (data.sequence as number) < 1
      ) {
        throw invalidData(parsed.type);
      }
      break;
    default:
      throw new Error(`workflow_event_type_unknown:${parsed.type}`);
  }

  next.stateVersion = parsed.sequence;
  next.updatedAt = parsed.occurredAt;
  return WorkflowRunSchema.parse(next);
}

export function rebuildWorkflow(
  snapshot: WorkflowSnapshot | undefined,
  events: WorkflowEvent[],
): WorkflowRun {
  let current =
    snapshot === undefined
      ? undefined
      : WorkflowSnapshotSchema.parse(snapshot).run;
  if (current === undefined && events.length === 0) {
    throw new Error("workflow_event_history_empty");
  }
  for (const event of events) current = applyWorkflowEvent(current, event);
  return WorkflowRunSchema.parse(current);
}

function record(
  value: unknown,
  eventType: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidData(eventType);
  }
  return value as Record<string, unknown>;
}

function status(value: unknown, eventType: string): WorkflowRun["status"] {
  const parsed = WorkflowStatusSchema.safeParse(value);
  if (!parsed.success) throw invalidData(eventType);
  return parsed.data;
}

function invalidData(eventType: string): Error {
  return new Error(`workflow_event_data_invalid:${eventType}`);
}
