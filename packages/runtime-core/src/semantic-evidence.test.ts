// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRequestSchema, type TaskRequestInput } from "@melra/protocol";
import { approvalTtl, createDefaultPolicy, type LocalPolicy } from "@melra/policy-core";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";

const roots: string[] = [];
const stores: SqliteStore[] = [];

afterEach(async () => {
  vi.useRealTimers();
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(policy: (root: string) => LocalPolicy = createDefaultPolicy) {
  const root = await mkdtemp(join(tmpdir(), "melra-semantic-"));
  roots.push(root);
  await writeFile(join(root, "out.txt"), "written");
  const store = new SqliteStore(":memory:");
  stores.push(store);
  const executor = { execute: vi.fn(async () => ({ success: true, path: "out.txt" })) };
  const resolved = policy(root);
  const controller = new TaskController(
    store,
    resolved,
    executor,
    await Verifier.create(root),
    new PayloadCipher(Buffer.alloc(32, 9)),
  );
  return { controller, store, executor, ttl: approvalTtl(resolved) };
}

const SEMANTIC = { type: "semantic" as const, question: "Does out.txt read as the summary asked for?", artifacts: ["path"] };

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

  it("meters a waiting effect, so a grant for one operation is spent by it", async () => {
    const { controller, store, executor } = await setup((root) => ({
      ...createDefaultPolicy(root),
      capabilities: [
        { id: "once", capability: "file.write", effects: ["mutate"], target: "*", principal: "*", maxOperations: 1 },
      ],
    }));
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
    const older = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]));
    const newer = await run(controller, write([{ type: "file_exists", path: "out.txt" }, SEMANTIC]));
    const at = Date.parse(older.task.judgements![0]!.expiresAt) + 1;
    // The newer one waits longer, as a later task with a longer TTL would.
    store.saveTask({
      ...controller.status(newer.task.id),
      judgements: [{ ...newer.task.judgements![0]!, expiresAt: new Date(at + 60_000).toISOString() }],
    });
    expect(store.listExpiredJudgements(new Date(at).toISOString()).map((task) => task.id)).toEqual([older.task.id]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    await controller.recoverInterrupted();
    expect(controller.status(older.task.id).status).toBe("recovery_required");
    expect(controller.status(newer.task.id).status).toBe("waiting_user");
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
