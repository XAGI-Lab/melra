// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Harness adapter: ordinary tool names on top of the kernel.
//
// The eleven `melra_*` tools are the kernel's own vocabulary, and a model asked
// to plan, read an approval challenge, and execute for every small read spends
// most of its turn on ceremony. This surface gives a harness what it already
// knows how to call — `read_file`, `write_file`, `run_command`, `browser_click`
// — and runs plan → policy → approval → execute → verify → receipt underneath.
// Nothing here is a shortcut past a stage: it builds an ordinary `TaskRequest`
// and hands it to the same `TaskController`. A mutation still stops on an
// approval phrase; the tool reports the phrase instead of pretending it was
// asked for.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  attributeTo,
  type EvidencePredicate,
  OperationSchema,
  type Principal,
  TaskRequestSchema,
} from "@melra/protocol";
import { z } from "zod";
import type { MelraRuntime } from "./runtime.js";

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

const path = z.string().min(1).max(4_096);
const target = z
  .object({
    selector: z.string().min(1).max(2_000).optional(),
    role: z.string().min(1).max(100).optional(),
    name: z.string().max(500).optional(),
    text: z.string().max(2_000).optional(),
  })
  .strict()
  .describe("How to find the element: a CSS selector, or a role plus its accessible name, or visible text.");

interface HarnessTool<Shape extends z.ZodRawShape> {
  title: string;
  description: string;
  input: Shape;
  readOnly: boolean;
  goal: (args: z.infer<z.ZodObject<Shape>>) => string;
  // The schema's *input* type: defaults like `encoding` and `timeoutMs` belong
  // to the schema, and restating them here would be a second place for them to
  // drift.
  operation: (args: z.infer<z.ZodObject<Shape>>) => z.input<typeof OperationSchema>;
  /**
   * Only for operations where `defaultEvidenceFor` can derive nothing — a
   * command says nothing about what it should leave behind, so the exit code is
   * the one post-condition the request itself justifies.
   */
  evidence?: (args: z.infer<z.ZodObject<Shape>>) => EvidencePredicate[];
}

function tool<Shape extends z.ZodRawShape>(
  definition: HarnessTool<Shape>,
): HarnessTool<z.ZodRawShape> {
  return definition as unknown as HarnessTool<z.ZodRawShape>;
}

export const HARNESS_TOOLS: Record<string, HarnessTool<z.ZodRawShape>> = {
  read_file: tool({
    title: "Read a file",
    description: "Read one workspace file as text.",
    input: { path },
    readOnly: true,
    goal: (a) => `Read ${a.path}`,
    operation: (a) => ({ kind: "file", action: "read", path: a.path }),
  }),
  list_files: tool({
    title: "List a directory",
    description: "List the entries of one workspace directory.",
    input: { path, recursive: z.boolean().default(false) },
    readOnly: true,
    goal: (a) => `List ${a.path}`,
    operation: (a) => ({
      kind: "file",
      action: "list",
      path: a.path,
      recursive: a.recursive,
    }),
  }),
  write_file: tool({
    title: "Write a file",
    description:
      "Create or overwrite one workspace file. Needs approval: the first call returns a phrase to pass to `approve`.",
    input: { path, content: z.string().max(1_000_000) },
    readOnly: false,
    goal: (a) => `Write ${a.path}`,
    operation: (a) => ({
      kind: "file",
      action: "write",
      path: a.path,
      content: a.content,
    }),
  }),
  move_file: tool({
    title: "Move a file",
    description: "Move or rename one workspace file. Needs approval.",
    input: { path, destination: path },
    readOnly: false,
    goal: (a) => `Move ${a.path} to ${a.destination}`,
    operation: (a) => ({
      kind: "file",
      action: "move",
      path: a.path,
      destination: a.destination,
    }),
  }),
  delete_file: tool({
    title: "Delete a file",
    description: "Delete one workspace file or directory. Needs approval.",
    input: { path, recursive: z.boolean().default(false) },
    readOnly: false,
    goal: (a) => `Delete ${a.path}`,
    operation: (a) => ({
      kind: "file",
      action: "delete",
      path: a.path,
      recursive: a.recursive,
    }),
  }),
  run_command: tool({
    title: "Run a command",
    description:
      "Run one allowlisted executable with arguments. No shell: the command is spawned directly, so pipes, globs, and `&&` are not interpreted. Needs approval unless policy classifies it as a read.",
    input: {
      command: z.string().min(1).max(512),
      args: z.array(z.string().max(4_096)).max(100).default([]),
      cwd: path.optional(),
    },
    readOnly: false,
    goal: (a) => `Run ${a.command}`,
    operation: (a) => ({
      kind: "terminal",
      action: "run",
      command: a.command,
      args: a.args,
      ...(a.cwd === undefined ? {} : { cwd: a.cwd }),
    }),
    // A command's own post-condition is unknowable from the request, and a
    // mutation nobody can check is what should not run unattended — so assert
    // the one thing the request does justify.
    evidence: () => [{ type: "exit_code", value: 0 }],
  }),
  browse: tool({
    title: "Open a page",
    description: "Navigate the browser to a URL and report the page it landed on.",
    input: { url: z.string().url().max(8_192) },
    readOnly: false,
    goal: (a) => `Open ${a.url}`,
    operation: (a) => ({ kind: "browser", action: "navigate", url: a.url }),
  }),
  browser_read: tool({
    title: "Read the page",
    description:
      "Report the page's interactive elements with the selectors that address them, optionally scoped to one target.",
    input: { target: target.optional() },
    readOnly: true,
    goal: () => "Inspect the current page",
    operation: (a) => ({
      kind: "browser",
      action: "inspect",
      ...(a.target === undefined ? {} : { target: a.target }),
    }),
  }),
  browser_click: tool({
    title: "Click an element",
    description: "Click one element on the current page. Needs approval.",
    input: { target },
    readOnly: false,
    goal: () => "Click an element",
    operation: (a) => ({ kind: "browser", action: "click", target: a.target }),
  }),
  browser_type: tool({
    title: "Type into a field",
    description: "Type text into one field on the current page. Needs approval.",
    input: { target, value: z.string().max(100_000) },
    readOnly: false,
    goal: () => "Type into a field",
    operation: (a) => ({
      kind: "browser",
      action: "type",
      target: a.target,
      value: a.value,
    }),
  }),
  remember: tool({
    title: "Remember a fact",
    description:
      "Store one operational fact for later retrieval. Needs approval. This is the kernel's own record of what it did and was told, not a semantic memory of a conversation.",
    input: {
      key: z.string().min(1).max(512),
      value: z.string().max(1_000_000),
      tags: z.array(z.string().min(1).max(128)).max(50).default([]),
    },
    readOnly: false,
    goal: (a) => `Remember ${a.key}`,
    operation: (a) => ({
      kind: "memory",
      action: "put",
      key: a.key,
      value: a.value,
      tags: a.tags,
    }),
  }),
  recall: tool({
    title: "Recall facts",
    description: "Search stored operational facts.",
    input: { query: z.string().max(10_000), limit: z.number().int().min(1).max(100).default(20) },
    readOnly: true,
    goal: (a) => `Recall ${a.query}`,
    operation: (a) => ({
      kind: "memory",
      action: "search",
      query: a.query,
      limit: a.limit,
    }),
  }),
};

/**
 * What the caller gets back. Deliberately not the whole `TaskRecord`: a harness
 * tool that answered with the kernel's internal envelope would just be the
 * kernel's vocabulary again under a friendlier name. The task id is here so the
 * receipt, the certificate, and the full record stay one `melra_receipt` away.
 */
function summarize(
  taskId: string,
  status: string,
  output?: Record<string, unknown>,
): unknown {
  return {
    status,
    taskId,
    ...(output === undefined ? {} : { result: output }),
    ...(status === "verified_success"
      ? {}
      : {
          note:
            status === "partial"
              ? "The adapter reported success but declared evidence did not hold. Treat this as unproven, not done."
              : "The task did not verify. Read melra_receipt for the evidence and the certificate.",
        }),
  };
}

export function registerHarnessTools(
  server: McpServer,
  runtime: MelraRuntime,
  /** Who the transport authenticated, recorded on every task these plan. */
  client?: Principal,
): void {
  for (const [name, definition] of Object.entries(HARNESS_TOOLS)) {
    server.registerTool(
      name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.input,
        annotations: {
          readOnlyHint: definition.readOnly,
          destructiveHint: !definition.readOnly,
          idempotentHint: false,
          openWorldHint: !definition.readOnly,
        },
      },
      async (args: Record<string, unknown>) => {
        const parsed = z.object(definition.input).parse(args);
        const task = runtime.controller.plan(
          TaskRequestSchema.parse({
            goal: definition.goal(parsed),
            operation: definition.operation(parsed),
            ...(definition.evidence === undefined
              ? {}
              : { requiredEvidence: definition.evidence(parsed) }),
            ...(client === undefined
              ? {}
              : { identity: attributeTo(client) }),
          }),
        );
        if (task.status === "policy_blocked") {
          return toolResult({
            status: "blocked",
            taskId: task.id,
            reason: task.policyDecision.reason,
          });
        }
        if (task.status === "awaiting_approval" && task.approval !== undefined) {
          // The phrase is scoped to this task and this exact operation, so it
          // travels with the task id rather than standing alone. Re-planning on
          // the approving call would mint a different task and a different
          // phrase — which is the property that stops approved arguments from
          // being swapped for others.
          return toolResult({
            status: "approval_required",
            taskId: task.id,
            phrase: task.approval.phrase,
            expiresAt: task.approval.expiresAt,
            next: "Show the phrase to the person who has to authorise this, then call `approve` with this taskId and the phrase they confirm.",
          });
        }
        const executed = await runtime.controller.execute(task.id);
        return toolResult(summarize(task.id, executed.task.status, executed.output));
      },
    );
  }

  server.registerTool(
    "approve",
    {
      title: "Approve and run a held task",
      description:
        "Run the task a previous tool call held for approval, using the exact phrase it returned. The task runs the operation that was approved; nothing about it can be changed here.",
      inputSchema: {
        taskId: z.string().uuid(),
        phrase: z.string().min(1).max(200),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, phrase }) => {
      const held = runtime.controller.status(taskId);
      if (held.approval === undefined) {
        return toolResult({ status: "blocked", taskId, reason: "no_approval_pending" });
      }
      const executed = await runtime.controller.execute(taskId, {
        approvalId: held.approval.approvalId,
        phrase,
      });
      return toolResult(summarize(taskId, executed.task.status, executed.output));
    },
  );
}
