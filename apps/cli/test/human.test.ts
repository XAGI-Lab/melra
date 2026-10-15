// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

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
  nextStep,
  renderConformance,
  renderDoctor,
  renderInit,
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
  const result = await setupWizard({ input, output }, CHOICES);
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

  it("says to move a data directory out of the workspace, not to make it writable", () => {
    const inside = report({
      checks: [{ name: "data-location", status: "warn", detail: "/w/.melra is inside the workspace" }],
      clients: [],
    });
    expect(nextStep(inside)).toBe("move MELRA_HOME outside MELRA_WORKSPACE");
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
      policyPath: "/p",
      configPath: "/w/.mcp.json",
      written: true as const,
      config: {},
      note: "",
    };
    expect(renderInit(result)).toContain("approve the 'melra' server");
    expect(renderInit({ ...result, client: "codex" })).toContain("Next: Restart Codex");
    expect(renderInit({ ...result, unchanged: true })).toContain("already set up; nothing changed");
  });
});
