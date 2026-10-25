// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import {
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeState,
} from "@melra/protocol";

export interface WorkflowGraph {
  nodes: ReadonlyMap<string, WorkflowNode>;
  layers: readonly (readonly string[])[];
}

export function validateWorkflow(
  definition: WorkflowDefinition,
): WorkflowGraph {
  if (definition.nodes.length > 500) {
    throw new Error("workflow_node_limit_exceeded");
  }
  const parsed = WorkflowDefinitionSchema.parse(definition);
  const nodes = new Map<string, WorkflowNode>();
  for (const node of parsed.nodes) {
    if (nodes.has(node.id)) throw new Error("workflow_node_id_duplicate");
    nodes.set(node.id, node);
  }

  for (const node of nodes.values()) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.id) {
        throw new Error(`workflow_node_self_dependency:${node.id}`);
      }
      if (!nodes.has(dependency)) {
        throw new Error(
          `workflow_dependency_missing:${node.id}:${dependency}`,
        );
      }
    }
    if (node.type === "approval" && !nodes.has(node.forNodeId)) {
      throw new Error(`workflow_approval_target_missing:${node.id}`);
    }
    if (node.type === "compensation") {
      const target = nodes.get(node.forNodeId);
      if (target === undefined) {
        throw new Error(`workflow_compensation_target_missing:${node.id}`);
      }
      if (target.type !== "operation") {
        throw new Error(
          `workflow_compensation_target_not_operation:${node.id}`,
        );
      }
    }
    if (node.type === "condition") {
      const source = nodes.get(node.sourceNodeId);
      if (source === undefined) {
        throw new Error(`workflow_condition_source_missing:${node.id}`);
      }
      if (source.type !== "operation") {
        throw new Error(`workflow_condition_source_not_operation:${node.id}`);
      }
    }
  }

  const indegrees = new Map(
    [...nodes.values()].map((node) => [node.id, node.dependsOn.length]),
  );
  const dependents = new Map<string, string[]>();
  for (const node of nodes.values()) {
    for (const dependency of node.dependsOn) {
      const children = dependents.get(dependency) ?? [];
      children.push(node.id);
      dependents.set(dependency, children);
    }
  }
  let ready = [...nodes.keys()]
    .filter((id) => indegrees.get(id) === 0)
    .sort();
  const layers: string[][] = [];
  let processed = 0;
  while (ready.length > 0) {
    const layer = ready;
    layers.push(layer);
    processed += layer.length;
    const next: string[] = [];
    for (const id of layer) {
      for (const dependent of dependents.get(id) ?? []) {
        const remaining = indegrees.get(dependent)! - 1;
        indegrees.set(dependent, remaining);
        if (remaining === 0) next.push(dependent);
      }
    }
    ready = next.sort();
  }
  if (processed !== nodes.size) throw new Error("workflow_dependency_cycle");

  for (const node of nodes.values()) {
    if (
      node.type === "approval" &&
      !hasDependency(nodes, node.forNodeId, node.id)
    ) {
      throw new Error(`workflow_approval_must_precede_target:${node.id}`);
    }
    // The approval runs its target's effect the moment it is given, so every
    // other dependency of the target has to be able to finish first. One that
    // itself waits on the approval would run after the effect it was meant to
    // precede.
    if (node.type === "approval") {
      const target = nodes.get(node.forNodeId)!;
      for (const dependency of target.dependsOn) {
        if (dependency !== node.id && hasDependency(nodes, dependency, node.id)) {
          throw new Error(`workflow_approval_target_dependency_after_approval:${node.id}:${dependency}`);
        }
      }
    }
    // A condition reads its source's result, so the source has to have run.
    // Without the dependency both were started together and the condition
    // threw on every advance.
    if (node.type === "condition" && !hasDependency(nodes, node.id, node.sourceNodeId)) {
      throw new Error(`workflow_condition_source_must_precede:${node.id}`);
    }
  }

  return { nodes, layers };
}

export function readyNodeIds(
  graph: WorkflowGraph,
  states: Record<string, WorkflowNodeState>,
): string[] {
  const done = (id: string) =>
    ["verified_complete", "skipped", "compensated"].includes(states[id]?.status ?? "");
  return [...graph.nodes.values()]
    .filter(
      (node) =>
        node.type !== "compensation" &&
        states[node.id]?.status === "pending" &&
        node.dependsOn.every(done) &&
        // An approval executes its target's effect, so it is offered only
        // once the target could run: before, a delete approved alongside the
        // backup it depended on ran first, and its undo was then skipped.
        (node.type !== "approval" ||
          (graph.nodes.get(node.forNodeId)?.dependsOn ?? []).every(
            (id) => id === node.id || done(id),
          )),
    )
    .map((node) => node.id)
    .sort();
}

function hasDependency(
  nodes: ReadonlyMap<string, WorkflowNode>,
  nodeId: string,
  dependencyId: string,
): boolean {
  const pending = [...nodes.get(nodeId)!.dependsOn];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === dependencyId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...nodes.get(current)!.dependsOn);
  }
  return false;
}
