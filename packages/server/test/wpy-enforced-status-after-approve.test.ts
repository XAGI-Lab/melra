// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Liveness in enforced mode: once an operator approved a task with `melra
// approve`, the agent's melra_task_status must say so, or an agent that reads
// status before running never learns it may execute.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, createMelraRuntime } from "../src/index.js";
import type { MelraRuntime } from "../src/runtime.js";

type Result = { isError?: boolean; content: { text: string }[] };

const directories: string[] = [];
const runtimes: MelraRuntime[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function home() {
  const base = mkdtempSync(join(tmpdir(), "melra-wpy-status-"));
  directories.push(base);
  mkdirSync(join(base, "ws"));
  writeFileSync(join(base, "policy.json"), JSON.stringify({ mode: "enforced" }));
  const open = async () => {
    const runtime = await createMelraRuntime({
      workspaceRoot: join(base, "ws"),
      dataDirectory: join(base, "home"),
      policyPath: join(base, "policy.json"),
      environment: {},
    });
    runtimes.push(runtime);
    return runtime;
  };
  return { open };
}

async function session(runtime: MelraRuntime) {
  const [left, right] = InMemoryTransport.createLinkedPair();
  await createMcpServer(runtime).connect(right);
  const client = new Client({ name: "wpy-status", version: "0.0.0" });
  await client.connect(left);
  clients.push(client);
  return async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as Result;
    const text = result.content[0]!.text;
    return { ok: result.isError !== true, text, value: result.isError === true ? {} : JSON.parse(text) };
  };
}

describe("enforced mode: status after an operator's approve", () => {
  it("shows the agent a usable operator decision, which then runs on a bare melra_execute", async () => {
    const { open } = await home();
    const agentSide = await open();
    const call = await session(agentSide);
    const planned = await call("melra_plan", {
      goal: "Write w.txt",
      operation: { kind: "file", action: "write", path: "w.txt", content: "x" },
      requiredEvidence: [{ type: "file_exists", path: "w.txt" }],
    });
    const taskId = String(planned.value.id);
    expect(planned.value.status).toBe("awaiting_approval");
    const before = await call("melra_task_status", { taskId });
    expect(before.value.approvalDecision).toBeUndefined();

    // The operator: another process on the same home, as `melra approve` is.
    const operator = await open();
    const view = operator.controller.approvalView(taskId);
    await operator.controller.decide(taskId, view.renderDigest, "cli:operator");

    const after = await call("melra_task_status", { taskId });
    expect(after.value.status).toBe("awaiting_approval");
    expect(after.value.approvalDecision).toMatchObject({ channel: "out_of_band", approver: "cli:operator" });
    expect(typeof after.value.approvalDecision.decidedAt).toBe("string");
    expect(typeof after.value.approvalDecision.usableUntil).toBe("string");
    // Nothing the agent could carry into another approval: no digest of the render, no policy digest.
    expect(after.text).not.toContain(view.renderDigest);
    expect(after.value.approvalDecision.renderDigest).toBeUndefined();
    expect(after.value.approvalDecision.policyDigest).toBeUndefined();
    // Still nothing the agent sends counts as a yes.
    const phrase = `APPROVE ${String(planned.value.approval.actionDigest).slice(0, 12)}`;
    const forged = await call("melra_execute", { taskId, approval: { approvalId: planned.value.approval.approvalId, phrase } });
    expect(forged.text).toContain("approval_in_band_refused");

    const ran = await call("melra_execute", { taskId });
    expect(ran.value.task.status).toBe("verified_success");
    const done = await call("melra_task_status", { taskId });
    expect(done.value.approvalDecision).toBeUndefined();
    expect(done.value.approvedBy).toMatchObject({ channel: "out_of_band", approver: "cli:operator" });
  });
});
