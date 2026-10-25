// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// When a grant is drawn down: whenever the adapter may have done the work,
// whatever the evidence then says of it. Counting an effect that did not
// happen is preferred to a grant funding more than it says.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { outcomeUnknown, TaskRequestSchema, type TaskRequestInput } from "@melra/protocol";
import { createDefaultPolicy, type LocalPolicy } from "@melra/policy-core";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";

const roots: string[] = [];
const stores: SqliteStore[] = [];

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Grant = LocalPolicy["capabilities"][number];

const grant = (id: string, capability: string, rest: Partial<Grant> = {}): Grant => ({
  id,
  capability,
  effects: [capability === "file.read" ? "read" : "mutate"],
  target: "*",
  principal: "*",
  ...rest,
});

/** One write, one read, and $15 a day of refunds. */
const GRANTS = [
  grant("write", "file.write", { maxOperations: 1 }),
  grant("read", "file.read", { maxOperations: 1 }),
  grant("pay", "http.post", { provider: { name: "acme-pay", dailyMax: 1_500 } }),
];

async function setup(capabilities = GRANTS) {
  const root = await mkdtemp(join(tmpdir(), "melra-metering-"));
  roots.push(root);
  await writeFile(join(root, "out.txt"), "written");
  const store = new SqliteStore(":memory:");
  stores.push(store);
  const executor = {
    execute: vi.fn(async (): Promise<Record<string, unknown>> => ({ success: true, path: "out.txt" })),
  };
  const controller = new TaskController(
    store,
    { ...createDefaultPolicy(root), capabilities },
    executor,
    await Verifier.create(root),
    new PayloadCipher(Buffer.alloc(32, 5)),
  );
  return { controller, store, executor };
}

const WRITE = { kind: "file", action: "write", path: "out.txt", content: "written", encoding: "utf8" } as const;
const READ = { kind: "file", action: "read", path: "out.txt", encoding: "utf8" } as const;
const REFUND = {
  kind: "http",
  action: "request",
  method: "POST",
  url: "https://api.example.com/refunds",
  content: "{}",
  spend: { provider: "acme-pay", amount: 1_000, currency: "USD" },
} as const;
/** Evidence the run will not meet, so it ends `partial`. */
const MISSING = [{ type: "file_exists", path: "missing.txt" }] as const;

function request(
  operation: TaskRequestInput["operation"],
  requiredEvidence: TaskRequestInput["requiredEvidence"] = [...MISSING],
  extra: Partial<TaskRequestInput> = {},
) {
  return TaskRequestSchema.parse({ goal: "Spend a grant", operation, requiredEvidence, ...extra });
}

const approve = (task: ReturnType<TaskController["plan"]>) =>
  task.approval === undefined ? undefined : { approvalId: task.approval.approvalId, phrase: task.approval.phrase! };

async function run(controller: TaskController, task: ReturnType<typeof request>) {
  const planned = controller.plan(task);
  return await controller.execute(planned.id, approve(planned));
}

const drawn = (store: SqliteStore, id: string) => store.capabilityUsage(id, new Date(0).toISOString());

describe("capability metering", () => {
  it.each([
    ["change", "write", WRITE],
    ["read", "read", READ],
  ] as const)("spends a one-operation grant on a %s that ends partial", async (_, id, operation) => {
    const { controller, store } = await setup();
    expect((await run(controller, request(operation))).task.status).toBe("partial");
    expect(drawn(store, id).operations).toBe(1);
    const next = controller.plan(request(operation));
    expect(next.status).toBe("policy_blocked");
    expect(next.policyDecision.reason).toBe(`capability_usage_exhausted:${id}`);
  });

  it("draws a partial refund's amount against the provider's daily limit", async () => {
    const { controller, store, executor } = await setup();
    // The far end answered, and not with what the evidence asks for.
    executor.execute.mockResolvedValueOnce({ success: true, status: 200 });
    const evidence = [{ type: "result_equals", path: "status", value: 201 }] as const;
    expect((await run(controller, request(REFUND, [...evidence]))).task.status).toBe("partial");
    expect(drawn(store, "pay").amountInWindow).toBe(1_000);
    expect(controller.plan(request(REFUND, [...evidence])).policyDecision.reason).toBe(
      "capability_daily_limit_exceeded:pay",
    );
  });

  it("charges once a change whose adapter may have run before it failed", async () => {
    const { controller, store, executor } = await setup();
    executor.execute.mockRejectedValueOnce(outcomeUnknown("file_write_timeout"));
    const parked = await run(controller, request(WRITE));
    expect(parked.task.status).toBe("recovery_required");
    expect(drawn(store, "write").operations).toBe(1);
    expect(controller.plan(request(WRITE)).status).toBe("policy_blocked");
  });

  it("charges nothing for an adapter that did not run, and charges one that ran and reported failure", async () => {
    const { controller, store, executor } = await setup();
    // A plain throw is the adapter's word that nothing went out.
    executor.execute.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:443"));
    expect((await run(controller, request(WRITE))).task.status).toBe("failed");
    expect(drawn(store, "write").operations).toBe(0);
    // Returned, so it ran: a command that exited 1, a request answered 500.
    executor.execute.mockResolvedValueOnce({ success: false, exitCode: 1 });
    expect((await run(controller, request(WRITE))).task.status).toBe("failed");
    expect(drawn(store, "write").operations).toBe(1);
  });

  it("charges nothing for a task policy blocks at execution", async () => {
    const { controller, store, executor } = await setup();
    // Both planned while the grant was unspent, and the first spends it.
    const [first, second] = [controller.plan(request(WRITE)), controller.plan(request(WRITE))];
    expect((await controller.execute(first!.id, approve(first!))).task.status).toBe("partial");
    const blocked = await controller.execute(second!.id, approve(second!));
    expect(blocked.task.status).toBe("policy_blocked");
    expect(store.hasCapabilityUse(second!.id)).toBe(false);
    expect(drawn(store, "write").operations).toBe(1);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("charges an unknown outcome once across recovery and its reconcile", async () => {
    const { controller, store, executor } = await setup([
      grant("a", "file.write", { maxOperations: 1 }),
      grant("b", "file.write", { maxOperations: 5 }),
    ]);
    expect((await run(controller, request(WRITE))).task.status).toBe("partial");
    // `a` is spent, so this one draws `b` when its outcome is lost.
    executor.execute.mockRejectedValueOnce(outcomeUnknown("file_write_timeout"));
    const parked = await run(
      controller,
      request(WRITE, [...MISSING], { reconciliation: [{ type: "file_exists", path: "out.txt" }] }),
    );
    expect(parked.task.status).toBe("recovery_required");
    await controller.recoverInterrupted();
    expect((await controller.reconcile(parked.task.id)).task.status).toBe("verified_success");
    expect([drawn(store, "a").operations, drawn(store, "b").operations]).toEqual([1, 1]);
  });

  it.each([
    ["change", "write", WRITE, "recovery_required"],
    ["read", "read", READ, "planned"],
  ] as const)(
    "holds the reservation of a %s whose draw failed to write until recovery draws it",
    async (_, id, operation, status) => {
      const { controller, store } = await setup();
      const record = vi.spyOn(store, "recordCapabilityUse").mockImplementation(() => {
        throw new Error("database is locked");
      });
      await expect(run(controller, request(operation))).rejects.toThrow("database is locked");
      expect(drawn(store, id).operations).toBe(0);
      // Not durable yet, and still not free to fund a second effect.
      expect(controller.plan(request(operation)).status).toBe("policy_blocked");
      record.mockRestore();
      const [recovered] = await controller.recoverInterrupted();
      expect(recovered?.status).toBe(status);
      expect(drawn(store, id).operations).toBe(1);
    },
  );

  it("holds the reservation of a change whose draw was undone with the rest of its outcome", async () => {
    const { controller, store } = await setup();
    const record = store.recordCapabilityUse.bind(store);
    // Written in the outcome's transaction, undone when its receipt fails,
    // and not written again.
    vi.spyOn(store, "recordCapabilityUse")
      .mockImplementationOnce(record)
      .mockImplementation(() => {
        throw new Error("database is locked");
      });
    vi.spyOn(store, "saveReceipt").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await expect(run(controller, request(WRITE))).rejects.toThrow("database is locked");
    expect(drawn(store, "write").operations).toBe(0);
    expect(controller.plan(request(WRITE)).status).toBe("policy_blocked");
  });

  it.each(["running", "verifying"] as const)(
    "charges a read cut off while %s, and its re-run needs room in the grant",
    async (status) => {
      const { controller, store, executor } = await setup();
      const planned = controller.plan(request(READ));
      // The process died with the read in flight, or its answer back.
      store.saveTask({ ...store.getTask(planned.id)!, status });
      const [recovered] = await controller.recoverInterrupted();
      expect(recovered).toMatchObject({ status: "planned", error: "interrupted_read_ready_for_retry" });
      expect(drawn(store, "read").operations).toBe(1);
      expect((await controller.execute(planned.id)).task.status).toBe("policy_blocked");
      expect(executor.execute).not.toHaveBeenCalled();
    },
  );

  it("charges a read whose earlier attempt may have run though its last failed plainly", async () => {
    const { controller, store, executor } = await setup();
    executor.execute
      .mockRejectedValueOnce(outcomeUnknown("http_response_incomplete"))
      .mockRejectedValueOnce(outcomeUnknown("http_response_incomplete"))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:443"));
    expect((await run(controller, request(READ))).task.status).toBe("failed");
    expect(executor.execute).toHaveBeenCalledTimes(3);
    expect(drawn(store, "read").operations).toBe(1);
  });
});
