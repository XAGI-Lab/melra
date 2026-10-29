// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from "node:crypto";
import type {
  ApprovalChallenge,
  ApprovalDecision,
  ApprovalDenial,
  ApprovalResponse,
  DenialInput,
  EffectContract,
  EvidencePredicate,
  Identity,
  KernelCheck,
  MelraTaskJudgeInput,
  Operation,
  PolicyDecision,
  Principal,
  Refusal,
  SemanticJudgedBy,
  SemanticJudgement,
  TaskRecord,
  TaskRequest,
} from "@melra/protocol";
import {
  allowsRetry,
  callerRef,
  delegationChain,
  DenialInputSchema,
  effectContract,
  executionGuaranteeFor,
  isOutcomeUnknown,
  LOCAL_IDENTITY,
  MelraTaskJudgeInputSchema,
  principalRef,
  TaskRequestSchema,
} from "@melra/protocol";
import {
  approvalTtl,
  CAPABILITY_DAY_MS,
  classifyOperation,
  defaultEvidenceFor,
  digestOperation,
  evaluatePolicy,
  type CapabilityUsageReader,
  type LocalPolicy,
  unlistedProbe,
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
import { kernelChecksFor, Verifier } from "@melra/verifier-core";
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
  /**
   * Who is planning it, as `callerRef` names them; the operator when unset,
   * but for a workflow step, which names its run's planner or, for a run
   * planned before callers were recorded, nobody.
   */
  client?: string;
  /** The run a workflow step is planned for. */
  workflowId?: string;
}

function now(): string {
  return new Date().toISOString();
}

/** How long a reconciliation read over HTTP that misses is not yet a no (#418). */
const HTTP_SETTLE_MS = 30_000;

/**
 * What was true before the call went out.
 *
 * A request that was never answered left no response, so the only handle on
 * what the provider was asked to do is the key MELRA itself sent. Shaped like
 * an adapter result so one predicate type reads the same on both paths.
 */
function reconciliationFacts(
  taskId: string,
  operation: Operation,
): Record<string, unknown> {
  return {
    taskId,
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
 * untouched — this only replaces an empty list. Exported for `melra policy
 * test`, whose preview must decide on the request the server would.
 */
export function withDefaultEvidence(request: TaskRequest): TaskRequest {
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

/**
 * A stored copy's content digests, masked as the content is. A file read's or
 * write's `sha256` hashes exactly what redaction took out of the record, and
 * a `file_hash` item that did not pass carries the file's real hash (one that
 * passed equals the hash its request declared). Applied after redaction to
 * the task's result and to receipt and certificate evidence; the marker maps
 * to itself, so a certificate written from a stored receipt (`certify`) says
 * what the live one did. The caller still gets the `sha256` in `output`, and
 * recovery reads the sealed raw result. A failed item's digest is returned
 * nowhere, since the caller gets the stored receipt and certificate; a file
 * `hash` operation reads it again.
 */
const MASKED = "[REDACTED_SENSITIVE_FIELD]";

function maskResultDigest(result: Record<string, unknown>, operation: Operation): Record<string, unknown> {
  return operation.kind === "file" && (operation.action === "read" || operation.action === "write") && "sha256" in result
    ? { ...result, sha256: MASKED }
    : result;
}

/**
 * The same list when there is nothing to mask, so a caller can tell. A kernel
 * check's `file_hash` hashes what the write carried, so with `kernel` its
 * digest goes whether it passed or not.
 */
function maskEvidenceDigests(evidence: EvidenceItem[], kernel = false): EvidenceItem[] {
  const hides = (item: EvidenceItem) =>
    item.type === "file_hash" && (kernel || !item.passed) && item.digest !== undefined && item.digest !== MASKED;
  return evidence.some(hides) ? evidence.map((item) => (hides(item) ? { ...item, digest: MASKED } : item)) : evidence;
}

/** Kernel checks as the task row stores them: redacted, a write's hash masked. */
function storedKernelChecks(checks: KernelCheck[]): KernelCheck[] {
  return redactStructuredValue(checks.map((check) => (check.type === "file_hash" ? { ...check, sha256: MASKED } : check)))
    .value as KernelCheck[];
}

/** Statuses a task leaves only once: by starting, by a deny, or by a refusal. */
const UNSTARTED: TaskRecord["status"][] = ["planned", "awaiting_approval"];

/** Whether a task waits on a question only someone outside MELRA answers (#54). */
function asksSemantic(request: TaskRequest): boolean {
  return request.requiredEvidence.some((predicate) => predicate.type === "semantic");
}

/**
 * A semantic task's evidence with its answers written in (#54). An answered
 * item passes only on a yes, is inconclusive on cannot_tell, and says who
 * judged it and, as `executedBy`, the receipt's declared principal, so the
 * two declared chains can be compared without the receipt; an open one stays
 * failed and inconclusive, summarised `unanswered`. Matched by index: a
 * semantic task's receipt has one item per predicate, in order. Every other
 * item is left as it was.
 */
function overlay(
  evidence: EvidenceItem[],
  judgements: SemanticJudgement[],
  unanswered: string,
  executedBy: string | undefined,
): EvidenceItem[] {
  return evidence.map((item, index) => {
    if (item.type !== "semantic") return item;
    const { inconclusive: _inconclusive, ...rest } = item;
    const judgedBy = judgements.find((judgement) => judgement.predicateIndex === index)?.judgedBy;
    if (judgedBy === undefined) return { ...rest, passed: false, inconclusive: true, summary: unanswered };
    return {
      ...rest,
      passed: judgedBy.verdict === "yes",
      ...(judgedBy.verdict === "cannot_tell" ? { inconclusive: true } : {}),
      summary: `semantic_judgement_${judgedBy.verdict}`,
      judgedBy,
      ...(executedBy === undefined ? {} : { executedBy }),
    };
  });
}

/**
 * Whether a judge is the actor it would judge (#54): its declared principal
 * is the actor's, or a non-human link the actor acts for; or its declared
 * chain names the actor's principal, as a grader the actor spawned would. The
 * person the work was for may judge it, and so may another session under a
 * link the actor's chain shares. `client`, the link a transport authenticated,
 * heads the judge's chain undeclared and is not compared: an OAuth client that
 * planned as itself would otherwise refuse every judge it sends. Claims on
 * both sides, so it stops one loop grading itself, not a harness that
 * declares someone else.
 */
function judgesItself(judge: Identity, actor: Identity, client?: Principal): boolean {
  const same = (one: Principal, other: Principal) => one.kind === other.kind && one.id === other.id;
  const declared = judge.onBehalfOf.slice(client === undefined ? 0 : 1);
  return (
    same(actor.principal, judge.principal) ||
    actor.onBehalfOf.some((link) => link.kind !== "human" && same(link, judge.principal)) ||
    declared.some((link) => same(link, actor.principal))
  );
}

/** The one browser action that reads each list. */
const BROWSER_LIST_ACTIONS = [
  ["values", "select"],
  ["fields", "fill_form"],
  ["filePaths", "upload"],
] as const;

export class TaskController {
  private readonly active = new Map<string, AbortController>();
  /** Each task running here, settled once it has ended (see `settled`). */
  private readonly running = new Map<string, Promise<void>>();

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
   * task. The durable draw is written only once the adapter has answered, so
   * without this two tasks running at once both saw the grant unspent: two
   * operations against `maxOperations: 1`, a parallel workflow node
   * overspending `dailyMax`. Let go once the draw is written or the effect is
   * known not to have run; one whose draw failed to write is held until
   * recovery writes it (`drawGrant`).
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
    // A step of a run that names no planner names none either, so it stays
    // open to anyone, as its run does.
    const client =
      options.client === undefined && options.workflowId !== undefined ? undefined : (options.client ?? callerRef());
    // Refused before anything is written, so a flood leaves no task behind.
    if (policy.challenge !== undefined && client !== undefined) this.assertChallengeRoom(client);
    const timestamp = now();
    const sanitizedRequest = redactStructuredValue(parsedRequest)
      .value as TaskRequest;
    const kernelChecks = kernelChecksFor(parsedRequest.operation);
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
      ...(policy.challenge === undefined ? {} : { approval: this.keyedChallenge(policy.challenge) }),
      receiptIds: [],
      ...(client === undefined ? {} : { client }),
      ...(options.workflowId === undefined ? {} : { workflowId: options.workflowId }),
      ...(kernelChecks.length === 0 ? {} : { kernelChecks: storedKernelChecks(kernelChecks) }),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const sealed =
      task.status === "policy_blocked"
        ? undefined
        : this.payloadCipher.seal(parsedRequest, `task:${id}:request`);
    // The row lands with its request or not at all: written apart, a failed
    // second write left a task that could never run, and a workflow step that
    // took it up again on every advance (#416).
    this.store.transaction(() => {
      this.store.saveTask(task);
      if (sealed !== undefined) this.store.saveTaskPayload(id, sealed, timestamp);
      // A deny is an outcome like any other, so it is certified as execute's is.
      else this.createAndSaveCertificate(task, []);
    });
    // The plaintext request goes back to the caller with the contract derived
    // from it, so what a caller reads before approving is the same object the
    // execution path will load.
    const planned = { ...task, request: parsedRequest, ...(kernelChecks.length === 0 ? {} : { kernelChecks }) };
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
    // Read only against the facts known before the call, so a URL token they
    // cannot fill (`{{json.id}}`: no response is read on this path) is
    // refused every time it is asked, and the task would stay parked.
    if (options.stored !== true) {
      const facts = reconciliationFacts("00000000-0000-4000-8000-000000000000", parsed.operation);
      for (const predicate of parsed.reconciliation) {
        const refused = this.verifier.unfilledToken(predicate, facts);
        if (refused !== undefined) throw new Error(`reconciliation_unanswerable:${refused}`);
      }
    }
    return evaluatePolicy(
      "00000000-0000-4000-8000-000000000000",
      parsed,
      this.policy,
      this.capabilityUsage,
    ).decision;
  }

  /**
   * Refuses a predicate no registered verifier can check, or that it would
   * refuse to. A workflow's own `check` is asked with no approval in front of
   * it, so in enforced mode one that reads from a host the policy admits only
   * by `*` is refused, where a task's evidence there is shown to a person.
   */
  assertVerifiable(predicates: EvidencePredicate[], options: { stored?: boolean; check?: boolean } = {}): void {
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
    if (options.check === true) this.assertCheckListed(predicates);
  }

  /**
   * Refuses, in enforced mode, a workflow check that reads from a host the
   * policy admits only by `*`. Asked again each time a check is, since a run
   * planned in developer mode, or before the planning check, can be advanced
   * by an enforced process, as a task's policy is evaluated again at execute.
   */
  assertCheckListed(predicates: EvidencePredicate[]): void {
    if (this.enforced && predicates.some((predicate) => unlistedProbe(predicate, this.policy))) {
      throw new Error("workflow_check_unlisted_host");
    }
  }

  status(taskId: string): TaskRecord {
    const task = this.store.getTask(taskId);
    if (task === undefined) throw new Error("task_not_found");
    return task;
  }

  /**
   * Refuses an authenticated client a task someone else planned: an id is a
   * handle, not a credential. `caller` is as `callerRef` names it; the
   * operator is refused nothing, and an id naming no task is left for the
   * call itself to refuse.
   */
  assertCaller(taskId: string, caller: string): void {
    const planner = this.store.getTask(taskId)?.client;
    if (caller !== callerRef() && planner !== undefined && planner !== caller) {
      throw new Error("task_belongs_to_another_client");
    }
  }

  /**
   * `by` is who sent `approval`, as for a workflow advance: the agent by the
   * client its transport authenticated (`agent` where it authenticated none),
   * or an operator by their label. A refused answer is recorded as the
   * agent's, never as the planner's, and an operator's not at all.
   */
  async execute(
    taskId: string,
    approval?: ApprovalResponse,
    by?: { agent: string } | { operator: string },
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
    if (!UNSTARTED.includes(task.status)) {
      // Swept at expiry (#462): the stored status is cancelled, but the caller
      // must still see the documented "plan the task again" signal — the same
      // answer this method gave before the sweep existed.
      if (task.status === "cancelled" && task.error === "approval_expired") {
        throw new Error("approval_expired");
      }
      throw new Error(`task_not_executable:${task.status}`);
    }
    // A halt stops the run, not only its advance: a step's task, in any mode,
    // runs only once its run is resumed, however its id was come by.
    const halted = task.workflowId === undefined ? undefined : this.store.getWorkflowRun(task.workflowId)?.status;
    if (halted === "paused" || halted === "suspended") throw new Error(`workflow_halted:${halted}`);
    if (
      task.idempotencyKey !== undefined &&
      this.store.getIdempotencyCommit(task.idempotencyKey) !== undefined
    ) {
      task.status = "cancelled";
      task.error = "duplicate_attempt_prevented";
      task.updatedAt = now();
      this.leaveUnstarted(task);
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
      this.leaveUnstarted(task);
      return this.finishWithoutReceipt(task, []);
    }

    if (rechecked.decision.outcome === "confirm") {
      // Stored keyed (`keyedChallenge`). One a 0.3.0-alpha.17 or alpha.18
      // process planned holds the plain digest, which binds the same exact
      // operation; it stays executable until it expires.
      const fresh = rechecked.challenge?.actionDigest;
      // An operator's is a command to rerun, not an answer from the agent's side.
      const refused = (code: string): Error =>
        by !== undefined && "operator" in by
          ? new Error(code)
          : this.refuse(code, {
              kind: "task",
              subjectId: task.id,
              ...(by === undefined ? {} : { client: by.agent }),
            });
      if (
        fresh === undefined ||
        (task.approval?.actionDigest !== this.payloadCipher.digest(fresh, "action") &&
          task.approval?.actionDigest !== fresh)
      ) {
        // A task planned without a challenge was sent nothing to refuse.
        throw task.approval === undefined
          ? new Error("approval_action_digest_mismatch")
          : refused("approval_action_digest_mismatch");
      }
      // Enforced mode asserts the agent holds no credential, so anything it
      // sends is refused rather than ignored, and only an operator's
      // out-of-band decision lets the effect run.
      if (this.policy.mode === "enforced" && approval !== undefined) {
        throw refused("approval_in_band_refused");
      }
      // A decision an operator recorded wins over anything the caller sent.
      const { contract, renderDigest: render } = this.approvalRender(task, request);
      // Recorded keyed, whatever form `render` takes: an older executor reads
      // the plain form only from a decision row.
      const bound = this.payloadCipher.digest(contract, "render");
      const decision = this.store.getApprovalDecision(task.approval.approvalId);
      // Waiting is only worth it while an operator could still say yes:
      // `decide` refuses an expired challenge, so past it the task is re-planned.
      if (this.policy.mode === "enforced" && decision?.channel !== "out_of_band") {
        throw new Error(
          Date.parse(task.approval.expiresAt) <= Date.now() ? "approval_expired" : "approval_awaiting_operator",
        );
      }
      if (decision !== undefined) {
        // A row a 0.3.0-alpha.17 or alpha.18 `melra approve` or console wrote
        // holds the plain digest of the same contract.
        if (decision.renderDigest !== render && decision.renderDigest !== sha256(contract)) {
          // Sent by whoever recorded the decision, not by this caller.
          throw this.refuse("approval_render_mismatch", {
            kind: "task",
            subjectId: task.id,
            principal: decision.approver,
          });
        }
        if (!this.usable(task, decision)) throw new Error("approval_expired");
        // Out of band is this kernel's claim to make, not the row's: a
        // developer-mode kernel cannot vouch that nothing the agent touched
        // wrote it, whatever mode the process that recorded it was in. The
        // digest is keyed, whichever form the row holds.
        task.approvedBy = {
          ...decision,
          renderDigest: bound,
          channel:
            decision.channel === "out_of_band" && this.policy.mode === "enforced"
              ? "out_of_band"
              : "in_band",
        };
      } else {
        const approvalResult = validateApproval(task.approval, approval);
        if (!approvalResult.ok) {
          // Only an answer that was sent and did not match is an attempt.
          throw ["approval_id_mismatch", "approval_phrase_mismatch"].includes(approvalResult.reason)
            ? refused(approvalResult.reason)
            : new Error(approvalResult.reason);
        }
        // The phrase is readable by anyone who can read the task, so an echo
        // of it says only that something echoed it.
        task.approvedBy = {
          approvalId: task.approval.approvalId,
          taskId: task.id,
          renderDigest: bound,
          channel: "in_band",
          approver: "phrase",
          decidedAt: now(),
        };
      }
    }
    task.policyDecision = rechecked.decision;

    task.status = "running";
    task.mode = this.policy.mode;
    if (this.policy.sandbox.backend !== undefined) task.sandbox = this.policy.sandbox.backend;
    task.updatedAt = now();
    // Status and owner land in one write, so no running row is ever unowned.
    this.leaveUnstarted(task, this.store.ownerId());
    const controller = new AbortController();
    let ended!: () => void;
    this.running.set(task.id, new Promise<void>((resolve) => (ended = resolve)));
    this.active.set(task.id, controller);
    this.store.inFlight.add(task.id);
    const startedAt = now();
    const classified = classifyOperation(request.operation);
    let timeout: NodeJS.Timeout | undefined;
    let budgetExhausted = false;
    let shortCircuited = false;
    let effectReturned = false;
    // Set once verification is done, until what it decided is committed: the
    // writes are undone together if any fails, and the catch puts back what
    // was true before them.
    let unwritten: { checksHeld: boolean; receiptIds: string[] } | undefined;
    if (rechecked.grantId !== undefined) {
      const held = this.reserved.get(rechecked.grantId) ?? new Map<string, number>();
      held.set(task.id, classified.spend?.amount ?? 0);
      this.reserved.set(rechecked.grantId, held);
    }
    // Charged whenever the adapter may have done the work, whatever the
    // evidence says of it: `verified_success` is the evidence verdict only.
    // Read off what the adapter gave back. It returned, whatever its `success`
    // (a request answered 500 reached the far end, a command that exited 1
    // ran), or it threw an outcome-unknown error (`OUTCOME_UNKNOWN_PREFIX`).
    // Any other throw is an adapter saying nothing went out, and costs
    // nothing; so does a refusal before it was called. Counting an effect
    // that did not happen is preferred to a grant funding more than it says.
    const draw = (): void => {
      if (rechecked.grantId === undefined) return;
      this.store.recordCapabilityUse(rechecked.grantId, task.id, classified.spend?.amount ?? 0, now());
    };
    // Only once the draw is committed, or the effect is known not to have run.
    const release = (): void => {
      if (rechecked.grantId !== undefined) this.reserved.get(rechecked.grantId)?.delete(task.id);
    };
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
      task.result = maskResultDigest(sanitizedResult.value as Record<string, unknown>, request.operation);
      task.updatedAt = now();
      // Committed on its own, ahead of the rest, on purpose: recovery settles
      // a `verifying` change it can look at again against this result
      // (`recoverTask`), and no transaction is held across the verifier,
      // which may wait on an HTTP probe.
      this.store.saveTaskExecutionResult(
        task,
        this.payloadCipher.seal(result, `task:${task.id}:result`),
      );

      const verification = await this.verifier.verify(
        request.requiredEvidence,
        result,
      );
      const kernelEvidence = await this.kernelEvidence(request.operation, result);
      const kernelHeld = kernelEvidence.every((item) => item.passed);
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
      // The kernel's own checks decide beside the caller's: one that failed
      // is `partial`, as a failed declared check is.
      const verified =
        actionSucceeded &&
        kernelHeld &&
        (request.requiredEvidence.length === 0 || verification.verified);
      // Every check the kernel can make held; what is left is a question only
      // someone outside answers (#54).
      const awaitingJudgement =
        actionSucceeded &&
        kernelHeld &&
        evidence.some((item) => item.type === "semantic") &&
        evidence.every((item) => item.passed || item.type === "semantic");
      // The effect ran and passed every kernel check, so it is committed now:
      // a key that ran must not run again, even while it waits for its verdict.
      const checksHeld = verified || awaitingJudgement;
      unwritten = { checksHeld, receiptIds: [...task.receiptIds] };
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
        undefined,
        kernelEvidence,
      );
      // Everything that records the outcome commits at once: the key, the
      // draw, the receipt, the task and its certificate. A crash before the
      // commit leaves the task `verifying`, as a crash during verification
      // does, and never a part of the outcome.
      const certificate = this.store.transaction(() => {
        if (
          checksHeld &&
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
        // The adapter returned, so the effect ran: drawn down for a `partial`,
        // a `failed` or a duplicate collapsed just above as for a verified task.
        draw();
        this.store.saveReceipt(receipt);
        task.receiptIds.push(receipt.receiptId);
        if (task.status !== "cancelled") {
          task.status = verified
            ? "verified_success"
            : awaitingJudgement
              ? "waiting_user"
              : actionSucceeded
                ? "partial"
                : "failed";
        }
        // Written in the same save as the status, so a waiting row always says
        // what it waits on, and until when.
        if (task.status === "waiting_user") {
          const expiresAt = new Date(Date.now() + approvalTtl(this.policy)).toISOString();
          task.judgements = request.requiredEvidence.flatMap((predicate, predicateIndex) =>
            predicate.type === "semantic" ? [{ judgementId: randomUUID(), predicateIndex, expiresAt }] : [],
          );
        }
        task.updatedAt = now();
        this.store.saveTask(task);
        // A wait lands with its certificate or not at all: written apart, a
        // peer's expiry between the two was overwritten by the second.
        if (task.status === "waiting_user") return this.createAndSaveCertificate(task, evidence, true, kernelEvidence);
        // Any other outcome stands without its certificate. Rewriting it
        // would contradict its receipt and commit, and an error would read
        // as the effect not having happened, so the caller gets what was
        // recorded; a workflow step's certificate is written by the run's
        // next advance (`certify`). A failure SQLite rolled the whole
        // transaction back for fails the commit instead, and the catch has it.
        try {
          return this.createAndSaveCertificate(task, evidence, true, kernelEvidence);
        } catch {
          return undefined;
        }
      });
      unwritten = undefined;
      release();
      return { task, output: result, receipt, ...(certificate === undefined ? {} : { certificate }) };
    } catch (error) {
      // The writes after verification were undone together. The receipt they
      // stored is gone, and a key whose effect passed every check is committed
      // here on its own, as it was before anything after it could fail: a
      // parked task settles on that commit (`settleCommitted`).
      if (unwritten !== undefined) {
        task.receiptIds = unwritten.receiptIds;
        if (unwritten.checksHeld && task.idempotencyKey !== undefined) {
          this.store.commitIdempotency(task.idempotencyKey, task.id, task.attempt ?? 1, now());
        }
      }
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
      // Paid for before the outcome is written, read or change alike. A draw
      // that fails to write leaves the reservation held, and the task running
      // for recovery to charge.
      const ran = effectReturned || isOutcomeUnknown(rawMessage);
      if (ran) draw();
      release();
      // Ahead of every other outcome, because it is the strongest thing known:
      // the effect may already have happened, either because the adapter says
      // so or because it returned and a write after it failed. `failed`,
      // `cancelled` and `budget_exhausted` all assert more than that. Reads
      // are exempt — a read that may or may not have run changed nothing
      // either way, so there is nothing to reconcile.
      const unknownOutcome = classified.effect !== "read" && ran;
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
      if (unknownOutcome) task.parkedAt = task.updatedAt;
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
      this.running.delete(task.id);
      ended();
    }
  }

  /**
   * Resolves once a task this controller is running has ended, its outcome
   * recorded: a cancel only signals the adapter to stop. At once for one it
   * is not running.
   */
  settled(taskId: string): Promise<void> {
    return this.running.get(taskId) ?? Promise.resolve();
  }

  cancel(taskId: string, error?: string): TaskRecord {
    const task = this.status(taskId);
    const controller = this.active.get(taskId);
    if (controller !== undefined) {
      controller.abort(new Error("task_cancelled"));
      return task;
    }
    if (UNSTARTED.includes(task.status)) {
      task.status = "cancelled";
      if (error !== undefined) {
        task.error = error;
      }
      task.updatedAt = now();
      // Started meanwhile by another process: it runs, so the caller is told
      // what the task is now rather than that it was cancelled.
      if (!this.store.saveTaskIf(task, UNSTARTED)) return this.status(taskId);
    }
    return task;
  }

  /**
   * Writes a task out of planned or awaiting_approval, unless a deny or an
   * execute in another process got there after this one read it: that one
   * stands, and this one is refused as it would have been had it read later.
   */
  private leaveUnstarted(task: TaskRecord, owner?: string): void {
    if (!this.store.saveTaskIf(task, UNSTARTED, owner)) {
      throw new Error(`task_not_executable:${this.status(task.id).status}`);
    }
  }

  async verifyPersisted(
    taskId: string,
    predicates: EvidencePredicate[],
  ): Promise<{ verified: boolean; evidence: EvidenceItem[] }> {
    this.assertCheckListed(predicates);
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
    this.assertCheckListed(predicates);
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
   * provider could not be reached and the task stays exactly where it was. A
   * miss inside the settle window is the third too.
   */
  async reconcile(taskId: string): Promise<ExecutionResult> {
    const task = this.status(taskId);
    if (task.status !== "recovery_required") {
      throw new Error(`task_not_reconcilable:${task.status}`);
    }
    const request = this.loadRequest(taskId);
    const classified = classifyOperation(request.operation);
    // A task an earlier version parked has no `parkedAt`; its window runs from
    // its last write, pinned at the first park here so it does not restart.
    const parkedAt = task.parkedAt ?? task.updatedAt;
    const park = (reason: string): ExecutionResult =>
      this.settleParked(taskId, () => {
        task.error = reason;
        task.parkedAt = parkedAt;
        task.updatedAt = now();
        this.store.saveTask(task);
        return { task };
      });
    // Its own commit already answers: every kernel check held, and only a
    // write after it failed. Parked for good otherwise, with nothing declared.
    const committed = this.settleParked(taskId, () => this.settleCommitted(task, request, classified));
    if (committed !== undefined) return committed;
    // A provider can say whether an effect happened, never whether it is
    // right: a task that declared a semantic predicate stays parked with its
    // cause unchanged (#54).
    if (asksSemantic(request)) return { task };
    if (request.reconciliation.length === 0) {
      return park("reconciliation_not_declared");
    }
    // The provider's view is from when it was asked, however late it answers.
    const askedAt = Date.now();
    const verification = await this.verifier.verify(
      request.reconciliation,
      reconciliationFacts(task.id, request.operation),
    );
    // Refused by the kernel itself, it is refused again however often it is
    // asked: the declaration needs fixing, which waiting on the provider will
    // not do. Named, so a caller can tell the two apart.
    const unanswerable = verification.evidence.filter((item) => item.unanswerable === true);
    if (unanswerable.length > 0) {
      const reason = `reconciliation_unanswerable:${unanswerable.map((item) => item.summary).join("; ")}`;
      return park((redactStructuredValue(reason).value as string).slice(0, 10_000));
    }
    // An unreachable provider did not say no. Resolving on this would be the
    // same lie as the `failed` this whole path exists to avoid.
    if (verification.evidence.some((item) => item.inconclusive === true)) {
      return park("reconciliation_inconclusive");
    }
    if (verification.verified) {
      // Held to the kernel's own checks too, or a weak reconciliation settled
      // what recovery had just seen fail. Parked rather than partial: these
      // facts carry no move result, so a case-only rename's source reads as
      // still there.
      const kernelEvidence = await this.kernelEvidence(request.operation, {});
      if (!kernelEvidence.every((item) => item.passed)) return park("reconciliation_kernel_check_failed");
      return this.settleParked(taskId, () =>
        this.resolveAsVerified(
          task,
          request,
          classified,
          verification.evidence,
          { reconciliation: "provider_state_confirms_effect" },
          kernelEvidence,
        ),
      );
    }
    // A provider whose reads lag its writes says "not found", or shows the old
    // value, for a write that landed, and is asked soonest after it did: on
    // the caller's retry and at recovery. Not a no until the window is over.
    const settleMs = Math.max(
      ...request.reconciliation.map((predicate) =>
        predicate.type === "http_resource_matches" ? (predicate.settleMs ?? HTTP_SETTLE_MS) : 0,
      ),
    );
    if (askedAt - Date.parse(parkedAt) < settleMs) {
      return park("reconciliation_settling");
    }
    // The provider answered, and the answer is that it never happened. Only now
    // is `failed` a claim MELRA is entitled to make.
    return this.settleParked(taskId, () => {
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
    });
  }

  /**
   * Writes a reconcile's answer in one transaction, and only while the task
   * still waits for one. Two reconciles of one task (two melra_execute calls,
   * or the sweep's recovery beside an agent's) each read it parked and ask
   * the provider; written unconditionally, the slower answer, even one that
   * could not reach the provider, overwrote a settle the other had recorded
   * and dropped its receipt. Now the first stands, and the other writes
   * nothing, not even a receipt, and returns the task as it now stands.
   */
  private settleParked<T>(taskId: string, write: () => T): T | ExecutionResult {
    return this.store.transaction(() =>
      this.store.getTask(taskId)?.status === "recovery_required" ? write() : { task: this.status(taskId) },
    );
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
    kernelEvidence: EvidenceItem[] = [],
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
    this.drawGrant(task, request, classified);
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
      undefined,
      kernelEvidence,
    );
    this.store.saveReceipt(receipt);
    task.receiptIds.push(receipt.receiptId);
    // Evidence gathered after the fact answers no question about meaning: a
    // semantic task, its effect done and receipted, settles closed as at
    // expiry (#54).
    if (asksSemantic(request)) return { ...this.settleUnanswered(task), receipt };
    task.status = "verified_success";
    delete task.error;
    task.updatedAt = now();
    const certificate = this.createAndSaveCertificate(task, evidence, false, kernelEvidence);
    return { task, receipt, certificate };
  }

  /**
   * Draws the grant behind an effect already done, once per task however
   * often asked. Policy is read for the grant id only: this is accounting
   * rather than permission, so a grant that has since run out still pays for
   * what it authorised. Asked as if nothing were drawn, because policy names
   * no grant at all for one that is now exhausted, and the effect then went
   * uncharged. A task that drew one already is left alone: policy read now
   * names the first grant that matches, not the one execute drew once that
   * was spent, and charging it too drew the task twice. Drawn, it lets go
   * of a reservation `execute` held when its own draw failed to write.
   */
  private drawGrant(
    task: TaskRecord,
    request: TaskRequest,
    classified: ReturnType<typeof classifyOperation>,
  ): void {
    const grantId = this.store.hasCapabilityUse(task.id)
      ? undefined
      : evaluatePolicy(task.id, request, this.policy, () => ({
          operations: 0,
          amountToday: 0,
        })).grantId;
    if (grantId !== undefined) {
      this.store.recordCapabilityUse(
        grantId,
        task.id,
        classified.spend?.amount ?? 0,
        now(),
      );
    }
    for (const held of this.reserved.values()) held.delete(task.id);
  }

  /**
   * Settle a task whose idempotency key is committed to it. A key is
   * committed only once every kernel check held, so whatever stopped the
   * task came after the effect: an interruption, or a write that failed. One
   * with a semantic question commits on entering `waiting_user`, so its
   * commit never says the question was answered: it settles closed, as at
   * expiry (#54).
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
    if (asksSemantic(request)) {
      // Settled already, it is left as it stands rather than certified again.
      // Asked of the stored row: a peer may have settled it since `task` was
      // read, and its status says `recovery_required` either way.
      // A verdict of cannot_tell settled it as well: settling it again would
      // rewrite that answer, and any yes beside it, as expired.
      const stored = this.status(task.id);
      if (stored.error === "semantic_judgement_expired" || stored.error === "semantic_judgement_cannot_tell") {
        return { task: stored };
      }
      // Cut off before it reached `waiting_user`, maybe before its draw too.
      this.drawGrant(task, request, classified);
      return this.settleUnanswered(task);
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
    // A miss inside its settle window parked these, and a workflow's advance
    // only reads them, so this pass asks again (#418). Listed before the
    // interrupted tasks, so one this pass parks is not asked twice.
    for (const id of this.store.listSettlingTaskIds()) {
      // Settled since the listing, by a caller or a peer.
      if (this.store.getTask(id)?.status !== "recovery_required") continue;
      try {
        recovered.push((await this.reconcile(id)).task);
      } catch (error) {
        failures.set(id, error);
      }
    }
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
    this.expireJudgements(failures);
    this.sweepExpiredApprovals(failures);
    if (failed === undefined && failures.size > 0) throw failures.values().next().value;
    return recovered;
  }

  /**
   * Standalone tasks awaiting approval whose challenge has expired without an
   * operator decision (#462) settle cancelled with error `approval_expired`.
   * A task with a recorded decision, and a workflow step's task, are left alone.
   */
  private sweepExpiredApprovals(failures: Map<string, unknown>): void {
    for (const listed of this.store.listExpiredApprovalTasks(now())) {
      try {
        if (listed.workflowId !== undefined) continue;
        if (listed.approval === undefined) continue;
        if (this.store.getApprovalDecision(listed.approval.approvalId) !== undefined) continue;
        if (listed.denial !== undefined) continue;
        this.cancel(listed.id, "approval_expired");
      } catch (error) {
        failures.set(listed.id, error);
      }
    }
  }

  /**
   * A waiting task whose judgements are past their `expiresAt` settles
   * closed. Re-read and written in one transaction, so a peer settling the
   * same task, or a verdict, wins once.
   *
   * ponytail: runs on the startup pass and the 30 s recovery sweep, so a wait
   * can outlive its `expiresAt` by one interval, or until a runtime next opens
   * this data directory. `judge` refuses a verdict from `expiresAt` on and
   * writes nothing, so nothing is answered in that gap; every runtime runs
   * this pass before it serves, `melra judge` included.
   */
  private expireJudgements(failures: Map<string, unknown>): void {
    for (const listed of this.store.listExpiredJudgements(now())) {
      try {
        this.store.transaction(() => {
          const task = this.store.getTask(listed.id);
          if (task?.status === "waiting_user") this.settleUnanswered(task);
        });
      } catch (error) {
        failures.set(listed.id, error);
      }
    }
  }

  /**
   * No answer is not a yes (#54). A task whose semantic question went
   * unanswered, at expiry or cut off after its commit, settles closed: its
   * effect ran, so a change is `recovery_required` (never `failed`) and a
   * read is `partial`. A yes given before expiry stays on the certificate.
   */
  private settleUnanswered(task: TaskRecord): ExecutionResult {
    return this.settleSemantic(
      task,
      task.policyDecision.effect === "read" ? "partial" : "recovery_required",
      "semantic_judgement_expired",
      "semantic_judgement_expired",
    );
  }

  /**
   * Settles a semantic task. Nothing runs here, so it writes no receipt: the
   * certificate, replaced, carries the evidence of the task's last one, the
   * live path's or the one recovery wrote, with the answers given so far.
   */
  private settleSemantic(
    task: TaskRecord,
    status: TaskRecord["status"],
    error: string | undefined,
    unanswered: string,
  ): ExecutionResult {
    const last = task.receiptIds[task.receiptIds.length - 1];
    const receipt = last === undefined ? undefined : this.store.getReceipt(last);
    const evidence = overlay(receipt?.evidence ?? [], task.judgements ?? [], unanswered, receipt?.principal);
    task.status = status;
    if (error === undefined) delete task.error;
    else task.error = error;
    task.updatedAt = now();
    return { task, certificate: this.createAndSaveCertificate(task, evidence, false, receipt?.kernelEvidence) };
  }

  /**
   * Records the answer to one semantic question of a waiting task (#54). The
   * first verdict other than yes settles the task: no ends it `partial`,
   * cannot_tell ends a change `recovery_required` and a read `partial`. The
   * yes that answers the last open question verifies it; an earlier one is
   * recorded, and the task waits on.
   *
   * A verdict writes the task row and nothing else, its certificate on a
   * settle included: no receipt, grant draw, breaker record or idempotency
   * commit, all of which the effect settled when it ran. Every check reads
   * the row inside one transaction, and each refusal writes nothing there, so
   * a question is answered once, and a peer's verdict or the expiry sweep wins
   * against this one at most once. An agent's in-band verdict is then recorded
   * as a refused answer, outside that transaction.
   *
   * `by` is the surface. An agent's declared identity is checked against the
   * task's actor, with `client` the link its transport authenticated, if any;
   * an operator's is not, as `decide` checks no approver. Only
   * an operator in an enforced process, on a task that ran enforced, judges
   * out of band, and an in-band verdict counts for nothing where approvals
   * come only from an operator.
   */
  judge(
    input: Omit<MelraTaskJudgeInput, "identity">,
    by: { identity: Identity; client?: Principal } | { operator: string },
  ): ExecutionResult {
    const parsed = MelraTaskJudgeInputSchema.omit({ identity: true }).parse(input);
    try {
      return this.judgeOnce(parsed, by);
    } catch (error) {
      // Recorded once the transaction is rolled back, which would take it too.
      // An operator's, refused for the mode its process runs in, is a command
      // to rerun, not an answer from the agent's side.
      if (!(error instanceof Error) || error.message !== "judgement_in_band_refused" || !("identity" in by)) {
        throw error;
      }
      throw this.refuse("judgement_in_band_refused", {
        kind: "task",
        subjectId: parsed.taskId,
        principal: delegationChain(by.identity),
        ...(by.client === undefined ? {} : { client: principalRef(by.client) }),
      });
    }
  }

  private judgeOnce(
    parsed: Omit<MelraTaskJudgeInput, "identity">,
    by: { identity: Identity; client?: Principal } | { operator: string },
  ): ExecutionResult {
    const operator = "operator" in by && this.enforced;
    return this.store.transaction(() => {
      const task = this.status(parsed.taskId);
      // The task and its question before the channel: told to change it, a
      // caller would only meet a settled task or a wrong id there (#384).
      // Nothing here is news to it: `melra_task_status` and `melra inspect`
      // show both.
      if (task.status !== "waiting_user") throw new Error(`task_not_awaiting_judgement:${task.status}`);
      const judgement = task.judgements?.find((entry) => entry.judgementId === parsed.judgementId);
      if (judgement === undefined) throw new Error("judgement_not_found");
      if (judgement.judgedBy !== undefined) throw new Error("judgement_already_answered");
      // Refused rather than settled here, which the throw would roll back:
      // the recovery pass settles it closed.
      if (Date.parse(judgement.expiresAt) <= Date.now()) throw new Error("judgement_expired");
      const runEnforced = this.runMode(task) === "enforced";
      // Every door an agent has to an enforced kernel is its harness's, and a
      // developer process sharing the home must not settle an enforced run.
      if (!operator && (this.enforced || runEnforced)) throw new Error("judgement_in_band_refused");
      // Out of band only on an enforced run, as `execute` downgrades an
      // approval: on a developer run the agent's own shell could have sent it.
      const channel = operator && runEnforced ? "out_of_band" : "in_band";
      // After the channel: where no agent's verdict counts, who it claims to
      // be is moot.
      if ("identity" in by && judgesItself(by.identity, this.loadRequest(task.id).identity ?? LOCAL_IDENTITY, by.client)) {
        throw new Error("semantic_judge_is_actor");
      }
      judgement.judgedBy = redactStructuredValue({
        verdict: parsed.verdict,
        judge: "identity" in by ? delegationChain(by.identity) : by.operator,
        channel,
        judgedAt: now(),
        ...(parsed.rationale === undefined ? {} : { rationale: parsed.rationale }),
      }).value as SemanticJudgedBy;
      if (parsed.verdict === "yes" && task.judgements!.some((entry) => entry.judgedBy === undefined)) {
        task.updatedAt = now();
        this.store.saveTask(task);
        return { task };
      }
      return this.settleSemantic(
        task,
        parsed.verdict === "yes"
          ? "verified_success"
          : parsed.verdict === "cannot_tell" && task.policyDecision.effect !== "read"
            ? "recovery_required"
            : "partial",
        parsed.verdict === "yes" ? undefined : `semantic_judgement_${parsed.verdict}`,
        "semantic_judgement_unanswered",
      );
    });
  }

  private async recoverTask(task: TaskRecord): Promise<TaskRecord> {
    const request = this.loadRequest(task.id);
    const classified = classifyOperation(request.operation);
    // A semantic question cannot be observed again, and resolveAsVerified
    // settles it closed; the rest must hold as for any other task, so a
    // change with no key to commit is charged here too.
    const observable = request.requiredEvidence.filter((predicate) => predicate.type !== "semantic");
    if (
      task.status === "verifying" &&
      classified.effect !== "read" &&
      observable.length > 0 &&
      observable.every((predicate) =>
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
      // Against what the adapter reported, as the live path verifies: a
      // move's own result is what tells a case-only rename's source is gone.
      // Its semantic item, never passed, rides along unanswered as on the
      // live receipt, and is the one item not required to pass.
      const verification = await this.verifier.verify(
        request.requiredEvidence,
        reported ?? {},
      );
      // The kernel's own checks are observed again too, as on the live path.
      const kernelEvidence = await this.kernelEvidence(request.operation, reported ?? {});
      if (
        actionSucceeded &&
        verification.evidence.every((item) => item.passed || item.type === "semantic") &&
        kernelEvidence.every((item) => item.passed)
      ) {
        this.resolveAsVerified(
          task,
          request,
          classified,
          verification.evidence,
          { recovery: "independent_reobservation" },
          kernelEvidence,
        );
        return task;
      }
    }
    // A read that verified and committed its key before the interruption is
    // done. Run again, it would only be cancelled as a duplicate of itself,
    // and a workflow reads a cancelled step as a denial. A task with a
    // semantic question that committed settles closed, change or read.
    if (classified.effect === "read" || asksSemantic(request)) {
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
    if (task.status === "recovery_required") task.parkedAt = task.updatedAt;
    // Cut off mid-flight, read or change, it may have run, so it is paid for
    // before it is parked, as `execute` pays for one. A read run again is the
    // same task, so it draws nothing more, but its re-check counts this draw.
    this.drawGrant(task, request, classified);
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
    // Keyed, like the challenge. A task a 0.3.0-alpha.17 or alpha.18 process
    // planned is shown its plain digest, the one that version's executor
    // recomputes, so a decision recorded here is one it accepts.
    const legacy = task.approval?.actionDigest === digestOperation(task.id, request.operation);
    return { contract, renderDigest: legacy ? sha256(contract) : this.payloadCipher.digest(contract, "render") };
  }

  /**
   * The challenge as stored beside the redacted request: its digest keyed by
   * this home's payload key, and the phrase still `APPROVE` plus that digest's
   * first twelve hex digits, as clients read it.
   */
  private keyedChallenge(challenge: ApprovalChallenge): ApprovalChallenge {
    const actionDigest = this.payloadCipher.digest(challenge.actionDigest, "action");
    return {
      ...challenge,
      actionDigest,
      ...(challenge.phrase === undefined ? {} : { phrase: `APPROVE ${actionDigest.slice(0, 12)}` }),
    };
  }

  /** A pending challenge as an operator surface shows it. */
  approvalView(taskId: string) {
    const task = this.status(taskId);
    // Swept at expiry (#462): report the expiry, not the swept status, so an
    // operator surface and the caller both see the re-plan signal.
    if (task.status === "cancelled" && task.error === "approval_expired") {
      throw new Error("approval_expired");
    }
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
    if (renderDigest !== current) {
      throw this.refuse("approval_render_mismatch", { kind: "task", subjectId: taskId, principal: approver });
    }
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

  /**
   * Records an approver's no, and why, and cancels the task in one write:
   * the denial lands with the cancel or not at all. Returns the task as it
   * now stands, which is not cancelled when another process started it
   * first. `out_of_band` only in enforced mode, as for a decision; the note
   * is stored redacted and never read here. `melra_task_cancel`, the agent
   * withdrawing its own task, leaves no denial.
   */
  deny(taskId: string, approver: string, input: DenialInput = {}): TaskRecord {
    const { reason, note } = DenialInputSchema.parse(input);
    const { task, renderDigest } = this.approvalView(taskId);
    const shown: NonNullable<TaskRecord["denial"]> = {
      reason,
      // Capped after redaction, which can lengthen it.
      ...(note === undefined ? {} : { note: redactSecrets(note).value.slice(0, 1_000) }),
      channel: this.enforced ? "out_of_band" : "in_band",
      approver,
      decidedAt: now(),
    };
    const denied: TaskRecord = { ...task, status: "cancelled", denial: shown, updatedAt: shown.decidedAt };
    const denial: ApprovalDenial = {
      ...shown,
      approvalId: task.approval!.approvalId,
      taskId,
      renderDigest,
      operationDigest: this.payloadCipher.digest(this.loadRequest(taskId).operation, "operation"),
    };
    return this.store.transaction(() => {
      if (!this.store.saveTaskIf(denied, UNSTARTED)) return this.status(taskId);
      this.store.recordApprovalDenial(denial);
      return denied;
    });
  }

  /**
   * Records a refused answer and returns the error to throw (#424). Only the
   * code, who sent it and when are kept, once per task or run and code. A
   * record that cannot be written changes nothing about the refusal. A
   * `client` of `agent`, a transport's name for a sender it did not
   * authenticate, names no client and is left out.
   */
  refuse(code: string, sender: Pick<Refusal, "kind" | "subjectId" | "principal" | "client">): Error {
    const { principal } = sender;
    const client = sender.client === "agent" ? undefined : sender.client;
    try {
      this.store.recordRefusal({
        kind: sender.kind,
        subjectId: sender.subjectId,
        code,
        mode: this.policy.mode,
        // Declared by the sender, so stored as other claims are.
        ...(principal === undefined ? {} : { principal: redactSecrets(principal).value }),
        ...(client === undefined ? {} : { client: redactSecrets(client).value }),
        refusedAt: now(),
      });
    } catch {
      // The refusal stands whether or not it could be written down.
    }
    return new Error(code);
  }

  /**
   * How many challenges a caller, as `callerRef` names it, has open: awaiting
   * a decision and not expired (#422). One approved and not yet run, and one
   * cancelled, denied or settled, asks nothing more of anyone and is not
   * counted.
   */
  pendingApprovals(client: string): number {
    return this.store
      .listOpenChallenges(client, now())
      .filter((task) => this.approvalDecision(task) === undefined).length;
  }

  /**
   * Refuses (`too_many_pending_approvals`) while a caller has
   * `maxPendingApprovals` challenges open, so it may be issued no more.
   *
   * ponytail: counted and written in one turn of this process; two servers
   * over one database can each pass at the cap at once, one over apiece.
   */
  assertChallengeRoom(client: string): void {
    const open = this.pendingApprovals(client);
    if (open >= this.policy.maxPendingApprovals) {
      throw new Error(
        `too_many_pending_approvals: ${open} tasks this caller planned already await approval (maxPendingApprovals ${this.policy.maxPendingApprovals}); plan more once some are approved, denied or cancelled, or their challenges expire`,
      );
    }
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
      return this.createAndSaveCertificate(task, receipt.evidence, true, receipt.kernelEvidence);
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
    kernelEvidence: EvidenceItem[] = [],
  ): ActionReceipt {
    // From the task, not the caller: recovery and reconciliation write
    // receipts with no caller in sight. A task running since before
    // `approvedBy` existed still names the challenge it was planned under.
    const approvalId =
      task.approvedBy?.approvalId ??
      (task.policyDecision.outcome === "confirm" ? task.approval?.approvalId : undefined);
    const sanitized = redactStructuredValue(result);
    const observedEffect = maskResultDigest(sanitized.value as Record<string, unknown>, request.operation);
    // A verifier's summary and source are stored text like any other.
    const sanitizedEvidence = redactStructuredValue(evidence);
    const storedEvidence = maskEvidenceDigests(sanitizedEvidence.value as EvidenceItem[]);
    const sanitizedKernel = redactStructuredValue(kernelEvidence);
    const storedKernel = maskEvidenceDigests(sanitizedKernel.value as EvidenceItem[], true);
    // The declared chain, redacted as the task row, a judge's name and a
    // certificate's `executedBy` are, so it reads the same as `executedBy`.
    const principal = redactSecrets(delegationChain(request.identity ?? LOCAL_IDENTITY));
    const adapterRedactions = Array.isArray(result.redactions)
      ? result.redactions.filter((item): item is string => typeof item === "string")
      : [];
    const masked =
      observedEffect !== sanitized.value ||
      storedEvidence !== sanitizedEvidence.value ||
      storedKernel !== sanitizedKernel.value
        ? [MASKED]
        : [];
    const redactions = [
      ...new Set([
        ...adapterRedactions,
        ...sanitized.redactions,
        ...sanitizedEvidence.redactions,
        ...sanitizedKernel.redactions,
        ...principal.redactions,
        ...masked,
      ]),
    ];
    return {
      schemaVersion: "1.0.0",
      receiptId: createReceiptId(),
      taskId: task.id,
      capability,
      principal: principal.value,
      effect,
      executionGuarantee: executionGuaranteeFor(
        effect,
        request.reconciliation.length > 0,
      ),
      mode: this.runMode(task) ?? this.policy.mode,
      ...(task.sandbox === undefined ? {} : { sandbox: task.sandbox }),
      policyDecision: {
        outcome: task.policyDecision.outcome,
        policyVersion: task.policyDecision.policyVersion,
        ...(task.policyDecision.policyDigest === undefined
          ? {}
          : { policyDigest: task.policyDecision.policyDigest }),
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
      // Keyed and bound to the task: it still pins the exact input for a
      // holder of the home's key, and two tasks' digests are never comparable.
      inputDigest: this.payloadCipher.digest({ taskId: task.id, operation: request.operation }, "input"),
      startedAt,
      endedAt: now(),
      success,
      observedEffect,
      evidence: storedEvidence,
      ...(storedKernel.length === 0 ? {} : { kernelEvidence: storedKernel }),
      redactions,
      ...(error === undefined ? {} : { error }),
    };
  }

  /**
   * What the kernel's own checks of this effect found (`kernelChecksFor`),
   * apart from the caller's. A memory record is read back from this store,
   * the one the memory adapter writes; the rest go through the verifier and
   * its confinement.
   */
  private async kernelEvidence(operation: Operation, result: Record<string, unknown>): Promise<EvidenceItem[]> {
    const checks = kernelChecksFor(operation);
    if (checks.length === 0) return [];
    if (operation.kind !== "memory") return (await this.verifier.verify(checks, result)).evidence;
    return checks.flatMap((check): EvidenceItem[] => {
      if (check.type !== "memory_absent") return [];
      const passed = this.store.getMemory(check.id)?.scope !== check.scope;
      const summary = `memory record ${passed ? "is absent" : "still exists"}`;
      return [{ type: check.type, passed, strength: evidenceStrength(check.type), summary }];
    });
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
        // An attempt that may have reached the far end outranks a later one
        // saying nothing went out: the read may have run, so it is charged.
        lastError = lastError instanceof Error && isOutcomeUnknown(lastError.message) ? lastError : error;
        if (attempt >= maximumAttempts || signal.aborted) throw lastError;
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
    kernelEvidence: EvidenceItem[] = [],
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
      ...(task.policyDecision.policyDigest === undefined
        ? {}
        : { policyDigest: task.policyDecision.policyDigest }),
      receiptIds: task.receiptIds,
      // Redacted and masked as a receipt's is, before the digest is taken.
      // Doing either again changes nothing, so one written from a stored
      // receipt's items (`certify`) says what one written from the verifier's would.
      evidence: maskEvidenceDigests(redactStructuredValue(evidence).value as EvidenceItem[]),
      ...(kernelEvidence.length === 0
        ? {}
        : { kernelEvidence: maskEvidenceDigests(redactStructuredValue(kernelEvidence).value as EvidenceItem[], true) }),
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
