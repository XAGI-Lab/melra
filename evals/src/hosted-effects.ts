// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Effects a host runs itself. An embedding host (a messaging assistant, a
// mail client) builds a TaskController over its own executor and its own
// registered verifiers, instead of MELRA's built-in adapters. Each case here
// drives one such host against a fake provider, through one fault, and
// checks the kernel's verdict against what the provider actually did. All
// data is synthetic.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { outcomeUnknown, TaskRequestSchema, type Operation } from "@melra/protocol";
import { createDefaultPolicy } from "@melra/policy-core";
import { PayloadCipher, TaskController } from "@melra/runtime-core";
import { SqliteStore } from "@melra/storage-sqlite";
import { Verifier } from "@melra/verifier-core";
import {
  assertPublishableWorktree,
  digestDurableCoreManifest as digestManifest,
  implementationCommit,
} from "./durable-core.js";

export const HOSTED_EFFECTS_MANIFEST_DIGEST =
  "7920aa91236db592de226c4e70cb2064c938fc540749743219ceb57de328750e";

export interface HostedEffectsCase {
  id: string;
  fault: string;
  /** Every task status the host reads, in order; `refused` for a call that threw. */
  expectedStatuses: string[];
  /** Calls into the host's executor, across every attempt and process. */
  expectedMaximumDispatches: number;
  /** Whether the provider holds the message, accepted and not bounced, at the end. */
  expectedDelivered: boolean;
}

export interface HostedEffectsManifest {
  schemaVersion: "1.0.0";
  suiteId: string;
  cases: HostedEffectsCase[];
}

export interface HostedEffectsRun {
  schemaVersion: "1.0.0";
  caseId: string;
  implementationCommit: string;
  manifestDigest: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  startedAt: string;
  endedAt: string;
  statuses: string[];
  dispatches: number;
  delivered: boolean;
  recovered: boolean;
  duplicateExecution: boolean;
  falseSuccess: boolean;
  error?: string;
}

export interface HostedEffectsSummary {
  schemaVersion: "1.0.0";
  manifestDigest: string;
  totalRuns: number;
  recoveryRate: number;
  duplicateExecutionRate: number;
  falseSuccessRate: number;
  recoveryRateByCase: Record<string, number>;
}

const manifestUrl = new URL("../manifests/hosted-effects-v1.json", import.meta.url);

export async function loadHostedEffectsManifest(): Promise<HostedEffectsManifest> {
  const bytes = await readFile(fileURLToPath(manifestUrl));
  if (digestManifest(bytes) !== HOSTED_EFFECTS_MANIFEST_DIGEST) {
    throw new Error("hosted_effects_manifest_digest_mismatch");
  }
  return JSON.parse(bytes.toString("utf8")) as HostedEffectsManifest;
}

export function summarizeHostedEffectsRuns(runs: HostedEffectsRun[]): HostedEffectsSummary {
  const rate = (items: HostedEffectsRun[], hit: (run: HostedEffectsRun) => boolean) =>
    items.filter(hit).length / (items.length || 1);
  const ids = [...new Set(runs.map((run) => run.caseId))];
  return {
    schemaVersion: "1.0.0",
    manifestDigest: HOSTED_EFFECTS_MANIFEST_DIGEST,
    totalRuns: runs.length,
    recoveryRate: rate(runs, (run) => run.recovered),
    duplicateExecutionRate: rate(runs, (run) => run.duplicateExecution),
    falseSuccessRate: rate(runs, (run) => run.falseSuccess),
    recoveryRateByCase: Object.fromEntries(
      ids.map((id) => [id, rate(runs.filter((run) => run.caseId === id), (run) => run.recovered)]),
    ),
  };
}

// ── The fake provider and the host ──────────────────────────────────────

/** What the host's dispatch does when the kernel calls it. */
type Dispatch = "accept" | "refuse" | "timeout_delivered" | "timeout_lost" | "crash" | "bounce";
/** What the provider's record says when reconciliation asks. */
type Lookup = "answer" | "unreachable";

interface Message {
  messageId: string;
  ack: "server" | "error";
}

/** A messaging provider's record of what it was sent, by idempotency key. */
class FakeProvider {
  readonly messages = new Map<string, Message>();
  lookup: Lookup = "answer";

  record(key: string, ack: Message["ack"]): Message {
    const message = { messageId: `msg-${key.slice(0, 12)}`, ack };
    this.messages.set(key, message);
    return message;
  }

  delivered(key: string): boolean {
    return this.messages.get(key)?.ack === "server";
  }
}

/** Counts every call into the executor, across processes: the at-most-once ledger. */
interface Ledger {
  dispatches: number;
  /** Called on each dispatch: the crash case waits on it. */
  dispatched?: () => void;
}

const KEY = createHash("sha256").update("hosted-effects|synthetic-send-1").digest("hex");
const IDLE = new Promise<never>(() => {});

/** The host's executor: sends through the fake provider, saying which failures sent nothing. */
function hostExecutor(provider: FakeProvider, ledger: Ledger, behaviour: () => Dispatch) {
  return {
    async execute(operation: Operation): Promise<Record<string, unknown>> {
      if (operation.kind !== "http" || operation.idempotencyKey === undefined) {
        throw new Error("host_send_unregistered");
      }
      const key = operation.idempotencyKey;
      ledger.dispatches += 1;
      ledger.dispatched?.();
      switch (behaviour()) {
        case "accept": {
          const message = provider.record(key, "server");
          return { success: true, ...message };
        }
        case "bounce": {
          const message = provider.record(key, "error");
          return { success: true, ...message };
        }
        case "refuse":
          // Refused before sending, so a plain error: the kernel records `failed`.
          throw new Error("not_sent:provider_unavailable");
        case "timeout_delivered":
          provider.record(key, "server");
          throw outcomeUnknown("provider_timeout");
        case "timeout_lost":
          throw outcomeUnknown("provider_timeout");
        case "crash":
          provider.record(key, "server");
          // The process dies here: the kernel never hears back.
          return await IDLE;
      }
    },
  };
}

/** The host's verifiers: the provider took the message, and the provider's record of it. */
function hostVerifiers(provider: FakeProvider) {
  return [
    {
      type: "message_accepted",
      async check(_params: never, result: Record<string, unknown>) {
        const passed =
          typeof result.messageId === "string" && result.messageId !== "" && result.ack !== "error";
        return { passed, summary: passed ? "provider accepted the message" : "no accepted message id" };
      },
    },
    {
      type: "message_landed",
      async check(_params: never, facts: Record<string, unknown>) {
        // A throw is no answer: the kernel keeps the task parked.
        if (provider.lookup === "unreachable") throw new Error("provider_lookup_unreachable");
        const passed = provider.delivered(String(facts.idempotencyKey ?? ""));
        return { passed, summary: passed ? "provider has the message" : "provider has no such message" };
      },
    },
  ];
}

const sendRequest = () =>
  TaskRequestSchema.parse({
    goal: "Send a synthetic message to a synthetic recipient",
    operation: {
      kind: "http",
      action: "request",
      method: "POST",
      url: "https://messages.example.invalid/send",
      idempotencyKey: KEY,
    },
    requiredEvidence: [{ type: "custom", verifier: "message_accepted" }],
    reconciliation: [{ type: "custom", verifier: "message_landed" }],
    budget: { maxSteps: 1, maxDurationMs: 60_000, maxRetries: 0 },
  });

interface Host {
  controller: TaskController;
  store: SqliteStore;
}

/** One host process over the store at `root`. */
async function openHost(
  root: string,
  provider: FakeProvider,
  ledger: Ledger,
  behaviour: () => Dispatch,
): Promise<Host> {
  const store = new SqliteStore(join(root, ".melra", "melra.sqlite"));
  const controller = new TaskController(
    store,
    createDefaultPolicy(root, false),
    hostExecutor(provider, ledger, behaviour),
    await Verifier.create(root, { verifiers: hostVerifiers(provider) }),
    new PayloadCipher(Buffer.alloc(32, 11)),
  );
  return { controller, store };
}

/** Plans attempt `attempt` of the send and executes it, echoing the developer-mode phrase. */
async function send(host: Host, attempt: number): Promise<{ taskId: string; status: string }> {
  const task = await host.controller.plan(sendRequest(), { idempotencyKey: KEY, attempt });
  const challenge = task.approval;
  const result = await host.controller.execute(
    task.id,
    challenge?.phrase === undefined ? undefined : { approvalId: challenge.approvalId, phrase: challenge.phrase },
  );
  return { taskId: task.id, status: result.task.status };
}

/** `refused` when the call throws, whatever the kernel's reason; `accepted` when it does not. */
async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "accepted";
  } catch {
    return "refused";
  }
}

type Driver = (root: string, provider: FakeProvider, ledger: Ledger) => Promise<string[]>;

/** One process, one behaviour per dispatch in order (the last repeats). */
const scripted =
  (behaviours: Dispatch[], drive: (host: Host) => Promise<string[]>): Driver =>
  async (root, provider, ledger) => {
    const host = await openHost(root, provider, ledger, () => behaviours[Math.min(ledger.dispatches, behaviours.length) - 1]!);
    try {
      return await drive(host);
    } finally {
      host.store.close();
    }
  };

const DRIVERS: Record<string, Driver> = {
  accepted_with_message_id: scripted(["accept"], async (host) => [(await send(host, 1)).status]),

  refused_before_sending: scripted(["refuse", "accept"], async (host) => [
    (await send(host, 1)).status,
    (await send(host, 2)).status,
  ]),

  unknown_then_reconciled_found: scripted(["timeout_delivered"], async (host) => {
    const parked = await send(host, 1);
    return [parked.status, (await host.controller.reconcile(parked.taskId)).task.status];
  }),

  unknown_then_reconciled_absent: scripted(["timeout_lost"], async (host) => {
    const parked = await send(host, 1);
    return [parked.status, (await host.controller.reconcile(parked.taskId)).task.status];
  }),

  unknown_then_reconcile_unreachable: async (root, provider, ledger) => {
    provider.lookup = "unreachable";
    return await scripted(["timeout_delivered"], async (host) => {
      const parked = await send(host, 1);
      return [
        parked.status,
        (await host.controller.reconcile(parked.taskId)).task.status,
        // Retried the obvious way, it reconciles again and never re-sends.
        (await host.controller.execute(parked.taskId)).task.status,
      ];
    })(root, provider, ledger);
  },

  crash_after_dispatch: async (root, provider, ledger) => {
    const first = await openHost(root, provider, ledger, () => "crash");
    const dispatched = new Promise<void>((resolve) => (ledger.dispatched = resolve));
    const task = await first.controller.plan(sendRequest(), { idempotencyKey: KEY, attempt: 1 });
    void first.controller.execute(task.id, { approvalId: task.approval!.approvalId, phrase: task.approval!.phrase! });
    await dispatched;
    // The process dies: its store closes, so its owner lock goes with it.
    first.store.close();
    // A new process, whose executor would send again if anything asked it to.
    const second = await openHost(root, provider, ledger, () => "accept");
    try {
      await second.controller.recoverInterrupted();
      const recovered = second.controller.status(task.id).status;
      return [recovered, (await send(second, 2)).status];
    } finally {
      second.store.close();
    }
  },

  duplicate_after_success: scripted(["accept"], async (host) => [
    (await send(host, 1)).status,
    (await send(host, 2)).status,
  ]),

  accepted_then_bounced: scripted(["bounce"], async (host) => [(await send(host, 1)).status]),

  async_plan_awaited: scripted(["accept"], async (host) => {
    const pending = host.controller.plan(sendRequest(), { idempotencyKey: KEY, attempt: 1 });
    // A host that forgot the `await` holds a promise, not a task: executing it
    // must refuse, never send outside the kernel's record.
    const forgotten = await refusal(() =>
      host.controller.execute((pending as unknown as { id: string }).id),
    );
    if (typeof (pending as { then?: unknown }).then !== "function") throw new Error("plan_not_async");
    const task = await pending;
    const result = await host.controller.execute(task.id, {
      approvalId: task.approval!.approvalId,
      phrase: task.approval!.phrase!,
    });
    return [forgotten, result.task.status];
  }),
};

export async function runHostedEffectsCase(
  testCase: HostedEffectsCase,
  commit: string,
): Promise<HostedEffectsRun> {
  const startedAt = new Date().toISOString();
  const root = await mkdtemp(join(tmpdir(), `melra-hosted-${testCase.id}-`));
  const provider = new FakeProvider();
  const ledger: Ledger = { dispatches: 0 };
  let statuses: string[] = [];
  let error: string | undefined;
  try {
    const drive = DRIVERS[testCase.id];
    if (drive === undefined) throw new Error("evaluation_case_unknown");
    statuses = await drive(root, provider, ledger);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const delivered = provider.delivered(KEY);
  return {
    schemaVersion: "1.0.0",
    caseId: testCase.id,
    implementationCommit: commit,
    manifestDigest: HOSTED_EFFECTS_MANIFEST_DIGEST,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    startedAt,
    endedAt: new Date().toISOString(),
    statuses,
    dispatches: ledger.dispatches,
    delivered,
    recovered:
      error === undefined &&
      JSON.stringify(statuses) === JSON.stringify(testCase.expectedStatuses) &&
      ledger.dispatches <= testCase.expectedMaximumDispatches &&
      delivered === testCase.expectedDelivered,
    duplicateExecution: ledger.dispatches > testCase.expectedMaximumDispatches,
    // The kernel said verified while the provider holds no accepted message.
    falseSuccess: statuses.includes("verified_success") && !delivered,
    ...(error === undefined ? {} : { error }),
  };
}

export async function runHostedEffectsEvaluation(): Promise<{
  runs: HostedEffectsRun[];
  summary: HostedEffectsSummary;
}> {
  const manifest = await loadHostedEffectsManifest();
  const commit = await implementationCommit();
  const runs: HostedEffectsRun[] = [];
  for (const testCase of manifest.cases) runs.push(await runHostedEffectsCase(testCase, commit));
  return { runs, summary: summarizeHostedEffectsRuns(runs) };
}

/** The release gate: every case recovered, nothing sent twice, nothing called verified that was not. */
export function passes(summary: HostedEffectsSummary): boolean {
  return (
    summary.totalRuns > 0 &&
    summary.recoveryRate === 1 &&
    summary.duplicateExecutionRate === 0 &&
    summary.falseSuccessRate === 0
  );
}

const resultDirectory = fileURLToPath(new URL("../results/hosted-effects", import.meta.url));

async function main(): Promise<void> {
  if (process.argv[2] !== "run") throw new Error("usage: hosted-effects run [--publishable]");
  if (process.argv.includes("--publishable")) await assertPublishableWorktree();
  const { runs, summary } = await runHostedEffectsEvaluation();
  const raw = join(resultDirectory, "latest.jsonl");
  await mkdir(dirname(raw), { recursive: true });
  await writeFile(raw, `${runs.map((run) => JSON.stringify(run)).join("\n")}\n`);
  await writeFile(join(resultDirectory, "latest-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = passes(summary) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
