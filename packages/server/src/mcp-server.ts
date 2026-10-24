// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  attributeTo,
  callerRef,
  IdentitySchema,
  type Principal,
  MelraCapabilitiesInputSchema,
  MelraExecuteInputSchema,
  MelraPlanInputSchema,
  MelraReceiptInputSchema,
  MelraTaskCancelInputSchema,
  MelraTaskJudgeInputSchema,
  MelraTaskStatusInputSchema,
  OperationSchema,
  PRODUCT_VERSION,
  principalRef,
  PROTOCOL_VERSION,
  TaskRequestSchema,
  TOOL_NAMES,
  WorkflowAdvanceInputSchema,
  WorkflowControlInputSchema,
  WorkflowDefinitionSchema,
  WorkflowIdInputSchema,
  WorkflowPlanInputSchema,
} from "@melra/protocol";
import type { MelraRuntime } from "./runtime.js";
import { HARNESS_TOOLS, registerHarnessTools } from "./harness-tools.js";

/**
 * Whether to also expose the ordinary tool names a harness already knows.
 * Opt-in, because a client that shows all twenty-five tools at once buys
 * confusion rather than convenience: the kernel vocabulary is the default, and
 * `MELRA_HARNESS_TOOLS=1` adds the adapter surface on top.
 */
export function harnessToolsEnabled(environment: NodeJS.ProcessEnv): boolean {
  const raw = environment.MELRA_HARNESS_TOOLS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function toolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

/**
 * The one description of what this server can do. The HTTP API serves the same
 * object, so a console and a model cannot be told different stories about the
 * posture they are operating under.
 */
export function capabilitiesPayload(runtime: MelraRuntime): unknown {
  const harnessTools = harnessToolsEnabled(process.env);
  return {
        product: "MELRA",
        version: PRODUCT_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        tools: harnessTools
          ? [...TOOL_NAMES, ...Object.keys(HARNESS_TOOLS), "approve"]
          : TOOL_NAMES,
        operations: Object.fromEntries(
          OperationSchema.options.map((schema) => [
            schema.shape.kind.value,
            "options" in schema.shape.action
              ? [...schema.shape.action.options]
              : [schema.shape.action.value],
          ]),
        ),
        // Names for `{ type: "custom", verifier }` evidence; planning refuses
        // any other, so an agent should only offer one of these.
        customEvidence: runtime.customEvidence,
        workflowNodes: [
          "operation",
          "approval",
          "condition",
          "parallel",
          "bounded_loop",
          "checkpoint",
          "compensation",
          "human_input",
          "delegation",
        ],
        policy: {
          version: runtime.policy.version,
          workspaceRoot: runtime.policy.workspaceRoot,
          // How this kernel is deployed, said out loud on the surface a harness
          // reads. `developer` is the honest admission that the harness may have
          // another way to the same disk; `enforced` is the operator's claim that
          // it does not, and the flag a conformance run reads before deciding
          // which caveats it still has to print.
          mode: runtime.policy.mode,
          // An agent that reads capabilities should be able to tell that nothing
          // is going to stop it, and a human reading a transcript should see the
          // same. Reporting the usual read-only posture here while running
          // unhinged would be the one lie the whole surface cannot afford.
          defaultPosture: runtime.policy.unhinged ? "unhinged" : "read-only",
          unhinged: runtime.policy.unhinged,
          ...(runtime.policy.unhinged
            ? {
                unhingedWarning:
                  "No policy, approval, evidence, confinement, or destination check is applied. Every listed limit below is advisory only.",
              }
            : {}),
          mutations: runtime.policy.mutations,
          allowedCommands: runtime.policy.allowedCommands,
          // Named here because `allowedCommands` alone reads as the whole
          // terminal posture, and it is not: `npm` on the allowlist with
          // `package-install` denied permits `npm test` and refuses `npm i`.
          deniedTraits: runtime.policy.deniedTraits,
          // A caller cannot tell from a denial alone whether it is missing one
          // grant or living in a closed world, so say which one this is up
          // front. The grants themselves are the operator's to know.
          capabilityGrants: runtime.policy.capabilities.length,
          capabilityMode:
            runtime.policy.capabilities.length === 0
              ? "ungranted"
              : "granted-only",
          // A grant can run out mid-session, so a caller planning a batch needs
          // to know some of its authority is finite before it starts. Counts
          // only — which grant, for whom, and how much is the operator's.
          meteredGrants: runtime.policy.capabilities.filter(
            (grant) =>
              grant.maxOperations !== undefined ||
              grant.provider?.amountMax !== undefined ||
              grant.provider?.dailyMax !== undefined,
          ).length,
          // Worth knowing before a caller plans a retry loop: after this many
          // consecutive failures against one target, the next task touching it
          // is refused outright rather than run.
          circuitBreaker: runtime.policy.circuitBreaker,
          allowedDomains: runtime.policy.allowedDomains,
          allowLocalhost: runtime.policy.allowLocalhost,
          // Names only, and worth publishing: a caller that knows the kernel
          // holds a credential for an API stops trying to source one itself,
          // which is the whole point of it not having one.
          credentials: Object.keys(runtime.policy.credentials),
          // A blocked popup is reported on the action that provoked it, so a
          // caller knows in advance whether a window it did not open will still
          // be there to address.
          popups: runtime.policy.popups,
          telemetry: "off",
        },
  };
}

/**
 * Stamps a caller the transport authenticated onto one incoming task request.
 *
 * A session with no authenticated client is left alone: over stdio the process
 * boundary is the identity, and inventing one here would put a name in a
 * receipt that nothing checked.
 */
function attributed(
  input: Record<string, unknown>,
  client: Principal | undefined,
): unknown {
  if (client === undefined) return input;
  return {
    ...input,
    identity: attributeTo(
      client,
      input.identity === undefined
        ? undefined
        : IdentitySchema.parse(input.identity),
    ),
  };
}

/**
 * The same stamp, applied to every request inside a workflow definition.
 *
 * Walks by shape rather than by node type: a request is the only thing in a
 * definition carrying both `goal` and `operation`, so a node type added later
 * is attributed without anyone remembering to come back here — and a workflow
 * is otherwise a way to dispatch effects that no client's name reaches.
 */
function attributeRequests(value: unknown, client: Principal): void {
  if (Array.isArray(value)) {
    for (const item of value) attributeRequests(item, client);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if ("goal" in record && "operation" in record) {
    record.identity = attributeTo(
      client,
      record.identity === undefined
        ? undefined
        : IdentitySchema.parse(record.identity),
    );
    return;
  }
  for (const item of Object.values(record)) attributeRequests(item, client);
}

/**
 * How to use MELRA, for the model on the other end. Kept short and literal:
 * every claim here is enforced by the pipeline, so it cannot drift into advice.
 */
export const SERVER_INSTRUCTIONS = [
  "MELRA runs effects for you under policy: files, terminal, browser, HTTP, desktop, and memory. Use its tools instead of acting directly, and treat its results as the record of what happened.",
  "For each action:",
  "1. melra_capabilities (once): the operations available and the policy in force: allowed commands and domains, and whether mutations need approval.",
  "2. melra_plan with a goal, one operation, and requiredEvidence. Nothing runs yet. status policy_blocked means refused: read the reason and change the request; the same request will be refused again. status awaiting_approval returns an approval challenge.",
  "3. melra_execute with the taskId, plus the challenge id and its exact phrase if one was issued. Policy is checked again here.",
  "4. Read the status. verified_success means the operation ran and every requiredEvidence check passed. partial means it ran but evidence did not hold, or a semantic question was answered no. waiting_user means it ran and every check MELRA can make passed, but a semantic question (listed in judgements) waits for an answer from outside MELRA: answer it with melra_task_judge, as a principal other than the one that planned it. yes on every question → verified_success; no → partial; cannot_tell, or no answer by expiresAt → recovery_required for a change, partial for a read. A change answered no stays in place, and nothing re-runs it: fixing it takes a new plan. recovery_required means a change may or may not have happened, or happened and its semantic question went unanswered or was answered cannot_tell (error semantic_judgement_expired or semantic_judgement_cannot_tell): inspect the world before trying again, never re-run blindly. Only reads are retried for you.",
  "5. melra_receipt returns the receipt and certificate when you need to show what was done.",
  "Rules: any operation that is not a read must declare requiredEvidence describing how to confirm it (result_equals, result_contains, exit_code, file_exists, file_absent, file_hash, page_contains, url_matches, http_resource_matches, custom, semantic). custom takes a verifier name from customEvidence in melra_capabilities. Outside unsafe-local mode, semantic is never enough alone for a destructive effect, which also needs file_exists, file_absent, file_hash or http_resource_matches. Leave constraints empty; free-text constraints are refused because they cannot be enforced.",
  "For multi-step jobs that must survive restarts, use melra_workflow_plan and melra_workflow_advance; each step still goes through the same policy, approval, and verification.",
  "No tool lists all tasks or workflow runs, so keep the ids melra_plan and melra_workflow_plan return. melra_workflow_control pauses, suspends or resumes a run; melra_workflow_cancel ends it.",
].join("\n");

/**
 * Enforced mode only: the challenge carries no phrase, and an operator answers
 * it out of band. Appended rather than woven in, so developer mode's text is
 * unchanged byte for byte.
 */
const ENFORCED_APPROVAL =
  "Enforced mode: a challenge has no phrase and you cannot approve it. Anything you send as an approval is refused (approval_in_band_refused). An operator approves with `melra approve <taskId>` outside this conversation; until then melra_execute answers approval_awaiting_operator, so try again later. approval_expired means plan the task again. No verdict you send is recorded: one on a question still waiting is refused (judgement_in_band_refused); an operator judges with `melra judge <taskId> --judgement <judgementId> --verdict yes|no|cannot_tell`.";

export function createMcpServer(
  runtime: MelraRuntime,
  /** Who the transport authenticated, if it authenticated anyone. */
  client?: Principal,
): McpServer {
  const server = new McpServer(
    {
      name: "melra",
      version: PRODUCT_VERSION,
    },
    // Clients that support it (Claude Code among them) put this in the model's
    // context once, so the loop below is learned up front instead of pieced
    // together from twelve tool descriptions after a failed first call.
    {
      instructions:
        runtime.policy.mode === "enforced" ? `${SERVER_INSTRUCTIONS}\n${ENFORCED_APPROVAL}` : SERVER_INSTRUCTIONS,
    },
  );
  // Every id this server is handed is checked against who planned it, so an
  // authenticated client acts only on its own tasks and runs: an id is a
  // handle, not a credential. A halt from here is the agent's, whoever holds
  // the session; an operator's comes only through `melra workflow`.
  const caller = callerRef(client);
  const agent = { agent: client === undefined ? "agent" : principalRef(client) };
  const ownTask = (taskId: string) => runtime.controller.assertCaller(taskId, caller);
  const ownRun = (workflowId: string) => runtime.workflows.assertCaller(workflowId, caller);

  server.registerTool(
    "melra_capabilities",
    {
      title: "MELRA capabilities",
      description:
        "Report what this MELRA server can run and the policy in force. Call it once before melra_plan or melra_workflow_plan; it takes no input and changes nothing. Returns product, version and protocolVersion; tools; operations (the actions each operation kind supports); customEvidence (verifier names allowed in custom evidence); workflowNodes (node types for workflow definitions); and policy, including mode, workspaceRoot, unhinged, mutations, allowedCommands, deniedTraits, allowedDomains, circuitBreaker and credential names.",
      inputSchema: MelraCapabilitiesInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => toolResult(capabilitiesPayload(runtime)),
  );

  server.registerTool(
    "melra_plan",
    {
      title: "Plan a MELRA task",
      description:
        "Plan one bounded operation without running it: MELRA evaluates policy and stores the task in its own records only, so nothing outside MELRA changes until it runs. Send a goal, one operation and requiredEvidence, and leave constraints empty. Returns the task with its effect contract and status planned, awaiting_approval (approval holds the challenge) or policy_blocked (a normal result; policyDecision.reason says why); an invalid request, such as one naming an unregistered verifier or a file evidence path outside the workspace, fails the call instead. Keep its id: it is the taskId for melra_execute, melra_task_status, melra_task_cancel and melra_receipt. For dependent steps use melra_workflow_plan.",
      inputSchema: MelraPlanInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      toolResult(
        runtime.controller.plan(
          TaskRequestSchema.parse(attributed(input, client)),
          { client: caller },
        ),
      ),
  );

  server.registerTool(
    "melra_execute",
    {
      title: "Execute a planned MELRA task",
      description:
        "Run one task melra_plan returned, by taskId: MELRA re-evaluates policy, so a plan made under a looser policy is still refused, then runs the operation, checks its requiredEvidence and records a receipt. If the plan returned an approval challenge with a phrase, pass approval with its approvalId and exact phrase; the phrase is scoped to that one task and expires. Only reads are retried, and a recovery_required task is reconciled, never re-run: it stays recovery_required while its provider cannot be reached (task.error reconciliation_inconclusive, ask again later) or while MELRA refuses to ask its reconciliation (reconciliation_unanswerable:<reason>, which asking again will not change). Returns { task, output?, receipt?, certificate? } with the outcome in task.status. For workflow steps use melra_workflow_advance instead; a step of a paused or suspended run fails with workflow_halted:<status> until the run is resumed." +
        (runtime.policy.mode === "enforced" ? ` ${ENFORCED_APPROVAL}` : ""),
      inputSchema: MelraExecuteInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const parsed = MelraExecuteInputSchema.parse(input);
      ownTask(parsed.taskId);
      return toolResult(
        await runtime.controller.execute(parsed.taskId, parsed.approval),
      );
    },
  );

  server.registerTool(
    "melra_task_status",
    {
      title: "Inspect MELRA task status",
      description:
        "Read one task's stored record by taskId (from melra_plan, or a workflow node's taskIds), in any status, policy_blocked and cancelled included, without changing or waiting on it. Returns the task: status, policyDecision, any approval challenge and approvedBy, the redacted request and result, error, attempts, receiptIds, certificateId, judgements (with judgedBy once answered) and timestamps. Use it to re-check a task after melra_task_cancel or from another session, or to re-read a pending challenge. Use melra_receipt for receipts and the certificate, and melra_workflow_status for a whole workflow run.",
      inputSchema: MelraTaskStatusInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const parsed = MelraTaskStatusInputSchema.parse(input);
      ownTask(parsed.taskId);
      return toolResult(runtime.controller.status(parsed.taskId));
    },
  );

  server.registerTool(
    "melra_task_cancel",
    {
      title: "Cancel a MELRA task",
      description:
        "Cancel one task by taskId and return its record; nothing that already happened is undone. A planned or awaiting_approval task becomes cancelled and can no longer be executed. A task running in this MELRA process is sent an abort, which interrupts terminal run, browser, computer and http operations; the returned record predates it, so read the outcome with melra_task_status. Any other task, including one running in another process, is returned unchanged without error, and so is one another process starts at the same moment, which then runs: check the returned status. On a workflow step's task that has not started it acts as a denial: the next melra_workflow_advance fails the run and offers the compensations of the steps already done, each for its own approval, unless another step's outcome is unknown, which leaves the run recovery_required; on a compensation's task it stops the unwind, and the run becomes recovery_required. melra_workflow_cancel ends a run without compensating.",
      inputSchema: MelraTaskCancelInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const parsed = MelraTaskCancelInputSchema.parse(input);
      ownTask(parsed.taskId);
      return toolResult(runtime.controller.cancel(parsed.taskId));
    },
  );

  server.registerTool(
    "melra_receipt",
    {
      title: "Read MELRA evidence",
      description:
        "Read a task's audit trail: returns { receipts, certificate? }. Pass taskId for all of that task's receipts plus its certificate, or receiptId for one receipt plus its task's certificate; receiptId wins if both are given. Each receipt records the capability, target, effect, principal, policy decision with any approval, timings, success, redacted observed effect and evidence; the certificate gives the overall result, such as VERIFIED_SUCCESS, PARTIAL or RECOVERY_REQUIRED. Use it to show what a task did; use melra_task_status for its current state.",
      inputSchema: MelraReceiptInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const parsed = MelraReceiptInputSchema.parse(input);
      // receiptId wins, so the task it names is the one checked.
      const owner =
        parsed.receiptId === undefined ? parsed.taskId : runtime.store.getReceipt(parsed.receiptId)?.taskId;
      if (owner !== undefined) ownTask(owner);
      return toolResult(
        runtime.controller.receipts({
          ...(parsed.taskId === undefined ? {} : { taskId: parsed.taskId }),
          ...(parsed.receiptId === undefined
            ? {}
            : { receiptId: parsed.receiptId }),
        }),
      );
    },
  );

  server.registerTool(
    "melra_task_judge",
    {
      title: "Judge a MELRA task's semantic question",
      description:
        "Answer one semantic question a waiting_user task waits on. MELRA runs no model, so a semantic predicate in requiredEvidence is answered from outside it, by a principal other than the one that planned the task. Read the task with melra_task_status first: judgements lists each question's judgementId, predicateIndex and expiresAt; request.requiredEvidence[predicateIndex] is the question, and the redacted result is what the effect returned. Judge that result, not the question's framing: the question was written by whoever ran the effect. identity is required and recorded as given, beside the receipt's principal; a judge whose principal is the task's principal or a non-human link that principal acts for, or whose onBehalfOf names the task's principal, is refused (semantic_judge_is_actor). rationale is for the people reading the record: stored redacted, never read by MELRA. A yes on every question makes the task verified_success; the first no ends it partial (error semantic_judgement_no); cannot_tell ends a change recovery_required and a read partial (semantic_judgement_cannot_tell); a yes while other questions are open is recorded and the task keeps waiting. Each question is answered once. Nothing runs again and no receipt is added: only the task and, once settled, its certificate change. Returns { task, certificate? }, the certificate only when the verdict settled the task. Fails without writing anything with task_not_found, judgement_in_band_refused (a task run in enforced mode takes a verdict only from an operator), task_not_awaiting_judgement:<status>, judgement_not_found, judgement_already_answered, judgement_expired (from expiresAt on; the task then settles closed) or semantic_judge_is_actor." +
        (runtime.policy.mode === "enforced"
          ? " Enforced mode: no verdict sent here is recorded, and one on a question still waiting is refused (judgement_in_band_refused); an operator judges with `melra judge <taskId> --judgement <judgementId> --verdict yes|no|cannot_tell` outside this conversation."
          : ""),
      inputSchema: MelraTaskJudgeInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      // Parsed before it is attributed, which would otherwise stand the
      // client in for an identity the judge never declared.
      const { identity, ...judgement } = MelraTaskJudgeInputSchema.parse(
        attributed(MelraTaskJudgeInputSchema.parse(input), client),
      );
      ownTask(judgement.taskId);
      return toolResult(
        runtime.controller.judge(judgement, { identity, ...(client === undefined ? {} : { client }) }),
      );
    },
  );

  server.registerTool(
    "melra_workflow_plan",
    {
      title: "Plan a MELRA workflow",
      description:
        "Validate a multi-step workflow definition and create a new run without executing anything: MELRA writes only its own records and plans no tasks; nothing outside MELRA changes until the run is advanced. Planning fails on the graph errors it checks (workflow_* codes, such as a dependency cycle), a step melra_plan would fail on, a condition, until or delegation check no registered verifier can ask (evidence_verifier_unavailable:<name>) or on a file path outside the workspace (evidence_path_outside_workspace), or a step policy denies (workflow_policy_blocked:<nodeId>); steps needing approval ask during advance. Returns the run, planned with every node pending; its id is the workflowId, and no tool lists runs. For one operation use melra_plan.",
      inputSchema: WorkflowPlanInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const parsed = WorkflowPlanInputSchema.parse(input);
      const definition = WorkflowDefinitionSchema.parse(parsed.definition);
      if (client !== undefined) attributeRequests(definition, client);
      return toolResult(runtime.workflows.plan(definition, caller));
    },
  );

  server.registerTool(
    "melra_workflow_advance",
    {
      title: "Advance a MELRA workflow",
      description:
        "Run a workflow run's next wave; use it, not melra_execute, for workflow steps, calling again for later waves. It starts all ready nodes concurrently, each step under melra_execute's policy, approval and verification. Once the run has failed (a forward node failed, or was denied while no other's outcome is unknown), only compensations run, in reverse definition order, stopping at one that fails or is denied; otherwise nodes still waiting are offered again beside the newly ready ones, unless a waiting step's task was denied or otherwise moved since the last advance: then only the waiting nodes are offered, so nothing new starts on a run that may now fail. Approval waits return challenges in tasks; human_input and delegation nodes wait with a prompt. A step an earlier advance planned or ran without recording it (its commit failed) is taken up by its idempotency key, as recovery reads it: its challenge is offered again rather than a second one, its effect is never repeated, and one that failed or was denied stays so. Answer later via inputs and, outside enforced mode, approvals. Returns { run, tasks, events }, unchanged when nothing is due; a halted run fails with workflow_halted:<status>. A run left recovery_required names why in run.error: workflow_compensation_incomplete:<nodeId> for an unwind that stopped, workflow_condition_branch_conflict:<nodeId> for a condition whose branch not taken holds a step an interrupted advance ran that may have had an effect (settle one whose outcome is unknown with melra_execute, which reconciles it; one that took effect stays, so undo it by hand and end the run with melra_workflow_cancel, which compensates nothing), otherwise workflow_contains_unreconciled_mutation. A condition, a bounded_loop's until or a delegation's evidence its provider does not answer (a 503, a 401, no connection) decides nothing: the call fails with workflow_check_inconclusive:<nodeId>, the node waits with that check as its error (a delegation keeps its report), and each later call asks again. melra_workflow_cancel ends a run whose provider never answers, without compensating. A condition or delegation check MELRA refuses to ask (a URL token its source result cannot fill, a verifier no longer registered, a reserved path) fails its node instead (workflow_check_unresolvable:<nodeId>), and the run unwinds; a bounded_loop's until reads it as no and runs its next iteration. Either way the call fails, but a condition under which an interrupted advance ran a step whose outcome is unknown halts on that step instead of waiting or failing (recovery_required, as after a restart), so nothing unwinds past it.",
      inputSchema: WorkflowAdvanceInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const parsed = WorkflowAdvanceInputSchema.parse(input);
      ownRun(parsed.workflowId);
      return toolResult(
        await runtime.workflows.advance(
          parsed.workflowId,
          parsed.approvals,
          parsed.inputs,
        ),
      );
    },
  );

  server.registerTool(
    "melra_workflow_status",
    {
      title: "Inspect a MELRA workflow",
      description:
        "Read a workflow run in any status by workflowId without advancing or changing it; workflowId is the run id melra_workflow_plan returned, the same one melra_workflow_advance, melra_workflow_control and melra_workflow_cancel take. Returns the run: status (such as planned, running, awaiting_approval, awaiting_input, paused, suspended, verified_complete, failed, recovery_required or cancelled), error, stateVersion, definitionId, definitionVersion, timestamps, and nodes keyed by node id, each with its status, taskIds and, where set, approval, prompt, input, iterations and error. Check it before melra_workflow_advance to see what the run waits on; pass a node's taskIds to melra_task_status or melra_receipt for detail.",
      inputSchema: WorkflowIdInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const parsed = WorkflowIdInputSchema.parse(input);
      ownRun(parsed.workflowId);
      return toolResult(runtime.workflows.status(parsed.workflowId));
    },
  );

  server.registerTool(
    "melra_workflow_cancel",
    {
      title: "Cancel a MELRA workflow",
      description:
        "End a workflow run by workflowId, the run id melra_workflow_plan returned. Its pending, ready and awaiting_approval nodes, compensations included, become cancelled and the run becomes cancelled; only once that is recorded are the tasks on those nodes, and any left planned or waiting under the run's steps, cancelled as melra_task_cancel would, so a cancel that fails changes no task, and one that fails after the run is cancelled reports it: cancel again to finish. Neither resume nor melra_workflow_advance continues it. It starts and undoes no effect: no compensation runs, and other nodes keep their status, though a step's task that another process starts at the same moment may still run (check it with melra_task_status). While an advance holds the run's lease, in this process or another, it fails with workflow_lease_held and changes nothing, so the steps that advance runs are recorded: retry once the advance returns. Do not stop a running step with melra_task_cancel to get the cancel in: that fails the step, and the advance still running it starts the run's unwind (its compensations run, or wait for approval) before this cancel can land. An advance that stalled past its lease, or died holding it, is taken over. The run's steps are first read again from their tasks, so what an advance that stalled, died or lost its commit ran is recorded on the cancelled run, and a step's task still running is cancelled as melra_task_cancel would: that step is recorded as still in flight (recovery_required, task_still_in_flight), not as cancelled, and one running in this process is recorded as it ends once it stops (tried again while something else holds the run's lease); cancelling the run again records any such step whose task has since ended, in any process. Works on paused, suspended and failed runs too. Returns the updated run: unchanged if already verified_complete, and if already cancelled changed only by recording such steps. To halt a run and continue later, use melra_workflow_control.",
      inputSchema: WorkflowIdInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const parsed = WorkflowIdInputSchema.parse(input);
      ownRun(parsed.workflowId);
      return toolResult(runtime.workflows.cancel(parsed.workflowId));
    },
  );

  server.registerTool(
    "melra_workflow_control",
    {
      title: "Pause, resume, or suspend a MELRA workflow",
      description:
        "Halt a workflow run or lift the halt, without changing node state. action pause or suspend (same behaviour; only the status name differs) sets the run's status to paused or suspended unless it is verified_complete, cancelled or failed; melra_workflow_advance then fails with workflow_halted:<status> while the run is halted. Halt between advances: while an advance holds the run's lease, in this process or another, pause, suspend and resume fail with workflow_lease_held and change nothing, so retry once it returns. resume needs a paused or suspended run, sets the status its nodes imply and runs nothing, so call melra_workflow_advance next. Returns the updated run. To end a run instead, use melra_workflow_cancel." +
        (runtime.policy.mode === "enforced"
          ? " Enforced mode: a halt an operator made with `melra workflow pause` or `suspend` is lifted only by the operator, so resume fails with workflow_resume_needs_operator, even on a run this tool had halted first; a halt made only here can be resumed here."
          : ""),
      inputSchema: WorkflowControlInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const parsed = WorkflowControlInputSchema.parse(input);
      ownRun(parsed.workflowId);
      return toolResult(
        parsed.action === "pause"
          ? runtime.workflows.pause(parsed.workflowId, agent)
          : parsed.action === "suspend"
            ? runtime.workflows.suspend(parsed.workflowId, agent)
            : runtime.workflows.resume(parsed.workflowId, agent),
      );
    },
  );
  if (harnessToolsEnabled(process.env)) {
    registerHarnessTools(server, runtime, client);
  }
  return server;
}

export async function serveStdio(runtime: MelraRuntime): Promise<McpServer> {
  const server = createMcpServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
