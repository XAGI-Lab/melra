// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { httpTransport, socketTransport } from "./remote.js";
import {
  WorkflowAdvanceInputSchema,
  WorkflowAdvanceResultSchema,
  WorkflowControlInputSchema,
  WorkflowDefinitionSchema,
  WorkflowIdInputSchema,
  WorkflowRunSchema,
  TaskRequestSchema,
  type WorkflowAdvanceResult,
  type WorkflowDefinitionInput,
  type WorkflowInput,
  type WorkflowRun,
  type ApprovalResponse,
  type TaskRequestInput,
} from "@melra/protocol";

interface ClientIdentity {
  clientName?: string;
  clientVersion?: string;
}

/** Spawn `melra serve` (or `command`) as a child and speak MCP over stdio. */
export interface MelraStdioOptions extends ClientIdentity {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Connect to a running `melra serve --http`. `url` is the MCP endpoint it
 * prints (`http://127.0.0.1:7457/mcp`); plain `http:` is accepted only for a
 * loopback host, since the token would otherwise cross the network in clear.
 */
export interface MelraHttpOptions extends ClientIdentity {
  url: string | URL;
  token: string;
  /**
   * Send the token over plain `http:` to a host that is not loopback. Off by
   * default; turn it on only for a network you trust end to end, such as a
   * private container network, and prefer `https:` everywhere else.
   */
  allowInsecureHttp?: boolean;
}

/** Connect to a running `melra serve --socket <path>`. Not on Windows. */
export interface MelraSocketOptions extends ClientIdentity {
  socketPath: string;
  token: string;
}

// `never` on the other variants' keys, so `{ url, token, cwd }` is a type
// error instead of a stdio option silently ignored by an HTTP connection.
type Without<K extends string> = { [P in K]?: never };
type StdioKeys = "command" | "args" | "cwd" | "env";

export type MelraClientOptions =
  | (MelraStdioOptions & Without<"url" | "socketPath" | "token" | "allowInsecureHttp">)
  | (MelraHttpOptions & Without<StdioKeys | "socketPath">)
  | (MelraSocketOptions & Without<StdioKeys | "url" | "allowInsecureHttp">);

interface TextContent {
  type: string;
  text?: string;
}

export function parseMelraToolResult(result: unknown): Record<string, unknown> {
  const response = result as {
    isError?: boolean;
    content?: TextContent[];
  };
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error("melra_missing_text_result");
  if (response.isError === true) throw new Error(text);
  return JSON.parse(text) as Record<string, unknown>;
}

export class MelraClient {
  private constructor(private readonly client: Client) {}

  static async connect(options: MelraClientOptions = {}): Promise<MelraClient> {
    const transport =
      options.url !== undefined
        ? httpTransport(options.url, options.token, options.allowInsecureHttp === true)
        : options.socketPath !== undefined
          ? socketTransport(options.socketPath, options.token)
          : new StdioClientTransport({
              command: options.command ?? "melra",
              args: options.args ?? ["serve"],
              ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
              ...(options.env === undefined ? {} : { env: options.env }),
              stderr: "pipe",
            });
    const client = new Client({
      name: options.clientName ?? "melra-sdk",
      version: options.clientVersion ?? "0.1.0",
    });
    try {
      await client.connect(transport);
    } catch (error) {
      // `Client.connect` has already closed the transport. Without an OAuth
      // provider the MCP client reports a refused token as a generic POST
      // failure; name it, since it is the one failure a caller can fix.
      if (error instanceof StreamableHTTPError && error.code === 401) {
        throw new Error(
          "melra_unauthorized: the server refused the token; use the one `melra serve` printed or MELRA_HTTP_TOKEN",
          { cause: error },
        );
      }
      throw error;
    }
    return new MelraClient(client);
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return parseMelraToolResult(
      await this.client.callTool({ name, arguments: args }),
    );
  }

  async capabilities(): Promise<Record<string, unknown>> {
    return await this.call("melra_capabilities", {});
  }

  // Takes the pre-defaults shape and parses, the same way `planWorkflow` does.
  // `TaskRequest` is what the schema produces, so requiring it would make every
  // caller restate `encoding`, `recursive`, and `maxSteps` by hand to satisfy
  // the compiler — defaults the schema already knows.
  async plan(request: TaskRequestInput): Promise<Record<string, unknown>> {
    const parsed = TaskRequestSchema.parse(request);
    return await this.call(
      "melra_plan",
      parsed as unknown as Record<string, unknown>,
    );
  }

  async execute(
    taskId: string,
    approval?: ApprovalResponse,
  ): Promise<Record<string, unknown>> {
    return await this.call("melra_execute", {
      taskId,
      ...(approval === undefined ? {} : { approval }),
    });
  }

  async status(taskId: string): Promise<Record<string, unknown>> {
    return await this.call("melra_task_status", { taskId });
  }

  async cancel(taskId: string): Promise<Record<string, unknown>> {
    return await this.call("melra_task_cancel", { taskId });
  }

  async receipt(input: {
    taskId?: string;
    receiptId?: string;
  }): Promise<Record<string, unknown>> {
    // The server says the same thing, but saying it here costs no round trip and
    // matches the Python SDK.
    if (input.taskId === undefined && input.receiptId === undefined) {
      throw new Error("taskId or receiptId is required");
    }
    return await this.call("melra_receipt", {
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.receiptId === undefined ? {} : { receiptId: input.receiptId }),
    });
  }

  // Same reason as `plan`: this is the shape an author writes, not the shape the
  // schema produces.
  async planWorkflow(
    definition: WorkflowDefinitionInput,
  ): Promise<WorkflowRun> {
    const parsed = WorkflowDefinitionSchema.parse(definition);
    return WorkflowRunSchema.parse(
      await this.call("melra_workflow_plan", {
        definition: parsed,
      }),
    );
  }

  async advanceWorkflow(
    workflowId: string,
    approvals: ApprovalResponse[] = [],
    inputs: WorkflowInput[] = [],
  ): Promise<WorkflowAdvanceResult> {
    const parsed = WorkflowAdvanceInputSchema.parse({
      workflowId,
      approvals,
      inputs,
    });
    return WorkflowAdvanceResultSchema.parse(
      await this.call("melra_workflow_advance", parsed),
    );
  }

  async workflowStatus(workflowId: string): Promise<WorkflowRun> {
    const parsed = WorkflowIdInputSchema.parse({ workflowId });
    return WorkflowRunSchema.parse(
      await this.call("melra_workflow_status", parsed),
    );
  }

  async cancelWorkflow(workflowId: string): Promise<WorkflowRun> {
    const parsed = WorkflowIdInputSchema.parse({ workflowId });
    return WorkflowRunSchema.parse(
      await this.call("melra_workflow_cancel", parsed),
    );
  }

  async controlWorkflow(
    workflowId: string,
    action: "pause" | "resume" | "suspend",
  ): Promise<WorkflowRun> {
    const parsed = WorkflowControlInputSchema.parse({ workflowId, action });
    return WorkflowRunSchema.parse(
      await this.call("melra_workflow_control", parsed),
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
