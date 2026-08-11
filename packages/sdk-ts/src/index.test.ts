// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { WorkflowDefinitionSchema } from "@melra/protocol";
import { MelraClient, parseMelraToolResult } from "./index.js";

describe("TypeScript SDK result parsing", () => {
  it("parses the server's JSON text contract", () => {
    expect(
      parseMelraToolResult({
        content: [{ type: "text", text: '{"verified":true}' }],
      }),
    ).toEqual({ verified: true });
  });

  it("does not hide MCP tool errors", () => {
    expect(() =>
      parseMelraToolResult({
        isError: true,
        content: [{ type: "text", text: "approval_required" }],
      }),
    ).toThrow("approval_required");
  });
});

describe("TypeScript workflow SDK", () => {
  it("calls the exact workflow tools with typed arguments", async () => {
    const workflowId = "11111111-1111-4111-8111-111111111111";
    const traceId = "22222222-2222-4222-8222-222222222222";
    const definition = WorkflowDefinitionSchema.parse({
      schemaVersion: "1.0.0",
      id: "33333333-3333-4333-8333-333333333333",
      version: 1,
      name: "SDK workflow",
      nodes: [
        {
          id: "inspect",
          type: "operation",
          request: {
            goal: "Inspect",
            operation: { kind: "system", action: "info" },
          },
        },
      ],
    });
    const run = {
      schemaVersion: "1.0.0",
      id: workflowId,
      definitionId: definition.id,
      definitionVersion: 1,
      status: "planned",
      stateVersion: 2,
      nodes: { inspect: { status: "pending", taskIds: [] } },
      traceId,
      createdAt: "2026-07-30T12:00:00.000Z",
      updatedAt: "2026-07-30T12:00:00.000Z",
    };
    const callTool = vi.fn(async ({ name }: { name: string }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            name === "melra_workflow_advance"
              ? { run, tasks: [], events: [] }
              : run,
          ),
        },
      ],
    }));
    const client = new (MelraClient as unknown as new (
      client: { callTool: typeof callTool; close(): Promise<void> },
    ) => MelraClient)({
      callTool,
      async close() {},
    });
    const approval = {
      approvalId: "44444444-4444-4444-8444-444444444444",
      phrase: "APPROVE exact",
    };

    const answer = {
      nodeId: "inspect",
      value: "ship it",
    };

    await client.planWorkflow(definition);
    await client.advanceWorkflow(workflowId, [approval], [answer]);
    await client.workflowStatus(workflowId);
    await client.controlWorkflow(workflowId, "pause");
    await client.cancelWorkflow(workflowId);

    expect(callTool.mock.calls.map(([input]) => input)).toEqual([
      {
        name: "melra_workflow_plan",
        arguments: { definition },
      },
      {
        name: "melra_workflow_advance",
        arguments: { workflowId, approvals: [approval], inputs: [answer] },
      },
      {
        name: "melra_workflow_status",
        arguments: { workflowId },
      },
      {
        name: "melra_workflow_control",
        arguments: { workflowId, action: "pause" },
      },
      {
        name: "melra_workflow_cancel",
        arguments: { workflowId },
      },
    ]);
  });

  it("plans a definition written by hand, defaults and all", async () => {
    const run = {
      schemaVersion: "1.0.0",
      id: "55555555-5555-4555-8555-555555555555",
      definitionId: "66666666-6666-4666-8666-666666666666",
      definitionVersion: 1,
      status: "planned",
      stateVersion: 2,
      nodes: { inspect: { status: "pending", taskIds: [] } },
      traceId: "77777777-7777-4777-8777-777777777777",
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
    };
    const callTool = vi.fn(
      async (_input: { name: string; arguments: Record<string, unknown> }) => ({
        content: [{ type: "text", text: JSON.stringify(run) }],
      }),
    );
    const client = new (MelraClient as unknown as new (
      client: { callTool: typeof callTool; close(): Promise<void> },
    ) => MelraClient)({ callTool, async close() {} });

    // No `dependsOn`, `constraints`, `forbiddenEffects`, `requiredEvidence`, or
    // `budget`. Requiring those would mean writing out `constraints: []` — where
    // any other value is a policy deny — just to satisfy the compiler.
    await client.planWorkflow({
      schemaVersion: "1.0.0",
      id: run.definitionId,
      version: 1,
      name: "Handwritten workflow",
      nodes: [
        {
          id: "inspect",
          type: "operation",
          request: {
            goal: "Inspect",
            operation: { kind: "system", action: "info" },
          },
        },
      ],
    });

    // The server still receives the complete definition, so the defaults are
    // applied once here rather than differing per caller.
    expect(callTool.mock.calls[0]?.[0]).toEqual({
      name: "melra_workflow_plan",
      arguments: {
        definition: {
          schemaVersion: "1.0.0",
          id: run.definitionId,
          version: 1,
          name: "Handwritten workflow",
          nodes: [
            {
              id: "inspect",
              type: "operation",
              dependsOn: [],
              request: {
                goal: "Inspect",
                operation: { kind: "system", action: "info" },
                constraints: [],
                forbiddenEffects: [],
                requiredEvidence: [],
                reconciliation: [],
                budget: { maxSteps: 10, maxDurationMs: 120_000, maxRetries: 2 },
              },
            },
          ],
        },
      },
    });
  });

  it("names the missing receipt selector without a round trip", async () => {
    const callTool = vi.fn();
    const client = new (MelraClient as unknown as new (
      client: { callTool: typeof callTool; close(): Promise<void> },
    ) => MelraClient)({ callTool, async close() {} });
    await expect(client.receipt({})).rejects.toThrow(
      "taskId or receiptId is required",
    );
    expect(callTool).not.toHaveBeenCalled();
  });
});
