// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// What a crash after the adapter returned leaves, at every write `execute`
// makes from then on, and what recovery in a new process makes of it. The
// outcome commits in one transaction after verification (#351), so every
// crash leaves the task as it was before its result was recorded, as it was
// during verification, or finished: never a part of the outcome.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRequestSchema, type TaskRequestInput } from "@melra/protocol";
import { createDefaultPolicy, type LocalPolicy } from "@melra/policy-core";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const KEY = "c".repeat(64);
const cipher = () => new PayloadCipher(Buffer.alloc(32, 13));
const grant = (capability: string, effect: "read" | "mutate"): LocalPolicy["capabilities"][number] => ({
  id: capability,
  capability,
  effects: [effect],
  target: "*",
  principal: "*",
  maxOperations: 10,
});
const policy = (root: string): LocalPolicy => ({
  ...createDefaultPolicy(root),
  capabilities: [grant("file.write", "mutate"), grant("http.post", "mutate"), grant("http.get", "read")],
});

/** The writes after the adapter: what each crash point is just before. */
const WRITES = [
  "saveTaskExecutionResult",
  "transaction",
  "commitIdempotency",
  "recordCapabilityUse",
  "saveReceipt",
  "saveTask",
  "saveCertificate",
] as const;

interface Outcome {
  status: string;
  error?: string;
  /** Who wrote each receipt: the live run, or recovery and why. */
  receipts: string[];
  certificate: string | null;
  committed: boolean;
  drawn: number;
}

/**
 * Runs one task to the end in a process of its own, copying what is
 * committed at every write after its adapter returned, and once it is done.
 * Each copy is what a crash at that moment leaves on disk.
 */
async function crashPoints(input: TaskRequestInput, execute: (root: string) => Promise<Record<string, unknown>>) {
  const root = await mkdtemp(join(tmpdir(), "melra-crash-points-"));
  roots.push(root);
  const path = join(root, ".melra", "melra.sqlite");
  const store = new SqliteStore(path);
  let returned = false;
  const controller = new TaskController(
    store,
    policy(root),
    {
      execute: async () => {
        const result = await execute(root);
        returned = true;
        return result;
      },
    },
    await Verifier.create(root),
    cipher(),
  );
  const reader = new DatabaseSync(path, { readOnly: true });
  const copies: Array<{ point: string; path: string }> = [];
  const copy = (point: string) => {
    const target = join(root, `crash-${copies.length}.sqlite`);
    reader.exec(`VACUUM INTO '${target}'`);
    copies.push({ point, path: target });
  };
  for (const name of WRITES) {
    const write = (store[name] as (...args: unknown[]) => unknown).bind(store);
    vi.spyOn(store, name).mockImplementation(((...args: unknown[]) => {
      if (returned) copy(name);
      return write(...args);
    }) as never);
  }
  const planned = controller.plan(TaskRequestSchema.parse(input), { idempotencyKey: KEY, attempt: 1 });
  await controller.execute(
    planned.id,
    planned.approval === undefined
      ? undefined
      : { approvalId: planned.approval.approvalId, phrase: planned.approval.phrase! },
  );
  copy("done");
  reader.close();
  store.close();

  const points: Array<{ point: string; outcome: Outcome }> = [];
  for (const crashed of copies) {
    points.push({ point: crashed.point, outcome: await recover(root, crashed.path, planned.id) });
  }
  return points;
}

/** A new process opening what the crash left: its startup recovery, then the caller's retry. */
async function recover(root: string, path: string, taskId: string): Promise<Outcome> {
  const store = new SqliteStore(path);
  try {
    const adapter = vi.fn(async () => ({ success: true }));
    const controller = new TaskController(store, policy(root), { execute: adapter }, await Verifier.create(root), cipher());
    await controller.recoverInterrupted();
    // Retried the obvious way: a parked change reconciles, and never runs again.
    if (controller.status(taskId).status === "recovery_required") await controller.execute(taskId);
    expect(adapter).not.toHaveBeenCalled();
    const task = controller.status(taskId);
    const { receipts, certificate } = controller.receipts({ taskId });
    return {
      status: task.status,
      ...(task.error === undefined ? {} : { error: task.error }),
      receipts: receipts.map((receipt) => {
        const observed = receipt.observedEffect as { recovery?: string };
        return observed.recovery ?? "live";
      }),
      certificate: certificate?.result ?? null,
      committed: store.getIdempotencyCommit(KEY)?.taskId === taskId,
      drawn: store.capabilityUsage(task.request.operation.kind === "file" ? "file.write" : `http.${String((task.request.operation as { method?: string }).method).toLowerCase()}`, new Date(0).toISOString()).operations,
    };
  } finally {
    store.close();
  }
}

/** Each outcome once, in the order the crash points first reach it. */
const distinct = (points: Array<{ outcome: Outcome }>) => [
  ...new Map(points.map(({ outcome }) => [JSON.stringify(outcome), outcome])).values(),
];

const parked: Outcome = {
  status: "recovery_required",
  error: "reconciliation_not_declared",
  receipts: [],
  certificate: null,
  committed: false,
  drawn: 1,
};

describe("a crash after the adapter returned", () => {
  it("leaves a change recovery can look at again parked, re-observed, or done", async () => {
    const points = await crashPoints(
      {
        goal: "Write the report",
        operation: { kind: "file", action: "write", path: "report.txt", content: "done" },
        requiredEvidence: [{ type: "file_exists", path: "report.txt" }],
      },
      async (root) => {
        await writeFile(join(root, "report.txt"), "done");
        return { success: true };
      },
    );
    expect(distinct(points)).toEqual([
      // Before its result was recorded, nothing says the write happened.
      parked,
      // After, and up to the commit, the file is looked at again.
      {
        status: "verified_success",
        receipts: ["independent_reobservation"],
        certificate: "VERIFIED_SUCCESS",
        committed: true,
        drawn: 1,
      },
      { status: "verified_success", receipts: ["live"], certificate: "VERIFIED_SUCCESS", committed: true, drawn: 1 },
    ]);
  });

  it("leaves a change it cannot look at again parked until the commit, and done after", async () => {
    const points = await crashPoints(
      {
        goal: "Charge the customer",
        operation: { kind: "http", action: "request", method: "POST", url: "http://localhost:9/charges" },
        requiredEvidence: [{ type: "result_equals", path: "success", value: true }],
      },
      async () => ({ success: true, status: 200 }),
    );
    // Never settled from a commit with no receipt beside it: none is made
    // without the rest.
    expect(distinct(points)).toEqual([
      parked,
      { status: "verified_success", receipts: ["live"], certificate: "VERIFIED_SUCCESS", committed: true, drawn: 1 },
    ]);
  });

  it("leaves a read to run again until the commit, and done after", async () => {
    const points = await crashPoints(
      { goal: "Fetch", operation: { kind: "http", action: "request", method: "GET", url: "http://localhost:9/ok" } },
      async () => ({ success: true, status: 200 }),
    );
    expect(distinct(points)).toEqual([
      {
        status: "planned",
        error: "interrupted_read_ready_for_retry",
        receipts: [],
        certificate: null,
        committed: false,
        drawn: 1,
      },
      { status: "verified_success", receipts: ["live"], certificate: "VERIFIED_SUCCESS", committed: true, drawn: 1 },
    ]);
  });

  it("leaves a change waiting on a judgement settled closed until the commit, and waiting after", async () => {
    const points = await crashPoints(
      {
        goal: "Write a summary someone has to judge",
        operation: { kind: "file", action: "write", path: "summary.txt", content: "done" },
        requiredEvidence: [
          { type: "file_exists", path: "summary.txt" },
          { type: "semantic", question: "Does it read as the summary asked for?", artifacts: ["path"] },
        ],
      },
      async (root) => {
        await writeFile(join(root, "summary.txt"), "done");
        return { success: true, path: "summary.txt" };
      },
    );
    expect(distinct(points)).toEqual([
      { ...parked, error: "interrupted_mutation_requires_reconciliation" },
      {
        status: "recovery_required",
        error: "semantic_judgement_expired",
        receipts: ["independent_reobservation"],
        certificate: "RECOVERY_REQUIRED",
        committed: true,
        drawn: 1,
      },
      { status: "waiting_user", receipts: ["live"], certificate: "WAITING_USER", committed: true, drawn: 1 },
    ]);
  });
});
