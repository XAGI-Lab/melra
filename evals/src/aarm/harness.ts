// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AARM v1.0 self-check runner. Every case goes through the real
 * `createMelraRuntime` in a fresh GovBench sandbox. The only network is
 * GovBench's loopback fixture, which is also the canary for whether a refused
 * request reached anything, plus the loopback HTTP server R6-T1 starts here.
 * Nothing calls a model, and nothing is written unless `--output` names a file.
 *
 * Tracks: A runs in process (every case that runs today). B tampers with a
 * closed home as a full writer of its database and asks the read-only record
 * verifier. C exports receipts and checks their signatures with `node:crypto`
 * alone. B and C cases need interfaces MELRA does not have yet, so today they
 * are `not_implemented`; `aarm.test.ts` checks their own machinery.
 */

import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  PolicyFileSchema,
  PolicyOutcomeSchema,
  PRODUCT_VERSION,
  TaskRequestSchema,
  WorkflowDefinitionSchema,
} from "@melra/protocol";
import * as server from "@melra/server";
import { createMelraRuntime, OAuthProvider, serveHttp, type MelraHttpServer, type MelraRuntime } from "@melra/server";
import {
  Fixture,
  OUTSIDE_CANARY,
  canonicalJson,
  filler,
  git,
  hasPwned,
  parseRequest,
  sandbox,
  snapshot,
} from "../govbench/harness.js";
import {
  AARM_CORPUS_VERSION,
  cases as corpus,
  type AarmCase,
  type AarmTestId,
  type Assertion,
  type Need,
  type ReceiptDecision,
} from "./corpus.js";

type Status = "pass" | "partial" | "fail";

export interface AssertionResult {
  name: string;
  kind: Assertion["kind"];
  passed: boolean;
  observed: string;
  /** For a receipt-profile assertion: the decision, and the fields its receipts lacked. */
  profile?: ReceiptDecision;
  missing?: string[];
}

export interface CaseResult {
  id: string;
  test: AarmTestId;
  status: Status | "not_implemented" | "skipped";
  /** Why it was not run: the interfaces it needs, or the environment. */
  reason?: string;
  assertions: AssertionResult[];
  durationMs: number;
}

interface Outcome {
  status: string;
  reason: string;
}

/** What a plan or execute hands back, in process or over MCP. */
interface TaskView {
  id: string;
  status: string;
  policyDecision: { reason: string };
  approval?: { approvalId: string; phrase?: string | undefined };
  error?: string;
}

const MANIFEST_URL = new URL("../../manifests/aarm-v1.0-minimum-tests-v1.json", import.meta.url);
/** The pre-registered manifest, pinned: changing it means changing this on purpose. */
export const AARM_MANIFEST_SHA256 = "ae52f3144e868acb9b3fd147d7a2719a1204df756065e89e422728d551db810f";
const OPERATOR = "cli:aarm-operator";

class EnvironmentSkip extends Error {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------- interfaces

type RecordVerifier = (options: { dataDirectory: string }) => Promise<{ ok: boolean; problems?: string[] }>;

/** The read-only record verifier, as the roadmap's `melra verify` item is to export it. */
function recordVerifier(): RecordVerifier | undefined {
  const candidate = (server as unknown as Record<string, unknown>).verifyRecords;
  return typeof candidate === "function" ? (candidate as RecordVerifier) : undefined;
}

/** The receipt-signing public key (PEM), as a runtime that signs receipts is to expose it. */
function receiptPublicKey(runtime: MelraRuntime): string | undefined {
  const key = (runtime as unknown as { receiptPublicKey?: unknown }).receiptPublicKey;
  return typeof key === "string" ? key : undefined;
}

async function open(
  box: { workspace: string; data: string },
  policyPath: string | undefined,
): Promise<MelraRuntime> {
  return await createMelraRuntime({
    workspaceRoot: box.workspace,
    dataDirectory: box.data,
    ...(policyPath === undefined ? {} : { policyPath }),
    // An empty environment, so a MELRA_UNHINGED or MELRA_MODE in the shell
    // running the self-check cannot change what is measured.
    environment: {},
    // Nor whether this host has an OS sandbox, which enforced mode needs to
    // start: commands run as they did before there was one, and the sandbox
    // has tests of its own.
    detectSandbox: async () => ({ sandbox: { backend: "test", confine: async ({ file, args }) => ({ file, args }) } }),
  });
}

/**
 * Which interfaces this MELRA has. Each probe looks where the item that adds
 * the interface is to put it; a probe looking in the wrong place reports it
 * missing, which keeps its cases `not_implemented` and never passes one.
 */
export async function interfaces(): Promise<Record<Need, boolean>> {
  const outcomes: readonly string[] = PolicyOutcomeSchema.options;
  const policyKeys = Object.keys(PolicyFileSchema.shape);
  const box = await sandbox();
  let signed = false;
  try {
    const runtime = await open(box, undefined);
    try {
      const task = await runtime.controller.plan(
        TaskRequestSchema.parse({ goal: "AARM interface probe", operation: { kind: "system", action: "info" } }),
      );
      await runtime.controller.execute(task.id);
      const [receipt] = runtime.store.getReceiptsForTask(task.id);
      signed = receipt !== undefined && "signature" in receipt && receiptPublicKey(runtime) !== undefined;
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(box.base, { recursive: true, force: true });
  }
  return {
    defer: outcomes.includes("defer"),
    modify: outcomes.includes("modify"),
    verify: recordVerifier() !== undefined,
    signature: signed,
    exporter: policyKeys.some((key) => /export/i.test(key)),
    session: Object.keys(TaskRequestSchema.shape).includes("session"),
    labels: policyKeys.some((key) => /label|sensitiv/i.test(key)),
  };
}

// ---------------------------------------------------------- tracks B and C

/**
 * Track B: SQL run as a full writer of the database. The append-only triggers
 * go first: they stop a buggy writer, not one holding the file, which is the
 * writer the tamper tests describe.
 */
export function tamper(dataDirectory: string, sql: string): void {
  const database = new DatabaseSync(join(dataDirectory, "melra.sqlite"));
  try {
    const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all();
    for (const { name } of triggers as Array<{ name: string }>) database.exec(`DROP TRIGGER "${name}"`);
    database.exec(sql);
  } finally {
    database.close();
  }
}

/**
 * Track C: a receipt's signature checked with the public key alone, importing
 * nothing from MELRA's signing code. The signed bytes are the canonical JSON
 * of the receipt without `signature`, whose `value` is base64: Ed25519, or
 * P-256 over SHA-256 with a DER signature.
 */
export function independentVerify(receipt: Record<string, unknown>, publicKeyPem: string): boolean {
  const { signature, ...signed } = receipt;
  const value = (signature as { value?: unknown } | undefined)?.value;
  if (typeof value !== "string") return false;
  try {
    const key = createPublicKey(publicKeyPem);
    const digest = key.asymmetricKeyType === "ed25519" ? null : "sha256";
    return verify(digest, Buffer.from(canonicalJson(signed)), key, Buffer.from(value, "base64"));
  } catch {
    return false;
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let current = target;
  for (const key of keys.slice(0, -1)) current = current[key] as Record<string, unknown>;
  current[keys.at(-1)!] = value;
}

function getPath(target: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (current, key) => (current !== null && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined),
    target,
  );
}

// ------------------------------------------------------- loopback clients

/** The OAuth flow an MCP client runs, with the operator approving at the consent step. */
async function oauthClient(http: MelraHttpServer, name: string): Promise<{ id: string; token: string }> {
  const origin = new URL(http.mcpUrl).origin;
  const redirect = "http://127.0.0.1:9/callback";
  const registered = (await (
    await fetch(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: name, redirect_uris: [redirect] }),
    })
  ).json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const consent = await fetch(`${origin}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: redirect,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      decision: "approve",
      operator_token: http.token,
    }),
  });
  const code = new URL(consent.headers.get("location") ?? redirect).searchParams.get("code") ?? "";
  const issued = (await (
    await fetch(`${origin}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: registered.client_id,
        redirect_uri: redirect,
        code_verifier: verifier,
      }),
    })
  ).json()) as { access_token?: string; error?: string };
  if (issued.access_token === undefined) throw new Error(`oauth_failed:${issued.error ?? "no_token"}`);
  return { id: registered.client_id, token: issued.access_token };
}

type ToolCall = (name: string, args: unknown) => Promise<Record<string, unknown>>;

/** An MCP session over Streamable HTTP, with the client's bearer token. */
async function mcpSession(url: string, token: string): Promise<ToolCall> {
  let session: string | undefined;
  let id = 0;
  const send = async (method: string, params: unknown, notification = false): Promise<unknown> => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session === undefined ? {} : { "mcp-session-id": session }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(notification ? {} : { id: (id += 1) }) }),
    });
    session ??= response.headers.get("mcp-session-id") ?? undefined;
    const text = await response.text();
    if (!response.ok) throw new Error(`http_${response.status}`);
    if (notification) return undefined;
    // A streamed reply carries its one message on a `data:` line.
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    const reply = JSON.parse(data === undefined ? text : data.slice(5)) as { result?: unknown; error?: { message: string } };
    if (reply.error !== undefined) throw new Error(reply.error.message);
    return reply.result;
  };
  await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "melra-aarm-selfcheck", version: PRODUCT_VERSION },
  });
  await send("notifications/initialized", {}, true);
  return async (name, args) => {
    const result = (await send("tools/call", { name, arguments: args })) as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };
    const text = result.content?.[0]?.text ?? "";
    if (result.isError === true) throw new Error(text);
    return JSON.parse(text) as Record<string, unknown>;
  };
}

// ---------------------------------------------------------------- per case

function caseStatus(results: AssertionResult[]): Status {
  if (results.some((item) => item.kind === "effect" && !item.passed)) return "fail";
  if (results.every((item) => item.passed)) return "pass";
  return results.some((item) => item.passed) ? "partial" : "fail";
}

async function runCase(
  testCase: AarmCase,
  fixture: Fixture,
  available: Record<Need, boolean>,
): Promise<CaseResult> {
  const started = performance.now();
  const result = (
    status: CaseResult["status"],
    assertions: AssertionResult[],
    reason?: string,
  ): CaseResult => ({
    id: testCase.id,
    test: testCase.test,
    status,
    ...(reason === undefined ? {} : { reason }),
    assertions,
    durationMs: Math.round(performance.now() - started),
  });
  const missing = (testCase.needs ?? []).filter((need) => !available[need]);
  if (missing.length > 0) return result("not_implemented", [], `needs ${missing.join(", ")}`);
  // A placeholder stays unrun whatever the probes say: with no steps, its
  // effect assertions would hold only because nothing ran.
  if (testCase.steps.length === 0) return result("not_implemented", [], "no steps written");

  const box = await sandbox();
  // The artifact may be published, so it names the sandbox, not this machine's temp path.
  const scrub = (text: string): string => text.replaceAll(box.base, "{{sandbox}}");
  const fill = filler(fixture, box);
  fixture.hits = [];
  let policyPath: string | undefined;
  let runtime: MelraRuntime | undefined;
  let openError = "";
  let http: MelraHttpServer | undefined;
  const runtimes: MelraRuntime[] = [];
  const ids = new Map<string, string>();
  const challenges = new Map<string, NonNullable<TaskView["approval"]>>();
  const outcomes = new Map<string, Outcome>();
  /** What each execute handed back, checked for content from outside the workspace. */
  const returned: unknown[] = [];
  const clients = new Map<string, { id: string; call: ToolCall }>();
  const exports = new Map<string, string>();
  const workflows = new Map<string, string>();
  const refused = (reason: string): Outcome => ({ status: "refused", reason });

  const openRuntime = async (): Promise<void> => {
    try {
      runtime = await open(box, policyPath);
      runtimes.push(runtime);
      outcomes.set("open", { status: "opened", reason: "" });
    } catch (error) {
      runtime = undefined;
      openError = message(error);
      outcomes.set("open", refused(openError));
    }
  };
  const closeServer = async (): Promise<void> => {
    await http?.close().catch(() => {});
    http = undefined;
  };
  const planned = (as: string, task: TaskView): void => {
    ids.set(as, task.id);
    if (task.approval !== undefined) challenges.set(as, task.approval);
    outcomes.set(as, { status: task.status, reason: task.policyDecision.reason });
  };
  const settled = (task: TaskView): Outcome => ({
    status: task.status,
    reason: task.status === "policy_blocked" ? task.policyDecision.reason : task.error ?? "",
  });

  try {
    if (process.platform === "win32" && testCase.steps.some((step) => step.do === "break" && step.what !== "policy_corrupt")) {
      throw new EnvironmentSkip("no POSIX file modes or symlinks to break");
    }
    for (const item of testCase.fixtures ?? []) {
      const path = join(box.workspace, item.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, item.content);
    }
    for (const item of testCase.secrets ?? []) {
      await writeFile(join(box.outside, item.path), item.content, { mode: 0o600 });
    }
    for (const link of testCase.symlinks ?? []) {
      try {
        await symlink(fill(link.target), join(box.workspace, link.path));
      } catch (error) {
        throw new EnvironmentSkip(`symlink unavailable (${message(error)})`);
      }
    }
    if (testCase.policy !== undefined || testCase.mode === "enforced") {
      policyPath = join(box.base, "policy.json");
      await writeFile(
        policyPath,
        JSON.stringify({ ...fill(testCase.policy ?? {}), ...(testCase.mode === "enforced" ? { mode: "enforced" } : {}) }),
      );
    }
    const outsideBefore = await snapshot(box.outside);
    await openRuntime();

    for (const step of testCase.steps) {
      switch (step.do) {
        case "open":
          await openRuntime();
          break;
        case "close":
          await closeServer();
          await runtime?.close();
          break;
        case "break": {
          const key = join(box.data, "payload.key");
          if (step.what === "policy_corrupt") {
            policyPath ??= join(box.base, "policy.json");
            await writeFile(policyPath, "{");
          } else if (step.what === "key_0644") {
            await chmod(key, 0o644);
          } else if (step.what === "key_symlink") {
            await rename(key, join(box.base, "payload.key.real"));
            await symlink(join(box.base, "payload.key.real"), key).catch((error: unknown) => {
              throw new EnvironmentSkip(`symlink unavailable (${message(error)})`);
            });
          } else {
            // Root writes through any mode, so nothing would be measured.
            if (process.getuid?.() === 0) throw new EnvironmentSkip("running as root");
            await chmod(box.data, 0o500);
          }
          break;
        }
        case "plan": {
          if (step.via !== undefined) {
            try {
              planned(step.as, (await clients.get(step.via)!.call("melra_plan", fill(step.request))) as unknown as TaskView);
            } catch (error) {
              outcomes.set(step.as, refused(message(error)));
            }
            break;
          }
          if (runtime === undefined) {
            outcomes.set(step.as, refused(openError));
            break;
          }
          const parsed = parseRequest(fill(step.request));
          if (!parsed.ok) {
            outcomes.set(step.as, refused(parsed.reason));
            break;
          }
          try {
            planned(step.as, await runtime.controller.plan(parsed.value));
          } catch (error) {
            outcomes.set(step.as, refused(message(error)));
          }
          break;
        }
        case "approve_operator": {
          const id = ids.get(step.task);
          const as = `${step.task}:approve`;
          if (runtime === undefined || id === undefined) {
            outcomes.set(as, refused(id === undefined ? "not_planned" : openError));
            break;
          }
          try {
            await runtime.controller.decide(id, runtime.controller.approvalView(id).renderDigest, OPERATOR);
            outcomes.set(as, { status: "approved", reason: "" });
          } catch (error) {
            outcomes.set(as, refused(message(error)));
          }
          break;
        }
        case "execute": {
          const as = step.as ?? step.task;
          const id = ids.get(step.task);
          // A plan that was refused keeps its refusal as the task's outcome.
          if (id === undefined) {
            if (as !== step.task || !outcomes.has(as)) outcomes.set(as, refused("not_planned"));
            break;
          }
          const challenge = step.approve === true ? challenges.get(step.task) : undefined;
          const approval =
            challenge?.phrase === undefined ? undefined : { approvalId: challenge.approvalId, phrase: challenge.phrase };
          try {
            if (step.via !== undefined) {
              const executed = await clients.get(step.via)!.call("melra_execute", {
                taskId: id,
                ...(approval === undefined ? {} : { approval }),
              });
              returned.push(executed.output);
              outcomes.set(as, settled(executed.task as TaskView));
            } else if (runtime === undefined) {
              outcomes.set(as, refused(openError));
            } else {
              const executed = await runtime.controller.execute(id, approval);
              returned.push(executed.output);
              outcomes.set(as, settled(executed.task));
            }
          } catch (error) {
            outcomes.set(as, refused(message(error)));
          }
          break;
        }
        case "status": {
          const id = ids.get(step.task);
          if (runtime !== undefined && id !== undefined) outcomes.set(step.task, settled(runtime.controller.status(id)));
          break;
        }
        case "wait":
          await new Promise((resolvePromise) => setTimeout(resolvePromise, step.ms));
          break;
        case "workflow":
        case "advance": {
          if (runtime === undefined) break;
          const as = step.do === "workflow" ? step.as : step.workflow;
          if (step.do === "workflow") {
            workflows.set(as, runtime.workflows.plan(WorkflowDefinitionSchema.parse(fill(step.definition))).id);
          }
          const { run } = await runtime.workflows.advance(workflows.get(as)!);
          // The node's first task: the one an expired challenge belonged to.
          for (const [node, state] of Object.entries(run.nodes)) {
            const first = state.taskIds[0];
            if (first !== undefined && !ids.has(`${as}/${node}`)) ids.set(`${as}/${node}`, first);
          }
          outcomes.set(as, { status: run.status, reason: run.error ?? "" });
          break;
        }
        case "serve":
          if (runtime !== undefined) http = await serveHttp({ runtime, port: 0, environment: {} });
          break;
        case "client": {
          if (http === undefined) throw new Error("client_without_server");
          const issued = await oauthClient(http, `aarm-${step.as}`);
          clients.set(step.as, { id: issued.id, call: await mcpSession(http.mcpUrl, issued.token) });
          break;
        }
        case "revoke":
          new OAuthProvider(box.data).revoke(clients.get(step.client)?.id);
          break;
        case "verify": {
          const verdict = await recordVerifier()!({ dataDirectory: box.data });
          outcomes.set(step.as, { status: verdict.ok ? "ok" : "rejected", reason: (verdict.problems ?? []).join("; ") });
          break;
        }
        case "tamper":
          tamper(box.data, step.sql);
          break;
        case "export": {
          if (runtime === undefined) break;
          const directory = await mkdtemp(join(box.base, "export-"));
          const receipts = [...ids.values()].flatMap((id) => runtime!.store.getReceiptsForTask(id));
          await writeFile(join(directory, "receipts.json"), JSON.stringify(receipts));
          await writeFile(join(directory, "public-key.pem"), receiptPublicKey(runtime) ?? "");
          exports.set(step.as, directory);
          break;
        }
        case "offline_verify": {
          const directory = exports.get(step.export)!;
          const receipts = JSON.parse(await readFile(join(directory, "receipts.json"), "utf8")) as Array<Record<string, unknown>>;
          const key = await readFile(join(directory, "public-key.pem"), "utf8");
          if (step.mutate !== undefined) for (const receipt of receipts) setPath(receipt, step.mutate, "aarm-changed");
          const ok = receipts.length > 0 && receipts.every((receipt) => independentVerify(receipt, key));
          outcomes.set(step.as, { status: ok ? "ok" : "rejected", reason: "" });
          break;
        }
      }
    }

    const evaluate = async (assertion: Assertion): Promise<AssertionResult> => {
      const done = (passed: boolean, observed: string, extra: Partial<AssertionResult> = {}): AssertionResult => ({
        name: assertion.name,
        kind: assertion.kind,
        passed,
        observed: scrub(observed),
        ...extra,
      });
      if (assertion.kind === "decision") {
        const outcome = outcomes.get(assertion.of);
        if (outcome === undefined) return done(false, "no outcome");
        const reasonOk = assertion.reason === undefined || new RegExp(assertion.reason).test(outcome.reason);
        return done(
          assertion.status.includes(outcome.status) && reasonOk,
          `${outcome.status}${outcome.reason === "" ? "" : `:${outcome.reason.split("\n")[0]}`}`,
        );
      }
      if (assertion.kind === "effect") {
        switch (assertion.check) {
          case "absent": {
            const present = await stat(join(box.workspace, assertion.path)).then(() => true, () => false);
            return done(!present, `${assertion.path} ${present ? "present" : "absent"}`);
          }
          case "unchanged": {
            const content = await readFile(join(box.workspace, assertion.path), "utf8").catch(() => undefined);
            return done(content === assertion.content, content === assertion.content ? "unchanged" : `${assertion.path} changed`);
          }
          case "hits": {
            const hits = fixture.hits.filter((hit) => assertion.methods?.includes(hit.method) ?? true);
            const seen = hits.map((hit) => `${hit.method} ${hit.path}`).join(", ");
            return done(hits.length <= assertion.max, `${hits.length} hits${seen === "" ? "" : `: ${seen}`}`);
          }
          case "contained": {
            const escaped: string[] = [];
            if (fixture.count() > 0) escaped.push(`fixture_hit:${fixture.hits.map((hit) => hit.path).join(",")}`);
            if ((await snapshot(box.outside)) !== outsideBefore) escaped.push("outside_changed");
            if (JSON.stringify(returned).includes(OUTSIDE_CANARY)) escaped.push("outside_content_returned");
            if (await hasPwned(box.workspace)) escaped.push("pwned_file");
            return done(escaped.length === 0, escaped.length === 0 ? "nothing escaped" : escaped.join(" "));
          }
        }
      }
      const id = ids.get(assertion.of);
      let receipts: Array<Record<string, unknown>> = [];
      try {
        receipts = id === undefined || runtime === undefined
          ? []
          : (runtime.store.getReceiptsForTask(id) as unknown as Array<Record<string, unknown>>);
      } catch (error) {
        return done(false, `receipts unreadable: ${message(error)}`);
      }
      const last = receipts.at(-1);
      switch (assertion.check) {
        case "receipts": {
          const countOk = assertion.count === undefined ? receipts.length > 0 : receipts.length === assertion.count;
          const decided = receipts.map((receipt) => String(getPath(receipt, "policyDecision.outcome")));
          const outcomeOk =
            assertion.outcome === undefined || (receipts.length > 0 && decided.every((item) => item === assertion.outcome));
          const lacking =
            receipts.length === 0
              ? ["*"]
              : (assertion.paths ?? []).filter((path) =>
                  receipts.some((receipt) => {
                    const value = getPath(receipt, path);
                    if (path === "policyDecision.policyDigest") return !/^sha256:[0-9a-f]{64}$/.test(String(value));
                    return value === undefined || value === "";
                  }),
                );
          const missingNow = assertion.paths === undefined && receipts.length > 0 ? [] : lacking;
          return done(
            countOk && outcomeOk && missingNow.length === 0,
            `${receipts.length} receipts${decided.length === 0 ? "" : ` (${[...new Set(decided)].join(", ")})`}${
              missingNow.length === 0 ? "" : `; missing ${missingNow.join(", ")}`
            }`,
            assertion.profile === undefined ? {} : { profile: assertion.profile, missing: missingNow },
          );
        }
        case "principal": {
          const chain = String(last?.principal ?? "");
          return done(new RegExp(assertion.chain).test(chain), chain === "" ? "no receipt" : chain);
        }
        case "approval": {
          const approver = getPath(last, "policyDecision.approval.approver");
          const channel = getPath(last, "policyDecision.approval.channel");
          return done(
            approver === assertion.approver && channel === assertion.channel,
            last === undefined ? "no receipt" : `${String(approver)} via ${String(channel)}`,
          );
        }
        case "credential": {
          const used = (getPath(last, "observedEffect.credentials") ?? []) as unknown[];
          const entry = used.find((item) =>
            item === assertion.credential || (item as { name?: unknown } | null)?.name === assertion.credential,
          );
          const windowed = typeof (entry as { validUntil?: unknown } | undefined)?.validUntil === "string";
          return done(
            entry !== undefined && (assertion.window !== true || windowed),
            entry === undefined
              ? `credentials ${JSON.stringify(used)}`
              : assertion.window === true && !windowed
                ? "named, no validity window"
                : "named",
          );
        }
        case "verified": {
          const outcome = outcomes.get(assertion.of);
          return done(outcome?.status === (assertion.ok ? "ok" : "rejected"), outcome?.status ?? "not verified");
        }
      }
    };
    const assertions: AssertionResult[] = [];
    for (const assertion of testCase.asserts) assertions.push(await evaluate(assertion));
    return result(caseStatus(assertions), assertions);
  } catch (error) {
    if (error instanceof EnvironmentSkip) return result("skipped", [], scrub(error.message));
    return result("fail", [{ name: "harness", kind: "effect", passed: false, observed: scrub(`harness_error:${message(error)}`) }]);
  } finally {
    await closeServer();
    for (const item of runtimes) await item.close().catch(() => {});
    await chmod(box.data, 0o700).catch(() => {});
    await rm(box.base, { recursive: true, force: true }).catch(() => {});
  }
}

// ------------------------------------------------------------------ report

interface ManifestTest {
  id: AarmTestId;
  requirement: string;
  section: string;
  level: "MUST" | "SHOULD";
  test: string;
  caseIds: string[];
  assertions: string[];
  na?: string;
  informational?: string[];
}

export interface Manifest {
  id: string;
  aarmVersion: string;
  claimBoundary: string;
  sources: {
    paper: Record<string, string>;
    conformancePage: Record<string, string>;
    siteSource: Record<string, string>;
  };
  deviations: Array<Record<string, string>>;
  tests: ManifestTest[];
}

/** Refuses a manifest that differs from the pinned one. Line endings do not count. */
export async function loadManifest(): Promise<{ manifest: Manifest; sha256: string }> {
  const text = (await readFile(MANIFEST_URL, "utf8")).replaceAll("\r\n", "\n");
  const sha256 = createHash("sha256").update(text).digest("hex");
  if (sha256 !== AARM_MANIFEST_SHA256) throw new Error("aarm_manifest_digest_mismatch");
  return { manifest: JSON.parse(text) as Manifest, sha256 };
}

export function corpusSha256(cases: AarmCase[] = corpus): string {
  return createHash("sha256").update(canonicalJson(cases)).digest("hex");
}

function testStatus(results: CaseResult[]): Status {
  if (results.every((item) => item.status === "pass")) return "pass";
  const leaked = results.some((item) => item.assertions.some((assertion) => assertion.kind === "effect" && !assertion.passed));
  if (leaked) return "fail";
  return results.some((item) => item.status === "pass" || item.status === "partial") ? "partial" : "fail";
}

const LIMITS = [
  "MELRA-authored cases on one host: in process, or over loopback HTTP for R6-T1. No stdio client and no black-box track yet.",
  "The tamper track writes melra.sqlite as a full writer of the file, append-only triggers dropped first.",
  "Interface probes look where each roadmap item is to put its interface; one looking in the wrong place leaves its cases not_implemented, never passed.",
  "No model calls, so R7's embedding-based drift metric is untested by design.",
];

export interface AarmOptions {
  only?: string[];
}

export async function runAarm(options: AarmOptions = {}) {
  const started = performance.now();
  const { manifest, sha256 } = await loadManifest();
  const selected = options.only === undefined ? corpus : corpus.filter((item) => options.only?.includes(item.id));
  const available = await interfaces();
  const fixture = new Fixture();
  await fixture.start();
  const results: CaseResult[] = [];
  try {
    for (const testCase of selected) results.push(await runCase(testCase, fixture, available));
  } finally {
    await fixture.stop();
  }
  const informational = new Set(corpus.filter((item) => item.informational === true).map((item) => item.id));
  const tests = manifest.tests.map((entry) => {
    const ran = results.filter((item) => item.test === entry.id && !informational.has(item.id));
    const status = entry.na !== undefined ? "n/a" : ran.length === 0 ? "not_run" : testStatus(ran);
    const profiles = ran.flatMap((item) => item.assertions.filter((assertion) => assertion.profile !== undefined));
    return {
      id: entry.id,
      requirement: entry.requirement,
      section: entry.section,
      level: entry.level,
      status,
      ...(entry.na === undefined ? {} : { na: entry.na }),
      ...(profiles.length === 0
        ? {}
        : { missingReceiptFields: Object.fromEntries(profiles.map((assertion) => [assertion.profile, assertion.missing ?? []])) }),
      cases: ran,
    };
  });
  const tally = (level: "MUST" | "SHOULD") => {
    const scoped = tests.filter((item) => item.level === level);
    const count = (status: string) => scoped.filter((item) => item.status === status).length;
    return {
      total: scoped.length,
      pass: count("pass"),
      partial: count("partial"),
      fail: count("fail"),
      ...(level === "SHOULD" ? { na: count("n/a") } : {}),
      ...(count("not_run") === 0 ? {} : { notRun: count("not_run") }),
    };
  };
  const status = git(["status", "--porcelain"]);
  return {
    schemaVersion: "1.0.0",
    benchmark: "MELRA AARM v1.0 self-check",
    claimBoundary: manifest.claimBoundary,
    manifest: { id: manifest.id, sha256 },
    corpusVersion: AARM_CORPUS_VERSION,
    corpusSha256: corpusSha256(),
    corpusSize: corpus.length,
    casesRun: selected.length,
    generatedAt: new Date().toISOString(),
    spec: { aarmVersion: manifest.aarmVersion, paper: manifest.sources.paper, conformancePage: manifest.sources.conformancePage },
    melra: {
      version: PRODUCT_VERSION,
      commit: git(["rev-parse", "HEAD"]) ?? "unknown",
      dirty: status === undefined ? "unknown" : status !== "",
    },
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      architecture: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      modelCalls: 0,
      network: "loopback fixture and loopback MELRA HTTP server only",
    },
    interfaces: available,
    tally: { must: tally("MUST"), should: tally("SHOULD") },
    tests,
    informational: results.filter((item) => informational.has(item.id)),
    skipped: results.filter((item) => item.status === "skipped").map((item) => ({ id: item.id, reason: item.reason })),
    deviations: manifest.deviations,
    limits: LIMITS,
    runtimeMs: Math.round(performance.now() - started),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf("--output");
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex === -1 ? undefined : process.argv[onlyIndex + 1]?.split(",");
  const report = await runAarm(only === undefined ? {} : { only });
  // Written only where the caller asks: publishing a tally is a decision, not a side effect.
  const output = outputIndex === -1 ? undefined : resolve(process.argv[outputIndex + 1] ?? "aarm-selfcheck.json");
  if (output !== undefined) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  const { must, should } = report.tally;
  const missingInterfaces = Object.entries(report.interfaces).filter(([, present]) => !present).map(([name]) => name);
  process.stdout.write(
    [
      `${report.benchmark} (corpus ${report.corpusSha256.slice(0, 12)}, ${report.casesRun} cases; manifest ${report.manifest.id})`,
      `MUST   pass ${must.pass}/${must.total}  partial ${must.partial}  fail ${must.fail}`,
      `SHOULD pass ${should.pass}/${should.total}  partial ${should.partial}  fail ${should.fail}  n/a ${should.na}`,
      ...report.tests.map((test) => `  ${test.id} ${test.level.padEnd(6)} ${test.status}`),
      `interfaces missing: ${missingInterfaces.length === 0 ? "none" : missingInterfaces.join(", ")}`,
      ...report.skipped.map((item) => `skipped ${item.id}: ${item.reason ?? ""}`),
      `runtime ${report.runtimeMs} ms${output === undefined ? " (no artifact written; pass --output <file>)" : ` → ${output}`}`,
      "",
    ].join("\n"),
  );
}
