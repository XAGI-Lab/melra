// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdir, realpath, stat } from "node:fs/promises";
import {
  arch,
  cpus,
  freemem,
  homedir,
  hostname,
  platform,
  release,
  totalmem,
} from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
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
  classifyCommand,
  CredentialBroker,
  loadPolicy,
  localhostAllowed,
  normalizeCommandName,
  sandboxUse,
  type LocalPolicy,
} from "@melra/policy-core";
import {
  PayloadCipher,
  TaskController,
  WorkflowController,
  type OperationExecutor,
} from "@melra/runtime-core";
import { SqliteStore } from "@melra/storage-sqlite";
import { detectSandbox, TerminalRuntime, type CommandSandbox } from "@melra/terminal-runtime";
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
  /**
   * How the OS sandbox commands run in is found. Code only, like
   * `computerAdapter`: a seam for tests, which no file or variable can swap.
   * Absent, this host's own (`detectSandbox`).
   */
  detectSandbox?: typeof detectSandbox;
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
 * What enforced mode warns of, at startup and in `melra doctor`, when MELRA's
 * own environment holds `MELRA_PAYLOAD_KEY` or `MELRA_HTTP_TOKEN`; undefined
 * when it holds neither. No program MELRA starts inherits them, but any
 * process running as the same OS user can read another's environment (`ps
 * eww`, `/proc/<pid>/environ`), and no sandbox profile hides it the way it can
 * deny a file. A warning, not a refusal: the compose recipe passes the token
 * this way.
 */
export function environmentSecrets(
  environment: NodeJS.ProcessEnv,
  dataDirectory: string,
): { detail: string; next: string } | undefined {
  // Blank is unset, as `serveHttp` reads the token.
  const set = ["MELRA_PAYLOAD_KEY", "MELRA_HTTP_TOKEN"].filter((name) => environment[name]?.trim());
  if (set.length === 0) return undefined;
  return {
    detail: `${set.join(" and ")} ${set.length > 1 ? "are" : "is"} set in MELRA's environment, which any process running as this OS user can read`,
    next: [
      ...(set.includes("MELRA_PAYLOAD_KEY")
        ? [`write the key to ${join(dataDirectory, "payload.key")} (mode 0600) and unset MELRA_PAYLOAD_KEY`]
        : []),
      ...(set.includes("MELRA_HTTP_TOKEN") ? ["unset MELRA_HTTP_TOKEN, so serve makes a random token"] : []),
    ].join("; "),
  };
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
 * The files the browser and the credential broker read secrets from, wherever
 * the operator put them, each by the setting that names it: the profile, the
 * HTTP archives, and every credential's `source.file`. `createMelraRuntime`
 * reserves them as it does the policy file.
 */
export function secretFiles(
  options: Pick<MelraRuntimeOptions, "browserProfileDir" | "browserHarPath" | "browserHarReplayPath">,
  credentials: LocalPolicy["credentials"],
): Map<string, string> {
  const secrets = new Map<string, string>();
  if (options.browserProfileDir !== undefined) secrets.set("MELRA_BROWSER_PROFILE", resolve(options.browserProfileDir));
  if (options.browserHarPath !== undefined) secrets.set("MELRA_BROWSER_HAR_PATH", resolve(options.browserHarPath));
  if (options.browserHarReplayPath !== undefined) {
    secrets.set("MELRA_BROWSER_HAR_REPLAY", resolve(options.browserHarReplayPath));
  }
  for (const [name, definition] of Object.entries(credentials)) {
    // Resolved as the broker reads it.
    if ("file" in definition.source) secrets.set(`credentials.${name}`, resolve(definition.source.file));
  }
  return secrets;
}

/**
 * The first of `secrets` a workspace holds, decided as `workspaceHoldsData`
 * decides it, or undefined: enforced mode refuses to start there.
 */
export async function secretInsideWorkspace(
  workspaceRoot: string,
  secrets: Map<string, string>,
): Promise<string | undefined> {
  for (const [name, path] of secrets) {
    const files = await FileRuntime.create({ root: workspaceRoot, reserved: [path] });
    if (await files.holdsReserved(files.root)) return name;
  }
  return undefined;
}

/**
 * The OS sandbox commands run in on this host, found as `createMelraRuntime`
 * finds it at startup, so `melra doctor` cannot disagree with the server it
 * describes. No command may read or write the data directory, the policy
 * file, a secret file, or a login under home the policy file does not allow
 * back.
 */
export async function commandSandbox(
  settings: LocalPolicy["sandbox"],
  paths: { workspaceRoot: string; dataDirectory: string; policyPath?: string; secrets: Map<string, string> },
  detect: typeof detectSandbox = detectSandbox,
): ReturnType<typeof detectSandbox> {
  return await detect({
    workspace: paths.workspaceRoot,
    denied: [
      resolve(paths.dataDirectory),
      ...(paths.policyPath === undefined ? [] : [resolve(paths.policyPath)]),
      ...paths.secrets.values(),
    ],
    readable: settings.readable,
    user: settings.user,
    dataDirectory: resolve(paths.dataDirectory),
  });
}

/**
 * Whether a workspace is the data directory or inside it, which
 * `createMelraRuntime` refuses in every mode: every path there is MELRA's own.
 * Asked of the browser profile the same way.
 */
export async function workspaceInsideData(workspaceRoot: string, dataDirectory: string): Promise<boolean> {
  const files = await FileRuntime.create({ root: unconfinedRoot(dataDirectory), reserved: [dataDirectory] });
  return files.isReserved(workspaceRoot);
}

/**
 * Whether a workspace hands the agent every project at once: a filesystem
 * root, the home directory, or a directory holding home (`/Users`, `/home`,
 * `C:\Users`). Decided by identity, so a symlinked home, a bind mount and
 * macOS's `/System/Volumes/Data` firmlink spelling (which realpath does not
 * fold) all count. Undefined for any other directory, a project under home
 * included, and for one that does not resolve, which `doctor` reports.
 */
export async function broadWorkspace(
  workspace: string,
  home = homedir(),
): Promise<"root" | "home" | "holds-home" | undefined> {
  try {
    const real = await realpath(workspace);
    if (parse(real).root === real) return "root";
    const id = async (path: string) => {
      const found = await stat(path, { bigint: true });
      return `${found.dev}:${found.ino}`;
    };
    const target = await id(real);
    const realHome = await realpath(home);
    const homeId = await id(realHome);
    for (const start of new Set([realHome, join("/System/Volumes/Data", realHome)])) {
      // Only a spelling that is home: the ancestors of one that is not are not home's.
      if ((await id(start).catch(() => undefined)) !== homeId) continue;
      for (let current = start; ; current = dirname(current)) {
        if ((await id(current).catch(() => undefined)) === target) {
          return current === start ? "home" : "holds-home";
        }
        if (dirname(current) === current) break;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * How to give a process a narrower workspace. MELRA_WORKSPACE always works.
 * The working directory does unless an operator's policy file pins the
 * workspace, as the CLI lets a MELRA_POLICY file's `workspaceRoot` do when
 * MELRA_WORKSPACE is unset; the shared ~/.melra/policy.json only narrows it.
 */
export function narrowWorkspaceAdvice(dataDirectory: string, policyPath?: string): string {
  return policyPath === undefined || resolve(policyPath) === resolve(dataDirectory, "policy.json")
    ? "set MELRA_WORKSPACE to your project directory, or run this from there"
    : `set MELRA_WORKSPACE to your project directory, or make that the workspaceRoot in ${policyPath}`;
}

/**
 * What to do about a workspace that holds the data directory, by layout. A
 * broad workspace is the mistake (the default ~/.melra is in home), and moving
 * MELRA_HOME would only point the server at a new, empty database. A project
 * someone put MELRA_HOME inside is fixed by moving it out, database and all.
 * Only the default location is said to stay: one inside a project under a
 * broad workspace still has to move once the workspace is narrowed.
 */
export async function dataLocationAdvice(
  workspaceRoot: string,
  dataDirectory: string,
  policyPath?: string,
): Promise<string> {
  if ((await broadWorkspace(workspaceRoot)) === undefined) {
    return "move the MELRA_HOME directory, with everything in it, out of the workspace, and set MELRA_HOME to where it went";
  }
  const narrow = narrowWorkspaceAdvice(dataDirectory, policyPath);
  return resolve(dataDirectory) === resolve(homedir(), ".melra")
    ? `${narrow}; keep MELRA_HOME where it is (moving it orphans the database)`
    : narrow;
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

/**
 * The home's payload cipher. The one place a key is loaded, `serve`, `run`,
 * `approve`, `audit` and the rest alike, so none of them mints one for a home
 * sealed under another, or starts with one that cannot open what is sealed
 * there: that process would seal under it too, splitting the home between
 * two keys (#417). `mint: false`, for a command that only reads, never writes
 * a key where there is none.
 */
export async function homeCipher(
  store: SqliteStore,
  dataDirectory: string,
  environment: NodeJS.ProcessEnv,
  { mint = true }: { mint?: boolean } = {},
): Promise<PayloadCipher> {
  const sample = store.sealedPayloadSample();
  const cipher = new PayloadCipher(
    await loadPayloadKey({ dataDirectory, environment, sealed: !mint || sample !== undefined }),
  );
  if (sample !== undefined) {
    try {
      cipher.open(sample.payload, sample.context);
    } catch {
      throw new Error(
        `payload_key_mismatch: ${dataDirectory} holds payloads sealed under another key; ` +
          "set MELRA_PAYLOAD_KEY to the key they were sealed under, or restore payload.key from its backup.",
      );
    }
  }
  return cipher;
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
  // `melra launch` sets this on the server it starts for an agent with no
  // shell of its own, so the defaults leave out node, npm, npx and pnpm; a
  // policy file that lists them keeps them.
  const runtimes = environment.MELRA_LAUNCHED !== "1";
  // Through `loadPolicy` either way, so the defaults carry their digest too.
  const loaded = await loadPolicy(options.policyPath, workspaceRoot, runtimes);
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
  // Decided once, in the resolved mode, so what `melra_capabilities` publishes
  // is what both network adapters apply.
  const allowLocalhost = localhostAllowed({ ...loaded, mode });
  const policy: LocalPolicy = {
    ...loaded,
    workspaceRoot: confinedRoot(workspaceRoot, loaded.workspaceRoot),
    allowLocalhost,
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
  const store = new SqliteStore(join(dataDirectory, "melra.sqlite"));
  let cipher: PayloadCipher;
  try {
    cipher = await homeCipher(store, dataDirectory, environment);
    // Before recovery writes anything: what an older MELRA sharing the home
    // wrote since the last start is sealed now, and every record from here
    // in the transaction that writes it.
    store.sealRecords(cipher.chainKey());
  } catch (error) {
    store.close();
    throw error;
  }
  // What this process holds open or locked. A workspace can contain the data
  // directory (`serve` started from home), and an adapter opening and closing
  // one of these would drop this process's POSIX locks on it: SQLite's on the
  // database, or the one other processes read this one's liveness from. The
  // data directory as a whole too: it also holds the key, the files a later
  // start reads its policy and clients from, and the artifacts, which may be
  // read but not changed.
  const reserved = [
    dataDirectory,
    ...["", "-wal", "-shm", "-journal", "-owners"].map((suffix) => `${store.path}${suffix}`),
    join(dataDirectory, "payload.key"),
  ];
  const artifacts = join(dataDirectory, "artifacts");
  const secrets = secretFiles(options, policy.credentials);
  const files = await FileRuntime.create({
    root: runtimeRoot,
    maxFileBytes: policy.maxFileBytes,
    // And, wherever they lie, the policy file, which every start reads again,
    // and the files secrets are read from.
    reserved: [
      ...reserved,
      ...(options.policyPath === undefined ? [] : [resolve(options.policyPath)]),
      ...secrets.values(),
    ],
    readable: [artifacts],
  });
  // The data alone, for the layout checks and the terminal's directory check:
  // a workspace holding only the policy file, or in developer mode a secret
  // file, is an ordinary one, whose commands still run. ponytail: so a
  // terminal command given a directory holding one still reaches it unnamed.
  const data = await FileRuntime.create({ root: runtimeRoot, reserved });
  // Every path in such a workspace would be refused, without saying why.
  if (await data.isReserved(policy.workspaceRoot)) {
    store.close();
    throw new Error(
      "workspace_inside_data_directory: point MELRA_WORKSPACE at the project, outside MELRA_HOME.",
    );
  }
  const profile = secrets.get("MELRA_BROWSER_PROFILE");
  if (profile !== undefined && (await workspaceInsideData(policy.workspaceRoot, profile))) {
    store.close();
    throw new Error(
      "workspace_inside_browser_profile: point MELRA_WORKSPACE at the project, outside MELRA_BROWSER_PROFILE.",
    );
  }
  // A workspace holding the data directory reaches it with a recursive read of
  // no path at all, so refusing the directories above it would be theatre
  // there; enforced mode refuses that layout instead.
  const holdsData = await data.holdsReserved(data.root);
  if (mode === "enforced" && holdsData) {
    store.close();
    const advice = await dataLocationAdvice(files.root, dataDirectory, options.policyPath);
    throw new Error(`enforced_mode_refuses_data_inside_workspace: ${advice}.`);
  }
  // The same unnamed read reaches a secret file there. Its own refusal: the
  // data directory's advice about MELRA_HOME does not fit it.
  const held = mode === "enforced" ? await secretInsideWorkspace(files.root, secrets) : undefined;
  if (held !== undefined) {
    store.close();
    throw new Error(
      `enforced_mode_refuses_secret_inside_workspace: ${held} names ${secrets.get(held)}, inside the workspace, ` +
        "where a recursive read reaches it without naming it; move it out of the workspace.",
    );
  }
  // The directories the browser writes into, made now rather than at its first
  // start, so the names it will write are recognised before it does.
  for (const path of [options.browserProfileDir, options.browserHarPath]) {
    if (path !== undefined) await mkdir(dirname(resolve(path)), { recursive: true }).catch(() => undefined);
  }
  // Every command in an OS sandbox: always in enforced mode, and wherever one
  // works in developer mode, unless the policy file says `off`. Found once,
  // here, so a host with none refuses to start rather than run commands with
  // MELRA's own rights; with `if-available`, developer mode's default or the
  // operator's recorded opt-out, it starts and every receipt says
  // `sandbox: none`.
  const use = sandboxUse(policy);
  if (mode === "enforced" && use === "off") {
    store.close();
    throw new Error(
      'enforced_mode_refuses_sandbox_off: enforced mode runs every command in an OS sandbox; drop "use": "off" ' +
        'from "sandbox" in the policy file, or set it to "if-available" to start without one where none works.',
    );
  }
  let sandbox: CommandSandbox | undefined;
  if (use !== "off") {
    const found = await commandSandbox(
      policy.sandbox,
      {
        workspaceRoot: runtimeRoot,
        dataDirectory,
        secrets,
        ...(options.policyPath === undefined ? {} : { policyPath: options.policyPath }),
      },
      options.detectSandbox,
    );
    if ("problems" in found && use === "on") {
      store.close();
      throw new Error(
        `sandbox_unavailable: no per-command OS sandbox works on this host. ${found.problems.join(". ")}. ` +
          'Or set "sandbox": {"use": "if-available"} in the policy file to start without one, which every receipt records.',
      );
    }
    sandbox = "sandbox" in found ? found.sandbox : undefined;
    policy.sandbox = { ...policy.sandbox, backend: sandbox?.backend ?? "none" };
    // The `uid` sandbox's account shares MELRA's group, as in the container
    // pair: what either one creates, the other may change. Commands inherit it.
    if (sandbox?.backend === "uid") process.umask(0o002);
  }
  const symlinkers = new Set((policy.sandbox.symlinks ?? []).map(normalizeCommandName));
  const listeners = new Set((policy.sandbox.listen ?? []).map(normalizeCommandName));
  // Without links git still exits 0: a clone or init writes core.symlinks=false
  // and checks each link out as a plain file. Developer mode, sandboxed by
  // default, lets it make them; enforced mode only where the policy names it.
  if (mode === "developer") symlinkers.add("git");
  const terminal = await TerminalRuntime.create({
    root: runtimeRoot,
    reserved: (path, call) => files.isReserved(path, false, call),
    ...(holdsData ? {} : { holdsReserved: (path: string, call?: object) => data.holdsReserved(path, call) }),
    confineArguments: mode === "enforced",
    // MELRA's judgement about approved writes, so unsafe-local, which approves
    // nothing, keeps the operator's PATH as given.
    ...(unhinged ? {} : { pathOutside: policy.workspaceRoot }),
    ...(sandbox === undefined
      ? {}
      : {
          sandbox,
          // By what the call asks for, as policy classified it: the network
          // only for the `network` trait, links for installs, the programs
          // the policy file names and, in developer mode, git.
          allowance: (command: string, args: readonly string[]) => {
            const { traits } = classifyCommand(command, args);
            return {
              network: traits.includes("network"),
              symlinks: traits.includes("package-install") || symlinkers.has(normalizeCommandName(command)),
              listen: listeners.has(normalizeCommandName(command)),
            };
          },
        }),
  });
  const browser = new BrowserRuntime({
    artifactDirectory: artifacts,
    workspaceRoot: runtimeRoot,
    allowedDomains: policy.allowedDomains,
    allowLocalhost,
    popups: policy.popups,
    unhinged,
    // Upload and file: loads only read, so its own artifacts stay usable.
    reserved: (path) => files.isReserved(path, true),
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
    artifactDirectory: artifacts,
    // Every helper it starts inherits this process's environment, which holds
    // these as the broker reads them, whatever host each is scoped to.
    withheldEnvironment: Object.values(policy.credentials).flatMap((definition) =>
      "env" in definition.source ? [definition.source.env] : [],
    ),
    ...(options.computerAdapter === undefined
      ? {}
      : { adapter: options.computerAdapter }),
  });
  const http = new HttpRuntime({
    allowedDomains: policy.allowedDomains,
    allowLocalhost,
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
      // Reads only, so artifacts can be checked.
      reserved: (path, call) => files.isReserved(path, true, call),
      ...(options.evidenceVerifiers === undefined ? {} : { verifiers: options.evidenceVerifiers }),
      // The same adapter the effects go through, so a verification request is
      // checked against the destination boundary, the allowlist, and the
      // credential scope like any other call. A read that could reach where an
      // effect may not would be a way to make the verifier fetch things for
      // you. Policy holds the rest: in enforced mode a task whose check goes
      // to a host only `*` admits waits for the operator, and a workflow's own
      // check there is refused at planning and advance (`unlistedProbe`).
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
  // Once started: a process that refuses to start has nothing to warn about.
  const exposed = mode === "enforced" ? environmentSecrets(environment, dataDirectory) : undefined;
  if (exposed !== undefined) process.emitWarning(`melra: ${exposed.detail}; ${exposed.next}`);
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
