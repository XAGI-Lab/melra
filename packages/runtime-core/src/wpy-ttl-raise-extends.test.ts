// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRequestSchema, type TaskRequest } from "@melra/protocol";
import { createDefaultPolicy, type LocalPolicy } from "@melra/policy-core";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import { PayloadCipher } from "./payload-cipher.js";
import { TaskController } from "./task-controller.js";

/**
 * WPY claim [ttl-raise-extends] (approval freshness, paper class: stale yes).
 *
 * OLD behaviour (6ccff05): `TaskController.usable()` measured a recorded
 * decision's freshness as `Date.now() < decidedAt + approvalTtl(this.policy)`:
 * the TTL of the process that EXECUTES, read at execute time, not the TTL in
 * force when the person said yes. So
 *   (a) raising `approvalTtlMs` (up to 24 h) after a decision, e.g. a restart
 *       with an edited policy.json, revived every outstanding yes;
 *   (b) a yes given just before the challenge expires ran up to ~2 x TTL
 *       after the plan (documented in ARCHITECTURE.md: "usable for a TTL
 *       after it was made").
 *
 * FIXED: `decide()` stamps each decision with its own `usableUntil`
 * (decidedAt + the TTL then in force), and `usable()` takes the earlier of
 * that and decidedAt + the current TTL, so a raised TTL extends nothing and a
 * lowered one still shortens. A decision with no stamp (written by an older
 * MELRA) is judged by the current TTL, as before. (b) is unchanged: it is the
 * documented window.
 */
const roots: string[] = [];
const stores: SqliteStore[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// One data directory (store + key) that several "processes" open in turn.
async function dataDir() {
  const root = await mkdtemp(join(tmpdir(), "melra-wpy-ttl-"));
  roots.push(root);
  const store = new SqliteStore(":memory:");
  stores.push(store);
  const cipher = new PayloadCipher(Buffer.alloc(32, 9));
  const verifier = await Verifier.create(root, {});
  const open = (policy: Partial<LocalPolicy>) =>
    new TaskController(
      store,
      { ...createDefaultPolicy(root), ...policy },
      { execute: async () => ({ success: true, stored: true }) },
      verifier,
      cipher,
    );
  return { store, open };
}

const put = (key: string): TaskRequest =>
  TaskRequestSchema.parse({
    goal: `Put ${key}`,
    operation: { kind: "memory", action: "put", key, value: key },
    requiredEvidence: [{ type: "result_equals", path: "stored", value: true }],
  });

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("[ttl-raise-extends] decision freshness is fixed when the yes is given", () => {
  for (const mode of ["developer", "enforced"] as const) {
    it(`a TTL raised after the yes does not extend it: dead at 1 min TTL, still dead at 24 h TTL (${mode})`, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { open, store } = await dataDir();

      // Process A: operator policy says a yes is good for 1 minute.
      const a = open({ mode, approvalTtlMs: MIN });
      const stale = await a.plan(put("stale"));
      const control = await a.plan(put("control"));
      await a.decide(stale.id, a.approvalView(stale.id).renderDigest, "cli:alice");
      await a.decide(control.id, a.approvalView(control.id).renderDigest, "cli:alice");

      // An hour passes. Under the policy the person approved under, both
      // decisions are long dead.
      vi.advanceTimersByTime(HOUR);
      await expect(a.execute(control.id)).rejects.toThrow("approval_expired");

      // Process B: same data directory, policy.json edited to the 24 h maximum
      // (a restart, or a second server with a different policy). OLD: the
      // hour-old yes, given under a 1-minute window, ran to verified_success.
      const b = open({ mode, approvalTtlMs: 24 * HOUR });
      await expect(b.execute(stale.id)).rejects.toThrow("approval_expired");
      expect(store.getApprovalDecision(b.status(stale.id).approval!.approvalId)?.usableUntil).toBeDefined();
      expect(b.status(stale.id).status).toBe("awaiting_approval");
    });
  }

  it("deleting the pinned 300000 key (as INSTALLATION.md advises) in enforced mode -> 30 min default no longer extends it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { open } = await dataDir();
    // An older policy.json pins approvalTtlMs: 300000 (5 min).
    const a = open({ mode: "enforced", approvalTtlMs: 5 * MIN });
    const t = await a.plan(put("mode"));
    await a.decide(t.id, a.approvalView(t.id).renderDigest, "cli:alice");
    vi.advanceTimersByTime(20 * MIN);
    await expect(a.execute(t.id)).rejects.toThrow("approval_expired");
    // The key is deleted and the server restarted: enforced default, 30 min.
    // OLD: the 20-minute-old yes ran.
    const b = open({ mode: "enforced" });
    await expect(b.execute(t.id)).rejects.toThrow("approval_expired");
  });

  it("a TTL lowered after the yes still shortens it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { open } = await dataDir();
    const a = open({ approvalTtlMs: HOUR });
    const t = await a.plan(put("short"));
    await a.decide(t.id, a.approvalView(t.id).renderDigest, "cli:alice");
    vi.advanceTimersByTime(10 * MIN);
    await expect(open({ approvalTtlMs: 5 * MIN }).execute(t.id)).rejects.toThrow("approval_expired");
    expect((await a.execute(t.id)).task.status).toBe("verified_success");
  });

  it("a decision with no stamp (an older MELRA's) is judged by the current TTL, as before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { open, store } = await dataDir();
    const a = open({ approvalTtlMs: MIN });
    const t = await a.plan(put("legacy"));
    const view = a.approvalView(t.id);
    // What an older MELRA writes: the decision row alone, no terms.
    store.recordApprovalDecision({
      approvalId: view.task.approval!.approvalId,
      taskId: t.id,
      renderDigest: view.renderDigest,
      channel: "in_band",
      approver: "cli:older",
      decidedAt: new Date().toISOString(),
    });
    vi.advanceTimersByTime(HOUR);
    await expect(a.execute(t.id)).rejects.toThrow("approval_expired");
    expect((await open({ approvalTtlMs: 24 * HOUR }).execute(t.id)).task.status).toBe("verified_success");
  });

  it("with no policy change, a yes just before expiry runs ~2 x TTL after the plan", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { open } = await dataDir();
    const ttl = MIN;
    const a = open({ approvalTtlMs: ttl });
    const t = await a.plan(put("late"));
    vi.advanceTimersByTime(ttl - 1); // challenge still open by 1 ms
    await a.decide(t.id, a.approvalView(t.id).renderDigest, "cli:alice");
    vi.advanceTimersByTime(ttl - 2); // 2 x TTL - 3 ms after the plan
    expect((await a.execute(t.id)).task.status).toBe("verified_success");
  });
});
