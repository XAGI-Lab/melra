// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskRequestSchema,
  WorkflowDefinitionSchema,
  outcomeUnknown,
  type TaskRequest,
} from "@melra/protocol";
import { createDefaultPolicy, type LocalPolicy } from "@melra/policy-core";
import { sha256 } from "@melra/receipt-schema";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier, type EvidenceProbe } from "@melra/verifier-core";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";
import { WorkflowController } from "./workflow-controller.js";

/**
 * A receipt used to say only which challenge a task ran under, never who
 * answered it or how: an echoed phrase, which anything that knows the task
 * can compute, looked the same as a person's yes. Decisions an operator
 * records now carry their channel, approver and what they were shown.
 */
const roots: string[] = [];
const stores: SqliteStore[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(
  policy: Partial<LocalPolicy> = {},
  execute: () => Promise<Record<string, unknown>> = async () => ({ success: true, stored: true }),
  probe?: EvidenceProbe,
) {
  const root = await mkdtemp(join(tmpdir(), "melra-approval-"));
  roots.push(root);
  const store = new SqliteStore(":memory:");
  stores.push(store);
  const cipher = new PayloadCipher(Buffer.alloc(32, 9));
  const tasks = new TaskController(
    store,
    { ...createDefaultPolicy(root), ...policy },
    { execute },
    await Verifier.create(root, probe === undefined ? {} : { probe }),
    cipher,
  );
  return { root, store, cipher, tasks };
}

const put = (key: string): TaskRequest =>
  TaskRequestSchema.parse({
    goal: `Put ${key}`,
    operation: { kind: "memory", action: "put", key, value: key },
    requiredEvidence: [{ type: "result_equals", path: "stored", value: true }],
  });

describe("operator approval decisions", () => {
  for (const mode of ["developer", "enforced"] as const) {
    it(`runs a mutation on an operator's decision and receipts who decided (${mode})`, async () => {
      const { tasks, store } = await setup({ mode });
      const planned = tasks.plan(put("ledger"));
      const view = tasks.approvalView(planned.id);
      const decision = tasks.decide(planned.id, view.renderDigest, "cli:test");
      const done = await tasks.execute(planned.id);

      expect(done.task.status).toBe("verified_success");
      const channel = mode === "enforced" ? "out_of_band" : "in_band";
      expect(done.receipt?.policyDecision).toMatchObject({
        approvalId: planned.approval!.approvalId,
        approval: { channel, approver: "cli:test", renderDigest: view.renderDigest, decidedAt: decision.decidedAt },
      });
      expect(done.certificate).toMatchObject({ mode, approvalChannel: channel });
      expect(store.getTask(planned.id)?.approvedBy?.approver).toBe("cli:test");
      // The new fields are inside what the certificate's digest seals.
      const { digest, ...body } = done.certificate!;
      expect(sha256(body)).toBe(digest);
    });
  }

  it("refuses a decision that does not match what is pending", async () => {
    const { tasks, store } = await setup();
    const planned = tasks.plan(put("ledger"));
    expect(() => tasks.decide(planned.id, "0".repeat(64), "cli:test")).toThrow("approval_render_mismatch");
    const view = tasks.approvalView(planned.id);
    tasks.decide(planned.id, view.renderDigest, "cli:first");
    expect(() => tasks.decide(planned.id, view.renderDigest, "cli:second")).toThrow("approval_already_decided");
    expect(store.getApprovalDecision(planned.approval!.approvalId)?.approver).toBe("cli:first");
    const read = tasks.plan(TaskRequestSchema.parse({ goal: "Inspect", operation: { kind: "system", action: "info" } }));
    expect(() => tasks.decide(read.id, view.renderDigest, "cli:test")).toThrow("task_not_awaiting_approval:planned");
    expect(store.getTask(planned.id)?.status).toBe("awaiting_approval");
  });

  it("refuses a decision once the challenge has expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { tasks } = await setup({ approvalTtlMs: 1_000 });
    const planned = tasks.plan(put("ledger"));
    const view = tasks.approvalView(planned.id);
    vi.advanceTimersByTime(2_000);
    expect(() => tasks.decide(planned.id, view.renderDigest, "cli:test")).toThrow("approval_expired");
  });

  it("honours a decision made in time for a TTL after it was made", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { tasks, store } = await setup({ approvalTtlMs: 60_000 });
    const [early, late, tardy] = [tasks.plan(put("early")), tasks.plan(put("late")), tasks.plan(put("tardy"))];
    vi.advanceTimersByTime(59_000);
    tasks.decide(early.id, tasks.approvalView(early.id).renderDigest, "cli:test");
    tasks.decide(late.id, tasks.approvalView(late.id).renderDigest, "cli:test");
    // Past the challenge's expiry, within the decision's TTL.
    vi.advanceTimersByTime(31_000);
    expect((await tasks.execute(early.id)).task.status).toBe("verified_success");
    // 119.5 s: past decidedAt + TTL (119 s), still before expiresAt + TTL
    // (120 s), so the TTL is measured from the decision, not the expiry.
    vi.advanceTimersByTime(29_500);
    await expect(tasks.execute(late.id)).rejects.toThrow("approval_expired");
    // A decision recorded after the challenge expired is never usable.
    store.recordApprovalDecision({
      approvalId: tardy.approval!.approvalId,
      taskId: tardy.id,
      renderDigest: tasks.approvalView(tardy.id).renderDigest,
      channel: "in_band",
      approver: "cli:test",
      decidedAt: new Date(Date.parse(tardy.approval!.expiresAt) + 1).toISOString(),
    });
    await expect(tasks.execute(tardy.id)).rejects.toThrow("approval_expired");
  });

  it("does not run a decision on anything but what was shown", async () => {
    const { tasks, store } = await setup();
    const planned = tasks.plan(put("ledger"));
    store.recordApprovalDecision({
      approvalId: planned.approval!.approvalId,
      taskId: planned.id,
      renderDigest: "f".repeat(64),
      channel: "in_band",
      approver: "cli:test",
      decidedAt: new Date().toISOString(),
    });
    // Even with the right phrase alongside: the recorded decision governs.
    await expect(
      tasks.execute(planned.id, { approvalId: planned.approval!.approvalId, phrase: planned.approval!.phrase! }),
    ).rejects.toThrow("approval_render_mismatch");
  });

  it("claims out of band only where the kernel running the effect enforces it", async () => {
    // One home, two processes: the server in developer mode, a shell in
    // enforced mode recording the decision. Or simply a row the agent wrote.
    const developer = await setup();
    const enforced = new TaskController(
      developer.store,
      { ...createDefaultPolicy(developer.root), mode: "enforced" },
      { execute: async () => ({ success: true, stored: true }) },
      await Verifier.create(developer.root),
      developer.cipher,
    );
    const planned = developer.tasks.plan(put("ledger"));
    enforced.decide(planned.id, enforced.approvalView(planned.id).renderDigest, "cli:test");
    const done = await developer.tasks.execute(planned.id);
    expect(done.receipt?.policyDecision.approval?.channel).toBe("in_band");
    expect(done.certificate).toMatchObject({ mode: "developer", approvalChannel: "in_band" });
  });

  it("takes a task's mode from its first receipt when it ran before the mode was recorded", async () => {
    const probe = async () => ({ status: 200, content: JSON.stringify({ status: "applied" }) });
    const developer = await setup({}, async () => {
      throw outcomeUnknown("socket hang up");
    });
    const enforced = new TaskController(
      developer.store,
      { ...createDefaultPolicy(developer.root), mode: "enforced" },
      { execute: async () => ({ success: true }) },
      await Verifier.create(developer.root, { probe }),
      developer.cipher,
    );
    const planned = developer.tasks.plan(charge());
    await developer.tasks.execute(planned.id, {
      approvalId: planned.approval!.approvalId,
      phrase: planned.approval!.phrase!,
    });
    // As a row an older version wrote: no mode on the task itself.
    const legacy = developer.store.getTask(planned.id)!;
    delete legacy.mode;
    developer.store.saveTask(legacy);
    const settled = await enforced.execute(planned.id);
    expect(settled.receipt?.mode).toBe("developer");
    expect(settled.certificate?.mode).toBe("developer");
  });

  it("keeps the mode an effect ran under on what is written after it", async () => {
    // Run in developer mode, parked on an unknown outcome, settled by an
    // enforced-mode process: the certificate describes the run, not the settler.
    const probe = async () => ({ status: 200, content: JSON.stringify({ status: "applied" }) });
    const developer = await setup({}, async () => {
      throw outcomeUnknown("socket hang up");
    });
    const enforced = new TaskController(
      developer.store,
      { ...createDefaultPolicy(developer.root), mode: "enforced" },
      { execute: async () => ({ success: true }) },
      await Verifier.create(developer.root, { probe }),
      developer.cipher,
    );
    const planned = developer.tasks.plan(charge());
    await developer.tasks.execute(planned.id, {
      approvalId: planned.approval!.approvalId,
      phrase: planned.approval!.phrase!,
    });
    const settled = await enforced.execute(planned.id);
    expect(settled.task.status).toBe("verified_success");
    expect(settled.receipt?.mode).toBe("developer");
    expect(settled.certificate?.mode).toBe("developer");
  });

  it("names how every task was authorised", async () => {
    const { tasks } = await setup();
    const echoed = tasks.plan(put("echoed"));
    const done = await tasks.execute(echoed.id, {
      approvalId: echoed.approval!.approvalId,
      phrase: echoed.approval!.phrase!,
    });
    expect(done.receipt?.policyDecision.approval).toMatchObject({ channel: "in_band", approver: "phrase" });
    expect(done.certificate?.approvalChannel).toBe("in_band");

    const read = tasks.plan(TaskRequestSchema.parse({ goal: "Inspect", operation: { kind: "system", action: "info" } }));
    expect((await tasks.execute(read.id)).certificate?.approvalChannel).toBe("not_required");

    const unhinged = await setup({ unhinged: true });
    const bypassed = unhinged.tasks.plan(put("bypassed"));
    expect((await unhinged.tasks.execute(bypassed.id)).certificate?.approvalChannel).toBe("bypassed");
  });
});

describe("enforced mode refuses in-band approval", () => {
  const forge = (task: { approval?: { approvalId: string; actionDigest: string } }) => ({
    approvalId: task.approval!.approvalId,
    phrase: `APPROVE ${task.approval!.actionDigest.slice(0, 12)}`,
  });

  it("refuses anything the agent sends, and runs only on an operator's decision", async () => {
    const { tasks, store } = await setup({ mode: "enforced" });
    const planned = tasks.plan(put("ledger"));
    expect(planned.approval).not.toHaveProperty("phrase");
    expect(planned.contract.authorization).not.toHaveProperty("phrase");
    await expect(tasks.execute(planned.id, forge(planned))).rejects.toThrow("approval_in_band_refused");
    await expect(tasks.execute(planned.id)).rejects.toThrow("approval_awaiting_operator");
    expect(store.getTask(planned.id)?.status).toBe("awaiting_approval");
    tasks.decide(planned.id, tasks.approvalView(planned.id).renderDigest, "cli:test");
    // Still refused alongside a decision: the agent sending one is the signal.
    await expect(tasks.execute(planned.id, forge(planned))).rejects.toThrow("approval_in_band_refused");
    const done = await tasks.execute(planned.id);
    expect(done.task.status).toBe("verified_success");
    expect(done.receipt?.policyDecision.approval).toMatchObject({ channel: "out_of_band", approver: "cli:test" });
  });

  it("takes no in-band decision and no phrase minted before the switch", async () => {
    const developer = await setup();
    const enforced = new TaskController(
      developer.store,
      { ...createDefaultPolicy(developer.root), mode: "enforced" },
      { execute: async () => ({ success: true, stored: true }) },
      await Verifier.create(developer.root),
      developer.cipher,
    );
    // Planned in developer mode, so its stored challenge still has a phrase.
    const old = developer.tasks.plan(put("old"));
    await expect(
      enforced.execute(old.id, { approvalId: old.approval!.approvalId, phrase: old.approval!.phrase! }),
    ).rejects.toThrow("approval_in_band_refused");
    // A developer-mode process deciding on the same data directory is in band.
    developer.tasks.decide(old.id, developer.tasks.approvalView(old.id).renderDigest, "cli:dev");
    await expect(enforced.execute(old.id)).rejects.toThrow("approval_awaiting_operator");
    expect(enforced.approvalDecision(enforced.status(old.id))).toBeUndefined();
    expect(developer.store.getTask(old.id)?.status).toBe("awaiting_approval");
    // The other way round, a developer-mode yes would burn the one decision an
    // enforced kernel's task can have, so it is refused before it is recorded.
    const fresh = enforced.plan(put("fresh"));
    expect(() => developer.tasks.decide(fresh.id, developer.tasks.approvalView(fresh.id).renderDigest, "cli:dev")).toThrow(
      "approval_needs_enforced_mode",
    );
    expect(developer.store.getApprovalDecision(fresh.approval!.approvalId)).toBeUndefined();
    enforced.decide(fresh.id, enforced.approvalView(fresh.id).renderDigest, "cli:ops");
    expect((await enforced.execute(fresh.id)).task.status).toBe("verified_success");
  });

  it("stops asking the agent to wait once no operator can answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { tasks } = await setup({ mode: "enforced", approvalTtlMs: 1_000 });
    const planned = tasks.plan(put("ledger"));
    await expect(tasks.execute(planned.id)).rejects.toThrow("approval_awaiting_operator");
    // `decide` refuses an expired challenge, so waiting longer would never end.
    vi.advanceTimersByTime(2_000);
    await expect(tasks.execute(planned.id)).rejects.toThrow("approval_expired");
  });

  it("refuses an in-band workflow approval loudly and runs on the operator's", async () => {
    const { tasks, store, cipher } = await setup({ mode: "enforced" });
    const workflows = new WorkflowController(store, tasks, cipher);
    const planned = workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: "66666666-6666-4666-8666-666666666666",
        version: 1,
        name: "Enforced",
        nodes: [
          { id: "gate", type: "approval", forNodeId: "write" },
          { id: "write", type: "operation", dependsOn: ["gate"], request: put("write") },
        ],
      }),
    );
    const waiting = (await workflows.advance(planned.id)).run;
    const gate = Object.values(waiting.nodes).find((node) => node.approval !== undefined)!;
    expect(gate.approval).not.toHaveProperty("phrase");
    expect(JSON.stringify(workflows.events(planned.id))).not.toMatch(/APPROVE [a-f0-9]{12}|"phrase"/);
    const [taskId] = gate.taskIds;
    await expect(workflows.advance(planned.id, [forge(store.getTask(taskId!)!)])).rejects.toThrow(
      "approval_in_band_refused",
    );
    expect(store.getTask(taskId!)?.status).toBe("awaiting_approval");
    expect((await workflows.advance(planned.id)).run.status).toBe("awaiting_approval");
    tasks.decide(taskId!, tasks.approvalView(taskId!).renderDigest, "cli:test");
    let run = (await workflows.advance(planned.id)).run;
    if (run.status !== "verified_complete") run = (await workflows.advance(planned.id)).run;
    expect(run.status).toBe("verified_complete");
    expect(store.getTask(taskId!)?.approvedBy?.channel).toBe("out_of_band");
  });

  it("refuses an in-band workflow approval before any sibling moves", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { tasks, store, cipher } = await setup({ mode: "enforced", approvalTtlMs: 1_000 });
    const workflows = new WorkflowController(store, tasks, cipher);
    const planned = workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: "77777777-7777-4777-8777-777777777777",
        version: 1,
        name: "Two gates",
        nodes: [
          { id: "a", type: "operation", request: put("a") },
          { id: "b", type: "operation", request: put("b") },
        ],
      }),
    );
    const waiting = (await workflows.advance(planned.id)).run;
    const [a] = waiting.nodes.a!.taskIds;
    const [b] = waiting.nodes.b!.taskIds;
    // An operator approves `b`; then `a`'s challenge lapses, so the next wave
    // would cancel and plan `a` again before reaching `b`.
    vi.advanceTimersByTime(900);
    tasks.decide(b!, tasks.approvalView(b!).renderDigest, "cli:ops");
    vi.advanceTimersByTime(200);
    await expect(workflows.advance(planned.id, [forge(store.getTask(b!)!)])).rejects.toThrow(
      "approval_in_band_refused",
    );
    // Refused before the wave: `a` was neither cancelled nor planned again by
    // an advance that was refused.
    expect(store.getTask(a!)?.status).toBe("awaiting_approval");
    expect(store.listTasks()).toHaveLength(2);
    const next = (await workflows.advance(planned.id)).run;
    expect(next.nodes.a!.status).toBe("awaiting_approval");
    expect(next.nodes.a!.taskIds).not.toContain(a);
    expect(next.nodes.b!.status).toBe("verified_complete");
  });
});

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
        // A "not found" settles at once: this provider shows every write.
        settleMs: 0,
      },
    ],
  });

describe("approval on receipts written without a caller", () => {
  /** A charge that was approved, sent, and never answered. */
  async function parked(probe: EvidenceProbe) {
    const context = await setup(
      {},
      async () => {
        throw outcomeUnknown("socket hang up");
      },
      probe,
    );
    const task = context.tasks.plan(charge());
    await context.tasks.execute(task.id, { approvalId: task.approval!.approvalId, phrase: task.approval!.phrase! });
    return { ...context, task };
  }

  it("keeps the approval on a receipt that reconciliation says never happened", async () => {
    const { tasks, task } = await parked(async () => ({ status: 404, content: "{}" }));
    const settled = await tasks.execute(task.id);
    expect(settled.task.status).toBe("failed");
    // Was undefined: the denied receipt dropped who had authorised the attempt.
    expect(settled.receipt?.policyDecision).toMatchObject({
      approvalId: task.approval!.approvalId,
      approval: { channel: "in_band" },
    });
  });

  it("puts the recorded approval, not a made-up one, on a receipt settled later", async () => {
    const { tasks, store, task } = await parked(async () => ({
      status: 200,
      content: JSON.stringify({ status: "applied" }),
    }));
    const settled = await tasks.execute(task.id);
    expect(settled.task.status).toBe("verified_success");
    const recorded = store.getTask(task.id)!.approvedBy!;
    expect(settled.receipt?.policyDecision.approval).toEqual({
      channel: recorded.channel,
      renderDigest: recorded.renderDigest,
      approver: recorded.approver,
      decidedAt: recorded.decidedAt,
    });
  });
});

describe("a refused sibling in a workflow wave", () => {
  it("keeps the changes the other nodes made in the same wave", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { tasks, store, cipher } = await setup({ approvalTtlMs: 1_500 });
    const workflows = new WorkflowController(store, tasks, cipher);
    const planned = workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: "99999999-9999-4999-8999-999999999999",
        version: 1,
        name: "Wave",
        nodes: [
          { id: "x", type: "operation", request: put("x") },
          { id: "loop", type: "bounded_loop", body: [put("l")], maxIterations: 2 },
        ],
      }),
    );
    let run = (await workflows.advance(planned.id)).run;
    const [x1] = run.nodes.x!.taskIds;
    const l0 = store.getTask(run.nodes.loop!.taskIds[0]!)!;
    vi.advanceTimersByTime(900);
    // The loop's first step runs and its second is planned, with a fresh challenge.
    run = (
      await workflows.advance(planned.id, [{ approvalId: l0.approval!.approvalId, phrase: l0.approval!.phrase! }])
    ).run;
    const l1 = store.getTask(run.nodes.loop!.taskIds[1]!)!;
    // `x`'s challenge lapses, the loop's does not.
    vi.advanceTimersByTime(800);
    await expect(
      workflows.advance(planned.id, [{ approvalId: l1.approval!.approvalId, phrase: "APPROVE 000000000000" }]),
    ).rejects.toThrow("approval_phrase_mismatch");
    // `x` was planned again in that wave; the run says so instead of pointing
    // at the task it cancelled, which read as `x` cancelled for good.
    expect(store.getTask(x1!)?.status).toBe("cancelled");
    expect(workflows.status(planned.id).nodes.x!.taskIds).not.toContain(x1);
    expect((await workflows.advance(planned.id)).run.nodes.x!.status).toBe("awaiting_approval");
  });
});

describe("workflow approvals decided by an operator", () => {
  it("runs the approved attempt when the decision beat the expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { tasks, store, cipher } = await setup({ approvalTtlMs: 60_000 });
    const workflows = new WorkflowController(store, tasks, cipher);
    const planned = workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: "55555555-5555-4555-8555-555555555555",
        version: 1,
        name: "Decided",
        nodes: [{ id: "write", type: "operation", request: put("write") }],
      }),
    );
    const waiting = (await workflows.advance(planned.id)).run;
    const [taskId] = waiting.nodes.write!.taskIds;
    vi.advanceTimersByTime(59_000);
    tasks.decide(taskId!, tasks.approvalView(taskId!).renderDigest, "cli:test");
    vi.advanceTimersByTime(31_000);
    // Past the challenge's expiry: before, the node was planned again under a
    // new attempt and the person asked a second time.
    const run = (await workflows.advance(planned.id)).run;
    expect(run.status).toBe("verified_complete");
    expect(run.nodes.write?.taskIds).toEqual([taskId]);
    expect(store.getTask(taskId!)?.attempt).toBe(1);
  });
});
