// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectBrowserExecutable } from "@melra/browser-runtime";
import { EvidencePredicateSchema, type WorkflowAdvanceResult } from "@melra/protocol";
import { SqliteStore } from "@melra/storage-sqlite";
import { createMelraRuntime } from "../src/runtime.js";

const detectedBrowserExecutable = await detectBrowserExecutable();
const rootPackage = resolve(import.meta.dirname, "../../..");
const cli = join(rootPackage, "apps/cli/dist/bin.js");
// Without MELRA_MODE: the developer-mode cases echo phrases, so a shell in
// enforced mode must not turn them into a different test.
const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== "MELRA_MODE",
  ),
);

interface TextToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function parsed(result: unknown): Record<string, unknown> {
  const tool = result as TextToolResult;
  if (tool.isError === true) {
    throw new Error(tool.content.map((item) => item.text ?? "").join("\n"));
  }
  const text = tool.content.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error("missing_text_tool_result");
  return JSON.parse(text) as Record<string, unknown>;
}

async function connectMcp(
  workspaceRoot: string,
  dataDirectory: string,
  policyPath: string,
): Promise<{
  client: Client;
  transport: StdioClientTransport;
  stderr: string[];
}> {
  const stderr: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "serve"],
    cwd: rootPackage,
    env: {
      ...childEnvironment,
      MELRA_WORKSPACE: workspaceRoot,
      MELRA_HOME: dataDirectory,
      MELRA_POLICY: policyPath,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "melra-restart-e2e", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport, stderr };
}

async function writeTestPolicy(root: string): Promise<string> {
  const policyPath = join(root, "policy.json");
  await writeFile(
    policyPath,
    `${JSON.stringify(
      {
        version: "restart-e2e",
        workspaceRoot: root,
        allowedCommands: ["node"],
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
  return policyPath;
}

describe("MELRA over real stdio transport", () => {
  let root: string;
  let dataDirectory: string;
  let client: Client;
  let transport: StdioClientTransport;
  const browserExecutable = detectedBrowserExecutable;
  let fixtureServer: Server | undefined;
  let fixtureUrl: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "melra-e2e-"));
    dataDirectory = join(root, ".data");
    const policyPath = join(root, "policy.json");
    await writeFile(
      policyPath,
      `${JSON.stringify(
        {
          version: "e2e",
          workspaceRoot: root,
          allowedCommands: ["node"],
          allowedDomains: ["127.0.0.1"],
          allowLocalhost: true,
          mutations: "confirm",
          approvalTtlMs: 300_000,
          maxFileBytes: 1_000_000,
        },
        null,
        2,
      )}\n`,
    );

    if (browserExecutable !== undefined) {
      fixtureServer = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<!doctype html><html><head><title>MELRA Fixture</title></head><body><main><h1>MELRA Browser Verified</h1><button>Inspect</button></main></body></html>",
        );
      });
      await new Promise<void>((resolvePromise) => {
        fixtureServer!.listen(0, "127.0.0.1", resolvePromise);
      });
      const address = fixtureServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("fixture_server_address_unavailable");
      }
      fixtureUrl = `http://127.0.0.1:${address.port}`;
    }

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "serve"],
      cwd: rootPackage,
      env: {
        ...childEnvironment,
        MELRA_WORKSPACE: root,
        MELRA_HOME: dataDirectory,
        MELRA_POLICY: policyPath,
        ...(browserExecutable === undefined
          ? {}
          : { MELRA_BROWSER: browserExecutable }),
      },
      stderr: "pipe",
    });
    client = new Client({ name: "melra-e2e", version: "1.0.0" });
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await new Promise<void>((resolvePromise) => {
      if (fixtureServer === undefined) {
        resolvePromise();
        return;
      }
      fixtureServer.close(() => resolvePromise());
    });
    await rm(root, { recursive: true, force: true });
  });

  it("advertises exactly the compact eleven-tool product surface", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "melra_capabilities",
      "melra_execute",
      "melra_plan",
      "melra_receipt",
      "melra_task_cancel",
      "melra_task_status",
      "melra_workflow_advance",
      "melra_workflow_cancel",
      "melra_workflow_control",
      "melra_workflow_plan",
      "melra_workflow_status",
    ]);
    const capabilities = parsed(
      await client.callTool({ name: "melra_capabilities", arguments: {} }),
    );
    expect(capabilities.product).toBe("MELRA");
    expect(
      (capabilities.operations as Record<string, unknown>).computer,
    ).toEqual([
      "capabilities",
      "inspect",
      "screenshot",
      "click",
      "move",
      "drag",
      "type",
      "key",
      "scroll",
    ]);
  });

  it("tells the model how to use it, naming only things that exist", async () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("melra_plan");
    // A renamed tool or a new evidence type must fail here, not leave agents
    // following a guide that no longer matches the server.
    const tools = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const [name] of instructions.matchAll(/melra_[a-z_]+/g)) {
      expect(tools, name).toContain(name);
    }
    const evidence = EvidencePredicateSchema.options.map((option) => option.shape.type.value);
    const listed = /requiredEvidence describing how to confirm it \(([^)]+)\)/.exec(instructions)?.[1];
    expect(listed?.split(", ").sort()).toEqual([...evidence].sort());
  });

  it("plans and advances a verified workflow over MCP", async () => {
    const planned = parsed(
      await client.callTool({
        name: "melra_workflow_plan",
        arguments: {
          definition: {
            schemaVersion: "1.0.0",
            id: "11111111-1111-4111-8111-111111111111",
            version: 1,
            name: "MCP workflow",
            nodes: [
              {
                id: "inspect",
                type: "operation",
                request: {
                  goal: "Inspect through a workflow",
                  operation: { kind: "system", action: "info" },
                },
              },
            ],
          },
        },
      }),
    );
    expect(planned.status).toBe("planned");

    const advanced = parsed(
      await client.callTool({
        name: "melra_workflow_advance",
        arguments: { workflowId: planned.id },
      }),
    ) as { run: Record<string, unknown> };
    expect(advanced.run.status).toBe("verified_complete");
    expect(
      parsed(
        await client.callTool({
          name: "melra_workflow_status",
          arguments: { workflowId: planned.id },
        }),
      ).status,
    ).toBe("verified_complete");
    expect(
      parsed(
        await client.callTool({
          name: "melra_workflow_cancel",
          arguments: { workflowId: planned.id },
        }),
      ).status,
    ).toBe("verified_complete");
  });

  it("names a mistyped field instead of dropping it", async () => {
    // A misspelled `forbiddenEffects` used to be stripped before the schema saw
    // it, so the task planned as if the caller had declared no limit at all.
    const mistyped = (await client.callTool({
      name: "melra_plan",
      arguments: {
        goal: "Read one file",
        operation: { kind: "file", action: "read", path: "notes.txt" },
        forbiddenEffcts: ["mutate"],
      },
    })) as TextToolResult;
    expect(mistyped.isError).toBe(true);
    expect(mistyped.content.map((item) => item.text ?? "").join("\n")).toContain(
      'Unrecognized key: "forbiddenEffcts"',
    );

    // The receipt tool needs one of two identifiers, and the requirement is part
    // of the advertised contract rather than an error thrown after the call.
    const noIdentifier = (await client.callTool({
      name: "melra_receipt",
      arguments: {},
    })) as TextToolResult;
    expect(noIdentifier.isError).toBe(true);
    expect(
      noIdentifier.content.map((item) => item.text ?? "").join("\n"),
    ).toContain("taskId or receiptId is required");

    // Strictness is advertised, so a client can reject the typo locally instead
    // of learning about it in a round trip.
    const plan = (await client.listTools()).tools.find(
      (tool) => tool.name === "melra_plan",
    );
    expect(plan?.inputSchema.additionalProperties).toBe(false);

    // The two rules a caller cannot infer from the types — a non-empty
    // `constraints` is a deny, and a mutation without evidence is a deny — reach
    // the model through the schema or not at all.
    const fields = plan?.inputSchema.properties as Record<
      string,
      { description?: string }
    >;
    expect(fields.constraints?.description).toContain(
      "freeform_constraints_not_enforceable",
    );
    expect(fields.requiredEvidence?.description).toContain(
      "mutation_requires_evidence",
    );
  });

  it("rejects the retired tool prefix", async () => {
    const retiredPrefix = ["at", "las"].join("");
    const result = (await client.callTool({
        name: `${retiredPrefix}_plan`,
        arguments: { goal: "This compatibility alias must not exist." },
      })) as TextToolResult;
    expect(result.isError).toBe(true);
    expect(result.content.map((item) => item.text ?? "").join("\n")).toMatch(
      /not found/i,
    );
  });

  it("recreates the runtime with a stable key and executable task payload", async () => {
    const restartRoot = await mkdtemp(join(tmpdir(), "melra-restart-"));
    const restartHome = join(restartRoot, ".melra");
    const first = await createMelraRuntime({
      workspaceRoot: restartRoot,
      dataDirectory: restartHome,
      environment: {},
    });
    const task = first.controller.plan({
      goal: "Execute after runtime restart",
      operation: { kind: "system", action: "info" },
      constraints: [],
      forbiddenEffects: [],
      requiredEvidence: [],
      reconciliation: [],
      budget: {
        maxDurationMs: 120_000,
        maxRetries: 2,
        maxSteps: 10,
      },
    });
    const firstKey = await readFile(join(restartHome, "payload.key"), "utf8");
    await first.close();

    const second = await createMelraRuntime({
      workspaceRoot: restartRoot,
      dataDirectory: restartHome,
      environment: {},
    });
    try {
      expect(second.workflows).toBeDefined();
      expect((await second.controller.execute(task.id)).task.status).toBe(
        "verified_success",
      );
      expect(await readFile(join(restartHome, "payload.key"), "utf8")).toBe(
        firstKey,
      );
    } finally {
      await second.close();
      await rm(restartRoot, { recursive: true, force: true });
    }
  });

  it("resumes an approval-gated verified workflow in a new MCP process", async () => {
    const restartRoot = await mkdtemp(join(tmpdir(), "melra-mcp-restart-"));
    const restartHome = join(restartRoot, ".melra");
    const policyPath = await writeTestPolicy(restartRoot);
    const definition = JSON.parse(
      await readFile(
        join(rootPackage, "examples/workflows/restart-safe.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    let first:
      | Awaited<ReturnType<typeof connectMcp>>
      | undefined = await connectMcp(restartRoot, restartHome, policyPath);
    let second: Awaited<ReturnType<typeof connectMcp>> | undefined;

    try {
      const firstPid = first.transport.pid;
      const planned = parsed(
        await first.client.callTool({
          name: "melra_workflow_plan",
          arguments: { definition },
        }),
      );
      const inspected = parsed(
        await first.client.callTool({
          name: "melra_workflow_advance",
          arguments: { workflowId: planned.id },
        }),
      ) as unknown as WorkflowAdvanceResult;
      expect(inspected.run.status).toBe("running");
      const sequences = inspected.events.map((event) => event.sequence);

      await first.client.close();
      first = undefined;
      second = await connectMcp(restartRoot, restartHome, policyPath);
      expect(second.transport.pid).not.toBe(firstPid);

      const awaiting = parsed(
        await second.client.callTool({
          name: "melra_workflow_advance",
          arguments: { workflowId: planned.id },
        }),
      ) as unknown as WorkflowAdvanceResult;
      expect(awaiting.run.status).toBe("awaiting_approval");
      const approval = awaiting.run.nodes.write?.approval;
      expect(approval).toBeDefined();
      sequences.push(...awaiting.events.map((event) => event.sequence));

      const tampered = parsed(
        await second.client.callTool({
          name: "melra_workflow_advance",
          arguments: {
            workflowId: planned.id,
            approvals: [
              {
                approvalId: "99999999-9999-4999-8999-999999999999",
                phrase: approval!.phrase,
              },
            ],
          },
        }),
      ) as unknown as WorkflowAdvanceResult;
      expect(tampered.run.status).toBe("awaiting_approval");
      await expect(
        readFile(join(restartRoot, "durable-core-result.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      sequences.push(...tampered.events.map((event) => event.sequence));

      const written = parsed(
        await second.client.callTool({
          name: "melra_workflow_advance",
          arguments: {
            workflowId: planned.id,
            approvals: [
              {
                approvalId: approval!.approvalId,
                phrase: approval!.phrase,
              },
            ],
          },
        }),
      ) as unknown as WorkflowAdvanceResult;
      expect(written.run.nodes.write?.status).toBe("verified_complete");
      sequences.push(...written.events.map((event) => event.sequence));

      const completed = parsed(
        await second.client.callTool({
          name: "melra_workflow_advance",
          arguments: { workflowId: planned.id },
        }),
      ) as unknown as WorkflowAdvanceResult;
      expect(completed.run.status).toBe("verified_complete");
      sequences.push(...completed.events.map((event) => event.sequence));
      expect(
        await readFile(join(restartRoot, "durable-core-result.txt"), "utf8"),
      ).toBe("verified after restart");

      const evidence = parsed(
        await second.client.callTool({
          name: "melra_receipt",
          arguments: { taskId: written.run.nodes.write!.taskIds[0] },
        }),
      ) as {
        receipts: Array<{ effect: string }>;
        certificate: { result: string; digest: string };
      };
      expect(evidence.receipts).toHaveLength(1);
      expect(evidence.receipts[0]?.effect).toBe("mutate");
      expect(evidence.certificate.result).toBe("VERIFIED_SUCCESS");
      expect(evidence.certificate.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    } finally {
      await first?.client.close();
      await second?.client.close();
      await rm(restartRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("never persists or returns a planned workflow secret in plaintext", async () => {
    const secretRoot = await mkdtemp(join(tmpdir(), "melra-mcp-secret-"));
    const secretHome = join(secretRoot, ".melra");
    const policyPath = await writeTestPolicy(secretRoot);
    const secret = "secret-restart-payload-7391";
    const session = await connectMcp(secretRoot, secretHome, policyPath);

    try {
      const planned = parsed(
        await session.client.callTool({
          name: "melra_workflow_plan",
          arguments: {
            definition: {
              schemaVersion: "1.0.0",
              id: "7d57f7ba-9b98-4ff5-8f73-a24fbaf66d29",
              version: 1,
              name: "encrypted-restart-payload",
              nodes: [
                {
                  id: "write",
                  type: "operation",
                  request: {
                    goal: "Persist an encrypted workflow payload",
                    operation: {
                      kind: "file",
                      action: "write",
                      path: "secret.txt",
                      content: secret,
                    },
                    requiredEvidence: [
                      { type: "file_exists", path: "secret.txt" },
                    ],
                  },
                },
              ],
            },
          },
        }),
      );
      const status = parsed(
        await session.client.callTool({
          name: "melra_workflow_status",
          arguments: { workflowId: planned.id },
        }),
      );
      expect(JSON.stringify({ planned, status })).not.toContain(secret);
      await session.client.close();

      const store = new SqliteStore(join(secretHome, "melra.sqlite"));
      const events = store.listWorkflowEvents(String(planned.id));
      store.close();
      expect(JSON.stringify(events)).not.toContain(secret);
      for (const file of (await readdir(secretHome)).filter((name) =>
        name.startsWith("melra.sqlite"),
      )) {
        expect(await readFile(join(secretHome, file))).not.toContain(
          Buffer.from(secret),
        );
      }
      expect(session.stderr.join("")).not.toContain(secret);
    } finally {
      await session.client.close();
      await rm(secretRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("in enforced mode, hands the agent no approval phrase anywhere and takes none back", async () => {
    const base = await mkdtemp(join(tmpdir(), "melra-mcp-enforced-"));
    const workspace = join(base, "workspace");
    const home = join(base, "data");
    await mkdir(workspace, { recursive: true });
    const stderr: string[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "serve"],
      cwd: rootPackage,
      env: {
        ...childEnvironment,
        MELRA_WORKSPACE: workspace,
        MELRA_HOME: home,
        MELRA_POLICY: "",
        MELRA_MODE: "enforced",
        MELRA_HARNESS_TOOLS: "1",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    const session = new Client({ name: "melra-enforced-e2e", version: "1.0.0" });
    await session.connect(transport);
    const instructions = session.getInstructions() ?? "";
    const seen: string[] = [instructions];
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await session.callTool({ name, arguments: args })) as TextToolResult;
      const text = result.content.map((item) => item.text ?? "").join("\n");
      seen.push(text);
      return {
        ok: result.isError !== true,
        text,
        value: result.isError === true ? {} : (JSON.parse(text) as Record<string, unknown>),
      };
    };
    const write = (path: string) => ({
      goal: `Write ${path}`,
      operation: { kind: "file", action: "write", path, content: "x" },
      requiredEvidence: [{ type: "file_exists", path }],
    });
    try {
      expect(instructions).toContain("melra approve <taskId>");
      // The enforced addendum is held to the same rule: only real tools by name.
      const tools = new Set((await session.listTools()).tools.map((tool) => tool.name));
      for (const [name] of instructions.matchAll(/melra_[a-z_]+/g)) {
        expect(tools, name).toContain(name);
      }

      const planned = await call("melra_plan", write("w.txt"));
      const taskId = String(planned.value.id);
      const challenge = planned.value.approval as { approvalId: string; actionDigest: string };
      await call("melra_task_status", { taskId });
      const forged = { approvalId: challenge.approvalId, phrase: `APPROVE ${challenge.actionDigest.slice(0, 12)}` };
      const refused = await call("melra_execute", { taskId, approval: forged });
      expect(refused.ok).toBe(false);
      expect(refused.text).toContain("approval_in_band_refused");
      expect((await call("melra_execute", { taskId })).text).toContain("approval_awaiting_operator");

      const workflow = await call("melra_workflow_plan", {
        definition: {
          schemaVersion: "1.0.0",
          id: "88888888-8888-4888-8888-888888888888",
          version: 1,
          name: "enforced-e2e",
          nodes: [{ id: "write", type: "operation", request: write("v.txt") }],
        },
      });
      const workflowId = String(workflow.value.id);
      const waiting = await call("melra_workflow_advance", { workflowId });
      const node = (waiting.value as unknown as WorkflowAdvanceResult).run.nodes.write!.approval!;
      const advanced = await call("melra_workflow_advance", {
        workflowId,
        approvals: [{ approvalId: node.approvalId, phrase: `APPROVE ${node.actionDigest.slice(0, 12)}` }],
      });
      expect(advanced.text).toContain("approval_in_band_refused");
      await call("melra_workflow_status", { workflowId });

      const held = await call("write_file", { path: "h.txt", content: "x" });
      expect(held.value.status).toBe("approval_required");
      expect((await call("approve", { taskId: held.value.taskId, phrase: "APPROVE 000000000000" })).ok).toBe(false);

      // The operator: another process on the same data directory.
      const operator = await createMelraRuntime({
        workspaceRoot: workspace,
        dataDirectory: home,
        environment: { MELRA_MODE: "enforced" },
      });
      try {
        operator.controller.decide(taskId, operator.controller.approvalView(taskId).renderDigest, "cli:e2e");
      } finally {
        await operator.close();
      }
      const executed = await call("melra_execute", { taskId });
      expect(executed.value).toMatchObject({ task: { status: "verified_success" } });
      const receipt = await call("melra_receipt", { taskId });
      expect(receipt.value).toMatchObject({
        receipts: [{ policyDecision: { approval: { channel: "out_of_band" } } }],
        certificate: { approvalChannel: "out_of_band" },
      });

      const store = new SqliteStore(join(home, "melra.sqlite"));
      seen.push(JSON.stringify(store.listWorkflowEvents(workflowId)));
      store.close();
      seen.push(stderr.join(""));
      for (const text of seen) {
        expect(text).not.toMatch(/"phrase"|APPROVE [a-f0-9]{12}/);
      }
    } finally {
      await session.close();
      await rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it("inspects computer-use support through the governed task path", async () => {
    const task = parsed(
      await client.callTool({
        name: "melra_plan",
        arguments: {
          goal: "Inspect local computer-use support",
          operation: { kind: "computer", action: "capabilities" },
          requiredEvidence: [
            {
              type: "result_equals",
              path: "platform",
              value: process.platform,
            },
          ],
        },
      }),
    );
    expect(task.status).toBe("planned");
    const execution = parsed(
      await client.callTool({
        name: "melra_execute",
        arguments: { taskId: task.id },
      }),
    ) as {
      task: Record<string, unknown>;
      output: Record<string, unknown>;
    };
    expect(execution.task.status).toBe("verified_success");
    expect(execution.output.platform).toBe(process.platform);
  });

  it("plans, executes, verifies, and receipts a system task", async () => {
    const task = parsed(
      await client.callTool({
        name: "melra_plan",
        arguments: {
          goal: "Inspect the local runtime",
          operation: { kind: "system", action: "info" },
        },
      }),
    );
    expect(task.status).toBe("planned");
    const execution = parsed(
      await client.callTool({
        name: "melra_execute",
        arguments: { taskId: task.id },
      }),
    ) as { task: Record<string, unknown>; certificate: Record<string, unknown> };
    expect(execution.task.status).toBe("verified_success");
    expect(execution.certificate.result).toBe("VERIFIED_SUCCESS");
    const evidence = parsed(
      await client.callTool({
        name: "melra_receipt",
        arguments: { taskId: task.id },
      }),
    ) as { receipts: unknown[]; certificate: Record<string, unknown> };
    expect(evidence.receipts).toHaveLength(1);
    expect(evidence.certificate.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("enforces scoped approval and verifies a real file effect", async () => {
    const task = parsed(
      await client.callTool({
        name: "melra_plan",
        arguments: {
          goal: "Create a verified artifact",
          operation: {
            kind: "file",
            action: "write",
            path: "result.txt",
            content: "created through MCP",
          },
          requiredEvidence: [{ type: "file_exists", path: "result.txt" }],
        },
      }),
    ) as {
      id: string;
      status: string;
      approval: { approvalId: string; phrase: string };
    };
    expect(task.status).toBe("awaiting_approval");
    const execution = parsed(
      await client.callTool({
        name: "melra_execute",
        arguments: {
          taskId: task.id,
          approval: {
            approvalId: task.approval.approvalId,
            phrase: task.approval.phrase,
          },
        },
      }),
    ) as { task: Record<string, unknown>; receipt: Record<string, unknown> };
    expect(execution.task.status).toBe("verified_success");
    expect(execution.receipt.effect).toBe("mutate");
  });

  it("runs a shell-free terminal command through approval and exit verification", async () => {
    const task = parsed(
      await client.callTool({
        name: "melra_plan",
        arguments: {
          goal: "Run a deterministic terminal check",
          operation: {
            kind: "terminal",
            action: "run",
            command: "node",
            args: ["-e", "process.stdout.write('terminal-through-mcp')"],
          },
          requiredEvidence: [
            { type: "exit_code", value: 0 },
            {
              type: "result_contains",
              path: "stdout",
              value: "terminal-through-mcp",
            },
          ],
        },
      }),
    ) as {
      id: string;
      approval: { approvalId: string; phrase: string };
    };
    const execution = parsed(
      await client.callTool({
        name: "melra_execute",
        arguments: {
          taskId: task.id,
          approval: {
            approvalId: task.approval.approvalId,
            phrase: task.approval.phrase,
          },
        },
      }),
    ) as { task: Record<string, unknown> };
    expect(execution.task.status).toBe("verified_success");
  });

  it("persists and retrieves scoped local memory through MCP", async () => {
    const task = parsed(
      await client.callTool({
        name: "melra_plan",
        arguments: {
          goal: "Remember the verified product name",
          operation: {
            kind: "memory",
            action: "put",
            scope: "workspace",
            key: "product",
            value: "MELRA",
          },
          requiredEvidence: [
            { type: "result_equals", path: "stored", value: true },
          ],
        },
      }),
    ) as {
      id: string;
      approval: { approvalId: string; phrase: string };
    };
    const stored = parsed(
      await client.callTool({
        name: "melra_execute",
        arguments: {
          taskId: task.id,
          approval: {
            approvalId: task.approval.approvalId,
            phrase: task.approval.phrase,
          },
        },
      }),
    ) as { task: Record<string, unknown> };
    expect(stored.task.status).toBe("verified_success");

    const search = parsed(
      await client.callTool({
        name: "melra_plan",
        arguments: {
          goal: "Retrieve product memory",
          operation: {
            kind: "memory",
            action: "search",
            scope: "workspace",
            query: "MELRA",
          },
        },
      }),
    );
    const found = parsed(
      await client.callTool({
        name: "melra_execute",
        arguments: { taskId: search.id },
      }),
    ) as {
      output: { memories: Array<{ value: string }> };
    };
    expect(found.output.memories[0]?.value).toBe("MELRA");
  });

  it.skipIf(browserExecutable === undefined)(
    "drives an installed browser through the actual MCP server and verifies the page",
    async () => {
      const task = parsed(
        await client.callTool({
          name: "melra_plan",
          arguments: {
            goal: "Open the deterministic browser fixture",
            operation: {
              kind: "browser",
              action: "navigate",
              url: fixtureUrl,
            },
            requiredEvidence: [
              { type: "page_contains", text: "MELRA Browser Verified" },
              { type: "url_matches", pattern: `${fixtureUrl}*` },
            ],
          },
        }),
      );
      const execution = parsed(
        await client.callTool({
          name: "melra_execute",
          arguments: { taskId: task.id },
        }),
      ) as { task: Record<string, unknown> };
      expect(execution.task.status).toBe("verified_success");
    },
    120_000,
  );
});
