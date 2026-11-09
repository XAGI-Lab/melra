// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TaskRequestSchema,
  WorkflowDefinitionSchema,
  effectContract,
  type Operation,
  type TaskRecord,
  type TaskRequest,
} from "@melra/protocol";
import { classifyOperation, createDefaultPolicy, digestOperation, type LocalPolicy } from "@melra/policy-core";
import { sha256 } from "@melra/receipt-schema";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";
import { WorkflowController } from "./workflow-controller.js";

/**
 * A digest stored beside a redacted record must not be one a reader of that
 * record can recompute from what the record holds. Digests are keyed per
 * home, and content digests are masked as the content is.
 */
const roots: string[] = [];
const stores: SqliteStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const hex = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function setup(policy: Partial<LocalPolicy> = {}) {
  const root = await mkdtemp(join(tmpdir(), "melra-digests-"));
  roots.push(root);
  const store = new SqliteStore(":memory:");
  stores.push(store);
  const cipher = new PayloadCipher(Buffer.alloc(32, 9));
  const calls: Operation[] = [];
  // Shaped as the file runtime answers a read and a write.
  const execute = async (operation: Operation): Promise<Record<string, unknown>> => {
    calls.push(operation);
    if (operation.kind === "file" && operation.action === "write") {
      const bytes = Buffer.from(operation.content ?? "", "utf8");
      await writeFile(join(root, operation.path), bytes);
      return { written: true, path: operation.path, size: bytes.byteLength, sha256: hex(bytes) };
    }
    if (operation.kind === "file" && operation.action === "read") {
      const bytes = await readFile(join(root, operation.path));
      return { path: operation.path, content: bytes.toString("utf8"), encoding: "utf8", size: bytes.byteLength, sha256: hex(bytes) };
    }
    return { success: true, stored: true };
  };
  const tasks = new TaskController(
    store,
    { ...createDefaultPolicy(root), ...policy },
    { execute },
    await Verifier.create(root),
    cipher,
  );
  return { root, store, cipher, tasks, calls, execute };
}

const pin: TaskRequest = TaskRequestSchema.parse({
  goal: "Store the door code",
  operation: { kind: "memory", action: "put", key: "door", value: "4821" },
  requiredEvidence: [{ type: "result_equals", path: "stored", value: true }],
});

/** The challenge a 0.3.0-alpha.17 or alpha.18 planner stored: the plain digest and its phrase. */
function plannedBefore(store: SqliteStore, taskId: string): string {
  const task = store.getTask(taskId)!;
  const plain = digestOperation(taskId, pin.operation);
  const phrase = `APPROVE ${plain.slice(0, 12)}`;
  store.saveTask({ ...task, approval: { ...task.approval!, actionDigest: plain, phrase } });
  return phrase;
}

/** What those versions show an approver, and bind a decision to: the plain digest of the contract. */
function plainRender(task: TaskRecord, request: TaskRequest): string {
  const { authorization: _authorization, policy: _policy, ...contract } = effectContract(
    { ...task, request },
    classifyOperation(request.operation),
  );
  return sha256(contract);
}

/**
 * A 0.3.0-alpha.17 or alpha.18 executor on the same rows and key, up to its
 * adapter: it checks the stored action digest against the plain one it
 * recomputes (policy-core, which computes it, is unchanged), then a recorded
 * decision against the plain digest of the contract, and only then runs.
 */
async function priorExecute(env: Awaited<ReturnType<typeof setup>>, taskId: string) {
  const task = env.store.getTask(taskId)!;
  const request = TaskRequestSchema.parse(env.cipher.open(env.store.getTaskPayload(taskId)!, `task:${taskId}:request`));
  if (task.approval?.actionDigest !== digestOperation(taskId, request.operation)) {
    throw new Error("approval_action_digest_mismatch");
  }
  const decision = env.store.getApprovalDecision(task.approval.approvalId);
  if (decision !== undefined && decision.renderDigest !== plainRender(task, request)) {
    throw new Error("approval_render_mismatch");
  }
  return await env.execute(request.operation);
}

/** Every row of every table, as one string. */
function dump(store: SqliteStore): string {
  const tables = store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return JSON.stringify(tables.map(({ name }) => store.database.prepare(`SELECT * FROM "${name}"`).all()));
}

describe("digests stored beside redacted records", () => {
  it("confirm nothing redaction took out of any stored row", async () => {
    const env = await setup();
    const { store, tasks, cipher } = env;
    // Distinctive enough that finding it among random ids means it was stored.
    const content = "door:4821";
    const plaintexts: Array<{ id: string; request: TaskRequest; contract?: string }> = [];
    const approve = async (request: TaskRequest, decide = false) => {
      const planned = await tasks.plan(request);
      const contract = plainRender(store.getTask(planned.id)!, planned.request);
      plaintexts.push({ id: planned.id, request: planned.request, contract });
      if (decide) {
        await tasks.decide(planned.id, tasks.approvalView(planned.id).renderDigest, "cli:test");
        return await tasks.execute(planned.id);
      }
      return await tasks.execute(planned.id, { approvalId: planned.approval!.approvalId, phrase: planned.approval!.phrase! });
    };

    // A write whose declared hash does not match, so its failed item holds the file's own.
    const write = await approve(
      TaskRequestSchema.parse({
        goal: "Write the door code",
        operation: { kind: "file", action: "write", path: "pin.txt", content },
        requiredEvidence: [{ type: "file_hash", path: "pin.txt", sha256: "0".repeat(64) }],
      }),
    );
    expect(write.task.status).toBe("partial");
    expect(write.output).toMatchObject({ sha256: hex(content) });
    // A read of it, and a second write decided by an operator.
    const read = await tasks.plan(TaskRequestSchema.parse({ goal: "Read the door code", operation: { kind: "file", action: "read", path: "pin.txt" } }));
    plaintexts.push({ id: read.id, request: read.request });
    const readDone = await tasks.execute(read.id);
    expect(readDone.output).toMatchObject({ content, sha256: hex(content) });
    expect((await approve(
      TaskRequestSchema.parse({
        goal: "Copy the door code",
        operation: { kind: "file", action: "write", path: "copy.txt", content },
        requiredEvidence: [{ type: "file_exists", path: "copy.txt" }],
      }),
      true,
    )).task.status).toBe("verified_success");
    // A form fill planned and never run.
    const form = await tasks.plan(
      TaskRequestSchema.parse({
        goal: "Enter the door code",
        operation: { kind: "browser", action: "fill_form", fields: [{ target: { selector: "#pin" }, value: content }] },
        requiredEvidence: [{ type: "result_equals", path: "filled", value: true }],
      }),
    );
    expect(form.status).toBe("awaiting_approval");
    plaintexts.push({ id: form.id, request: form.request, contract: plainRender(store.getTask(form.id)!, form.request) });
    // A one-step workflow.
    const workflows = new WorkflowController(store, tasks, cipher);
    const run = workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: crypto.randomUUID(),
        version: 1,
        name: "Store the door code",
        nodes: [{ id: "put", type: "operation", request: pin }],
      }),
    );
    const waiting = (await workflows.advance(run.id)).run.nodes.put!;
    const stepId = waiting.taskIds[0]!;
    const step = store.getTask(stepId)!;
    plaintexts.push({ id: stepId, request: pin, contract: plainRender(step, pin) });
    const finished = await workflows.advance(run.id, [{ approvalId: waiting.approval!.approvalId, phrase: waiting.approval!.phrase! }]);
    expect(finished.run.status).toBe("verified_complete");

    const stored = dump(store);
    expect(stored).not.toContain(content);
    const plainDigests = [
      hex(content),
      ...plaintexts.flatMap(({ id, request, contract }) => [
        sha256(request.operation),
        digestOperation(id, request.operation),
        ...(contract === undefined ? [] : [contract]),
      ]),
    ];
    for (const plain of plainDigests) {
      expect(stored).not.toContain(plain);
      expect(stored).not.toContain(plain.slice(0, 12));
    }
    // The one plain digest kept on purpose: a workflow step's key, which every
    // version sharing the home must derive alike or a step could run twice.
    expect(step.idempotencyKey).toBe(sha256({ workflowId: run.id, nodeId: "put", iteration: 0, branch: "operation", request: pin }));
    // Each receipt's input digest still pins its exact input, for a holder of the key.
    for (const { id, request } of plaintexts) {
      for (const receipt of store.getReceiptsForTask(id)) {
        expect(receipt.inputDigest).toBe(cipher.digest({ taskId: id, operation: request.operation }, "input"));
      }
    }
  });

  it("mask a failed file hash alike on the receipt and the certificate", async () => {
    const { store, tasks } = await setup();
    const planned = await tasks.plan(
      TaskRequestSchema.parse({
        goal: "Write the door code",
        operation: { kind: "file", action: "write", path: "pin.txt", content: "4821" },
        requiredEvidence: [{ type: "file_hash", path: "pin.txt", sha256: "0".repeat(64) }],
      }),
    );
    const done = await tasks.execute(planned.id, { approvalId: planned.approval!.approvalId, phrase: planned.approval!.phrase! });
    const receipt = store.getReceipt(done.task.receiptIds[0]!)!;
    expect(receipt.evidence).toEqual([expect.objectContaining({ type: "file_hash", passed: false, digest: "[REDACTED_SENSITIVE_FIELD]" })]);
    expect(receipt.observedEffect).toMatchObject({ size: 4, sha256: "[REDACTED_SENSITIVE_FIELD]" });
    expect(receipt.redactions).toContain("[REDACTED_SENSITIVE_FIELD]");
    expect(store.getTask(planned.id)!.result).toMatchObject({ size: 4, sha256: "[REDACTED_SENSITIVE_FIELD]" });
    // A certificate written from the stored receipt says what the live one did.
    const certificate = store.getCertificateForTask(planned.id)!;
    expect(certificate.evidence).toEqual(receipt.evidence);
    const { digest, ...body } = certificate;
    expect(sha256(body)).toBe(digest);
  });

  it("are keyed, with the phrase still the action digest's first twelve digits", async () => {
    const { store, tasks, cipher } = await setup();
    const planned = await tasks.plan(pin);
    const view = tasks.approvalView(planned.id);
    const done = await tasks.execute(planned.id, { approvalId: planned.approval!.approvalId, phrase: planned.approval!.phrase! });
    expect(done.task.status).toBe("verified_success");

    const stored = store.getTask(planned.id)!;
    expect(stored.request.operation).toMatchObject({ value: "[REDACTED_SENSITIVE_FIELD]" });
    const plain = digestOperation(planned.id, pin.operation);
    expect(stored.approval!.actionDigest).toBe(cipher.digest(plain, "action"));
    expect(stored.approval!.phrase).toBe(`APPROVE ${stored.approval!.actionDigest.slice(0, 12)}`);
    expect(view.renderDigest).toBe(cipher.digest(view.contract, "render"));
    expect(Object.keys(view).sort()).toEqual(["contract", "renderDigest", "task"]);
    expect(stored.approvedBy!.renderDigest).toBe(view.renderDigest);
    const receipt = store.getReceipt(stored.receiptIds[0]!)!;
    expect(receipt.policyDecision.approval!.renderDigest).toBe(view.renderDigest);
    // Bound to the task: the same input in another task digests apart.
    const other = await tasks.plan(pin);
    await tasks.execute(other.id, { approvalId: other.approval!.approvalId, phrase: other.approval!.phrase! });
    expect(store.getReceiptsForTask(other.id)[0]!.inputDigest).not.toBe(receipt.inputDigest);
  });

  it("refuse a challenge whose digest is neither form", async () => {
    const { store, tasks, calls } = await setup();
    const planned = await tasks.plan(pin);
    const task = store.getTask(planned.id)!;
    store.saveTask({ ...task, approval: { ...task.approval!, actionDigest: "0".repeat(64) } });
    await expect(
      tasks.execute(planned.id, { approvalId: planned.approval!.approvalId, phrase: planned.approval!.phrase! }),
    ).rejects.toThrow("approval_action_digest_mismatch");
    expect(calls).toEqual([]);
  });
});

describe("a home shared with 0.3.0-alpha.17 or alpha.18", () => {
  it("runs once a challenge an older process planned, on its phrase", async () => {
    const { store, tasks, calls, cipher } = await setup();
    const planned = await tasks.plan(pin);
    const phrase = plannedBefore(store, planned.id);
    const { contract } = tasks.approvalView(planned.id);
    const done = await tasks.execute(planned.id, { approvalId: planned.approval!.approvalId, phrase });
    expect(done.task.status).toBe("verified_success");
    expect(calls).toHaveLength(1);
    // No older executor reads what this one records, so it is keyed.
    expect(done.task.approvedBy!.renderDigest).toBe(cipher.digest(contract, "render"));
    expect(done.receipt!.policyDecision.approval!.renderDigest).toBe(cipher.digest(contract, "render"));
    expect(dump(store)).not.toContain(sha256(contract));
  });

  it("decides an older process's task in the digest its executor recomputes", async () => {
    const env = await setup({ mode: "enforced" });
    const { store, tasks, calls, cipher } = env;
    const planned = await tasks.plan(pin);
    plannedBefore(store, planned.id);
    const view = tasks.approvalView(planned.id);
    expect(view.renderDigest).toBe(sha256(view.contract));
    await tasks.decide(planned.id, view.renderDigest, "cli:new");
    expect(store.getApprovalDecision(planned.approval!.approvalId)!.renderDigest).toBe(sha256(view.contract));
    // The older executor accepts it; so does this one, and either runs it once.
    await priorExecute(env, planned.id);
    expect(calls).toHaveLength(1);
    const done = await tasks.execute(planned.id);
    expect(done.task.status).toBe("verified_success");
    // Only the row keeps the plain form, for the older executor.
    expect(done.task.approvedBy!.renderDigest).toBe(cipher.digest(view.contract, "render"));
    expect(done.receipt!.policyDecision.approval!.renderDigest).toBe(cipher.digest(view.contract, "render"));
  });

  for (const mode of ["developer", "enforced"] as const) {
    it(`accepts an older process's decision on a new challenge, and nothing else (${mode})`, async () => {
      const { store, tasks, calls } = await setup({ mode });
      const decide = (taskId: string, approvalId: string, renderDigest: string) =>
        store.recordApprovalDecision({
          approvalId,
          taskId,
          renderDigest,
          channel: mode === "enforced" ? "out_of_band" : "in_band",
          approver: "cli:old",
          decidedAt: new Date().toISOString(),
        });
      const planned = await tasks.plan(pin);
      const keyed = tasks.approvalView(planned.id).renderDigest;
      decide(planned.id, planned.approval!.approvalId, plainRender(store.getTask(planned.id)!, pin));
      const done = await tasks.execute(planned.id);
      expect(done.task.status).toBe("verified_success");
      // What this kernel bound, not the row's plain form.
      expect(done.task.approvedBy!.renderDigest).toBe(keyed);
      expect(done.receipt!.policyDecision.approval!.renderDigest).toBe(keyed);

      const forged = await tasks.plan(pin);
      decide(forged.id, forged.approval!.approvalId, "0".repeat(64));
      await expect(tasks.execute(forged.id)).rejects.toThrow("approval_render_mismatch");
      expect(calls).toHaveLength(1);
    });
  }

  it("fails closed when an older process executes a new challenge, with nothing run", async () => {
    const env = await setup();
    const { store, tasks, calls } = env;
    const planned = await tasks.plan(pin);
    await expect(priorExecute(env, planned.id)).rejects.toThrow("approval_action_digest_mismatch");
    expect(calls).toEqual([]);
    expect(store.getTask(planned.id)!.status).toBe("awaiting_approval");
    // This version still runs it, once.
    const done = await tasks.execute(planned.id, { approvalId: planned.approval!.approvalId, phrase: planned.approval!.phrase! });
    expect(done.task.status).toBe("verified_success");
    expect(calls).toHaveLength(1);
  });
});
