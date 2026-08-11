// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  WorkflowDefinitionSchema,
  type OperationNode,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeState,
} from "@melra/protocol";
import { readyNodeIds, validateWorkflow } from "./workflow-graph.js";

const definitionId = "11111111-1111-4111-8111-111111111111";

function operation(id: string, dependsOn: string[] = []): OperationNode {
  return {
    id,
    type: "operation",
    dependsOn,
    request: {
      goal: `Run ${id}`,
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
    },
  };
}

function definition(nodes: WorkflowNode[]): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    schemaVersion: "1.0.0",
    id: definitionId,
    version: 1,
    name: "Graph test",
    nodes,
  });
}

const invalidGraphs: Array<{ nodes: WorkflowNode[]; error: string }> = [
  {
    nodes: [operation("same"), operation("same")],
    error: "workflow_node_id_duplicate",
  },
  {
    nodes: [operation("node", ["missing"])],
    error: "workflow_dependency_missing:node:missing",
  },
  {
    nodes: [operation("node", ["node"])],
    error: "workflow_node_self_dependency:node",
  },
  {
    nodes: [operation("a", ["b"]), operation("b", ["a"])],
    error: "workflow_dependency_cycle",
  },
  {
    nodes: [
      { id: "approve", type: "approval", dependsOn: [], forNodeId: "missing" },
    ],
    error: "workflow_approval_target_missing:approve",
  },
  {
    nodes: [
      { id: "approve", type: "approval", dependsOn: [], forNodeId: "target" },
      operation("target"),
    ],
    error: "workflow_approval_must_precede_target:approve",
  },
  {
    nodes: [
      {
        id: "undo",
        type: "compensation",
        dependsOn: [],
        forNodeId: "missing",
        request: operation("request").request,
      },
    ],
    error: "workflow_compensation_target_missing:undo",
  },
  {
    nodes: [
      { id: "checkpoint", type: "checkpoint", dependsOn: [] },
      {
        id: "undo",
        type: "compensation",
        dependsOn: [],
        forNodeId: "checkpoint",
        request: operation("request").request,
      },
    ],
    error: "workflow_compensation_target_not_operation:undo",
  },
  {
    nodes: [
      {
        id: "condition",
        type: "condition",
        dependsOn: [],
        sourceNodeId: "missing",
        predicate: { type: "result_equals", path: "ok", value: true },
        whenTrue: [],
        whenFalse: [],
      },
    ],
    error: "workflow_condition_source_missing:condition",
  },
  {
    nodes: [
      { id: "checkpoint", type: "checkpoint", dependsOn: [] },
      {
        id: "condition",
        type: "condition",
        dependsOn: [],
        sourceNodeId: "checkpoint",
        predicate: { type: "result_equals", path: "ok", value: true },
        whenTrue: [],
        whenFalse: [],
      },
    ],
    error: "workflow_condition_source_not_operation:condition",
  },
];

describe("workflow graph", () => {
  it("emits deterministic lexical topological layers", () => {
    const graph = validateWorkflow(
      definition([
        operation("write-b", ["inspect"]),
        { id: "checkpoint", type: "checkpoint", dependsOn: ["write-a", "write-b"] },
        operation("inspect"),
        operation("write-a", ["inspect"]),
      ]),
    );

    expect(graph.layers).toEqual([
      ["inspect"],
      ["write-a", "write-b"],
      ["checkpoint"],
    ]);
  });

  it.each(invalidGraphs)("rejects invalid graphs with $error", ({ nodes, error }) => {
    expect(() => validateWorkflow(definition(nodes))).toThrow(error);
  });

  it("rejects definitions above the node bound with a stable error", () => {
    const oversized = {
      schemaVersion: "1.0.0",
      id: definitionId,
      version: 1,
      name: "Oversized",
      nodes: Array.from({ length: 501 }, (_, index) =>
        operation(`node-${index}`),
      ),
    } as WorkflowDefinition;

    expect(() => validateWorkflow(oversized)).toThrow(
      "workflow_node_limit_exceeded",
    );
  });

  it("selects ready normal nodes in lexical order", () => {
    const graph = validateWorkflow(
      definition([
        operation("source"),
        operation("z-ready", ["source"]),
        operation("a-ready", ["source"]),
        {
          id: "undo",
          type: "compensation",
          dependsOn: ["source"],
          forNodeId: "source",
          request: operation("request").request,
        },
      ]),
    );
    const states: Record<string, WorkflowNodeState> = {
      source: { status: "verified_complete", taskIds: [] },
      "z-ready": { status: "pending", taskIds: [] },
      "a-ready": { status: "pending", taskIds: [] },
      undo: { status: "pending", taskIds: [] },
    };

    expect(readyNodeIds(graph, states)).toEqual(["a-ready", "z-ready"]);
  });
});
