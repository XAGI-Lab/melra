// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_DENIED_TOOLS,
  HERMES_DISABLED_TOOLSETS,
  OPENCLAW_DENIED_TOOLS,
  claudeHarness,
  claudeManagedFiles,
  harnessCheck,
  installLines,
  managedLaunch,
  nativeTools,
  nativeToolsCheck,
  nativeToolsOff,
} from "../src/harness.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "melra-harness-"));
  roots.push(root);
  return root;
}

async function put(path: string, value: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, text);
  return text;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// Root-owned, mode 0644, and not writable here, whoever really owns the
// temporary files: what an installed managed file looks like.
const installed = {
  stat: async () => ({ uid: 0, mode: 0o100644 }),
  writable: async () => false,
  admin: async () => false,
};

describe("Claude Code managed files", () => {
  it("stages exactly the deny list, its locks, and melra as the only server", () => {
    const files = claudeManagedFiles({
      command: "/usr/local/bin/node",
      args: ["/usr/local/lib/node_modules/@melra/cli/dist/bin.js", "serve"],
      env: { MELRA_WORKSPACE: "/srv/project", MELRA_HOME: "/srv/melra", MELRA_HARNESS_TOOLS: "1" },
    });
    expect(Object.keys(files)).toEqual(["managed-settings.json", "managed-mcp.json"]);
    expect(files["managed-settings.json"]).toBe(`{
  "permissions": {
    "deny": [
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
      "ShareOnboardingGuide"
    ],
    "disableBypassPermissionsMode": "disable"
  },
  "allowManagedPermissionRulesOnly": true,
  "allowManagedHooksOnly": true
}
`);
    expect(files["managed-mcp.json"]).toBe(`{
  "mcpServers": {
    "melra": {
      "command": "/usr/local/bin/node",
      "args": [
        "/usr/local/lib/node_modules/@melra/cli/dist/bin.js",
        "serve"
      ],
      "env": {
        "MELRA_WORKSPACE": "/srv/project",
        "MELRA_HOME": "/srv/melra",
        "MELRA_HARNESS_TOOLS": "1"
      }
    }
  }
}
`);
  });

  it("names only a melra outside the home folder, by absolute path", async () => {
    const home = await scratch();
    const outside = await scratch();
    const node = join(outside, "node");
    const bin = join(outside, "bin.js");
    expect(managedLaunch({ command: node, args: [bin, "serve"] }, home)).toEqual({ command: node, args: [bin, "serve"] });
    expect(() => managedLaunch({ command: "npx", args: ["-y", "@melra/cli@1.0.0", "serve"] }, home)).toThrow(
      /managed_launch_refused: this melra runs through npx/,
    );
    expect(() => managedLaunch({ command: "melra", args: ["serve"] }, home)).toThrow(
      /managed_launch_refused: melra is not an absolute path/,
    );
    expect(() => managedLaunch({ command: node, args: [join(home, ".nvm", "bin.js"), "serve"] }, home)).toThrow(
      /managed_launch_refused: .*bin\.js is inside/,
    );
    expect(() => managedLaunch({ command: join(home, "node"), args: ["serve"] }, home)).toThrow(/is inside/);
  });

  // macOS matches names regardless of case, so the home folder in other
  // letters is still the home folder.
  it.runIf(process.platform === "darwin")("refuses the home folder spelled in another case", () => {
    expect(() => managedLaunch({ command: "/opt/melra/node", args: [homedir().toLowerCase(), "serve"] }, homedir())).toThrow(
      /managed_launch_refused/,
    );
  });

  it("prints install lines for an administrator, quoted, and the Windows destination as text", () => {
    const staged = { "managed-settings.json": "/tmp/stage dir/managed-settings.json", "managed-mcp.json": "/tmp/s/managed-mcp.json" };
    expect(installLines(staged, "darwin")).toEqual([
      "sudo install -d -o root -m 0755 '/Library/Application Support/ClaudeCode'",
      "sudo install -o root -m 0644 '/tmp/stage dir/managed-settings.json' '/Library/Application Support/ClaudeCode/managed-settings.json'",
      "sudo install -o root -m 0644 /tmp/s/managed-mcp.json '/Library/Application Support/ClaudeCode/managed-mcp.json'",
    ]);
    expect(installLines(staged, "linux")).toEqual([
      "sudo install -d -o root -m 0755 /etc/claude-code",
      "sudo install -o root -m 0644 '/tmp/stage dir/managed-settings.json' /etc/claude-code/managed-settings.json",
      "sudo install -o root -m 0644 /tmp/s/managed-mcp.json /etc/claude-code/managed-mcp.json",
    ]);
    expect(installLines(staged, "win32")).toEqual([
      "as an administrator, copy /tmp/stage dir/managed-settings.json to C:\\Program Files\\ClaudeCode\\managed-settings.json",
      "as an administrator, copy /tmp/s/managed-mcp.json to C:\\Program Files\\ClaudeCode\\managed-mcp.json",
    ]);
  });
});

describe("doctor harness check", () => {
  it("reports an installed managed tier: every tool removed, root-owned, locks set, hashes", async () => {
    const root = await scratch();
    const managed = join(root, "managed");
    const files = claudeManagedFiles({ command: "/usr/bin/node", args: ["/usr/lib/melra/bin.js", "serve"], env: {} });
    const settings = await put(join(managed, "managed-settings.json"), files["managed-settings.json"]);
    await put(join(managed, "managed-mcp.json"), files["managed-mcp.json"]);
    const report = await claudeHarness({
      workspace: join(root, "ws"),
      userDirectory: join(root, "user"),
      managedDirectory: managed,
      platform: "linux",
      ...installed,
    });
    expect(report.present).toEqual([]);
    expect(report.removed).toEqual(CLAUDE_DENIED_TOOLS);
    expect(report.locks).toEqual({
      allowManagedPermissionRulesOnly: true,
      allowManagedHooksOnly: true,
      "permissions.disableBypassPermissionsMode": true,
    });
    expect(report.managedServers).toEqual(["melra"]);
    expect(report.managedMelra).toEqual({ command: "/usr/bin/node", accepted: true });
    expect(report.aboveManaged).toEqual([]);
    expect(report.files[0]).toEqual({
      scope: "managed",
      path: join(managed, "managed-settings.json"),
      sha256: sha256(settings),
      owner: 0,
      mode: "0644",
      writable: false,
    });
    const check = harnessCheck(report);
    expect(check.status).toBe("pass");
    expect(check.detail).toContain(`removed: ${CLAUDE_DENIED_TOOLS.join(", ")}`);
    expect(check.detail).toContain(`${join(managed, "managed-settings.json")}: owner uid 0, mode 0644, not writable by this user`);
    expect(check.detail).toContain("locks set: allowManagedPermissionRulesOnly, allowManagedHooksOnly, permissions.disableBypassPermissionsMode");
    expect(check.detail).toContain("managed-mcp.json lists: melra; managed-mcp.json runs melra with /usr/bin/node;");
    expect(check.detail).toContain(`sha256 ${join(managed, "managed-settings.json")} ${sha256(settings).slice(0, 12)}`);
    expect(check.detail).not.toMatch(/\bsafe\b/i);
  });

  it("warns, in words, on a managed file the user owns, a missing lock and tools still present", async () => {
    const root = await scratch();
    const managed = join(root, "managed");
    const workspace = join(root, "ws");
    await put(join(managed, "managed-settings.json"), {
      permissions: { deny: ["Bash(*)", "Web*"] },
      allowManagedPermissionRulesOnly: true,
    });
    // Ignored: only managed permission rules apply once that lock is set.
    await put(join(workspace, ".claude", "settings.local.json"), { permissions: { deny: CLAUDE_DENIED_TOOLS } });
    const report = await claudeHarness({
      workspace,
      userDirectory: join(root, "user"),
      managedDirectory: managed,
      platform: "linux",
      stat: async () => ({ uid: 501, mode: 0o100664 }),
      writable: async () => true,
      admin: async () => true,
    });
    expect(report.removed).toEqual(["Bash", "WebFetch", "WebSearch"]);
    expect(report.present).toContain("Edit");
    expect(report.locks).toEqual({
      allowManagedPermissionRulesOnly: true,
      allowManagedHooksOnly: false,
      "permissions.disableBypassPermissionsMode": false,
    });
    const check = harnessCheck(report);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("present: PowerShell, Monitor, Edit");
    expect(check.detail).toContain("owner uid 501, mode 0664, writable by this user");
    expect(check.detail).toContain("locks missing: allowManagedHooksOnly, permissions.disableBypassPermissionsMode");
    expect(check.detail).toContain(`${managed} writable by this user`);
    expect(check.detail).toContain("this user is in an admin group, which can change the managed files");
    expect(check.next).toMatch(/--managed <dir>/);
  });

  it("counts every file's deny rules without managed settings, and says what is left", async () => {
    const root = await scratch();
    const workspace = join(root, "ws");
    const user = join(root, "user");
    await put(join(workspace, ".claude", "settings.local.json"), { permissions: { deny: CLAUDE_DENIED_TOOLS.slice(0, 8) } });
    await put(join(user, "settings.json"), { permissions: { deny: CLAUDE_DENIED_TOOLS.slice(8) } });
    const all = await claudeHarness({ workspace, userDirectory: user, managedDirectory: join(root, "none"), platform: "linux", ...installed });
    expect(all.present).toEqual([]);
    expect(all.locks).toBeUndefined();
    expect(harnessCheck(all)).toMatchObject({ status: "pass" });
    expect(harnessCheck(all).detail).toContain(`no managed settings in ${join(root, "none")}`);

    await put(join(user, "settings.json"), "{ not json");
    const some = await claudeHarness({ workspace, userDirectory: user, managedDirectory: join(root, "none"), platform: "linux", ...installed });
    expect(some.present).toEqual(CLAUDE_DENIED_TOOLS.slice(8));
    expect(some.unreadable).toEqual([join(user, "settings.json")]);
    const check = harnessCheck(some);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(`unreadable: ${join(user, "settings.json")}`);
    expect(check.next).toBe("run 'melra setup --client claude-code --exclusive --write' to remove them in this workspace");
  });

  it("does not inspect ownership or admin groups on Windows", async () => {
    const root = await scratch();
    const managed = join(root, "managed");
    await put(join(managed, "managed-settings.json"), { permissions: { deny: ["*"] } });
    const report = await claudeHarness({
      workspace: join(root, "ws"),
      userDirectory: join(root, "user"),
      managedDirectory: managed,
      platform: "win32",
      admin: async () => undefined,
    });
    expect(report.present).toEqual([]);
    expect(report.files[0]).not.toHaveProperty("owner");
    const check = harnessCheck(report, "win32");
    expect(check.detail).toContain("owner not inspected on Windows");
    expect(check.detail).toContain("admin groups not inspected");
    expect(check.detail).toContain("HKLM policy not inspected");
  });

  it("counts the claude.ai policy's rules and locks in place of the managed files'", async () => {
    const root = await scratch();
    const managed = join(root, "managed");
    const user = join(root, "user");
    const files = claudeManagedFiles({ command: "/usr/bin/node", args: ["/usr/lib/melra/bin.js", "serve"], env: {} });
    await put(join(managed, "managed-settings.json"), files["managed-settings.json"]);
    await put(join(managed, "managed-mcp.json"), files["managed-mcp.json"]);
    const probe = { workspace: join(root, "ws"), userDirectory: user, managedDirectory: managed, platform: "linux" as const, ...installed };
    // Only the keys that steer the ranking: not a policy, so the file applies.
    await put(join(user, "remote-settings.json"), { managedSourcesBehavior: "first-wins" });
    expect(harnessCheck(await claudeHarness(probe)).status).toBe("pass");

    await put(join(user, "remote-settings.json"), { cleanupPeriodDays: 30 });
    const report = await claudeHarness(probe);
    expect(report.aboveManaged).toEqual([join(user, "remote-settings.json")]);
    expect(report.removed).toEqual([]);
    expect(report.locks).toEqual({
      allowManagedPermissionRulesOnly: false,
      allowManagedHooksOnly: false,
      "permissions.disableBypassPermissionsMode": false,
    });
    const check = harnessCheck(report);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(
      `${join(user, "remote-settings.json")} present: by default Claude Code applies that policy instead of managed-settings.json`,
    );
    expect(check.next).toMatch(/policy Claude Code applies instead/);

    await put(join(user, "remote-settings.json"), JSON.parse(files["managed-settings.json"] ?? ""));
    const moved = await claudeHarness(probe);
    expect(moved.removed).toEqual(CLAUDE_DENIED_TOOLS);
    expect(Object.values(moved.locks ?? {})).toEqual([true, true, true]);
    expect(harnessCheck(moved).next).toBeUndefined();
  });

  it("counts no local, project or user rule once the claude.ai policy allows managed rules only", async () => {
    const root = await scratch();
    const workspace = join(root, "ws");
    const user = join(root, "user");
    await put(join(workspace, ".claude", "settings.local.json"), { permissions: { deny: CLAUDE_DENIED_TOOLS } });
    await put(join(user, "remote-settings.json"), { allowManagedPermissionRulesOnly: true });
    const report = await claudeHarness({ workspace, userDirectory: user, managedDirectory: join(root, "none"), platform: "linux", ...installed });
    expect(report.removed).toEqual([]);
    expect(report.present).toEqual(CLAUDE_DENIED_TOOLS);
    const check = harnessCheck(report);
    expect(check.status).toBe("warn");
    // Not the workspace file, which already has them and does not count.
    expect(check.next).toMatch(/policy Claude Code applies instead/);

    // Merged rather than replacing: still no advice to write the workspace file.
    await put(join(user, "remote-settings.json"), { managedSourcesBehavior: "merge", allowManagedPermissionRulesOnly: true });
    const merged = await claudeHarness({ workspace, userDirectory: user, managedDirectory: join(root, "none"), platform: "linux", ...installed });
    expect(merged.removed).toEqual([]);
    expect(harnessCheck(merged).next).not.toMatch(/--write/);
  });

  it("counts no rule from any file while an MDM profile it cannot read may apply", async () => {
    const root = await scratch();
    const workspace = join(root, "ws");
    const preferences = join(root, "Managed Preferences");
    await put(join(workspace, ".claude", "settings.local.json"), { permissions: { deny: CLAUDE_DENIED_TOOLS } });
    await put(join(preferences, "com.anthropic.claudecode.plist"), "<plist/>");
    const report = await claudeHarness({
      workspace,
      userDirectory: join(root, "user"),
      managedDirectory: join(root, "none"),
      managedPreferences: preferences,
      platform: "darwin",
      ...installed,
    });
    expect(report.aboveManaged).toEqual([join(preferences, "com.anthropic.claudecode.plist")]);
    expect(report.present).toEqual(CLAUDE_DENIED_TOOLS);
    expect(harnessCheck(report).status).toBe("warn");

    // The managed files do not count either: the profile replaces them.
    const managed = join(root, "managed");
    const files = claudeManagedFiles({ command: "/usr/bin/node", args: ["/usr/lib/melra/bin.js", "serve"], env: {} });
    await put(join(managed, "managed-settings.json"), files["managed-settings.json"]);
    await put(join(managed, "managed-mcp.json"), files["managed-mcp.json"]);
    const withManaged = await claudeHarness({
      workspace,
      userDirectory: join(root, "user"),
      managedDirectory: managed,
      managedPreferences: preferences,
      platform: "darwin",
      ...installed,
    });
    expect(withManaged.removed).toEqual([]);
    expect(withManaged.present).toEqual(CLAUDE_DENIED_TOOLS);
  });

  it("adds a claude.ai policy that merges to the managed files: lists unioned, the strictest lock", async () => {
    const root = await scratch();
    const managed = join(root, "managed");
    const user = join(root, "user");
    const files = claudeManagedFiles({ command: "/usr/bin/node", args: ["/usr/lib/melra/bin.js", "serve"], env: {} });
    await put(join(managed, "managed-settings.json"), files["managed-settings.json"]);
    await put(join(managed, "managed-mcp.json"), files["managed-mcp.json"]);
    const probe = { workspace: join(root, "ws"), userDirectory: user, managedDirectory: managed, platform: "linux" as const, ...installed };
    await put(join(user, "remote-settings.json"), { managedSourcesBehavior: "merge", cleanupPeriodDays: 30 });
    const report = await claudeHarness(probe);
    expect(report.aboveManaged).toEqual([]);
    expect(report.removed).toEqual(CLAUDE_DENIED_TOOLS);
    expect(harnessCheck(report).status).toBe("pass");

    await put(join(managed, "managed-settings.json"), { permissions: { deny: CLAUDE_DENIED_TOOLS.slice(0, 8) }, allowManagedHooksOnly: false });
    await put(join(user, "remote-settings.json"), {
      managedSourcesBehavior: "merge",
      permissions: { deny: CLAUDE_DENIED_TOOLS.slice(8), disableBypassPermissionsMode: "disable" },
      allowManagedPermissionRulesOnly: true,
      allowManagedHooksOnly: true,
    });
    const merged = await claudeHarness(probe);
    expect(merged.removed).toEqual(CLAUDE_DENIED_TOOLS);
    expect(Object.values(merged.locks ?? {})).toEqual([true, true, true]);
  });

  it("reads settings as strict JSON, as Claude Code does, and counts no rule in a file with comments", async () => {
    const root = await scratch();
    const workspace = join(root, "ws");
    const local = join(workspace, ".claude", "settings.local.json");
    await put(local, `{\n  // note\n  "permissions": { "deny": ${JSON.stringify(CLAUDE_DENIED_TOOLS)} },\n}\n`);
    const report = await claudeHarness({ workspace, userDirectory: join(root, "user"), managedDirectory: join(root, "none"), platform: "linux", ...installed });
    expect(report.present).toEqual(CLAUDE_DENIED_TOOLS);
    expect(report.unreadable).toEqual([local]);
    expect(harnessCheck(report).status).toBe("warn");
  });

  it("warns when managed-mcp.json's melra is not a launch setup writes", async () => {
    const root = await scratch();
    const managed = join(root, "managed");
    const files = claudeManagedFiles({ command: "/usr/bin/node", args: ["/usr/lib/melra/bin.js", "serve"], env: {} });
    await put(join(managed, "managed-settings.json"), files["managed-settings.json"]);
    await put(join(managed, "managed-mcp.json"), { mcpServers: { melra: { command: "/bin/sh", args: ["-c", "true"] } } });
    const report = await claudeHarness({
      workspace: join(root, "ws"),
      userDirectory: join(root, "user"),
      managedDirectory: managed,
      platform: "linux",
      ...installed,
    });
    expect(report.managedMelra).toEqual({ command: "/bin/sh", accepted: false });
    const check = harnessCheck(report);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("managed-mcp.json runs melra with /bin/sh, not as setup writes it");
    // The executable only: arguments are where a user would put a token.
    expect(check.detail).not.toMatch(/\/bin\/sh -c/);
    expect(check.next).toMatch(/--managed <dir>/);
  });
});

describe("OpenClaw's and Hermes's own tools", () => {
  it("takes away the tools that send or publish outside or start a session, and Hermes's MCP and plugin installers", () => {
    expect(OPENCLAW_DENIED_TOOLS).toEqual(
      expect.arrayContaining([
        "sessions_create",
        "sessions_spawn",
        "sessions_send",
        "conversations_send",
        "conversations_turn",
        "github_publish",
      ]),
    );
    expect(HERMES_DISABLED_TOOLSETS).toEqual(expect.arrayContaining(["connections", "catalog"]));
  });

  it("reports OpenClaw's exec as still enabled until tools.deny removes it, by any name OpenClaw takes", async () => {
    const path = join(await scratch(), "openclaw.json");
    await put(path, { tools: { profile: "coding", deny: ["browser"] } });
    const before = await nativeTools("openclaw", path);
    expect(before).toMatchObject({ key: "tools.deny", shell: "enabled", removed: [], present: OPENCLAW_DENIED_TOOLS });
    const warned = nativeToolsCheck(before);
    expect(warned.status).toBe("warn");
    expect(warned.detail).toMatch(/^openclaw: native exec still enabled; present: group:runtime, write/);
    expect(warned.next).toBe("run 'melra setup --client openclaw --exclusive --write' to turn them off in tools.deny");
    // Its alias, any letter case and a pattern over tool names count, as
    // OpenClaw counts them; a pattern over group names or the alias does not.
    for (const [deny, shell] of [
      [["bash"], "removed"],
      [["EXEC"], "removed"],
      [["Group:Runtime"], "removed"],
      [["ex*"], "removed"],
      [["*"], "removed"],
      [["group:*", "b*"], "enabled"],
      [["ba*"], "enabled"],
    ] as const) {
      await put(path, { tools: { deny } });
      const report = await nativeTools("openclaw", path);
      expect(report.shell, deny.join()).toBe(shell);
      if (shell === "enabled") expect(nativeToolsCheck(report)).toMatchObject({ status: "warn", detail: expect.stringContaining("native exec still enabled") });
    }
    // What setup writes, beside the entry: everything removed, and the file's hash.
    const text = await put(path, '{\n  // mine\n  "tools": { "deny": ["browser"] },\n}\n');
    await put(path, nativeToolsOff("openclaw", path, text));
    const after = await nativeTools("openclaw", path);
    expect(after).toMatchObject({ shell: "removed", removed: OPENCLAW_DENIED_TOOLS, present: [] });
    const passed = nativeToolsCheck(after);
    expect(passed.status).toBe("pass");
    expect(passed.next).toBeUndefined();
    expect(passed.detail).toContain(`sha256 ${path} ${after.sha256?.slice(0, 12)}`);
  });

  it("reports Hermes's terminal by agent.disabled_toolsets, counting names, not composite toolsets", async () => {
    const path = join(await scratch(), "config.yaml");
    // `debugging` holds the terminal tools, but doctor counts only what is named.
    const text = await put(path, "agent:\n  disabled_toolsets:\n  - debugging\n  - web\n");
    const before = await nativeTools("hermes", path);
    expect(before).toMatchObject({ key: "agent.disabled_toolsets", shell: "enabled", removed: ["web"] });
    expect(nativeToolsCheck(before).detail).toMatch(/^hermes: native terminal still enabled; present: terminal, code_execution, file/);
    await put(path, nativeToolsOff("hermes", path, text));
    const after = await nativeTools("hermes", path);
    expect(after).toMatchObject({ shell: "removed", removed: HERMES_DISABLED_TOOLSETS, present: [] });
    expect(nativeToolsCheck(after).status).toBe("pass");
  });

  it("warns, saying why, when the switch cannot be read", async () => {
    const path = join(await scratch(), "config.yaml");
    await put(path, "agent:\n  disabled_toolsets: terminal\n");
    const report = await nativeTools("hermes", path);
    expect(report.shell).toBeUndefined();
    const check = nativeToolsCheck(report);
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/could not read agent\.disabled_toolsets in .*is not a list of names/);
    expect((await nativeTools("openclaw", join(path, "..", "missing.json"))).unreadable).toBe("ENOENT");
  });
});
