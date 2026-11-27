// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WPY probe [policy-not-bound] for "Who Pressed Yes? Approval Integrity in AI
 * Agents".
 *
 * Claim: an operator decision was bound to (approvalId, task, keyed action
 * digest, render digest), and the render contract `approvalRender` hashes
 * drops `policy`. `ApprovalDecision` had no policy field. So:
 *   1. a decision recorded while policy P1 governed was honoured by a kernel
 *      running a different policy P2 that still answers `confirm`;
 *   2. if the policy is loosened between plan and execute so the recheck
 *      answers `allow`, the outstanding challenge is never consulted (not even
 *      its expiry): the effect runs, the receipt drops `approvalId`, and the
 *      certificate says `bypassed` (mutation) or `not_required` (read).
 *
 * OLD behaviour (6ccff05) for 1: verified_success, receipt with P2's digest
 * beside P1's approver, nothing recording P1.
 * FIXED for 1: a decision records the policyDigest and mode it was made under
 * (`approval_terms`), and execute refuses `approval_policy_changed` when the
 * kernel running it has another digest or mode.
 * NOT CHANGED, 2: the loosen-to-allow cases below still assert the 6ccff05
 * behaviour. A recheck that answers allow runs the task with no approval;
 * the THREAT_MODEL "A policy changed between effects" row says so.
 *
 * Two TaskControllers on one store and one payload key stand in for "the
 * operator restarted MELRA with another policy file".
 */

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

const roots: string[] = [];
const stores: SqliteStore[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** One home (store + key), and a kernel factory for any policy over it. */
async function home() {
  const root = await mkdtemp(join(tmpdir(), "melra-wpy-policy-"));
  roots.push(root);
  const store = new SqliteStore(":memory:");
  stores.push(store);
  const cipher = new PayloadCipher(Buffer.alloc(32, 9));
  const effects: string[] = [];
  const kernel = async (policy: Partial<LocalPolicy>) =>
    new TaskController(
      store,
      { ...createDefaultPolicy(root), ...policy },
      {
        execute: async (operation) => {
          effects.push(operation.kind);
          return { success: true, stored: true, status: 200 };
        },
      },
      await Verifier.create(root, {}),
      cipher,
    );
  return { store, kernel, effects };
}

const put = (key: string): TaskRequest =>
  TaskRequestSchema.parse({
    goal: `Put ${key}`,
    operation: { kind: "memory", action: "put", key, value: key },
    requiredEvidence: [{ type: "result_equals", path: "stored", value: true }],
  });

const P1 = { version: "1", digest: "sha256:" + "1".repeat(64) };
const P2 = { version: "2", digest: "sha256:" + "2".repeat(64) };

describe("WPY policy-not-bound: a decision is bound to the policy it was made under", () => {
  it("refuses a decision recorded under P1 when executed under a different P2 that still confirms", async () => {
    const { store, kernel, effects } = await home();
    const underP1 = await kernel({ ...P1, mode: "enforced" });
    const planned = await underP1.plan(put("ledger"));
    expect(planned.policyDecision).toMatchObject({ outcome: "confirm", policyDigest: P1.digest });

    // The operator approves what P1's kernel shows them.
    const shownUnderP1 = underP1.approvalView(planned.id).renderDigest;
    await underP1.decide(planned.id, shownUnderP1, "cli:operator");
    // The decision now names the policy and mode it was made under.
    expect(store.getApprovalDecision(planned.approval!.approvalId)).toMatchObject({ policyDigest: P1.digest, mode: "enforced" });

    // MELRA restarted with another policy file (P2) that still says confirm.
    // The render digest is the same (the policy is not in it), but OLD: it
    // ran to verified_success with P2's digest beside P1's approver.
    const underP2 = await kernel({ ...P2, mode: "enforced", allowedCommands: ["sh"] });
    expect(underP2.approvalView(planned.id).renderDigest).toBe(shownUnderP1);
    await expect(underP2.execute(planned.id)).rejects.toThrow("approval_policy_changed");
    expect(effects).toEqual([]);

    // Under the policy it was made under, the same yes runs.
    const back = await kernel({ ...P1, mode: "enforced" });
    expect((await back.execute(planned.id)).task.status).toBe("verified_success");
    expect(effects).toEqual(["memory"]);
  });

  it("runs a confirmed, never-approved mutation once the policy is loosened (unhinged), receipt drops approvalId, certificate says bypassed", async () => {
    const { store, kernel, effects } = await home();
    const planned = await (await kernel({ ...P1, mode: "enforced" })).plan(put("ledger"));
    expect(planned.status).toBe("awaiting_approval");
    expect(planned.approval?.approvalId).toBeDefined();

    // No decision is ever recorded. Policy changes to one whose recheck says allow.
    const loosened = await kernel({ ...P2, mode: "enforced", unhinged: true });
    const done = await loosened.execute(planned.id);

    expect(done.task.status).toBe("verified_success");
    expect(effects).toEqual(["memory"]);
    expect(store.getApprovalDecision(planned.approval!.approvalId)).toBeUndefined();
    // The challenge that was issued and never answered leaves no trace on the receipt.
    expect(done.receipt?.policyDecision.outcome).toBe("allow");
    expect(done.receipt?.policyDecision).not.toHaveProperty("approvalId");
    expect(done.receipt?.policyDecision).not.toHaveProperty("approval");
    expect(done.receipt?.policyDecision.policyDigest).toBe(P2.digest);
    // Docs define `bypassed` as "a mutation unsafe-local allowed with no
    // challenge"; here a challenge existed and was simply skipped.
    expect(done.certificate?.approvalChannel).toBe("bypassed");
  });

  it("does not even check the pending challenge's expiry when the recheck says allow", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { kernel, effects } = await home();
    const planned = await (await kernel({ ...P1, mode: "enforced", approvalTtlMs: 1_000 })).plan(put("stale"));
    vi.advanceTimersByTime(60_000); // challenge long expired, task row not swept
    const done = await (await kernel({ ...P2, mode: "enforced", unhinged: true })).execute(planned.id);
    expect(done.task.status).toBe("verified_success");
    expect(effects).toEqual(["memory"]);
  });

  it("runs a read that was held for approval once P2 lists its host (no unhinged needed), certificate says not_required", async () => {
    const { kernel, effects } = await home();
    const fetch = TaskRequestSchema.parse({
      goal: "Fetch the report",
      operation: { kind: "http", action: "request", method: "GET", url: "https://reports.example.test/q3" },
    });
    // P1: host admitted only by "*", so enforced mode holds the read for a person.
    const planned = await (await kernel({ ...P1, mode: "enforced", allowedDomains: ["*"] })).plan(fetch);
    expect(planned.policyDecision).toMatchObject({ outcome: "confirm", reason: "network_read_unlisted_host" });

    // P2 names the host: the recheck allows, the challenge is never consulted.
    const underP2 = await kernel({ ...P2, mode: "enforced", allowedDomains: ["reports.example.test", "*"] });
    const done = await underP2.execute(planned.id);
    expect(done.task.status).toBe("verified_success");
    expect(effects).toEqual(["http"]);
    expect(done.receipt?.policyDecision).toMatchObject({ outcome: "allow", policyDigest: P2.digest });
    expect(done.receipt?.policyDecision).not.toHaveProperty("approvalId");
    expect(done.certificate?.approvalChannel).toBe("not_required");
  });
});
