// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  WorkflowDefinitionSchema,
  WorkflowEventSchema,
  WorkflowRunSchema,
  WorkflowSnapshotSchema,
  type ApprovalResponse,
  type TaskRecord,
  type TaskRequest,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowInput,
  type WorkflowNode,
  type WorkflowNodeState,
  type WorkflowRun,
} from "@melra/protocol";
import {
  canonicalJson,
  redactStructuredValue,
  sha256,
} from "@melra/receipt-schema";
import { SqliteStore } from "@melra/storage-sqlite";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";
import {
  applyWorkflowEvent,
  rebuildWorkflow,
} from "./workflow-events.js";
import {
  readyNodeIds,
  validateWorkflow,
  type WorkflowGraph,
} from "./workflow-graph.js";

type EmitEvent = (
  type: string,
  data: Record<string, unknown>,
) => void;

export interface WorkflowAdvanceResult {
  run: WorkflowRun;
  tasks: TaskRecord[];
  events: WorkflowEvent[];
}

interface NodeAdvance {
  state: WorkflowNodeState;
  tasks: TaskRecord[];
  checkpoint?: boolean;
}

interface TaskIdentity {
  workflowId: string;
  nodeId: string;
  iteration: number;
  branch: string;
}

export class WorkflowController {
  // In-process advances serialize on this map; competing *processes* serialize
  // on a SQLite lease (see `advance`). Both are needed: the map keeps one
  // process from racing itself without touching the disk on every call.
  private readonly advances = new Map<string, Promise<WorkflowAdvanceResult>>();
  private readonly owner = `${process.pid}:${randomUUID()}`;

  constructor(
    private readonly store: SqliteStore,
    private readonly tasks: TaskController,
    private readonly payloadCipher: PayloadCipher,
    private readonly leaseDurationMs = 60_000,
  ) {}

  plan(definition: WorkflowDefinition): WorkflowRun {
    const parsed = WorkflowDefinitionSchema.parse(definition);
    const graph = validateWorkflow(parsed);
    for (const node of graph.nodes.values()) {
      for (const request of requestsFor(node)) {
        if (this.tasks.preflight(request).outcome === "deny") {
          throw new Error(`workflow_policy_blocked:${node.id}`);
        }
      }
    }

    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const traceId = randomUUID();
    const draft = WorkflowRunSchema.parse({
      schemaVersion: "1.0.0",
      id,
      definitionId: parsed.id,
      definitionVersion: parsed.version,
      status: "draft",
      stateVersion: 1,
      nodes: Object.fromEntries(
        parsed.nodes.map((node) => [node.id, { status: "pending" }]),
      ),
      traceId,
      createdAt,
      updatedAt: createdAt,
    });
    const created = makeEvent(draft, 1, "workflow.created", { run: draft });
    const plannedEvent = makeEvent(draft, 2, "workflow.status_changed", {
      from: "draft",
      to: "planned",
    });
    const planned = applyWorkflowEvent(draft, plannedEvent);
    const redacted = WorkflowDefinitionSchema.parse(
      redactStructuredValue(parsed).value,
    );
    this.store.createWorkflow(
      redacted,
      this.payloadCipher.seal(
        parsed,
        `workflow:${parsed.id}:${parsed.version}:definition`,
      ),
      planned,
      [created, plannedEvent],
    );
    return planned;
  }

  status(workflowId: string): WorkflowRun {
    const run = this.store.getWorkflowRun(workflowId);
    if (run === undefined) throw new Error("workflow_not_found");
    return run;
  }

  events(workflowId: string, afterSequence = 0): WorkflowEvent[] {
    this.status(workflowId);
    return this.store.listWorkflowEvents(workflowId, afterSequence);
  }

  async advance(
    workflowId: string,
    approvals: ApprovalResponse[] = [],
    inputs: WorkflowInput[] = [],
  ): Promise<WorkflowAdvanceResult> {
    const previous = this.advances.get(workflowId);
    const ready =
      previous === undefined
        ? Promise.resolve()
        : previous.then(
            () => undefined,
            () => undefined,
          );
    const result = ready.then(() =>
      this.leasedAdvance(workflowId, approvals, inputs),
    );
    this.advances.set(workflowId, result);
    try {
      return await result;
    } finally {
      if (this.advances.get(workflowId) === result) {
        this.advances.delete(workflowId);
      }
    }
  }

  // The lease is taken before any adapter runs, so a second process cannot
  // start duplicate side effects while this one is mid-flight. `transitionWorkflow`
  // still guards the commit; this guards the work leading up to it.
  private async leasedAdvance(
    workflowId: string,
    approvals: ApprovalResponse[],
    inputs: WorkflowInput[],
  ): Promise<WorkflowAdvanceResult> {
    this.status(workflowId);
    const now = Date.now();
    if (
      !this.store.acquireWorkflowLease(
        workflowId,
        this.owner,
        new Date(now).toISOString(),
        new Date(now + this.leaseDurationMs).toISOString(),
      )
    ) {
      throw new Error("workflow_lease_held");
    }
    // A long advance must not let its own lease lapse and invite a second
    // process in, so renew at half the duration while the adapters run.
    const renewal = setInterval(() => {
      this.store.renewWorkflowLease(
        workflowId,
        this.owner,
        new Date(Date.now() + this.leaseDurationMs).toISOString(),
      );
    }, Math.max(1_000, Math.floor(this.leaseDurationMs / 2)));
    renewal.unref();
    try {
      return await this.advanceOnce(workflowId, approvals, inputs);
    } finally {
      clearInterval(renewal);
      this.store.releaseWorkflowLease(workflowId, this.owner);
    }
  }

  private async advanceOnce(
    workflowId: string,
    approvals: ApprovalResponse[],
    inputs: WorkflowInput[],
  ): Promise<WorkflowAdvanceResult> {
    const current = this.status(workflowId);
    if (["verified_complete", "cancelled"].includes(current.status)) {
      return { run: current, tasks: [], events: [] };
    }
    // A halted workflow is a deliberate operator decision. Failing loudly beats
    // returning an unchanged run, which reads to a caller like "nothing to do".
    if (["paused", "suspended"].includes(current.status)) {
      throw new Error(`workflow_halted:${current.status}`);
    }
    const definition = this.loadDefinition(current);
    const graph = validateWorkflow(definition);
    const rollback =
      current.status === "failed"
        ? definition.nodes
            .filter(
              (node) =>
                node.type === "compensation" &&
                ["pending", "awaiting_approval"].includes(
                  current.nodes[node.id]?.status ?? "",
                ) &&
                current.nodes[node.forNodeId]?.status ===
                  "verified_complete",
            )
            .map((node) => node.id)
            .reverse()
        : [];
    if (current.status === "failed" && rollback.length === 0) {
      return { run: current, tasks: [], events: [] };
    }
    // An unwind that stopped half-done is not a base to build more effects on:
    // a forward effect happened, its declared inverse did not, and no node
    // describes that. Refused here rather than left to `readyNodeIds`, which
    // would happily start an independent branch on top of it.
    if (
      definition.nodes.some(
        (node) =>
          node.type === "compensation" &&
          ["failed", "recovery_required"].includes(
            current.nodes[node.id]?.status ?? "",
          ),
      )
    ) {
      return { run: current, tasks: [], events: [] };
    }
    // A node parked for a human — approval phrase or supplied input — is no
    // longer `pending`, so `readyNodeIds` will not return it. Re-offer it here
    // or the workflow would stall forever with the answer in hand.
    const awaiting = [...graph.nodes.values()]
      .filter(
        (node) =>
          node.type !== "compensation" &&
          ["awaiting_approval", "awaiting_input"].includes(
            current.nodes[node.id]?.status ?? "",
          ),
      )
      .map((node) => node.id)
      .sort();
    const nodeIds =
      rollback.length > 0
        ? rollback
        : awaiting.length > 0
        ? awaiting
        : readyNodeIds(graph, current.nodes);
    if (nodeIds.length === 0) {
      return { run: current, tasks: [], events: [] };
    }

    const results: Array<{ nodeId: string; result: NodeAdvance }> = await (rollback.length >
    0
      ? // Compensations undo each other's preconditions, so the order they run
        // in *is* the semantics: cancel the shipment before refunding the
        // charge that paid for it. `Promise.all` computed a reverse list and
        // then threw the order away by starting them all at once. Sequential,
        // and stopping at the first one that does not reach `compensated` —
        // continuing past a failed unwind would strand the saga in a state no
        // node describes.
        this.unwind(rollback, graph, definition, current, approvals, inputs)
      : Promise.all(
          nodeIds.map(async (nodeId) => {
            const node = graph.nodes.get(nodeId)!;
            return {
              nodeId,
              result: await this.advanceNode(
                node,
                definition,
                current.nodes[nodeId]!,
                current,
                approvals,
                inputs,
              ),
            };
          }),
        ));
    // A *compensation* that failed must not open a second unwind. The saga is
    // already stranded, and undoing the next step while this inverse is still
    // outstanding is precisely what the halt exists to prevent — so only a
    // forward node failing starts compensating.
    if (
      results.some(
        ({ nodeId, result }) =>
          result.state.status === "failed" &&
          graph.nodes.get(nodeId)?.type !== "compensation",
      )
    ) {
      for (const node of [...definition.nodes].reverse()) {
        if (
          node.type !== "compensation" ||
          current.nodes[node.id]?.status !== "pending"
        ) {
          continue;
        }
        const targetState =
          results.find(({ nodeId }) => nodeId === node.forNodeId)?.result
            .state ?? current.nodes[node.forNodeId];
        if (targetState?.status !== "verified_complete") {
          results.push({
            nodeId: node.id,
            result: {
              state: { status: "skipped", taskIds: [] },
              tasks: [],
            },
          });
          continue;
        }
        const compensation = await this.runTask(
          node.request,
          current.nodes[node.id]?.taskIds[0],
          approvals,
          true,
          {
            workflowId: current.id,
            nodeId: node.id,
            iteration: 0,
            branch: "compensation",
          },
        );
        results.push({
          nodeId: node.id,
          result: {
            ...compensation,
            state:
              compensation.state.status === "verified_complete"
                ? { ...compensation.state, status: "compensated" }
                : compensation.state,
          },
        });
        // Same rule as a resumed unwind: stop rather than undo step 1 while
        // step 3's inverse is still outstanding.
        if (compensation.state.status !== "verified_complete") break;
      }
    }
    let run = this.transition(current, (draft, emit) => {
      for (const { nodeId, result } of results) {
        const from = draft.nodes[nodeId]!.status;
        draft.nodes[nodeId] = result.state;
        emit("workflow.node_changed", {
          nodeId,
          from,
          state: result.state,
        });
      }
      let status = this.deriveStatus(draft, definition);
      if (status === "verified_complete") {
        for (const node of definition.nodes) {
          const state = draft.nodes[node.id]!;
          if (node.type !== "compensation" || state.status !== "pending") {
            continue;
          }
          state.status = "skipped";
          emit("workflow.node_changed", {
            nodeId: node.id,
            from: "pending",
            state,
          });
        }
        status = this.deriveStatus(draft, definition);
      }
      if (status !== draft.status) {
        const from = draft.status;
        draft.status = status;
        // Name the step, or "recovery_required" tells an operator that
        // something needs hands without saying which effect is half-undone.
        const stalled = definition.nodes.find(
          (node) =>
            node.type === "compensation" &&
            ["failed", "recovery_required"].includes(
              draft.nodes[node.id]?.status ?? "",
            ),
        );
        if (status === "recovery_required" && stalled !== undefined) {
          draft.error = `workflow_compensation_incomplete:${stalled.id}`;
        } else {
          // The reducer clears `error` on every status change, so the draft has
          // to as well or replay no longer reproduces the projection.
          delete draft.error;
        }
        emit("workflow.status_changed", {
          from,
          to: status,
          ...(draft.error === undefined ? {} : { error: draft.error }),
        });
      }
    });
    if (results.some(({ result }) => result.checkpoint === true)) {
      run = this.transition(run, (draft, emit) => {
        emit("workflow.checkpoint_saved", {
          sequence: draft.stateVersion + 1,
        });
      });
      this.store.saveWorkflowSnapshot(
        WorkflowSnapshotSchema.parse({
          schemaVersion: "1.0.0",
          workflowId: run.id,
          sequence: run.stateVersion,
          run,
          createdAt: run.updatedAt,
        }),
      );
    }
    return {
      run,
      tasks: results.flatMap(({ result }) => result.tasks),
      events: this.events(workflowId, current.stateVersion),
    };
  }

  async recoverInterrupted(): Promise<WorkflowRun[]> {
    await this.tasks.recoverInterrupted();
    const recovered: WorkflowRun[] = [];
    const allTasks = this.store.listTasks(100_000);
    for (const stored of this.store.listWorkflowRuns([
      "planned",
      "running",
      "awaiting_approval",
      "recovery_required",
    ])) {
      const replayed = this.replay(stored);
      if (replayed.stateVersion !== stored.stateVersion) {
        throw new Error("workflow_event_history_invalid");
      }
      const definition = this.loadDefinition(stored);
      let run = this.transition(stored, (draft, emit) => {
        for (const node of definition.nodes) {
          const state = recoveredNodeState(
            node,
            expectedTaskKeys(stored.id, node, definition)
              .map((key) => preferredTask(allTasks, key))
              .filter((task): task is TaskRecord => task !== undefined),
            replayed.nodes[node.id]!,
          );
          if (canonicalJson(draft.nodes[node.id]) === canonicalJson(state)) {
            continue;
          }
          const from = draft.nodes[node.id]!.status;
          draft.nodes[node.id] = state;
          emit("workflow.node_changed", {
            nodeId: node.id,
            from,
            state,
          });
        }
        let status = this.deriveStatus(draft, definition);
        if (status === "verified_complete") {
          for (const node of definition.nodes) {
            const state = draft.nodes[node.id]!;
            if (node.type !== "compensation" || state.status !== "pending") {
              continue;
            }
            state.status = "skipped";
            emit("workflow.node_changed", {
              nodeId: node.id,
              from: "pending",
              state,
            });
          }
          status = this.deriveStatus(draft, definition);
        }
        const from = draft.status;
        draft.status = status;
        if (status === "recovery_required") {
          draft.error = "workflow_contains_unreconciled_mutation";
        } else {
          delete draft.error;
        }
        emit(
          status === "recovery_required"
            ? "workflow.recovery_required"
            : "workflow.recovered",
          {
            from,
            to: status,
            ...(draft.error === undefined ? {} : { error: draft.error }),
          },
        );
      });
      recovered.push(run);
    }
    return recovered;
  }

  // Operator controls. `pause` is a soft stop an operator lifts with `resume`;
  // `suspend` is the same stop for an operator who wants the run parked
  // indefinitely. Neither touches node state, so resuming picks the graph up
  // exactly where it stopped — that is why `advance` refuses to run while a
  // workflow sits in either status instead of quietly continuing.
  pause(workflowId: string): WorkflowRun {
    return this.halt(workflowId, "paused", "workflow.paused");
  }

  suspend(workflowId: string): WorkflowRun {
    return this.halt(workflowId, "suspended", "workflow.suspended");
  }

  resume(workflowId: string): WorkflowRun {
    const current = this.status(workflowId);
    if (!["paused", "suspended"].includes(current.status)) {
      throw new Error("workflow_not_paused");
    }
    return this.transition(current, (draft, emit) => {
      const from = draft.status;
      // Restore whatever the graph was actually blocked on before the halt,
      // so resuming a run parked on a human does not claim it is running.
      const nodes = Object.values(draft.nodes);
      draft.status = nodes.some(
        (node) => node.status === "awaiting_approval",
      )
        ? "awaiting_approval"
        : nodes.some((node) => node.status === "awaiting_input")
        ? "awaiting_input"
        : "running";
      delete draft.error;
      emit("workflow.resumed", { from, to: draft.status });
    });
  }

  private halt(
    workflowId: string,
    to: "paused" | "suspended",
    eventType: string,
  ): WorkflowRun {
    const current = this.status(workflowId);
    if (current.status === to) return current;
    if (
      ["verified_complete", "cancelled", "failed"].includes(current.status)
    ) {
      throw new Error("workflow_not_haltable");
    }
    return this.transition(current, (draft, emit) => {
      const from = draft.status;
      draft.status = to;
      emit(eventType, { from, to });
    });
  }

  cancel(workflowId: string): WorkflowRun {
    const current = this.status(workflowId);
    if (
      current.status === "verified_complete" ||
      current.status === "cancelled"
    ) {
      return current;
    }
    return this.transition(current, (draft, emit) => {
      for (const [nodeId, node] of Object.entries(draft.nodes)) {
        if (
          !["pending", "ready", "awaiting_approval"].includes(node.status)
        ) {
          continue;
        }
        for (const taskId of node.taskIds) this.tasks.cancel(taskId);
        const from = node.status;
        node.status = "cancelled";
        emit("workflow.node_changed", {
          nodeId,
          from,
          state: node,
        });
      }
      const from = draft.status;
      draft.status = "cancelled";
      delete draft.error;
      emit("workflow.cancelled", { from, to: "cancelled" });
    });
  }

  private transition(
    current: WorkflowRun,
    mutate: (draft: WorkflowRun, emit: EmitEvent) => void,
  ): WorkflowRun {
    const draft = structuredClone(current);
    const events: WorkflowEvent[] = [];
    const emit: EmitEvent = (type, data) => {
      events.push(
        makeEvent(
          current,
          current.stateVersion + events.length + 1,
          type,
          data,
        ),
      );
    };
    mutate(draft, emit);
    if (events.length === 0) return current;
    draft.stateVersion = current.stateVersion + events.length;
    draft.updatedAt = events.at(-1)!.occurredAt;
    const expected = WorkflowRunSchema.parse(draft);
    let rebuilt = current;
    for (const event of events) rebuilt = applyWorkflowEvent(rebuilt, event);
    if (canonicalJson(rebuilt) !== canonicalJson(expected)) {
      throw new Error("workflow_projection_event_mismatch");
    }
    this.store.transitionWorkflow(
      current.id,
      current.stateVersion,
      rebuilt,
      events,
    );
    return rebuilt;
  }

  private loadDefinition(run: WorkflowRun): WorkflowDefinition {
    const payload = this.store.getWorkflowPayload(
      run.definitionId,
      run.definitionVersion,
    );
    if (payload === undefined) throw new Error("workflow_payload_not_found");
    return WorkflowDefinitionSchema.parse(
      this.payloadCipher.open(
        payload,
        `workflow:${run.definitionId}:${run.definitionVersion}:definition`,
      ),
    );
  }

  private replay(run: WorkflowRun): WorkflowRun {
    try {
      const snapshot = this.store.getLatestWorkflowSnapshot(run.id);
      return rebuildWorkflow(
        snapshot,
        this.store.listWorkflowEvents(run.id, snapshot?.sequence ?? 0),
      );
    } catch {
      try {
        return rebuildWorkflow(
          undefined,
          this.store.listWorkflowEvents(run.id),
        );
      } catch {
        throw new Error("workflow_event_history_invalid");
      }
    }
  }

  /**
   * Run declared compensations one at a time, newest effect first, stopping at
   * the first that does not land `compensated`.
   *
   * `nodeIds` is already in unwind order. Nothing here is special-cased for the
   * provider a compensation talks to: each one is an ordinary request through
   * `runTask`, so undoing a charge at one host and a shipment at another is the
   * same code path as undoing two at the same host — policy, approval, and the
   * compensation's own declared evidence all still apply, and a delegate saying
   * "reversed" without evidence still does not count.
   */
  private async unwind(
    nodeIds: string[],
    graph: WorkflowGraph,
    definition: WorkflowDefinition,
    run: WorkflowRun,
    approvals: ApprovalResponse[],
    inputs: WorkflowInput[],
  ): Promise<Array<{ nodeId: string; result: NodeAdvance }>> {
    const results: Array<{ nodeId: string; result: NodeAdvance }> = [];
    for (const nodeId of nodeIds) {
      const result = await this.advanceNode(
        graph.nodes.get(nodeId)!,
        definition,
        run.nodes[nodeId]!,
        run,
        approvals,
        inputs,
      );
      results.push({ nodeId, result });
      if (result.state.status !== "compensated") break;
    }
    return results;
  }

  private async advanceNode(
    node: WorkflowNode,
    definition: WorkflowDefinition,
    state: WorkflowNodeState,
    run: WorkflowRun,
    approvals: ApprovalResponse[],
    inputs: WorkflowInput[],
  ): Promise<NodeAdvance> {
    switch (node.type) {
      case "operation": {
        const approvalNode = definition.nodes.find(
          (candidate) =>
            candidate.type === "approval" &&
            candidate.forNodeId === node.id,
        );
        const approvedTaskId =
          approvalNode === undefined
            ? undefined
            : run.nodes[approvalNode.id]?.taskIds[0];
        return await this.runTask(
          node.request,
          approvedTaskId ?? state.taskIds[0],
          approvals,
          true,
          {
            workflowId: run.id,
            nodeId: node.id,
            iteration: 0,
            branch: "operation",
          },
        );
      }
      case "approval": {
        const target = definition.nodes.find(
          (candidate) => candidate.id === node.forNodeId,
        );
        if (target === undefined || target.type !== "operation") {
          throw new Error(`workflow_approval_target_missing:${node.id}`);
        }
        return await this.runTask(
          target.request,
          state.taskIds[0],
          approvals,
          false,
          {
            workflowId: run.id,
            nodeId: target.id,
            iteration: 0,
            branch: "operation",
          },
        );
      }
      case "condition": {
        const sourceTaskId = run.nodes[node.sourceNodeId]?.taskIds[0];
        if (sourceTaskId === undefined) {
          throw new Error(`workflow_condition_source_unavailable:${node.id}`);
        }
        const condition = await this.tasks.verifyPersisted(sourceTaskId, [
          node.predicate,
        ]);
        return await this.runSequential(
          condition.verified ? node.whenTrue : node.whenFalse,
          state,
          approvals,
          {
            workflowId: run.id,
            nodeId: node.id,
            iteration: 0,
            branch: condition.verified ? "true" : "false",
          },
        );
      }
      case "parallel":
        return await this.runParallel(
          node.branches,
          state,
          approvals,
          run.id,
          node.id,
        );
      case "bounded_loop":
        return await this.runLoop(node, state, approvals, run.id);
      case "compensation": {
        const result = await this.runTask(
          node.request,
          state.taskIds[0],
          approvals,
          true,
          {
            workflowId: run.id,
            nodeId: node.id,
            iteration: 0,
            branch: "compensation",
          },
        );
        return {
          ...result,
          state:
            result.state.status === "verified_complete"
              ? { ...result.state, status: "compensated" }
              : result.state,
        };
      }
      case "checkpoint":
        return {
          state: { status: "verified_complete", taskIds: [] },
          tasks: [],
          checkpoint: true,
        };
      case "human_input": {
        const supplied = inputs.find((item) => item.nodeId === node.id);
        if (supplied === undefined) {
          return {
            state: {
              status: "awaiting_input",
              taskIds: [],
              prompt: node.prompt,
            },
            tasks: [],
          };
        }
        if (supplied.value.length > node.maxLength) {
          throw new Error(`workflow_input_too_long:${node.id}`);
        }
        if (
          node.choices.length > 0 &&
          !node.choices.includes(supplied.value)
        ) {
          throw new Error(`workflow_input_not_a_choice:${node.id}`);
        }
        return {
          state: {
            status: "verified_complete",
            taskIds: [],
            prompt: node.prompt,
            input: recordedInput(supplied.value),
          },
          tasks: [],
        };
      }
      case "delegation": {
        const supplied = inputs.find((item) => item.nodeId === node.id);
        // Node state caps `prompt` at 2,000 chars; assignee + goal can exceed
        // that, and a truncated label is better than a schema rejection.
        const prompt = `${node.assignee}: ${node.goal}`.slice(0, 2_000);
        if (supplied === undefined) {
          return {
            state: { status: "awaiting_input", taskIds: [], prompt },
            tasks: [],
          };
        }
        // The delegate reporting "done" is not evidence. If the node declared
        // predicates, they decide — a node whose evidence fails is `failed`,
        // never complete, exactly as for an operation node.
        if (node.requiredEvidence.length > 0) {
          const verification = await this.tasks.verifyStandalone(
            node.requiredEvidence,
          );
          if (!verification.verified) {
            return {
              state: {
                status: "failed",
                taskIds: [],
                prompt,
                error: `workflow_delegation_unverified:${node.id}`,
              },
              tasks: [],
            };
          }
        }
        return {
          state: {
            status: "verified_complete",
            taskIds: [],
            prompt,
            input: recordedInput(supplied.value),
          },
          tasks: [],
        };
      }
      default:
        throw new Error("workflow_node_not_executable");
    }
  }

  private async runTask(
    request: TaskRequest,
    existingTaskId: string | undefined,
    approvals: ApprovalResponse[],
    executePlanned = true,
    identity: TaskIdentity,
  ): Promise<NodeAdvance> {
    let task =
      existingTaskId === undefined
        ? this.tasks.plan(request, {
            idempotencyKey: taskIdempotencyKey(identity, request),
            attempt: 1,
          })
        : this.tasks.status(existingTaskId);
    if (task.status === "awaiting_approval") {
      const approval = approvals.find(
        (item) => item.approvalId === task.approval?.approvalId,
      );
      if (approval === undefined) {
        return {
          state: {
            status: "awaiting_approval",
            taskIds: [task.id],
            ...(task.approval === undefined
              ? {}
              : { approval: task.approval }),
          },
          tasks: [task],
        };
      }
      task = (await this.tasks.execute(task.id, approval)).task;
    } else if (task.status === "planned" && executePlanned) {
      task = (await this.tasks.execute(task.id)).task;
    }
    return {
      state: nodeStateForTask(task, !executePlanned),
      tasks: [task],
    };
  }

  private async runSequential(
    requests: TaskRequest[],
    state: WorkflowNodeState,
    approvals: ApprovalResponse[],
    identity: TaskIdentity,
  ): Promise<NodeAdvance> {
    const taskIds = [...state.taskIds];
    const tasks: TaskRecord[] = [];
    for (const [index, request] of requests.entries()) {
      const result = await this.runTask(
        request,
        taskIds[index],
        approvals,
        true,
        { ...identity, branch: `${identity.branch}:${index}` },
      );
      tasks.push(...result.tasks);
      taskIds[index] = result.state.taskIds[0]!;
      if (result.state.status !== "verified_complete") {
        return {
          state: { ...result.state, taskIds },
          tasks,
        };
      }
    }
    return {
      state: { status: "verified_complete", taskIds },
      tasks,
    };
  }

  private async runParallel(
    branches: TaskRequest[][],
    state: WorkflowNodeState,
    approvals: ApprovalResponse[],
    workflowId: string,
    nodeId: string,
  ): Promise<NodeAdvance> {
    const requests = branches.flatMap((branch, branchIndex) =>
      branch.map((request, requestIndex) => ({
        request,
        branch: `${branchIndex}:${requestIndex}`,
      })),
    );
    const results = await Promise.all(
      requests.map((item, index) =>
        this.runTask(
          item.request,
          state.taskIds[index],
          approvals,
          true,
          {
            workflowId,
            nodeId,
            iteration: 0,
            branch: item.branch,
          },
        ),
      ),
    );
    return {
      state: aggregateNodeState(results.map((result) => result.state)),
      tasks: results.flatMap((result) => result.tasks),
    };
  }

  private async runLoop(
    node: Extract<WorkflowNode, { type: "bounded_loop" }>,
    state: WorkflowNodeState,
    approvals: ApprovalResponse[],
    workflowId: string,
  ): Promise<NodeAdvance> {
    const taskIds = [...state.taskIds];
    const tasks: TaskRecord[] = [];
    let iterations = state.iterations ?? 0;
    while (iterations < node.maxIterations) {
      const offset = iterations * node.body.length;
      for (const [index, request] of node.body.entries()) {
        const result = await this.runTask(
          request,
          taskIds[offset + index],
          approvals,
          true,
          {
            workflowId,
            nodeId: node.id,
            iteration: iterations,
            branch: `loop:${index}`,
          },
        );
        tasks.push(...result.tasks);
        taskIds[offset + index] = result.state.taskIds[0]!;
        if (result.state.status !== "verified_complete") {
          return {
            state: {
              ...result.state,
              taskIds,
              iterations,
            },
            tasks,
          };
        }
      }
      iterations += 1;
      const lastTaskId = taskIds[offset + node.body.length - 1]!;
      if (
        node.until !== undefined &&
        (await this.tasks.verifyPersisted(lastTaskId, [node.until])).verified
      ) {
        break;
      }
    }
    return {
      state: {
        status: "verified_complete",
        taskIds,
        iterations,
      },
      tasks,
    };
  }

  private deriveStatus(
    run: WorkflowRun,
    definition: WorkflowDefinition,
  ): WorkflowRun["status"] {
    const required = definition.nodes.filter(
      (node) => node.type !== "compensation",
    );
    // Compensation nodes are excluded from every check below, because a
    // skipped one is the normal case on a clean run. A *failed* one is not:
    // the forward effect happened and its declared inverse did not, which
    // leaves the world in a state no single node describes. Checked first, so
    // an incomplete unwind is never reported as a clean failure.
    if (
      definition.nodes.some(
        (node) =>
          node.type === "compensation" &&
          ["failed", "recovery_required"].includes(
            run.nodes[node.id]?.status ?? "",
          ),
      )
    ) {
      return "recovery_required";
    }
    if (required.some((node) => run.nodes[node.id]?.status === "failed")) {
      return "failed";
    }
    if (
      required.some(
        (node) => run.nodes[node.id]?.status === "recovery_required",
      )
    ) {
      return "recovery_required";
    }
    if (
      required.some(
        (node) => run.nodes[node.id]?.status === "awaiting_approval",
      )
    ) {
      return "awaiting_approval";
    }
    // A run blocked on a person is not "running" — reporting it as running
    // makes an operator wait for a machine that is waiting for them.
    if (
      required.some((node) => run.nodes[node.id]?.status === "awaiting_input")
    ) {
      return "awaiting_input";
    }
    if (
      required.every((node) => {
        const state = run.nodes[node.id];
        return (
          state !== undefined &&
          ["verified_complete", "skipped", "compensated"].includes(
            state.status,
          ) &&
          state.taskIds.every(
            (taskId) =>
              this.tasks.receipts({ taskId }).certificate?.result ===
              "VERIFIED_SUCCESS",
          )
        );
      })
    ) {
      return "verified_complete";
    }
    return "running";
  }
}

function makeEvent(
  run: WorkflowRun,
  sequence: number,
  type: string,
  data: Record<string, unknown>,
): WorkflowEvent {
  return WorkflowEventSchema.parse({
    schemaVersion: "1.0.0",
    id: randomUUID(),
    aggregateId: run.id,
    sequence,
    traceId: run.traceId,
    type,
    data,
    occurredAt: new Date().toISOString(),
  });
}

// Human- and delegate-supplied text is untrusted like any other input, so it is
// redacted before it reaches persisted state. Redaction can lengthen a value
// (a short secret becomes a longer marker), hence the cap the state schema wants.
function recordedInput(value: string): string {
  return String(redactStructuredValue(value).value).slice(0, 10_000);
}

function requestsFor(node: WorkflowNode): TaskRequest[] {
  switch (node.type) {
    case "operation":
    case "compensation":
      return [node.request];
    case "condition":
      return [...node.whenTrue, ...node.whenFalse];
    case "parallel":
      return node.branches.flat();
    case "bounded_loop":
      return node.body;
    case "approval":
    case "checkpoint":
    case "human_input":
      return [];
    // A delegate reports work done elsewhere. MELRA runs no adapter for it, so
    // it contributes no task requests — only evidence to verify.
    case "delegation":
      return [];
  }
}

function nodeStateForTask(
  task: TaskRecord,
  plannedIsComplete: boolean,
): WorkflowNodeState {
  switch (task.status) {
    case "verified_success":
      return { status: "verified_complete", taskIds: [task.id] };
    case "planned":
      return {
        status: plannedIsComplete ? "verified_complete" : "ready",
        taskIds: [task.id],
      };
    case "awaiting_approval":
      return {
        status: "awaiting_approval",
        taskIds: [task.id],
        ...(task.approval === undefined ? {} : { approval: task.approval }),
      };
    case "recovery_required":
      return {
        status: "recovery_required",
        taskIds: [task.id],
        ...(task.error === undefined ? {} : { error: task.error }),
      };
    case "cancelled":
      return { status: "cancelled", taskIds: [task.id] };
    default:
      return {
        status: "failed",
        taskIds: [task.id],
        ...(task.error === undefined ? {} : { error: task.error }),
      };
  }
}

function aggregateNodeState(
  states: WorkflowNodeState[],
): WorkflowNodeState {
  const taskIds = states.flatMap((state) => state.taskIds);
  for (const status of [
    "failed",
    "recovery_required",
    "awaiting_approval",
    "cancelled",
  ] as const) {
    const state = states.find((candidate) => candidate.status === status);
    if (state !== undefined) return { ...state, taskIds };
  }
  return { status: "verified_complete", taskIds };
}

function taskIdempotencyKey(
  identity: TaskIdentity,
  request: TaskRequest,
): string {
  return sha256({ ...identity, request });
}

function expectedTaskKeys(
  workflowId: string,
  node: WorkflowNode,
  definition: WorkflowDefinition,
): string[] {
  const key = (
    request: TaskRequest,
    iteration: number,
    branch: string,
    nodeId = node.id,
  ) =>
    taskIdempotencyKey(
      { workflowId, nodeId, iteration, branch },
      request,
    );
  switch (node.type) {
    case "operation":
      return [key(node.request, 0, "operation")];
    case "approval": {
      const target = definition.nodes.find(
        (candidate) => candidate.id === node.forNodeId,
      );
      return target?.type === "operation"
        ? [key(target.request, 0, "operation", target.id)]
        : [];
    }
    case "condition":
      return [
        ...node.whenTrue.map((request, index) =>
          key(request, 0, `true:${index}`),
        ),
        ...node.whenFalse.map((request, index) =>
          key(request, 0, `false:${index}`),
        ),
      ];
    case "parallel":
      return node.branches.flatMap((branch, branchIndex) =>
        branch.map((request, requestIndex) =>
          key(request, 0, `${branchIndex}:${requestIndex}`),
        ),
      );
    case "bounded_loop":
      return Array.from({ length: node.maxIterations }, (_, iteration) =>
        node.body.map((request, index) =>
          key(request, iteration, `loop:${index}`),
        ),
      ).flat();
    case "compensation":
      return [key(node.request, 0, "compensation")];
    // Neither runs an adapter, so neither reserves an idempotency key: a
    // checkpoint only records a resume point, and human_input/delegation
    // record what a person supplied or a delegate reported.
    case "checkpoint":
    case "human_input":
    case "delegation":
      return [];
  }
}

function preferredTask(
  tasks: TaskRecord[],
  idempotencyKey: string,
): TaskRecord | undefined {
  return tasks
    .filter((task) => task.idempotencyKey === idempotencyKey)
    .sort(
      (left, right) =>
        Number(right.status === "verified_success") -
          Number(left.status === "verified_success") ||
        (right.attempt ?? 1) - (left.attempt ?? 1) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )[0];
}

function recoveredNodeState(
  node: WorkflowNode,
  tasks: TaskRecord[],
  previous: WorkflowNodeState,
): WorkflowNodeState {
  if (tasks.length === 0) return previous;
  const taskIds = tasks.map((task) => task.id);
  const withStatus = (status: TaskRecord["status"]) =>
    tasks.find((task) => task.status === status);
  const recovery = withStatus("recovery_required");
  if (recovery !== undefined) {
    return {
      status: "recovery_required",
      taskIds,
      ...(recovery.error === undefined ? {} : { error: recovery.error }),
    };
  }
  const awaiting = withStatus("awaiting_approval");
  if (awaiting !== undefined) {
    return {
      status: "awaiting_approval",
      taskIds,
      ...(awaiting.approval === undefined
        ? {}
        : { approval: awaiting.approval }),
    };
  }
  const failed = tasks.find((task) =>
    [
      "failed",
      "partial",
      "budget_exhausted",
      "policy_blocked",
    ].includes(task.status),
  );
  if (failed !== undefined) {
    return {
      status: "failed",
      taskIds,
      ...(failed.error === undefined ? {} : { error: failed.error }),
    };
  }
  if (tasks.some((task) => task.status === "planned")) {
    return {
      status: "pending",
      taskIds,
      ...(tasks.find((task) => task.error !== undefined)?.error === undefined
        ? {}
        : { error: tasks.find((task) => task.error !== undefined)!.error }),
    };
  }
  if (tasks.every((task) => task.status === "verified_success")) {
    return {
      status: node.type === "compensation" ? "compensated" : "verified_complete",
      taskIds,
      ...(node.type === "bounded_loop"
        ? {
            iterations: Math.ceil(
              tasks.length / node.body.length,
            ),
          }
        : {}),
    };
  }
  return { status: "cancelled", taskIds };
}
