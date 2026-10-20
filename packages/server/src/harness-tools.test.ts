// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOL_NAMES } from "@melra/protocol";
import { createMcpServer, harnessToolsEnabled, SERVER_INSTRUCTIONS } from "./mcp-server.js";
import { registerHarnessTools } from "./harness-tools.js";
import { createMelraRuntime, type MelraRuntime } from "./runtime.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
}>;

/** Enough of an `McpServer` to collect handlers; the transport proves nothing here. */
function collect(runtime: MelraRuntime): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerHarnessTools(
    {
      registerTool: (name: string, _config: unknown, handler: Handler) =>
        handlers.set(name, handler),
    } as never,
    runtime,
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
