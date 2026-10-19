// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalResponse,
  EffectContract,
  EvidencePredicate,
  Operation,
  PolicyDecision,
  TaskRecord,
  TaskRequest,
} from "@melra/protocol";
import {
  allowsRetry,
  delegationChain,
  effectContract,
  executionGuaranteeFor,
  isOutcomeUnknown,
  LOCAL_IDENTITY,
  TaskRequestSchema,
} from "@melra/protocol";
import {
  approvalTtl,
  CAPABILITY_DAY_MS,
  classifyOperation,
  defaultEvidenceFor,
  evaluatePolicy,
  type CapabilityUsageReader,
  type LocalPolicy,
  validateApproval,
} from "@melra/policy-core";
import {
  createCertificate,
  createReceiptId,
  evidenceStrength,
  redactSecrets,
  redactStructuredValue,
  sha256,
  type ActionReceipt,
  type CertificateResult,
  type EvidenceItem,
  type ExecutionCertificate,
} from "@melra/receipt-schema";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import { CircuitBreaker } from "./circuit-breaker.js";
import { PayloadCipher } from "./payload-cipher.js";

export interface OperationExecutor {
  capabilities?(): ReadonlySet<Operation["kind"]>;
  execute(
    operation: Operation,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export interface ExecutionResult {
  task: TaskRecord;
  output?: Record<string, unknown>;
  receipt?: ActionReceipt;
  certificate?: ExecutionCertificate;
}

export interface TaskPlanOptions {
  idempotencyKey?: string;
  attempt?: number;
  /**
   * Planned again from a workflow definition stored when it was accepted.
   * Checks that only govern new work (an unused browser list) are not applied
   * again, so a run accepted before a check existed does not stop mid-way.
   */
  stored?: boolean;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * What was true before the call went out.
 *
 * A request that was never answered left no response, so the only handle on
 * what the provider was asked to do is the key MELRA itself sent. Shaped like
 * an adapter result so one predicate type reads the same on both paths.
 */
function reconciliationFacts(
  task: TaskRecord,
  operation: Operation,
): Record<string, unknown> {
  return {
    taskId: task.id,
    ...(operation.kind === "http"
      ? {
          url: operation.url,
          method: operation.method,
          ...(operation.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: operation.idempotencyKey }),
        }
      : {}),
  };
}

function certificateResult(task: TaskRecord): CertificateResult {
  switch (task.status) {
    case "verified_success":
      return "VERIFIED_SUCCESS";
    case "partial":
      return "PARTIAL";
    case "cancelled":
      return "CANCELLED";
    case "awaiting_approval":
      return "WAITING_APPROVAL";
    case "waiting_user":
      return "WAITING_USER";
    case "policy_blocked":
      return "POLICY_BLOCKED";
    case "budget_exhausted":
      return "BUDGET_EXHAUSTED";
    // Without this case a parked task certified as FAILED — exactly the claim
    // the status exists to stop MELRA from making.
    case "recovery_required":
      return "RECOVERY_REQUIRED";
    default:
      return "FAILED";
  }
}

/**
 * Fill in `requiredEvidence` for a mutation that declared none.
 *
 * Applied once, where the request is normalized, so the derived predicates flow
 * identically into the policy decision, the sealed payload, the persisted task
 * record, and verification. A caller that declared its own evidence is left
 * untouched — this only replaces an empty list.
 */
function withDefaultEvidence(request: TaskRequest): TaskRequest {
  if (request.requiredEvidence.length > 0) return request;
  const derived = defaultEvidenceFor(request.operation);
  if (derived.length === 0) return request;
  return { ...request, requiredEvidence: derived };
}

/**
 * A grant's durable draw-down, the way policy wants to read it.
 *
 * Exported because `melra policy test` previews the same decision from outside
 * this class, and a preview that counted differently from the server it is
 * previewing would be worse than none.
 */
export function capabilityUsageReader(store: SqliteStore): CapabilityUsageReader {
  return (grantId) => {
    const since = new Date(Date.now() - CAPABILITY_DAY_MS).toISOString();
    const drawn = store.capabilityUsage(grantId, since);
    return { operations: drawn.operations, amountToday: drawn.amountInWindow };
  };
}

/** The one browser action that reads each list. */
const BROWSER_LIST_ACTIONS = [
  ["values", "select"],
  ["fields", "fill_form"],
  ["filePaths", "upload"],
] as const;

export class TaskController {
  private readonly active = new Map<string, AbortController>();

  private readonly breaker: CircuitBreaker;

  /** Whether approvals come only from an operator, out of band. */
  get enforced(): boolean {
    return this.policy.mode === "enforced";
  }

  constructor(
    private readonly store: SqliteStore,
    private readonly policy: LocalPolicy,
    private readonly executor: OperationExecutor,
    private readonly verifier: Verifier,
    private readonly payloadCipher: PayloadCipher,
    breaker?: CircuitBreaker,
  ) {
    // Unhinged means nothing MELRA judges gets to refuse a call, and a tripped
    // breaker refusing to run is exactly that. `threshold: 0` switches it off at
    // the one place that owns the behaviour rather than branching at each use.
    this.breaker =
      breaker ??
      new CircuitBreaker(
        policy.unhinged ? { threshold: 0, cooldownMs: 0 } : policy.circuitBreaker,
      );
  }

  /**
   * The durable draw-down on each grant, as policy sees it.
   *
   * Handed to every `evaluatePolicy` call in this class so a metered grant is
   * counted the same at plan time, at the re-check before execution, and in a
   * preflight — a bound that only one of the three enforced would be a bound
   * with a way around it.
   */
  private readonly capabilityUsage: CapabilityUsageReader = (grantId) => {
    const drawn = capabilityUsageReader(this.store)(grantId);
    const held = [...(this.reserved.get(grantId)?.values() ?? [])];
    return {
      operations: drawn.operations + held.length,
      amountToday: drawn.amountToday + held.reduce((total, amount) => total + amount, 0),
    };
  };

  /**
   * Draws by tasks between their re-check and their record, per grant and
   * task. The durable draw is written only once work is verified, so without
   * this two tasks running at once both saw the grant unspent: two operations
   * against `maxOperations: 1`, a parallel workflow node overspending
   * `dailyMax`.
   *
   * ponytail: held in this process. Two servers sharing one database can
   * still both pass a re-check at the same moment; a durable reservation row
   * would close that if it ever matters.
   */
  private readonly reserved = new Map<string, Map<string, number>>();

  plan(
    request: TaskRequest,
    options: TaskPlanOptions = {},
  ): TaskRecord & { contract: EffectContract } {
    const parsedRequest = withDefaultEvidence(TaskRequestSchema.parse(request));
    if (
      options.idempotencyKey !== undefined &&
      !/^[a-f0-9]{64}$/.test(options.idempotencyKey)
    ) {
      throw new Error("idempotency_key_invalid");
    }
    if (
      options.attempt !== undefined &&
      (!Number.isInteger(options.attempt) || options.attempt < 1)
    ) {
      throw new Error("idempotency_attempt_invalid");
    }
    this.preflight(parsedRequest, options);
    const id = randomUUID();
    const policy = evaluatePolicy(
      id,
      parsedRequest,
      this.policy,
      this.capabilityUsage,
    );
    const timestamp = now();
    const sanitizedRequest = redactStructuredValue(parsedRequest)
      .value as TaskRequest;
    const task: TaskRecord = {
      id,
      request: sanitizedRequest,
      status:
        policy.decision.outcome === "deny"
          ? "policy_blocked"
          : policy.decision.outcome === "confirm"
            ? "awaiting_approval"
            : "planned",
      policyDecision: policy.decision,
      ...(options.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: options.idempotencyKey }),
      ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
      ...(policy.challenge === undefined ? {} : { approval: policy.challenge }),
      receiptIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.saveTask(task);
    if (task.status !== "policy_blocked") {
      this.store.saveTaskPayload(
        id,
        this.payloadCipher.seal(parsedRequest, `task:${id}:request`),
        timestamp,
      );
    }
    // The plaintext request goes back to the caller with the contract derived
    // from it, so what a caller reads before approving is the same object the
    // execution path will load.
    const planned = { ...task, request: parsedRequest };
    return {
      ...planned,
      contract: effectContract(planned, classifyOperation(parsedRequest.operation)),
    };
  }

  preflight(request: TaskRequest, options: { stored?: boolean } = {}): PolicyDecision {
    const parsed = withDefaultEvidence(TaskRequestSchema.parse(request));
    const capabilities = this.executor.capabilities?.();
    if (
      capabilities !== undefined &&
      !capabilities.has(parsed.operation.kind)
    ) {
      throw new Error(
        `operation_capability_unavailable:${parsed.operation.kind}`,
      );
    }
    // A list the browser action never reads would sit in the approval as a
    // decoy: shown to the person approving, doing nothing.
    if (parsed.operation.kind === "browser" && options.stored !== true) {
      for (const [field, action] of BROWSER_LIST_ACTIONS) {
        if (parsed.operation[field] !== undefined && parsed.operation.action !== action) {
          throw new Error(`browser_field_unused:${field}`);
        }
      }
    }
    // Refused before anything is approved: a mutation run against evidence no
    // registered verifier can check would end `partial` after the effect, and
    // one that could not be reconciled would stay parked for good. A stored
    // step's reconciliation was never checked, and refusing it now would stop
    // a run whose earlier steps already ran.
    this.assertVerifiable(
      options.stored === true
        ? parsed.requiredEvidence
        : [...parsed.requiredEvidence, ...parsed.reconciliation],
      options,
    );
    return evaluatePolicy(
      "00000000-0000-4000-8000-000000000000",
      parsed,
      this.policy,
      this.capabilityUsage,
    ).decision;
  }

  /** Refuses a predicate no registered verifier can check, or that it would refuse to. */
  assertVerifiable(predicates: EvidencePredicate[], options: { stored?: boolean } = {}): void {
    for (const predicate of predicates) {
      if (!this.verifier.supports(predicate)) {
        throw new Error(
          `evidence_verifier_unavailable:${predicate.type === "custom" ? predicate.verifier : predicate.type}`,
        );
      }
      // A file path the verifier refuses however often it is asked. New work
      // only, like the reconciliation check: a run accepted before this
      // check existed is not stopped at the step.
      if (options.stored !== true && this.verifier.outsideWorkspace(predicate)) {
        throw new Error("evidence_path_outside_workspace");
      }
    }
  }

  status(taskId: string): TaskRecord {
    const task = this.store.getTask(taskId);
    if (task === undefined) throw new Error("task_not_found");
    return task;
  }

  async execute(
    taskId: string,
    approval?: ApprovalResponse,
  ): Promise<ExecutionResult> {
    const task = this.status(taskId);
    if (task.status === "policy_blocked") {
      return { task };
    }
    // Re-running the adapter is the one thing that must not happen to a parked
    // task: it may already have run. `reconcile` asks the provider instead, so
    // a caller retrying the obvious way gets the safe thing.
    if (task.status === "recovery_required") {
      return await this.reconcile(taskId);
    }
    if (!["planned", "awaiting_approval"].includes(task.status)) {
      throw new Error(`task_not_executable:${task.status}`);
    }
    if (
      task.idempotencyKey !== undefined &&
      this.store.getIdempotencyCommit(task.idempotencyKey) !== undefined
    ) {
      task.status = "cancelled";
      task.error = "duplicate_attempt_prevented";
      task.updatedAt = now();
      this.store.saveTask(task);
      return this.finishWithoutReceipt(task, [
        {
          type: "idempotency",
          passed: false,
          strength: evidenceStrength("idempotency"),
          summary: "duplicate_attempt_prevented",
        },
      ]);
    }
    const request = this.loadRequest(taskId);

    const rechecked = evaluatePolicy(
      task.id,
      request,
      this.policy,
      this.capabilityUsage,
    );
    if (rechecked.decision.outcome === "deny") {
      task.status = "policy_blocked";
      task.policyDecision = rechecked.decision;
      task.updatedAt = now();
      this.store.saveTask(task);
      return this.finishWithoutReceipt(task, []);
    }

    if (rechecked.decision.outcome === "confirm") {
      if (
        rechecked.challenge === undefined ||
        task.approval?.actionDigest !== rechecked.challenge.actionDigest
      ) {
        throw new Error("approval_action_digest_mismatch");
      }
      // Enforced mode asserts the agent holds no credential, so anything it
      // sends is refused rather than ignored, and only an operator's
      // out-of-band decision lets the effect run.
      if (this.policy.mode === "enforced" && approval !== undefined) {
        throw new Error("approval_in_band_refused");
      }
      // A decision an operator recorded wins over anything the caller sent.
      const render = this.approvalRender(task, request).renderDigest;
      const decision = this.store.getApprovalDecision(task.approval.approvalId);
      // Waiting is only worth it while an operator could still say yes:
      // `decide` refuses an expired challenge, so past it the task is re-planned.
      if (this.policy.mode === "enforced" && decision?.channel !== "out_of_band") {
        throw new Error(
          Date.parse(task.approval.expiresAt) <= Date.now() ? "approval_expired" : "approval_awaiting_operator",
        );
      }
      if (decision !== undefined) {
        if (decision.renderDigest !== render) throw new Error("approval_render_mismatch");
        if (!this.usable(task, decision)) throw new Error("approval_expired");
        // Out of band is this kernel's claim to make, not the row's: a
        // developer-mode kernel cannot vouch that nothing the agent touched
        // wrote it, whatever mode the process that recorded it was in.
        task.approvedBy = {
          ...decision,
          channel:
            decision.channel === "out_of_band" && this.policy.mode === "enforced"
              ? "out_of_band"
              : "in_band",
        };
      } else {
        const approvalResult = validateApproval(task.approval, approval);
        if (!approvalResult.ok) {
          throw new Error(approvalResult.reason);
        }
        // The phrase is derivable by anyone who knows the task, so an echo of
        // it says only that something echoed it.
        task.approvedBy = {
          approvalId: task.approval.approvalId,
          taskId: task.id,
          renderDigest: render,
          channel: "in_band",
          approver: "phrase",
          decidedAt: now(),
        };
      }
    }
    task.policyDecision = rechecked.decision;

    const controller = new AbortController();
    this.active.set(task.id, controller);
    this.store.inFlight.add(task.id);
    task.status = "running";
    task.mode = this.policy.mode;
    task.updatedAt = now();
    // Status and owner land in one write, so no running row is ever unowned.
    this.store.saveTask(task, this.store.ownerId());
    const startedAt = now();
    const classified = classifyOperation(request.operation);
    let timeout: NodeJS.Timeout | undefined;
    let budgetExhausted = false;
    let shortCircuited = false;
    let effectReturned = false;
    let settled: ExecutionResult | undefined;
    if (rechecked.grantId !== undefined) {
      const held = this.reserved.get(rechecked.grantId) ?? new Map<string, number>();
      held.set(task.id, classified.spend?.amount ?? 0);
      this.reserved.set(rechecked.grantId, held);
    }
    try {
      const opened = this.breaker.check(classified.target);
      if (opened !== undefined) {
        // Thrown rather than returned early so the refusal still produces the
        // receipt and certificate every other terminal outcome produces.
        shortCircuited = true;
        throw new Error(opened);
      }
      timeout = setTimeout(
        () => {
          budgetExhausted = true;
          controller.abort(new Error("task_budget_exhausted"));
        },
        request.budget.maxDurationMs,
      );
      timeout.unref();
      const result = await this.executeWithRetries(
        task,
        request,
        classified.effect,
        controller.signal,
      );
      effectReturned = true;
      const sanitizedResult = redactStructuredValue(result);
      task.status = "verifying";
      task.result = sanitizedResult.value as Record<string, unknown>;
      task.updatedAt = now();
      this.store.saveTaskExecutionResult(
        task,
        this.payloadCipher.seal(result, `task:${task.id}:result`),
      );

      const verification = await this.verifier.verify(
        request.requiredEvidence,
        result,
      );
      const actionSucceeded =
        result.success === undefined || result.success === true;
      if (actionSucceeded) this.breaker.recordSuccess(classified.target);
      else this.breaker.recordFailure(classified.target);
      const evidence: EvidenceItem[] =
        request.requiredEvidence.length === 0
          ? [
              {
                type: "operation_completed",
                passed: actionSucceeded,
                strength: evidenceStrength("operation_completed"),
                summary: actionSucceeded
                  ? "read-only operation completed"
                  : "operation reported failure",
              },
            ]
          : verification.evidence;
      const verified =
        actionSucceeded &&
        (request.requiredEvidence.length === 0 || verification.verified);
      if (
        verified &&
        task.idempotencyKey !== undefined &&
        !this.store.commitIdempotency(
          task.idempotencyKey,
          task.id,
          task.attempt ?? 1,
          now(),
        )
      ) {
        task.status = "cancelled";
        task.error = "duplicate_attempt_prevented";
      }
      // Metered here and nowhere else: the same point idempotency commits, so a
      // grant is drawn down by work that actually happened and was verified.
      // A refusal, a failed verification, a duplicate collapsed just above —
      // none of them reach this line, and none of them cost the caller a draw.
      if (
        verified &&
        task.status !== "cancelled" &&
        rechecked.grantId !== undefined
      ) {
        this.store.recordCapabilityUse(
          rechecked.grantId,
          task.id,
          classified.spend?.amount ?? 0,
          now(),
        );
      }
      const receipt = this.createReceipt(
        task,
        request,
        classified.capability,
        classified.target,
        classified.effect,
        startedAt,
        actionSucceeded,
        result,
        evidence,
      );
      this.store.saveReceipt(receipt);
      task.receiptIds.push(receipt.receiptId);
      if (task.status !== "cancelled") {
        task.status = verified
          ? "verified_success"
          : actionSucceeded
            ? "partial"
            : "failed";
      }
      task.updatedAt = now();
      this.store.saveTask(task);
      settled = { task, output: result, receipt };
      const certificate = this.createAndSaveCertificate(task, evidence, true);
      return { ...settled, certificate };
    } catch (error) {
      // The outcome is recorded, beside its receipt and idempotency commit,
      // and only the certificate summarising it failed to write. Rewriting it
      // would contradict them, and an error would read as the effect not
      // having happened, so the caller gets what was recorded. A workflow
      // step's certificate is written by the run's next advance (`certify`).
      if (settled !== undefined) return settled;
      const rawMessage = error instanceof Error ? error.message : String(error);
      // Capped after redaction, which can lengthen it, at the 10,000 characters
      // a workflow node's `error` holds: a longer one failed the node's write
      // after the effect ran, and the next advance ran the step again.
      const message = (redactStructuredValue(rawMessage).value as string).slice(0, 10_000);
      const aborted = controller.signal.aborted;
      // A refusal by the breaker is not fresh evidence about the target, and an
      // operator's cancellation is not evidence about it at all. A budget that
      // ran out is: the target did not answer in time. Nor is anything after
      // the adapter returned, which the target already answered.
      if (!shortCircuited && !effectReturned && (!aborted || budgetExhausted)) {
        this.breaker.recordFailure(classified.target);
      }
      // Ahead of every other outcome, because it is the strongest thing known:
      // the effect may already have happened, either because the adapter says
      // so or because it returned and a write after it failed. `failed`,
      // `cancelled` and `budget_exhausted` all assert more than that. Reads
      // are exempt — a read that may or may not have run changed nothing
      // either way, so there is nothing to reconcile.
      const unknownOutcome =
        classified.effect !== "read" && (effectReturned || isOutcomeUnknown(rawMessage));
      task.status = unknownOutcome
        ? "recovery_required"
        : aborted
          ? budgetExhausted
            ? "budget_exhausted"
            : "cancelled"
          : "failed";
      task.error = unknownOutcome
        ? message
        : budgetExhausted
          ? "task_budget_exhausted"
          : message;
      task.updatedAt = now();
      const evidence: EvidenceItem[] = [
        {
          type: "execution_error",
          passed: false,
          // The adapter could not say, so neither can the receipt. Without this
          // the item reads as proof the effect did not happen.
          ...(unknownOutcome ? { inconclusive: true } : {}),
          strength: evidenceStrength("execution_error"),
          summary: budgetExhausted && !unknownOutcome
            ? "task_budget_exhausted"
            : message,
        },
      ];
      const receipt = this.createReceipt(
        task,
        request,
        classified.capability,
        classified.target,
        classified.effect,
        startedAt,
        false,
        {},
        evidence,
        task.error,
      );
      this.store.saveReceipt(receipt);
      task.receiptIds.push(receipt.receiptId);
      this.store.saveTask(task);
      const certificate = this.createAndSaveCertificate(task, evidence, true);
      return { task, receipt, certificate };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.active.delete(task.id);
      this.store.inFlight.delete(task.id);
      if (rechecked.grantId !== undefined) this.reserved.get(rechecked.grantId)?.delete(task.id);
    }
  }

  cancel(taskId: string): TaskRecord {
    const task = this.status(taskId);
    const controller = this.active.get(taskId);
    if (controller !== undefined) {
      controller.abort(new Error("task_cancelled"));
      return task;
    }
    if (["planned", "awaiting_approval"].includes(task.status)) {
      task.status = "cancelled";
      task.updatedAt = now();
      this.store.saveTask(task);
    }
    return task;
  }

  async verifyPersisted(
    taskId: string,
    predicates: EvidencePredicate[],
  ): Promise<{ verified: boolean; evidence: EvidenceItem[] }> {
    const sealed = this.store.getTaskResult(taskId);
    const result =
      sealed === undefined
        ? {}
        : this.payloadCipher.open<Record<string, unknown>>(
            sealed,
            `task:${taskId}:result`,
          );
    return await this.verifier.verify(predicates, result);
  }

  // Verify predicates with no task behind them. A delegation node claims work
  // happened somewhere MELRA did not run it; the claim is only worth what the
  // evidence proves, so it goes through the same verifier as everything else.
  async verifyStandalone(
    predicates: EvidencePredicate[],
  ): Promise<{ verified: boolean; evidence: EvidenceItem[] }> {
    return await this.verifier.verify(predicates, {});
  }

  /**
   * Ask the provider whether an effect MELRA could not observe actually
   * happened.
   *
   * Reachable only from `recovery_required`, the one status that says "unknown"
   * rather than a result. The predicates are read against the facts that were
   * true *before* the call — the idempotency key that went out, the destination
   * — because a request that was never answered left no response to
   * interpolate a verification URL from.
   *
   * Three answers, and the third is the point: it happened, it did not, or the
   * provider could not be reached and the task stays exactly where it was.
   */
  async reconcile(taskId: string): Promise<ExecutionResult> {
    const task = this.status(taskId);
    if (task.status !== "recovery_required") {
      throw new Error(`task_not_reconcilable:${task.status}`);
    }
    const request = this.loadRequest(taskId);
    const classified = classifyOperation(request.operation);
    const park = (reason: string): ExecutionResult => {
      task.error = reason;
      task.updatedAt = now();
      this.store.saveTask(task);
      return { task };
    };
    // Its own commit already answers: the effect verified, and only a write
    // after it failed. Parked for good otherwise, with nothing declared.
    const committed = this.settleCommitted(task, request, classified);
    if (committed !== undefined) return committed;
    if (request.reconciliation.length === 0) {
      return park("reconciliation_not_declared");
    }
    const verification = await this.verifier.verify(
      request.reconciliation,
      reconciliationFacts(task, request.operation),
    );
    // An unreachable provider did not say no. Resolving on this would be the
    // same lie as the `failed` this whole path exists to avoid.
    if (verification.evidence.some((item) => item.inconclusive === true)) {
      return park("reconciliation_inconclusive");
    }
    if (verification.verified) {
      return this.resolveAsVerified(
        task,
        request,
        classified,
        verification.evidence,
        { reconciliation: "provider_state_confirms_effect" },
      );
    }
    // The provider answered, and the answer is that it never happened. Only now
    // is `failed` a claim MELRA is entitled to make.
    task.status = "failed";
    task.error = "reconciliation_confirms_effect_not_applied";
    task.updatedAt = now();
    this.store.saveTask(task);
    const receipt = this.createReceipt(
      task,
      request,
      classified.capability,
      classified.target,
      classified.effect,
      task.updatedAt,
      false,
      { reconciliation: "provider_state_denies_effect" },
      verification.evidence,
      task.error,
    );
    this.store.saveReceipt(receipt);
    task.receiptIds.push(receipt.receiptId);
    const certificate = this.createAndSaveCertificate(
      task,
      verification.evidence,
    );
    return { task, receipt, certificate };
  }

  /**
   * Settle a task as done on evidence gathered after the fact.
   *
   * Shared by restart recovery and reconciliation because the two differ only
   * in where the evidence came from. Everything an ordinary success does has to
   * happen here too — the idempotency commit *and* the capability draw-down —
   * or an effect settled this way would be free to run again and free to spend.
   */
  private resolveAsVerified(
    task: TaskRecord,
    request: TaskRequest,
    classified: ReturnType<typeof classifyOperation>,
    evidence: EvidenceItem[],
    observed: Record<string, unknown>,
  ): ExecutionResult {
    if (
      task.idempotencyKey !== undefined &&
      this.store.getIdempotencyCommit(task.idempotencyKey) === undefined
    ) {
      this.store.commitIdempotency(
        task.idempotencyKey,
        task.id,
        task.attempt ?? 1,
        now(),
      );
    }
    // Read for the grant id only. The work is already done, so this is
    // accounting rather than permission: a grant that has since run out still
    // pays for what it authorised. Asked as if nothing were drawn, because
    // policy names no grant at all for one that is now exhausted, and the
    // effect then went uncharged.
    const { grantId } = evaluatePolicy(task.id, request, this.policy, () => ({
      operations: 0,
      amountToday: 0,
    }));
    if (grantId !== undefined) {
      this.store.recordCapabilityUse(
        grantId,
        task.id,
        classified.spend?.amount ?? 0,
        now(),
      );
    }
    const receipt = this.createReceipt(
      task,
      request,
      classified.capability,
      classified.target,
      classified.effect,
      task.updatedAt,
      true,
      observed,
      evidence,
    );
    this.store.saveReceipt(receipt);
    task.receiptIds.push(receipt.receiptId);
    task.status = "verified_success";
    delete task.error;
    task.updatedAt = now();
    const certificate = this.createAndSaveCertificate(task, evidence);
    return { task, receipt, certificate };
  }

  /**
   * Settle a task whose idempotency key is committed to it. A key is
   * committed only once its effect verified, so whatever stopped the task
   * came after the effect: an interruption, or a write that failed.
   */
  private settleCommitted(
    task: TaskRecord,
    request: TaskRequest,
    classified: ReturnType<typeof classifyOperation>,
  ): ExecutionResult | undefined {
    if (
      task.idempotencyKey === undefined ||
      this.store.getIdempotencyCommit(task.idempotencyKey)?.taskId !== task.id
    ) {
      return undefined;
    }
    return this.resolveAsVerified(
      task,
      request,
      classified,
      [
        {
          type: "idempotency",
          passed: true,
          strength: evidenceStrength("idempotency"),
          summary: "verified and committed before the interruption",
        },
      ],
      { recovery: "committed_before_interruption" },
    );
  }

  /**
   * With `failed`, each task that could not be recovered is recorded there by
   * id instead of the first failure being thrown at the end.
   */
  async recoverInterrupted(failed?: Map<string, unknown>): Promise<TaskRecord[]> {
    const recovered: TaskRecord[] = [];
    const failures = failed ?? new Map<string, unknown>();
    for (const listed of this.store.listInterruptedTasks()) {
      // Only tasks whose owning process is gone, and only once: a live peer's
      // work is left to finish. This process's own rows are taken too when
      // nothing here has them in flight, so a task whose final write failed,
      // or whose recovery threw after the claim, is retried by the next pass
      // instead of waiting for a restart.
      const task = this.store.claimInterruptedTask(listed.id);
      if (task === undefined) continue;
      this.store.inFlight.add(task.id);
      try {
        recovered.push(await this.recoverTask(task));
      } catch (error) {
        // One task that cannot be recovered must not keep the rest waiting;
        // the failure is still reported once every task has had its turn.
        failures.set(task.id, error);
        // Given back rather than kept: held by this live process, no other
        // could take it, so an advance elsewhere could never learn why its
        // run is stuck. Whoever claims it next meets the same failure.
        try {
          this.store.releaseTaskClaim(task.id);
        } catch {
          // Still ours, then; this process retakes it on its next pass.
        }
      } finally {
        this.store.inFlight.delete(task.id);
      }
    }
    if (failed === undefined && failures.size > 0) throw failures.values().next().value;
    return recovered;
  }

  private async recoverTask(task: TaskRecord): Promise<TaskRecord> {
    const request = this.loadRequest(task.id);
    const classified = classifyOperation(request.operation);
    if (
      task.status === "verifying" &&
      classified.effect !== "read" &&
      request.requiredEvidence.length > 0 &&
      request.requiredEvidence.every((predicate) =>
        ["file_exists", "file_absent", "file_hash"].includes(
          predicate.type,
        ),
      )
    ) {
      // What the adapter reported before the crash, when it got that far.
      // Evidence alone is not success: a build that exited 1 beside a dist/
      // left by an earlier one would otherwise recover as verified.
      const sealed = this.store.getTaskResult(task.id);
      const reported =
        sealed === undefined
          ? undefined
          : (this.payloadCipher.open(sealed, `task:${task.id}:result`) as Record<string, unknown>);
      const actionSucceeded = reported?.success !== false;
      const verification = await this.verifier.verify(
        request.requiredEvidence,
        {},
      );
      if (actionSucceeded && verification.verified) {
        this.resolveAsVerified(task, request, classified, verification.evidence, {
          recovery: "independent_reobservation",
        });
        return task;
      }
    }
    // A read that verified and committed its key before the interruption is
    // done. Run again, it would only be cancelled as a duplicate of itself,
    // and a workflow reads a cancelled step as a denial.
    if (classified.effect === "read") {
      const committed = this.settleCommitted(task, request, classified);
      if (committed !== undefined) return committed.task;
    }
    const effect = classified.effect;
    task.status = effect === "read" ? "planned" : "recovery_required";
    task.error =
      effect === "read"
        ? "interrupted_read_ready_for_retry"
        : "interrupted_mutation_requires_reconciliation";
    task.updatedAt = now();
    this.store.saveTask(task);
    // A crash mid-flight is the same unknown a dropped reply is, so a task
    // that declared how to settle one gets asked here rather than waiting for
    // someone to notice it. Still parked if the provider cannot answer.
    if (task.status === "recovery_required" && request.reconciliation.length > 0) {
      return (await this.reconcile(task.id)).task;
    }
    return task;
  }

  /**
   * What an approver is shown: the effect contract, minus the challenge and
   * the policy verdict, which a recheck at execution rewrites. Its digest is
   * what a decision is bound to, so a request that changed after it was
   * shown cannot run on that decision.
   */
  private approvalRender(task: TaskRecord, request: TaskRequest) {
    const { authorization: _authorization, policy: _policy, ...contract } = effectContract(
      { ...task, request },
      classifyOperation(request.operation),
    );
    return { contract, renderDigest: sha256(contract) };
  }

  /** A pending challenge as an operator surface shows it. */
  approvalView(taskId: string) {
    const task = this.status(taskId);
    if (task.status !== "awaiting_approval" || task.approval === undefined) {
      throw new Error(`task_not_awaiting_approval:${task.status}`);
    }
    return { task, ...this.approvalRender(task, this.loadRequest(taskId)) };
  }

  /**
   * Records an approver's yes to exactly the render they were shown. Never
   * executes, and never touches the task row: the decision lives in its own
   * insert-once table, and `execute` reads it. `out_of_band` only in enforced
   * mode, where nothing the agent saw could have produced it.
   */
  decide(taskId: string, renderDigest: string, approver: string): ApprovalDecision {
    const { task, renderDigest: current } = this.approvalView(taskId);
    // No phrase means an enforced kernel planned it, and would refuse this
    // in-band decision while the insert-once row kept anyone from correcting it.
    if (this.policy.mode !== "enforced" && task.approval!.phrase === undefined) {
      throw new Error("approval_needs_enforced_mode");
    }
    if (Date.parse(task.approval!.expiresAt) <= Date.now()) throw new Error("approval_expired");
    if (renderDigest !== current) throw new Error("approval_render_mismatch");
    const decision: ApprovalDecision = {
      approvalId: task.approval!.approvalId,
      taskId,
      renderDigest,
      channel: this.policy.mode === "enforced" ? "out_of_band" : "in_band",
      approver,
      decidedAt: now(),
    };
    if (!this.store.recordApprovalDecision(decision)) throw new Error("approval_already_decided");
    return decision;
  }

  /** The recorded decision for a pending task, while it can still be used. */
  approvalDecision(task: TaskRecord): ApprovalDecision | undefined {
    if (task.approval === undefined) return undefined;
    const decision = this.store.getApprovalDecision(task.approval.approvalId);
    if (decision === undefined || !this.usable(task, decision)) return undefined;
    // In enforced mode an in-band row is no decision at all, so a workflow node
    // waits for an operator and is re-planned at expiry instead of failing on
    // every advance.
    return this.policy.mode === "enforced" && decision.channel !== "out_of_band" ? undefined : decision;
  }

  /**
   * Made before the challenge expired, and used within a TTL of being made:
   * an answer that came in time is not lost to the time it takes to act on.
   */
  private usable(task: TaskRecord, decision: ApprovalDecision): boolean {
    const decidedAt = Date.parse(decision.decidedAt);
    return (
      task.approval !== undefined &&
      decidedAt <= Date.parse(task.approval.expiresAt) &&
      Date.now() < decidedAt + approvalTtl(this.policy)
    );
  }

  receipts(input: {
    taskId?: string;
    receiptId?: string;
  }): {
    receipts: ActionReceipt[];
    certificate?: ExecutionCertificate;
  } {
    if (input.receiptId !== undefined) {
      const receipt = this.store.getReceipt(input.receiptId);
      if (receipt === undefined) throw new Error("receipt_not_found");
      const certificate = this.store.getCertificateForTask(receipt.taskId);
      return {
        receipts: [receipt],
        ...(certificate === undefined ? {} : { certificate }),
      };
    }
    if (input.taskId === undefined) throw new Error("task_or_receipt_required");
    const receipts = this.store.getReceiptsForTask(input.taskId);
    const certificate = this.store.getCertificateForTask(input.taskId);
    return {
      receipts,
      ...(certificate === undefined ? {} : { certificate }),
    };
  }

  /**
   * A task's certificate, written now for a `verified_success` task whose
   * certificate failed to write after it was recorded: a workflow counts a
   * step done only on its certificate. For a writer of the run, never a
   * read. Only that status, because every other path to it writes the
   * certificate before the task, and `execute`, which does not, writes it
   * only if none is stored: whoever writes first, both hand out the same one.
   * A write that fails again is left for the next writer.
   */
  certify(taskId: string): ExecutionCertificate | undefined {
    const certificate = this.store.getCertificateForTask(taskId);
    if (certificate !== undefined) return certificate;
    const task = this.store.getTask(taskId);
    const last = task?.receiptIds.at(-1);
    const receipt = last === undefined ? undefined : this.store.getReceipt(last);
    if (task?.status !== "verified_success" || receipt === undefined) return undefined;
    try {
      return this.createAndSaveCertificate(task, receipt.evidence, true);
    } catch {
      return undefined;
    }
  }

  /**
   * The mode a task's effect ran under: recorded when it started running, or,
   * for a task that started before that was recorded, the mode on its first
   * receipt.
   */
  private runMode(task: TaskRecord): string | undefined {
    if (task.mode !== undefined) return task.mode;
    const [first] = task.receiptIds;
    return first === undefined ? undefined : this.store.getReceipt(first)?.mode;
  }

  private createReceipt(
    task: TaskRecord,
    request: TaskRequest,
    capability: string,
    target: string,
    effect: "read" | "mutate" | "destructive",
    startedAt: string,
    success: boolean,
    result: Record<string, unknown>,
    evidence: EvidenceItem[],
    error?: string,
  ): ActionReceipt {
    // From the task, not the caller: recovery and reconciliation write
    // receipts with no caller in sight. A task running since before
    // `approvedBy` existed still names the challenge it was planned under.
    const approvalId =
      task.approvedBy?.approvalId ??
      (task.policyDecision.outcome === "confirm" ? task.approval?.approvalId : undefined);
    const sanitized = redactStructuredValue(result);
    const adapterRedactions = Array.isArray(result.redactions)
      ? result.redactions.filter((item): item is string => typeof item === "string")
      : [];
    const redactions = [
      ...new Set([...adapterRedactions, ...sanitized.redactions]),
    ];
    return {
      schemaVersion: "1.0.0",
      receiptId: createReceiptId(),
      taskId: task.id,
      capability,
      principal: delegationChain(request.identity ?? LOCAL_IDENTITY),
      effect,
      executionGuarantee: executionGuaranteeFor(
        effect,
        request.reconciliation.length > 0,
      ),
      mode: this.runMode(task) ?? this.policy.mode,
      policyDecision: {
        outcome: task.policyDecision.outcome,
        policyVersion: task.policyDecision.policyVersion,
        ...(approvalId === undefined ? {} : { approvalId }),
        ...(task.approvedBy === undefined
          ? {}
          : {
              approval: {
                channel: task.approvedBy.channel,
                renderDigest: task.approvedBy.renderDigest,
                approver: task.approvedBy.approver,
                decidedAt: task.approvedBy.decidedAt,
              },
            }),
      },
      // The target is built from the request (a URL, a memory key) and stored
      // as it is, so it takes the same secret shapes out as everything else.
      target: redactSecrets(target).value,
      inputDigest: sha256(request.operation),
      startedAt,
      endedAt: now(),
      success,
      observedEffect: sanitized.value as Record<string, unknown>,
      evidence,
      redactions,
      ...(error === undefined ? {} : { error }),
    };
  }

  private loadRequest(taskId: string): TaskRequest {
    const sealed = this.store.getTaskPayload(taskId);
    if (sealed === undefined) throw new Error("task_payload_not_found");
    return TaskRequestSchema.parse(
      this.payloadCipher.open(sealed, `task:${taskId}:request`),
    );
  }

  private async executeWithRetries(
    task: TaskRecord,
    request: TaskRequest,
    effect: "read" | "mutate" | "destructive",
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    // Asked of the guarantee rather than re-derived from the effect, so the
    // promise the plan published is the same rule the loop obeys.
    const maximumAttempts = allowsRetry(
      executionGuaranteeFor(effect, request.reconciliation.length > 0),
    )
      ? request.budget.maxRetries + 1
      : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      if (signal.aborted) throw signal.reason ?? new Error("task_cancelled");
      task.attempts = attempt;
      task.updatedAt = now();
      this.store.saveTask(task);
      try {
        const result = await this.executor.execute(request.operation, signal);
        return {
          ...result,
          execution: {
            attempts: attempt,
            retried: attempt > 1,
          },
        };
      } catch (error) {
        lastError = error;
        if (attempt >= maximumAttempts || signal.aborted) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("execution_failed_without_error");
  }

  private createAndSaveCertificate(
    task: TaskRecord,
    evidence: EvidenceItem[],
    // A task's first: one another writer stored meanwhile stays, and is used.
    first = false,
  ): ExecutionCertificate {
    const approvalChannel =
      task.approvedBy?.channel ??
      (task.policyDecision.outcome === "allow"
        ? task.policyDecision.effect === "read"
          ? "not_required"
          : "bypassed"
        : undefined);
    // Sealed, so never guessed: a task that ran says how it ran, one that
    // never did was decided here, and one that ran before the mode was
    // recorded and left no receipt saying so goes without.
    const mode =
      this.runMode(task) ?? (task.receiptIds.length === 0 ? this.policy.mode : undefined);
    const certificate = createCertificate({
      taskId: task.id,
      goal: task.request.goal,
      result: certificateResult(task),
      policyVersion: task.policyDecision.policyVersion,
      receiptIds: task.receiptIds,
      evidence,
      createdAt: now(),
      ...(mode === undefined ? {} : { mode }),
      ...(approvalChannel === undefined ? {} : { approvalChannel }),
    });
    const stored = this.store.saveCertificate(certificate, { ifAbsent: first });
    task.certificateId = stored.certificateId;
    task.updatedAt = now();
    this.store.saveTask(task);
    return stored;
  }

  private finishWithoutReceipt(
    task: TaskRecord,
    evidence: EvidenceItem[],
  ): ExecutionResult {
    const certificate = this.createAndSaveCertificate(task, evidence);
    return { task, certificate };
  }
}
