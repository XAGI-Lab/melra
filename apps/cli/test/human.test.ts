// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { detectClients, type ClientChoice } from "../src/client-status.js";
import {
  broadWorkspaceWarning,
  confirmBroadWorkspace,
  nextStep,
  prompter,
  renderConformance,
  renderDoctor,
  renderInit,
  renderManaged,
  setupWizard,
  type DoctorReport,
} from "../src/human.js";
import { isHuman, mark, paint, table } from "../src/output.js";

const execute = promisify(execFile);
const entry = resolve(import.meta.dirname, "../dist/bin.js");
const roots: string[] = [];
const savedEnv = { ...process.env };

afterEach(async () => {
  // Restored in place: replacing `process.env` with a plain object would stop
  // later changes reaching the real environment that `os.homedir()` reads.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CHOICES: ClientChoice[] = [
  { client: "claude-code", label: "Claude Code", path: "/w/.mcp.json" },
  { client: "cursor", label: "Cursor", path: "/h/.cursor/mcp.json", detected: "config file found" },
];

// Feeds the answers in one go, as a paste would: the wizard must not drop lines
// that arrive before it asks for them.
async function wizard(answers: string[], end = true) {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => (printed += String(chunk)));
  input.write(answers.map((answer) => `${answer}\n`).join(""));
  if (end) input.end();
  const reader = prompter({ input, output });
  const result = await setupWizard(reader, CHOICES).finally(() => reader.close());
  return { result, printed };
}

describe("setup wizard", () => {
  it("lists detected clients first and writes the chosen one by default", async () => {
    const { result, printed } = await wizard(["", ""]);
    expect(result).toEqual({ client: "cursor", write: true });
    expect(printed).toMatch(/1\)\s+Cursor\s+detected: config file found/);
    expect(printed).toMatch(/3\)\s+generic \(just print the config\)/);
    expect(printed).toContain("Write it into /h/.cursor/mcp.json? [Y/n]");
  });

  it("prints instead of writing when the write is declined", async () => {
    expect((await wizard(["2", "n"])).result).toEqual({ client: "claude-code", write: false });
    expect((await wizard(["cursor", "no"])).result).toEqual({ client: "cursor", write: false });
  });

  it("asks again after an answer it cannot use", async () => {
    const { result, printed } = await wizard(["9", "zzz", "1", "maybe", "y"]);
    expect(result).toEqual({ client: "cursor", write: true });
    expect(printed.match(/Enter a number from 1 to 3\./g)).toHaveLength(2);
    expect(printed).toContain("Answer y or n.");
  });

  it("does not ask about writing for generic", async () => {
    expect((await wizard(["3"])).result).toEqual({ client: "generic", write: false });
  });

  it("aborts with no answer when input ends, at either question", async () => {
    expect((await wizard([])).result).toBeUndefined();
    expect((await wizard(["1"])).result).toBeUndefined();
  });
});

describe("broad workspace question", () => {
  const ask = async (answer: string | undefined) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.on("data", (chunk) => (printed += String(chunk)));
    input.end(answer === undefined ? "" : `${answer}\n`);
    const reader = prompter({ input, output });
    const warning = broadWorkspaceWarning("/h", "home", "set MELRA_WORKSPACE to your project directory");
    return { agreed: await confirmBroadWorkspace(reader, "/h", warning).finally(() => reader.close()), printed };
  };

  it("says why, and goes ahead only on a yes", async () => {
    const { agreed, printed } = await ask("y");
    expect(agreed).toBe(true);
    expect(printed).toContain(
      "/h is your home directory, and the agent could read every file under it. Set MELRA_WORKSPACE to your project directory",
    );
    expect(printed).toContain("Use /h as the workspace anyway? [y/N]");
    expect((await ask("YES")).agreed).toBe(true);
    // No is the default, and so is anything else, or no answer at all.
    for (const answer of ["", "n", "sure", undefined]) expect((await ask(answer)).agreed).toBe(false);
  });

  it("keeps the answers typed ahead of the wizard that follows it", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    // Typed, or pasted, before the first prompt: yes, Claude Code, don't write.
    input.write("y\n2\nn\n");
    const reader = prompter({ input, output });
    try {
      expect(await confirmBroadWorkspace(reader, "/h", broadWorkspaceWarning("/h", "home", "x"))).toBe(true);
      expect(await setupWizard(reader, CHOICES)).toEqual({ client: "claude-code", write: false });
    } finally {
      reader.close();
    }
  });
});

describe("client detection", () => {
  it("finds a client by its file, its folder, or its executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-detect-"));
    roots.push(root);
    await mkdir(join(root, ".cursor"), { recursive: true });
    await writeFile(join(root, ".cursor", "mcp.json"), "{}");
    await mkdir(join(root, ".gemini"));
    const bin = join(root, "bin");
    await mkdir(bin);
    const zed = join(bin, process.platform === "win32" ? "zed.cmd" : "zed");
    await writeFile(zed, "", { mode: 0o755 });
    Object.assign(process.env, {
      HOME: root,
      USERPROFILE: root,
      APPDATA: join(root, "AppData"),
      XDG_CONFIG_HOME: join(root, ".config"),
      CODEX_HOME: join(root, ".codex"),
      PATH: bin,
      Path: bin,
    });
    const detected = Object.fromEntries(
      detectClients(join(root, "ws")).map(({ client, detected: why }) => [client, why]),
    );
    expect(detected.cursor).toBe("config file found");
    expect(detected.gemini).toBe("config folder found");
    expect(detected.zed).toBe("'zed' on PATH");
    // The workspace itself always exists; it says nothing about Claude Code.
    expect(detected["claude-code"]).toBeUndefined();
    expect(detected.generic).toBeUndefined();
  });
});

const report = (overrides: Partial<DoctorReport> = {}): DoctorReport => ({
  product: "MELRA",
  version: "0.0.0",
  ready: true,
  unhinged: false,
  mode: "developer",
  checks: [
    { name: "node", status: "pass", detail: "v22" },
    { name: "browser", status: "warn", detail: "not found" },
    { name: "clients", status: "warn", detail: "" },
  ],
  clients: [
    { client: "zed", path: "/z", state: "not configured", problems: [] },
    {
      client: "cursor",
      path: "/c",
      state: "configured",
      command: "npx",
      pin: "0.1.0",
      problems: ["pinned to @melra/cli@0.1.0, this is 0.0.0; fix: melra setup --client cursor --write"],
    },
  ],
  ...overrides,
});

describe("human doctor report", () => {
  it("puts each client on its own line and names one next command", () => {
    const text = renderDoctor(report());
    expect(text).toMatch(/\n {6}\S+\s+cursor\s+configured\s+pinned to @melra\/cli@0\.1\.0/);
    expect(text).toMatch(/\n {6}\S+\s+zed\s+not configured\n/);
    expect(text).toContain("Ready, with 2 warnings");
    expect(text.trimEnd().split("\n").at(-1)).toBe("Next: melra setup --client cursor --write");
    expect(text).not.toContain("\u001b[");
  });

  it("puts the client lines right under the clients row, wherever it is", () => {
    const text = renderDoctor(
      report({
        checks: [
          { name: "clients", status: "warn", detail: "" },
          { name: "harness", status: "warn", detail: "claude-code: present: Bash" },
        ],
        clients: [{ client: "claude-code", path: "/w/.mcp.json", state: "configured", command: "melra", problems: [] }],
      }),
    );
    const client = text.search(/\n {6}\S+\s+claude-code\s+configured/);
    expect(client).toBeGreaterThan(text.indexOf("clients"));
    expect(client).toBeLessThan(text.indexOf("harness"));
  });

  it("puts a failure ahead of every warning and says Ready only when clean", () => {
    const failing = report({
      checks: [{ name: "node", status: "fail", detail: "v20" }, ...report().checks],
    });
    expect(nextStep(failing)).toBe("install Node.js 22 or newer");
    expect(renderDoctor(failing)).toContain("Not ready: 3 problems");
    const clean = report({ checks: [{ name: "node", status: "pass", detail: "v22" }], clients: [] });
    expect(nextStep(clean)).toBeUndefined();
    expect(renderDoctor(clean).trimEnd().endsWith("Ready")).toBe(true);
  });

  it("gives the data-location advice doctor chose for the layout", () => {
    // Which advice is right depends on the layout, so doctor works it out (see
    // cli.test.ts) and the check carries it.
    const inside = report({
      checks: [{ name: "data-location", status: "warn", detail: "/w/.melra is inside the workspace", next: "move it" }],
      clients: [],
    });
    expect(nextStep(inside)).toBe("move it");
    const unresolved = report({
      checks: [{ name: "data-location", status: "fail", detail: "could not resolve the workspace: EISDIR" }],
      clients: [],
    });
    expect(nextStep(unresolved)).toBe("point MELRA_WORKSPACE at a directory you can read and write");
  });

  it("says to make an open data directory private, not to move it", () => {
    const open = report({
      checks: [{ name: "data-directory", status: "warn", detail: "/h/.melra can be read by other users; run chmod 700 on it" }],
      clients: [],
    });
    expect(nextStep(open)).toBe("make MELRA_HOME private with chmod 700 (see the data-directory line above)");
    const unwritable = report({ checks: [{ name: "data-directory", status: "fail", detail: "/h/.melra" }], clients: [] });
    expect(nextStep(unwritable)).toBe("point MELRA_HOME at a directory you can write");
  });

  it("says what clears an attached browser's warning, which no install does", () => {
    const browser = (detail: string) => report({ checks: [{ name: "browser", status: "warn", detail }], clients: [] });
    expect(nextStep(browser("attached over CDP to http://127.0.0.1:9/: any tab open there is a tab_switch away"))).toBe(
      "point MELRA_BROWSER_CDP_ENDPOINT at a browser you do not use yourself, or unset it",
    );
    expect(nextStep(browser("Chrome, Chromium, or Edge not found"))).toBe(
      "install Chrome, or set MELRA_BROWSER to a Chrome, Chromium, or Edge executable",
    );
  });

  it("does not send a missing command round the setup loop", () => {
    const missing = report({
      clients: [
        { client: "vscode", path: "/v", state: "configured", command: "melra", problems: ["'melra' not found on PATH"] },
      ],
    });
    expect(nextStep(missing)).toBe("put 'melra' on PATH: npm install -g @melra/cli@alpha");
  });
});

describe("output helpers", () => {
  it("is human only on a TTY without --json", () => {
    expect(isHuman([], { isTTY: true })).toBe(true);
    expect(isHuman(["--json"], { isTTY: true })).toBe(false);
    expect(isHuman([], {})).toBe(false);
  });

  it("aligns columns by visible width and honours NO_COLOR over FORCE_COLOR", () => {
    process.env.FORCE_COLOR = "1";
    delete process.env.NO_COLOR;
    expect(paint.ok("x")).toBe("\u001b[32mx\u001b[39m");
    expect(table([[paint.ok("a"), "1"], ["bbb", "2"]])).toBe(`${paint.ok("a")}    1\nbbb  2`);
    process.env.NO_COLOR = "1";
    expect(paint.ok("x")).toBe("x");
  });

  it("keeps piped output JSON, and accepts --json", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-json-"));
    roots.push(root);
    const env = { ...savedEnv, HOME: root, USERPROFILE: root, MELRA_HOME: join(root, ".melra"), MELRA_WORKSPACE: root };
    const version = await execute(process.execPath, [entry, "version", "--json"], { env });
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+\S*\n$/);
    const setup = await execute(process.execPath, [entry, "setup", "--json"], { cwd: root, env });
    expect(JSON.parse(setup.stdout).client).toBe("generic");
    // Non-interactive setup never wrote a client file.
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });
});

describe("conformance and setup output", () => {
  it("renders conformance as checks, a verdict, and what it does not prove", () => {
    process.env.NO_COLOR = "1";
    const check = (level: number, name: string, passed: boolean) => ({ level, name, passed, detail: "d" });
    const base = { suite: "melra-conformance/1", claimed: 3, mode: "developer", notProven: ["not this"] };
    const passed = renderConformance({
      ...base,
      level: 3,
      claim: "L3 verified effects",
      passed: 2,
      of: 2,
      checks: [check(1, "kernel-tools-present", true), check(3, "approved-mutation-verifies", true)],
    });
    expect(passed).toContain("L1  kernel-tools-present");
    expect(passed).toContain(`${mark("pass")} L3 verified effects (2 of 2 checks)`);
    expect(passed).toContain("Not proven by this suite:\n  - not this");
    const failed = renderConformance({
      ...base,
      level: 0,
      claim: "none",
      passed: 0,
      of: 1,
      checks: [check(1, "kernel-tools-present", false)],
    });
    // The legacy Windows console gets [ok]/[fail] instead of the symbols.
    expect(failed).toContain(`${mark("fail")} no level reached, short of the L3 claimed`);
  });

  it("tells Claude Code users to approve the project server, and says when nothing changed", () => {
    process.env.NO_COLOR = "1";
    const result = {
      initialized: true as const,
      client: "claude-code",
      workspace: "/w",
      policyPath: "/p",
      configPath: "/w/.mcp.json",
      written: true as const,
      config: {},
      note: "",
    };
    expect(renderInit(result)).toContain("approve the 'melra' server");
    // And the way to start it with no other tool that changes anything.
    expect(renderInit(result)).toContain("Or start it with 'melra launch claude-code'");
    // The directory the agent gets, written or printed.
    expect(renderInit(result)).toMatch(/^ {2}\S+\s+Workspace\s+\/w$/m);
    const { written: _written, ...printedOnly } = result;
    expect(renderInit(printedOnly)).toMatch(/Workspace\s+\/w$/m);
    expect(renderInit({ ...result, client: "codex" })).toContain("Next: Restart Codex");
    expect(renderInit({ ...result, unchanged: true })).toContain("already set up; nothing changed");
  });

  it("shows the Claude Code settings --exclusive writes, a dry run, and the managed install lines", () => {
    process.env.NO_COLOR = "1";
    const result = {
      initialized: true as const,
      client: "claude-code",
      workspace: "/w",
      policyPath: "/p",
      configPath: "/w/.mcp.json",
      config: {},
      settings: { path: "/w/.claude/settings.local.json", key: "permissions.deny", deny: ["Bash", "Edit"] },
      note: "",
    };
    expect(renderInit(result)).toContain("And this to /w/.claude/settings.local.json:");
    expect(renderInit(result)).toContain("melra setup --client claude-code --exclusive --write");
    const written = renderInit({ ...result, written: true, settings: { ...result.settings, backup: "/w/.claude/settings.local.json.bak" } });
    expect(written).toMatch(/Settings\s+\/w\/\.claude\/settings\.local\.json$/m);
    expect(written).toContain("previous file saved as /w/.claude/settings.local.json.bak");
    expect(written).toContain("denies Bash, Edit");
    // OpenClaw's and Hermes's switch, in the client's own file and format.
    const openclaw = { ...result, client: "openclaw", configPath: "/h/openclaw.json", settings: { path: "/h/openclaw.json", key: "tools.deny", deny: ["group:runtime"] } };
    expect(renderInit(openclaw)).toContain('"tools": {\n        "deny": [\n          "group:runtime"');
    const once = renderInit({ ...openclaw, written: true });
    expect(once.match(/\/h\/openclaw\.json/g)).toHaveLength(1);
    expect(once).toContain("tools.deny turns off group:runtime");
    const hermes = { ...result, client: "hermes", config: "mcp_servers:\n", configPath: "/h/config.yaml", settings: { path: "/h/config.yaml", key: "agent.disabled_toolsets", deny: ["terminal"] } };
    expect(renderInit(hermes)).toContain("    agent:\n      disabled_toolsets:\n        - terminal");
    const dry = renderInit({ ...result, dryRun: true, files: [{ path: "/w/.mcp.json", text: "{}\n" }] });
    expect(dry).toContain("Would write /w/.mcp.json:");
    expect(dry.trimEnd().endsWith("Nothing was written.")).toBe(true);
    const staged = {
      client: "claude-code",
      managed: "/s",
      written: true,
      files: [{ path: "/s/managed-settings.json", text: '{\n  "allowManagedHooksOnly": true\n}\n', sha256: "ab".repeat(32) }],
      install: ["sudo install -o root -m 0644 /s/managed-settings.json /etc/claude-code/managed-settings.json"],
    };
    const managed = renderManaged(staged);
    expect(managed).toMatch(/Staged\s+\/s\/managed-settings\.json/);
    expect(managed).toContain("Install them as an administrator; MELRA does not:");
    expect(managed).toContain("    sudo install -o root -m 0644 /s/managed-settings.json /etc/claude-code/managed-settings.json");
    expect(managed).toContain(`    ${"ab".repeat(32)}  /s/managed-settings.json`);
    expect(managed).not.toContain('"allowManagedHooksOnly"');
    // A dry run shows each file as it would be staged.
    const planned = renderManaged({ ...staged, written: false });
    expect(planned).toMatch(/Would stage\s+\/s\/managed-settings\.json/);
    expect(planned).toContain('Would write /s/managed-settings.json:\n\n    {\n      "allowManagedHooksOnly": true\n    }');
    expect(planned).toContain(`    ${"ab".repeat(32)}  /s/managed-settings.json`);
    expect(planned.trimEnd().endsWith("Nothing was written.")).toBe(true);
  });
});
