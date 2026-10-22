// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRequestSchema, type Identity, type TaskRecord, type TaskRequestInput } from "@melra/protocol";
import { approvalTtl, createDefaultPolicy, type LocalPolicy } from "@melra/policy-core";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import { CircuitBreaker } from "./circuit-breaker.js";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";

const roots: string[] = [];
const stores: SqliteStore[] = [];

afterEach(async () => {
  vi.useRealTimers();
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(
  policy: (root: string) => LocalPolicy = createDefaultPolicy,
  file = ":memory:",
  breaker?: CircuitBreaker,
) {
  const root = await mkdtemp(join(tmpdir(), "melra-semantic-"));
  roots.push(root);
  await writeFile(join(root, "out.txt"), "written");
  const store = new SqliteStore(file);
  stores.push(store);
  const executor = { execute: vi.fn(async () => ({ success: true, path: "out.txt" })) };
  const resolved = policy(root);
  const verifier = await Verifier.create(root);
  const cipher = new PayloadCipher(Buffer.alloc(32, 9));
  const controller = new TaskController(store, resolved, executor, verifier, cipher, breaker);
  /** Another process on the same data: its own policy, and its own connection when given one. */
  const peer = (as: (root: string) => LocalPolicy, on = store) =>
    new TaskController(on, as(root), executor, verifier, cipher);
  return { controller, store, executor, ttl: approvalTtl(resolved), peer };
}

const SEMANTIC = { type: "semantic" as const, question: "Does out.txt read as the summary asked for?", artifacts: ["path"] };

/** A grant for one write. */
const once = (root: string): LocalPolicy => ({
  ...createDefaultPolicy(root),
  capabilities: [
    { id: "once", capability: "file.write", effects: ["mutate"], target: "*", principal: "*", maxOperations: 1 },
  ],
});

function write(requiredEvidence: TaskRequestInput["requiredEvidence"], extra: Partial<TaskRequestInput> = {}) {
  return TaskRequestSchema.parse({
    goal: "Write a summary someone has to judge",
    operation: { kind: "file", action: "write", path: "out.txt", content: "written", encoding: "utf8" },
    requiredEvidence,
    ...extra,
  });
}

/** Plans and, past the approval it needs, runs a mutation. */
async function run(controller: TaskController, request: ReturnType<typeof write>, options = {}) {
  const planned = controller.plan(request, options);
  if (planned.status !== "awaiting_approval") return await controller.execute(planned.id);
  return await controller.execute(planned.id, {
    approvalId: planned.approval!.approvalId,
    phrase: planned.approval!.phrase!,
  });
}

describe("semantic evidence (#54)", () => {
  it("waits for a verdict once every other check holds, and settles closed at expiry", async () => {
    const { controller, store, executor, ttl } = await setup();
    const started = Date.now();
    const ran = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]));
    const task = ran.task;
    expect(task.status).toBe("waiting_user");
    expect(ran.certificate?.result).toBe("WAITING_USER");
    expect(task.judgements).toEqual([
      { judgementId: expect.stringMatching(/^[0-9a-f-]{36}$/), predicateIndex: 1, expiresAt: expect.any(String) },
    ]);
    const expiresAt = Date.parse(task.judgements![0]!.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(started + ttl);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + ttl);
    // The action happened and is on record, the question as unanswered.
    expect(ran.receipt?.success).toBe(true);
    expect(ran.receipt?.evidence.map((item) => item.strength)).toEqual(["state", "semantic"]);
    expect(ran.receipt?.evidence[1]).toMatchObject({
      type: "semantic",
      passed: false,
      inconclusive: true,
      summary: "semantic_judgement_unanswered",
    });
    // Nothing runs it again or ends the wait early.
    await expect(controller.execute(task.id)).rejects.toThrow("task_not_executable:waiting_user");
    expect(controller.cancel(task.id).status).toBe("waiting_user");
    await controller.recoverInterrupted();
    expect(controller.status(task.id).status).toBe("waiting_user");
    expect(executor.execute).toHaveBeenCalledTimes(1);

    // No answer is not a yes: the change happened, so it is recovery_required, never failed.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(expiresAt + 1);
    await controller.recoverInterrupted();
    const expired = controller.status(task.id);
    expect(expired.status).toBe("recovery_required");
    expect(expired.error).toBe("semantic_judgement_expired");
    expect(expired.receiptIds).toEqual(task.receiptIds);
    const { certificate } = controller.receipts({ taskId: task.id });
    expect(certificate?.result).toBe("RECOVERY_REQUIRED");
    expect(certificate?.evidence[1]).toMatchObject({
      type: "semantic",
      passed: false,
      inconclusive: true,
      summary: "semantic_judgement_expired",
    });
    // A provider can say whether it happened, never whether it is right.
    const again = await controller.execute(task.id);
    expect(again.task.status).toBe("recovery_required");
    expect(again.task.error).toBe("semantic_judgement_expired");
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("ends a read partial at expiry, and a task whose other evidence failed partial at once", async () => {
    const { controller, executor } = await setup();
    const read = await controller.execute(
      controller.plan(
        TaskRequestSchema.parse({
          goal: "Read a summary someone has to judge",
          operation: { kind: "file", action: "read", path: "out.txt", encoding: "utf8" },
          requiredEvidence: [SEMANTIC],
        }),
      ).id,
    );
    expect(read.task.status).toBe("waiting_user");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(read.task.judgements![0]!.expiresAt) + 1);
    await controller.recoverInterrupted();
    expect(controller.status(read.task.id)).toMatchObject({ status: "partial", error: "semantic_judgement_expired" });
    vi.useRealTimers();

    const failing = await run(controller, write([{ type: "file_exists", path: "missing.txt" }, SEMANTIC]));
    expect(failing.task.status).toBe("partial");
    expect(failing.task.judgements).toBeUndefined();
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it("commits a waiting effect, so the same key does not run it again", async () => {
    const { controller, store, executor } = await setup();
    const key = "a".repeat(64);
    const first = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]), {
      idempotencyKey: key,
      attempt: 1,
    });
    expect(first.task.status).toBe("waiting_user");
    expect(store.getIdempotencyCommit(key)).toBeDefined();
    const duplicate = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]), {
      idempotencyKey: key,
      attempt: 2,
    });
    expect(duplicate.task).toMatchObject({ status: "cancelled", error: "duplicate_attempt_prevented" });
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("does not recover a wait cut off after its commit as verified", async () => {
    const { controller, store, executor } = await setup();
    const key = "b".repeat(64);
    const planned = controller.plan(
      TaskRequestSchema.parse({
        goal: "Read a summary someone has to judge",
        operation: { kind: "file", action: "read", path: "out.txt", encoding: "utf8" },
        requiredEvidence: [SEMANTIC],
      }),
      { idempotencyKey: key, attempt: 1 },
    );
    // Killed between the commit and the write that would have made it wait:
    // the commit says every kernel check held, not that the question did.
    store.saveTask({ ...planned, status: "verifying" }, store.ownerId());
    store.commitIdempotency(key, planned.id, 1, new Date().toISOString());
    await controller.recoverInterrupted();
    // Nor left to a retry, which its own commit cancels as a duplicate: it
    // settles closed, as at expiry.
    expect(controller.status(planned.id)).toMatchObject({ status: "partial", error: "semantic_judgement_expired" });
    expect(controller.receipts({ taskId: planned.id }).certificate?.result).toBe("PARTIAL");
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("draws the grant of a change cut off after its commit, and settles it closed", async () => {
    const { controller, store, executor } = await setup(once);
    const key = "c".repeat(64);
    const planned = controller.plan(write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]), {
      idempotencyKey: key,
      attempt: 1,
    });
    // Killed between the commit and the grant's draw.
    store.saveTask({ ...planned, status: "verifying" }, store.ownerId());
    store.commitIdempotency(key, planned.id, 1, new Date().toISOString());
    await controller.recoverInterrupted();
    expect(store.capabilityUsage("once", new Date(0).toISOString()).operations).toBe(1);
    expect(controller.status(planned.id)).toMatchObject({
      status: "recovery_required",
      error: "semantic_judgement_expired",
    });
    expect(controller.receipts({ taskId: planned.id }).certificate?.result).toBe("RECOVERY_REQUIRED");
    expect(controller.plan(write([{ type: "file_exists", path: "out.txt" }, SEMANTIC])).status).toBe("policy_blocked");
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("re-observes a change with no key cut off before its draw, and settles it closed", async () => {
    const { controller, store, executor } = await setup(once);
    const planned = controller.plan(write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]));
    // Killed after the adapter returned, as any task planned over MCP or the CLI.
    store.saveTask({ ...planned, status: "verifying" }, store.ownerId());
    await controller.recoverInterrupted();
    expect(controller.status(planned.id)).toMatchObject({
      status: "recovery_required",
      error: "semantic_judgement_expired",
    });
    // Receipted as any recovered change, with what was checked again.
    const { receipts, certificate } = controller.receipts({ taskId: planned.id });
    expect(receipts.map((receipt) => receipt.success)).toEqual([true]);
    expect(certificate?.evidence).toMatchObject([
      { type: "file_exists", passed: true },
      { type: "semantic", passed: false, inconclusive: true, summary: "semantic_judgement_expired" },
    ]);
    expect(store.capabilityUsage("once", new Date(0).toISOString()).operations).toBe(1);
    expect(controller.plan(write([{ type: "file_exists", path: "out.txt" }, SEMANTIC])).status).toBe("policy_blocked");
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("draws the grant of a change whose draw failed, once reconciled", async () => {
    const { controller, store, executor } = await setup(once);
    // The write after the commit: SQLITE_BUSY past the busy timeout, a full disk.
    vi.spyOn(store, "recordCapabilityUse").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const first = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]), {
      idempotencyKey: "d".repeat(64),
      attempt: 1,
    });
    expect(first.task.status).toBe("recovery_required");
    // What the status asks for: execute reconciles, and asked again says the same.
    const settled = [await controller.execute(first.task.id), await controller.execute(first.task.id)];
    expect(store.capabilityUsage("once", new Date(0).toISOString()).operations).toBe(1);
    for (const { task } of settled) {
      expect(task).toMatchObject({ status: "recovery_required", error: "semantic_judgement_expired" });
    }
    expect(controller.plan(write([{ type: "file_exists", path: "out.txt" }, SEMANTIC])).status).toBe("policy_blocked");
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("draws nothing more when settling a change whose live draw landed", async () => {
    const { controller, store } = await setup((root) => ({
      ...createDefaultPolicy(root),
      capabilities: [
        { id: "a", capability: "file.write", effects: ["mutate"], target: "*", principal: "*", maxOperations: 1 },
        { id: "b", capability: "file.write", effects: ["mutate"], target: "*", principal: "*", maxOperations: 5 },
      ],
    }));
    expect((await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]))).task.status).toBe(
      "waiting_user",
    );
    // `a` is spent, so this one draws `b`, and then its wait fails to write.
    vi.spyOn(store, "saveCertificate").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const second = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]), {
      idempotencyKey: "e".repeat(64),
      attempt: 1,
    });
    expect(second.task.status).toBe("recovery_required");
    expect((await controller.execute(second.task.id)).task.error).toBe("semantic_judgement_expired");
    const since = new Date(0).toISOString();
    expect([store.capabilityUsage("a", since).operations, store.capabilityUsage("b", since).operations]).toEqual([
      1, 1,
    ]);
  });

  it("leaves a change a peer settled since it was read as the peer settled it", async () => {
    const { controller, store } = await setup();
    vi.spyOn(store, "saveCertificate").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const parked = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]), {
      idempotencyKey: "f".repeat(64),
      attempt: 1,
    });
    expect(parked.task.status).toBe("recovery_required");
    // A peer's reconcile settles it between this one's read and its transaction.
    let peer: ReturnType<TaskController["execute"]> | undefined;
    const transaction = store.transaction.bind(store);
    vi.spyOn(store, "transaction").mockImplementationOnce((action) => {
      peer = controller.execute(parked.task.id);
      return transaction(action);
    });
    const late = await controller.execute(parked.task.id);
    const first = await peer!;
    expect(first.certificate).toBeDefined();
    expect(late.certificate).toBeUndefined();
    expect(late.task.error).toBe("semantic_judgement_expired");
    expect(controller.receipts({ taskId: parked.task.id }).certificate?.certificateId).toBe(
      first.certificate?.certificateId,
    );
  });

  it("writes a wait with its certificate, so a peer's expiry cannot land between them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "melra-semantic-db-"));
    roots.push(dir);
    const { controller, store } = await setup(createDefaultPolicy, join(dir, "melra.db"));
    const peer = new SqliteStore(join(dir, "melra.db"));
    stores.push(peer);
    // Written apart, a peer's sweep here saw the wait, settled it, and then
    // had it overwritten back to waiting_user by the certificate's save.
    const save = store.saveCertificate.bind(store);
    let seen: string | undefined;
    vi.spyOn(store, "saveCertificate").mockImplementationOnce((certificate, options) => {
      seen = peer.getTask(certificate.taskId)?.status;
      return save(certificate, options);
    });
    const ran = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]));
    expect(ran.task.status).toBe("waiting_user");
    expect(seen).toBe("verifying");
    expect(peer.getTask(ran.task.id)?.status).toBe("waiting_user");
  });

  it("meters a waiting effect, so a grant for one operation is spent by it", async () => {
    const { controller, store, executor } = await setup(once);
    const first = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]));
    expect(first.task.status).toBe("waiting_user");
    expect(store.capabilityUsage("once", new Date(0).toISOString()).operations).toBe(1);
    const another = controller.plan(write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]));
    expect(another.status).toBe("policy_blocked");
    expect(another.policyDecision.reason).toContain("capability");
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("settles the oldest expired waits first and reads no wait that is still open", async () => {
    const { controller, store } = await setup();
    const tasks = [];
    for (let index = 0; index < 3; index += 1) {
      tasks.push((await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]))).task);
    }
    const [newer, open, older] = tasks as [(typeof tasks)[0], (typeof tasks)[0], (typeof tasks)[0]];
    const at = Date.parse(newer.judgements![0]!.expiresAt) + 1;
    // Saved out of order: `older` was last updated first, and `open` waits longer.
    const saved = (task: typeof newer, updatedAt: number, expiresAt: number) =>
      store.saveTask({
        ...controller.status(task.id),
        updatedAt: new Date(updatedAt).toISOString(),
        judgements: [{ ...task.judgements![0]!, expiresAt: new Date(expiresAt).toISOString() }],
      });
    saved(newer, at - 1_000, at - 1);
    saved(open, at - 3_000, at + 60_000);
    saved(older, at - 2_000, at - 1);
    expect(store.listExpiredJudgements(new Date(at).toISOString()).map((task) => task.id)).toEqual([
      older.id,
      newer.id,
    ]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    await controller.recoverInterrupted();
    expect(controller.status(older.id).status).toBe("recovery_required");
    expect(controller.status(newer.id).status).toBe("recovery_required");
    expect(controller.status(open.id).status).toBe("waiting_user");
  });

  it("is refused where nothing could settle it", async () => {
    const { controller } = await setup();
    // Beside reconciliation, which asks a provider whether the effect happened.
    for (const request of [
      write([{ type: "file_exists", path: "out.txt" }, SEMANTIC], {
        reconciliation: [{ type: "file_exists", path: "out.txt" }],
      }),
      write([{ type: "file_exists", path: "out.txt" }], { reconciliation: [SEMANTIC] }),
    ]) {
      const planned = controller.plan(request);
      expect(planned.status).toBe("policy_blocked");
      expect(planned.policyDecision.reason).toBe("semantic_evidence_not_reconcilable");
    }
    // As the deciding vote on a delete.
    const deletion = controller.plan(
      TaskRequestSchema.parse({
        goal: "Delete a file judged only by a question",
        operation: { kind: "file", action: "delete", path: "out.txt", encoding: "utf8", recursive: false },
        requiredEvidence: [SEMANTIC],
      }),
    );
    expect(deletion.status).toBe("policy_blocked");
    expect(deletion.policyDecision.reason).toBe("semantic_only_destructive");
  });
});

const SECOND = { type: "semantic" as const, question: "Is out.txt short enough to read aloud?", artifacts: [] };

const enforced = (root: string): LocalPolicy => ({ ...createDefaultPolicy(root), mode: "enforced" });
const unhinged = (root: string): LocalPolicy => ({ ...createDefaultPolicy(root), unhinged: true });

/** A declared identity from `kind:id` refs, outermost first, as `delegationChain` prints it. */
function as(...refs: string[]): { identity: Identity } {
  const principals = refs.map((ref) => {
    const [kind, id] = ref.split(":") as [Identity["principal"]["kind"], string];
    return { kind, id };
  });
  return { identity: { principal: principals.at(-1)!, onBehalfOf: principals.slice(0, -1) } };
}

const GRADER = as("agent:grader");

function read(requiredEvidence: TaskRequestInput["requiredEvidence"], extra: Partial<TaskRequestInput> = {}) {
  return TaskRequestSchema.parse({
    goal: "Read a summary someone has to judge",
    operation: { kind: "file", action: "read", path: "out.txt", encoding: "utf8" },
    requiredEvidence,
    ...extra,
  });
}

/** A verdict on a task's `index`th question. */
function on(task: TaskRecord, verdict: "yes" | "no" | "cannot_tell", index = 0) {
  return { taskId: task.id, judgementId: task.judgements![index]!.judgementId, verdict };
}

/** Everything a verdict could write, to show a refused one wrote none of it. */
function snapshot(controller: TaskController, store: SqliteStore, taskId: string): string {
  return JSON.stringify([store.getTask(taskId), controller.receipts({ taskId })]);
}

describe("semantic verdicts (#54)", () => {
  it("verifies a task once a judge other than its actor says yes", async () => {
    const { controller, store } = await setup();
    const ran = await run(
      controller,
      write([{ type: "file_exists", path: "out.txt" }, SEMANTIC], { identity: as("human:alice", "agent:a").identity }),
    );
    expect(ran.task.status).toBe("waiting_user");
    const judged = controller.judge(
      { ...on(ran.task, "yes"), rationale: "It reads as the summary asked for." },
      as("harness:C", "agent:grader"),
    );
    expect(judged.task).toMatchObject({ status: "verified_success" });
    expect(judged.task.error).toBeUndefined();
    expect(judged.certificate?.result).toBe("VERIFIED_SUCCESS");
    expect(judged.certificate?.evidence.map((item) => item.strength)).toEqual(["state", "semantic"]);
    const judgedBy = {
      verdict: "yes",
      judge: "harness:C/agent:grader",
      channel: "in_band",
      judgedAt: expect.any(String),
      rationale: "It reads as the summary asked for.",
    };
    // Beside the actor's declared chain, so the two compare without the receipt.
    expect(judged.certificate?.evidence[1]).toEqual({
      type: "semantic",
      passed: true,
      strength: "semantic",
      summary: "semantic_judgement_yes",
      judgedBy,
      executedBy: "human:alice/agent:a",
    });
    // On the stored task too, beside the receipt's principal it was checked against.
    expect(store.getTask(ran.task.id)?.judgements?.[0]?.judgedBy).toEqual(judgedBy);
    const { receipts, certificate } = controller.receipts({ taskId: ran.task.id });
    expect(receipts.map((receipt) => receipt.principal)).toEqual(["human:alice/agent:a"]);
    expect(certificate?.certificateId).toBe(judged.certificate?.certificateId);
  });

  it("settles closed on a no or a cannot_tell, a change and a read as each claims", async () => {
    const { controller } = await setup();
    const cases = [
      ["change", "no", "partial"],
      ["read", "no", "partial"],
      ["change", "cannot_tell", "recovery_required"],
      ["read", "cannot_tell", "partial"],
    ] as const;
    for (const [effect, verdict, status] of cases) {
      const evidence = [{ type: "file_exists" as const, path: "out.txt" }, SEMANTIC];
      const ran = effect === "change" ? await run(controller, write(evidence)) : await run(controller, read(evidence));
      const judged = controller.judge(on(ran.task, verdict), GRADER);
      expect(judged.task, `${effect} ${verdict}`).toMatchObject({ status, error: `semantic_judgement_${verdict}` });
      expect(judged.certificate?.result).toBe(status.toUpperCase());
      expect(judged.certificate?.evidence[1]).toEqual({
        type: "semantic",
        passed: false,
        // Answered no is evidence the result is wrong; cannot_tell is evidence of nothing.
        ...(verdict === "cannot_tell" ? { inconclusive: true } : {}),
        strength: "semantic",
        summary: `semantic_judgement_${verdict}`,
        judgedBy: { verdict, judge: "agent:grader", channel: "in_band", judgedAt: expect.any(String) },
        executedBy: "agent:local",
      });
    }
  });

  it("waits for every question, and settles on the first answer other than yes", async () => {
    const { controller } = await setup();
    const evidence = [{ type: "file_exists" as const, path: "out.txt" }, SEMANTIC, SECOND];

    const both = await run(controller, write(evidence));
    const waiting = controller.judge(on(both.task, "yes"), GRADER);
    // Recorded, and nothing else: the certificate is the wait's.
    expect(waiting.task.status).toBe("waiting_user");
    expect(waiting.certificate).toBeUndefined();
    expect(controller.receipts({ taskId: both.task.id }).certificate?.certificateId).toBe(
      both.certificate?.certificateId,
    );
    const verified = controller.judge(on(both.task, "yes", 1), as("human:alice"));
    expect(verified.task.status).toBe("verified_success");
    expect(verified.certificate?.evidence.map((item) => [item.passed, item.summary])).toEqual([
      [true, expect.any(String)],
      [true, "semantic_judgement_yes"],
      [true, "semantic_judgement_yes"],
    ]);

    const split = await run(controller, write(evidence));
    controller.judge(on(split.task, "yes"), GRADER);
    const no = controller.judge(on(split.task, "no", 1), GRADER);
    expect(no.task).toMatchObject({ status: "partial", error: "semantic_judgement_no" });
    expect(no.certificate?.evidence.slice(1).map((item) => item.summary)).toEqual([
      "semantic_judgement_yes",
      "semantic_judgement_no",
    ]);

    // A no settles it with the other question still open, which stays unanswered.
    const early = await run(controller, write(evidence));
    const first = controller.judge(on(early.task, "no", 1), GRADER);
    expect(first.certificate?.evidence[1]).toMatchObject({
      passed: false,
      inconclusive: true,
      summary: "semantic_judgement_unanswered",
    });
    expect(first.certificate?.evidence[1]?.judgedBy).toBeUndefined();

    // Expiry settles it closed, and the yes already given stays on the record.
    const lapsed = await run(controller, write(evidence));
    controller.judge(on(lapsed.task, "yes"), GRADER);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(lapsed.task.judgements![0]!.expiresAt));
    await controller.recoverInterrupted();
    const expired = controller.receipts({ taskId: lapsed.task.id }).certificate;
    expect(controller.status(lapsed.task.id)).toMatchObject({
      status: "recovery_required",
      error: "semantic_judgement_expired",
    });
    expect(expired?.evidence.slice(1)).toMatchObject([
      {
        passed: true,
        summary: "semantic_judgement_yes",
        judgedBy: { verdict: "yes", judge: "agent:grader" },
        executedBy: "agent:local",
      },
      { passed: false, inconclusive: true, summary: "semantic_judgement_expired" },
    ]);
    expect(expired?.evidence[2]?.executedBy).toBeUndefined();
  });

  it("writes only the task: no breaker record, grant draw, commit or receipt", async () => {
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 });
    const twice = (root: string): LocalPolicy => ({
      ...createDefaultPolicy(root),
      capabilities: [
        { id: "twice", capability: "file.write", effects: ["mutate"], target: "*", principal: "*", maxOperations: 2 },
      ],
    });
    const { controller, store } = await setup(twice, ":memory:", breaker);
    const recorded = [vi.spyOn(breaker, "recordSuccess"), vi.spyOn(breaker, "recordFailure")];
    const usage = () => store.capabilityUsage("twice", new Date(0).toISOString()).operations;
    // A refund on no would let a grant for one write fund a second.
    for (const [verdict, key] of [
      ["no", "1".repeat(64)],
      ["cannot_tell", "2".repeat(64)],
    ] as const) {
      const ran = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]), {
        idempotencyKey: key,
        attempt: 1,
      });
      expect(ran.task.status).toBe("waiting_user");
      for (const spy of recorded) spy.mockClear();
      const before = { drawn: usage(), commit: store.getIdempotencyCommit(key), receipts: ran.task.receiptIds };
      const judged = controller.judge(on(ran.task, verdict), GRADER);
      expect(judged.task.error).toBe(`semantic_judgement_${verdict}`);
      for (const spy of recorded) expect(spy).not.toHaveBeenCalled();
      expect({
        drawn: usage(),
        commit: store.getIdempotencyCommit(key),
        receipts: controller.receipts({ taskId: ran.task.id }).receipts.map((receipt) => receipt.receiptId),
      }).toEqual(before);
    }
  });

  it("never rewrites a judged task when execute settles its key", async () => {
    const { controller, executor } = await setup();
    const unchanged = async (taskId: string) => {
      const before = controller.receipts({ taskId }).certificate;
      const stored = controller.status(taskId);
      const again = await controller.execute(taskId);
      expect(again.task).toMatchObject({ status: stored.status, error: stored.error });
      const after = controller.receipts({ taskId }).certificate;
      expect(after?.certificateId).toBe(before?.certificateId);
      expect(after?.evidence).toEqual(before?.evidence);
      expect(controller.status(taskId)).toEqual(stored);
    };

    const doubted = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]), {
      idempotencyKey: "7".repeat(64),
      attempt: 1,
    });
    expect(controller.judge(on(doubted.task, "cannot_tell"), GRADER).task.status).toBe("recovery_required");
    await unchanged(doubted.task.id);

    const lapsed = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC, SECOND]), {
      idempotencyKey: "8".repeat(64),
      attempt: 1,
    });
    controller.judge(on(lapsed.task, "yes"), GRADER);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(lapsed.task.judgements![0]!.expiresAt) + 1);
    await controller.recoverInterrupted();
    expect(controller.status(lapsed.task.id).error).toBe("semantic_judgement_expired");
    await unchanged(lapsed.task.id);
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it("answers each question once, and only a waiting task's own", async () => {
    const { controller, store } = await setup();
    const ran = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC, SECOND]));
    const other = await run(controller, read([SEMANTIC]));
    const refused = (input: Parameters<TaskController["judge"]>[0], error: string) => {
      const before = snapshot(controller, store, input.taskId);
      expect(() => controller.judge(input, GRADER)).toThrow(error);
      expect(snapshot(controller, store, input.taskId)).toBe(before);
    };
    refused({ ...on(ran.task, "yes"), taskId: "00000000-0000-4000-8000-000000000000" }, "task_not_found");
    refused({ ...on(ran.task, "yes"), judgementId: "00000000-0000-4000-8000-000000000000" }, "judgement_not_found");
    // Another task's question, however real, is not this one's.
    refused({ ...on(other.task, "yes"), taskId: ran.task.id }, "judgement_not_found");
    controller.judge(on(ran.task, "yes"), GRADER);
    refused(on(ran.task, "no"), "judgement_already_answered");
    controller.judge(on(ran.task, "no", 1), GRADER);
    refused(on(ran.task, "yes", 1), "task_not_awaiting_judgement:partial");
    // Bounded, typed and closed like every other input.
    expect(() => controller.judge({ ...on(other.task, "yes"), verdict: "maybe" as "yes" }, GRADER)).toThrow();
    expect(() => controller.judge({ ...on(other.task, "yes"), rationale: "x".repeat(1_001) }, GRADER)).toThrow();
    expect(controller.status(other.task.id).status).toBe("waiting_user");
  });

  it("refuses a verdict from expiresAt on, writes nothing, and leaves it to the sweep", async () => {
    const { controller, store } = await setup();
    const ran = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]));
    const before = snapshot(controller, store, ran.task.id);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(ran.task.judgements![0]!.expiresAt));
    expect(() => controller.judge(on(ran.task, "yes"), GRADER)).toThrow("judgement_expired");
    expect(snapshot(controller, store, ran.task.id)).toBe(before);
    await controller.recoverInterrupted();
    expect(controller.status(ran.task.id)).toMatchObject({
      status: "recovery_required",
      error: "semantic_judgement_expired",
    });
  });

  for (const [mode, policy] of [
    ["developer", createDefaultPolicy],
    ["unsafe-local", unhinged],
  ] as const) {
    it(`refuses a judge that is the actor, and only that, in ${mode} mode`, async () => {
      const { controller, store } = await setup(policy);
      const matrix: [string[] | undefined, string[], boolean][] = [
        // Actor as `receipt.principal` reads, outermost first; the judge as it declared; refused?
        [undefined, ["agent:local"], true],
        [undefined, ["agent:grader"], false],
        [["harness:C", "agent:a"], ["harness:C", "agent:a"], true],
        [["harness:C", "agent:a"], ["harness:C", "agent:grader"], false],
        // A link the actor acts for is the actor too, unless it is a person.
        [["harness:C", "agent:a"], ["harness:C"], true],
        [["human:alice", "agent:a"], ["human:alice"], false],
        [["human:alice"], ["human:alice"], true],
        // A judge whose chain names the actor acts for it: a grader it spawned (#378).
        [undefined, ["agent:local", "agent:grader"], true],
        [["agent:a"], ["agent:a", "agent:grader"], true],
        [["harness:C", "agent:a"], ["harness:C", "agent:a", "agent:grader"], true],
        [["harness:C", "agent:a"], ["agent:a", "harness:D", "session:2"], true],
        [["human:alice"], ["human:alice", "agent:grader"], true],
        [["harness:C"], ["harness:C", "session:2"], true],
        // A link above the actor names someone else: another session of its
        // harness, or another agent of the person the work was for.
        [["harness:C", "agent:a"], ["harness:C", "session:2", "agent:grader"], false],
        [["human:alice", "agent:a"], ["human:alice", "agent:grader"], false],
      ];
      for (const [actor, judge, isActor] of matrix) {
        const ran = await run(
          controller,
          read([SEMANTIC], actor === undefined ? {} : { identity: as(...actor).identity }),
        );
        const label = `${actor?.join("/") ?? "(none)"} judged by ${judge.join("/")}`;
        if (isActor) {
          const before = snapshot(controller, store, ran.task.id);
          expect(() => controller.judge(on(ran.task, "yes"), as(...judge)), label).toThrow("semantic_judge_is_actor");
          expect(snapshot(controller, store, ran.task.id), label).toBe(before);
          // Still answerable by someone else.
          expect(controller.judge(on(ran.task, "yes"), as("agent:other")).task.status, label).toBe("verified_success");
        } else {
          expect(controller.judge(on(ran.task, "yes"), as(...judge)).task.status, label).toBe("verified_success");
        }
      }
    });
  }

  it("never compares the link a transport authenticated above a judge", async () => {
    const { controller } = await setup();
    const client = { kind: "harness" as const, id: "C" };
    // An OAuth client that planned declaring nothing is the actor, and heads
    // every chain it sends, so a judge it sends names it without declaring it.
    const itself = await run(controller, read([SEMANTIC], { identity: as("harness:C").identity }));
    expect(controller.judge(on(itself.task, "yes"), { ...as("harness:C", "agent:grader"), client }).task.status).toBe(
      "verified_success",
    );
    // What the judge declares beneath it still counts.
    const planned = await run(controller, read([SEMANTIC], { identity: as("harness:C", "agent:a").identity }));
    expect(() =>
      controller.judge(on(planned.task, "yes"), { ...as("harness:C", "agent:a", "agent:grader"), client }),
    ).toThrow("semantic_judge_is_actor");
    const declared = await run(controller, read([SEMANTIC], { identity: as("harness:C").identity }));
    expect(() =>
      controller.judge(on(declared.task, "yes"), { ...as("harness:C", "harness:C", "agent:grader"), client }),
    ).toThrow("semantic_judge_is_actor");
    // And an operator is not compared at all.
    const operated = await run(controller, read([SEMANTIC], { identity: as("human:alice").identity }));
    expect(controller.judge(on(operated.task, "yes"), { operator: "cli:alice" }).task.status).toBe("verified_success");
  });

  it("refuses an in-band verdict where only an operator's counts", async () => {
    const { controller, store, peer } = await setup(enforced);
    const developer = peer(createDefaultPolicy);
    const ran = await run(controller, read([SEMANTIC]));
    expect(ran.task.status).toBe("waiting_user");
    const before = snapshot(controller, store, ran.task.id);
    // The agent's, through any door of an enforced kernel.
    expect(() => controller.judge(on(ran.task, "yes"), GRADER)).toThrow("judgement_in_band_refused");
    // A developer process sharing the home: an agent or its operator alike.
    expect(() => developer.judge(on(ran.task, "yes"), GRADER)).toThrow("judgement_in_band_refused");
    expect(() => developer.judge(on(ran.task, "yes"), { operator: "cli:alice" })).toThrow(
      "judgement_in_band_refused",
    );
    // The task and its question come first, through every door (#384).
    const unknown = { ...on(ran.task, "yes"), judgementId: "00000000-0000-4000-8000-000000000000" };
    expect(() => controller.judge(unknown, GRADER)).toThrow("judgement_not_found");
    expect(() => developer.judge(unknown, GRADER)).toThrow("judgement_not_found");
    expect(snapshot(controller, store, ran.task.id)).toBe(before);
    // An operator of an enforced process, whoever the task was planned as.
    const asOperator = await run(controller, read([SEMANTIC], { identity: as("human:alice").identity }));
    for (const task of [ran.task, asOperator.task]) {
      const judged = controller.judge(on(task, "yes"), { operator: "cli:alice" });
      expect(judged.task.status).toBe("verified_success");
      expect(judged.task.judgements?.[0]?.judgedBy).toMatchObject({ judge: "cli:alice", channel: "out_of_band" });
    }
    expect(() => controller.judge(on(ran.task, "no"), GRADER)).toThrow("task_not_awaiting_judgement:verified_success");
    // In developer mode the operator's verdict is in band, and stands.
    const local = await run(developer, read([SEMANTIC]));
    expect(developer.judge(on(local.task, "no"), { operator: "cli:alice" }).task.judgements?.[0]?.judgedBy).toMatchObject(
      { judge: "cli:alice", channel: "in_band" },
    );
    // So is an enforced operator's on a developer run, which the agent's own
    // shell could have sent, as execute downgrades such an approval.
    const lent = await run(developer, read([SEMANTIC]));
    const judged = controller.judge(on(lent.task, "yes"), { operator: "cli:alice" });
    expect(judged.task.judgements?.[0]?.judgedBy).toMatchObject({ judge: "cli:alice", channel: "in_band" });
    expect(judged.certificate?.mode).toBe("developer");
    expect(judged.certificate?.evidence.find((item) => item.type === "semantic")?.judgedBy?.channel).toBe("in_band");
  });

  it("lets exactly one of two racing writers win", async () => {
    const dir = await mkdtemp(join(tmpdir(), "melra-semantic-db-"));
    roots.push(dir);
    const { controller, store, peer } = await setup(createDefaultPolicy, join(dir, "melra.db"));
    const other = new SqliteStore(join(dir, "melra.db"));
    stores.push(other);
    const rival = peer(createDefaultPolicy, other);
    /** Runs `peer` once this controller is about to open its transaction. */
    const between = (peerWrite: () => unknown) => {
      const transaction = store.transaction.bind(store);
      vi.spyOn(store, "transaction").mockImplementationOnce((action) => {
        peerWrite();
        return transaction(action);
      });
    };

    // Two verdicts on one question: the second is refused, the first stands.
    const shared = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC, SECOND]));
    between(() => rival.judge(on(shared.task, "yes"), as("agent:first")));
    expect(() => controller.judge(on(shared.task, "yes"), as("agent:second"))).toThrow("judgement_already_answered");
    expect(controller.status(shared.task.id).judgements?.[0]?.judgedBy?.judge).toBe("agent:first");

    // Two that would each settle it.
    const single = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]));
    let settled: ReturnType<TaskController["judge"]> | undefined;
    between(() => (settled = rival.judge(on(single.task, "no"), as("agent:first"))));
    expect(() => controller.judge(on(single.task, "yes"), as("agent:second"))).toThrow(
      "task_not_awaiting_judgement:partial",
    );
    expect(controller.receipts({ taskId: single.task.id }).certificate?.certificateId).toBe(
      settled?.certificate?.certificateId,
    );

    // The sweep and a verdict: the sweep first, the verdict refused.
    const swept = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(swept.task.judgements![0]!.expiresAt) + 1);
    let sweep: Promise<unknown> | undefined;
    between(() => (sweep = rival.recoverInterrupted()));
    expect(() => controller.judge(on(swept.task, "yes"), GRADER)).toThrow(
      "task_not_awaiting_judgement:recovery_required",
    );
    await sweep;
    expect(controller.status(swept.task.id).judgements?.[0]?.judgedBy).toBeUndefined();
    vi.useRealTimers();

    // The verdict first: the sweep leaves what it settled alone.
    const judged = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]));
    const verified = controller.judge(on(judged.task, "yes"), GRADER);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(judged.task.judgements![0]!.expiresAt) + 1);
    await rival.recoverInterrupted();
    expect(controller.status(judged.task.id).status).toBe("verified_success");
    expect(controller.receipts({ taskId: judged.task.id }).certificate?.certificateId).toBe(
      verified.certificate?.certificateId,
    );
  });

  it("redacts a rationale, a judge's name and the actor's on the task and the certificate", async () => {
    const { controller, store } = await setup();
    const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    const ran = await run(
      controller,
      write([{ type: "file_exists", path: "out.txt" }, SEMANTIC], { identity: as(`harness:${token}`).identity }),
    );
    const judged = controller.judge(
      { ...on(ran.task, "no"), rationale: `The summary pastes ${token} into the file.` },
      as(`agent:${token}`),
    );
    const stored = JSON.stringify(store.getTask(ran.task.id));
    const certificate = JSON.stringify(controller.receipts({ taskId: ran.task.id }).certificate);
    for (const text of [stored, certificate, JSON.stringify(judged)]) {
      expect(text).not.toContain(token);
      expect(text).toContain("The summary pastes [REDACTED_GITHUB_TOKEN] into the file.");
      expect(text).toContain('"judge":"agent:[REDACTED_GITHUB_TOKEN]"');
    }
    for (const text of [certificate, JSON.stringify(judged.certificate)]) {
      expect(text).toContain('"executedBy":"harness:[REDACTED_GITHUB_TOKEN]"');
    }
  });
});
