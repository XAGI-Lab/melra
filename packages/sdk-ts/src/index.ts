// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
  /**
   * How long `execute()` and `advanceWorkflow()` wait for the server, in whole
   * milliseconds from 1 to 2 147 483 647. The default, 36 minutes, covers a
   * task's budget (15 minutes at most) and then its built-in evidence reads (20
   * predicates of up to a minute each), so the client does not give up on an
   * effect the server is still running and may still verify. Raise it for what
   * that does not cover: custom verifiers and `file_hash` on a very large file,
   * which have no time limit, and an `advanceWorkflow()` call that runs several
   * tasks in turn (a loop's or a branch's steps, or, when a step fails, every
   * compensation). After a timeout, read the task or the run before acting on
   * it: the server may still be at work.
   */
  runTimeoutMs?: number;
}

/**
 * `budget.maxDurationMs`'s cap, then 20 evidence predicates at the 60 s probe
 * cap (verification is not timed by the budget), with a minute to answer in.
 */
const RUN_TIMEOUT_MS = 900_000 + 20 * 60_000 + 60_000;

/** Node's timer ceiling: past it, as for 0, NaN or a negative, a timer fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;

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

/**
 * The settings of this process worth passing to a stdio server it spawns:
 * where its state and policy live, and a stricter mode. Not the ones that
 * would redirect or widen it: MELRA_SOCKET moved older versions of `melra
 * serve` off stdio, so connecting hung; MELRA_UNHINGED unconfines it, with a banner nobody reads; and an
 * explicit `cwd` decides the workspace over an inherited MELRA_WORKSPACE.
 * Pass any of those in `env` to mean them.
 */
function melraSettings(environment: NodeJS.ProcessEnv, cwd: string | undefined): Record<string, string> {
  const names = ["MELRA_HOME", "MELRA_POLICY", "MELRA_MODE", "MELRA_PAYLOAD_KEY"];
  if (cwd === undefined) names.push("MELRA_WORKSPACE");
  return Object.fromEntries(
    names.flatMap((name) => (environment[name] === undefined ? [] : [[name, environment[name]!]])),
  );
}

/**
 * Ends an HTTP or socket session, waiting at most two seconds: a server that
 * never answers the DELETE held close() for minutes, or for good over a
 * socket. client.close() then aborts the request, which shares its signal.
 */
async function endSession(transport: StreamableHTTPClientTransport): Promise<void> {
  await Promise.race([
    transport.terminateSession().catch(() => undefined),
    new Promise((settled) => setTimeout(settled, 2_000).unref()),
  ]);
}

export class MelraClient {
  private constructor(
    private readonly client: Client,
    private readonly runTimeoutMs: number,
  ) {}

  static async connect(options: MelraClientOptions = {}): Promise<MelraClient> {
    // Anything else becomes a timer that fires in a millisecond, so every
    // execute() would report a timeout while the server ran the effect.
    const runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
    if (!Number.isInteger(runTimeoutMs) || runTimeoutMs < 1 || runTimeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(
        `melra_run_timeout_invalid: runTimeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}`,
      );
    }
    const transport =
      options.url !== undefined
        ? httpTransport(options.url, options.token, options.allowInsecureHttp === true)
        : options.socketPath !== undefined
          ? socketTransport(options.socketPath, options.token)
          : new StdioClientTransport({
              command: options.command ?? "melra",
              args: options.args ?? ["serve"],
              ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
              // The MCP SDK passes the child only HOME, PATH and a few more,
              // so MELRA_MODE, MELRA_POLICY and MELRA_HOME set for this
              // process were dropped and the server ran configured differently.
              env: { ...melraSettings(process.env, options.cwd), ...options.env },
              stderr: "pipe",
            });
    const client = new Client({
      name: options.clientName ?? "melra-sdk",
      version: options.clientVersion ?? "0.1.0",
    });
    // Read, so a server with a lot to say never blocks on a full pipe, and
    // kept, so one that refuses to start says why: a bad policy, an unwritable
    // MELRA_HOME and a missing node:sqlite all read "Connection closed".
    let said = "";
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on("data", (chunk: Buffer) => {
        said = (said + chunk.toString("utf8")).slice(-2_000);
      });
    }
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
      if (transport instanceof StdioClientTransport) {
        // Its last words can land a moment after the transport reports the close.
        await new Promise((settled) => setTimeout(settled, 50));
        if (said.trim() !== "") {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`${reason}; the server said: ${said.trim()}`, { cause: error });
        }
      }
      throw error;
    }
    return new MelraClient(client, runTimeoutMs);
  }

  /**
   * `long` for the two calls that run effects: the MCP client otherwise gives
   * up after 60 s, while the server goes on running the task and may verify
   * it, and a caller who reads that error as a failure runs it again.
   */
  private async call(
    name: string,
    args: Record<string, unknown>,
    long = false,
  ): Promise<Record<string, unknown>> {
    return parseMelraToolResult(
      await this.client.callTool(
        { name, arguments: args },
        undefined,
        long ? { timeout: this.runTimeoutMs } : undefined,
      ),
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
    return await this.call(
      "melra_execute",
      {
        taskId,
        ...(approval === undefined ? {} : { approval }),
      },
      true,
    );
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
      await this.call("melra_workflow_advance", parsed, true),
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
    // Over HTTP or a socket the session lives on the server until it is ended;
    // closing the client only aborts its requests. Best effort: a server that
    // is already gone has no session left to end.
    const transport = this.client.transport;
    if (transport instanceof StreamableHTTPClientTransport) {
      await endSession(transport);
    }
    await this.client.close();
  }
}
