// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// An older MELRA writing the same home. `melra setup` pins each client to the
// version that wrote its config, so after an upgrade a pinned server keeps
// running beside the new one until its config is rewritten. Every query this
// store makes must see what that one writes: a task it starts, finishes or
// plans under a key.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRequestSchema, WorkflowEventSchema, type ApprovalDecision, type WorkflowEvent } from "@melra/protocol";
import { createCertificate, type ActionReceipt, type ExecutionCertificate } from "@melra/receipt-schema";
import { SqliteStore, type TaskRecord } from "./index.js";

const stores: SqliteStore[] = [];
const closers: Array<() => void> = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const close of closers.splice(0)) close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function newHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "melra-older-writer-"));
  directories.push(directory);
  return join(directory, "melra.sqlite");
}

function open(path: string): SqliteStore {
  const store = new SqliteStore(path);
  stores.push(store);
  return store;
}

/**
 * 0.3.0-alpha.17's two writes of a task and its writes of the records an
 * effect leaves, verbatim, on a connection of its own.
 */
function olderMelra(path: string) {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA busy_timeout = 5000");
  closers.push(() => database.close());
  return {
    saveTask(task: TaskRecord): void {
      database
        .prepare(`
          INSERT INTO tasks(id, data, created_at, updated_at, owner)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            data = excluded.data,
            updated_at = excluded.updated_at,
            owner = COALESCE(excluded.owner, tasks.owner)
        `)
        .run(task.id, JSON.stringify(task), task.createdAt, task.updatedAt, null);
    },
    saveTaskIf(task: TaskRecord, expected: readonly TaskRecord["status"][]): boolean {
      const result = database
        .prepare(`
          UPDATE tasks SET data = ?, updated_at = ?, owner = COALESCE(?, owner)
          WHERE id = ? AND json_extract(data, '$.status') IN (SELECT value FROM json_each(?))
        `)
        .run(JSON.stringify(task), task.updatedAt, null, task.id, JSON.stringify(expected));
      return Number(result.changes) === 1;
    },
    commitIdempotency(key: string, taskId: string, attempt: number, at: string): boolean {
      const result = database
        .prepare(`
          INSERT OR IGNORE INTO idempotency_commits(
            idempotency_key, task_id, attempt, committed_at
          )
          VALUES (?, ?, ?, ?)
        `)
        .run(key, taskId, attempt, at);
      return Number(result.changes) === 1;
    },
    recordApprovalDecision(decision: ApprovalDecision): boolean {
      const result = database
        .prepare(`
          INSERT OR IGNORE INTO approval_decisions(
            approval_id, task_id, render_digest, channel, approver, decided_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          decision.approvalId,
          decision.taskId,
          decision.renderDigest,
          decision.channel,
          decision.approver,
          decision.decidedAt,
        );
      return Number(result.changes) === 1;
    },
    recordCapabilityUse(grantId: string, taskId: string, amount: number, at: string): void {
      database
        .prepare(`
          INSERT OR IGNORE INTO capability_usage(
            grant_id, task_id, amount, committed_at
          )
          VALUES (?, ?, ?, ?)
        `)
        .run(grantId, taskId, amount, at);
    },
    insertWorkflowEvent(event: WorkflowEvent): void {
      database
        .prepare(`
          INSERT INTO workflow_events(
            id, aggregate_id, sequence, trace_id, type, data, occurred_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          event.id,
          event.aggregateId,
          event.sequence,
          event.traceId,
          event.type,
          JSON.stringify(event),
          event.occurredAt,
        );
    },
    saveReceipt(receipt: ActionReceipt): void {
      database
        .prepare(`
          INSERT INTO receipts(id, task_id, data, created_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(receipt.receiptId, receipt.taskId, JSON.stringify(receipt), receipt.endedAt);
    },
    saveCertificate(certificate: ExecutionCertificate, { ifAbsent = false }: { ifAbsent?: boolean } = {}): void {
      database
        .prepare(`
          INSERT INTO certificates(id, task_id, data, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(task_id) DO ${ifAbsent ? "NOTHING" : `UPDATE SET
            id = excluded.id,
            data = excluded.data,
            created_at = excluded.created_at`}
        `)
        .run(certificate.certificateId, certificate.taskId, JSON.stringify(certificate), certificate.createdAt);
    },
  };
}

const UNSTARTED: TaskRecord["status"][] = ["planned", "awaiting_approval"];
const KEY = "a".repeat(64);

function task(status: TaskRecord["status"], extra: Partial<TaskRecord> = {}): TaskRecord {
  const at = "2026-10-01T00:00:00.000Z";
  return {
    id: "00000000-0000-4000-8000-000000000001",
    request: TaskRequestSchema.parse({ goal: "Inspect", operation: { kind: "system", action: "info" } }),
    status,
    policyDecision: {
      outcome: "allow",
      effect: "read",
      risk: "low",
      reason: "read_only_operation",
      policyVersion: "1",
      traits: [],
    },
    receiptIds: [],
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

describe("an older MELRA writing the same home", () => {
  it("is seen to have planned and started a task, by status and by key", () => {
    const path = newHome();
    const store = open(path);
    const older = olderMelra(path);
    const row = task("planned", { idempotencyKey: KEY, attempt: 1 });
    older.saveTask(row);
    expect(older.saveTaskIf({ ...row, status: "running" }, UNSTARTED)).toBe(true);
    // Recovery takes it up if that process dies, and a workflow step sees its
    // key taken rather than planning the change again (#319).
    expect(store.listInterruptedTasks().map((found) => found.id)).toEqual([row.id]);
    expect(store.listTasksByKey(KEY).map((found) => found.status)).toEqual(["running"]);
    expect(store.taskStatusCounts()).toEqual({ running: 1 });
  });

  it("keeps a task it started from being started again here", () => {
    const path = newHome();
    const store = open(path);
    const older = olderMelra(path);
    const row = task("planned");
    store.saveTask(row);
    expect(older.saveTaskIf({ ...row, status: "running" }, UNSTARTED)).toBe(true);
    expect(store.saveTaskIf({ ...row, status: "running" }, UNSTARTED, store.ownerId())).toBe(false);
  });

  it("keeps a task it finished from being recovered here", () => {
    const path = newHome();
    const store = open(path);
    const older = olderMelra(path);
    const row = task("running");
    store.saveTask(row);
    older.saveTask({ ...row, status: "verified_success" });
    expect(store.listInterruptedTasks()).toEqual([]);
    expect(store.claimInterruptedTask(row.id)).toBeUndefined();
    expect(store.getTask(row.id)?.status).toBe("verified_success");
  });

  it("keeps recording what an effect leaves on a home that keeps those records append-only", () => {
    const path = newHome();
    const store = open(path);
    const older = olderMelra(path);
    const row = task("verifying", { idempotencyKey: KEY, attempt: 1 });
    const at = row.updatedAt;
    older.saveTask(row);
    // Its commit of an outcome, as it makes it: each record once, a repeat ignored.
    expect(older.commitIdempotency(KEY, row.id, 1, at)).toBe(true);
    expect(older.commitIdempotency(KEY, row.id, 2, at)).toBe(false);
    const decision: ApprovalDecision = {
      approvalId: "00000000-0000-4000-8000-0000000000a1",
      taskId: row.id,
      renderDigest: "b".repeat(64),
      channel: "out_of_band",
      approver: "cli:operator",
      decidedAt: at,
    };
    expect(older.recordApprovalDecision(decision)).toBe(true);
    expect(older.recordApprovalDecision({ ...decision, approver: "cli:other" })).toBe(false);
    older.recordCapabilityUse("grant", row.id, 1, at);
    older.recordCapabilityUse("grant", row.id, 1, at);
    const receipt = { receiptId: "00000000-0000-4000-8000-0000000000b1", taskId: row.id, endedAt: at } as ActionReceipt;
    older.saveReceipt(receipt);
    older.insertWorkflowEvent(
      WorkflowEventSchema.parse({
        schemaVersion: "1.0.0",
        id: "00000000-0000-4000-8000-0000000000c1",
        aggregateId: "00000000-0000-4000-8000-0000000000c2",
        sequence: 1,
        traceId: "00000000-0000-4000-8000-0000000000c3",
        type: "workflow.created",
        data: {},
        occurredAt: at,
      }),
    );
    // A certificate, then the one a judgement or a settle writes in its place.
    const issue = (result: "PARTIAL" | "VERIFIED_SUCCESS") =>
      createCertificate({
        taskId: row.id,
        goal: "Inspect",
        result,
        policyVersion: "1",
        receiptIds: [receipt.receiptId],
        evidence: [],
        createdAt: at,
      });
    const first = issue("PARTIAL");
    older.saveCertificate(first, { ifAbsent: true });
    older.saveCertificate(issue("PARTIAL"), { ifAbsent: true });
    const settled = issue("VERIFIED_SUCCESS");
    older.saveCertificate(settled);
    older.saveTask({ ...row, status: "verified_success", receiptIds: [receipt.receiptId] });

    expect(store.getIdempotencyCommit(KEY)).toMatchObject({ taskId: row.id, attempt: 1 });
    expect(store.getApprovalDecision(decision.approvalId)).toEqual(decision);
    expect(store.capabilityUsage("grant", at)).toEqual({ operations: 1, amountInWindow: 1 });
    expect(store.getReceiptsForTask(row.id)).toEqual([receipt]);
    expect(store.listWorkflowEvents("00000000-0000-4000-8000-0000000000c2")).toHaveLength(1);
    expect(store.getCertificateForTask(row.id)).toEqual(settled);
    // The certificate it replaced is kept, not lost.
    expect(
      store.database.prepare("SELECT data FROM certificate_history WHERE task_id = ?").all(row.id),
    ).toEqual([{ data: JSON.stringify(first) }]);
  });

  it("leaves a task denied here denied, and its own deny reads as the plain cancel it is", () => {
    const path = newHome();
    const store = open(path);
    const older = olderMelra(path);
    const pending = task("awaiting_approval");
    store.saveTask(pending);
    const denial = {
      reason: "never" as const,
      channel: "out_of_band" as const,
      approver: "cli:operator",
      decidedAt: pending.updatedAt,
    };
    // What a deny here writes: the cancel carrying its denial, and its row.
    expect(store.saveTaskIf({ ...pending, status: "cancelled", denial }, UNSTARTED)).toBe(true);
    expect(
      store.recordApprovalDenial({
        ...denial,
        approvalId: "00000000-0000-4000-8000-0000000000d1",
        taskId: pending.id,
        renderDigest: "b".repeat(64),
        operationDigest: "c".repeat(64),
      }),
    ).toBe(true);
    // Its execute and its deny, both a write out of an unstarted status, find
    // the task gone from one and leave the denial standing.
    expect(older.saveTaskIf({ ...pending, status: "running" }, UNSTARTED)).toBe(false);
    expect(older.saveTaskIf({ ...pending, status: "cancelled" }, UNSTARTED)).toBe(false);
    expect(store.getTask(pending.id)).toMatchObject({ status: "cancelled", denial });
    // It records no denial and no refusal: its deny is a cancel, as it always was.
    const other = task("awaiting_approval", { id: "00000000-0000-4000-8000-000000000002" });
    older.saveTask(other);
    expect(older.saveTaskIf({ ...other, status: "cancelled" }, UNSTARTED)).toBe(true);
    expect(store.getTask(other.id)?.status).toBe("cancelled");
    expect(store.getTask(other.id)).not.toHaveProperty("denial");
    expect(store.refusalCount()).toBe(0);
  });
});
