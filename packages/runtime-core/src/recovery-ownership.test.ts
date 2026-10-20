// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskRequestSchema,
  outcomeUnknown,
  WorkflowDefinitionSchema,
  type Operation,
  type TaskRecord,
  type TaskRequest,
  type WorkflowRun,
} from "@melra/protocol";
import { createDefaultPolicy, type LocalPolicy } from "@melra/policy-core";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier, type EvidenceProbe } from "@melra/verifier-core";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";
import { WorkflowController } from "./workflow-controller.js";

/**
 * Two processes sharing one MELRA home, modelled as two stores on one database
 * file. Recovery used to treat every running task and every open run as
 * abandoned, so starting a second process (any CLI command) rewrote work the
 * first was still doing: the live task went to recovery_required, and the
 * live process then lost its own commit as a duplicate.
 */
const stores: SqliteStore[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // The test already closed it, standing in for a crash.
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function home() {
  const root = await mkdtemp(join(tmpdir(), "melra-recovery-ownership-"));
  roots.push(root);
  return { root, path: join(root, ".melra", "melra.sqlite") };
}

/** One process: its own connection, verifier and controllers, the shared key. */
async function side(
  at: { root: string; path: string },
  execute: (operation?: Operation) => Promise<Record<string, unknown>> = async () => ({
    success: true,
    stored: true,
  }),
  probe?: EvidenceProbe,
  policy: Partial<LocalPolicy> = {},
) {
  const store = new SqliteStore(at.path);
  stores.push(store);
  const verifier = await Verifier.create(at.root, probe === undefined ? {} : { probe });
  const adapter = vi.fn(execute);
  const cipher = new PayloadCipher(Buffer.alloc(32, 41));
  const tasks = new TaskController(
    store,
    { ...createDefaultPolicy(at.root), ...policy },
    { execute: adapter },
    verifier,
    cipher,
  );
  return { store, verifier, adapter, tasks, workflows: new WorkflowController(store, tasks, cipher) };
}

/** An adapter that reports when it is entered and finishes when told to. */
function held() {
  const entered = gate();
  const release = gate();
  return {
    entered,
    release,
    execute: async () => {
      entered.open();
      await release.opened;
      return { success: true, stored: true };
    },
  };
}

const charge = () =>
  TaskRequestSchema.parse({
    goal: "Charge the customer",
    operation: {
      kind: "http",
      action: "request",
      method: "POST",
      url: "http://localhost:9/charges",
      idempotencyKey: "charge-1",
    },
    requiredEvidence: [{ type: "result_equals", path: "success", value: true }],
    reconciliation: [
      {
        type: "http_resource_matches",
        url: "http://localhost:9/charges/{{idempotencyKey}}",
        method: "GET",
        path: "json.status",
        value: "applied",
      },
    ],
  });

const approve = (task: { approval?: { approvalId: string; phrase?: string | undefined } }) => ({
  approvalId: task.approval!.approvalId,
  phrase: task.approval!.phrase!,
});

describe("task recovery across processes", () => {
  it("leaves a live process's running mutation alone", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const probe = vi.fn(async () => ({ status: 200, content: JSON.stringify({ status: "applied" }) }));
    const b = await side(at, undefined, probe);
    const task = a.tasks.plan(charge());
    const running = a.tasks.execute(task.id, approve(task));
    await adapter.entered.opened;

    expect(await b.tasks.recoverInterrupted()).toEqual([]);
    expect(b.store.getTask(task.id)?.status).toBe("running");
    expect(b.tasks.receipts({ taskId: task.id }).receipts).toHaveLength(0);
    expect(probe).not.toHaveBeenCalled();

    adapter.release.open();
    const finished = await running;
    expect(finished.task.status).toBe("verified_success");
    expect(a.tasks.receipts({ taskId: task.id }).receipts).toHaveLength(1);
  });

  it("does not settle a live process's verification for it", async () => {
    const at = await home();
    const a = await side(at);
    const b = await side(at);
    const entered = gate();
    const release = gate();
    const verify = a.verifier.verify.bind(a.verifier);
    vi.spyOn(a.verifier, "verify").mockImplementationOnce(async (...args) => {
      entered.open();
      await release.opened;
      return await verify(...args);
    });
    const key = "c".repeat(64);
    const task = a.tasks.plan(
      TaskRequestSchema.parse({
        goal: "Write the report",
        operation: { kind: "file", action: "write", path: "report.txt", content: "done" },
        requiredEvidence: [{ type: "file_exists", path: "report.txt" }],
      }),
      { idempotencyKey: key, attempt: 1 },
    );
    const running = a.tasks.execute(task.id, approve(task));
    await entered.opened;
    // The evidence is already there, which is what made the second process
    // resolve the task itself and commit the key out from under the first.
    await writeFile(join(at.root, "report.txt"), "done");

    expect(await b.tasks.recoverInterrupted()).toEqual([]);
    expect(b.store.getTask(task.id)?.status).toBe("verifying");
    expect(b.store.getIdempotencyCommit(key)).toBeUndefined();

    release.open();
    expect((await running).task.status).toBe("verified_success");
    expect(a.store.getIdempotencyCommit(key)?.taskId).toBe(task.id);
  });

  it("recovers a task the moment its process is gone", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const b = await side(at);
    const task = a.tasks.plan(
      TaskRequestSchema.parse({
        goal: "Write the report",
        operation: { kind: "file", action: "write", path: "report.txt", content: "done" },
        requiredEvidence: [{ type: "file_exists", path: "report.txt" }],
      }),
    );
    void a.tasks.execute(task.id, approve(task)).catch(() => undefined);
    await adapter.entered.opened;
    expect(await b.tasks.recoverInterrupted()).toEqual([]);

    a.store.close();
    const [recovered] = await b.tasks.recoverInterrupted();
    expect(recovered).toMatchObject({ id: task.id, status: "recovery_required" });
    expect(a.adapter).toHaveBeenCalledTimes(1);
    expect(b.adapter).not.toHaveBeenCalled();
  });

  it("lets exactly one of two recoverers settle an abandoned task", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const probe = vi.fn(async () => ({ status: 200, content: JSON.stringify({ status: "applied" }) }));
    const b = await side(at, undefined, probe);
    const c = await side(at, undefined, probe);
    const task = a.tasks.plan(charge());
    void a.tasks.execute(task.id, approve(task)).catch(() => undefined);
    await adapter.entered.opened;
    a.store.close();
    // Two processes starting together both list the task before either acts.
    const listed = c.store.listInterruptedTasks();
    vi.spyOn(c.store, "listInterruptedTasks").mockReturnValue(listed);

    const fromB = await b.tasks.recoverInterrupted();
    const fromC = await c.tasks.recoverInterrupted();
    expect([...fromB, ...fromC].map((recovered) => recovered.status)).toEqual(["verified_success"]);
    expect(c.store.getTask(task.id)?.status).toBe("verified_success");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(b.tasks.receipts({ taskId: task.id }).receipts).toHaveLength(1);
  });
});

describe("task recovery that does not finish", () => {
  it("retries a task whose recovery failed after claiming it", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const b = await side(at);
    const task = a.tasks.plan(put("ledger"));
    void a.tasks.execute(task.id, approve(task)).catch(() => undefined);
    await adapter.entered.opened;
    a.store.close();

    vi.spyOn(b.store, "saveTask").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await expect(b.tasks.recoverInterrupted()).rejects.toThrow("database is locked");
    // The failed claim is given back, so the next pass, here or anywhere, retries it.
    expect(b.store.getTask(task.id)?.status).toBe("running");
    const [recovered] = await b.tasks.recoverInterrupted();
    expect(recovered).toMatchObject({ id: task.id, status: "recovery_required" });
  });

  it("does not let one task it cannot recover hold up the others", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const b = await side(at);
    const [stuck, fine] = [a.tasks.plan(put("stuck")), a.tasks.plan(put("fine"))];
    void a.tasks.execute(stuck.id, approve(stuck)).catch(() => undefined);
    await adapter.entered.opened;
    void a.tasks.execute(fine.id, approve(fine)).catch(() => undefined);
    await vi.waitFor(() => expect(a.adapter).toHaveBeenCalledTimes(2));
    a.store.close();
    // Unreadable however often it is retried: listed first, failing first.
    b.store.deleteTaskPayload(stuck.id);

    for (let pass = 0; pass < 2; pass += 1) {
      await expect(b.tasks.recoverInterrupted()).rejects.toThrow("task_payload_not_found");
    }
    expect(b.store.getTask(fine.id)?.status).toBe("recovery_required");
  });

  it("does not take a task another controller on the same store is running", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const task = a.tasks.plan(put("ledger"));
    const running = a.tasks.execute(task.id, approve(task));
    await adapter.entered.opened;
    // Ownership belongs to the store, so whatever else uses it must see this.
    const other = new TaskController(
      a.store,
      createDefaultPolicy(at.root),
      { execute: async () => ({ success: true, stored: true }) },
      a.verifier,
      new PayloadCipher(Buffer.alloc(32, 41)),
    );
    expect(await other.recoverInterrupted()).toEqual([]);
    adapter.release.open();
    expect((await running).task.status).toBe("verified_success");
  });

  it("recovers its own task whose last writes failed, without a restart", async () => {
    const at = await home();
    const a = await side(at);
    const b = await side(at);
    const task = a.tasks.plan(put("ledger"));
    const receipts = vi.spyOn(a.store, "saveReceipt").mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(a.tasks.execute(task.id, approve(task))).rejects.toThrow("disk full");
    receipts.mockRestore();
    expect(["running", "verifying"]).toContain(a.store.getTask(task.id)?.status);

    // A live process owns it, so a peer leaves it; the owner does not.
    expect(await b.tasks.recoverInterrupted()).toEqual([]);
    const [recovered] = await a.tasks.recoverInterrupted();
    expect(recovered).toMatchObject({ id: task.id, status: "recovery_required" });
  });
});

describe("starting and denying a task across processes", () => {
  // `melra approve --deny` and the console deny in one process while the
  // agent's server executes in another: whichever moves the task first wins,
  // and the other says so instead of reporting what did not happen.
  it("lets exactly one of a deny and an execute, or of two executes, win", async () => {
    const at = await home();
    const a = await side(at);
    const b = await side(at);
    /** Runs `between` after this store's next read of a task, before its caller writes. */
    const afterRead = (store: SqliteStore, between: () => void) => {
      const read = store.getTask.bind(store);
      vi.spyOn(store, "getTask").mockImplementationOnce((id) => {
        const task = read(id);
        between();
        return task;
      });
    };

    // The deny lands after the execute read the task.
    const denied = a.tasks.plan(charge());
    let cancelled: TaskRecord | undefined;
    afterRead(a.store, () => (cancelled = b.tasks.cancel(denied.id)));
    await expect(a.tasks.execute(denied.id, approve(denied))).rejects.toThrow("task_not_executable:cancelled");
    expect(cancelled?.status).toBe("cancelled");
    expect(a.adapter).not.toHaveBeenCalled();

    // The execute lands after the deny read the task.
    const started = a.tasks.plan(charge());
    let executing: ReturnType<TaskController["execute"]> | undefined;
    afterRead(b.store, () => (executing = a.tasks.execute(started.id, approve(started))));
    expect(b.tasks.cancel(started.id).status).toBe("running");
    expect((await executing!).task.status).toBe("verified_success");
    expect(a.adapter).toHaveBeenCalledTimes(1);

    // Two executes, one in each process.
    const twice = a.tasks.plan(charge());
    afterRead(a.store, () => (executing = b.tasks.execute(twice.id, approve(twice))));
    await expect(a.tasks.execute(twice.id, approve(twice))).rejects.toThrow("task_not_executable:running");
    expect((await executing!).task.status).toBe("verified_success");
    expect(a.adapter).toHaveBeenCalledTimes(1);
    expect(b.adapter).toHaveBeenCalledTimes(1);
  });

  it("does not ask a step's expired challenge again beside an execute that beat its cancel", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at);
    const b = await side(at, adapter.execute);
    const run = a.workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Expiring",
        nodes: [{ id: "charge", type: "operation", request: put("charge") }],
      }),
    );
    const waiting = (await a.workflows.advance(run.id)).run;
    const first = waiting.nodes.charge!.taskIds[0]!;
    const expiresAt = Date.parse(waiting.nodes.charge!.approval!.expiresAt);
    // The agent's melra_execute in B starts the step's task with the phrase
    // after A's advance read it waiting, and A then finds the challenge expired.
    let started: ReturnType<TaskController["execute"]> | undefined;
    const decision = a.tasks.approvalDecision.bind(a.tasks);
    vi.spyOn(a.tasks, "approvalDecision").mockImplementationOnce((task) => {
      started = b.tasks.execute(first, approvalsFor(waiting)[0]);
      const now = Date.now.bind(Date);
      vi.spyOn(Date, "now").mockImplementation(() => Math.max(now(), expiresAt + 1));
      return decision(task);
    });
    const asked = (await a.workflows.advance(run.id)).run;
    vi.mocked(Date.now).mockRestore();
    // Asked again beside the running task, approving the second ran the charge twice.
    expect(asked.nodes.charge).toMatchObject({ status: "recovery_required", taskIds: [first] });
    adapter.release.open();
    expect((await started!).task.status).toBe("verified_success");
    const settled = (await a.workflows.advance(run.id)).run;
    expect(settled.nodes.charge).toEqual({ status: "verified_complete", taskIds: [first] });
    expect(a.adapter.mock.calls.length + b.adapter.mock.calls.length).toBe(1);
  });
});

describe("reconciling one task in two processes", () => {
  // Two melra_execute calls, or the sweep's recovery beside an agent's
  // execute, ask the provider about one parked task: the first to settle it
  // stands, and the other writes nothing.
  it.each([
    ["is not reached", { status: 503, content: "" }],
    ["says it never happened", { status: 404, content: JSON.stringify({ status: "none" }) }],
  ])("keeps a peer's verified settle when its own provider %s", async (_, answer) => {
    const at = await home();
    const asked = gate();
    const answered = gate();
    const a = await side(
      at,
      async () => {
        throw outcomeUnknown("socket hang up");
      },
      vi.fn(async () => {
        asked.open();
        await answered.opened;
        return answer;
      }),
    );
    const b = await side(at, undefined, vi.fn(async () => ({ status: 200, content: JSON.stringify({ status: "applied" }) })));
    const task = a.tasks.plan(charge());
    expect((await a.tasks.execute(task.id, approve(task))).task.status).toBe("recovery_required");

    const slow = a.tasks.execute(task.id);
    await asked.opened;
    const settled = (await b.tasks.execute(task.id)).task;
    expect(settled.status).toBe("verified_success");
    answered.open();
    // Written over the peer's settle: parked again or failed, the peer's
    // receipt dropped from the task, and a failed one's receipt in its place.
    expect((await slow).task).toEqual(b.store.getTask(task.id));
    expect(b.store.getTask(task.id)).toMatchObject({ status: "verified_success", receiptIds: settled.receiptIds });
    expect(b.tasks.receipts({ taskId: task.id })).toMatchObject({
      receipts: settled.receiptIds.map((receiptId) => ({ receiptId })),
      certificate: { result: "VERIFIED_SUCCESS" },
    });
  });
});

const definitionId = "33333333-3333-4333-8333-333333333333";

const put = (key: string): TaskRequest =>
  TaskRequestSchema.parse({
    goal: `Put ${key}`,
    operation: { kind: "memory", action: "put", key, value: key },
    requiredEvidence: [{ type: "result_equals", path: "stored", value: true }],
  });

const approvalsFor = (run: WorkflowRun) =>
  Object.values(run.nodes).flatMap((node) =>
    node.approval === undefined ? [] : [{ approvalId: node.approval.approvalId, phrase: node.approval.phrase! }],
  );

/** A one-step workflow whose step is in A's adapter when this returns. */
async function midFlight(a: Awaited<ReturnType<typeof side>>, adapter: ReturnType<typeof held>) {
  const run = a.workflows.plan(
    WorkflowDefinitionSchema.parse({
      schemaVersion: "1.0.0",
      id: definitionId,
      version: 1,
      name: "Ownership",
      nodes: [{ id: "write", type: "operation", request: put("write") }],
    }),
  );
  const waiting = (await a.workflows.advance(run.id)).run;
  const advancing = a.workflows.advance(run.id, approvalsFor(waiting));
  advancing.catch(() => undefined);
  await adapter.entered.opened;
  return { id: run.id, advancing };
}

const footprint = (store: SqliteStore, id: string) => ({
  version: store.getWorkflowRun(id)?.stateVersion,
  events: store.listWorkflowEvents(id).length,
});

function expireLease(store: SqliteStore, id: string): void {
  store.database
    .prepare("UPDATE workflow_leases SET expires_at = ? WHERE workflow_id = ?")
    .run(new Date(Date.now() - 1_000).toISOString(), id);
}

/** inspect, then a branch of two steps: one that needs approval, one that does not. */
const twoStepBranch = () =>
  WorkflowDefinitionSchema.parse({
    schemaVersion: "1.0.0",
    id: definitionId,
    version: 1,
    name: "Two-step branch",
    nodes: [
      {
        id: "inspect",
        type: "operation",
        request: TaskRequestSchema.parse({ goal: "Inspect", operation: { kind: "system", action: "info" } }),
      },
      {
        id: "branch",
        type: "condition",
        dependsOn: ["inspect"],
        sourceNodeId: "inspect",
        predicate: { type: "result_equals", path: "success", value: true },
        whenTrue: [
          put("first"),
          TaskRequestSchema.parse({ goal: "Inspect again", operation: { kind: "system", action: "info" } }),
        ],
        whenFalse: [],
      },
    ],
  });

describe("workflow recovery across processes", () => {
  it("leaves a run another process is advancing alone", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const b = await side(at);
    const { id, advancing } = await midFlight(a, adapter);
    const before = footprint(b.store, id);

    expect(await b.workflows.recoverInterrupted()).toEqual([]);
    expect(await b.workflows.recoverInterrupted({ abandonedOnly: true })).toEqual([]);
    expect(footprint(b.store, id)).toEqual(before);

    adapter.release.open();
    expect((await advancing).run.status).toBe("verified_complete");
  });

  it("leaves a run this process is advancing alone", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const { id, advancing } = await midFlight(a, adapter);
    const before = footprint(a.store, id);

    expect(await a.workflows.recoverInterrupted()).toEqual([]);
    expect(await a.workflows.recoverInterrupted({ abandonedOnly: true })).toEqual([]);
    expect(footprint(a.store, id)).toEqual(before);

    adapter.release.open();
    expect((await advancing).run.status).toBe("verified_complete");
  });

  it("leaves a run this process is still advancing even once its lease lapsed", async () => {
    const at = await home();
    const a = await side(at);
    const done = gate();
    const release = gate();
    // The task has finished; the advance has not, as across a laptop's sleep.
    const execute = a.tasks.execute.bind(a.tasks);
    vi.spyOn(a.tasks, "execute").mockImplementationOnce(async (...args) => {
      const result = await execute(...args);
      done.open();
      await release.opened;
      return result;
    });
    const run = a.workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Ownership",
        nodes: [{ id: "write", type: "operation", request: put("write") }],
      }),
    );
    const waiting = (await a.workflows.advance(run.id)).run;
    const advancing = a.workflows.advance(run.id, approvalsFor(waiting));
    await done.opened;
    expireLease(a.store, run.id);
    const before = footprint(a.store, run.id);

    expect(await a.workflows.recoverInterrupted({ abandonedOnly: true })).toEqual([]);
    expect(footprint(a.store, run.id)).toEqual(before);
    release.open();
    expect((await advancing).run.status).toBe("verified_complete");
  });

  it("does not start the next branch step after losing its workflow lease", async () => {
    const at = await home();
    const a = await side(at);
    const nextAdapter = held();
    const b = await side(at, nextAdapter.execute);
    const firstDone = gate();
    const releaseFirst = gate();
    const run = a.workflows.plan(twoStepBranch());

    try {
      await a.workflows.advance(run.id);
      const waiting = (await a.workflows.advance(run.id)).run;
      const execute = a.tasks.execute.bind(a.tasks);
      vi.spyOn(a.tasks, "execute").mockImplementationOnce(async (...args) => {
        const result = await execute(...args);
        firstDone.open();
        await releaseFirst.opened;
        return result;
      });
      const advancing = a.workflows.advance(run.id, approvalsFor(waiting));
      void advancing.catch(() => undefined);
      await firstDone.opened;
      expireLease(a.store, run.id);

      // B recovers the run and runs step 2, which needs no approval, itself.
      const bAdvancing = b.workflows.advance(run.id);
      void bAdvancing.catch(() => undefined);
      await nextAdapter.entered.opened;

      releaseFirst.open();
      await expect(advancing).rejects.toThrow("workflow_lease_lost");
      expect(a.adapter).toHaveBeenCalledTimes(2);

      nextAdapter.release.open();
      expect((await bAdvancing).run.status).toBe("verified_complete");
      expect(b.adapter).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirst.open();
      nextAdapter.release.open();
    }
  });

  it("keeps a lapsed lease nobody took when it starts a step, so a takeover after that is refused", async () => {
    const at = await home();
    const second = held();
    let calls = 0;
    const a = await side(at, async () => (++calls === 3 ? second.execute() : { success: true, stored: true }));
    const b = await side(at);
    const run = a.workflows.plan(twoStepBranch());
    await a.workflows.advance(run.id);
    const waiting = (await a.workflows.advance(run.id)).run;
    // Step 1 finishes and the advance stalls past its lease (a laptop's
    // sleep), with nobody having taken the lease yet.
    const execute = a.tasks.execute.bind(a.tasks);
    vi.spyOn(a.tasks, "execute").mockImplementationOnce(async (...args) => {
      const result = await execute(...args);
      expireLease(a.store, run.id);
      return result;
    });
    // B's repair pass, one synchronous block in another process, lands after
    // A's lease check for step 2 and before step 2's task is written.
    const recovery = b.workflows as unknown as {
      repairRuns(abandonedOnly: boolean, tasks: Map<string, unknown>, runs: Map<string, unknown>): WorkflowRun[];
    };
    let repaired: WorkflowRun[] | undefined;
    const plan = a.tasks.plan.bind(a.tasks);
    vi.spyOn(a.tasks, "plan").mockImplementation((request, options) => {
      if (request.goal === "Inspect again") repaired ??= recovery.repairRuns(true, new Map(), new Map());
      return plan(request, options);
    });

    try {
      const advancing = a.workflows.advance(run.id, approvalsFor(waiting)).then(
        ({ run }) => run.status,
        (error: Error) => error.message,
      );
      await second.entered.opened;
      const resumed = await b.workflows.advance(run.id).then(
        ({ run }) => run.status,
        (error: Error) => error.message,
      );
      second.release.open();

      // Step 2 ran once, in A. B neither took the run over nor ran it again.
      expect(b.adapter).not.toHaveBeenCalled();
      expect(repaired).toEqual([]);
      expect(resumed).toBe("workflow_lease_held");
      expect(await advancing).toBe("verified_complete");
      expect(a.adapter).toHaveBeenCalledTimes(3);
    } finally {
      second.release.open();
    }
  });

  it("fails with workflow_lease_lost when the run was taken over after its last step", async () => {
    const at = await home();
    const a = await side(at);
    const b = await side(at);
    const run = a.workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Ownership",
        nodes: [
          {
            id: "inspect",
            type: "operation",
            request: TaskRequestSchema.parse({ goal: "Inspect", operation: { kind: "system", action: "info" } }),
          },
        ],
      }),
    );
    const recovery = b.workflows as unknown as {
      repairRuns(abandonedOnly: boolean, tasks: Map<string, unknown>, runs: Map<string, unknown>): WorkflowRun[];
    };
    let repaired: WorkflowRun[] = [];
    // The step finishes, A stalls past its lease, and B's repair pass takes
    // the run over and commits the step before A gets to commit it.
    const execute = a.tasks.execute.bind(a.tasks);
    vi.spyOn(a.tasks, "execute").mockImplementationOnce(async (...args) => {
      const result = await execute(...args);
      expireLease(a.store, run.id);
      repaired = recovery.repairRuns(true, new Map(), new Map());
      return result;
    });

    await expect(a.workflows.advance(run.id)).rejects.toThrow("workflow_lease_lost");
    expect(repaired.map(({ id }) => id)).toEqual([run.id]);
    expect(a.store.getWorkflowRun(run.id)?.status).toBe("verified_complete");
    expect(a.adapter).toHaveBeenCalledTimes(1);
  });

  it("refuses a halted run without disturbing the lease a dead advance left", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const b = await side(at);
    const { id } = await midFlight(a, adapter);
    a.store.close();
    expireLease(b.store, id);
    b.workflows.pause(id);

    await expect(b.workflows.advance(id)).rejects.toThrow("workflow_halted:paused");
    expect(b.store.getWorkflowLease(id)).toBeDefined();
    b.workflows.resume(id);
    const after = (await b.workflows.advance(id)).run;
    expect(after.nodes.write?.status).toBe("recovery_required");
    expect(a.adapter).toHaveBeenCalledTimes(1);
    expect(b.adapter).not.toHaveBeenCalled();
  });

  it("repairs runs even when a task cannot be recovered", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const b = await side(at);
    const stuck = a.tasks.plan(put("stuck"));
    void a.tasks.execute(stuck.id, approve(stuck)).catch(() => undefined);
    await adapter.entered.opened;
    const { id } = await midFlight(a, adapter);
    a.store.close();
    expireLease(b.store, id);
    b.store.deleteTaskPayload(stuck.id);

    await expect(b.workflows.recoverInterrupted({ abandonedOnly: true })).rejects.toThrow(
      "task_payload_not_found",
    );
    expect(b.workflows.status(id).nodes.write?.status).toBe("recovery_required");
    expect(b.store.getWorkflowLease(id)).toBeUndefined();
  });

  it("keeps a dead advance's lease when repairing its run fails", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const b = await side(at);
    const { id } = await midFlight(a, adapter);
    a.store.close();
    expireLease(b.store, id);
    vi.spyOn(b.store, "transitionWorkflow").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });

    await expect(b.workflows.recoverInterrupted({ abandonedOnly: true })).rejects.toThrow(
      "database is locked",
    );
    // Still marked: without it the next advance would take the run over from
    // a projection that predates the dead advance's task.
    expect(b.store.expiredWorkflowLeases(new Date().toISOString())).toContain(id);
    await expect(b.workflows.advance(id)).resolves.toBeDefined();
    expect(b.workflows.status(id).nodes.write?.status).toBe("recovery_required");
    expect(b.adapter).not.toHaveBeenCalled();
  });

  it("keeps the lease when an operator pauses the run in the middle of its repair", async () => {
    // Unsafe-local mode plans and runs a step in one advance, so a projection
    // read from before the dead advance's task would plan that task again.
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute, undefined, { unhinged: true });
    const b = await side(at, undefined, undefined, { unhinged: true });
    const run = a.workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Ownership",
        nodes: [{ id: "write", type: "operation", request: put("write") }],
      }),
    );
    void a.workflows.advance(run.id).catch(() => undefined);
    await adapter.entered.opened;
    a.store.close();
    expireLease(b.store, run.id);
    // The pause lands after the pass listed the run and before it took the lease.
    const take = b.store.takeWorkflowLease.bind(b.store);
    vi.spyOn(b.store, "takeWorkflowLease").mockImplementationOnce((...args) => {
      b.workflows.pause(run.id);
      return take(...args);
    });

    expect(await b.workflows.recoverInterrupted({ abandonedOnly: true })).toEqual([]);
    expect(b.store.getWorkflowLease(run.id)).toBeDefined();
    b.workflows.resume(run.id);
    const after = (await b.workflows.advance(run.id)).run;
    expect(after.nodes.write?.status).toBe("recovery_required");
    expect(b.adapter).not.toHaveBeenCalled();
  });

  it("leaves no lease on a run another process repaired while this one looked", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const b = await side(at);
    const { id } = await midFlight(a, adapter);
    a.store.close();
    expireLease(b.store, id);
    // Between this pass's listing and its lease, a peer repairs the run and
    // releases: the run moves on and no lease is left.
    const take = b.store.takeWorkflowLease.bind(b.store);
    vi.spyOn(b.store, "takeWorkflowLease").mockImplementationOnce((...args) => {
      b.workflows.pause(id);
      b.workflows.resume(id);
      b.store.database.prepare("DELETE FROM workflow_leases WHERE workflow_id = ?").run(id);
      return take(...args);
    });

    expect(await b.workflows.recoverInterrupted({ abandonedOnly: true })).toEqual([]);
    // Marked again, peers would take turns repairing it on every sweep.
    expect(b.store.getWorkflowLease(id)).toBeUndefined();
  });

  it("reports its own run's failure, not another's, when its repair fails", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const b = await side(at);
    const stuck = a.tasks.plan(put("stuck"));
    void a.tasks.execute(stuck.id, approve(stuck)).catch(() => undefined);
    await adapter.entered.opened;
    const { id } = await midFlight(a, adapter);
    a.store.close();
    expireLease(b.store, id);
    b.store.deleteTaskPayload(stuck.id);
    vi.spyOn(b.store, "transitionWorkflow").mockImplementationOnce(() => {
      throw new Error("this run's own repair failed");
    });

    await expect(b.workflows.advance(id)).rejects.toThrow("this run's own repair failed");
    // The unrelated task still cannot be recovered; this run no longer cares.
    expect((await b.workflows.advance(id)).run.nodes.write?.status).toBe("recovery_required");
  });

  it("tells an advance in one process why a peer could not recover its task", async () => {
    const at = await home();
    const adapter = held();
    const dead = await side(at, adapter.execute);
    const sweeper = await side(at);
    const b = await side(at);
    const { id } = await midFlight(dead, adapter);
    dead.store.close();
    expireLease(b.store, id);
    b.store.deleteTaskPayload(b.workflows.status(id).nodes.write!.taskIds[0]!);
    // A live peer's sweep meets the failure first.
    await expect(sweeper.workflows.recoverInterrupted({ abandonedOnly: true })).rejects.toThrow(
      "task_payload_not_found",
    );

    await expect(b.workflows.advance(id)).rejects.toThrow("task_payload_not_found");
  });

  it("reports why its own task cannot be recovered rather than calling it contention", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const b = await side(at);
    const { id } = await midFlight(a, adapter);
    a.store.close();
    expireLease(b.store, id);
    b.store.deleteTaskPayload(b.workflows.status(id).nodes.write!.taskIds[0]!);

    await expect(b.workflows.advance(id)).rejects.toThrow("task_payload_not_found");
  });

  it("reports why its own run's repair failed rather than calling it contention", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const b = await side(at);
    const { id } = await midFlight(a, adapter);
    a.store.close();
    expireLease(b.store, id);
    vi.spyOn(b.store, "transitionWorkflow").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });

    await expect(b.workflows.advance(id)).rejects.toThrow("database is locked");
    expect((await b.workflows.advance(id)).run.nodes.write?.status).toBe("recovery_required");
  });

  it("does not run a compensation again that a dead unwind had started", async () => {
    // a verifies, b fails while its sibling s is still running, and the
    // process dies. The next process runs s again, repairs the run to failed
    // and starts undoing a, then dies inside the compensation. s is a read, so
    // recovery can settle it by running it again: an interrupted mutation's
    // outcome is unknown, and the run would halt rather than unwind (#270).
    // Unsafe-local mode, so a compensation needs no approval and is planned
    // and run in one advance.
    const at = await home();
    const key = (operation?: Operation) => (operation as { key?: string } | undefined)?.key;
    const look = TaskRequestSchema.parse({
      goal: "Look for s",
      operation: { kind: "memory", action: "search", query: "s" },
    });
    const sibling = gate();
    const first = await side(
      at,
      async (operation) => {
        if (key(operation) === "b") return { success: false, stored: false };
        if (operation?.kind === "memory" && operation.action === "search") {
          sibling.open();
          await new Promise(() => undefined);
        }
        return { success: true, stored: true };
      },
      undefined,
      { unhinged: true },
    );
    const run = first.workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Rollback",
        nodes: [
          { id: "a", type: "operation", request: put("a") },
          { id: "b", type: "operation", request: put("b"), dependsOn: ["a"] },
          { id: "s", type: "operation", request: look, dependsOn: ["a"] },
          { id: "undo-a", type: "compensation", forNodeId: "a", request: put("undo-a") },
        ],
      }),
    );
    await first.workflows.advance(run.id);
    void first.workflows.advance(run.id).catch(() => undefined);
    await sibling.opened;
    // b has failed; only s is still running when the process dies.
    await vi.waitFor(() => expect(first.store.listInterruptedTasks()).toHaveLength(1));
    first.store.close();

    const undoing = gate();
    const second = await side(
      at,
      async (operation) => {
        if (key(operation) === "undo-a") {
          undoing.open();
          await new Promise(() => undefined);
        }
        return { success: true, stored: true };
      },
      undefined,
      { unhinged: true },
    );
    expireLease(second.store, run.id);
    void second.workflows.advance(run.id).catch(() => undefined);
    await undoing.opened;
    expect(second.workflows.status(run.id).status).toBe("failed");
    second.store.close();

    const third = await side(at, undefined, undefined, { unhinged: true });
    expireLease(third.store, run.id);
    await third.workflows.recoverInterrupted();
    const after = (await third.workflows.advance(run.id)).run;
    expect(after.nodes["undo-a"]?.status).toBe("recovery_required");
    expect(third.adapter).not.toHaveBeenCalled();
  });

  it("halts rather than unwind when a failed step's sibling was a mutation interrupted mid-run", async () => {
    // b fails while its sibling s, a mutation, is still running, and the
    // process dies. s's effect may have happened: the next process must not
    // undo a, which it may depend on, but halt for an operator (#270).
    const at = await home();
    const key = (operation?: Operation) => (operation as { key?: string } | undefined)?.key;
    const sibling = gate();
    const first = await side(
      at,
      async (operation) => {
        if (key(operation) === "b") return { success: false, stored: false };
        if (key(operation) === "s") {
          sibling.open();
          await new Promise(() => undefined);
        }
        return { success: true, stored: true };
      },
      undefined,
      { unhinged: true },
    );
    const run = first.workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Rollback",
        nodes: [
          { id: "a", type: "operation", request: put("a") },
          { id: "b", type: "operation", request: put("b"), dependsOn: ["a"] },
          { id: "s", type: "operation", request: put("s"), dependsOn: ["a"] },
          { id: "undo-a", type: "compensation", forNodeId: "a", request: put("undo-a") },
        ],
      }),
    );
    await first.workflows.advance(run.id);
    void first.workflows.advance(run.id).catch(() => undefined);
    await sibling.opened;
    await vi.waitFor(() => expect(first.store.listInterruptedTasks()).toHaveLength(1));
    first.store.close();

    const second = await side(at, undefined, undefined, { unhinged: true });
    expireLease(second.store, run.id);
    const after = (await second.workflows.advance(run.id)).run;
    expect(after.status).toBe("recovery_required");
    expect(after.nodes.s?.status).toBe("recovery_required");
    expect(after.nodes["undo-a"]?.status).toBe("pending");
    expect(second.adapter).not.toHaveBeenCalled();
  });

  it("keeps a failed run failed when it repairs it", async () => {
    // q verified; p's branches: one failed, one still waiting for approval.
    // Live, p counts as failed and the run unwinds. A repair that ranked p's
    // tasks its own way reopened the waiting branch on a half-undone run.
    const at = await home();
    const execute = async (operation?: Operation) =>
      operation?.kind === "memory" && operation.action === "search"
        ? { success: true, found: false }
        : { success: true, stored: true };
    const a = await side(at, execute);
    const look = TaskRequestSchema.parse({
      goal: "Find x",
      operation: { kind: "memory", action: "search", query: "x" },
      requiredEvidence: [{ type: "result_equals", path: "found", value: true }],
    });
    const run = a.workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Mixed",
        nodes: [
          { id: "q", type: "operation", request: put("q") },
          { id: "p", type: "parallel", dependsOn: ["q"], branches: [[look], [put("p2")]] },
          { id: "undo-q", type: "compensation", forNodeId: "q", request: put("undo-q") },
        ],
      }),
    );
    let current = (await a.workflows.advance(run.id)).run;
    current = (await a.workflows.advance(run.id, approvalsFor(current))).run;
    current = (await a.workflows.advance(run.id)).run;
    expect(current.status).toBe("failed");
    // An advance on it died without changing anything; its lease lapsed.
    a.store.database
      .prepare("INSERT INTO workflow_leases(workflow_id, owner, acquired_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(run.id, "dead", new Date(0).toISOString(), new Date(Date.now() - 1_000).toISOString());
    const b = await side(at, execute);
    const swept = await b.workflows.recoverInterrupted({ abandonedOnly: true });
    expect(swept.map((repairedRun) => repairedRun.id)).toEqual([run.id]);
    const repaired = b.workflows.status(run.id);
    expect(repaired.status).toBe("failed");
    expect(repaired.nodes.p?.status).toBe("failed");
    // The unwind carries on: only the compensation runs.
    const after = (await b.workflows.advance(run.id, approvalsFor(repaired))).run;
    expect(after.nodes["undo-q"]?.status).toBe("compensated");
    expect(b.adapter.mock.calls.map(([operation]) => (operation as { key?: string }).key)).toEqual(["undo-q"]);
  });

  it("does not reopen a failed branch's sibling when a restart repairs a stalled unwind", async () => {
    // p fails while its other branch waits for approval, so the run fails and
    // unwinds. The compensation's outcome is unknown, so it parks and stalls
    // the unwind. A restart then repairs the run, and p must stay failed: the
    // waiting branch is part of a saga already being undone.
    const at = await home();
    const execute = async (operation?: Operation) => {
      if (operation?.kind === "http") throw outcomeUnknown("socket hang up");
      if (operation?.kind === "memory" && operation.action === "search") {
        return { success: true, found: false };
      }
      return { success: true, stored: true };
    };
    const a = await side(at, execute);
    const look = TaskRequestSchema.parse({
      goal: "Find x",
      operation: { kind: "memory", action: "search", query: "x" },
      requiredEvidence: [{ type: "result_equals", path: "found", value: true }],
    });
    const run = a.workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Stalled",
        nodes: [
          { id: "q", type: "operation", request: put("q") },
          { id: "p", type: "parallel", dependsOn: ["q"], branches: [[look], [put("p2")]] },
          { id: "undo-q", type: "compensation", forNodeId: "q", request: charge() },
        ],
      }),
    );
    let current = (await a.workflows.advance(run.id)).run;
    current = (await a.workflows.advance(run.id, approvalsFor(current))).run;
    current = (await a.workflows.advance(run.id)).run;
    expect(current.status).toBe("failed");
    const undo = current.nodes["undo-q"]!.approval!;
    current = (await a.workflows.advance(run.id, [{ approvalId: undo.approvalId, phrase: undo.phrase! }])).run;
    expect(current.status).toBe("recovery_required");
    expect(current.nodes.p?.status).toBe("failed");

    const restarted = new WorkflowController(a.store, a.tasks, new PayloadCipher(Buffer.alloc(32, 41)));
    await restarted.recoverInterrupted();
    const after = restarted.status(run.id);
    expect(after.nodes.p?.status).toBe("failed");
    expect(after.error).toBe("workflow_compensation_incomplete:undo-q");
  });

  it("waits out a lapsed lease while its task still runs, then recovers before advancing", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const b = await side(at);
    const { id } = await midFlight(a, adapter);
    // A's renewal stalled, but its task is still running in a live process.
    expireLease(b.store, id);
    const before = footprint(b.store, id);

    expect(await b.workflows.recoverInterrupted({ abandonedOnly: true })).toEqual([]);
    expect(footprint(b.store, id)).toEqual(before);
    await expect(b.workflows.advance(id)).rejects.toThrow("workflow_lease_held");
    expect(b.store.getWorkflowLease(id)).toBeDefined();

    // A dies. Taking its lease over would read a projection from before its
    // task and plan that task again; the run is recovered first instead.
    a.store.close();
    const after = (await b.workflows.advance(id)).run;
    expect(after.nodes.write?.status).toBe("recovery_required");
    expect(b.store.getWorkflowLease(id)).toBeUndefined();
    expect(a.adapter).toHaveBeenCalledTimes(1);
    expect(b.adapter).not.toHaveBeenCalled();
  });

  it("sweeps a run whose advance died, and nothing else", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const b = await side(at);
    const { id } = await midFlight(a, adapter);
    const idle = b.workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: "44444444-4444-4444-8444-444444444444",
        version: 1,
        name: "Idle",
        nodes: [{ id: "write", type: "operation", request: put("idle") }],
      }),
    );
    const idleBefore = footprint(b.store, idle.id);
    a.store.close();
    expireLease(b.store, id);

    const recovered = await b.workflows.recoverInterrupted({ abandonedOnly: true });
    expect(recovered.map((run) => run.id)).toEqual([id]);
    expect(recovered[0]?.nodes.write?.status).toBe("recovery_required");
    expect(b.store.getWorkflowLease(id)).toBeUndefined();
    // No lease, no advance that died: the sweep does not touch it.
    expect(footprint(b.store, idle.id)).toEqual(idleBefore);
  });

  it("cancels a run without calling a step cancelled that another process is running", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at);
    const b = await side(at, adapter.execute);
    const run = a.workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: definitionId,
        version: 1,
        name: "Ownership",
        nodes: [{ id: "write", type: "operation", request: put("write") }],
      }),
    );
    const waiting = (await a.workflows.advance(run.id)).run;
    const taskId = waiting.nodes.write!.taskIds[0]!;
    // Approved with melra_execute in B; A's next advance reads it in flight.
    const executing = b.tasks.execute(taskId, approvalsFor(waiting)[0]);
    await adapter.entered.opened;
    const parked = (await a.workflows.advance(run.id)).run.nodes.write;
    expect(parked).toEqual({ status: "recovery_required", taskIds: [taskId], error: "task_still_in_flight" });

    const cancelled = a.workflows.cancel(run.id);
    adapter.release.open();
    expect((await executing).task.status).toBe("verified_success");
    // Its outcome was not known when the run was cancelled, and it took effect.
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.nodes.write).toEqual(parked);
  });

  it("cancels a run without calling a step cancelled whose process died mid-effect", async () => {
    const at = await home();
    const adapter = held();
    const a = await side(at, adapter.execute);
    const b = await side(at);
    const { id } = await midFlight(a, adapter);
    const [running] = b.store.listTasks(1, "running");
    a.store.close();
    expireLease(b.store, id);

    const cancelled = b.workflows.cancel(id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.nodes.write).toEqual({ status: "recovery_required", taskIds: [running!.id], error: "task_still_in_flight" });
    // Task recovery cannot say whether the write landed, and nor does the run.
    await b.tasks.recoverInterrupted();
    expect(b.tasks.status(running!.id).status).toBe("recovery_required");
    expect(b.workflows.status(id).nodes.write?.status).toBe("recovery_required");
  });
});
