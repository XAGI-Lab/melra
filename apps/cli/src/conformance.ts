// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * The compatibility suite, run against a live endpoint rather than a build.
 *
 * A runtime that speaks these tools is asking to be trusted with real effects,
 * and "it has the right tool names" is not that claim. This drives one probe
 * effect through the whole pipeline over an actual transport and reports the
 * highest level the endpoint earned:
 *
 *   L1 typed effects     — every effect is a strict, bounded, typed request
 *   L2 governed effects  — policy and approval decide before anything runs
 *   L3 verified effects  — nothing is success without evidence, and every
 *                          effect leaves a receipt
 *
 * Levels are cumulative and ordered by what they let you conclude, so the
 * report names the highest level with no failed check at or below it. A
 * runtime claims a level by publishing this report.
 *
 * Read `notProven` before quoting a result. This is a black-box check of one
 * endpoint: it can show that the endpoint governs the effects it is asked for,
 * and it cannot show that the harness on the other side has no second way to
 * reach the same disk.
 */

import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { PRODUCT_VERSION } from "@melra/protocol";

export const CONFORMANCE_SUITE = "melra-conformance/1";

const LEVEL_NAMES: Record<number, string> = {
  0: "none",
  1: "L1 typed effects",
  2: "L2 governed effects",
  3: "L3 verified effects",
};

/** The kernel surface. A harness adapter may add tools; it may not remove one. */
const KERNEL_TOOLS = [
  "melra_capabilities",
  "melra_plan",
  "melra_execute",
  "melra_task_status",
  "melra_task_cancel",
  "melra_receipt",
  "melra_workflow_plan",
  "melra_workflow_advance",
  "melra_workflow_status",
  "melra_workflow_cancel",
  "melra_workflow_control",
] as const;

const NOT_PROVEN = [
  "That the harness has no second, ungoverned path to the same systems. A harness holding both a MELRA terminal and a native one makes the kernel optional, and an optional boundary is not a trust boundary. Nothing observable from this side distinguishes the two.",
  "That the endpoint's own policy is well chosen. The suite checks that policy is consulted and obeyed, not that it says the right thing.",
  "Anything about effects this suite does not exercise. It probes one file effect end to end; browser, terminal, computer, and memory adapters are out of scope.",
];

interface Check {
  level: number;
  name: string;
  passed: boolean;
  detail: string;
}

interface Reply {
  ok: boolean;
  value: Record<string, unknown>;
  text: string;
}

function must(condition: unknown, detail: string): asserts condition {
  if (condition !== true) throw new Error(detail);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A field the report needs from an untyped reply, or a failed check saying so. */
function field<T>(source: Record<string, unknown>, path: string): T {
  let value: unknown = source;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null || !(key in value)) {
      throw new Error(`reply has no ${path}`);
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value as T;
}

export interface ConformanceOptions {
  /** Loopback MCP endpoint. Omit to spawn a stdio server instead. */
  url?: string;
  token?: string;
  /** Stdio server command and arguments. Defaults to this CLI's own `serve`. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** The level being claimed. The run fails if the endpoint falls short of it. */
  claim?: number;
}

/**
 * Every call goes through here, and none of them throws.
 *
 * A refusal is a result in this suite — "the endpoint said no" is what half the
 * checks are looking for — so the transport's own error signalling has to be
 * data rather than control flow. `ok` is false for both a tool that answered
 * with `isError` and a protocol-level failure, because from the caller's side
 * those are the same fact: the effect did not happen.
 */
function caller(
  client: Client,
): (name: string, args: Record<string, unknown>) => Promise<Reply> {
  return async (name, args) => {
    try {
      const result = (await client.callTool({ name, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text =
        result.content?.find((item) => item.type === "text")?.text ?? "";
      if (result.isError === true) return { ok: false, value: {}, text };
      return {
        ok: true,
        value: JSON.parse(text) as Record<string, unknown>,
        text,
      };
    } catch (error) {
      return { ok: false, value: {}, text: message(error) };
    }
  };
}

export async function runConformance(
  options: ConformanceOptions = {},
): Promise<{ report: Record<string, unknown>; failed: boolean }> {
  const claim = options.claim ?? 3;
  const client = new Client({
    name: "melra-conformance",
    version: PRODUCT_VERSION,
  });
  const target = await connect(client, options);
  const call = caller(client);

  const checks: Check[] = [];
  const check = async (
    level: number,
    name: string,
    run: () => Promise<string>,
  ): Promise<void> => {
    try {
      checks.push({ level, name, passed: true, detail: await run() });
    } catch (error) {
      checks.push({ level, name, passed: false, detail: message(error) });
    }
  };

  // Unique per run, so the suite can never collide with — or delete — a file
  // that was already there. Flat rather than in a directory, so cleanup is one
  // named file and never a recursive delete of something a user owns.
  const probe = `melra-conformance-${randomBytes(4).toString("hex")}.txt`;
  const marker = `melra conformance ${CONFORMANCE_SUITE}\n`;
  const write = {
    kind: "file",
    action: "write",
    path: probe,
    content: marker,
  };
  let probeWritten = false;
  let approvalId: string | undefined;
  let phrase: string | undefined;
  let writeTaskId: string | undefined;

  await check(1, "kernel-tools-present", async () => {
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    const missing = KERNEL_TOOLS.filter((tool) => !listed.includes(tool));
    must(missing.length === 0, `missing tools: ${missing.join(", ")}`);
    return `${KERNEL_TOOLS.length} kernel tools present of ${listed.length} offered`;
  });

  await check(1, "capabilities-describe-the-surface", async () => {
    const reply = await call("melra_capabilities", {});
    must(reply.ok, reply.text);
    const version = field<string>(reply.value, "version");
    const file = field<string[]>(reply.value, "operations.file");
    for (const action of ["read", "write", "delete"]) {
      must(file.includes(action), `operations.file omits ${action}`);
    }
    return `version ${version}, ${file.length} file actions declared`;
  });

  await check(1, "unknown-field-rejected", async () => {
    const reply = await call("melra_plan", {
      goal: "Conformance: an operation carrying a field the schema does not know",
      operation: { ...write, unexpected: true },
    });
    must(!reply.ok, "an unknown operation field was accepted");
    return "strict schema refused an unrecognised field";
  });

  await check(1, "incomplete-operation-rejected", async () => {
    const reply = await call("melra_plan", {
      goal: "Conformance: an operation missing a required field",
      operation: { kind: "file", action: "write", content: marker },
    });
    must(!reply.ok, "an operation with no path was accepted");
    return "schema refused an operation missing a required field";
  });

  await check(1, "plan-returns-an-effect-contract", async () => {
    const reply = await call("melra_plan", {
      goal: "Conformance: read the capabilities of this endpoint",
      operation: { kind: "system", action: "info" },
    });
    must(reply.ok, reply.text);
    const capability = field<string>(reply.value, "contract.capability");
    const effect = field<string>(reply.value, "contract.effect");
    must(effect === "read", `a system info read was classified ${effect}`);
    return `contract ${field<string>(reply.value, "contract.contractVersion")} for ${capability} (${effect})`;
  });

  await check(2, "mutation-is-held-for-approval", async () => {
    const reply = await call("melra_plan", {
      goal: "Conformance: write the probe file",
      operation: write,
    });
    must(reply.ok, reply.text);
    writeTaskId = field<string>(reply.value, "id");
    const outcome = field<string>(reply.value, "policyDecision.outcome");
    must(
      outcome === "confirm",
      `policy answered ${outcome}; L2 needs a mutation to be gated (policy.mutations: "confirm")`,
    );
    must(
      field<string>(reply.value, "status") === "awaiting_approval",
      "a gated mutation was not left awaiting approval",
    );
    approvalId = field<string>(reply.value, "approval.approvalId");
    phrase = field<string>(reply.value, "approval.phrase");
    must(
      field<string>(reply.value, "approval.taskId") === writeTaskId,
      "the approval challenge is not scoped to this task",
    );
    must(
      /^[a-f0-9]{64}$/.test(field<string>(reply.value, "approval.actionDigest")),
      "the approval challenge carries no action digest",
    );
    return "planning a mutation produced a task-scoped approval challenge";
  });

  await check(2, "no-approval-is-refused", async () => {
    must(writeTaskId !== undefined, "no planned mutation to execute");
    const reply = await call("melra_execute", { taskId: writeTaskId });
    must(!reply.ok, "a gated mutation executed with no approval at all");
    return `refused: ${reply.text}`;
  });

  await check(2, "wrong-phrase-is-refused", async () => {
    must(writeTaskId !== undefined, "no planned mutation to execute");
    must(phrase !== undefined && approvalId !== undefined, "no challenge issued");
    const reply = await call("melra_execute", {
      taskId: writeTaskId,
      approval: { approvalId, phrase: `${phrase} and also this` },
    });
    must(!reply.ok, "a gated mutation executed on a phrase that was not the one issued");
    return `refused: ${reply.text}`;
  });

  await check(2, "refused-effects-did-not-happen", async () => {
    const reply = await call("melra_plan", {
      goal: "Conformance: confirm the refused write left nothing behind",
      operation: { kind: "file", action: "read", path: probe },
    });
    must(reply.ok, reply.text);
    const executed = await call("melra_execute", {
      taskId: field<string>(reply.value, "id"),
    });
    const status = executed.ok
      ? field<string>(executed.value, "task.status")
      : "refused";
    must(
      status !== "verified_success",
      "the probe file exists, so a refused mutation ran anyway",
    );
    return "two refusals, and the file they would have created does not exist";
  });

  await check(2, "freeform-constraints-are-denied-as-a-result", async () => {
    const reply = await call("melra_plan", {
      goal: "Conformance: a limit expressed as prose",
      operation: { kind: "system", action: "info" },
      constraints: ["do not touch anything important"],
    });
    // Denial has to be a normal result. A harness that cannot tell "policy said
    // no" from "the call failed" will retry a denial as if it were a blip.
    must(reply.ok, `a policy denial came back as a transport error: ${reply.text}`);
    must(
      field<string>(reply.value, "status") === "policy_blocked",
      "prose constraints were not denied",
    );
    const blocked = field<string>(reply.value, "id");
    const executed = await call("melra_execute", { taskId: blocked });
    must(executed.ok, `executing a blocked task errored: ${executed.text}`);
    must(
      field<string>(executed.value, "task.status") === "policy_blocked",
      "a blocked task ran when executed anyway",
    );
    must(
      executed.value.receipt === undefined,
      "a blocked task produced an execution receipt",
    );
    return `denied with ${field<string>(reply.value, "policyDecision.reason")}, and still denied at execute`;
  });

  await check(3, "approved-mutation-verifies", async () => {
    must(writeTaskId !== undefined, "no planned mutation to execute");
    must(phrase !== undefined && approvalId !== undefined, "no challenge issued");
    const reply = await call("melra_execute", {
      taskId: writeTaskId,
      approval: { approvalId, phrase },
    });
    must(reply.ok, reply.text);
    probeWritten = true;
    const status = field<string>(reply.value, "task.status");
    must(status === "verified_success", `approved mutation ended ${status}`);
    const result = field<string>(reply.value, "certificate.result");
    must(result === "VERIFIED_SUCCESS", `certificate says ${result}`);
    must(
      /^[a-f0-9]{64}$/.test(field<string>(reply.value, "certificate.digest")),
      "the certificate carries no SHA-256 digest",
    );
    const evidence = field<Array<{ type: string; passed: boolean }>>(
      reply.value,
      "certificate.evidence",
    );
    must(evidence.length > 0, "verified success with no evidence at all");
    must(
      evidence.every((item) => item.passed),
      `verified success over failing evidence: ${JSON.stringify(evidence)}`,
    );
    return `${status} on ${evidence.length} passing evidence item(s)`;
  });

  await check(3, "the-effect-really-happened", async () => {
    const reply = await call("melra_plan", {
      goal: "Conformance: read back what the approved write claims to have done",
      operation: { kind: "file", action: "read", path: probe },
    });
    must(reply.ok, reply.text);
    const executed = await call("melra_execute", {
      taskId: field<string>(reply.value, "id"),
    });
    must(executed.ok, executed.text);
    must(
      field<string>(executed.value, "task.status") === "verified_success",
      "reading the file the kernel says it wrote did not verify",
    );
    must(
      field<string>(executed.value, "output.content") === marker,
      "the file exists but does not hold what was approved",
    );
    return "the approved bytes are on disk, read back through the kernel";
  });

  await check(3, "the-receipt-outlives-the-call", async () => {
    must(writeTaskId !== undefined, "no executed mutation to read back");
    const status = await call("melra_task_status", { taskId: writeTaskId });
    must(status.ok, status.text);
    must(
      field<string>(status.value, "status") === "verified_success",
      "the durable record disagrees with what execute returned",
    );
    const receiptIds = field<string[]>(status.value, "receiptIds");
    must(receiptIds.length === 1, `${receiptIds.length} receipts for one effect`);
    const reply = await call("melra_receipt", { taskId: writeTaskId });
    must(reply.ok, reply.text);
    const receipts = field<Array<{ receiptId: string; capability: string }>>(
      reply.value,
      "receipts",
    );
    must(receipts.length === 1, `${receipts.length} receipts returned`);
    must(
      receipts[0]?.receiptId === receiptIds[0],
      "the receipt read back is not the one the task records",
    );
    must(
      field<string>(reply.value, "certificate.result") === "VERIFIED_SUCCESS",
      "no verified certificate survived the call",
    );
    return `receipt ${receipts[0]?.receiptId} for ${receipts[0]?.capability}, still readable after other tasks ran`;
  });

  // Last, because it is also the cleanup: a destructive effect gated by its own
  // approval, verified by the file being gone.
  await check(3, "destructive-effects-are-gated-and-verified", async () => {
    must(probeWritten, "nothing was written, so nothing is left to delete");
    const reply = await call("melra_plan", {
      goal: "Conformance: remove the probe file",
      operation: { kind: "file", action: "delete", path: probe },
    });
    must(reply.ok, reply.text);
    const effect = field<string>(reply.value, "policyDecision.effect");
    must(effect === "destructive", `deleting a file was classified ${effect}`);
    must(
      field<string>(reply.value, "policyDecision.risk") === "high",
      "a destructive effect was not classified high risk",
    );
    must(
      field<string>(reply.value, "status") === "awaiting_approval",
      "a destructive effect was not gated",
    );
    const executed = await call("melra_execute", {
      taskId: field<string>(reply.value, "id"),
      approval: {
        approvalId: field<string>(reply.value, "approval.approvalId"),
        phrase: field<string>(reply.value, "approval.phrase"),
      },
    });
    must(executed.ok, executed.text);
    must(
      field<string>(executed.value, "task.status") === "verified_success",
      "the delete did not verify",
    );
    probeWritten = false;
    return "a destructive effect needed its own approval and verified as absent";
  });

  await client.close();

  const failedLevels = new Set(
    checks.filter((entry) => !entry.passed).map((entry) => entry.level),
  );
  let level = 0;
  for (const candidate of [1, 2, 3]) {
    if (failedLevels.has(candidate)) break;
    level = candidate;
  }

  return {
    report: {
      suite: CONFORMANCE_SUITE,
      runner: PRODUCT_VERSION,
      target,
      level,
      claimed: claim,
      claim: LEVEL_NAMES[level],
      passed: checks.filter((entry) => entry.passed).length,
      of: checks.length,
      checks,
      notProven: NOT_PROVEN,
      // Only ever set when a level-3 check failed between writing the probe and
      // deleting it. Saying where it is beats silently leaving it.
      ...(probeWritten ? { uncleanedProbeFile: probe } : {}),
    },
    failed: level < claim,
  };
}

async function connect(
  client: Client,
  options: ConformanceOptions,
): Promise<Record<string, unknown>> {
  if (options.url !== undefined) {
    // Forgiving about the one thing people get wrong: `serve --http` prints both
    // the console URL and the MCP URL, and only one of them is an endpoint.
    const url = new URL(
      options.url.endsWith("/mcp") ? options.url : `${options.url.replace(/\/$/, "")}/mcp`,
    );
    await client.connect(
      // ponytail: the SDK declares `sessionId?: string` on this transport, which
      // `exactOptionalPropertyTypes` reads as incompatible with the `Transport`
      // it implements. Cast here rather than loosen the flag for the package.
      new StreamableHTTPClientTransport(url, {
        ...(options.token === undefined
          ? {}
          : {
              requestInit: {
                headers: { authorization: `Bearer ${options.token}` },
              },
            }),
      }) as unknown as Transport,
    );
    return { transport: "http", url: url.href, authenticated: options.token !== undefined };
  }
  const command = options.command ?? process.execPath;
  const args =
    options.args ??
    (options.command === undefined
      ? // Reproduce how this process was started, loaders included, so the same
        // command works from `dist/bin.js` and from `tsx src/index.ts`.
        [...process.execArgv, process.argv[1] ?? "", "serve"]
      : ["serve"]);
  await client.connect(
    new StdioClientTransport({
      command,
      args,
      // The SDK forwards a small allowlist by default, which would drop every
      // MELRA_* variable and quietly check a server configured differently from
      // the one the operator runs. The point is to check *their* endpoint.
      env: options.env ?? inheritedEnvironment(),
      stderr: "pipe",
    }),
  );
  return { transport: "stdio", command, args };
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
