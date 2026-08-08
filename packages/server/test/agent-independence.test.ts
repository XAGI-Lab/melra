// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Agent independence: the claim that distinguishes a kernel from a server.
//
// Everything else in the suite exercises one client against one runtime. What
// is unproven there is that the *harness* is replaceable — that policy, durable
// state, approvals and receipts belong to MELRA rather than to whichever client
// happened to open the session. So this file drives one effect through two
// deliberately mismatched harnesses:
//
//   A — a real child process over stdio, speaking the ordinary tool names a
//       harness already knows (`write_file`, `approve`).
//   B — an in-process loopback HTTP server on a second runtime object over the
//       same data directory, speaking the kernel vocabulary (`melra_plan`,
//       `melra_execute`).
//   C — the CLI, which speaks no MCP at all.
//
// Different transport, different vocabulary, different client, different
// runtime instance. If the kernel is the kernel, an effect planned under A can
// only be finished under B on A's terms, and C reads back the same receipt.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskRecord } from "@melra/protocol";
import { createMelraRuntime, serveHttp } from "../src/index.js";
import type { MelraHttpServer } from "../src/http-server.js";
import type { MelraRuntime } from "../src/runtime.js";

const run = promisify(execFile);
const rootPackage = resolve(import.meta.dirname, "../../..");
const cli = join(rootPackage, "apps/cli/dist/bin.js");
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function parsed<T>(result: unknown): T {
  const tool = result as ToolResult;
  const text = tool.content.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error("missing_text_tool_result");
  if (tool.isError === true) throw new Error(text);
  return JSON.parse(text) as T;
}

describe("one kernel underneath two harnesses", () => {
  let workspace: string;
  let home: string;
  let policyPath: string;
  let childEnvironment: Record<string, string>;

  // Harness A: another process, ordinary tool names.
  let harnessA: Client | undefined;
  let transportA: StdioClientTransport;

  // Harness B: another transport, another runtime object, kernel vocabulary.
  let runtimeB: MelraRuntime;
  let httpB: MelraHttpServer;
  let harnessB: Client;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "melra-independence-"));
    home = join(workspace, ".data");
    policyPath = join(workspace, "policy.json");
    await writeFile(
      policyPath,
      `${JSON.stringify(
        {
          version: "agent-independence",
          workspaceRoot: workspace,
          allowedCommands: [],
          allowedDomains: [],
          allowLocalhost: false,
          mutations: "confirm",
          approvalTtlMs: 300_000,
          maxFileBytes: 1_000_000,
        },
        null,
        2,
      )}\n`,
    );
    childEnvironment = {
      ...inherited,
      MELRA_WORKSPACE: workspace,
      MELRA_HOME: home,
      MELRA_POLICY: policyPath,
      MELRA_HARNESS_TOOLS: "1",
    };

    transportA = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "serve"],
      cwd: rootPackage,
      env: childEnvironment,
      stderr: "pipe",
    });
    harnessA = new Client({ name: "harness-a", version: "1.0.0" });
    await harnessA.connect(transportA);

    runtimeB = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: home,
      policyPath,
    });
    httpB = await serveHttp({
      runtime: runtimeB,
      port: 0,
      token: "independence-token",
      environment: {},
    });
    harnessB = new Client({ name: "harness-b", version: "1.0.0" });
    await harnessB.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://${httpB.host}:${httpB.port}/mcp`),
        {
          requestInit: {
            headers: { authorization: "Bearer independence-token" },
          },
        },
      ),
    );
  }, 60_000);

  afterAll(async () => {
    await harnessA?.close();
    await harnessB.close();
    await httpB.close();
    await runtimeB.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const statusFromB = async (taskId: string): Promise<TaskRecord> =>
    parsed<TaskRecord>(
      await harnessB.callTool({ name: "melra_task_status", arguments: { taskId } }),
    );

  it("sees two vocabularies over two transports", async () => {
    const a = (await harnessA!.listTools()).tools.map((tool) => tool.name);
    const b = (await harnessB.listTools()).tools.map((tool) => tool.name);
    expect(a).toContain("write_file");
    expect(b).not.toContain("write_file");
    expect(b).toContain("melra_plan");
    // Both still carry the kernel surface — the adapter is additive, so a
    // harness is never offered a door that skips a stage.
    expect(a).toEqual(expect.arrayContaining(b));
  });

  it("derives one contract however the effect was asked for", async () => {
    const operation = {
      kind: "file",
      action: "write",
      path: "contract.txt",
      content: "same effect, two vocabularies\n",
    };
    const viaAdapter = parsed<{ taskId: string; status: string }>(
      await harnessA!.callTool({
        name: "write_file",
        arguments: { path: operation.path, content: operation.content },
      }),
    );
    const planned = parsed<TaskRecord>(
      await harnessB.callTool({
        name: "melra_plan",
        arguments: { goal: "Write contract.txt", operation },
      }),
    );

    expect(viaAdapter.status).toBe("approval_required");
    expect(planned.status).toBe("awaiting_approval");

    // Read both back through the same client, so any difference is a difference
    // in what was stored rather than in what each surface chose to report.
    const stored = await statusFromB(viaAdapter.taskId);
    const viaKernel = await statusFromB(planned.id);
    expect(stored.request.operation).toEqual(viaKernel.request.operation);
    expect(stored.request.requiredEvidence).toEqual(
      viaKernel.request.requiredEvidence,
    );
    expect(stored.policyDecision.effect).toBe(viaKernel.policyDecision.effect);
    expect(stored.policyDecision.risk).toBe(viaKernel.policyDecision.risk);
    expect(stored.policyDecision.decision).toBe(
      viaKernel.policyDecision.decision,
    );
    // Two plans of the same effect are two tasks. The kernel does not merge
    // them, and neither approval can run the other.
    expect(stored.id).not.toBe(viaKernel.id);
  });

  let swapped: string;

  it("finishes under the second harness what the first planned, once the first is gone", async () => {
    const held = parsed<{ taskId: string; phrase: string; status: string }>(
      await harnessA!.callTool({
        name: "write_file",
        arguments: { path: "swapped.txt", content: "written after the swap\n" },
      }),
    );
    expect(held.status).toBe("approval_required");
    swapped = held.taskId;

    // The harness that asked is now gone: process closed, session ended.
    await harnessA!.close();
    harnessA = undefined;

    const pending = await statusFromB(swapped);
    expect(pending.status).toBe("awaiting_approval");
    expect(pending.approval).toBeDefined();

    // Same phrase, different transport, different vocabulary, different
    // runtime object. A wrong one still fails, so the swap did not loosen it.
    const refused = (await harnessB.callTool({
      name: "melra_execute",
      arguments: {
        taskId: swapped,
        approval: {
          approvalId: pending.approval!.approvalId,
          phrase: `${pending.approval!.phrase} please`,
        },
      },
    })) as ToolResult;
    expect(refused.isError).toBe(true);
    await expect(readFile(join(workspace, "swapped.txt"), "utf8")).rejects.toThrow();

    const executed = parsed<{ task: TaskRecord }>(
      await harnessB.callTool({
        name: "melra_execute",
        arguments: {
          taskId: swapped,
          approval: {
            approvalId: pending.approval!.approvalId,
            phrase: pending.approval!.phrase,
          },
        },
      }),
    );
    expect(executed.task.status).toBe("verified_success");
    expect(await readFile(join(workspace, "swapped.txt"), "utf8")).toBe(
      "written after the swap\n",
    );
    expect(executed.task.receiptIds).toHaveLength(1);
  }, 60_000);

  it("reads the same receipt from a client that speaks no MCP", async () => {
    const { stdout } = await run(process.execPath, [cli, "inspect", swapped], {
      cwd: rootPackage,
      env: childEnvironment,
    });
    const seen = JSON.parse(stdout) as {
      task: TaskRecord;
      receipts: Array<{ receiptId: string }>;
      certificate?: { result: string; digest: string };
    };
    expect(seen.task.status).toBe("verified_success");
    expect(seen.receipts).toHaveLength(1);
    expect(seen.receipts[0]!.receiptId).toBe(seen.task.receiptIds[0]);
    expect(seen.certificate?.result).toBe("VERIFIED_SUCCESS");
    expect(seen.certificate?.digest).toMatch(/^[a-f0-9]{64}$/);
  }, 60_000);
});
