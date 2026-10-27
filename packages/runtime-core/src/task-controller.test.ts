// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskRequestSchema,
  delegationChain,
  outcomeUnknown,
  type Operation,
} from "@melra/protocol";
import { createDefaultPolicy } from "@melra/policy-core";
import { sha256 } from "@melra/receipt-schema";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier, type EvidenceProbe } from "@melra/verifier-core";
import { CircuitBreaker } from "./circuit-breaker.js";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";

const roots: string[] = [];
const stores: SqliteStore[] = [];

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(
  executor: {
    capabilities?(): ReadonlySet<Operation["kind"]>;
    execute(
      operation?: unknown,
      signal?: AbortSignal,
    ): Promise<Record<string, unknown>>;
  } = {
    async execute() {
      return { success: true, stored: true, value: "verified" };
    },
  },
  probe?: EvidenceProbe,
) {
  const root = await mkdtemp(join(tmpdir(), "melra-controller-"));
  roots.push(root);
  const store = new SqliteStore(":memory:");
  stores.push(store);
  const controller = await createController(
    store,
    root,
    Buffer.alloc(32, 7),
    executor,
    probe,
  );
  return { controller, store };
}

async function createController(
  store: SqliteStore,
  root: string,
  key: Buffer,
  executor: {
    capabilities?(): ReadonlySet<Operation["kind"]>;
    execute(
      operation?: unknown,
      signal?: AbortSignal,
    ): Promise<Record<string, unknown>>;
  },
  probe?: EvidenceProbe,
): Promise<TaskController> {
  return new TaskController(
    store,
    createDefaultPolicy(root),
    executor,
    await Verifier.create(root, probe === undefined ? {} : { probe }),
    new PayloadCipher(key),
  );
}

describe("TaskController", () => {
  it("executes a planned task after restart with the same key", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-controller-restart-"));
    roots.push(root);
    const databasePath = join(root, "melra.sqlite");
    const key = Buffer.alloc(32, 21);
    const executor = {
      execute: vi.fn(async () => ({ success: true, value: "verified" })),
    };
    const storeA = new SqliteStore(databasePath);
    stores.push(storeA);
    const controllerA = await createController(storeA, root, key, executor);
    const request = TaskRequestSchema.parse({
      goal: "Inspect the runtime after restart",
      operation: { kind: "system", action: "info" },
    });
    const planned = controllerA.plan(request);
    storeA.close();
    stores.splice(stores.indexOf(storeA), 1);

    const storeB = new SqliteStore(databasePath);
    stores.push(storeB);
    const controllerB = await createController(storeB, root, key, executor);
    const result = await controllerB.execute(planned.id);

    expect(result.task.status).toBe("verified_success");
    expect(executor.execute).toHaveBeenCalledWith(
      request.operation,
      expect.any(AbortSignal),
    );
  });

  it("hands out one certificate per task across processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-controller-certificate-"));
    roots.push(root);
    const databasePath = join(root, "melra.sqlite");
    const key = Buffer.alloc(32, 23);
    const executor = { execute: async () => ({ success: true, value: "verified" }) };
    const running = new SqliteStore(databasePath);
    const elsewhere = new SqliteStore(databasePath);
    stores.push(running, elsewhere);
    const executing = await createController(running, root, key, executor);
    const other = await createController(elsewhere, root, key, executor);
    const planned = executing.plan(
      TaskRequestSchema.parse({ goal: "Inspect the runtime", operation: { kind: "system", action: "info" } }),
    );
    // Another process reads the task, and a workflow advance certifies it,
    // while its certificate is being written.
    const save = running.saveCertificate.bind(running);
    let read: ReturnType<TaskController["receipts"]> | undefined;
    let certified: ReturnType<TaskController["certify"]>;
    let seen: string | undefined;
    vi.spyOn(running, "saveCertificate").mockImplementationOnce((certificate, options) => {
      read = other.receipts({ taskId: planned.id });
      certified = other.certify(planned.id);
      seen = elsewhere.getTask(planned.id)?.status;
      return save(certificate, options);
    });

    const executed = await executing.execute(planned.id);

    // The outcome commits with its certificate, so until then the task is
    // still verifying to anyone else: a read has no certificate to hand out,
    // and an advance none to write that the executor's would then replace.
    expect(seen).toBe("verifying");
    expect(read?.certificate).toBeUndefined();
    expect(certified).toBeUndefined();
    const stored = running.getCertificateForTask(planned.id)!;
    expect(executed.certificate?.certificateId).toBe(stored.certificateId);
    expect(running.getTask(planned.id)?.certificateId).toBe(stored.certificateId);
  });

  it("keeps exact requests out of SQLite and rejects the wrong key", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-controller-sealed-"));
    roots.push(root);
    const databasePath = join(root, "melra.sqlite");
    const storeA = new SqliteStore(databasePath);
    stores.push(storeA);
    const controllerA = await createController(
      storeA,
      root,
      Buffer.alloc(32, 23),
      { async execute() { return { success: true }; } },
    );
    const planned = controllerA.plan(
      TaskRequestSchema.parse({
        // Secret-shaped, since a goal keeps any words that are not (#385).
        goal: "Inspect with password=one-time-secret",
        operation: { kind: "system", action: "info" },
      }),
    );
    storeA.close();
    stores.splice(stores.indexOf(storeA), 1);

    expect((await readFile(databasePath)).toString()).not.toContain(
      "one-time-secret",
    );

    const storeB = new SqliteStore(databasePath);
    stores.push(storeB);
    const controllerB = await createController(
      storeB,
      root,
      Buffer.alloc(32, 29),
      { async execute() { return { success: true }; } },
    );
    await expect(controllerB.execute(planned.id)).rejects.toThrow(
      "task_payload_authentication_failed",
    );
  });

  it("verifies an authenticated persisted adapter result", async () => {
    const { controller } = await setup();
    const planned = controller.plan(
      TaskRequestSchema.parse({
        goal: "Persist a result for later workflow conditions",
        operation: { kind: "system", action: "info" },
      }),
    );
    await controller.execute(planned.id);

    await expect(
      controller.verifyPersisted(planned.id, [
        { type: "result_equals", path: "value", value: "verified" },
      ]),
    ).resolves.toMatchObject({ verified: true });
  });

  it("preflights installed capabilities without persisting a task", async () => {
    const { controller, store } = await setup({
      capabilities() {
        return new Set<Operation["kind"]>(["file"]);
      },
      async execute() {
        return { success: true };
      },
    });
    const request = TaskRequestSchema.parse({
      goal: "Require an installed system adapter",
      operation: { kind: "system", action: "info" },
    });

    expect(() => controller.preflight(request)).toThrow(
      "operation_capability_unavailable:system",
    );
    expect(store.listTasks()).toEqual([]);
  });

  it("refuses a browser list its action never reads, before anything is saved", async () => {
    const { controller, store } = await setup();
    const browser = (operation: Record<string, unknown>) =>
      TaskRequestSchema.parse({ goal: "Click", operation: { kind: "browser", ...operation } });
    // A list the runtime ignores would show the approver an effect that does not happen.
    expect(() =>
      controller.plan(browser({ action: "click", target: { selector: "#ok" }, filePaths: [".env"] })),
    ).toThrow("browser_field_unused:filePaths");
    expect(() =>
      controller.plan(browser({ action: "fill_form", fields: [{ target: { selector: "#a" }, value: "x" }], values: ["pad"] })),
    ).toThrow("browser_field_unused:values");
    expect(() =>
      controller.plan(browser({ action: "type", target: { selector: "#q" }, value: "x", fields: [{ target: { selector: "#a" }, value: "x" }] })),
    ).toThrow("browser_field_unused:fields");
    expect(store.listTasks()).toEqual([]);
    // Each list is still accepted by the action that reads it.
    expect(() => controller.plan(browser({ action: "select", target: { selector: "#s" }, values: ["a"] }))).not.toThrow();
  });

  it("rejects an approval whose stored action digest no longer matches", async () => {
    const { controller, store } = await setup();
    const planned = controller.plan(
      TaskRequestSchema.parse({
        goal: "Store a governed memory",
        operation: {
          kind: "memory",
          action: "put",
          key: "project",
          value: "MELRA",
        },
        requiredEvidence: [
          { type: "result_equals", path: "stored", value: true },
        ],
      }),
    );
    const stored = store.getTask(planned.id)!;
    stored.approval = {
      ...stored.approval!,
      actionDigest: "0".repeat(64),
    };
    store.saveTask(stored);

    await expect(
      controller.execute(planned.id, {
        approvalId: stored.approval.approvalId,
        phrase: stored.approval.phrase!,
      }),
    ).rejects.toThrow("approval_action_digest_mismatch");
  });

  it("uses rechecked policy rather than a stale stored allow decision", async () => {
    const execute = vi.fn(async () => ({ success: true, stored: true }));
    const { controller, store } = await setup({ execute });
    const planned = controller.plan(
      TaskRequestSchema.parse({
        goal: "Store a governed memory",
        operation: {
          kind: "memory",
          action: "put",
          key: "project",
          value: "MELRA",
        },
        requiredEvidence: [
          { type: "result_equals", path: "stored", value: true },
        ],
      }),
    );
    const stored = store.getTask(planned.id)!;
    stored.policyDecision = {
      ...stored.policyDecision,
      outcome: "allow",
      reason: "stale projection",
    };
    store.saveTask(stored);

    await expect(controller.execute(planned.id)).rejects.toThrow(
      "approval_required",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("recovers interrupted reads for retry and quarantines mutations", async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const { controller, store } = await setup({ execute });
    const read = controller.plan(
      TaskRequestSchema.parse({
        goal: "Recover an interrupted read",
        operation: { kind: "system", action: "info" },
      }),
    );
    const mutation = controller.plan(
      TaskRequestSchema.parse({
        goal: "Recover an interrupted mutation",
        operation: {
          kind: "memory",
          action: "put",
          key: "project",
          value: "MELRA",
        },
        requiredEvidence: [
          { type: "result_equals", path: "stored", value: true },
        ],
      }),
    );
    for (const item of [read, mutation]) {
      const stored = store.getTask(item.id)!;
      stored.status = "running";
      store.saveTask(stored);
    }

    const recovered = await controller.recoverInterrupted();

    expect(recovered).toHaveLength(2);
    expect(store.getTask(read.id)).toMatchObject({
      status: "planned",
      error: "interrupted_read_ready_for_retry",
    });
    expect(store.getTask(mutation.id)).toMatchObject({
      status: "recovery_required",
      error: "interrupted_mutation_requires_reconciliation",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("recovers as verified a read that committed its key before the interruption", async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const { controller, store } = await setup({ execute });
    const planned = controller.plan(
      TaskRequestSchema.parse({ goal: "Inspect", operation: { kind: "system", action: "info" } }),
      { idempotencyKey: "c".repeat(64), attempt: 1 },
    );
    // It verified and committed, then the process died before its final save.
    store.commitIdempotency("c".repeat(64), planned.id, 1, new Date().toISOString());
    const interrupted = store.getTask(planned.id)!;
    interrupted.status = "verifying";
    store.saveTask(interrupted);

    const [recovered] = await controller.recoverInterrupted();
    // Back to `planned` it ran again only to be cancelled as a duplicate of
    // itself, which a workflow reads as a denial.
    expect(recovered).toMatchObject({ status: "verified_success" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not recover as verified an action that reported failure", async () => {
    const { controller, store } = await setup();
    const root = roots.at(-1)!;
    const planned = controller.plan(
      TaskRequestSchema.parse({
        goal: "A build that failed beside an old output",
        operation: { kind: "file", action: "write", path: "dist.txt", content: "new" },
        requiredEvidence: [{ type: "file_exists", path: "dist.txt" }],
      }),
    );
    // Left by an earlier run, so the evidence passes whatever this one did.
    await writeFile(join(root, "dist.txt"), "old");
    const interrupted = store.getTask(planned.id)!;
    interrupted.status = "verifying";
    store.saveTaskExecutionResult(
      interrupted,
      new PayloadCipher(Buffer.alloc(32, 7)).seal({ success: false }, `task:${planned.id}:result`),
    );

    const [recovered] = await controller.recoverInterrupted();
    expect(recovered?.status).not.toBe("verified_success");
  });

  it("reconciles a verifying file mutation from independent evidence", async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const { controller, store } = await setup({ execute });
    const root = roots.at(-1)!;
    const planned = controller.plan(
      TaskRequestSchema.parse({
        goal: "Recover an already completed file write",
        operation: {
          kind: "file",
          action: "write",
          path: "recovered.txt",
          content: "complete",
        },
        requiredEvidence: [
          { type: "file_exists", path: "recovered.txt" },
        ],
      }),
      {
        idempotencyKey: "b".repeat(64),
        attempt: 1,
      },
    );
    await writeFile(join(root, "recovered.txt"), "complete");
    const interrupted = store.getTask(planned.id)!;
    interrupted.status = "verifying";
    // What execute() writes on its way into `verifying`: the adapter's result.
    store.saveTaskExecutionResult(
      interrupted,
      new PayloadCipher(Buffer.alloc(32, 7)).seal({ success: true }, `task:${planned.id}:result`),
    );

    const [recovered] = await controller.recoverInterrupted();

    expect(recovered).toMatchObject({
      id: planned.id,
      status: "verified_success",
    });
    expect(controller.receipts({ taskId: planned.id }).certificate?.result).toBe(
      "VERIFIED_SUCCESS",
    );
    expect(store.getIdempotencyCommit("b".repeat(64))).toMatchObject({
      taskId: planned.id,
      attempt: 1,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("recovers an interrupted case-only rename against the move's own result", async () => {
    const { controller, store } = await setup({ execute: vi.fn(async () => ({ success: true })) });
    const root = roots.at(-1)!;
    await writeFile(join(root, "Readme.md"), "x");
    await rename(join(root, "Readme.md"), join(root, "README.md"));
    // Only a disk that folds case reaches the renamed file by its old name.
    if (!(await lstat(join(root, "Readme.md")).then(() => true, () => false))) return;
    const planned = controller.plan(
      TaskRequestSchema.parse({
        goal: "Rename by case",
        operation: { kind: "file", action: "move", path: "Readme.md", destination: "README.md" },
      }),
      { idempotencyKey: "c".repeat(64), attempt: 1 },
    );
    const interrupted = store.getTask(planned.id)!;
    interrupted.status = "verifying";
    store.saveTaskExecutionResult(
      interrupted,
      new PayloadCipher(Buffer.alloc(32, 7)).seal(
        { moved: true, path: "Readme.md", destination: "README.md" },
        `task:${planned.id}:result`,
      ),
    );
    // Checked against no result, the old spelling read present and the
    // rename was parked for reconciliation it does not declare.
    const [recovered] = await controller.recoverInterrupted();
    expect(recovered).toMatchObject({ id: planned.id, status: "verified_success" });
  });

  it("prevents an already committed idempotency key from executing again", async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const { controller } = await setup({ execute });
    const request = TaskRequestSchema.parse({
      goal: "Run one logical attempt",
      operation: { kind: "system", action: "info" },
    });
    const idempotencyKey = "a".repeat(64);
    const first = controller.plan(request, {
      idempotencyKey,
      attempt: 1,
    });
    const firstResult = await controller.execute(first.id);
    const duplicate = controller.plan(request, {
      idempotencyKey,
      attempt: 2,
    });
    const duplicateResult = await controller.execute(duplicate.id);

    expect(firstResult.task).toMatchObject({
      status: "verified_success",
      idempotencyKey,
      attempt: 1,
    });
    expect(duplicateResult.task).toMatchObject({
      status: "cancelled",
      error: "duplicate_attempt_prevented",
      idempotencyKey,
      attempt: 2,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("plans, executes, verifies, and persists a read task", async () => {
    const { controller, store } = await setup();
    const task = controller.plan(
      TaskRequestSchema.parse({
        goal: "Inspect the system",
        operation: { kind: "system", action: "info" },
      }),
    );
    expect(task.status).toBe("planned");
    const execution = await controller.execute(task.id);
    expect(execution.task.status).toBe("verified_success");
    expect(execution.receipt?.success).toBe(true);
    expect(execution.certificate?.result).toBe("VERIFIED_SUCCESS");
    expect(store.getReceiptsForTask(task.id)).toHaveLength(1);
  });

  it("requires the exact approval for mutation", async () => {
    const { controller } = await setup();
    const task = controller.plan(
      TaskRequestSchema.parse({
        goal: "Store a memory",
        operation: {
          kind: "memory",
          action: "put",
          scope: "workspace",
          key: "project",
          value: "MELRA",
        },
        requiredEvidence: [
          { type: "result_equals", path: "stored", value: true },
        ],
      }),
    );
    expect(task.status).toBe("awaiting_approval");
    await expect(controller.execute(task.id)).rejects.toThrow("approval_required");
    const result = await controller.execute(task.id, {
      approvalId: task.approval!.approvalId,
      phrase: task.approval!.phrase!,
    });
    expect(result.task.status).toBe("verified_success");
  });

  it("derives evidence for a mutation that declared none", async () => {
    const { controller } = await setup();
    const task = controller.plan(
      TaskRequestSchema.parse({
        goal: "Write a file",
        operation: {
          kind: "file",
          action: "write",
          path: "result.txt",
          content: "unsafe",
        },
      }),
    );
    // A write has an obvious post-condition, so the task proceeds to approval
    // rather than dead-ending — but it is still held to that post-condition.
    expect(task.status).toBe("awaiting_approval");
    expect(task.request.requiredEvidence).toEqual([
      { type: "file_exists", path: "result.txt" },
    ]);
  });

  it("still blocks a mutation whose evidence cannot be derived", async () => {
    const { controller } = await setup();
    const task = controller.plan(
      TaskRequestSchema.parse({
        goal: "Run a build",
        operation: {
          kind: "terminal",
          action: "run",
          command: "npm",
          args: ["run", "build"],
        },
      }),
    );
    // Nothing about the request says what the command should leave behind, so
    // the mutation-requires-evidence guarantee still holds.
    expect(task.status).toBe("policy_blocked");
    expect(task.policyDecision.reason).toBe("mutation_requires_evidence");
  });

  it("stops calling an adapter that keeps failing, and still receipts the refusal", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-controller-breaker-"));
    roots.push(root);
    const store = new SqliteStore(":memory:");
    stores.push(store);
    let calls = 0;
    const controller = new TaskController(
      store,
      createDefaultPolicy(root),
      {
        async execute() {
          calls += 1;
          throw new Error("target_unreachable");
        },
      },
      await Verifier.create(root),
      new PayloadCipher(Buffer.alloc(32, 9)),
      new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 }),
    );
    const run = async () => {
      const task = controller.plan(
        TaskRequestSchema.parse({
          goal: "Ask an unreachable target",
          operation: { kind: "system", action: "info" },
          budget: { maxSteps: 1, maxDurationMs: 5_000, maxRetries: 0 },
        }),
      );
      return (await controller.execute(task.id)).task;
    };

    expect((await run()).status).toBe("failed");
    expect((await run()).status).toBe("failed");
    const refused = await run();
    // The point of the breaker: the third task never reaches the adapter.
    expect(calls).toBe(2);
    expect(refused.status).toBe("failed");
    expect(refused.error).toContain("circuit_open:local-system");
    // A refusal is still a governed outcome, so it owes the caller the same
    // receipt and certificate any other terminal task produces.
    expect(controller.receipts({ taskId: refused.id }).receipts).toHaveLength(1);
  });

  it("retries bounded read failures but never loops indefinitely", async () => {
    let attempts = 0;
    const { controller } = await setup({
      async execute() {
        attempts += 1;
        if (attempts < 2) throw new Error("transient_read_failure");
        return { success: true };
      },
    });
    const task = controller.plan(
      TaskRequestSchema.parse({
        goal: "Retry one transient read",
        operation: { kind: "system", action: "info" },
        budget: { maxRetries: 2, maxSteps: 3, maxDurationMs: 5_000 },
      }),
    );
    const result = await controller.execute(task.id);
    expect(result.task.status).toBe("verified_success");
    expect(result.task.attempts).toBe(2);
    expect(attempts).toBe(2);
  });

  it("classifies a generic abort error as budget exhaustion when its timer fires", async () => {
    const { controller } = await setup({
      async execute(_operation, signal?: AbortSignal) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("The operation was aborted")),
            { once: true },
          );
        });
        return { success: true };
      },
    });
    const task = controller.plan(
      TaskRequestSchema.parse({
        goal: "Respect a strict execution budget",
        operation: { kind: "system", action: "info" },
        budget: { maxRetries: 0, maxSteps: 1, maxDurationMs: 100 },
      }),
    );
    const result = await controller.execute(task.id);
    expect(result.task.status).toBe("budget_exhausted");
    expect(result.task.error).toBe("task_budget_exhausted");
    expect(result.certificate?.result).toBe("BUDGET_EXHAUSTED");
  });

  it("redacts executor secrets before task or receipt persistence", async () => {
    const { controller, store } = await setup({
      async execute() {
        return {
          success: true,
          stored: true,
          output: "password=hunter2",
          authorization: "Bearer raw-token-value",
        };
      },
    });
    const task = controller.plan(
      TaskRequestSchema.parse({
        goal: "Persist only redacted evidence",
        operation: { kind: "system", action: "info" },
        requiredEvidence: [
          { type: "result_equals", path: "stored", value: true },
        ],
      }),
    );
    const result = await controller.execute(task.id);
    expect(JSON.stringify(result.task.result)).not.toContain("hunter2");
    expect(JSON.stringify(result.receipt?.observedEffect)).not.toContain(
      "raw-token-value",
    );
    expect(result.output?.output).toBe("password=hunter2");
    expect(result.receipt?.redactions.length).toBeGreaterThan(0);
    expect(JSON.stringify(store.getTask(task.id))).not.toContain("hunter2");
  });

  it("redacts evidence before it is stored in the receipt and certificate", async () => {
    // Built at run time so no literal here reads as a leaked credential.
    const secret = `${"ghp"}_${"A1b2C3d4E5".repeat(4)}`;
    const { controller, store } = await setup(
      {
        async execute() {
          return { success: true, status: 200 };
        },
      },
      async () => {
        // A provider's error text is evidence too, and can carry anything.
        throw new Error(`upstream rejected ${secret}`);
      },
    );
    const task = controller.plan(
      TaskRequestSchema.parse({
        goal: "Confirm the provider's state",
        operation: { kind: "system", action: "info" },
        requiredEvidence: [
          { type: "http_resource_matches", url: "https://api.example.com/state", path: "status", value: 200 },
        ],
      }),
    );
    const result = await controller.execute(task.id);
    expect(result.receipt?.evidence[0]?.summary).toContain("upstream rejected");
    expect(JSON.stringify(store.getReceiptsForTask(task.id))).not.toContain(secret);
    expect(JSON.stringify(store.getCertificateForTask(task.id))).not.toContain(secret);
    expect(result.receipt?.redactions).toContain("[REDACTED_GITHUB_TOKEN]");
    // The certificate carries the same items, and its digest covers them.
    const { digest, ...unsigned } = store.getCertificateForTask(task.id)!;
    expect(unsigned.evidence).toEqual(result.receipt?.evidence);
    expect(digest).toBe(sha256(unsigned));
  });

  it("keeps a URL's userinfo out of the stored task and the receipt target", async () => {
    const { controller, store } = await setup({
      async execute() {
        return { success: true, status: 200 };
      },
    });
    const task = controller.plan(
      TaskRequestSchema.parse({
        goal: "Check status",
        operation: { kind: "http", action: "request", method: "GET", url: "https://deploy:S3cretPass@api.example.com/status" },
      }),
    );
    const result = await controller.execute(task.id);
    expect(JSON.stringify(store.getTask(task.id))).not.toContain("S3cretPass");
    expect(result.receipt?.target).not.toContain("S3cretPass");
  });

  it("records the declared goal on the task and certificate, minus its secret shapes (#385)", async () => {
    const { controller, store } = await setup({
      async execute() {
        return { success: true };
      },
    });
    const goal = "Read a.txt to confirm the greeting";
    const plain = controller.plan(
      TaskRequestSchema.parse({ goal, operation: { kind: "system", action: "info" } }),
    );
    expect((await controller.execute(plain.id)).certificate?.goal).toBe(goal);
    expect(store.getTask(plain.id)?.request.goal).toBe(goal);
    expect(store.getCertificateForTask(plain.id)?.goal).toBe(goal);

    // Built at run time so no literal here reads as a leaked credential.
    const secret = `${"ghp"}_${"A1b2C3d4E5".repeat(4)}`;
    const leaky = controller.plan(
      TaskRequestSchema.parse({ goal: `Deploy with ${secret}`, operation: { kind: "system", action: "info" } }),
    );
    await controller.execute(leaky.id);
    expect(store.getTask(leaky.id)?.request.goal).toBe("Deploy with [REDACTED_GITHUB_TOKEN]");
    expect(store.getCertificateForTask(leaky.id)?.goal).toBe("Deploy with [REDACTED_GITHUB_TOKEN]");
  });

  it("keeps no value of a credential a goal binds with `:=` or `=>`", async () => {
    const { controller, store } = await setup({
      async execute() {
        return { success: true };
      },
    });
    // Built at run time so no literal here reads as a leaked credential.
    const secret = `S3cr3t${"Passw0rd"}`;
    const task = controller.plan(
      TaskRequestSchema.parse({
        goal: `set password := "${secret}" in main.go and 'secret' => '${secret} too' in config.php`,
        operation: { kind: "system", action: "info" },
      }),
    );
    const execution = await controller.execute(task.id);
    for (const text of [
      JSON.stringify(store.getTask(task.id)),
      JSON.stringify(store.getCertificateForTask(task.id)),
      JSON.stringify(store.getReceiptsForTask(task.id)),
      JSON.stringify(execution.receipt),
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(store.getTask(task.id)?.request.goal).toBe(
      "set password=[REDACTED]\" in main.go and 'secret'=[REDACTED]' in config.php",
    );
  });

  it("shows the live caller the approval input without retaining it", async () => {
    const { controller, store } = await setup({
      async execute() {
        return { success: true, typed: true };
      },
    });
    const secretInput = "one-time private form value";
    const task = controller.plan(
      TaskRequestSchema.parse({
        goal: "Type a reviewed value",
        operation: {
          kind: "browser",
          action: "type",
          target: { selector: "#field" },
          value: secretInput,
        },
        requiredEvidence: [
          { type: "result_equals", path: "typed", value: true },
        ],
      }),
    );
    expect(
      task.request.operation.kind === "browser"
        ? task.request.operation.value
        : undefined,
    ).toBe(secretInput);
    expect(JSON.stringify(store.getTask(task.id))).not.toContain(secretInput);
    const execution = await controller.execute(task.id, {
      approvalId: task.approval!.approvalId,
      phrase: task.approval!.phrase!,
    });
    expect(execution.task.status).toBe("verified_success");
  });
});

describe("effect contract and principal", () => {
  it("returns the contract with the plan and stamps the chain on the receipt", async () => {
    const { controller } = await setup();
    const identity = {
      principal: { kind: "agent" as const, id: "claude-code" },
      onBehalfOf: [{ kind: "human" as const, id: "dheeraj" }],
    };
    const task = controller.plan(
      TaskRequestSchema.parse({
        goal: "Read a file",
        operation: { kind: "file", action: "read", path: "notes.txt" },
        identity,
      }),
    );
    expect(task.contract).toMatchObject({
      taskId: task.id,
      capability: "file.read",
      effect: "read",
      identity,
      metadata: { goal: "Read a file" },
    });
    const execution = await controller.execute(task.id);
    expect(execution.receipt?.principal).toBe("human:dheeraj/agent:claude-code");
  });

  it("records the local principal when the caller declares none", async () => {
    const { controller } = await setup();
    const task = controller.plan(
      TaskRequestSchema.parse({
        goal: "Read a file",
        operation: { kind: "file", action: "read", path: "notes.txt" },
      }),
    );
    const execution = await controller.execute(task.id);
    expect(execution.receipt?.principal).toBe("agent:local");
  });

  it("redacts the declared chain on the receipt as on the task row", async () => {
    const { controller, store } = await setup();
    // Built at run time so no literal here reads as a leaked credential.
    const token = `${"ghp"}_${"A1b2C3d4E5".repeat(4)}`;
    const task = controller.plan(
      TaskRequestSchema.parse({
        goal: "Read system info",
        operation: { kind: "system", action: "info" },
        identity: {
          principal: { kind: "agent", id: "worker password=hunter2hunter2" },
          onBehalfOf: [
            { kind: "human", id: "alice" },
            { kind: "harness", id: token },
          ],
        },
      }),
    );
    const execution = await controller.execute(task.id);
    const stored = store.getReceiptsForTask(task.id);
    for (const text of [JSON.stringify(stored), JSON.stringify(execution.receipt)]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain("hunter2hunter2");
    }
    expect(stored[0]?.principal).toBe("human:alice/harness:[REDACTED_GITHUB_TOKEN]/agent:worker password=[REDACTED]");
    // The same chain the stored task row's identity names.
    expect(stored[0]?.principal).toBe(delegationChain(store.getTask(task.id)!.request.identity!));
    expect(stored[0]?.redactions).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  describe("a write that fails after the adapter returned", () => {
    async function charge(
      execute: () => Promise<Record<string, unknown>>,
      options: { idempotencyKey?: string } = {},
    ) {
      const { controller, store } = await setup({ execute });
      const task = controller.plan(
        TaskRequestSchema.parse({
          goal: "Charge the customer",
          operation: {
            kind: "http",
            action: "request",
            method: "POST",
            url: "http://localhost:9/charges",
          },
          requiredEvidence: [
            { type: "result_equals", path: "success", value: true },
          ],
        }),
        options,
      );
      const approval = { approvalId: task.approval!.approvalId, phrase: task.approval!.phrase! };
      return { controller, store, task, approval };
    }

    it("parks the mutation instead of calling it failed", async () => {
      const execute = vi.fn(async () => ({ success: true }));
      const { controller, store, task, approval } = await charge(execute);
      vi.spyOn(store, "saveTaskExecutionResult").mockImplementationOnce(() => {
        throw new Error("database is locked");
      });
      const charged = vi.spyOn(CircuitBreaker.prototype, "recordFailure");

      const result = await controller.execute(task.id, approval);

      // The charge went through; only the record of it did not.
      expect(result.task.status).toBe("recovery_required");
      expect(result.receipt?.evidence[0]).toMatchObject({ passed: false, inconclusive: true });
      // The target answered, so it is not charged with the failure.
      expect(charged).not.toHaveBeenCalled();
      charged.mockRestore();
      // Retrying the obvious way reconciles rather than charging again.
      await controller.execute(task.id);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("keeps a verified outcome when only its certificate could not be written", async () => {
      const execute = vi.fn(async () => ({ success: true }));
      const { controller, store, task, approval } = await charge(execute);
      vi.spyOn(store, "saveCertificate").mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      const result = await controller.execute(task.id, approval);

      expect(result.task.status).toBe("verified_success");
      expect(store.getTask(task.id)?.status).toBe("verified_success");
      expect(controller.receipts({ taskId: task.id }).receipts).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("settles a mutation that verified and committed its key before a later write failed", async () => {
      const execute = vi.fn(async () => ({ success: true }));
      const { controller, store, task, approval } = await charge(execute, {
        idempotencyKey: "c".repeat(64),
      });
      vi.spyOn(store, "saveReceipt").mockImplementationOnce(() => {
        throw new Error("database is locked");
      });
      expect((await controller.execute(task.id, approval)).task.status).toBe("recovery_required");

      // Its key is committed only once it verified, so with no reconciliation
      // declared it was parked for good.
      const settled = await controller.execute(task.id);

      expect(settled.task.status).toBe("verified_success");
      expect(settled.certificate?.result).toBe("VERIFIED_SUCCESS");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("lists only the receipts that were stored when its outcome failed to commit", async () => {
      const execute = vi.fn(async () => ({ success: true }));
      const { controller, store, task, approval } = await charge(execute, {
        idempotencyKey: "d".repeat(64),
      });
      const save = store.saveTask.bind(store);
      let failed = false;
      vi.spyOn(store, "saveTask").mockImplementation((saved, owner) => {
        if (saved.status === "verified_success" && !failed) {
          failed = true;
          throw new Error("disk full");
        }
        save(saved, owner);
      });

      const parked = await controller.execute(task.id, approval);

      // The live receipt went with the rest of the outcome; the task names
      // only the one that says it failed, and so does its certificate.
      expect(parked.task.status).toBe("recovery_required");
      const { receipts, certificate } = controller.receipts({ taskId: task.id });
      expect(receipts.map((receipt) => receipt.receiptId)).toEqual(store.getTask(task.id)?.receiptIds);
      expect(certificate?.receiptIds).toEqual(store.getTask(task.id)?.receiptIds);
      expect(receipts).toHaveLength(1);
      // Its key was committed on its own all the same, so it settles on it.
      expect((await controller.execute(task.id)).task.status).toBe("verified_success");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("reconciliation", () => {
    /**
     * A charge whose request reached the wire and was never answered, plus the
     * probe that can settle it. The reconciliation URL is written against the
     * idempotency key rather than a response field on purpose: there is no
     * response to read on this path. One predicate per entry of `windows`.
     */
    async function unansweredCharge(
      probe?: EvidenceProbe,
      url = "http://localhost:9/charges/{{idempotencyKey}}",
      plan: { stored?: boolean } = {},
      windows: Array<{ settleMs?: number }> = [{}],
    ) {
      const execute = vi.fn(async () => {
        throw outcomeUnknown("socket hang up");
      });
      const { controller, store } = await setup({ execute }, probe);
      const task = controller.plan(
        TaskRequestSchema.parse({
          goal: "Charge the customer",
          operation: {
            kind: "http",
            action: "request",
            method: "POST",
            url: "http://localhost:9/charges",
            idempotencyKey: "charge-1",
          },
          requiredEvidence: [
            { type: "result_equals", path: "success", value: true },
          ],
          reconciliation: windows.map((window) => ({
            type: "http_resource_matches",
            url,
            method: "GET",
            path: "json.status",
            value: "applied",
            ...window,
          })),
        }),
        plan,
      );
      const parked = await controller.execute(task.id, {
        approvalId: task.approval!.approvalId,
        phrase: task.approval!.phrase!,
      });
      return { controller, store, task, parked, execute };
    }

    it("parks an unanswered mutation instead of claiming it failed", async () => {
      const { parked, controller } = await unansweredCharge();
      expect(parked.task.status).toBe("recovery_required");
      expect(parked.certificate?.result).toBe("RECOVERY_REQUIRED");
      // The receipt must not read as proof the charge did not happen.
      expect(parked.receipt?.evidence[0]).toMatchObject({
        type: "execution_error",
        passed: false,
        inconclusive: true,
      });
      expect(parked.receipt?.executionGuarantee).toBe("reconciliation-required");
      expect(controller.status(parked.task.id).status).toBe("recovery_required");
    });

    it("resolves a parked mutation the provider says did happen", async () => {
      const probe = vi.fn(async () => ({
        status: 200,
        content: JSON.stringify({ status: "applied" }),
      }));
      const { parked, controller, execute } = await unansweredCharge(probe);
      expect(parked.task.status).toBe("recovery_required");

      // Retrying the obvious way must not re-run the adapter: it may already
      // have charged the customer once.
      const settled = await controller.execute(parked.task.id);

      expect(settled.task.status).toBe("verified_success");
      expect(settled.certificate?.result).toBe("VERIFIED_SUCCESS");
      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://localhost:9/charges/charge-1",
        }),
      );
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("marks a parked mutation failed only once the provider denies it after the settle window", async () => {
      const probe = vi.fn(async () => ({
        status: 404,
        content: JSON.stringify({ status: "none" }),
      }));
      const { parked, controller, execute } = await unansweredCharge(probe);
      expect(parked.task.parkedAt).toBeDefined();

      // Asked straight away, a "not found" may be a write the provider does
      // not show yet: no answer, no receipt, and the window keeps its start.
      const settling = await controller.execute(parked.task.id);
      expect(settling.task).toMatchObject({
        status: "recovery_required",
        error: "reconciliation_settling",
        parkedAt: parked.task.parkedAt,
      });
      expect(settling.receipt).toBeUndefined();

      vi.spyOn(Date, "now").mockReturnValue(Date.parse(parked.task.parkedAt!) + 30_000);
      try {
        const settled = await controller.execute(parked.task.id);
        expect(settled.task).toMatchObject({
          status: "failed",
          error: "reconciliation_confirms_effect_not_applied",
        });
        expect(settled.certificate?.result).toBe("FAILED");
      } finally {
        vi.mocked(Date.now).mockRestore();
      }
      expect(probe).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("asks a settling mutation again on the next recovery pass, and settles it after the window", async () => {
      const probe = vi.fn(async () => ({
        status: 404,
        content: JSON.stringify({ status: "none" }),
      }));
      const { parked, controller, execute } = await unansweredCharge(probe);
      expect((await controller.execute(parked.task.id)).task.error).toBe("reconciliation_settling");

      // No caller has to come back: the sweep asks, as it does at startup.
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(parked.task.parkedAt!) + 30_000);
      try {
        expect(await controller.recoverInterrupted()).toMatchObject([
          { id: parked.task.id, status: "failed", error: "reconciliation_confirms_effect_not_applied" },
        ]);
      } finally {
        vi.mocked(Date.now).mockRestore();
      }
      expect(await controller.recoverInterrupted()).toEqual([]);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("measures the settle window from when the provider was asked, not when it answered", async () => {
      const clock = vi.spyOn(Date, "now");
      let parkedAt = 0;
      const probe = vi.fn(async () => {
        // A slow answer, given only after the window is over.
        clock.mockReturnValue(parkedAt + 30_000);
        return { status: 404, content: JSON.stringify({ status: "none" }) };
      });
      try {
        const { parked, controller } = await unansweredCharge(probe);
        parkedAt = Date.parse(parked.task.parkedAt!);
        expect((await controller.execute(parked.task.id)).task).toMatchObject({
          status: "recovery_required",
          error: "reconciliation_settling",
        });
      } finally {
        clock.mockRestore();
      }
    });

    it("holds the longest settle window when several predicates declare one", async () => {
      const probe = vi.fn(async () => ({
        status: 404,
        content: JSON.stringify({ status: "none" }),
      }));
      const { parked, controller } = await unansweredCharge(probe, undefined, {}, [{ settleMs: 0 }, {}]);
      expect((await controller.execute(parked.task.id)).task).toMatchObject({
        status: "recovery_required",
        error: "reconciliation_settling",
      });
    });

    it("measures the window of a task parked without parkedAt from its last write, and keeps it there", async () => {
      const probe = vi.fn(async () => ({
        status: 404,
        content: JSON.stringify({ status: "none" }),
      }));
      const { parked, controller, store } = await unansweredCharge(probe);
      // As an earlier version left it: no parkedAt, last written 20 s ago.
      const earlier = store.getTask(parked.task.id)!;
      delete earlier.parkedAt;
      const lastWrite = new Date(Date.now() - 20_000).toISOString();
      store.saveTask({ ...earlier, updatedAt: lastWrite });
      expect((await controller.execute(parked.task.id)).task).toMatchObject({
        error: "reconciliation_settling",
        parkedAt: lastWrite,
      });

      // Asked again, the window still runs from that write, not this one.
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(lastWrite) + 30_000);
      try {
        expect((await controller.execute(parked.task.id)).task.status).toBe("failed");
      } finally {
        vi.mocked(Date.now).mockRestore();
      }
    });

    it("keeps a parked mutation parked when the provider cannot be reached", async () => {
      const probe = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      });
      const { parked, controller } = await unansweredCharge(probe);

      const settled = await controller.execute(parked.task.id);

      // An unreachable provider did not say no. Anything but `recovery_required`
      // here is the kernel inventing an outcome.
      expect(settled.task).toMatchObject({
        status: "recovery_required",
        error: "reconciliation_inconclusive",
      });
      expect(settled.receipt).toBeUndefined();
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it("keeps a parked mutation parked, named as unanswerable, when its reconciliation URL cannot be completed", async () => {
      const probe = vi.fn(async () => ({
        status: 404,
        content: JSON.stringify({ status: "none" }),
      }));
      // There is no response on this path, so `json.id` never resolves. A
      // workflow step accepted before planning checked for that still runs.
      const { parked, controller, execute } = await unansweredCharge(
        probe,
        "http://localhost:9/charges/{{json.id}}",
        { stored: true },
      );

      const settled = await controller.execute(parked.task.id);

      // Nobody was asked, so nobody said no; and asking again is refused
      // again, which a caller must be able to tell from a provider outage.
      expect(settled.task).toMatchObject({
        status: "recovery_required",
        error: "reconciliation_unanswerable:verification_token_unresolved:json.id",
      });
      expect(probe).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("refuses at plan time a reconciliation URL token the facts before the call cannot fill", async () => {
      await expect(unansweredCharge(undefined, "http://localhost:9/charges/{{json.id}}")).rejects.toThrow(
        "reconciliation_unanswerable:verification_token_unresolved:json.id",
      );
      // The facts it is read against: the task, the URL, the method, the key.
      const { parked } = await unansweredCharge(
        undefined,
        "http://localhost:9/charges/{{idempotencyKey}}?task={{taskId}}&m={{method}}&u={{url}}",
      );
      expect(parked.task.status).toBe("recovery_required");
    });

    it("refuses at plan time a reconciliation verifier this runtime does not have", async () => {
      const { controller } = await setup();
      expect(() =>
        controller.plan(
          TaskRequestSchema.parse({
            goal: "Charge the customer",
            operation: {
              kind: "http",
              action: "request",
              method: "POST",
              url: "http://localhost:9/charges",
            },
            requiredEvidence: [
              { type: "result_equals", path: "success", value: true },
            ],
            reconciliation: [{ type: "custom", verifier: "ledger_row" }],
          }),
        ),
      ).toThrow("evidence_verifier_unavailable:ledger_row");
    });

    it("refuses at plan time a file path no answer can ever come from", async () => {
      const { controller } = await setup();
      const write = (evidence: Record<string, unknown>) =>
        TaskRequestSchema.parse({
          goal: "Write the release flag",
          operation: { kind: "file", action: "write", path: "release.flag", content: "x" },
          ...evidence,
        });
      for (const path of ["../release.flag", ".", "/etc/hosts"]) {
        expect(() => controller.plan(write({ requiredEvidence: [{ type: "file_exists", path }] })), path).toThrow(
          "evidence_path_outside_workspace",
        );
        // Asked, it is refused every time, so the task would stay parked.
        expect(() => controller.plan(write({ reconciliation: [{ type: "file_absent", path }] })), path).toThrow(
          "evidence_path_outside_workspace",
        );
      }
      // By its spelling: a file that is not there yet is a fair question.
      const later = write({ requiredEvidence: [{ type: "file_exists", path: "dist/../out/release.flag" }] });
      expect(controller.plan(later).status).toBe("awaiting_approval");
      // A workflow step accepted before this check is not stopped at.
      const accepted = write({ requiredEvidence: [{ type: "file_exists", path: "." }] });
      expect(controller.plan(accepted, { stored: true }).status).toBe("awaiting_approval");
    });

    it("parks an unanswered mutation that declared no way to settle it", async () => {
      const execute = vi.fn(async () => {
        throw outcomeUnknown("socket hang up");
      });
      const { controller } = await setup({ execute });
      const task = controller.plan(
        TaskRequestSchema.parse({
          goal: "Charge the customer",
          operation: {
            kind: "http",
            action: "request",
            method: "POST",
            url: "http://localhost:9/charges",
          },
          requiredEvidence: [
            { type: "result_equals", path: "success", value: true },
          ],
        }),
      );
      const parked = await controller.execute(task.id, {
        approvalId: task.approval!.approvalId,
        phrase: task.approval!.phrase!,
      });
      expect(parked.task.status).toBe("recovery_required");
      expect(parked.receipt?.executionGuarantee).toBe("at-most-once");

      const settled = await controller.execute(task.id);

      expect(settled.task.error).toBe("reconciliation_not_declared");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("leaves an unanswered read failed, since nothing changed either way", async () => {
      const execute = vi.fn(async () => {
        throw outcomeUnknown("socket hang up");
      });
      const { controller } = await setup({ execute });
      const task = controller.plan(
        TaskRequestSchema.parse({
          goal: "Read the charge",
          operation: {
            kind: "http",
            action: "request",
            method: "GET",
            url: "http://localhost:9/charges/charge-1",
          },
        }),
      );
      expect((await controller.execute(task.id)).task.status).toBe("failed");
    });

    it.each([
      ["settles an interrupted mutation on recovery when it can", 200, { status: "verified_success" }],
      [
        "keeps an interrupted mutation parked on recovery while the provider may not show it yet",
        404,
        { status: "recovery_required", error: "reconciliation_settling" },
      ],
    ])("%s", async (_, status, outcome) => {
      const probe = vi.fn(async () => ({
        status,
        content: JSON.stringify({ status: status === 200 ? "applied" : "none" }),
      }));
      const execute = vi.fn(async () => ({ success: true }));
      const { controller, store } = await setup({ execute }, probe);
      const task = controller.plan(
        TaskRequestSchema.parse({
          goal: "Charge the customer",
          operation: {
            kind: "http",
            action: "request",
            method: "POST",
            url: "http://localhost:9/charges",
            idempotencyKey: "charge-2",
          },
          requiredEvidence: [
            { type: "result_equals", path: "success", value: true },
          ],
          reconciliation: [
            {
              type: "http_resource_matches",
              url: "http://localhost:9/charges/{{idempotencyKey}}",
              method: "GET",
              path: "json.status",
              value: "applied",
            },
          ],
        }),
      );
      const interrupted = store.getTask(task.id)!;
      interrupted.status = "running";
      store.saveTask(interrupted);

      const [recovered] = await controller.recoverInterrupted();

      expect(recovered).toMatchObject({ id: task.id, ...outcome });
      expect(execute).not.toHaveBeenCalled();
    });
  });
});

describe("challenges open per caller (#422)", () => {
  const write = (path: string) =>
    TaskRequestSchema.parse({
      goal: `Write ${path}`,
      operation: { kind: "file", action: "write", path, content: "x" },
      requiredEvidence: [{ type: "file_exists", path }],
    });

  async function capped(maxPendingApprovals: number) {
    const root = await mkdtemp(join(tmpdir(), "melra-controller-cap-"));
    roots.push(root);
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const controller = new TaskController(
      store,
      { ...createDefaultPolicy(root), maxPendingApprovals },
      { execute: async () => ({ success: true }) },
      await Verifier.create(root),
      new PayloadCipher(Buffer.alloc(32, 9)),
    );
    return { controller, store };
  }

  it("refuses a challenge past the cap before anything is written, naming the cap and how to make room", async () => {
    const { controller, store } = await capped(2);
    controller.plan(write("a.txt"));
    controller.plan(write("b.txt"));
    const before = store.listTasks(100);
    expect(() => controller.plan(write("c.txt"))).toThrow(
      /^too_many_pending_approvals: 2 tasks .*\(maxPendingApprovals 2\); plan more once some are approved, denied or cancelled, or their challenges expire$/,
    );
    expect(store.listTasks(100)).toEqual(before);
    // A read asks nobody, and another caller has room of its own.
    expect(controller.plan(TaskRequestSchema.parse({ goal: "Inspect", operation: { kind: "system", action: "info" } })).status).toBe(
      "planned",
    );
    expect(controller.plan(write("c.txt"), { client: "harness:B" }).status).toBe("awaiting_approval");
    expect([controller.pendingApprovals("operator"), controller.pendingApprovals("harness:B")]).toEqual([2, 1]);
  });

  it("counts only a challenge still open: not one cancelled, denied, approved or expired", async () => {
    const { controller, store } = await capped(1);
    controller.cancel(controller.plan(write("a.txt")).id);
    controller.deny(controller.plan(write("b.txt")).id, "operator");
    const approved = controller.plan(write("c.txt"));
    controller.decide(approved.id, controller.approvalView(approved.id).renderDigest, "operator");
    const lapsed = store.getTask(controller.plan(write("d.txt")).id)!;
    store.saveTask({ ...lapsed, approval: { ...lapsed.approval!, expiresAt: new Date(Date.now() - 1_000).toISOString() } });
    expect(controller.pendingApprovals("operator")).toBe(0);
    controller.plan(write("e.txt"));
    expect(() => controller.plan(write("f.txt"))).toThrow("too_many_pending_approvals");
  });
});
