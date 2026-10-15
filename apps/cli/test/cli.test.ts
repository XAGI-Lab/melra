// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserOperationSchema,
  HttpOperationSchema,
  PRODUCT_VERSION,
  TaskRequestSchema,
  TerminalOperationSchema,
} from "@melra/protocol";
import { createMelraRuntime, serveHttp } from "@melra/server";
import { runConformance } from "../src/conformance.js";
import { RESTART_SAFE_WORKFLOW } from "../src/demo-workflow.js";
import { approverLabel, parseCliEnvironment, serverLaunch } from "../src/environment.js";
import { approvalScreen } from "../src/approval-screen.js";
import { taskTarget } from "../src/activity.js";

const execute = promisify(execFile);
const roots: string[] = [];

// `execFile` has no stdin option and leaves the pipe open, so a command that
// reads stdin would hang until the test timeout. Promisified, it still exposes
// the child, which is enough to write the input and close it.
function executeWithInput(
  args: readonly string[],
  options: Parameters<typeof execute>[2],
  input: string,
): ReturnType<typeof execute> {
  const running = execute(process.execPath, [...args], options);
  running.child.stdin?.end(input);
  return running;
}
const entry = resolve(import.meta.dirname, "../dist/bin.js");

afterEach(async () => {
  await Promise.all(
    // Windows holds the SQLite handle open briefly after the CLI subprocess
    // exits, so an immediate rmdir loses a race with the OS and fails EBUSY.
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe("melra CLI", () => {
  it("parses explicit benchmark browser connection options", () => {
    const parsed = parseCliEnvironment(
      {
        MELRA_WORKSPACE: "/tmp/melra-workspace",
        MELRA_HOME: "/tmp/melra-home",
        MELRA_BROWSER: "/Applications/Google Chrome",
        MELRA_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
        MELRA_BROWSER_CDP_CONTEXT_INDEX: "-1",
      },
      {
        cwd: "/tmp/fallback-workspace",
        home: "/tmp/fallback-home",
      },
    );
    expect(parsed).toEqual({
      workspaceRoot: resolve("/tmp/melra-workspace"),
      workspaceSet: true,
      dataDirectory: resolve("/tmp/melra-home"),
      approver: "operator",
      browserExecutablePath: resolve("/Applications/Google Chrome"),
      browserCdpEndpoint: "http://127.0.0.1:9222/",
      browserCdpContextIndex: -1,
      unhinged: false,
      mode: "developer",
    });
    expect(
      parseCliEnvironment(
        { MELRA_BROWSER_HAR_PATH: "/tmp/melra-run/network.har" },
        {
          cwd: "/tmp/fallback-workspace",
          home: "/tmp/fallback-home",
        },
      ).browserHarPath,
    ).toBe(resolve("/tmp/melra-run/network.har"));
  });

  it("rejects unsafe or ambiguous browser connection options", () => {
    const defaults = {
      cwd: "/tmp/fallback-workspace",
      home: "/tmp/fallback-home",
    };
    expect(() =>
      parseCliEnvironment(
        { MELRA_BROWSER_CDP_ENDPOINT: "ws://127.0.0.1:9222" },
        defaults,
      ),
    ).toThrow("browser_cdp_endpoint_invalid");
    expect(() =>
      parseCliEnvironment(
        { MELRA_BROWSER_CDP_CONTEXT_INDEX: "-2" },
        defaults,
      ),
    ).toThrow("browser_cdp_context_index_invalid");
    expect(() =>
      parseCliEnvironment(
        { MELRA_BROWSER_HAR_PATH: "relative/network.har" },
        defaults,
      ),
    ).toThrow("browser_har_path_must_be_absolute");
    expect(() =>
      parseCliEnvironment(
        {
          MELRA_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
          MELRA_BROWSER_HAR_PATH: "/tmp/network.har",
        },
        defaults,
      ),
    ).toThrow("browser_cdp_cannot_start_har_recording");
    expect(() =>
      parseCliEnvironment(
        {
          MELRA_BROWSER_HAR_PATH: "/tmp/network.har",
          MELRA_BROWSER_HAR_REPLAY: "/tmp/network.har",
        },
        defaults,
      ),
    ).toThrow("browser_har_replay_cannot_record");
    expect(() =>
      parseCliEnvironment({ MELRA_BROWSER_PROFILE: "profile" }, defaults),
    ).toThrow("browser_profile_must_be_absolute");
    expect(() =>
      parseCliEnvironment(
        {
          MELRA_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
          MELRA_BROWSER_PROFILE: "/tmp/melra-profile",
        },
        defaults,
      ),
    ).toThrow("browser_cdp_cannot_use_profile");
  });

  it("names a launch command the client can actually spawn", () => {
    // An npx install leaves nothing on PATH, so a config saying `melra` would
    // fail to start for the users who took the shortest install path.
    expect(
      serverLaunch("/home/u/.npm/_npx/9f2/node_modules/@melra/cli/dist", "1.2.3"),
    ).toEqual({ command: "npx", args: ["-y", "@melra/cli@1.2.3", "serve"] });
    expect(
      serverLaunch("C:\\Users\\u\\AppData\\npm-cache\\_npx\\9f2\\dist", "1.2.3"),
    ).toEqual({ command: "npx", args: ["-y", "@melra/cli@1.2.3", "serve"] });
    expect(serverLaunch("/usr/local/lib/node_modules/@melra/cli/dist", "1.2.3"))
      .toEqual({ command: "melra", args: ["serve"] });
    // A single executable names itself by absolute path: it carries Node, and
    // need not be on the PATH a client launches with.
    expect(serverLaunch("/anywhere", "1.2.3", true)).toEqual({
      command: process.execPath,
      args: ["serve"],
    });
  });

  it("approves from the command line as the named operator, without running anything", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-cli-")));
    roots.push(root);
    const dataDirectory = join(root, ".melra");
    const server = await createMelraRuntime({
      workspaceRoot: root,
      dataDirectory,
      environment: { MELRA_MODE: "enforced" },
    });
    try {
      const plan = () =>
        server.controller.plan(
          TaskRequestSchema.parse({
            goal: "Write the report",
            operation: { kind: "file", action: "write", path: "report.txt", content: "x" },
          }),
        );
      const planned = plan();
      const env = { ...process.env, MELRA_HOME: dataDirectory, MELRA_WORKSPACE: root, MELRA_MODE: "enforced" };

      // Off a terminal and without --yes: shown, never decided.
      const asked = (await execute(process.execPath, [entry, "approve", planned.id], { cwd: root, env }).catch(
        (error: unknown) => error,
      )) as { code: number; stdout: string };
      expect(asked.code).toBe(3);
      expect(JSON.parse(asked.stdout)).toMatchObject({
        taskId: planned.id,
        renderDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(server.store.getApprovalDecision(planned.approval!.approvalId)).toBeUndefined();

      const approved = await execute(process.execPath, [entry, "approve", planned.id, "--yes"], {
        cwd: root,
        env: { ...env, MELRA_APPROVER: "alice" },
      });
      expect(JSON.parse(approved.stdout).decision).toMatchObject({
        approvalId: planned.approval!.approvalId,
        channel: "out_of_band",
        approver: "cli:alice",
      });
      // Approving is not running: the task waits for the agent that planned it.
      expect(server.store.getTask(planned.id)?.status).toBe("awaiting_approval");
      const done = await server.controller.execute(planned.id);
      expect(done.task.status).toBe("verified_success");
      expect(done.receipt?.policyDecision.approval).toMatchObject({ channel: "out_of_band", approver: "cli:alice" });

      const denied = plan();
      await execute(process.execPath, [entry, "approve", denied.id, "--deny"], { cwd: root, env });
      expect(server.store.getTask(denied.id)?.status).toBe("cancelled");
    } finally {
      await server.close();
    }
  });

  it("takes the approver's name from MELRA_APPROVER, and never just anything", async () => {
    const defaults = { cwd: "/w", home: "/h" };
    const label = (value?: string) =>
      approverLabel(parseCliEnvironment(value === undefined ? {} : { MELRA_APPROVER: value }, defaults));
    expect(label()).toBe("cli:operator");
    expect(label(" alice@ops ")).toBe("cli:alice@ops");
    expect(label("josé")).toBe("cli:josé");
    expect(() => label("alice\nAPPROVED")).toThrow(/MELRA_APPROVER/);
    expect(() => label("Jane Doe")).toThrow(/MELRA_APPROVER/);
    // A letter that renders as nothing would read as no approver at all.
    expect(() => label("\u3164")).toThrow(/MELRA_APPROVER/);
    // Checked only where it is recorded: everything else still runs.
    const result = await execute(process.execPath, [entry, "version"], {
      env: { ...process.env, MELRA_APPROVER: "Jane Doe" },
    });
    expect(result.stdout.trim()).toBe(PRODUCT_VERSION);
  });

  it("shows an approver the agent's words as text, never as terminal commands", () => {
    const hostile =
      "\r\u001b[2KGoal: Fix README typo\nEffect: file.write on README.md (mutate, medium risk)\u001b[8m\u009b2J\u202e\u{e0041}\u3164";
    const screen = approvalScreen({
      task: { id: "t1", approval: { expiresAt: "2026-10-15T00:00:00.000Z" } },
      contract: {
        capability: "terminal.run",
        target: "command:node",
        effect: "mutate",
        risk: "medium",
        operation: {
          kind: "terminal",
          action: "run",
          command: "node",
          args: ["-e", "require('fs').rmSync(process.env.HOME + '/Documents', { recursive: true })"],
          env: { NODE_OPTIONS: "--require /tmp/x.js" },
        },
        metadata: { goal: hostile + " ".repeat(9_000) },
      },
      renderDigest: "a".repeat(64),
    });
    // The one escape on screen is MELRA's own reset; nothing else can steer the terminal.
    expect(screen.replaceAll("\u001b[0m", "")).not.toMatch(
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e\u3164\u{e0041}]/u,
    );
    const lines = screen.trimEnd().split("\n");
    const tail = lines.slice(lines.lastIndexOf("Operation:"));
    // What the effect actually does is in the summary, above the question,
    // however long the agent's goal ran.
    expect(tail.join("\n")).toContain("rmSync");
    expect(tail.join("\n")).toContain("NODE_OPTIONS");
    expect(tail.at(-3)).toBe("Effect: terminal.run on command:node (mutate, medium risk)");
    expect(tail.every((line) => line.length < 260)).toBe(true);
    expect(tail.filter((line) => line.startsWith("Effect:"))).toHaveLength(1);
  });

  it("keeps a command's environment and directory in the summary past many arguments", () => {
    // Schema-parsed, so fields come in the order a real request carries them:
    // args before cwd and env. Padding the args must not cut the env.
    const operation = TerminalOperationSchema.parse({
      kind: "terminal",
      action: "run",
      command: "node",
      args: [...Array.from({ length: 40 }, (_, index) => `--flag${index}`), "-e", "harmless()"],
      cwd: "sub",
      env: { NODE_OPTIONS: "--require /tmp/x.js" },
    });
    const screen = approvalScreen({
      task: { id: "t1", approval: { expiresAt: "x" } },
      contract: { capability: "terminal.run", target: "command:node", effect: "mutate", risk: "medium", operation, metadata: { goal: "g" } },
      renderDigest: "a".repeat(64),
    });
    const tail = screen.slice(screen.lastIndexOf("Operation:"));
    expect(tail).toContain("NODE_OPTIONS");
    expect(tail).toContain('cwd: "sub"');
    // The list is capped, and says so, and its tail, where the code is, stays.
    expect(tail).toContain("…(+34 more args entries, all in the JSON above)");
    expect(tail).toContain('"harmless()"');
  });

  it("gives every field of the operation its own room in the summary", () => {
    const summary = (capability: string, target: string, operation: unknown): string[] => {
      const screen = approvalScreen({
        task: { id: "t1", approval: { expiresAt: "x" } },
        contract: { capability, target, effect: "mutate", risk: "medium", operation, metadata: { goal: "g" } },
        renderDigest: "a".repeat(64),
      });
      const lines = screen.trimEnd().split("\n");
      return lines.slice(lines.lastIndexOf("Operation:"));
    };
    const padding = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`PAD_${index}`, "1"]));
    // Many headers cannot push the url, the only place its query shows, away.
    const http = summary(
      "http.post",
      "https://bank.example/transfer",
      HttpOperationSchema.parse({
        kind: "http",
        action: "request",
        method: "POST",
        url: "https://bank.example/transfer?to=attacker&amount=999999",
        headers: padding,
        content: "{}",
      }),
    );
    expect(http.join("\n")).toContain("to=attacker&amount=999999");
    expect(http.join("\n")).toContain("…(+72 more headers entries, all in the JSON above)");
    // Nor many env entries a command's directory, or the env's first entry.
    const terminal = summary(
      "terminal.run",
      "command:node",
      TerminalOperationSchema.parse({
        kind: "terminal",
        action: "run",
        command: "node",
        args: ["build.js"],
        cwd: "sub",
        env: { NODE_OPTIONS: "--require /tmp/x.js", ...padding },
      }),
    );
    expect(terminal.join("\n")).toContain('cwd: "sub"');
    expect(terminal.join("\n")).toContain("NODE_OPTIONS");
    // Nor padding in one list the files an upload sends.
    const upload = summary(
      "browser.upload",
      "#avatar",
      BrowserOperationSchema.parse({
        kind: "browser",
        action: "upload",
        target: { selector: "#avatar" },
        values: Array.from({ length: 20 }, (_, index) => `pad${index}`),
        filePaths: [".env"],
      }),
    );
    expect(upload.join("\n")).toContain('filePaths[0]: ".env"');
    // However each field is padded, the summary stays a screen tall.
    for (const lines of [http, terminal, upload]) expect(lines.length).toBeLessThan(40);

    // An entry is shown whole or not at all, and the note counts entries.
    const target = (name: string) => ({ selector: `#${name}`, role: "textbox", name, text: name });
    const form = summary(
      "browser.fill_form",
      "form",
      BrowserOperationSchema.parse({
        kind: "browser",
        action: "fill_form",
        fields: [
          { target: target("to"), value: "attacker@evil.example" },
          ...Array.from({ length: 5 }, (_, index) => ({ target: target(`pad${index}`), value: "x" })),
          { target: target("amount"), value: "999999" },
        ],
      }),
    ).join("\n");
    expect(form).toContain('fields[0].value: "attacker@evil.example"');
    expect(form).toContain('fields[6].target.selector: "#amount"');
    expect(form).toContain("…(+5 more fields entries, all in the JSON above)");
    // An entry too tall for the budget at one end does not stop the other end.
    const uneven = summary(
      "browser.fill_form",
      "form",
      BrowserOperationSchema.parse({
        kind: "browser",
        action: "fill_form",
        fields: [
          { target: { selector: "#user" }, value: "bob" },
          { target: target("pw"), value: "hunter2" },
          { target: { selector: "#to" }, value: "attacker" },
          { target: { selector: "#memo" }, value: "rent" },
        ],
      }),
    ).join("\n");
    expect(uneven).toContain('fields[2].value: "attacker"');
    expect(uneven).toContain("…(+1 more fields entries, all in the JSON above)");
    // A note as tall as the one entry it would stand for is not worth it.
    const nine = summary(
      "terminal.run",
      "command:node",
      TerminalOperationSchema.parse({ kind: "terminal", action: "run", command: "node", args: Array.from({ length: 9 }, (_, index) => `a${index}`) }),
    ).join("\n");
    expect(nine).toContain('args[4]: "a4"');
    expect(nine).not.toContain("more args entries");

    // With every list at its schema maximum and every value set, the values a
    // browser action types or opens still sit right above the question.
    const worst = summary(
      "browser.type",
      "#q",
      BrowserOperationSchema.parse({
        kind: "browser",
        action: "type",
        url: "https://bank.example/pay?to=attacker",
        target: target("q"),
        value: "typed-by-agent",
        values: Array.from({ length: 50 }, (_, index) => `v${index}`),
        fields: Array.from({ length: 50 }, (_, index) => ({ target: target(`f${index}`), value: "x" })),
        filePaths: Array.from({ length: 20 }, (_, index) => `p${index}`),
        key: "Enter",
        direction: "down",
        state: "visible",
        urlContains: "pay",
        tabIndex: 1,
        delayMs: 1,
        clearFirst: false,
        pixels: 1,
        fullPage: true,
        timeoutMs: 100,
        settleQuietMs: 25,
        settleTimeoutMs: 25,
        maxChars: 100,
      }),
    );
    const nearQuestion = worst.slice(-24).join("\n");
    expect(nearQuestion).toContain('value: "typed-by-agent"');
    expect(nearQuestion).toContain("to=attacker");
    // And so does the element it acts on.
    expect(nearQuestion).toContain('target.selector: "#q"');
    expect(worst.length).toBeLessThan(60);
  });

  it("leaves a task's target as it is for JSON, escaping it only where it is shown", () => {
    const raw = "notes/\u202ereport\u009b.md";
    const task = {
      request: { operation: { kind: "file", action: "write", path: raw, content: "x" } },
    } as unknown as Parameters<typeof taskTarget>[0];
    // A display escape baked in here would change the value `melra watch` emits.
    expect(taskTarget(task)).toBe(raw);
  });

  it("keeps hidden characters out of every JSON it prints", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-cli-")));
    roots.push(root);
    const dataDirectory = join(root, ".melra");
    const server = await createMelraRuntime({ workspaceRoot: root, dataDirectory, environment: {} });
    try {
      const planned = server.controller.plan(
        TaskRequestSchema.parse({
          goal: "Write\u009b2J\u202ethe report",
          operation: { kind: "file", action: "write", path: "report.txt", content: "x" },
        }),
      );
      const env = { ...process.env, MELRA_HOME: dataDirectory, MELRA_WORKSPACE: root };
      // By the eight characters `melra tasks` shows.
      const asked = (await execute(process.execPath, [entry, "approve", planned.id.slice(0, 8), "--json"], {
        cwd: root,
        env,
      }).catch((error: unknown) => error)) as { code: number; stdout: string };
      expect(asked.code).toBe(3);
      expect(asked.stdout).not.toMatch(/[\u0080-\u009f\u202e]/);
      expect(JSON.parse(asked.stdout).contract.metadata.goal).toBe("Write\u009b2J\u202ethe report");
      // `melra tasks --json`, which the approval hint points at, too.
      server.controller.plan(
        TaskRequestSchema.parse({
          goal: "Write",
          operation: { kind: "file", action: "write", path: "a\u202eb\u009b.txt", content: "x" },
        }),
      );
      const listed = await execute(process.execPath, [entry, "tasks", "--json"], { cwd: root, env });
      expect(listed.stdout).not.toMatch(/[\u0080-\u009f\u202e]/);
      expect(listed.stdout).toContain("a\\u202eb\\u009b.txt");
    } finally {
      await server.close();
    }
  });

  it("prints the product version", async () => {
    const result = await execute(process.execPath, [entry, "version"]);
    // Against the constant, not a literal: a literal here is an eighteenth
    // place a release has to remember, and `check-versions.mjs` does not know
    // about it.
    expect(result.stdout.trim()).toBe(PRODUCT_VERSION);
  });

  it("reports local readiness through doctor", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
    roots.push(root);
    const result = await execute(process.execPath, [entry, "doctor"], {
      cwd: root,
      env: {
        ...process.env,
        MELRA_HOME: join(root, ".melra"),
        MELRA_WORKSPACE: root,
      },
    });
    const report = JSON.parse(result.stdout) as {
      ready: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    expect(report.ready).toBe(true);
    expect(report.checks.find((check) => check.name === "sqlite")?.status).toBe(
      "pass",
    );
    expect(
      ["pass", "warn"].includes(
        report.checks.find((check) => check.name === "computer")?.status ?? "",
      ),
    ).toBe(true);
  });

  it("earns level 3 against its own server, and level 1 without guardrails", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
    roots.push(root);
    const env = {
      ...process.env,
      MELRA_HOME: join(root, ".melra"),
      MELRA_WORKSPACE: root,
    };
    const result = await execute(process.execPath, [entry, "conformance"], {
      cwd: root,
      env,
    });
    const report = JSON.parse(result.stdout) as {
      level: number;
      mode: string;
      notProven: string[];
      checks: Array<{ name: string; passed: boolean; detail: string }>;
      uncleanedProbeFile?: string;
    };
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);
    expect(report.level).toBe(3);
    expect(report.mode).toBe("developer");
    // The caveat an operator has to read before quoting the level: in developer
    // mode nothing observable from this side rules out a second path.
    expect(report.notProven[0]).toContain("no second, ungoverned path");
    // The suite writes a real file through the kernel, so it owes the workspace
    // the same file back. A leftover probe is a bug in the suite, not a detail.
    expect(report.uncleanedProbeFile).toBeUndefined();
    expect(
      (await readdir(root)).filter((name) => name.startsWith("melra-conformance-")),
    ).toEqual([]);

    // Enforced mode does not earn a level the endpoint has not earned; what it
    // changes is whose word the remaining caveat rests on. It refuses a data
    // directory inside the workspace, so this one sits beside it.
    const strictHome = await mkdtemp(join(tmpdir(), "melra-cli-home-"));
    roots.push(strictHome);
    const strict = await execute(process.execPath, [entry, "conformance"], {
      cwd: root,
      env: { ...env, MELRA_MODE: "enforced", MELRA_HOME: strictHome },
    });
    const strictReport = JSON.parse(strict.stdout) as {
      level: number;
      mode: string;
      notProven: string[];
    };
    expect(strictReport.level).toBe(3);
    expect(strictReport.mode).toBe("enforced");
    expect(strictReport.notProven[0]).toContain("enforced-mode claim");

    // Unhinged is supposed to cost the governed levels and keep the typed one.
    // If it ever reached L2 the flag would not be doing what it says.
    const unhinged = await execute(
      process.execPath,
      [entry, "conformance", "--level", "1"],
      { cwd: root, env: { ...env, MELRA_UNHINGED: "1" } },
    );
    expect(JSON.parse(unhinged.stdout).level).toBe(1);
    // Three full suites, each spawning its own server: a Windows runner has
    // taken just over the file's 20 s default for the lot.
  }, 60_000);

  it("keeps Node's SQLite warning out of every invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
    roots.push(root);
    const env = {
      ...process.env,
      MELRA_HOME: join(root, ".melra"),
      MELRA_WORKSPACE: root,
    };
    // `help` links the graph without doing any work, so it is the cheapest
    // proof the warning is gone at import time rather than at first query.
    const help = await execute(process.execPath, [entry, "help"], { cwd: root, env });
    expect(help.stderr).toBe("");

    // And on a command that really opens the database, where a caller reading
    // stderr for errors would otherwise get a false positive on every run.
    const doctor = await execute(process.execPath, [entry, "doctor"], { cwd: root, env });
    expect(doctor.stderr).toBe("");
    expect(JSON.parse(doctor.stdout).ready).toBe(true);
  });

  it("explains bad input instead of leaking parser internals", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
    roots.push(root);
    const options = {
      cwd: root,
      env: {
        ...process.env,
        MELRA_HOME: join(root, ".melra"),
        MELRA_WORKSPACE: root,
      },
    };

    // Redirected-but-empty stdin is the scripted form of running `run` with no
    // arguments, and used to answer with JSON.parse's "unexpected end of input".
    await expect(
      executeWithInput([entry, "run"], options, ""),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("provide --request <file> or pipe"),
    });

    // A syntax error names its source, so a caller with several request files
    // knows which one to open.
    const requestPath = join(root, "broken.json");
    await writeFile(requestPath, "{oops", "utf8");
    await expect(
      execute(process.execPath, [entry, "run", "--request", requestPath], options),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(`${requestPath} is not valid JSON`),
    });

    // A schema rejection is one line per problem, keyed by field path, rather
    // than the JSON dump of zod's issue array.
    await expect(
      executeWithInput(
        [entry, "run"],
        options,
        JSON.stringify({ goal: "no operation here", oops: 1 }),
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        [
          "input does not match the schema:",
          "  operation: Invalid input: expected object, received undefined",
          '  (root): Unrecognized key: "oops"',
        ].join("\n"),
      ),
    });
  });

  it("names a mistyped flag instead of waiting on stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
    roots.push(root);
    const options = {
      cwd: root,
      env: {
        ...process.env,
        MELRA_HOME: join(root, ".melra"),
        MELRA_WORKSPACE: root,
      },
    };

    // `execute` leaves stdin an open pipe that never sends EOF, which is what
    // makes this a regression test: `run` used to ignore the unknown flag, fall
    // through to reading stdin, and hang here until the test timed out.
    await expect(
      execute(
        process.execPath,
        [entry, "run", "--workflow", join(root, "wf.json")],
        options,
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("unknown flag --workflow"),
    });

    // The message lists what this command does take, so the fix is in the error.
    await expect(
      execute(
        process.execPath,
        [entry, "workflow", "plan", "--defintion", join(root, "wf.json")],
        options,
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--approval, --definition, --input"),
    });

    // A known flag's value may itself look like a flag, and must not be read as
    // one.
    await expect(
      execute(
        process.execPath,
        [entry, "workflow", "advance", "missing-id", "--input", "node=--x"],
        options,
      ),
    ).rejects.toMatchObject({
      stderr: expect.not.stringContaining("unknown flag"),
    });

    // A mistyped command is the same mistake one level up, so it gets the same
    // treatment: name it, and say where the answer is.
    await expect(
      execute(process.execPath, [entry, "docter"], options),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("unknown command: docter. Run 'melra --help'"),
    });
  });

  it("cannot run unsafe-local without saying so", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
    roots.push(root);
    const env = {
      ...process.env,
      MELRA_HOME: join(root, ".melra"),
      MELRA_WORKSPACE: root,
      MELRA_UNHINGED: "1",
    };
    // The banner goes to stderr, not stdout, so it stays out of the JSON a
    // caller parses while still being impossible to miss in a terminal.
    const doctor = await execute(process.execPath, [entry, "doctor"], {
      cwd: root,
      env,
    });
    expect(doctor.stderr).toContain("NO GUARDRAILS");
    expect(JSON.parse(doctor.stdout).unhinged).toBe(true);

    // And the flag alone is enough — no environment variable needed.
    const flagged = await execute(
      process.execPath,
      [entry, "doctor", "--unsafe-local"],
      { cwd: root, env: { ...env, MELRA_UNHINGED: "0" } },
    );
    expect(flagged.stderr).toContain("NO GUARDRAILS");
    expect(JSON.parse(flagged.stdout).unhinged).toBe(true);

    // The old name still works, because a flag people have in scripts that
    // silently stops disabling guardrails is worse than a deprecated one.
    const deprecated = await execute(
      process.execPath,
      [entry, "doctor", "--unhinged"],
      { cwd: root, env: { ...env, MELRA_UNHINGED: "0" } },
    );
    expect(deprecated.stderr).toContain("--unhinged is deprecated");
    expect(JSON.parse(deprecated.stdout).unhinged).toBe(true);
  });

  it("serves on MELRA_SOCKET, and doctor reports the socket's mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
    roots.push(root);
    // Short: a socket path has a ~104-byte ceiling on macOS.
    const socketDirectory = await mkdtemp(join(tmpdir(), "mc-"));
    roots.push(socketDirectory);
    const socketPath = join(socketDirectory, "melra.sock");
    const env = {
      ...process.env,
      MELRA_HOME: join(root, ".melra"),
      MELRA_WORKSPACE: root,
      MELRA_SOCKET: socketPath,
      MELRA_HTTP_TOKEN: "cli-socket-token",
    };
    const socketReport = async (environment: NodeJS.ProcessEnv) => {
      const result = await execute(process.execPath, [entry, "doctor"], {
        cwd: root,
        env: environment,
      }).catch((error: { stdout: string }) => error);
      return (
        JSON.parse(result.stdout) as {
          checks: Array<{ name: string; status: string; detail: string }>;
        }
      ).checks.find((check) => check.name === "socket");
    };

    // One transport per process: a socket and a port together is a mistake to
    // name, not one to resolve quietly.
    await expect(
      execute(process.execPath, [entry, "serve", "--http"], { cwd: root, env }),
    ).rejects.toThrow(/replaces --http/);

    if (process.platform === "win32") {
      expect((await socketReport(env))?.status).toBe("fail");
      return;
    }
    expect(await socketReport({ ...env, MELRA_SOCKET: join(root, "nope", "m.sock") }))
      .toMatchObject({ status: "fail", detail: expect.stringContaining("parent directory missing") });
    expect((await socketReport(env))?.detail).toContain("not listening");

    const server = spawn(process.execPath, [entry, "serve"], {
      cwd: root,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    server.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(socketPath); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      expect(await socketReport(env)).toMatchObject({
        status: "pass",
        detail: expect.stringContaining("mode 0600"),
      });
      const status = await new Promise<number | undefined>((resolveStatus, rejectStatus) => {
        httpRequest(
          {
            socketPath,
            path: "/api/capabilities",
            headers: { authorization: "Bearer cli-socket-token" },
          },
          (response) => {
            response.resume();
            resolveStatus(response.statusCode);
          },
        )
          .on("error", rejectStatus)
          .end();
      });
      expect(status).toBe(200);
    } finally {
      const exited = new Promise((resolveExit) => server.once("exit", resolveExit));
      server.kill("SIGTERM");
      await exited;
    }
    // A clean shutdown takes the socket with it.
    expect(existsSync(socketPath)).toBe(false);
    // A stdio client spawned under an exported MELRA_SOCKET would hang, so the
    // variable is named where such a client logs.
    expect(stderr).toContain("MELRA_SOCKET is set, so 'serve' is on the socket below, not stdio");
  });

  it("refuses to start in enforced mode with the local bypass", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
    roots.push(root);
    const env = {
      ...process.env,
      MELRA_HOME: join(root, ".melra"),
      MELRA_WORKSPACE: root,
    };
    const enforced = await execute(process.execPath, [entry, "doctor"], {
      cwd: root,
      env: { ...env, MELRA_MODE: "enforced" },
    });
    expect(
      JSON.parse(enforced.stdout).checks.find(
        (check: { name: string }) => check.name === "mode",
      ).detail,
    ).toContain("enforced");
    // "enforced" belongs to the mode and to nothing else in this report. Two
    // checks a line apart using it for different things is how an operator ends
    // up believing a developer-mode machine is locked down.
    expect(
      JSON.parse(enforced.stdout).checks.find(
        (check: { name: string }) => check.name === "guardrails",
      ).detail,
    ).not.toContain("enforced");

    // The two together are a contradiction, so the process declines to be the
    // thing that resolves it — before printing a banner that would read as if
    // unsafe-local had taken effect.
    await expect(
      execute(
        process.execPath,
        [entry, "doctor", "--mode", "enforced", "--unsafe-local"],
        { cwd: root, env },
      ),
    ).rejects.toThrow(/enforced_mode_refuses_unsafe_local/);
    // A typo in the mode is not silently the permissive one.
    await expect(
      execute(process.execPath, [entry, "doctor"], {
        cwd: root,
        env: { ...env, MELRA_MODE: "enfroced" },
      }),
    ).rejects.toThrow(/deployment_mode_unknown/);
  });

  it("initializes a safe local policy and client configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
    roots.push(root);
    const home = join(root, ".melra");
    const result = await execute(
      process.execPath,
      [entry, "init", "--client", "claude"],
      {
        cwd: root,
        env: {
          ...process.env,
          MELRA_HOME: home,
          MELRA_WORKSPACE: root,
        },
      },
    );
    const initialized = JSON.parse(result.stdout) as {
      initialized: boolean;
      policyPath: string;
      config: { mcpServers: { melra: { command: string } } };
    };
    expect(initialized.initialized).toBe(true);
    expect(initialized.config.mcpServers.melra.command).toBe("melra");
    const policy = JSON.parse(await readFile(initialized.policyPath, "utf8")) as {
      mutations: string;
      allowLocalhost: boolean;
      allowedDomains: string[];
    };
    // Mutations stay approval-gated. Browsing is usable out of the box —
    // localhost is the developer's own machine, and the network guard still
    // blocks private ranges, cloud metadata, and non-HTTP schemes regardless of
    // what the allowlist says.
    expect(policy.mutations).toBe("confirm");
    expect(policy.allowLocalhost).toBe(true);
    expect(policy.allowedDomains).toContain("*");
  });

  it("prepares policy, config, and readiness in one setup command", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-setup-"));
    roots.push(root);
    const result = await execute(
      process.execPath,
      [entry, "setup", "--client", "cursor"],
      {
        cwd: root,
        env: {
          ...process.env,
          MELRA_HOME: join(root, ".melra"),
          MELRA_WORKSPACE: root,
        },
      },
    );
    const report = JSON.parse(result.stdout) as {
      initialized: boolean;
      client: string;
      policyPath: string;
      config: { mcpServers: { melra: { command: string } } };
      ready: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    expect(report.initialized).toBe(true);
    expect(report.client).toBe("cursor");
    expect(report.ready).toBe(true);
    expect(report.checks.some((check) => check.name === "sqlite")).toBe(true);
    expect(JSON.parse(await readFile(report.policyPath, "utf8"))).toMatchObject({
      mutations: "confirm",
    });
  });

  it("keeps each project in its own workspace when they share MELRA_HOME", async () => {
    // Real path: the working directory comes back as /private/var on macOS.
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-cli-shared-")));
    roots.push(root);
    const home = join(root, ".melra");
    const [first, second] = [join(root, "projA"), join(root, "projB")];
    await mkdir(first);
    await mkdir(second);
    // What `setup` in projA used to leave behind for every later project.
    await mkdir(home);
    await writeFile(join(home, "policy.json"), JSON.stringify({ workspaceRoot: first }));
    const doctor = async (cwd: string, extra: Record<string, string>) => {
      const run = await execute(process.execPath, [entry, "doctor"], {
        cwd,
        env: { ...process.env, MELRA_HOME: home, MELRA_WORKSPACE: "", MELRA_POLICY: "", MELRA_MODE: "", ...extra },
      }).catch((error: { stdout: string }) => error);
      const report = JSON.parse(run.stdout) as {
        unhinged: boolean;
        mode: string;
        checks: Array<{ name: string; detail: string; status: string }>;
      };
      return { ...report, workspace: report.checks.find((check) => check.name === "workspace")?.detail };
    };
    // A client config from `setup` names its workspace; so does the working directory.
    expect((await doctor(root, { MELRA_WORKSPACE: second })).workspace).toBe(second);
    expect((await doctor(second, {})).workspace).toBe(second);

    // Naming the shared file in MELRA_POLICY, as every older config does, does
    // not let it pin the workspace either.
    expect((await doctor(second, { MELRA_POLICY: join(home, "policy.json") })).workspace).toBe(second);

    // A file the operator names on purpose may still pin the workspace, and
    // may narrow MELRA_WORKSPACE, but never move it elsewhere.
    const pinned = join(root, "pinned.json");
    await writeFile(pinned, JSON.stringify({ workspaceRoot: first }));
    expect((await doctor(second, { MELRA_POLICY: pinned })).workspace).toBe(first);
    expect((await doctor(second, { MELRA_POLICY: pinned, MELRA_WORKSPACE: second })).workspace).toBe(second);
    expect((await doctor(second, { MELRA_POLICY: pinned, MELRA_WORKSPACE: root })).workspace).toBe(first);
    // Relative to the file, not to wherever the server started.
    const relative = join(first, "relative.json");
    await writeFile(relative, JSON.stringify({ workspaceRoot: "." }));
    expect((await doctor(root, { MELRA_POLICY: relative })).workspace).toBe(first);

    // A file that switches the guardrails off is reported, not hidden.
    const loose = join(root, "loose.json");
    await writeFile(loose, JSON.stringify({ unhinged: true }));
    const unhinged = await doctor(second, { MELRA_POLICY: loose });
    expect(unhinged.unhinged).toBe(true);
    expect(unhinged.checks.find((check) => check.name === "guardrails")?.status).toBe("warn");
    // A file the server would refuse fails doctor too, rather than passing as JSON.
    const typo = join(root, "typo.json");
    await writeFile(typo, JSON.stringify({ mode: "enfroced" }));
    expect((await doctor(second, { MELRA_POLICY: typo })).checks.find((check) => check.name === "policy")?.status).toBe(
      "fail",
    );
    // An empty MELRA_HOME is unset, not the working directory.
    const emptyHome = await execute(process.execPath, [entry, "doctor"], {
      cwd: second,
      env: { ...process.env, MELRA_HOME: "", MELRA_WORKSPACE: "", MELRA_POLICY: "" },
    }).catch((error: { stdout: string }) => error);
    expect(
      (JSON.parse(emptyHome.stdout) as { checks: Array<{ name: string; detail: string }> }).checks.find(
        (check) => check.name === "data-directory",
      )?.detail,
    ).not.toBe(second);

    // `setup` in projB writes projB, and a fresh shared policy names no workspace.
    const fresh = join(root, "fresh-home");
    const setup = await execute(process.execPath, [entry, "init", "--client", "claude"], {
      cwd: second,
      env: { ...process.env, MELRA_HOME: fresh, MELRA_WORKSPACE: "", MELRA_POLICY: "" },
    });
    const initialized = JSON.parse(setup.stdout) as {
      policyPath: string;
      config: { mcpServers: { melra: { env: Record<string, string> } } };
    };
    expect(initialized.config.mcpServers.melra.env.MELRA_WORKSPACE).toBe(second);
    expect(JSON.parse(await readFile(initialized.policyPath, "utf8"))).not.toHaveProperty("workspaceRoot");
  });

  it("writes the operator's MELRA_POLICY into the client config, and refuses one that is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-policy-"));
    roots.push(root);
    const strict = join(root, "strict.json");
    await writeFile(strict, JSON.stringify({ mode: "enforced" }));
    const env = { ...process.env, MELRA_HOME: join(root, ".melra"), MELRA_WORKSPACE: root };
    const result = await execute(process.execPath, [entry, "init", "--client", "claude"], {
      cwd: root,
      env: { ...env, MELRA_POLICY: strict },
    });
    const initialized = JSON.parse(result.stdout) as {
      config: { mcpServers: { melra: { env: Record<string, string> } } };
    };
    expect(initialized.config.mcpServers.melra.env.MELRA_POLICY).toBe(strict);
    await expect(
      execute(process.execPath, [entry, "init", "--client", "claude"], {
        cwd: root,
        env: { ...env, MELRA_POLICY: join(root, "missing.json") },
      }),
    ).rejects.toThrow(/does not exist/);
    // `--mode developer` does not loosen MELRA_MODE=enforced.
    const doctor = await execute(process.execPath, [entry, "doctor", "--mode", "developer"], {
      cwd: root,
      env: { ...env, MELRA_MODE: "enforced", MELRA_POLICY: "" },
    }).catch((error: { stdout: string }) => error);
    expect((JSON.parse(doctor.stdout) as { mode: string }).mode).toBe("enforced");
    // A file asking for both: the server refuses, naming the file, but the
    // CLI still answers `help`.
    const both = join(root, "both.json");
    await writeFile(both, JSON.stringify({ mode: "enforced", unhinged: true }));
    await execute(process.execPath, [entry, "help"], { cwd: root, env: { ...env, MELRA_POLICY: both } });
  });

  it("checks a server given the console URL that serve --http prints", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-console-url-"));
    roots.push(root);
    const runtime = await createMelraRuntime({ workspaceRoot: root, dataDirectory: join(root, ".melra"), environment: {} });
    const http = await serveHttp({ runtime, port: 0, token: "console-token", environment: {} });
    try {
      // `http://127.0.0.1:<port>/?token=...` used to become `/?token=.../mcp`.
      const { report } = await runConformance({ url: http.url, claim: 1 });
      expect(report.target).toMatchObject({ url: http.mcpUrl, authenticated: true });
      expect(report.level).toBeGreaterThanOrEqual(1);
    } finally {
      await http.close();
      await runtime.close();
    }
  });

  it("plans, advances, inspects, and cancels a durable workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-workflow-"));
    roots.push(root);
    const home = join(root, ".melra");
    const definitionPath = join(root, "workflow.json");
    await writeFile(
      definitionPath,
      JSON.stringify({
        schemaVersion: "1.0.0",
        id: "11111111-1111-4111-8111-111111111111",
        version: 1,
        name: "CLI workflow",
        nodes: [
          {
            id: "inspect",
            type: "operation",
            request: {
              goal: "Inspect from CLI",
              operation: { kind: "system", action: "info" },
            },
          },
        ],
      }),
    );
    const options = {
      cwd: root,
      env: {
        ...process.env,
        MELRA_HOME: home,
        MELRA_WORKSPACE: root,
      },
    };
    const planned = await execute(
      process.execPath,
      [entry, "workflow", "plan", "--definition", definitionPath],
      options,
    );
    const run = JSON.parse(planned.stdout) as { id: string; status: string };
    expect(run.status).toBe("planned");

    const advanced = await execute(
      process.execPath,
      [entry, "workflow", "advance", run.id],
      options,
    );
    expect(
      (JSON.parse(advanced.stdout) as { run: { status: string } }).run.status,
    ).toBe("verified_complete");
    const inspected = await execute(
      process.execPath,
      [entry, "workflow", "inspect", run.id],
      options,
    );
    expect(
      (JSON.parse(inspected.stdout) as { status: string }).status,
    ).toBe("verified_complete");
    const cancelled = await execute(
      process.execPath,
      [entry, "workflow", "cancel", run.id],
      options,
    );
    expect(
      (JSON.parse(cancelled.stdout) as { status: string }).status,
    ).toBe("verified_complete");
  });

  it("uses stable exit codes for workflow approval and unknown IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-workflow-"));
    roots.push(root);
    const home = join(root, ".melra");
    const definitionPath = join(root, "workflow.json");
    await writeFile(
      definitionPath,
      JSON.stringify({
        schemaVersion: "1.0.0",
        id: "22222222-2222-4222-8222-222222222222",
        version: 1,
        name: "CLI approval",
        nodes: [
          {
            id: "write",
            type: "operation",
            request: {
              goal: "Write from CLI",
              operation: {
                kind: "file",
                action: "write",
                path: "result.txt",
                content: "verified",
              },
              requiredEvidence: [
                { type: "file_exists", path: "result.txt" },
              ],
            },
          },
        ],
      }),
    );
    const options = {
      cwd: root,
      env: {
        ...process.env,
        MELRA_HOME: home,
        MELRA_WORKSPACE: root,
      },
    };
    const planned = await execute(
      process.execPath,
      [entry, "workflow", "plan", "--definition", definitionPath],
      options,
    );
    const workflowId = (JSON.parse(planned.stdout) as { id: string }).id;
    await expect(
      execute(
        process.execPath,
        [entry, "workflow", "advance", workflowId],
        options,
      ),
    ).rejects.toMatchObject({ code: 3 });
    await expect(
      execute(
        process.execPath,
        [
          entry,
          "workflow",
          "inspect",
          "99999999-9999-4999-8999-999999999999",
        ],
        options,
      ),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("starts the durable-core demo through production services", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-demo-"));
    roots.push(root);
    const result = await execute(
      process.execPath,
      // Bare `demo` runs the only demo there is.
      [entry, "demo"],
      {
        cwd: root,
        env: {
          ...process.env,
          MELRA_HOME: join(root, ".melra"),
          MELRA_WORKSPACE: root,
        },
      },
    );
    const demo = JSON.parse(result.stdout) as {
      example: string;
      workflow: { status: string };
      next: string;
    };
    expect(demo.example).toBe("restart-safe-verified-file");
    // The CLI's own copy, used because npm installs have no examples/
    // directory, must not drift from the one the docs point at.
    const example = JSON.parse(
      await readFile(resolve(import.meta.dirname, "../../../examples/workflows/restart-safe.json"), "utf8"),
    );
    expect(RESTART_SAFE_WORKFLOW).toEqual(example);
    expect(demo.workflow.status).toBe("running");
    expect(demo.next).toMatch(/^melra workflow advance /);
  });
});
