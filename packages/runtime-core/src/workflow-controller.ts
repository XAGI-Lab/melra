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

const RECOVERABLE: WorkflowRun["status"][] = [
  "planned",
  "running",
  "awaiting_approval",
  "recovery_required",
];

// A failed run's advance runs its compensations, so an advance that died on
// one leaves the same hazard as any other: a compensation it started, planned
// and run again. Repaired too, but only once an expired lease says an advance
// died there; the full startup pass leaves failed runs as they are.
const ABANDONABLE: WorkflowRun["status"][] = [...RECOVERABLE, "failed"];

export class WorkflowController {
  // In-process advances serialize on this map; competing *processes* serialize
  // on a SQLite lease (see `advance`). Both are needed: the map keeps one
  // process from racing itself without touching the disk on every call.
  private readonly advances = new Map<string, Promise<WorkflowAdvanceResult>>();
  private readonly owner = `${process.pid}:${randomUUID()}`;
  /** Whether a task's effect happened and verified, for `targetDone`. */
  private readonly ran = (taskId: string): boolean =>
    this.tasks.status(taskId).status === "verified_success";
  // Distinct from `owner`, so this process's own advance in flight also keeps
  // its recovery away from the run.
  private readonly recoveryOwner = `${this.owner}:recovery`;
  // Runs an advance in this process holds the lease for. Recovery leaves them
  // alone even once the lease has lapsed, say across a laptop's sleep.
  private readonly leased = new Set<string>();

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
    // A definition is stored once per id and version, and any number of runs
    // may use it: planning the same file twice is a second run, not an error.
    // The same id and version with different content is refused, because
    // runs already planned from the stored one must keep meaning what they did.
    const purpose = `workflow:${parsed.id}:${parsed.version}:definition`;
    const stored = this.store.getWorkflowPayload(parsed.id, parsed.version);
    if (
      stored !== undefined &&
      canonicalJson(WorkflowDefinitionSchema.parse(this.payloadCipher.open(stored, purpose))) !==
        canonicalJson(parsed)
    ) {
      throw new Error(
        `workflow_definition_conflict:${parsed.id}@${parsed.version}: a different definition is stored under this id and version; bump "version"`,
      );
    }
    this.store.createWorkflow(
      redacted,
      stored === undefined ? this.payloadCipher.seal(parsed, purpose) : undefined,
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
    const current = this.status(workflowId);
    // Refused before the lease is touched: taking it would replace, and the
    // release then delete, an expired lease a dead advance left, which is the
    // only sign the run still needs recovering once it is resumed.
    if (["paused", "suspended"].includes(current.status)) {
      throw new Error(`workflow_halted:${current.status}`);
    }
    // Every task would refuse these anyway, but only once its node's turn came,
    // after siblings in the same wave had already been cancelled, planned
    // again or run on the strength of a request that is refused. Refused
    // before anything moves.
    if (this.tasks.enforced && approvals.length > 0) throw new Error("approval_in_band_refused");
    // An expired lease someone else holds is an advance that died mid-flight.
    // Taking it over would read a projection from before that advance's tasks
    // and plan them again under keys that were never committed, so the run is
    // recovered first. A lease left exactly as it was means a task of that
    // advance is still running somewhere: wait, as for a live holder.
    const left = this.store.getWorkflowLease(workflowId);
    if (
      left !== undefined &&
      left.owner !== this.owner &&
      left.expiresAt <= new Date().toISOString() &&
      ABANDONABLE.includes(current.status)
    ) {
      // A repaired run has no lease left. One still there is a task still
      // running, a live process that got in first, or a repair that failed.
      // Only this run's own failure is reported as itself; the rest of the
      // pass's belong to other runs or tasks and reach the sweep's warnings.
      const pass = await this.recoveryPass(true);
      if (this.store.getWorkflowLease(workflowId) !== undefined) {
        if (pass.runFailures.has(workflowId)) throw pass.runFailures.get(workflowId);
        throw new Error("workflow_lease_held");
      }
    }
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
    this.leased.add(workflowId);
    try {
      return await this.advanceOnce(workflowId, approvals, inputs);
    } finally {
      this.leased.delete(workflowId);
      clearInterval(renewal);
      this.store.releaseWorkflowLease(workflowId, this.owner);
    }
  }

  private async advanceOnce(
    workflowId: string,
    approvals: ApprovalResponse[],
    inputs: WorkflowInput[],
  ): Promise<WorkflowAdvanceResult> {
    const stored = this.status(workflowId);
    if (["verified_complete", "cancelled"].includes(stored.status)) {
      return { run: stored, tasks: [], events: [] };
    }
    // A halted workflow is a deliberate operator decision. Failing loudly beats
    // returning an unchanged run, which reads to a caller like "nothing to do".
    if (["paused", "suspended"].includes(stored.status)) {
      throw new Error(`workflow_halted:${stored.status}`);
    }
    const definition = this.loadDefinition(stored);
    const graph = validateWorkflow(definition);
    // A step parked as recovery_required is settled outside the run, by
    // melra_execute reconciling its task against the provider. Its tasks are
    // read again here, as recovery reads them, so the run moves on in this
    // process instead of at the next restart.
    const current = this.resettleParked(stored, definition);
    const since = stored.stateVersion;
    const rollback =
      current.status === "failed"
        ? definition.nodes
            .filter(
              (node) =>
                node.type === "compensation" &&
                ["pending", "awaiting_approval"].includes(
                  current.nodes[node.id]?.status ?? "",
                ) &&
                targetDone(definition, (id) => current.nodes[id], node.forNodeId, this.ran),
            )
            .map((node) => node.id)
            .reverse()
        : [];
    // An earlier version failed a run beside a step whose outcome is unknown
    // and would now undo what that step may depend on. Halt it as a run that
    // gets there now halts, so recovery settles the step first.
    const repaired = this.repairLegacy(definition, current);
    if (repaired !== undefined) {
      return { run: repaired, tasks: [], events: this.events(workflowId, since) };
    }
    // An unwind that stopped half-done is not a base to build more effects on:
    // a forward effect happened, its declared inverse did not, and no node
    // describes that. Refused here rather than left to `readyNodeIds`, which
    // would happily start an independent branch on top of it.
    const stalled = stalledCompensation(definition, current.nodes);
    if (stalled !== undefined) {
      if (current.status === "recovery_required") {
        return { run: current, tasks: [], events: this.events(workflowId, since) };
      }
      // An earlier version recorded a denied compensation and left the run
      // `failed`; say so, as a run that stalls now does, rather than return it
      // unchanged as if nothing were outstanding.
      const run = this.transition(current, (draft, emit) => {
        const from = draft.status;
        draft.status = "recovery_required";
        draft.error = `workflow_compensation_incomplete:${stalled.id}`;
        emit("workflow.status_changed", { from, to: draft.status, error: draft.error });
      });
      return { run, tasks: [], events: this.events(workflowId, since) };
    }
    // A run with a failed or denied step unwinds once nothing is unknown. Until
    // then it is halted, and offers no forward step: not one newly ready, nor
    // one parked for approval, whose effect would only be undone.
    if (this.hasFailure(definition, current.nodes) && rollback.length === 0) {
      return { run: current, tasks: [], events: this.events(workflowId, since) };
    }
    // A node parked for a human — approval or supplied input — is no
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
      return { run: current, tasks: [], events: this.events(workflowId, since) };
    }

    // A sibling's refusal is reported only after the others' changes are
    // committed: a node another sibling cancelled and planned again in this
    // wave would otherwise keep pointing at the task it cancelled, and stay
    // cancelled for good.
    let refused: { reason: unknown } | undefined;
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
      : Promise.allSettled(
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
        ).then((settled) => {
          // Every sibling finishes before one's error is reported. Rejecting
          // at the first throw released the lease while other adapters still
          // ran, and a retry then read their tasks as failed.
          refused = settled.find((outcome) => outcome.status === "rejected");
          return settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
        }));
    // A *compensation* that failed must not open a second unwind. The saga is
    // already stranded, and undoing the next step while this inverse is still
    // outstanding is precisely what the halt exists to prevent — so only a
    // forward node failing, denied or cancelled starts compensating. A denied
    // step is never offered again, so the run can only end by unwinding.
    const statusAfter = (nodeId: string) =>
      results.find((entry) => entry.nodeId === nodeId)?.result.state.status ??
      current.nodes[nodeId]?.status;
    // Not past a step whose outcome is unknown or still unsettled: the run
    // halts for an operator, as deriveStatus says, rather than undo what that
    // effect may depend on.
    if (
      !hasUnknownOutcome(definition, statusAfter) &&
      results.some(
        ({ nodeId, result }) =>
          ["failed", "cancelled"].includes(result.state.status) &&
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
        // Not once the run has moved on under this advance (cancelled,
        // paused): its commit is going to fail, and a compensation planned now
        // would be a live challenge for a run that no longer offers it.
        // Checked before each one, since one that ran gives a cancel time.
        if (this.status(workflowId).stateVersion !== current.stateVersion) break;
        const stateOf = (id: string) =>
          results.find(({ nodeId }) => nodeId === id)?.result.state ?? current.nodes[id];
        if (!targetDone(definition, stateOf, node.forNodeId, this.ran)) {
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
      this.settleStatus(draft, definition, emit);
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
    if (refused !== undefined) throw refused.reason;
    return {
      run,
      tasks: results.flatMap(({ result }) => result.tasks),
      events: this.events(workflowId, since),
    };
  }

  /**
   * Repairs runs whose advance is not coming back. A run is touched only under
   * its lease, so a live advance in any process (this one included) keeps its
   * run; and only when none of its tasks is still running, which after the
   * task pass means a live process owns that task. `abandonedOnly` limits the
   * pass to runs whose advance died holding the lease — the periodic sweep.
   */
  async recoverInterrupted(
    { abandonedOnly = false }: { abandonedOnly?: boolean } = {},
  ): Promise<WorkflowRun[]> {
    // A task or run that cannot be recovered is reported once everything else
    // has been: one bad record must not hold up the rest.
    const pass = await this.recoveryPass(abandonedOnly);
    if (pass.failures.length > 0) throw pass.failures[0];
    return pass.recovered;
  }

  private async recoveryPass(abandonedOnly: boolean) {
    const taskFailures = new Map<string, unknown>();
    const failures: unknown[] = [];
    await this.tasks.recoverInterrupted(taskFailures).catch((error: unknown) => {
      failures.push(error);
    });
    const runFailures = new Map<string, unknown>();
    const recovered = this.repairRuns(abandonedOnly, taskFailures, runFailures);
    failures.push(...taskFailures.values(), ...runFailures.values());
    return { recovered, failures, runFailures };
  }

  /**
   * Repairs each run under its lease. `runFailures` gets each run's own reason
   * for not being repaired, including a task of its that could not be.
   */
  private repairRuns(
    abandonedOnly: boolean,
    taskFailures: ReadonlyMap<string, unknown>,
    runFailures: Map<string, unknown>,
  ): WorkflowRun[] {
    const at = Date.now();
    // The sweep reads only runs with an expired lease, so a home's history of
    // finished and failed runs costs it nothing.
    const runs = abandonedOnly
      ? this.store
          .expiredWorkflowLeases(new Date(at).toISOString())
          .map((id) => this.store.getWorkflowRun(id))
          .filter((run): run is WorkflowRun => run !== undefined && ABANDONABLE.includes(run.status))
      : this.store.listWorkflowRuns(RECOVERABLE);
    if (runs.length === 0) return [];
    const recovered: WorkflowRun[] = [];
    const allTasks = this.store.listTasks(100_000);
    for (const stored of runs) {
      if (this.leased.has(stored.id)) continue;
      let definition: WorkflowDefinition;
      try {
        definition = this.loadDefinition(stored);
      } catch (error) {
        runFailures.set(stored.id, error);
        continue;
      }
      const keys = new Set(
        definition.nodes.flatMap((node) => expectedTaskKeys(stored.id, node, definition)),
      );
      // Skipped runs keep any abandoned lease, which is how the sweep finds
      // them again once that task settles.
      const unsettled = allTasks.filter(
        (task) =>
          task.idempotencyKey !== undefined &&
          keys.has(task.idempotencyKey) &&
          (task.status === "running" || task.status === "verifying"),
      );
      if (unsettled.length > 0) {
        const failed = unsettled.find((task) => taskFailures.has(task.id));
        if (failed !== undefined) runFailures.set(stored.id, taskFailures.get(failed.id));
        continue;
      }
      const taken = this.store.takeWorkflowLease(
        stored.id,
        this.recoveryOwner,
        new Date(at).toISOString(),
        new Date(at + this.leaseDurationMs).toISOString(),
      );
      if (taken === "refused") continue;
      let repaired = false;
      let failed = false;
      try {
        // Changed since the listing, by an advance or by an operator's pause,
        // so the tasks read above may be stale.
        if (this.store.getWorkflowRun(stored.id)?.stateVersion === stored.stateVersion) {
          recovered.push(this.recoverRun(stored, definition, allTasks));
          repaired = true;
        }
      } catch (error) {
        failed = true;
        runFailures.set(stored.id, error);
      } finally {
        // A run not repaired keeps a lease, expired rather than deleted, when
        // it still needs one: its repair failed, or the lease it replaced was
        // a dead advance's or an earlier repair's. That lease is how the sweep
        // and the next advance know, and without it an advance would plan its
        // tasks again. A lease this pass created replaced nothing: whoever
        // held one last released it with the run left straight.
        if (repaired || (!failed && taken === "created")) {
          this.store.releaseWorkflowLease(stored.id, this.recoveryOwner);
        } else {
          this.store.renewWorkflowLease(stored.id, this.recoveryOwner, new Date(0).toISOString());
        }
      }
    }
    return recovered;
  }

  /**
   * A node's state read again from its tasks: what recovery does at startup,
   * and what an advance does for a step parked as recovery_required.
   */
  private recoveredNode(
    runId: string,
    node: WorkflowNode,
    definition: WorkflowDefinition,
    allTasks: TaskRecord[],
    recorded: WorkflowNodeState,
  ): { state: WorkflowNodeState; found: Array<TaskRecord | undefined> } {
    const found = expectedTaskKeys(runId, node, definition).map((key) =>
      preferredTask(allTasks, key),
    );
    let state = recoveredNodeState(
      node,
      found.filter((task): task is TaskRecord => task !== undefined),
      recorded,
    );
    // An operation behind an approval shares its task with the approval
    // node. Waiting for the approval is that node's state; mirrored onto
    // the operation, both were re-offered, the approval ran the effect,
    // and the operation read the running task as failed.
    if (
      node.type === "operation" &&
      state.status === "awaiting_approval" &&
      definition.nodes.some((other) => other.type === "approval" && other.forNodeId === node.id)
    ) {
      state = recorded;
    }
    // A sequence whose finished steps all verified is not finished if
    // steps remain: a crash between a loop's iterations, or between a
    // branch's steps, recovered as complete with the rest never run.
    // Pending, so the next advance carries on from the tasks it has.
    // Unless the projection recorded it finished in a way only the live
    // path finishes one short: a loop stopped by `until` at a whole
    // iteration, or a condition whose chosen branch is empty. Reopened,
    // `until` or the condition would be asked again of a world that has
    // moved on. Anything else recorded finished but short was written by
    // a recovery that never downgraded (alpha.12), and is downgraded now.
    const finishedShort =
      recorded.status === "verified_complete" &&
      canonicalJson(recorded.taskIds) === canonicalJson(state.taskIds) &&
      ((node.type === "bounded_loop" &&
        node.until !== undefined &&
        state.taskIds.length > 0 &&
        state.taskIds.length % node.body.length === 0) ||
        (node.type === "condition" && state.taskIds.length === 0));
    if (state.status === "verified_complete" && !sequenceFinished(node, found) && !finishedShort) {
      state = {
        status: "pending",
        taskIds: state.taskIds,
        // Whole iterations only: the loop resumes at the one in progress.
        ...(node.type === "bounded_loop"
          ? { iterations: Math.floor(state.taskIds.length / node.body.length) }
          : {}),
      };
    }
    // A loop that stopped on a step keeps the iteration it stopped in, as
    // runLoop records it. Without it the next advance starts again at
    // iteration 0 and asks `until` of a task long finished.
    if (node.type === "bounded_loop" && state.iterations === undefined && state.taskIds.length > 0) {
      state = { ...state, iterations: Math.floor((state.taskIds.length - 1) / node.body.length) };
    }
    return { state, found };
  }

  /**
   * Parked steps whose tasks have since settled, recorded as such: forward
   * steps, and compensations an unwind stopped at. One still in flight is left
   * for recovery, which waits for its owner as at startup.
   */
  private resettleParked(run: WorkflowRun, definition: WorkflowDefinition): WorkflowRun {
    const parked = definition.nodes.filter((node) => {
      const state = run.nodes[node.id];
      if (state?.status !== "recovery_required") return false;
      // Only an earlier version fails a run beside a parked forward step, and
      // advance repairs that run first, as recovery leaves it alone.
      if (run.status === "failed" && node.type !== "compensation") return false;
      // Read again only once its recorded tasks would move it: a harness polls
      // a parked run, and reading every task each time is not free. A parallel
      // branch that settled beside one still unknown moves nothing.
      if (state.taskIds.length === 0) return true;
      const recorded = state.taskIds.map((taskId) => this.store.getTask(taskId));
      if (recorded.some((task) => task === undefined)) return true;
      if (recorded.some((task) => ["running", "verifying"].includes(task!.status))) return false;
      return recoveredNodeState(node, recorded as TaskRecord[], state).status !== "recovery_required";
    });
    if (parked.length === 0) return run;
    const allTasks = this.store.listTasks(100_000);
    const changed = parked.flatMap((node) => {
      const { state, found } = this.recoveredNode(run.id, node, definition, allTasks, run.nodes[node.id]!);
      if (found.some((task) => task !== undefined && ["running", "verifying"].includes(task.status))) return [];
      return canonicalJson(state) === canonicalJson(run.nodes[node.id]) ? [] : [{ nodeId: node.id, state }];
    });
    if (changed.length === 0) return run;
    return this.transition(run, (draft, emit) => {
      for (const { nodeId, state } of changed) {
        const from = draft.nodes[nodeId]!.status;
        draft.nodes[nodeId] = state;
        emit("workflow.node_changed", { nodeId, from, state });
      }
      this.settleStatus(draft, definition, emit);
    });
  }

  /** The run's status from its nodes, with a finished run's unused compensations skipped. */
  private settleStatus(draft: WorkflowRun, definition: WorkflowDefinition, emit: EmitEvent): void {
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
      const stalled = stalledCompensation(definition, draft.nodes);
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
  }

  private recoverRun(
    stored: WorkflowRun,
    definition: WorkflowDefinition,
    allTasks: TaskRecord[],
  ): WorkflowRun {
    const replayed = this.replay(stored);
    if (replayed.stateVersion !== stored.stateVersion) {
      throw new Error("workflow_event_history_invalid");
    }
    return this.transition(stored, (draft, emit) => {
      for (const node of definition.nodes) {
        // An advance on a failed run only ever runs compensations, so only
        // they can be stale. Re-deriving the forward nodes would rank their
        // tasks differently from the live path and could take the run out of
        // failed: a branch awaiting approval beside a failed one reopened.
        if (stored.status === "failed" && node.type !== "compensation") continue;
        const { state } = this.recoveredNode(stored.id, node, definition, allTasks, replayed.nodes[node.id]!);
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
      // Named the way advanceOnce names a stalled unwind, so a run reads the
      // same whether its process died or not.
      const stalled = stalledCompensation(definition, draft.nodes);
      if (status === "recovery_required") {
        draft.error =
          stalled === undefined
            ? "workflow_contains_unreconciled_mutation"
            : `workflow_compensation_incomplete:${stalled.id}`;
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
    const definition = this.loadDefinition(current);
    return this.transition(current, (draft, emit) => {
      const from = draft.status;
      // Restore whatever the graph was actually blocked on before the halt,
      // so resuming a run parked on a human, or on an effect whose outcome is
      // unknown, does not claim it is running.
      draft.status = this.deriveStatus(draft, definition);
      if (draft.status !== "recovery_required") delete draft.error;
      else draft.error ??= "workflow_contains_unreconciled_mutation";
      emit("workflow.resumed", {
        from,
        to: draft.status,
        ...(draft.error === undefined ? {} : { error: draft.error }),
      });
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
      // Kept: a run halted while it needed recovery still needs it, and the
      // reducer drops an error the event does not carry.
      emit(eventType, { from, to, ...(draft.error === undefined ? {} : { error: draft.error }) });
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
      // A cancel or pause landed under this advance: its commit will fail, and
      // a compensation started now would run for a run that no longer asks.
      if (this.status(run.id).stateVersion !== run.stateVersion) break;
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
        // Decided once. A branch that has started keeps going: re-evaluating a
        // live predicate on a later advance could flip it and reuse the other
        // branch's tasks by position.
        const identity = { workflowId: run.id, nodeId: node.id, iteration: 0 };
        const started =
          state.taskIds[0] === undefined ? undefined : this.tasks.status(state.taskIds[0]).idempotencyKey;
        // A branch whose first step committed was chosen, though the advance
        // that chose it may have lost its commit (a pause landed) and left no
        // task here. Asking the predicate again would read a workspace that
        // branch already changed, and could run the other one as well.
        const committed = (branch: "true" | "false", requests: TaskRequest[]) =>
          requests.length > 0 &&
          this.store.getIdempotencyCommit(
            taskIdempotencyKey({ ...identity, branch: `${branch}:0` }, requests[0]!),
          ) !== undefined;
        const chosen =
          started !== undefined
            ? node.whenTrue.length > 0 &&
              started === taskIdempotencyKey({ ...identity, branch: "true:0" }, node.whenTrue[0]!)
            : committed("true", node.whenTrue) ||
              (!committed("false", node.whenFalse) &&
                (await this.tasks.verifyPersisted(sourceTaskId, [node.predicate])).verified);
        return await this.runSequential(
          chosen ? node.whenTrue : node.whenFalse,
          state,
          approvals,
          { ...identity, branch: chosen ? "true" : "false" },
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
            stored: true,
          })
        : this.tasks.status(existingTaskId);
    // A challenge this run asked again after it expired leaves its first
    // attempt cancelled; when the advance that asked again did not commit, the
    // run still names that attempt. Take the newest attempt for the key, as
    // recovery does, so only a cancel nobody followed reads as a denial.
    if (task.status === "cancelled" && task.idempotencyKey !== undefined) {
      task = preferredTask(this.store.listTasks(100_000), task.idempotencyKey) ?? task;
    }
    // A challenge that expired before anyone answered it can never be
    // answered, and reusing it left the node unapprovable for good. Ask again:
    // the expired task is cancelled and the same request planned afresh.
    // A challenge an approver answered in time is not asked again, however
    // long the answer took to act on.
    const decided =
      task.status === "awaiting_approval" && this.tasks.approvalDecision(task) !== undefined;
    if (
      task.status === "awaiting_approval" &&
      task.approval !== undefined &&
      Date.parse(task.approval.expiresAt) <= Date.now() &&
      !decided
    ) {
      this.tasks.cancel(task.id);
      task = this.tasks.plan(request, {
        idempotencyKey: taskIdempotencyKey(identity, request),
        attempt: (task.attempt ?? 1) + 1,
        stored: true,
      });
    }
    if (task.status === "awaiting_approval") {
      const approval = approvals.find(
        (item) => item.approvalId === task.approval?.approvalId,
      );
      if (approval === undefined && !decided) {
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
    // Resumed after recovery between iterations: the last one finished but its
    // `until` was never checked, and running another would be one too many.
    const finished = taskIds[iterations * node.body.length - 1];
    if (
      iterations > 0 &&
      taskIds.length === iterations * node.body.length &&
      finished !== undefined &&
      node.until !== undefined &&
      (await this.tasks.verifyPersisted(finished, [node.until])).verified
    ) {
      return { state: { status: "verified_complete", taskIds, iterations }, tasks };
    }
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

  /**
   * Whether a forward step failed or was denied. Also inside a node that an
   * unknown branch ranks as recovery_required: a parallel node with one branch
   * unknown and one failed reads recovery_required, and its failure is in its
   * tasks.
   */
  /**
   * What an earlier version recorded beside a step whose outcome is unknown.
   * It ranked a failure above an unknown outcome, so a parallel, condition or
   * loop node holding both read `failed`, and the run failed and unwound. That
   * unwind skipped the unknown step's own compensation, the step not being
   * done; offered again, it runs if the step settles as done. Nothing records
   * either now, so a current run is never changed here.
   */
  private repairLegacy(definition: WorkflowDefinition, current: WorkflowRun): WorkflowRun | undefined {
    if (current.status !== "failed" && current.status !== "recovery_required") return undefined;
    const reranked = definition.nodes.flatMap((node) => {
      const state = current.nodes[node.id];
      if (node.type === "compensation" || (state?.status !== "failed" && state?.status !== "cancelled")) return [];
      const unknown = state.taskIds
        .map((taskId) => this.store.getTask(taskId))
        .find((task) => task?.status === "recovery_required");
      return unknown === undefined ? [] : [{ node, state, unknown }];
    });
    const isUnknown = (nodeId: string) =>
      current.nodes[nodeId]?.status === "recovery_required" || reranked.some(({ node }) => node.id === nodeId);
    // An approval node runs its step's task itself, so the step may still
    // read `pending` while the approval holds the unknown outcome.
    const unskipped = definition.nodes.filter(
      (node) =>
        node.type === "compensation" &&
        current.nodes[node.id]?.status === "skipped" &&
        (isUnknown(node.forNodeId) ||
          definition.nodes.some(
            (other) => other.type === "approval" && other.forNodeId === node.forNodeId && isUnknown(other.id),
          )),
    );
    const halt =
      current.status === "failed" &&
      (reranked.length > 0 || hasUnknownOutcome(definition, (id) => current.nodes[id]?.status));
    if (reranked.length === 0 && unskipped.length === 0 && !halt) return undefined;
    return this.transition(current, (draft, emit) => {
      for (const { node, state: previous, unknown } of reranked) {
        const state: WorkflowNodeState = {
          status: "recovery_required",
          taskIds: previous.taskIds,
          ...(unknown!.error === undefined ? {} : { error: unknown!.error }),
        };
        emit("workflow.node_changed", { nodeId: node.id, from: previous.status, state });
        draft.nodes[node.id] = state;
      }
      for (const node of unskipped) {
        const state = { status: "pending" as const, taskIds: [] };
        emit("workflow.node_changed", { nodeId: node.id, from: "skipped", state });
        draft.nodes[node.id] = state;
      }
      if (draft.status === "failed") {
        const from = draft.status;
        draft.status = "recovery_required";
        const stalled = stalledCompensation(definition, draft.nodes);
        if (stalled === undefined) delete draft.error;
        else draft.error = `workflow_compensation_incomplete:${stalled.id}`;
        emit("workflow.status_changed", {
          from,
          to: draft.status,
          ...(draft.error === undefined ? {} : { error: draft.error }),
        });
      }
    });
  }

  private hasFailure(definition: WorkflowDefinition, nodes: WorkflowRun["nodes"]): boolean {
    return definition.nodes.some((node) => {
      if (node.type === "compensation") return false;
      const state = nodes[node.id];
      if (state === undefined) return false;
      if (state.status === "failed" || state.status === "cancelled") return true;
      if (state.status !== "recovery_required") return false;
      return state.taskIds.some((taskId) => {
        const task = this.store.getTask(taskId);
        return (
          task !== undefined &&
          (["failed", "partial", "budget_exhausted", "policy_blocked"].includes(task.status) ||
            (task.status === "cancelled" && task.error !== "duplicate_attempt_prevented"))
        );
      });
    });
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
    if (stalledCompensation(definition, run.nodes) !== undefined) {
      return "recovery_required";
    }
    // Above a failure: unwinding now could undo what an effect that may have
    // happened depends on (refund a charge whose goods may be in transit). The
    // run halts until that step is settled, and only then fails and unwinds.
    if (hasUnknownOutcome(definition, (id) => run.nodes[id]?.status)) {
      return "recovery_required";
    }
    if (required.some((node) => run.nodes[node.id]?.status === "failed")) {
      return "failed";
    }
    // A step whose task was denied or cancelled did not happen and is never
    // offered again (`readyNodeIds` takes pending nodes, the re-offer awaiting
    // ones), so the run cannot finish: it fails, and unwinds as for a failure.
    // A run-level `cancelled` belongs to `cancel()`, whose runs are not
    // derived.
    if (required.some((node) => run.nodes[node.id]?.status === "cancelled")) {
      return "failed";
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
      // Cancelled as a duplicate, the effect committed under an attempt this
      // run does not record: an advance lost its commit (a pause landed while
      // the step ran). Not a denial. The run halts, and recovery, which reads
      // every attempt of every slot, settles it as it always has.
      return task.error === "duplicate_attempt_prevented"
        ? { status: "recovery_required", taskIds: [task.id], error: task.error }
        : { status: "cancelled", taskIds: [task.id] };
    case "running":
    case "verifying":
      // Still in flight elsewhere, or interrupted after its effect (its key may
      // be committed). Not a failure of its own: read as one, its run would
      // unwind past an effect that may stand. Task recovery settles it, and
      // the run is derived again.
      return { status: "recovery_required", taskIds: [task.id], error: "task_still_in_flight" };
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
  // A failed or denied branch ends the node before another branch's approval
  // can run a step on a run that is already failing. An unknown outcome ranks
  // above both: the run halts for an operator rather than unwind past an
  // effect that may have happened.
  for (const status of [
    "recovery_required",
    "failed",
    "cancelled",
    "awaiting_approval",
  ] as const) {
    const state = states.find((candidate) => candidate.status === status);
    if (state !== undefined) return { ...state, taskIds };
  }
  return { status: "verified_complete", taskIds };
}

/**
 * Whether a compensation's target step happened. An approval node runs its
 * operation's task itself, so the operation still reads `pending` for a wave
 * after its effect; skipping the compensation then would undo the steps
 * before it while this one stands. Only when that task did run, though: an
 * approval that policy let through (unsafe-local, or a read) reads
 * `verified_complete` with the task merely planned, and the effect is not
 * there to undo.
 */
function targetDone(
  definition: WorkflowDefinition,
  stateOf: (nodeId: string) => WorkflowNodeState | undefined,
  nodeId: string,
  ran: (taskId: string) => boolean,
): boolean {
  return (
    stateOf(nodeId)?.status === "verified_complete" ||
    definition.nodes.some(
      (node) =>
        node.type === "approval" &&
        node.forNodeId === nodeId &&
        stateOf(node.id)?.status === "verified_complete" &&
        (stateOf(node.id)?.taskIds ?? []).some(ran),
    )
  );
}

/**
 * Whether a forward step's outcome is unknown or unsettled (an effect that may
 * have happened, a task still in flight, or one cancelled as a duplicate of an
 * attempt that committed). Nothing is undone past one.
 */
function hasUnknownOutcome(
  definition: WorkflowDefinition,
  statusOf: (nodeId: string) => string | undefined,
): boolean {
  return definition.nodes.some(
    (node) => node.type !== "compensation" && statusOf(node.id) === "recovery_required",
  );
}

/**
 * The compensation an unwind stopped at: it failed, its outcome is unknown, or
 * an operator denied it (Deny cancels its task). Its step was not undone, so
 * nothing older is undone either.
 */
function stalledCompensation(
  definition: WorkflowDefinition,
  nodes: WorkflowRun["nodes"],
): WorkflowNode | undefined {
  return definition.nodes.find(
    (node) =>
      node.type === "compensation" &&
      ["failed", "recovery_required", "cancelled"].includes(nodes[node.id]?.status ?? ""),
  );
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

/**
 * Whether a recovered node that runs steps in sequence ran all of them, given
 * its expected tasks in `expectedTaskKeys` order (missing ones undefined).
 */
function sequenceFinished(node: WorkflowNode, found: Array<TaskRecord | undefined>): boolean {
  if (node.type === "condition") {
    // Only one branch ever runs; finished means the branch that ran is whole.
    const whenTrue = found.slice(0, node.whenTrue.length);
    const whenFalse = found.slice(node.whenTrue.length);
    const whole = (steps: Array<TaskRecord | undefined>) => steps.length > 0 && steps.every(Boolean);
    return whole(whenTrue) || whole(whenFalse);
  }
  if (node.type === "bounded_loop") {
    // Recovery cannot evaluate `until`, so short of the last iteration it is
    // left for the loop itself to decide.
    return found.every(Boolean);
  }
  return true;
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
        // The newest planned, not the newest touched: cancelling a stale
        // duplicate challenge must not make it the one the run names.
        right.createdAt.localeCompare(left.createdAt),
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
  // Ranked as aggregateNodeState ranks a live node: an unknown outcome, then a
  // failure. A parallel node with one failed branch and one awaiting approval
  // was failed live and came back from recovery awaiting approval, reopening
  // the waiting branch on a run whose rollback had begun.
  const recovery = withStatus("recovery_required");
  if (recovery !== undefined) {
    return {
      status: "recovery_required",
      taskIds,
      ...(recovery.error === undefined ? {} : { error: recovery.error }),
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
  // Ranked as aggregateNodeState ranks it, so a denied branch reads the same
  // after a restart and its sibling's challenge is not offered again.
  if (withStatus("cancelled") !== undefined) return { status: "cancelled", taskIds };
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
