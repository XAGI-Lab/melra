// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type {
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

export class TaskController {
  private readonly active = new Map<string, AbortController>();

  private readonly breaker: CircuitBreaker;

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
  private readonly capabilityUsage: CapabilityUsageReader = (grantId) =>
    capabilityUsageReader(this.store)(grantId);

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
    this.preflight(parsedRequest);
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

  preflight(request: TaskRequest): PolicyDecision {
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
    return evaluatePolicy(
      "00000000-0000-4000-8000-000000000000",
      parsed,
      this.policy,
      this.capabilityUsage,
    ).decision;
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
      const approvalResult = validateApproval(task.approval, approval);
      if (!approvalResult.ok) {
        throw new Error(approvalResult.reason);
      }
    }
    task.policyDecision = rechecked.decision;

    const controller = new AbortController();
    this.active.set(task.id, controller);
    task.status = "running";
    task.updatedAt = now();
    this.store.saveTask(task);
    const startedAt = now();
    const classified = classifyOperation(request.operation);
    let timeout: NodeJS.Timeout | undefined;
    let budgetExhausted = false;
    let shortCircuited = false;
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
        approval,
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
      const certificate = this.createAndSaveCertificate(task, evidence);
      return { task, output: result, receipt, certificate };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = redactStructuredValue(rawMessage).value as string;
      const aborted = controller.signal.aborted;
      // A refusal by the breaker is not fresh evidence about the target, and an
      // operator's cancellation is not evidence about it at all. A budget that
      // ran out is: the target did not answer in time.
      if (!shortCircuited && (!aborted || budgetExhausted)) {
        this.breaker.recordFailure(classified.target);
      }
      // Checked on the raw message and ahead of every other outcome, because it
      // is the strongest thing known: the adapter says the effect may already
      // have happened. `failed`, `cancelled` and `budget_exhausted` all assert
      // more than that. Reads are exempt — a read that may or may not have run
      // changed nothing either way, so there is nothing to reconcile.
      const unknownOutcome =
        classified.effect !== "read" && isOutcomeUnknown(rawMessage);
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
        approval,
        task.error,
      );
      this.store.saveReceipt(receipt);
      task.receiptIds.push(receipt.receiptId);
      this.store.saveTask(task);
      const certificate = this.createAndSaveCertificate(task, evidence);
      return { task, receipt, certificate };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.active.delete(task.id);
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
      undefined,
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
    // accounting rather than permission — a grant that has since run out still
    // pays for what it authorised.
    const { grantId } = evaluatePolicy(
      task.id,
      request,
      this.policy,
      this.capabilityUsage,
    );
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
      task.approval === undefined
        ? undefined
        : { approvalId: task.approval.approvalId, phrase: "recovered" },
    );
    this.store.saveReceipt(receipt);
    task.receiptIds.push(receipt.receiptId);
    task.status = "verified_success";
    delete task.error;
    task.updatedAt = now();
    const certificate = this.createAndSaveCertificate(task, evidence);
    return { task, receipt, certificate };
  }

  async recoverInterrupted(): Promise<TaskRecord[]> {
    const recovered: TaskRecord[] = [];
    for (const task of this.store.listInterruptedTasks()) {
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
        const verification = await this.verifier.verify(
          request.requiredEvidence,
          {},
        );
        if (verification.verified) {
          this.resolveAsVerified(task, request, classified, verification.evidence, {
            recovery: "independent_reobservation",
          });
          recovered.push(task);
          continue;
        }
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
        recovered.push((await this.reconcile(task.id)).task);
        continue;
      }
      recovered.push(task);
    }
    return recovered;
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
    approval?: ApprovalResponse,
    error?: string,
  ): ActionReceipt {
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
      mode: this.policy.mode,
      policyDecision: {
        outcome: task.policyDecision.outcome,
        policyVersion: task.policyDecision.policyVersion,
        ...(approval === undefined ? {} : { approvalId: approval.approvalId }),
      },
      target,
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
  ): ExecutionCertificate {
    const certificate = createCertificate({
      taskId: task.id,
      goal: task.request.goal,
      result: certificateResult(task),
      policyVersion: task.policyDecision.policyVersion,
      receiptIds: task.receiptIds,
      evidence,
      createdAt: now(),
    });
    task.certificateId = certificate.certificateId;
    task.updatedAt = now();
    this.store.saveCertificate(certificate);
    this.store.saveTask(task);
    return certificate;
  }

  private finishWithoutReceipt(
    task: TaskRecord,
    evidence: EvidenceItem[],
  ): ExecutionResult {
    const certificate = this.createAndSaveCertificate(task, evidence);
    return { task, certificate };
  }
}
