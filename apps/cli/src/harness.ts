// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Claude Code's own settings, as `melra setup --client claude-code --exclusive`
// writes them and `melra doctor` reads them back. The tool names, keys and
// paths are Claude Code's, checked on 2026-10-26 against
// https://code.claude.com/docs/en/tools-reference (tool names),
// https://code.claude.com/docs/en/permissions (a bare deny rule removes the
// tool from the model's context; deny rules from every file apply),
// https://code.claude.com/docs/en/managed-settings (paths, managed-only keys,
// the sources ranked above the managed files, and under managedSourcesBehavior
// "merge" lists unioned and the strictest lock winning)
// and https://code.claude.com/docs/en/managed-mcp (managed-mcp.json).

import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, sep, win32 } from "node:path";
import { launchOf } from "./client-status.js";
import { clientConfig, isObject, type ServerEntry } from "./clients.js";

/**
 * Claude Code's built-in tools that change something or reach the network:
 * the shells and Monitor, which runs commands and opens WebSockets; the file
 * editors; the web tools; the worktree tools, which create and delete git
 * worktrees; and the tools that publish, schedule, notify or message another
 * session through claude.ai. Pinned to the documentation above: a tool a later
 * Claude Code adds is not on it, and nothing here can tell.
 */
export const CLAUDE_DENIED_TOOLS: readonly string[] = [
  "Bash",
  "PowerShell",
  "Monitor",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "EnterWorktree",
  "ExitWorktree",
  "Artifact",
  "RemoteTrigger",
  "SendMessage",
  "SendUserFile",
  "PushNotification",
  "ShareOnboardingGuide",
];

/**
 * The managed-only keys, and the one key every scope reads, that stop a user,
 * project or local settings file, a hook, or bypass mode from undoing the
 * managed deny list, each with the value that locks it.
 */
export const CLAUDE_LOCKS: Readonly<Record<string, unknown>> = {
  allowManagedPermissionRulesOnly: true,
  allowManagedHooksOnly: true,
  "permissions.disableBypassPermissionsMode": "disable",
};

/** Where Claude Code reads managed-settings.json and managed-mcp.json. */
export function claudeManagedDirectory(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code";
}

/**
 * The two files MELRA owns whole in the managed tier: the deny list with its
 * locks, and an MCP config listing only melra, which Claude Code then loads to
 * the exclusion of every other server.
 */
export function claudeManagedFiles(entry: ServerEntry): Record<string, string> {
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    "managed-settings.json": json({
      permissions: { deny: CLAUDE_DENIED_TOOLS, disableBypassPermissionsMode: "disable" },
      allowManagedPermissionRulesOnly: true,
      allowManagedHooksOnly: true,
    }),
    "managed-mcp.json": json(clientConfig("claude-code", entry)),
  };
}

const contains = (folder: string, path: string) => {
  // A macOS volume ignores case by default, a name not yet on disk included;
  // path.relative already does on Windows.
  const fold = (each: string) => (process.platform === "darwin" ? each.toLowerCase() : each);
  const rest = relative(fold(folder), fold(path));
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};

// Links followed and, on macOS and Windows, each name spelled as on disk, as
// far as the path exists; the rest is kept as written.
function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
}

/** Whether `path` is `folder` or inside it, as written or with links followed. */
export const within = (folder: string, path: string): boolean =>
  [path, real(path)].some((each) => [folder, real(folder)].some((at) => contains(at, each)));

/**
 * The launch a managed file may name. Every session on the machine runs it,
 * so no part of it may be something the user running setup, and so an agent
 * running as that user, can replace: not `npx`, whose cache is in that user's
 * home, not a name looked up on `PATH`, and no path inside the home folder,
 * as written or with links followed. The last argument is `serve`.
 */
export function managedLaunch(
  launch: { command: string; args: string[] },
  home: string,
): { command: string; args: string[] } {
  if (launch.command === "npx") {
    throw new Error(
      "managed_launch_refused: this melra runs through npx, from a cache in your home folder; " +
        "install @melra/cli where only an administrator can write, or use the single executable, and run setup from there",
    );
  }
  for (const path of [launch.command, ...launch.args.slice(0, -1)]) {
    if (!isAbsolute(path)) {
      throw new Error(
        `managed_launch_refused: ${path} is not an absolute path; ` +
          "run setup from a melra installed where only an administrator can write",
      );
    }
    if (within(home, path)) {
      throw new Error(
        `managed_launch_refused: ${path} is inside ${home}, where an agent running as you can replace it; ` +
          "run setup from a melra and a node installed where only an administrator can write",
      );
    }
  }
  return launch;
}

const sh = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

/**
 * What an administrator runs to install the staged files: `sudo install`
 * lines on macOS and Linux, the destination as text on Windows. MELRA itself
 * never writes there.
 */
export function installLines(staged: Record<string, string>, platform: NodeJS.Platform = process.platform): string[] {
  const target = claudeManagedDirectory(platform);
  if (platform === "win32") {
    return Object.entries(staged).map(([name, from]) => `as an administrator, copy ${from} to ${win32.join(target, name)}`);
  }
  // The target's separator, whatever this host's is.
  return [
    `sudo install -d -o root -m 0755 ${sh(target)}`,
    ...Object.entries(staged).map(([name, from]) => `sudo install -o root -m 0644 ${sh(from)} ${sh(posix.join(target, name))}`),
  ];
}

export interface HarnessFile {
  scope: "managed" | "local" | "project" | "user";
  path: string;
  sha256: string;
  // Managed files only, and not on Windows, where ownership is an ACL.
  owner?: number;
  mode?: string;
  writable?: boolean;
}

export interface HarnessReport {
  client: "claude-code";
  managedDirectory: string;
  /** Pinned tools a deny rule in force removes, and the rest. */
  removed: string[];
  present: string[];
  /** Each of `CLAUDE_LOCKS`, set to its locking value or not, once a managed source in force is read. */
  locks?: Record<string, boolean>;
  /** The servers managed-mcp.json lists, when there is one. */
  managedServers?: string[];
  /**
   * Its melra entry's executable, never the arguments, and whether the launch
   * is one `managedLaunch` takes, ending in `serve`.
   */
  managedMelra?: { command?: string; accepted: boolean };
  /**
   * Managed sources Claude Code ranks above the managed files that are
   * present here; by default the first one replaces managed-settings.json.
   * Not claude.ai settings that merge with it.
   */
  aboveManaged: string[];
  /** Whether this user can write the managed folder; not on Windows. */
  managedDirectoryWritable?: boolean;
  /** Whether this user is in an admin, sudo or wheel group; not inspected on Windows. */
  admin?: boolean;
  files: HarnessFile[];
  unreadable: string[];
}

export interface HarnessProbe {
  workspace: string;
  /** Claude Code's user folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
  userDirectory?: string;
  managedDirectory?: string;
  /** macOS's managed preferences folder, where an MDM profile lands. */
  managedPreferences?: string;
  platform?: NodeJS.Platform;
  stat?: (path: string) => Promise<{ uid: number; mode: number }>;
  writable?: (path: string) => Promise<boolean>;
  admin?: () => Promise<boolean | undefined>;
}

async function inAdminGroup(platform: NodeJS.Platform): Promise<boolean | undefined> {
  if (platform === "win32" || process.getgroups === undefined) return undefined;
  if (process.getuid?.() === 0) return true;
  let groups: string;
  try {
    groups = await readFile("/etc/group", "utf8");
  } catch {
    return undefined;
  }
  // macOS lists its admin group here too, though membership comes from its
  // directory service; getgroups() reports that membership.
  const admins = new Set(
    groups.split("\n").flatMap((line) => {
      const [name = "", , gid] = line.split(":");
      return ["admin", "sudo", "wheel"].includes(name) && gid !== undefined ? [Number(gid)] : [];
    }),
  );
  return process.getgroups().some((gid) => admins.has(gid));
}

// A deny rule removes the tool when it names the whole tool: the bare name,
// `Tool(*)`, or a tool-name glob.
function removes(rule: string, tool: string): boolean {
  if (rule === tool || rule === `${tool}(*)`) return true;
  if (rule.includes("(") || !rule.includes("*")) return false;
  return new RegExp(`^${rule.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(tool);
}

const at = (value: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((inner, step) => (isObject(inner) ? inner[step] : undefined), value);

function acceptedLaunch([command, ...args]: string[]): boolean {
  if (command === undefined || args.at(-1) !== "serve") return false;
  try {
    managedLaunch({ command, args }, homedir());
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}

/**
 * What Claude Code would read on this machine for the workspace: the managed
 * files at their platform path (and managed-settings.d), the project's
 * `.claude/settings.json` and `.claude/settings.local.json`, and the user's
 * `settings.json`. Read-only. It sees files, not a running session. Of the
 * sources ranked above the managed files it reads the cached claude.ai
 * settings and sees only that an MDM profile is there, on macOS; not the
 * Windows registry.
 */
export async function claudeHarness(probe: HarnessProbe): Promise<HarnessReport> {
  const platform = probe.platform ?? process.platform;
  const managed = probe.managedDirectory ?? claudeManagedDirectory(platform);
  const user = probe.userDirectory ?? (process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"));
  const statOf = probe.stat ?? ((path: string) => stat(path));
  const writable = probe.writable ?? ((path: string) => access(path, constants.W_OK).then(() => true, () => false));
  let dropIns: string[] = [];
  try {
    // Merged after managed-settings.json, in name order, as Claude Code does.
    dropIns = (await readdir(join(managed, "managed-settings.d")))
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort()
      .map((name) => join(managed, "managed-settings.d", name));
  } catch {
    // None.
  }
  const mcp = join(managed, "managed-mcp.json");
  const candidates: Array<[HarnessFile["scope"], string]> = [
    ["managed", join(managed, "managed-settings.json")],
    ...dropIns.map((path): [HarnessFile["scope"], string] => ["managed", path]),
    ["managed", mcp],
    ["local", join(probe.workspace, ".claude", "settings.local.json")],
    ["project", join(probe.workspace, ".claude", "settings.json")],
    ["user", join(user, "settings.json")],
  ];
  const files: HarnessFile[] = [];
  const unreadable: string[] = [];
  const parsed = new Map<string, Record<string, unknown>>();
  for (const [scope, path] of candidates) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") unreadable.push(path);
      continue;
    }
    const file: HarnessFile = { scope, path, sha256: createHash("sha256").update(bytes).digest("hex") };
    if (scope === "managed" && platform !== "win32") {
      const { uid, mode } = await statOf(path);
      file.owner = uid;
      file.mode = (mode & 0o7777).toString(8).padStart(4, "0");
      file.writable = await writable(path);
    }
    files.push(file);
    try {
      // Strict JSON, as Claude Code reads them: a comment or a trailing comma
      // and the file's rules are not counted.
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!isObject(value)) throw new Error("not an object");
      parsed.set(path, value);
    } catch {
      unreadable.push(path);
    }
  }
  // Ranked above the managed files: the claude.ai settings Claude Code caches,
  // a policy once they hold a key other than the two that only steer the
  // ranking, and on macOS an MDM profile for its preferences domain, which is
  // not read here.
  const remotePath = join(user, "remote-settings.json");
  let remote: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(await readFile(remotePath, "utf8"));
    if (!isObject(value)) throw new Error("not an object");
    remote = value;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") unreadable.push(remotePath);
  }
  const policy = Object.keys(remote).some((key) => key !== "wslInheritsWindowsSettings" && key !== "managedSourcesBehavior");
  // Read from the highest-ranked source, so theirs decides: under "merge"
  // every admin source applies, the managed files included.
  const merge = remote.managedSourcesBehavior === "merge";
  const profiles: string[] = [];
  if (platform === "darwin") {
    const preferences = probe.managedPreferences ?? "/Library/Managed Preferences";
    let name: string | undefined;
    try {
      name = userInfo().username;
    } catch {
      // No account entry: only the machine-wide profile.
    }
    for (const folder of [preferences, ...(name === undefined ? [] : [join(preferences, name)])]) {
      const path = join(folder, "com.anthropic.claudecode.plist");
      if (await exists(path)) profiles.push(path);
    }
  }
  const aboveManaged = [...(policy && !merge ? [remotePath] : []), ...profiles];
  const settings = (scopes: Array<HarnessFile["scope"]>) =>
    files
      .filter((file) => scopes.includes(file.scope) && file.path !== mcp)
      .flatMap((file) => parsed.get(file.path) ?? []);
  // Each managed source Claude Code applies. By default the first one with a
  // policy, and none counts while that may be an unread MDM profile; under
  // "merge" the claude.ai policy and the managed files together.
  const inForce =
    policy && !merge ? [[remote]] : profiles.length > 0 && !merge ? [] : [...(policy ? [[remote]] : []), settings(["managed"])];
  const managedSettings = inForce.flat();
  // Within a source a later managed file's value replaces an earlier one's;
  // across merged sources the strictest value any of them sets applies.
  const locks = Object.fromEntries(
    Object.entries(CLAUDE_LOCKS).map(([key, value]) => [
      key,
      inForce.some((source) => source.map((each) => at(each, key)).filter((each) => each !== undefined).at(-1) === value),
    ]),
  );
  // With allowManagedPermissionRulesOnly, which an unread MDM profile may
  // set, Claude Code ignores every other file's rules.
  const sources =
    locks.allowManagedPermissionRulesOnly === true || profiles.length > 0
      ? managedSettings
      : [...managedSettings, ...settings(["local", "project", "user"])];
  const rules = sources.flatMap((each) => {
    const deny = at(each, "permissions.deny");
    return Array.isArray(deny) ? deny.filter((rule): rule is string => typeof rule === "string") : [];
  });
  const removed = CLAUDE_DENIED_TOOLS.filter((tool) => rules.some((rule) => removes(rule, tool)));
  const servers = parsed.get(mcp)?.mcpServers;
  const melra = isObject(servers) && Object.hasOwn(servers, "melra") ? (launchOf(servers.melra) ?? []) : undefined;
  const anyManaged = files.some((file) => file.scope === "managed");
  const admin = await (probe.admin ?? (() => inAdminGroup(platform)))();
  return {
    client: "claude-code",
    managedDirectory: managed,
    removed,
    present: CLAUDE_DENIED_TOOLS.filter((tool) => !removed.includes(tool)),
    ...(managedSettings.length === 0 ? {} : { locks }),
    ...(parsed.has(mcp) ? { managedServers: isObject(servers) ? Object.keys(servers) : [] } : {}),
    ...(melra === undefined
      ? {}
      : { managedMelra: { ...(melra[0] === undefined ? {} : { command: melra[0] }), accepted: acceptedLaunch(melra) } }),
    aboveManaged,
    ...(anyManaged && platform !== "win32" ? { managedDirectoryWritable: await writable(managed) } : {}),
    ...(admin === undefined ? {} : { admin }),
    files,
    unreadable,
  };
}

/**
 * The doctor line: what was observed, never a verdict on it. A `warn` at
 * worst, in both modes, as the isolation line is: removing the harness's
 * other path is the operator's to arrange.
 */
export function harnessCheck(report: HarnessReport, platform: NodeJS.Platform = process.platform): {
  name: string;
  status: "pass" | "warn";
  detail: string;
  next?: string;
} {
  const managed = report.files.filter((file) => file.scope === "managed");
  // Not root's, writable by its group or others, or by this user.
  const loose = managed.filter(
    (file) =>
      (file.owner !== undefined && file.owner !== 0) ||
      (Number.parseInt(file.mode ?? "0", 8) & 0o022) !== 0 ||
      file.writable === true,
  );
  const set = Object.entries(report.locks ?? {}).filter(([, on]) => on).map(([key]) => key);
  const missing = Object.entries(report.locks ?? {}).filter(([, on]) => !on).map(([key]) => key);
  const servers = report.managedServers;
  const melra = report.managedMelra;
  const parts = [
    report.present.length === 0
      ? `removed: ${report.removed.join(", ")}`
      : `present: ${report.present.join(", ")}${report.removed.length === 0 ? "" : `; removed: ${report.removed.join(", ")}`}`,
    ...report.aboveManaged.map((path) => `${path} present: by default Claude Code applies that policy instead of managed-settings.json`),
    ...(platform === "win32" ? ["HKLM policy not inspected"] : []),
    ...(managed.length === 0
      ? [`no managed settings in ${report.managedDirectory}`]
      : managed.map((file) =>
          file.owner === undefined
            ? `${file.path}: owner not inspected on Windows`
            : `${file.path}: owner uid ${file.owner}, mode ${file.mode}, ` +
              `${file.writable === true ? "writable" : "not writable"} by this user`,
        )),
    ...(report.managedDirectoryWritable === true ? [`${report.managedDirectory} writable by this user`] : []),
    ...(set.length === 0 ? [] : [`locks set: ${set.join(", ")}`]),
    ...(missing.length === 0 ? [] : [`locks missing: ${missing.join(", ")}`]),
    ...(servers === undefined ? [] : [`managed-mcp.json lists: ${servers.join(", ") || "no server"}`]),
    ...(melra === undefined
      ? []
      : [
          `managed-mcp.json runs melra with ${melra.command ?? "no command"}` +
            (melra.accepted ? "" : ", not as setup writes it: absolute paths outside the home folder, ending in serve"),
        ]),
    report.admin === undefined
      ? "admin groups not inspected"
      : report.admin
        ? "this user is in an admin group, which can change the managed files"
        : "this user is in no admin, sudo or wheel group",
    // The first twelve digits; the report's `harness.files` has them all.
    ...report.files.map((file) => `sha256 ${file.path} ${file.sha256.slice(0, 12)}`),
    ...report.unreadable.map((path) => `unreadable: ${path}`),
  ];
  const next =
    report.aboveManaged.length > 0 && (report.present.length > 0 || missing.length > 0)
      ? "add the deny list and locks to the policy Claude Code applies instead of managed-settings.json"
      : // Local rules help only when no admin source tells Claude Code to ignore them.
        report.present.length > 0 && managed.length === 0 && report.locks?.allowManagedPermissionRulesOnly !== true
        ? "run 'melra setup --client claude-code --exclusive --write' to remove them in this workspace"
        : loose.length > 0 ||
            report.managedDirectoryWritable === true ||
            missing.length > 0 ||
            report.present.length > 0 ||
            melra?.accepted === false
          ? "reinstall the managed files with the lines 'melra setup --client claude-code --exclusive --managed <dir>' prints"
          : report.admin === true && managed.length > 0
            ? "run the agent as a user outside the admin groups"
            : undefined;
  const gaps =
    next !== undefined ||
    report.unreadable.length > 0 ||
    report.aboveManaged.length > 0 ||
    (servers !== undefined && servers.join() !== "melra");
  return {
    name: "harness",
    status: gaps ? "warn" : "pass",
    detail: `claude-code: ${parts.join("; ")}`,
    ...(next === undefined ? {} : { next }),
  };
}
