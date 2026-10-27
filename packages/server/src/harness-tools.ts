// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Harness adapter: ordinary tool names on top of the kernel.
//
// The twelve `melra_*` tools are the kernel's own vocabulary, and a model asked
// to plan, read an approval challenge, and execute for every small read spends
// most of its turn on ceremony. This surface gives a harness what it already
// knows how to call — `read_file`, `write_file`, `run_command`, `browser_click`
// — and runs plan → policy → approval → execute → verify → receipt underneath.
// Nothing here is a shortcut past a stage: it builds an ordinary `TaskRequest`
// and hands it to the same `TaskController`. A mutation still stops for
// approval. In developer mode the tool reports the approval phrase instead of
// pretending it was asked for; in enforced mode there is no phrase, and the
// tool says an operator approves out of band.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  attributeTo,
  callerRef,
  type EvidencePredicate,
  OperationSchema,
  type Principal,
  principalRef,
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
const pageUrl = z
  .string()
  .url()
  .max(8_192)
  .optional()
  .describe("The page the action acts on, as policy and the approver see it.");

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
    // The goal is stored with only secret shapes taken out (#385), and a
    // query, fragment or userinfo can carry a credential of no recognisable
    // shape, so it names the page as the stored URL does: parsed, without them.
    goal: (a) => {
      const url = new URL(a.url);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return `Open ${url}`;
    },
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
    description:
      "Click one element on the current page. Needs approval. `url` names that page: the click is refused anywhere else, and in enforced mode it is required.",
    input: { target, url: pageUrl },
    readOnly: false,
    goal: () => "Click an element",
    operation: (a) => ({ kind: "browser", action: "click", target: a.target, ...(a.url === undefined ? {} : { url: a.url }) }),
  }),
  browser_type: tool({
    title: "Type into a field",
    description:
      "Type text into one field on the current page. Needs approval. `url` names that page: typing is refused anywhere else, and in enforced mode it is required.",
    input: { target, value: z.string().max(100_000), url: pageUrl },
    readOnly: false,
    goal: () => "Type into a field",
    operation: (a) => ({
      kind: "browser",
      action: "type",
      target: a.target,
      value: a.value,
      ...(a.url === undefined ? {} : { url: a.url }),
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
              ? "The adapter reported success but declared evidence, or a check MELRA makes itself, did not hold. Treat this as unproven, not done."
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
  // Enforced mode only extends or loosens what is registered, so developer
  // mode's tool list is unchanged byte for byte.
  const enforced = runtime.policy.mode === "enforced";
  for (const [name, definition] of Object.entries(HARNESS_TOOLS)) {
    server.registerTool(
      name,
      {
        title: definition.title,
        description:
          enforced && name === "write_file"
            ? "Create or overwrite one workspace file. Needs approval: an operator approves it with `melra approve <taskId>`, then call `approve`."
            : definition.description,
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
        // A goal is capped at 10,000 characters, and one built from an
        // accepted input can pass that: a `recall` query of 10,000, or a
        // non-ASCII URL that percent-encoding lengthens up to ninefold. Cut
        // through, it could keep part of a secret no pattern then matches, so
        // it keeps only its verb; the operation still carries the input.
        const goal = definition.goal(parsed);
        const task = runtime.controller.plan(
          TaskRequestSchema.parse({
            goal: goal.length <= 10_000 ? goal : `${goal.split(" ", 1)[0]} (input too long to restate)`,
            operation: definition.operation(parsed),
            ...(definition.evidence === undefined
              ? {}
              : { requiredEvidence: definition.evidence(parsed) }),
            ...(client === undefined
              ? {}
              : { identity: attributeTo(client) }),
          }),
          { client: callerRef(client) },
        );
        if (task.status === "policy_blocked") {
          return toolResult({
            status: "blocked",
            taskId: task.id,
            reason: task.policyDecision.reason,
          });
        }
        if (task.status === "awaiting_approval" && task.approval !== undefined) {
          // The approval is scoped to this task and this exact operation, so
          // it travels with the task id rather than standing alone. Re-planning
          // on the approving call would mint a different task and a different
          // challenge — which is the property that stops approved arguments
          // from being swapped for others. Enforced mode issues no phrase.
          return toolResult({
            status: "approval_required",
            taskId: task.id,
            ...(task.approval.phrase === undefined ? {} : { phrase: task.approval.phrase }),
            expiresAt: task.approval.expiresAt,
            next:
              task.approval.phrase === undefined
                ? `An operator approves this outside the conversation with \`melra approve ${task.id}\`; then call \`approve\` with this taskId and no phrase.`
                : "Show the phrase to the person who has to authorise this, then call `approve` with this taskId and the phrase they confirm.",
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
      description: enforced
        ? "Run the task a previous tool call held for approval, once an operator has approved it outside this conversation with `melra approve <taskId>`. Pass no phrase: none is issued, and one sent is refused. The task runs the operation that was approved; nothing about it can be changed here."
        : "Run the task a previous tool call held for approval, using the exact phrase it returned. The task runs the operation that was approved; nothing about it can be changed here.",
      inputSchema: {
        taskId: z.string().uuid(),
        // Optional only where no phrase is ever issued.
        phrase: enforced ? z.string().min(1).max(200).optional() : z.string().min(1).max(200),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ taskId, phrase }) => {
      runtime.controller.assertCaller(taskId, callerRef(client));
      const held = runtime.controller.status(taskId);
      if (held.approval === undefined) {
        return toolResult({ status: "blocked", taskId, reason: "no_approval_pending" });
      }
      const executed = await runtime.controller.execute(
        taskId,
        phrase === undefined ? undefined : { approvalId: held.approval.approvalId, phrase },
        client === undefined ? undefined : { agent: principalRef(client) },
      );
      return toolResult(summarize(taskId, executed.task.status, executed.output));
    },
  );
}
