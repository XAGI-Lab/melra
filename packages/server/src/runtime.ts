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
import { join, parse, resolve } from "node:path";
import type { Operation } from "@melra/protocol";
import { BrowserRuntime } from "@melra/browser-runtime";
import { ComputerRuntime } from "@melra/computer-runtime";
import { FileRuntime } from "@melra/file-runtime";
import { LocalMemory } from "@melra/memory";
import {
  createDefaultPolicy,
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
import { Verifier } from "@melra/verifier-core";
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
  browserExecutablePath?: string;
  browserHeadless?: boolean;
  browserCdpEndpoint?: string;
  browserCdpContextIndex?: number;
  browserHarPath?: string;
  browserHarReplayPath?: string;
  /**
   * Directory holding browser cookies and profile state between runs. Opt-in:
   * absent means a fresh throwaway profile, which is why a logged-in site has
   * to be logged into again on the next task. From `MELRA_BROWSER_PROFILE`.
   */
  browserProfileDir?: string;
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

export class RuntimeRouter implements OperationExecutor {
  constructor(
    private readonly files: FileRuntime,
    private readonly terminal: TerminalRuntime,
    private readonly browser: BrowserRuntime,
    private readonly computer: ComputerRuntime,
    private readonly memory: LocalMemory,
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
        return await this.browser.execute(operation);
      case "memory":
        return this.memory.execute(operation);
      case "computer":
        return await this.computer.execute(operation, signal);
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
      "system",
    ]);
  }

  async close(): Promise<void> {
    this.terminal.close();
    await this.browser.close();
  }
}

export interface MelraRuntime {
  controller: TaskController;
  workflows: WorkflowController;
  policy: LocalPolicy;
  store: SqliteStore;
  router: RuntimeRouter;
  workspaceRoot: string;
  dataDirectory: string;
  close(): Promise<void>;
}

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
  const policy: LocalPolicy = { ...loaded, unhinged };
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
  const files = await FileRuntime.create({
    root: runtimeRoot,
    maxFileBytes: policy.maxFileBytes,
  });
  const terminal = await TerminalRuntime.create({ root: runtimeRoot });
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
  });
  const router = new RuntimeRouter(files, terminal, browser, computer, memory);
  const controller = new TaskController(
    store,
    policy,
    router,
    await Verifier.create(runtimeRoot),
    cipher,
  );
  const workflows = new WorkflowController(store, controller, cipher);
  await controller.recoverInterrupted();
  await workflows.recoverInterrupted();
  return {
    controller,
    workflows,
    policy,
    store,
    router,
    workspaceRoot,
    dataDirectory,
    async close() {
      await router.close();
      store.close();
    },
  };
}
