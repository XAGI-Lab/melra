// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("sends a verdict to melra_task_judge, and refuses one with no judge before sending it", async () => {
    const callTool = vi.fn(async (_input: { name: string; arguments: Record<string, unknown> }) => ({
      content: [{ type: "text", text: JSON.stringify({ task: { status: "verified_success" } }) }],
    }));
    const client = new (MelraClient as unknown as new (
      client: { callTool: typeof callTool; close(): Promise<void> },
    ) => MelraClient)({ callTool, async close() {} });
    const verdict = {
      taskId: "88888888-8888-4888-8888-888888888888",
      judgementId: "99999999-9999-4999-8999-999999999999",
      verdict: "yes" as const,
    };
    await expect(
      client.judge({ ...verdict, identity: { principal: { kind: "agent", id: "grader" } } }),
    ).resolves.toEqual({ task: { status: "verified_success" } });
    expect(callTool.mock.calls[0]?.[0]).toEqual({
      name: "melra_task_judge",
      arguments: { ...verdict, identity: { principal: { kind: "agent", id: "grader" }, onBehalfOf: [] } },
    });
    await expect(client.judge(verdict as Parameters<MelraClient["judge"]>[0])).rejects.toThrow();
    expect(callTool).toHaveBeenCalledTimes(1);
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

describe("TypeScript SDK stdio connect", () => {
  it("waits for execute as long as runTimeoutMs, not the MCP client's 60 s default", async () => {
    // A stand-in server whose execute takes 1.5 s, as a long build would take minutes.
    const mcp = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
    const stdio = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
    const slow = [
      `const { McpServer } = await import(${JSON.stringify(mcp)});`,
      `const { StdioServerTransport } = await import(${JSON.stringify(stdio)});`,
      `const server = new McpServer({ name: "slow", version: "1" });`,
      `server.tool("melra_execute", async () => { await new Promise((done) => setTimeout(done, 1500)); return { content: [{ type: "text", text: "{\\"done\\":true}" }] }; });`,
      `await server.connect(new StdioServerTransport());`,
    ].join("\n");
    const connect = (runTimeoutMs: number) =>
      MelraClient.connect({ command: process.execPath, args: ["--input-type=module", "-e", slow], runTimeoutMs });

    const impatient = await connect(500);
    try {
      // Honoured: a short limit really does cut the call off.
      await expect(impatient.execute("task")).rejects.toThrow(/timed out/i);
    } finally {
      await impatient.close();
    }
    const patient = await connect(5_000);
    try {
      await expect(patient.execute("task")).resolves.toEqual({ done: true });
    } finally {
      await patient.close();
    }
  }, 20_000);

  it("refuses a runTimeoutMs that would fire at once, before starting anything", async () => {
    // Each of these becomes a 1 ms timer: every execute() would time out while
    // the server went on and ran the effect.
    for (const runTimeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      await expect(
        MelraClient.connect({ command: "/nonexistent/melra", runTimeoutMs }),
        String(runTimeoutMs),
      ).rejects.toThrow("melra_run_timeout_invalid");
    }
  });

  it("says why the server it started refused to start", async () => {
    // What `melra serve` prints for a bad policy, then exits 1.
    const refuse =
      'process.stderr.write("melra: policy_invalid: /p/policy.json: approvalTtlMs: policy_approval_ttl_invalid: must be a whole number\\n"); process.exit(1)';
    await expect(MelraClient.connect({ command: process.execPath, args: ["-e", refuse] })).rejects.toThrow(
      /the server said: melra: policy_invalid: \/p\/policy\.json: approvalTtlMs: policy_approval_ttl_invalid/,
    );
  });

  it("passes this process's environment, all but what would redirect or widen the server (#382)", async () => {
    // A stand-in server that records what it was given and exits; connecting
    // fails, which is fine, the spawn is what is under test.
    const directory = mkdtempSync(join(tmpdir(), "melra-sdk-env-"));
    const out = join(directory, "env.json");
    const set = {
      MELRA_MODE: "enforced",
      MELRA_SOCKET: join(directory, "s.sock"),
      MELRA_UNHINGED: "1",
      MELRA_WORKSPACE: "/elsewhere",
      // What a policy's `{ "source": { "env": ... } }` credential and the browser read.
      PARITY_TOKEN: "inherited",
      MELRA_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
      PARITY_GIVEN: "inherited",
    };
    const names = [...Object.keys(set), "melra_unhinged", "Melra_Socket"];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, set);
    const spawned = async (options: { cwd?: string; env?: Record<string, string> }) => {
      rmSync(out, { force: true });
      const record = `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`;
      await expect(
        MelraClient.connect({ command: process.execPath, args: ["-e", record], ...options }),
      ).rejects.toThrow();
      return JSON.parse(readFileSync(out, "utf8")) as Record<string, string | undefined>;
    };
    try {
      const seen = await spawned({ cwd: directory, env: { PARITY_GIVEN: "given" } });
      expect(seen.MELRA_MODE).toBe("enforced");
      expect(seen.PARITY_TOKEN).toBe("inherited");
      expect(seen.MELRA_BROWSER_CDP_ENDPOINT).toBe("http://127.0.0.1:9222");
      // `env` goes on top.
      expect(seen.PARITY_GIVEN).toBe("given");
      expect(seen.MELRA_SOCKET).toBeUndefined();
      expect(seen.MELRA_UNHINGED).toBeUndefined();
      // `cwd` decides the workspace.
      expect(seen.MELRA_WORKSPACE).toBeUndefined();

      // Without `cwd` the inherited workspace stands, and `env` can mean MELRA_UNHINGED.
      const asked = await spawned({ env: { MELRA_UNHINGED: "1" } });
      expect(asked.MELRA_WORKSPACE).toBe("/elsewhere");
      expect(asked.MELRA_UNHINGED).toBe("1");

      // Any spelling: on Windows `set melra_unhinged=1` is MELRA_UNHINGED, under
      // that name. Alone, since there one would overwrite the other.
      delete process.env.MELRA_SOCKET;
      delete process.env.MELRA_UNHINGED;
      Object.assign(process.env, { melra_unhinged: "1", Melra_Socket: join(directory, "s.sock") });
      const spelled = Object.keys(await spawned({ cwd: directory }));
      expect(spelled.filter((name) => ["MELRA_SOCKET", "MELRA_UNHINGED"].includes(name.toUpperCase()))).toEqual([]);
    } finally {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
