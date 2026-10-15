// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskRequestSchema,
  WorkflowDefinitionSchema,
  type TaskRequest,
  type WorkflowRun,
} from "@melra/protocol";
import { createDefaultPolicy } from "@melra/policy-core";
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
  execute: () => Promise<Record<string, unknown>> = async () => ({ success: true, stored: true }),
  probe?: EvidenceProbe,
) {
  const store = new SqliteStore(at.path);
  stores.push(store);
  const verifier = await Verifier.create(at.root, probe === undefined ? {} : { probe });
  const adapter = vi.fn(execute);
  const cipher = new PayloadCipher(Buffer.alloc(32, 41));
  const tasks = new TaskController(store, createDefaultPolicy(at.root), { execute: adapter }, verifier, cipher);
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

const approve = (task: { approval?: { approvalId: string; phrase: string } }) => ({
  approvalId: task.approval!.approvalId,
  phrase: task.approval!.phrase,
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
    // Claimed by a live process, so no peer may take it: this one has to.
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

const definitionId = "33333333-3333-4333-8333-333333333333";

const put = (key: string): TaskRequest =>
  TaskRequestSchema.parse({
    goal: `Put ${key}`,
    operation: { kind: "memory", action: "put", key, value: key },
    requiredEvidence: [{ type: "result_equals", path: "stored", value: true }],
  });

const approvalsFor = (run: WorkflowRun) =>
  Object.values(run.nodes).flatMap((node) =>
    node.approval === undefined ? [] : [{ approvalId: node.approval.approvalId, phrase: node.approval.phrase }],
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
});
