// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRequestSchema, type Operation, type TaskRequestInput } from "@melra/protocol";
import { createDefaultPolicy } from "@melra/policy-core";
import { sha256 } from "@melra/receipt-schema";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController, type TaskPlanOptions } from "./task-controller.js";

/**
 * The agent's own evidence holds, and the effect did not land as it asked: a
 * stand-in adapter reports the change it was asked for and leaves something
 * else. The kernel's check of the end state the request fixes decides it.
 */
const roots: string[] = [];
const stores: SqliteStore[] = [];
const MASKED = "[REDACTED_SENSITIVE_FIELD]";
const KEY = Buffer.alloc(32, 5);

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const hex = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function setup(adapter: (root: string, operation: Operation) => Promise<Record<string, unknown>>) {
  const root = await mkdtemp(join(tmpdir(), "melra-kernel-checks-"));
  roots.push(root);
  const store = new SqliteStore(":memory:");
  stores.push(store);
  const controller = new TaskController(
    store,
    createDefaultPolicy(root),
    { execute: (operation) => adapter(root, operation) },
    await Verifier.create(root),
    new PayloadCipher(KEY),
  );
  const run = async (request: TaskRequestInput, options?: TaskPlanOptions) => {
    const planned = await controller.plan(TaskRequestSchema.parse(request), options);
    const done = await controller.execute(
      planned.id,
      planned.approval === undefined ? undefined : { approvalId: planned.approval.approvalId, phrase: planned.approval.phrase! },
    );
    const receipt = store.getReceipt(done.task.receiptIds[0]!)!;
    const certificate = store.getCertificateForTask(planned.id)!;
    return { planned, done, receipt, certificate };
  };
  return { root, store, controller, run };
}

describe("kernel checks", () => {
  it("hold a write to the bytes it sent, apart from the agent's own evidence", async () => {
    const { store, run } = await setup(async (root) => {
      await writeFile(join(root, "notes.md"), "something else");
      return { written: true, path: "notes.md" };
    });
    const { planned, done, receipt, certificate } = await run({
      goal: "Write the notes",
      operation: { kind: "file", action: "write", path: "notes.md", content: "done" },
      requiredEvidence: [{ type: "file_exists", path: "notes.md" }],
    });

    // Shown to the live caller as derived; stored as the content is, masked.
    expect(planned.kernelChecks).toEqual([{ type: "file_hash", path: "notes.md", sha256: hex("done") }]);
    expect(store.getTask(planned.id)!.kernelChecks).toEqual([{ type: "file_hash", path: "notes.md", sha256: MASKED }]);
    expect(done.task.status).toBe("partial");
    expect(receipt.evidence).toEqual([expect.objectContaining({ type: "file_exists", passed: true })]);
    expect(receipt.kernelEvidence).toEqual([
      expect.objectContaining({ type: "file_hash", passed: false, strength: "state", digest: MASKED }),
    ]);
    expect(certificate.result).toBe("PARTIAL");
    expect(certificate.evidence).toEqual(receipt.evidence);
    expect(certificate.kernelEvidence).toEqual(receipt.kernelEvidence);
    const { digest, ...body } = certificate;
    expect(sha256(body)).toBe(digest);
    // Neither the hash of what was sent nor of what was found is stored.
    const rows = JSON.stringify(
      (store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        ({ name }) => store.database.prepare(`SELECT * FROM "${name}"`).all(),
      ),
    );
    expect(rows).not.toContain(hex("done"));
    expect(rows).not.toContain(hex("something else"));
  });

  it("verify a write that landed as sent, binary content included", async () => {
    const bytes = Buffer.from([0, 255, 10, 13, 128, 1]);
    const { run } = await setup(async (root, operation) => {
      if (operation.kind !== "file" || operation.content === undefined) throw new Error("unexpected");
      await writeFile(join(root, operation.path), Buffer.from(operation.content, "base64"));
      return { written: true, path: operation.path };
    });
    const { done, receipt, certificate } = await run({
      goal: "Write a binary file",
      operation: { kind: "file", action: "write", path: "blob.bin", content: bytes.toString("base64"), encoding: "base64" },
      requiredEvidence: [{ type: "result_equals", path: "written", value: true }],
    });
    expect(done.task.status).toBe("verified_success");
    expect(receipt.kernelEvidence).toEqual([expect.objectContaining({ type: "file_hash", passed: true, digest: MASKED })]);
    expect(certificate.kernelEvidence).toEqual(receipt.kernelEvidence);
  });

  it("hold a mkdir to a directory, a move to its source gone and a delete to its path gone", async () => {
    const { root, run } = await setup(async (root, operation) => {
      if (operation.kind !== "file") throw new Error("unexpected");
      // A file where a directory was asked for, a copy for a move, and no delete.
      if (operation.action === "mkdir") await writeFile(join(root, operation.path), "");
      if (operation.action === "move") await copyFile(join(root, operation.path), join(root, operation.destination!));
      return { created: true, moved: true, deleted: true };
    });
    await writeFile(join(root, "draft.md"), "x");
    await writeFile(join(root, "old.log"), "x");

    const mkdir = await run({
      goal: "Make the build folder",
      operation: { kind: "file", action: "mkdir", path: "build" },
      requiredEvidence: [{ type: "file_exists", path: "build" }],
    });
    expect(mkdir.done.task.status).toBe("partial");
    expect(mkdir.receipt.kernelEvidence).toEqual([expect.objectContaining({ type: "directory_exists", passed: false })]);

    const move = await run({
      goal: "Publish the draft",
      operation: { kind: "file", action: "move", path: "draft.md", destination: "post.md" },
      requiredEvidence: [{ type: "file_exists", path: "post.md" }],
    });
    expect(move.done.task.status).toBe("partial");
    expect(move.receipt.kernelEvidence).toEqual([
      expect.objectContaining({ type: "file_absent", passed: false }),
      expect.objectContaining({ type: "file_present", passed: true }),
    ]);

    const remove = await run({
      goal: "Remove the old log",
      operation: { kind: "file", action: "delete", path: "old.log" },
      requiredEvidence: [{ type: "result_equals", path: "deleted", value: true }],
    });
    expect(remove.done.task.status).toBe("partial");
    expect(remove.receipt.kernelEvidence).toEqual([expect.objectContaining({ type: "file_absent", passed: false })]);
  });

  it("hold a memory delete to the record being gone from its scope", async () => {
    const id = "00000000-0000-4000-8000-0000000000c1";
    let deletes = false;
    const env = await setup(async (_root, operation) => {
      if (operation.kind !== "memory" || operation.id === undefined) throw new Error("unexpected");
      if (deletes) env.store.deleteMemory(operation.id, operation.scope);
      return { deleted: true, id: operation.id, scope: operation.scope };
    });
    const at = new Date().toISOString();
    env.store.putMemory({ id, scope: "workspace", key: "door", value: "red", source: "test", confidence: 1, tags: [], createdAt: at, updatedAt: at });
    const request = { goal: "Forget the door", operation: { kind: "memory", action: "delete", id } } as const;

    const kept = await env.run(request);
    expect(kept.planned.kernelChecks).toEqual([{ type: "memory_absent", id, scope: "workspace" }]);
    expect(kept.done.task.status).toBe("partial");
    expect(kept.receipt.kernelEvidence).toEqual([expect.objectContaining({ type: "memory_absent", passed: false, strength: "state" })]);

    deletes = true;
    const gone = await env.run(request);
    expect(gone.done.task.status).toBe("verified_success");
    expect(gone.receipt.kernelEvidence).toEqual([expect.objectContaining({ type: "memory_absent", passed: true })]);
  });

  it("are observed again when recovery finds an interrupted write", async () => {
    const { root, store, controller } = await setup(async () => ({ written: true }));
    const planned = await controller.plan(
      TaskRequestSchema.parse({
        goal: "Write the report",
        operation: { kind: "file", action: "write", path: "report.txt", content: "final" },
        requiredEvidence: [{ type: "file_exists", path: "report.txt" }],
      }),
    );
    // Cut off in `verifying`, with other bytes than the ones sent in the file.
    await writeFile(join(root, "report.txt"), "draft");
    const interrupted = store.getTask(planned.id)!;
    interrupted.status = "verifying";
    store.saveTaskExecutionResult(interrupted, new PayloadCipher(KEY).seal({ written: true }, `task:${planned.id}:result`));

    // The agent's file_exists still holds, so this used to recover as verified.
    const [parked] = await controller.recoverInterrupted();
    expect(parked?.status).toBe("recovery_required");
    expect(store.getReceiptsForTask(planned.id)).toEqual([]);
  });

  it("hold a reconciliation too, in the same recovery that saw one fail", async () => {
    const { root, store, controller } = await setup(async () => ({ written: true }));
    const planned = await controller.plan(
      TaskRequestSchema.parse({
        goal: "Write the report",
        operation: { kind: "file", action: "write", path: "report.txt", content: "final" },
        requiredEvidence: [{ type: "file_exists", path: "report.txt" }],
        reconciliation: [{ type: "file_exists", path: "report.txt" }],
      }),
    );
    await writeFile(join(root, "report.txt"), "draft");
    const interrupted = store.getTask(planned.id)!;
    interrupted.status = "verifying";
    store.saveTaskExecutionResult(interrupted, new PayloadCipher(KEY).seal({ written: true }, `task:${planned.id}:result`));

    // The declared reconciliation holds, so recovery parked it and then
    // settled it as verified.
    const [parked] = await controller.recoverInterrupted();
    expect(parked).toMatchObject({ status: "recovery_required", error: "reconciliation_kernel_check_failed" });
    expect(store.getReceiptsForTask(planned.id)).toEqual([]);

    // Once the file holds what was sent, a reconciliation settles it, the
    // kernel's check on its receipt and certificate.
    await writeFile(join(root, "report.txt"), "final");
    const settled = await controller.reconcile(planned.id);
    expect(settled.task.status).toBe("verified_success");
    expect(settled.receipt?.kernelEvidence).toEqual([expect.objectContaining({ type: "file_hash", passed: true })]);
    expect(settled.certificate?.kernelEvidence).toEqual(settled.receipt?.kernelEvidence);
  });

  it("keep a semantic question from waiting, and its key uncommitted, when one fails", async () => {
    const { store, run } = await setup(async (root) => {
      await writeFile(join(root, "summary.md"), "other");
      return { written: true };
    });
    const key = "a".repeat(64);
    const { done } = await run(
      {
        goal: "Write the summary",
        operation: { kind: "file", action: "write", path: "summary.md", content: "short" },
        requiredEvidence: [
          { type: "file_exists", path: "summary.md" },
          { type: "semantic", question: "Is the summary accurate?" },
        ],
      },
      { idempotencyKey: key, attempt: 1 },
    );
    // Waiting, a judge's yes would have certified the wrong bytes.
    expect(done.task.status).toBe("partial");
    expect(done.task.judgements).toBeUndefined();
    expect(store.getIdempotencyCommit(key)).toBeUndefined();
  });

  it("stay on a semantic task's certificate once its question is answered", async () => {
    const { store, controller, run } = await setup(async (root, operation) => {
      if (operation.kind !== "file") throw new Error("unexpected");
      await writeFile(join(root, operation.path), operation.content ?? "");
      return { written: true, path: operation.path };
    });
    const { planned, done } = await run({
      goal: "Write the summary",
      operation: { kind: "file", action: "write", path: "summary.md", content: "short" },
      requiredEvidence: [
        { type: "file_exists", path: "summary.md" },
        { type: "semantic", question: "Is the summary accurate?" },
      ],
    });
    expect(done.task.status).toBe("waiting_user");
    const judged = await controller.judge(
      { taskId: planned.id, judgementId: done.task.judgements![0]!.judgementId, verdict: "yes" },
      { identity: { principal: { kind: "human", id: "reviewer" }, onBehalfOf: [] } },
    );
    expect(judged.task.status).toBe("verified_success");
    expect(judged.certificate?.kernelEvidence).toEqual([expect.objectContaining({ type: "file_hash", passed: true })]);
    expect(store.getCertificateForTask(planned.id)?.kernelEvidence).toEqual(judged.certificate?.kernelEvidence);
  });
});
