// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOL_NAMES, type Principal } from "@melra/protocol";
import { createMcpServer, harnessToolsEnabled, SERVER_INSTRUCTIONS } from "./mcp-server.js";
import { HARNESS_TOOLS, registerHarnessTools } from "./harness-tools.js";
import { createMelraRuntime, type MelraRuntime } from "./runtime.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
}>;

/** Enough of an `McpServer` to collect handlers; the transport proves nothing here. */
function collect(runtime: MelraRuntime, client?: Principal): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerHarnessTools(
    {
      registerTool: (name: string, _config: unknown, handler: Handler) =>
        handlers.set(name, handler),
    } as never,
    runtime,
    client,
  );
  return handlers;
}

async function call(
  handlers: Map<string, Handler>,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = handlers.get(name);
  if (handler === undefined) throw new Error(`no tool named ${name}`);
  const result = await handler(args);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("harnessToolsEnabled", () => {
  it("takes only the affirmative spellings", () => {
    expect(harnessToolsEnabled({ MELRA_HARNESS_TOOLS: "1" })).toBe(true);
    expect(harnessToolsEnabled({ MELRA_HARNESS_TOOLS: "0" })).toBe(false);
    expect(harnessToolsEnabled({})).toBe(false);
  });
});

describe("harness tool goals", () => {
  it("names a page without its query or fragment, which the stored URL drops too (#385)", () => {
    expect(HARNESS_TOOLS.browse!.goal({ url: "https://example.com/callback?code=4f2a9c&state=x#token=y" })).toBe(
      "Open https://example.com/callback",
    );
  });

  it("names a page without its userinfo, whose password no secret pattern may match (#385)", () => {
    for (const url of [
      "https://alice:pa'ss@example.com/x?code=1#t",
      'https://alice:pa"ss@example.com/x',
      "https://alice:p@ssw0rdXYZ@example.com/x",
      "https://al,{ice:pw@example.com/x",
    ]) {
      expect(HARNESS_TOOLS.browse!.goal({ url })).toBe("Open https://example.com/x");
    }
  });
});

describe("harness tools", () => {
  let base: string;
  let workspace: string;
  let runtime: MelraRuntime;
  let tools: Map<string, Handler>;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "melra-harness-"));
    workspace = join(base, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "note.txt"), "hello", "utf8");
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: join(base, "data"),
      environment: {},
    });
    tools = collect(runtime);
  });

  afterEach(async () => {
    await runtime.close();
    await rm(base, { recursive: true, force: true });
  });

  it("runs a read straight through", async () => {
    const result = await call(tools, "read_file", { path: "note.txt" });
    expect(result.status).toBe("verified_success");
    expect((result.result as { content: string }).content).toBe("hello");
  });

  it("holds a mutation on the approval phrase and runs it once approved", async () => {
    const held = await call(tools, "write_file", {
      path: "written.txt",
      content: "from the harness",
    });
    expect(held.status).toBe("approval_required");
    // Nothing ran: an approval that could be skipped by ignoring the answer
    // would make the whole surface a bypass.
    await expect(readFile(join(workspace, "written.txt"), "utf8")).rejects.toThrow();

    const done = await call(tools, "approve", {
      taskId: held.taskId,
      phrase: held.phrase,
    });
    expect(done.status).toBe("verified_success");
    expect(await readFile(join(workspace, "written.txt"), "utf8")).toBe(
      "from the harness",
    );
  });

  it("refuses a wrong phrase", async () => {
    const held = await call(tools, "write_file", {
      path: "nope.txt",
      content: "x",
    });
    await expect(
      call(tools, "approve", { taskId: held.taskId, phrase: "APPROVE whatever" }),
    ).rejects.toThrow("approval_phrase_mismatch");
    await expect(readFile(join(workspace, "nope.txt"), "utf8")).rejects.toThrow();
  });

  it("reports a policy denial as a result rather than an error", async () => {
    const result = await call(tools, "run_command", { command: "sh", args: ["-c", "true"] });
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("command_not_allowlisted");
  });
});

describe("harness tools in enforced mode", () => {
  let base: string;
  let workspace: string;
  let runtime: MelraRuntime;
  let tools: Map<string, Handler>;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "melra-harness-enforced-"));
    workspace = join(base, "workspace");
    await mkdir(workspace, { recursive: true });
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: join(base, "data"),
      environment: { MELRA_MODE: "enforced" },
    });
    tools = collect(runtime);
  });

  afterEach(async () => {
    await runtime.close();
    await rm(base, { recursive: true, force: true });
  });

  it("hands the agent no phrase, refuses one, and runs once an operator decides", async () => {
    const held = await call(tools, "write_file", { path: "w.txt", content: "x" });
    expect(held.status).toBe("approval_required");
    expect(held).not.toHaveProperty("phrase");
    expect(held.next).toContain(`melra approve ${String(held.taskId)}`);
    const task = runtime.controller.status(String(held.taskId));
    await expect(
      call(tools, "approve", { taskId: held.taskId, phrase: `APPROVE ${task.approval!.actionDigest.slice(0, 12)}` }),
    ).rejects.toThrow("approval_in_band_refused");
    await expect(call(tools, "approve", { taskId: held.taskId })).rejects.toThrow("approval_awaiting_operator");
    runtime.controller.decide(task.id, runtime.controller.approvalView(task.id).renderDigest, "cli:test");
    expect((await call(tools, "approve", { taskId: held.taskId })).status).toBe("verified_success");
    expect(await readFile(join(workspace, "w.txt"), "utf8")).toBe("x");
  });

  it("runs a held task only for the client that asked for it", async () => {
    const owner = collect(runtime, { kind: "harness", id: "owner" });
    const held = await call(owner, "write_file", { path: "owned.txt", content: "x" });
    runtime.controller.decide(String(held.taskId), runtime.controller.approvalView(String(held.taskId)).renderDigest, "cli:test");
    await expect(
      call(collect(runtime, { kind: "harness", id: "other" }), "approve", { taskId: held.taskId }),
    ).rejects.toThrow("task_belongs_to_another_client");
    await expect(readFile(join(workspace, "owned.txt"), "utf8")).rejects.toThrow();
    expect((await call(owner, "approve", { taskId: held.taskId })).status).toBe("verified_success");
  });

  it("holds an operator's pause against the agent: no resume, and no run of the waiting step", async () => {
    const [left, right] = InMemoryTransport.createLinkedPair();
    await createMcpServer(runtime).connect(right);
    const agent = new Client({ name: "t", version: "1" });
    await agent.connect(left);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await agent.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { refused: result.isError === true, body: result.content[0]!.text };
    };
    try {
      const write = { kind: "file", action: "write", path: "held.txt", content: "x" };
      const run = JSON.parse(
        (
          await call("melra_workflow_plan", {
            definition: {
              schemaVersion: "1.0.0",
              id: "44444444-4444-4444-8444-444444444444",
              version: 1,
              name: "Held",
              nodes: [
                {
                  id: "write",
                  type: "operation",
                  request: { goal: "Write held.txt", operation: write, requiredEvidence: [{ type: "file_exists", path: "held.txt" }] },
                },
              ],
            },
          })
        ).body,
      ) as { id: string };
      const waiting = JSON.parse((await call("melra_workflow_advance", { workflowId: run.id })).body) as {
        run: { status: string; nodes: { write: { taskIds: string[] } } };
      };
      expect(waiting.run.status).toBe("awaiting_approval");
      const taskId = waiting.run.nodes.write.taskIds[0]!;
      // What `melra approve <task> --yes`, then `melra workflow pause`, record.
      runtime.controller.decide(taskId, runtime.controller.approvalView(taskId).renderDigest, "cli:alice");
      runtime.workflows.pause(run.id, { operator: "cli:alice" });

      for (const [name, args, error] of [
        ["melra_workflow_control", { workflowId: run.id, action: "resume" }, "workflow_resume_needs_operator"],
        ["melra_execute", { taskId }, "workflow_halted:paused"],
      ] as const) {
        const refused = await call(name, args);
        expect(refused.refused, name).toBe(true);
        expect(refused.body, name).toContain(error);
      }
      await expect(readFile(join(workspace, "held.txt"), "utf8")).rejects.toThrow();
      expect(runtime.workflows.status(run.id).status).toBe("paused");

      // Lifted by the operator, the run is the agent's again, and so is a halt it makes.
      runtime.workflows.resume(run.id, { operator: "cli:alice" });
      expect(JSON.parse((await call("melra_workflow_control", { workflowId: run.id, action: "pause" })).body).status).toBe("paused");
      expect(JSON.parse((await call("melra_workflow_control", { workflowId: run.id, action: "resume" })).body).status).toBe(
        "awaiting_approval",
      );
      expect(JSON.parse((await call("melra_workflow_advance", { workflowId: run.id })).body).run.status).toBe("verified_complete");
      expect(await readFile(join(workspace, "held.txt"), "utf8")).toBe("x");
    } finally {
      await agent.close();
    }
  });

  it("leaves an operator's question to the operator: the agent's answer is refused and the node waits", async () => {
    const [left, right] = InMemoryTransport.createLinkedPair();
    await createMcpServer(runtime).connect(right);
    const agent = new Client({ name: "t", version: "1" });
    await agent.connect(left);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await agent.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { refused: result.isError === true, body: result.content[0]!.text };
    };
    try {
      const { tools } = await agent.listTools();
      expect(tools.find((tool) => tool.name === "melra_workflow_advance")?.description).toContain(
        "workflow_input_in_band_refused",
      );
      expect(agent.getInstructions()).toContain("melra workflow advance <workflowId> --input <nodeId>=<value>");
      const run = JSON.parse(
        (
          await call("melra_workflow_plan", {
            definition: {
              schemaVersion: "1.0.0",
              id: "66666666-6666-4666-8666-666666666666",
              version: 1,
              name: "Asked",
              nodes: [
                { id: "ask", type: "human_input", prompt: "Proceed?", choices: ["yes", "no"], answeredBy: "operator" },
                { id: "any", type: "human_input", prompt: "Notes?" },
              ],
            },
          })
        ).body,
      ) as { id: string };
      await call("melra_workflow_advance", { workflowId: run.id });

      const refused = await call("melra_workflow_advance", {
        workflowId: run.id,
        inputs: [
          { nodeId: "ask", value: "yes" },
          { nodeId: "any", value: "none" },
        ],
      });
      expect(refused.refused).toBe(true);
      expect(refused.body).toContain("workflow_input_in_band_refused:ask");
      // Nothing moved, the other answer included.
      expect(runtime.workflows.status(run.id).nodes).toMatchObject({
        ask: { status: "awaiting_input" },
        any: { status: "awaiting_input" },
      });

      const answered = JSON.parse(
        (await call("melra_workflow_advance", { workflowId: run.id, inputs: [{ nodeId: "any", value: "none" }] })).body,
      ) as { run: { nodes: Record<string, unknown> }; events: { type: string; data: Record<string, unknown> }[] };
      expect(answered.run.nodes.any).toMatchObject({ status: "verified_complete" });
      expect(answered.run.nodes.ask).toMatchObject({ status: "awaiting_input" });
      expect(answered.events.find((event) => event.type === "workflow.node_changed")?.data).toMatchObject({
        nodeId: "any",
        answeredBy: "agent",
        channel: "in_band",
      });
    } finally {
      await agent.close();
    }
  });

  it("plans a URL or query it accepts even when its goal would pass the goal's cap", async () => {
    // 8,017 characters, but each é is percent-encoded to six in the goal. On
    // loopback, so policy stops it at the plan and no page is opened.
    const held = await call(tools, "browse", { url: `http://localhost/${"é".repeat(8_000)}` });
    expect(held.status).toBe("blocked");
    expect(runtime.controller.status(String(held.taskId)).request.goal).toBe("Open (input too long to restate)");
    const recalled = await call(tools, "recall", { query: "q".repeat(10_000) });
    expect(recalled.status).toBe("verified_success");
    expect(runtime.controller.status(String(recalled.taskId)).request.goal).toBe("Recall (input too long to restate)");
  });

  it("asks the browser tools for the page they act on", async () => {
    for (const [name, args] of [
      ["browser_click", { target: { selector: "#go" } }],
      ["browser_type", { target: { selector: "#q" }, value: "x" }],
    ] as const) {
      expect(await call(tools, name, args), name).toMatchObject({ status: "blocked", reason: "browser_action_requires_url" });
      const held = await call(tools, name, { ...args, url: "https://example.com/" });
      expect(held.status, name).toBe("approval_required");
      expect(runtime.controller.status(String(held.taskId)).request.operation, name).toMatchObject({ url: "https://example.com/" });
    }
  });

  it("describes every MELRA tool and each of its top-level parameters", async () => {
    // A model reading the tool list has only these words to pick a tool and
    // fill its arguments; an undescribed parameter is a guess.
    const [left, right] = InMemoryTransport.createLinkedPair();
    await createMcpServer(runtime).connect(right);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(left);
    try {
      const { tools } = await client.listTools();
      const melra = tools.filter((tool) => (TOOL_NAMES as readonly string[]).includes(tool.name));
      expect(melra.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
      for (const tool of melra) {
        expect(tool.description?.split(/\s+/).length ?? 0, tool.name).toBeGreaterThanOrEqual(40);
        const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
        for (const [name, property] of Object.entries(properties)) {
          expect(property.description ?? "", `${tool.name}.${name}`).not.toBe("");
        }
      }
    } finally {
      await client.close();
    }
  });

  it("does not tell the model to stop a running step's task to cancel its run", async () => {
    // melra_task_cancel on that task fails the step, and the advance still
    // running it unwinds the run before the workflow cancel can land.
    const [left, right] = InMemoryTransport.createLinkedPair();
    await createMcpServer(runtime).connect(right);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(left);
    try {
      const { tools } = await client.listTools();
      const cancel = tools.find((tool) => tool.name === "melra_workflow_cancel")?.description ?? "";
      expect(cancel).not.toContain("stop a running step's task first with melra_task_cancel");
      expect(cancel).toContain("starts the run's unwind");
      expect(cancel).toContain("may still run");
    } finally {
      await client.close();
    }
  });

  it("tells the model an operator approves, and leaves developer mode's words alone", async () => {
    const instructions = async (server: ReturnType<typeof createMcpServer>) => {
      const [left, right] = InMemoryTransport.createLinkedPair();
      await server.connect(right);
      const client = new Client({ name: "t", version: "1" });
      await client.connect(left);
      const text = client.getInstructions();
      await client.close();
      return text;
    };
    const enforced = await instructions(createMcpServer(runtime));
    expect(enforced?.startsWith(SERVER_INSTRUCTIONS)).toBe(true);
    expect(enforced).toContain("melra approve <taskId>");
    expect(enforced).toContain("approval_awaiting_operator");
    const developer = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: join(base, "dev-data"),
      environment: {},
    });
    try {
      expect(await instructions(createMcpServer(developer))).toBe(SERVER_INSTRUCTIONS);
    } finally {
      await developer.close();
    }
  });
});
