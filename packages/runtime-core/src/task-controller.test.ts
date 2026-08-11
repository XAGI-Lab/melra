// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskRequestSchema,
  outcomeUnknown,
  type Operation,
} from "@melra/protocol";
import { createDefaultPolicy } from "@melra/policy-core";
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
        goal: "one-time-secret",
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
        phrase: stored.approval.phrase,
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
    store.saveTask(interrupted);

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
      phrase: task.approval!.phrase,
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
      phrase: task.approval!.phrase,
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

  describe("reconciliation", () => {
    /**
     * A charge whose request reached the wire and was never answered, plus the
     * probe that can settle it. The reconciliation URL is written against the
     * idempotency key rather than a response field on purpose: there is no
     * response to read on this path.
     */
    async function unansweredCharge(probe?: EvidenceProbe) {
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
      const parked = await controller.execute(task.id, {
        approvalId: task.approval!.approvalId,
        phrase: task.approval!.phrase,
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

    it("marks a parked mutation failed only once the provider denies it", async () => {
      const probe = vi.fn(async () => ({
        status: 404,
        content: JSON.stringify({ status: "none" }),
      }));
      const { parked, controller } = await unansweredCharge(probe);

      const settled = await controller.execute(parked.task.id);

      expect(settled.task).toMatchObject({
        status: "failed",
        error: "reconciliation_confirms_effect_not_applied",
      });
      expect(settled.certificate?.result).toBe("FAILED");
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
        phrase: task.approval!.phrase,
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

    it("settles an interrupted mutation on recovery when it can", async () => {
      const probe = vi.fn(async () => ({
        status: 200,
        content: JSON.stringify({ status: "applied" }),
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

      expect(recovered).toMatchObject({
        id: task.id,
        status: "verified_success",
      });
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
