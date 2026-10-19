// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import {
  arch,
  cpus,
  freemem,
  hostname,
  platform,
  release,
  totalmem,
} from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import type { DeploymentMode, Operation } from "@melra/protocol";
import { deploymentMode, HttpOperationSchema } from "@melra/protocol";
import { BrowserRuntime } from "@melra/browser-runtime";
import {
  ComputerRuntime,
  type ComputerAdapter,
} from "@melra/computer-runtime";
import { FileRuntime } from "@melra/file-runtime";
import { HttpRuntime } from "@melra/http-runtime";
import { LocalMemory } from "@melra/memory";
import {
  createDefaultPolicy,
  CredentialBroker,
  loadPolicy,
  type LocalPolicy,
} from "@melra/policy-core";
import {
  PayloadCipher,
  TaskController,
  WorkflowController,
  type OperationExecutor,
} from "@melra/runtime-core";
import { SqliteStore } from "@melra/storage-sqlite";
import { TerminalRuntime } from "@melra/terminal-runtime";
import { Verifier, type RegisteredVerifier } from "@melra/verifier-core";
import { loadPayloadKey } from "./payload-key.js";

export interface MelraRuntimeOptions {
  workspaceRoot: string;
  dataDirectory: string;
  policyPath?: string;
  /**
   * Turns off every guardrail. See `LocalPolicy.unhinged`. When omitted, the
   * value comes from `MELRA_UNHINGED` in `environment`.
   */
  unhinged?: boolean;
  /**
   * Deployment mode. When omitted, the value comes from `MELRA_MODE` in
   * `environment`, then from the policy file.
   */
  mode?: DeploymentMode;
  browserExecutablePath?: string;
  browserHeadless?: boolean;
  browserCdpEndpoint?: string;
  browserCdpContextIndex?: number;
  browserHarPath?: string;
  browserHarReplayPath?: string;
  /**
   * Desktop to act on, for callers that need one that behaves the same on
   * every machine — `ReplayComputerAdapter` over a recorded trace. Deliberately
   * programmatic only: a config file able to swap the real desktop for a
   * recording could report a click nobody made.
   */
  computerAdapter?: ComputerAdapter;
  /**
   * Directory holding browser cookies and profile state between runs. Opt-in:
   * absent means a fresh throwaway profile, which is why a logged-in site has
   * to be logged into again on the next task. From `MELRA_BROWSER_PROFILE`.
   */
  browserProfileDir?: string;
  /**
   * Verifiers for `{ type: "custom", verifier: "<name>" }` evidence. Code only,
   * like `computerAdapter`: what counts as proof is not something a config
   * file or an environment variable should be able to swap in.
   */
  evidenceVerifiers?: ReadonlyArray<RegisteredVerifier>;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Whether the operator asked for unhinged mode. Only `1`, `true`, `yes`, and
 * `on` count: a stray `MELRA_UNHINGED=0` or `MELRA_UNHINGED=false` left in a
 * shell profile must not silently disarm the machine.
 */
export function unhingedFromEnvironment(
  environment: NodeJS.ProcessEnv,
): boolean {
  const raw = environment.MELRA_UNHINGED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * What enforced mode refuses about its own setup, in one place.
 *
 * MELRA cannot see whether the harness above it also holds a native terminal —
 * that is the operator's claim, and enforced mode is them making it. What MELRA
 * can do is stop being one of the ways the claim could be false. Each refusal
 * here is a door this process owns:
 *
 * - `--unsafe-local` turns off every guardrail. A mode whose whole point is that
 *   the boundary cannot be bypassed cannot also ship a bypass flag.
 * - A bind outside loopback is not IPC between a sandbox and its kernel; it is a
 *   machine-control API on a network, which is a second door by definition.
 *   Checked in `serveHttp`, which is the only place that knows the host.
 * - A client registering itself over OAuth is a stranger asking a human to let it
 *   in. Enforced mode admits service identities the operator issued, and nothing
 *   else. Also `serveHttp`.
 *
 * Deliberately not checked: whether this process runs as root. Enforced mode's
 * whole point is containers, and a container process is usually root inside it —
 * refusing that would refuse the deployment the mode exists for.
 */
export function assertEnforceable(mode: DeploymentMode, unhinged: boolean): void {
  if (mode === "enforced" && unhinged) {
    throw new Error(
      "enforced_mode_refuses_unsafe_local: enforced mode exists so the " +
        "boundary cannot be bypassed. Drop --unsafe-local, MELRA_UNHINGED and " +
        '"unhinged" in the policy file, or run in developer mode.',
    );
  }
}

/**
 * Where an unconfined runtime is rooted. Unhinged mode lifts workspace
 * confinement by rooting the file and terminal runtimes at the filesystem root
 * rather than by adding a bypass branch inside them, so the confinement code
 * itself keeps exactly one behaviour and stays impossible to accidentally skip.
 *
 * On Windows this is the root of the drive MELRA is running from; reaching a
 * second drive still requires running a second server there.
 */
export function unconfinedRoot(from: string): string {
  return parse(resolve(from)).root;
}

/**
 * Whether a workspace holds the data directory, decided the way
 * `createMelraRuntime` decides it before refusing enforced startup: by
 * identity, along the data directory's path both as spelled and resolved, so
 * `melra doctor` cannot disagree with the server it describes.
 */
export async function workspaceHoldsData(workspaceRoot: string, dataDirectory: string): Promise<boolean> {
  const files = await FileRuntime.create({
    root: workspaceRoot,
    reserved: [join(dataDirectory, "payload.key")],
  });
  return files.holdsReserved(files.root);
}

/**
 * The root a server confines to, given the one it was started for and the one
 * a policy file names: the file's only when it lies inside the given root, so
 * an operator can narrow a workspace but no file can move it elsewhere. A
 * shared ~/.melra/policy.json naming another project's root used to confine
 * every later project's server to that one.
 */
export function confinedRoot(given: string, named: string): string {
  const inside = relative(resolve(given), resolve(named));
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? resolve(named) : resolve(given);
}

export class RuntimeRouter implements OperationExecutor {
  constructor(
    private readonly files: FileRuntime,
    private readonly terminal: TerminalRuntime,
    private readonly browser: BrowserRuntime,
    private readonly computer: ComputerRuntime,
    private readonly memory: LocalMemory,
    private readonly http: HttpRuntime,
  ) {}

  async execute(
    operation: Operation,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted === true) throw new Error("task_cancelled");
    switch (operation.kind) {
      case "file":
        return await this.files.execute(operation);
      case "terminal":
        return await this.terminal.execute(operation, signal);
      case "browser":
        return await this.browser.execute(operation, signal);
      case "memory":
        return this.memory.execute(operation);
      case "computer":
        return await this.computer.execute(operation, signal);
      case "http":
        return await this.http.execute(operation, signal);
      case "system":
        return {
          platform: platform(),
          release: release(),
          architecture: arch(),
          hostname: hostname(),
          cpuCount: cpus().length,
          totalMemoryBytes: totalmem(),
          freeMemoryBytes: freemem(),
          nodeVersion: process.version,
        };
    }
  }

  capabilities(): ReadonlySet<Operation["kind"]> {
    return new Set<Operation["kind"]>([
      "file",
      "terminal",
      "browser",
      "memory",
      "computer",
      "http",
      "system",
    ]);
  }

  async close(): Promise<void> {
    await this.terminal.close();
    await this.browser.close();
  }
}

export interface MelraRuntime {
  controller: TaskController;
  workflows: WorkflowController;
  /** Names a `custom` evidence predicate may use with this runtime. */
  customEvidence: string[];
  policy: LocalPolicy;
  store: SqliteStore;
  router: RuntimeRouter;
  workspaceRoot: string;
  dataDirectory: string;
  close(): Promise<void>;
}

// How often a running runtime looks for work a crashed peer left behind.
const RECOVERY_SWEEP_MS = 30_000;

export async function createMelraRuntime(
  options: MelraRuntimeOptions,
): Promise<MelraRuntime> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const dataDirectory = resolve(options.dataDirectory);
  const environment = options.environment ?? process.env;
  const loaded =
    options.policyPath === undefined
      ? createDefaultPolicy(workspaceRoot)
      : await loadPolicy(options.policyPath, workspaceRoot);
  // Either channel is enough to ask for it, and the resolved policy is the one
  // place that answers "is this server unhinged" — so a policy file that sets
  // the flag still raises every warning the environment variable does.
  const unhinged =
    (options.unhinged ?? unhingedFromEnvironment(environment)) ||
    loaded.unhinged;
  // Same shape, opposite direction: the strictest of the three wins, so a policy
  // file that pinned enforced mode is not loosened by an unset variable.
  const mode: DeploymentMode =
    (options.mode ?? deploymentMode(environment.MELRA_MODE)) === "enforced" ||
    loaded.mode === "enforced"
      ? "enforced"
      : "developer";
  assertEnforceable(mode, unhinged);
  const policy: LocalPolicy = {
    ...loaded,
    workspaceRoot: confinedRoot(workspaceRoot, loaded.workspaceRoot),
    unhinged,
    mode,
  };
  // Confinement is lifted by moving the root, not by branching inside the
  // runtimes. `maxFileBytes` stays as configured: it bounds how much one read
  // pulls into memory, and an unbounded read is a way to crash the host, not a
  // guardrail on what the operator is allowed to touch.
  const runtimeRoot = unhinged
    ? unconfinedRoot(workspaceRoot)
    : policy.workspaceRoot;
  const key = await loadPayloadKey({ dataDirectory, environment });
  const cipher = new PayloadCipher(key);
  const store = new SqliteStore(join(dataDirectory, "melra.sqlite"));
  // What this process holds open or locked. A workspace can contain the data
  // directory (`serve` started from home), and an adapter opening and closing
  // one of these would drop this process's POSIX locks on it: SQLite's on the
  // database, or the one other processes read this one's liveness from.
  const reserved = [
    ...["", "-wal", "-shm", "-journal", "-owners"].map((suffix) => `${store.path}${suffix}`),
    join(dataDirectory, "payload.key"),
  ];
  const files = await FileRuntime.create({
    root: runtimeRoot,
    maxFileBytes: policy.maxFileBytes,
    reserved,
  });
  // A workspace holding the data directory reaches it with a recursive read of
  // no path at all, so refusing the directories above it would be theatre
  // there; enforced mode refuses that layout instead.
  const holdsData = await files.holdsReserved(files.root);
  if (mode === "enforced" && holdsData) {
    store.close();
    throw new Error(
      "enforced_mode_refuses_data_inside_workspace: run setup from the project directory, or set " +
        "MELRA_WORKSPACE to it; keep MELRA_HOME where it is (moving it orphans the database).",
    );
  }
  const terminal = await TerminalRuntime.create({
    root: runtimeRoot,
    reserved: (path) => files.isReserved(path),
    ...(holdsData ? {} : { holdsReserved: (path: string) => files.holdsReserved(path) }),
    confineArguments: mode === "enforced",
  });
  const browser = new BrowserRuntime({
    artifactDirectory: join(dataDirectory, "artifacts"),
    workspaceRoot: runtimeRoot,
    allowedDomains: policy.allowedDomains,
    allowLocalhost: policy.allowLocalhost,
    popups: policy.popups,
    unhinged,
    ...(options.browserExecutablePath === undefined
      ? {}
      : { executablePath: options.browserExecutablePath }),
    ...(options.browserHeadless === undefined
      ? {}
      : { headless: options.browserHeadless }),
    ...(options.browserCdpEndpoint === undefined
      ? {}
      : { cdpEndpoint: options.browserCdpEndpoint }),
    ...(options.browserCdpContextIndex === undefined
      ? {}
      : { cdpContextIndex: options.browserCdpContextIndex }),
    ...(options.browserHarPath === undefined
      ? {}
      : { recordHarPath: options.browserHarPath }),
    ...(options.browserHarReplayPath === undefined
      ? {}
      : { replayHarPath: options.browserHarReplayPath }),
    ...(options.browserProfileDir === undefined
      ? {}
      : { userDataDir: options.browserProfileDir }),
  });
  const memory = new LocalMemory(store, policy.memoryRetention);
  const computer = new ComputerRuntime({
    artifactDirectory: join(dataDirectory, "artifacts"),
    ...(options.computerAdapter === undefined
      ? {}
      : { adapter: options.computerAdapter }),
  });
  const http = new HttpRuntime({
    allowedDomains: policy.allowedDomains,
    allowLocalhost: policy.allowLocalhost,
    unhinged,
    // Host and capability scoping stay on under `unhinged`. That flag lifts the
    // guardrails MELRA imposes on the caller; a credential's scope is the
    // operator bounding their own secret, and nothing in this process asked for
    // that to be widened.
    credentials: new CredentialBroker(policy.credentials),
  });
  const router = new RuntimeRouter(
    files,
    terminal,
    browser,
    computer,
    memory,
    http,
  );
  const verifier = await Verifier.create(runtimeRoot, {
      reserved: (path) => files.isReserved(path),
      ...(options.evidenceVerifiers === undefined ? {} : { verifiers: options.evidenceVerifiers }),
      // The same adapter the effects go through, so a verification request is
      // checked against the destination boundary, the allowlist, and the
      // credential scope like any other call. A read that could reach where an
      // effect may not would be a way to make the verifier fetch things for
      // you.
      probe: async (request) =>
        await http.execute(
          HttpOperationSchema.parse({
            kind: "http",
            action: "request",
            method: request.method,
            url: request.url,
            timeoutMs: request.timeoutMs,
          }),
        ),
    });
  const controller = new TaskController(store, policy, router, verifier, cipher);
  const workflows = new WorkflowController(store, controller, cipher);
  // The workflow pass runs the task pass first.
  await workflows.recoverInterrupted();
  // Startup only sees processes that died before it. The sweep picks up work
  // left by ones that die later, while this one keeps running.
  let sweeping: Promise<unknown> | undefined;
  const sweep = setInterval(() => {
    sweeping ??= workflows
      .recoverInterrupted({ abandonedOnly: true })
      .catch((error: unknown) =>
        process.emitWarning(
          `melra recovery sweep: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        sweeping = undefined;
      });
  }, RECOVERY_SWEEP_MS);
  sweep.unref();
  return {
    controller,
    workflows,
    customEvidence: verifier.customVerifiers(),
    policy,
    store,
    router,
    workspaceRoot,
    dataDirectory,
    async close() {
      clearInterval(sweep);
      await sweeping;
      await router.close();
      store.close();
    },
  };
}
