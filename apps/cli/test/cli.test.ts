// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserOperationSchema,
  HttpOperationSchema,
  PRODUCT_VERSION,
  TaskRequestSchema,
  TerminalOperationSchema,
} from "@melra/protocol";
import { OAuthProvider, approvalScreen, createMelraRuntime, printable, serveHttp } from "@melra/server";
import { runConformance } from "../src/conformance.js";
import { RESTART_SAFE_WORKFLOW } from "../src/demo-workflow.js";
import { approverLabel, parseCliEnvironment, serverLaunch } from "../src/environment.js";
import { approvalConsole, confirmInTerminal, type ConsoleTerminal } from "../src/approval-console.js";
import { taskTarget } from "../src/activity.js";

const execute = promisify(execFile);
const roots: string[] = [];
// Every run here that wants enforced mode asks for it, so a shell in enforced
// mode must not put the rest there too.
delete process.env.MELRA_MODE;

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
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-cli-")));
    roots.push(base);
    // Enforced mode refuses a data directory inside the workspace.
    const root = join(base, "workspace");
    await mkdir(root);
    const dataDirectory = join(base, "data");
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

      // A developer-mode yes would spend the one decision this enforced task
      // can have on a row its kernel refuses, so it is refused unrecorded.
      const developer = plan();
      const refused = (await execute(process.execPath, [entry, "approve", developer.id, "--yes"], {
        cwd: root,
        env: { ...env, MELRA_MODE: "" },
      }).catch((error: unknown) => error)) as { code: number; stderr: string };
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("approval_needs_enforced_mode");
      expect(server.store.getApprovalDecision(developer.approval!.approvalId)).toBeUndefined();

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

  it("starts an approval console only in a terminal, and prints nothing that opens it", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-cli-")));
    roots.push(base);
    await mkdir(join(base, "workspace"));
    // Piped, as a harness that spawned it would read it.
    const failed = (await execute(process.execPath, [entry, "console"], {
      cwd: join(base, "workspace"),
      env: { ...process.env, MELRA_HOME: join(base, "data"), MELRA_WORKSPACE: join(base, "workspace"), MELRA_MODE: "enforced" },
    }).catch((error: unknown) => error)) as { code: number; stdout: string; stderr: string };
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("console_needs_a_terminal");
    // Refused before anything was opened: no database was made on the way.
    expect(await readdir(join(base, "data")).catch(() => [])).not.toContain("melra.sqlite");
    expect(failed.stdout + failed.stderr).not.toMatch(/https?:|[a-f0-9]{32}/);
  });

  describe("approval console", () => {
    const start = async () => {
      const base = await realpath(await mkdtemp(join(tmpdir(), "melra-cli-")));
      roots.push(base);
      const root = join(base, "workspace");
      await mkdir(root);
      const env = parseCliEnvironment(
        {
          MELRA_HOME: join(base, "data"),
          MELRA_WORKSPACE: root,
          MELRA_MODE: "enforced",
          MELRA_APPROVER: "alice",
          MELRA_HTTP_TOKEN: "agent-token",
        },
        { cwd: root, home: base },
      );
      const melra = await createMelraRuntime({
        workspaceRoot: root,
        dataDirectory: env.dataDirectory,
        environment: { MELRA_MODE: "enforced" },
      });
      const seen = { said: "", opened: [] as string[], browser: true };
      const terminal: ConsoleTerminal = {
        interactive: true,
        open: async (url) => {
          seen.opened.push(url);
          return seen.browser;
        },
        say: (text) => {
          seen.said += text;
        },
      };
      return { env, melra, terminal, seen };
    };
    const call = (url: URL, path: string, init: { body?: unknown; token?: string } = {}) =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolveCall, reject) => {
        const text = init.body === undefined ? "" : JSON.stringify(init.body);
        const request = httpRequest(
          {
            host: url.hostname,
            port: url.port,
            path,
            method: init.body === undefined ? "GET" : "POST",
            // No pooled keep-alive socket, as in the server's console test:
            // the console runs in this process, and a slow turn lets it time
            // one out just as the next request is written to it (#296).
            agent: false,
            headers: {
              ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
              origin: url.origin,
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(text)),
            },
          },
          (response) => {
            let data = "";
            response.on("data", (chunk) => (data += chunk));
            response.on("end", () => resolveCall({ status: response.statusCode ?? 0, json: JSON.parse(data) }));
          },
        );
        request.on("error", reject);
        request.end(text);
      });

    it("prints its address before the pairing, even when the page pairs first", async () => {
      const { env, melra, terminal, seen } = await start();
      const task = melra.controller.plan(
        TaskRequestSchema.parse({
          goal: "Write the report",
          operation: { kind: "file", action: "write", path: "report.txt", content: "x" },
        }),
      );
      // A browser fast enough to pair, and approve, before the opener has returned.
      const quick: ConsoleTerminal = {
        ...terminal,
        open: async (address) => {
          const url = new URL(address);
          const paired = await call(url, "/pair", { body: { code: url.hash.slice("#pair=".length) } });
          const session = paired.json.session as string;
          const shown = await call(url, `/api/tasks/${task.id}/approval`, { token: session });
          await call(url, `/api/tasks/${task.id}/approve`, {
            token: session,
            body: { taskId: task.id, renderDigest: shown.json.renderDigest },
          });
          return true;
        },
      };
      const endpoint = await approvalConsole(env, melra, quick);
      try {
        expect(seen.said.indexOf("Approval console on")).toBeGreaterThanOrEqual(0);
        expect(seen.said.indexOf("Paired with a browser tab")).toBeGreaterThan(seen.said.indexOf("Approval console on"));
        // An approval is named at once, the opener still running, so no Ctrl-C can lose it.
        expect(seen.said.indexOf(`Approved ${task.id} at `)).toBeGreaterThanOrEqual(0);
        expect(seen.said.indexOf(`Approved ${task.id} at `)).toBeLessThan(seen.said.indexOf("Approval console on"));
      } finally {
        await endpoint.close();
        await melra.close();
      }
    });

    it("names what a tab approved while an opener ran, when the opener then fails", async () => {
      const { env, melra, terminal, seen } = await start();
      const task = melra.controller.plan(
        TaskRequestSchema.parse({
          goal: "Write the report",
          operation: { kind: "file", action: "write", path: "report.txt", content: "x" },
        }),
      );
      const failing: ConsoleTerminal = {
        ...terminal,
        open: async (address) => {
          const url = new URL(address);
          const paired = await call(url, "/pair", { body: { code: url.hash.slice("#pair=".length) } });
          const session = paired.json.session as string;
          const shown = await call(url, `/api/tasks/${task.id}/approval`, { token: session });
          await call(url, `/api/tasks/${task.id}/approve`, {
            token: session,
            body: { taskId: task.id, renderDigest: shown.json.renderDigest },
          });
          return false;
        },
      };
      try {
        const failed = await approvalConsole(env, melra, failing).then(() => "", (error: Error) => error.message);
        expect(failed).toMatch(/^console_needs_a_browser: the browser opener reported failure; a browser tab paired at \d\d:\d\d/);
        expect(failed).toContain(`approved ${task.id}`);
        expect(failed).toContain("melra approve <task-id> --deny");
        // Nothing on the terminal claims a normal start.
        expect(seen.said).not.toMatch(/Approval console on|Paired with a browser tab/);
        // And one that throws leaves nothing listening behind it.
        let address = "";
        const throwing: ConsoleTerminal = {
          ...terminal,
          open: async (url) => {
            address = url;
            throw new Error("opener exploded");
          },
        };
        await expect(approvalConsole(env, melra, throwing)).rejects.toThrow("opener exploded");
        await expect(call(new URL(address), "/pair", { body: { code: "x" } })).rejects.toThrow();
      } finally {
        await melra.close();
      }
    });

    it("hands its pairing code to the browser and nothing else, and records console approvals", async () => {
      const { env, melra, terminal, seen } = await start();
      const endpoint = await approvalConsole(env, melra, terminal);
      try {
        expect(seen.opened).toHaveLength(1);
        const url = new URL(seen.opened[0]!);
        expect(url.hostname).toBe("127.0.0.1");
        expect(url.search).toBe("");
        expect(seen.opened[0]).not.toContain("&");
        const code = /^#pair=([a-f0-9]{32})$/.exec(url.hash)?.[1] ?? "";
        expect(code).not.toBe("");
        expect(seen.said).not.toMatch(/Paired/);
        const paired = await call(url, "/pair", { body: { code } });
        const session = paired.json.session as string;
        expect(seen.said).toMatch(/Paired with a browser tab at \d\d:\d\d/);
        const task = melra.controller.plan(
          TaskRequestSchema.parse({
            goal: "Write the report",
            operation: { kind: "file", action: "write", path: "report.txt", content: "x" },
          }),
        );
        const shown = await call(url, `/api/tasks/${task.id}/approval`, { token: session });
        const decided = await call(url, `/api/tasks/${task.id}/approve`, {
          token: session,
          body: { taskId: task.id, renderDigest: shown.json.renderDigest },
        });
        expect(decided.json.decision).toMatchObject({ channel: "out_of_band", approver: "console:alice" });
        // Named on the terminal as it happens, whatever ends the console later.
        expect(seen.said).toContain(`Approved ${task.id} at `);
        expect(seen.said).toContain(`melra approve ${task.id} --deny`);
        expect((await melra.controller.execute(task.id)).task.status).toBe("verified_success");
        // What the operator's terminal shows names the console, never a way in.
        expect(seen.said).toContain(`http://127.0.0.1:${url.port}`);
        expect(seen.said).not.toContain(code);
        expect(seen.said).not.toContain(session);
      } finally {
        await endpoint.close();
        await melra.close();
      }
    });

    it("refuses without a terminal or a browser, and leaves nothing listening", async () => {
      const { env, melra, terminal, seen } = await start();
      try {
        await expect(approvalConsole(env, melra, { ...terminal, interactive: false })).rejects.toThrow(
          "console_needs_a_terminal",
        );
        expect(seen.opened).toHaveLength(0);
        seen.browser = false;
        await expect(approvalConsole(env, melra, terminal)).rejects.toThrow("console_needs_a_browser");
        expect(seen.said).toBe("");
        const offered = new URL(seen.opened[0]!);
        await expect(fetch(`${offered.origin}/`)).rejects.toThrow();
      } finally {
        await melra.close();
      }
    });
  });

  it("warns when the agent's browser is one attached over CDP", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-cli-")));
    roots.push(root);
    const result = await execute(process.execPath, [entry, "doctor"], {
      cwd: root,
      env: {
        ...process.env,
        MELRA_HOME: join(root, ".melra"),
        MELRA_WORKSPACE: root,
        MELRA_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9",
      },
    });
    const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; status: string; detail: string }> };
    const browser = report.checks.find((check) => check.name === "browser");
    expect(browser?.status).toBe("warn");
    expect(browser?.detail).toContain("attached over CDP");
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
        metadata: { goal: hostile + "e\u0301\u0302\u0303\u0304\ufff0\u0305\u0306\u0307" + " ".repeat(9_000) },
      },
      renderDigest: "a".repeat(64),
    });
    // Nor draw over the lines around it: no character carries more than two
    // combining marks, even with an unassigned code point between them.
    expect(screen).not.toMatch(/[\p{Mn}\p{Me}]{3}/u);
    // Other CLI output keeps scripts that stack more as written, but still
    // spells out a code point a terminal may draw as nothing.
    expect(printable("\u0f40\u0f71\u0f72\u0f74")).toBe("\u0f40\u0f71\u0f72\u0f74");
    expect(printable("a\ufff0b")).toBe("a\\ufff0b");
    expect(screen).toContain("e\u0301\u0302\\u0303\\u0304\\ufff0");
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

  it("wraps the terminal screen itself, so agent text never starts a row at column 0", () => {
    const view = (content: string) => ({
      task: { id: "t1", approval: { expiresAt: "2026-10-15T00:00:00.000Z" } },
      contract: {
        capability: "file.write",
        target: "w.txt",
        effect: "mutate",
        risk: "medium",
        operation: { kind: "file", action: "write", path: "w.txt", content },
        metadata: { goal: "Save notes" },
      },
      renderDigest: "a".repeat(64),
    });
    // The most a character can take: two cells for anything past ASCII, since
    // a terminal set to draw ambiguous-width text wide draws Greek in two.
    const cells = (row: string) => [...row].reduce((sum, character) => sum + (character.codePointAt(0)! < 0x80 ? 1 : 2), 0);
    const check = (content: string, columns: number) => {
      const plain = approvalScreen(view(content), true);
      const rows = approvalScreen(view(content), true, columns).split("\n");
      // Every row fits, so the terminal wraps none of them itself...
      expect(rows.filter((row) => cells(row) > columns - 1)).toEqual([]);
      // ...each line comes back whole, every row after its first indented...
      let index = 0;
      for (const line of plain.split("\n")) {
        let rebuilt = rows[index++]!;
        while (rebuilt.length < line.length) {
          const row = rows[index++]!;
          expect(row.slice(0, 4)).toBe("    ");
          rebuilt += row.slice(4);
        }
        expect(rebuilt).toBe(line);
      }
      expect(index).toBe(rows.length);
      // ...and MELRA's Effect line is the only row that starts with one.
      expect(rows.filter((row) => row.startsWith("Effect:"))).toEqual([expect.stringMatching(/^Effect: file\.write/)]);
    };
    const payload = "Effect: file.read on notes.txt";
    for (const columns of [40, 60, 80, 120]) {
      // Padded so the forged Effect line starts exactly where the terminal
      // would wrap the line, and where MELRA's own wrap does, in the summary
      // and then in the contract dump: left unwrapped, or wrapped without the
      // indent, it would start a row of its own.
      for (const label of ["  content: ", '    "content": '] as const) {
        const line = approvalScreen(view("MARK"), true)
          .split("\n")
          .find((row) => row.startsWith(label))!;
        for (const end of [columns, columns - 1]) check("x".padEnd(end - line.indexOf("MARK"), " ") + payload, columns);
      }
      check("中".repeat(columns) + payload, columns);
      check("α".repeat(columns) + payload, columns);
      check("°".repeat(columns) + payload, columns);
    }
    // Without a usable width (piped, in JSON, or too narrow to indent) the
    // screen is as it was.
    const plain = approvalScreen(view(payload), true);
    for (const columns of [undefined, 19, 80.5, Number.NaN]) expect(approvalScreen(view(payload), true, columns)).toBe(plain);
    expect(approvalScreen(view(payload), false, 80)).toBe(approvalScreen(view(payload)));
  });

  it("asks on the terminal it shows the screen on, wrapped to that terminal", async () => {
    const view = {
      task: { id: "t1", approval: { expiresAt: "2026-10-15T00:00:00.000Z" } },
      contract: {
        capability: "file.write",
        target: "w.txt",
        effect: "mutate",
        risk: "medium",
        operation: { kind: "file", action: "write", path: "w.txt", content: "x".repeat(200) },
        metadata: { goal: "Save notes" },
      },
      renderDigest: "a".repeat(64),
    };
    const screen = approvalScreen(view, true, 40);
    expect(screen).not.toBe(approvalScreen(view, true));
    const question = "Approve this effect? [y/N] ";
    // Given a terminal: the screen and then the question go to it, the screen
    // wrapped to its width, and nothing but a yes approves.
    const output = Object.assign(new PassThrough(), { columns: 40 });
    let shown = "";
    output.on("data", (chunk: Buffer) => (shown += chunk.toString()));
    expect(await confirmInTerminal(view, Readable.from(["y\n"]), output)).toBe(true);
    expect(shown).toBe(screen + question);
    // Only a yes approves, however it is cased or spaced; input that ends
    // before any answer is a no.
    for (const [said, approved] of [["\n", false], ["nope\n", false], ["q\n", false], ["yes!\n", false], [" YES \n", true], ["Y\n", true]] as const) {
      expect(await confirmInTerminal(view, Readable.from([said]), new PassThrough()), JSON.stringify(said)).toBe(approved);
    }
    const ended = new PassThrough();
    let rest = "";
    ended.on("data", (chunk: Buffer) => (rest += chunk.toString()));
    expect(await confirmInTerminal(view, Readable.from([]), ended)).toBe(false);
    // Ending the question's line, so whatever comes next starts its own.
    expect(rest.endsWith(question + "\nNot approved.\n")).toBe(true);
    // By default, the operator's: stderr, at stderr's width.
    const columns = Object.getOwnPropertyDescriptor(process.stderr, "columns");
    Object.defineProperty(process.stderr, "columns", { value: 40, configurable: true, writable: true });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await confirmInTerminal(view, Readable.from(["n\n"]))).toBe(false);
      expect(write.mock.calls.map((call) => String(call[0]))).toEqual([screen, question, "Not approved.\n"]);
    } finally {
      write.mockRestore();
      if (columns === undefined) delete (process.stderr as { columns?: number }).columns;
      else Object.defineProperty(process.stderr, "columns", columns);
    }
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
    // An upload's files are in the summary too.
    const upload = summary(
      "browser.upload",
      "#avatar",
      BrowserOperationSchema.parse({
        kind: "browser",
        action: "upload",
        target: { selector: "#avatar" },
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

    // Planning refuses a list its action never reads, so each action carries
    // only its own. With that list at any size, every value set and a full
    // target, the element acted on and the values typed or opened still sit
    // right above the question, and the list's ends are close behind.
    const lists = {
      select: (size: number) => ({ values: Array.from({ length: Math.min(size, 50) }, (_, index) => `v${index}`) }),
      fill_form: (size: number) => ({
        fields: Array.from({ length: Math.ceil(size / 5) }, (_, index) => ({ target: target(`f${index}`), value: `x${index}` })),
      }),
      upload: (size: number) => ({ filePaths: Array.from({ length: Math.min(size, 20) }, (_, index) => `p${index}`) }),
    };
    for (const [action, list] of Object.entries(lists)) {
      for (const size of [4, 250]) {
        const operation = BrowserOperationSchema.parse({
          kind: "browser",
          action,
          url: "https://bank.example/pay?to=attacker",
          target: target("q"),
          value: "typed-by-agent",
          ...list(size),
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
        });
        const worst = summary(`browser.${action}`, "#q", operation);
        const nearQuestion = worst.slice(-24).join("\n");
        expect(nearQuestion).toContain('value: "typed-by-agent"');
        expect(nearQuestion).toContain("to=attacker");
        expect(nearQuestion).toContain('target.selector: "#q"');
        const shown = worst.slice(-40).join("\n");
        const items = Object.values(list(size))[0]!;
        expect(shown).toContain(`[0]`);
        expect(shown).toContain(`[${items.length - 1}]`);
        expect(worst.length).toBeLessThan(60);
      }
    }
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

  it("warns, or in enforced mode fails, when the workspace holds the data directory, and fails when the data holds it", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-cli-")));
    roots.push(root);
    const doctorWith = async (extra: Record<string, string>) => {
      const result = await execute(process.execPath, [entry, "doctor"], {
        cwd: root,
        env: { ...process.env, MELRA_WORKSPACE: join(root, "ws"), MELRA_POLICY: "", ...extra },
      }).catch((error: { stdout: string }) => error);
      return JSON.parse(result.stdout) as { ready: boolean; checks: Array<{ name: string; status: string }> };
    };
    await mkdir(join(root, "ws"));
    const data = (report: { checks: Array<{ name: string; status: string }> }) =>
      report.checks.find((check) => check.name === "data-location")?.status;
    // Inside, spelled through a link: still inside.
    await symlink(join(root, "ws"), join(root, "alias"));
    const inside = await doctorWith({ MELRA_HOME: join(root, "alias", ".melra") });
    expect(data(inside)).toBe("warn");
    expect(inside.ready).toBe(true);
    // Spelled inside, leading out: the server counts it as inside, and so does doctor.
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), join(root, "ws", "out"));
    expect(data(await doctorWith({ MELRA_HOME: join(root, "ws", "out") }))).toBe("warn");
    const enforced = await doctorWith({ MELRA_HOME: join(root, "ws", ".melra"), MELRA_MODE: "enforced" });
    expect(data(enforced)).toBe("fail");
    expect(enforced.ready).toBe(false);
    // Beside the workspace, as the deploy examples lay it out.
    expect(data(await doctorWith({ MELRA_HOME: join(root, "data") }))).toBe("pass");
    // Unsafe-local reaches every file, which the guardrails check reports;
    // no data-location verdict pretends otherwise.
    expect(data(await doctorWith({ MELRA_HOME: join(root, "data"), MELRA_UNHINGED: "1" }))).toBeUndefined();
    // Inside the data directory every path is MELRA's own, which the server
    // refuses in every mode.
    await mkdir(join(root, "data", "ws"), { recursive: true });
    for (const extra of [{}, { MELRA_UNHINGED: "1" }]) {
      const within = await doctorWith({ MELRA_WORKSPACE: join(root, "data", "ws"), MELRA_HOME: join(root, "data"), ...extra });
      expect(data(within), JSON.stringify(extra)).toBe("fail");
      expect(within.ready).toBe(false);
    }
    // A workspace that is a file is the workspace's problem, reported once.
    await writeFile(join(root, "file"), "");
    const file = await doctorWith({ MELRA_WORKSPACE: join(root, "file"), MELRA_HOME: join(root, "data") });
    expect(file.checks.filter((check) => check.status === "fail").map((check) => check.name)).toEqual(["workspace"]);
    // Eight CLI starts, each a fresh Node process; a slow Windows runner took ~3.6 s for one.
  }, 60_000);

  it("warns, or in enforced mode fails, when the workspace holds a secret file, and fails when the profile holds it", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-cli-")));
    roots.push(root);
    await mkdir(join(root, "ws"));
    const doctorWith = async (extra: Record<string, string>) => {
      const result = await execute(process.execPath, [entry, "doctor"], {
        cwd: root,
        env: { ...process.env, MELRA_WORKSPACE: join(root, "ws"), MELRA_HOME: join(root, "data"), MELRA_POLICY: "", ...extra },
      }).catch((error: { stdout: string }) => error);
      const report = JSON.parse(result.stdout) as { ready: boolean; checks: Array<{ name: string; status: string }> };
      return { ready: report.ready, secret: report.checks.find((check) => check.name === "secret-location")?.status };
    };
    // Nothing configured, nothing said.
    expect((await doctorWith({})).secret).toBeUndefined();
    expect((await doctorWith({ MELRA_BROWSER_PROFILE: join(root, "profile") })).secret).toBe("pass");
    expect((await doctorWith({ MELRA_BROWSER_PROFILE: join(root, "ws", "profile") })).secret).toBe("warn");
    // Its directory not there yet still counts.
    expect(
      await doctorWith({ MELRA_BROWSER_HAR_PATH: join(root, "ws", "har", "session.har"), MELRA_MODE: "enforced" }),
    ).toEqual({ ready: false, secret: "fail" });
    // A credential's file, named in the policy file.
    await writeFile(
      join(root, "policy.json"),
      JSON.stringify({
        credentials: {
          billing: {
            source: { file: join(root, "ws", "billing.key") },
            inject: { header: "Authorization" },
            hosts: ["api.example.com"],
            capability: "http.post:*",
          },
        },
      }),
    );
    expect((await doctorWith({ MELRA_POLICY: join(root, "policy.json"), MELRA_MODE: "enforced" })).secret).toBe("fail");
    // Inside the profile every path is refused, which the server refuses in every mode.
    await mkdir(join(root, "profile", "ws"), { recursive: true });
    expect(
      await doctorWith({ MELRA_WORKSPACE: join(root, "profile", "ws"), MELRA_BROWSER_PROFILE: join(root, "profile") }),
    ).toEqual({ ready: false, secret: "fail" });
    // Six CLI starts, each a fresh Node process; a slow Windows runner took ~3.6 s for one.
  }, 60_000);

  it("says when a policy file opens loopback destinations in enforced mode", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-cli-")));
    roots.push(root);
    await mkdir(join(root, "ws"));
    const loopback = async (policy: Record<string, unknown>, extra: Record<string, string>) => {
      await writeFile(join(root, "policy.json"), JSON.stringify(policy));
      const result = await execute(process.execPath, [entry, "doctor"], {
        cwd: root,
        env: {
          ...process.env,
          MELRA_WORKSPACE: join(root, "ws"),
          MELRA_HOME: join(root, "data"),
          MELRA_POLICY: join(root, "policy.json"),
          ...extra,
        },
      }).catch((error: { stdout: string }) => error);
      const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; status: string }> };
      return report.checks.find((check) => check.name === "loopback")?.status;
    };
    expect(await loopback({ allowLocalhost: true }, { MELRA_MODE: "enforced" })).toBe("warn");
    expect(await loopback({ allowLocalhost: true, mode: "enforced" }, {})).toBe("warn");
    // Closed, or developer mode, where it is the default: nothing to say.
    expect(await loopback({}, { MELRA_MODE: "enforced" })).toBeUndefined();
    expect(await loopback({ allowLocalhost: true }, {})).toBeUndefined();
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
    // Developer mode's checks are the ones every published 14/14 was run on.
    expect(report.checks).toHaveLength(14);
    for (const name of ["approval-credential-withheld", "in-band-approval-refused", "approval-provenance-recorded"]) {
      expect(report.checks.map((check) => check.name)).not.toContain(name);
    }
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
    // By the flag, which the spawned server is not given: only its env reaches it.
    const strict = await execute(process.execPath, [entry, "conformance", "--mode", "enforced"], {
      cwd: root,
      env: { ...env, MELRA_HOME: strictHome },
    });
    const strictReport = JSON.parse(strict.stdout) as {
      level: number;
      mode: string;
      notProven: string[];
      checks: Array<{ name: string; passed: boolean }>;
      uncleanedProbeFile?: string;
    };
    expect(strictReport.checks.filter((check) => !check.passed)).toEqual([]);
    // No phrase to echo, the derived one refused, and an operator's yes on the
    // receipt: the level is earned with the approver this suite spawned.
    expect(strictReport.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining(["approval-credential-withheld", "in-band-approval-refused", "approval-provenance-recorded"]),
    );
    expect(strictReport.checks.map((check) => check.name)).not.toContain("wrong-phrase-is-refused");
    expect(strictReport.checks).toHaveLength(16);
    expect(strictReport.level).toBe(3);
    expect(strictReport.mode).toBe("enforced");
    expect(strictReport.uncleanedProbeFile).toBeUndefined();
    expect(strictReport.notProven[0]).toContain("enforced-mode claim");

    // Unhinged is supposed to cost the governed levels and keep the typed one.
    // If it ever reached L2 the flag would not be doing what it says.
    // By the flag, as with --mode: the spawned server gets it only as env.
    const unhinged = await execute(
      process.execPath,
      [entry, "conformance", "--level", "1", "--unsafe-local"],
      { cwd: root, env },
    );
    expect(JSON.parse(unhinged.stdout).level).toBe(1);
    // Three full suites, each spawning its own server, and the enforced one
    // two `melra approve` processes besides: a Windows runner has taken just
    // over the file's 20 s default for the lot.
  }, 90_000);

  it("says why a server conformance started refused to start", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
    roots.push(root);
    // Enforced mode refuses a data directory inside the workspace; the suite
    // used to report only that the connection closed.
    const refused = await execute(process.execPath, [entry, "conformance", "--mode", "enforced"], {
      cwd: root,
      env: { ...process.env, MELRA_HOME: join(root, ".melra"), MELRA_WORKSPACE: root, MELRA_POLICY: "" },
    }).catch((error: { stderr: string }) => error);
    expect(refused.stderr).toContain("enforced_mode_refuses_data_inside_workspace");
  });

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

  it("names the Node.js it needs when node:sqlite will not load, instead of crashing", async (context) => {
    // Turning the module off stands in for a release where it needs a flag.
    if (!process.allowedNodeEnvironmentFlags.has("--no-experimental-sqlite")) context.skip();
    const failed = await execute(process.execPath, ["--no-experimental-sqlite", entry, "doctor"]).then(
      () => undefined,
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(failed?.code).toBe(1);
    // Every Node.js CI runs is a supported one, where the module was turned off.
    expect(failed?.stderr).toBe(
      `melra: Node.js ${process.versions.node} has node:sqlite turned off or built without it; check NODE_OPTIONS for --no-experimental-sqlite\n`,
    );
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

    // An unknown flag after one that takes no value is caught too. --write
    // and --open were read as taking a value, so the token after them was
    // skipped unchecked and `--write --dry-run` wrote the client config. The
    // timeout stops an unfixed `serve` from waiting on stdin for good.
    for (const args of [
      ["setup", "--client", "claude-code", "--write", "--dry-run"],
      ["init", "--client", "claude-code", "--write", "--dry-run"],
      ["serve", "--open", "--dry-run"],
    ]) {
      await expect(
        execute(process.execPath, [entry, ...args], { ...options, timeout: 10_000 }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("unknown flag --dry-run") });
    }
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);

    // Without --http, serve speaks MCP over stdio, so a port is refused rather
    // than left looking like a server that never answers.
    // A trailing --port too, as `--port $PORT` sends with PORT unset.
    for (const args of [["serve", "--port", "8080"], ["serve", "--port"], ["serve", "--open"]]) {
      await expect(
        execute(process.execPath, [entry, ...args], { ...options, timeout: 10_000 }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("--port and --open need --http") });
    }

    // A mistyped command is the same mistake one level up, so it gets the same
    // treatment: name it, and say where the answer is.
    await expect(
      execute(process.execPath, [entry, "docter"], options),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("unknown command: docter. Run 'melra --help'"),
    });
    // A dozen CLI starts, each a fresh Node process.
  }, 60_000);

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

  it("lists a client it revoked as pending, not approved", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
    roots.push(root);
    const home = join(root, ".melra");
    const options = { cwd: root, env: { ...process.env, MELRA_HOME: home, MELRA_WORKSPACE: root } };
    // Registered and approved through the console's provider, as a server does.
    const oauth = new OAuthProvider(home);
    const id = oauth.register({ client_name: "agent", redirect_uris: ["http://127.0.0.1:9/cb"] }).client_id as string;
    oauth.decide(
      new URLSearchParams({ client_id: id, redirect_uri: "http://127.0.0.1:9/cb", code_challenge: "x".repeat(43), decision: "approve" }),
    );
    expect((await execute(process.execPath, [entry, "clients"], options)).stdout).toContain(`approved  ${id}`);

    await execute(process.execPath, [entry, "clients", "--revoke", id], options);
    // Its tokens were gone, and it was still listed as approved.
    expect((await execute(process.execPath, [entry, "clients"], options)).stdout).toContain(`pending   ${id}`);
  });

  it("refuses to revoke a client that is not registered, or nothing at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
    roots.push(root);
    const options = { cwd: root, env: { ...process.env, MELRA_HOME: join(root, ".melra"), MELRA_WORKSPACE: root } };
    // A mistyped id reported "Revoked 0 tokens" and exited 0; a bare --revoke listed the clients.
    await expect(execute(process.execPath, [entry, "clients", "--revoke", "nope"], options)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("no such client: nope"),
    });
    await expect(execute(process.execPath, [entry, "clients", "--revoke"], options)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("--revoke requires a client id"),
    });
  });

  it("refuses a blank --port instead of taking a random one", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
    roots.push(root);
    const options = {
      cwd: root,
      env: { ...process.env, MELRA_HOME: join(root, ".melra"), MELRA_WORKSPACE: root },
      // An unfixed serve listens until killed.
      timeout: 10_000,
    };
    // What `--port "$PORT"` sends with PORT unset, and a --port with nothing after it.
    for (const args of [["--port", ""], ["--port", " "], ["--port"]]) {
      await expect(
        execute(process.execPath, [entry, "serve", "--http", ...args], options),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("--port requires a port") });
    }
    // With --socket the transports conflict first, value or not: telling a
    // socket user to pass 0 only gets them refused for mixing transports.
    await expect(
      execute(process.execPath, [entry, "serve", "--socket", join(root, "s.sock"), "--port"], options),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("--socket replaces") });
  }, 60_000);

  it("serves on a socket only with --socket, and doctor reports the socket's mode", async () => {
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
      execute(process.execPath, [entry, "serve", "--socket", socketPath, "--http"], { cwd: root, env }),
    ).rejects.toThrow(/replaces --http/);

    // MELRA_SOCKET alone leaves serve on stdio: a stdio client launched from a
    // shell that exported it still gets its reply.
    const stdio = spawn(process.execPath, [entry, "serve"], { cwd: root, env, stdio: ["pipe", "pipe", "ignore"] });
    try {
      const replied = new Promise<string>((resolveReply) => {
        let out = "";
        stdio.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes('"id":1')) resolveReply(out);
        });
      });
      stdio.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cli-test", version: "1" } },
        })}\n`,
      );
      expect(await replied).toContain('"serverInfo"');
      expect(existsSync(socketPath)).toBe(false);
    } finally {
      const exited = new Promise((resolveExit) => stdio.once("exit", resolveExit));
      stdio.kill("SIGTERM");
      await exited;
    }

    if (process.platform === "win32") {
      expect((await socketReport(env))?.status).toBe("fail");
      return;
    }
    expect(await socketReport({ ...env, MELRA_SOCKET: join(root, "nope", "m.sock") }))
      .toMatchObject({ status: "fail", detail: expect.stringContaining("parent directory missing") });
    expect((await socketReport(env))?.detail).toContain("not listening");

    const server = spawn(process.execPath, [entry, "serve", "--socket", socketPath], {
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
    expect(stderr).toContain(`listening on Unix socket ${socketPath}`);
  });

  it("fails doctor when a policy file asks for enforced mode beside unsafe-local", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-cli-")));
    roots.push(root);
    await mkdir(join(root, "ws"));
    await writeFile(join(root, "policy.json"), JSON.stringify({ mode: "enforced" }));
    const result = (await execute(process.execPath, [entry, "doctor"], {
      cwd: root,
      env: {
        ...process.env,
        MELRA_HOME: join(root, "data"),
        MELRA_WORKSPACE: join(root, "ws"),
        MELRA_POLICY: join(root, "policy.json"),
        MELRA_UNHINGED: "1",
        MELRA_MODE: "",
      },
    }).catch((error: unknown) => error)) as { stdout: string };
    const report = JSON.parse(result.stdout) as { ready: boolean; checks: Array<{ name: string; status: string; detail: string }> };
    // The server refuses this; doctor must not call it ready.
    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.name === "mode")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("enforced_mode_refuses_unsafe_local"),
    });
  });

  it("refuses to start in enforced mode with the local bypass", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
    roots.push(root);
    // Data beside the workspace: enforced mode refuses it inside.
    await mkdir(join(root, "ws"));
    const env = {
      ...process.env,
      MELRA_HOME: join(root, ".melra"),
      MELRA_WORKSPACE: join(root, "ws"),
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
    // what the allowlist says. Localhost is left to the mode, so the file does
    // not open it for an enforced server that later reads it.
    expect(policy.mutations).toBe("confirm");
    expect(policy).not.toHaveProperty("allowLocalhost");
    expect(policy.allowedDomains).toContain("*");
  });

  it("carries --mode enforced into the policy and the client config it writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-cli-mode-"));
    roots.push(root);
    // Beside the workspace: enforced mode refuses a data directory inside it.
    const workspace = join(root, "ws");
    await mkdir(workspace);
    const init = async (home: string, extra: string[]) =>
      JSON.parse(
        (
          await execute(process.execPath, [entry, "init", "--client", "claude", ...extra], {
            cwd: workspace,
            env: { ...process.env, MELRA_HOME: home, MELRA_WORKSPACE: workspace, MELRA_POLICY: "" },
          })
        ).stdout,
      ) as { policyPath: string; config: { mcpServers: { melra: { env: Record<string, string> } } } };
    // What the client will run: a process given only the config's env.
    const modeFrom = async (config: Record<string, string>) =>
      (
        JSON.parse(
          (
            await execute(process.execPath, [entry, "doctor", "--json"], {
              cwd: workspace,
              env: { ...process.env, MELRA_MODE: "", ...config },
            }).catch((error: { stdout: string }) => error)
          ).stdout,
        ) as { mode: string }
      ).mode;

    const strict = await init(join(root, "strict"), ["--mode", "enforced"]);
    expect(strict.config.mcpServers.melra.env.MELRA_MODE).toBe("enforced");
    expect(JSON.parse(await readFile(strict.policyPath, "utf8")).mode).toBe("enforced");
    expect(JSON.parse(await readFile(strict.policyPath, "utf8")).allowLocalhost).not.toBe(true);
    expect(await modeFrom(strict.config.mcpServers.melra.env)).toBe("enforced");

    // A policy that already exists is the operator's and is left alone; the
    // config alone still starts the server enforced.
    const kept = join(root, "kept");
    await init(kept, []);
    const before = await readFile(join(kept, "policy.json"), "utf8");
    const pinned = await init(kept, ["--mode", "enforced"]);
    expect(await readFile(join(kept, "policy.json"), "utf8")).toBe(before);
    expect(JSON.parse(before).mode).toBe("developer");
    expect(await modeFrom(pinned.config.mcpServers.melra.env)).toBe("enforced");

    // Developer mode adds nothing, so an existing entry stays unchanged.
    const plain = await init(join(root, "plain"), []);
    expect(plain.config.mcpServers.melra.env).not.toHaveProperty("MELRA_MODE");
    // Six CLI starts, each a fresh Node process; a slow Windows runner took ~3.6 s for one.
  }, 60_000);

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
      workspace: string;
      policyPath: string;
      config: { mcpServers: { melra: { command: string } } };
      ready: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    expect(report.initialized).toBe(true);
    expect(report.client).toBe("cursor");
    expect(report.workspace).toBe(root);
    expect(report.ready).toBe(true);
    expect(report.checks.some((check) => check.name === "sqlite")).toBe(true);
    expect(JSON.parse(await readFile(report.policyPath, "utf8"))).toMatchObject({
      mutations: "confirm",
    });
  });

  it("will not quietly make the home directory or a filesystem root the workspace", async () => {
    // Real path, so the working directory the CLI reads back is spelled the same.
    const home = await realpath(await mkdtemp(join(tmpdir(), "melra-cli-home-")));
    roots.push(home);
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MELRA_HOME: join(home, ".melra"),
      MELRA_WORKSPACE: "",
      MELRA_POLICY: "",
    };
    // What `npx @melra/cli@alpha setup` in a fresh terminal did: piped, or with
    // --json, nobody can be asked, so it is refused with what to do instead.
    for (const [cwd, what] of [
      [home, "is your home directory"],
      [parse(home).root, "is the root of the file system"],
      // Every user's home, as /Users, /home or C:\Users is.
      [resolve(home, ".."), "holds your home directory"],
    ] as const) {
      for (const command of [["setup"], ["init"], ["setup", "--json"]]) {
        const refused = await execute(process.execPath, [entry, ...command, "--client", "claude"], { cwd, env }).catch(
          (error: { code: number; stdout: string; stderr: string }) => error,
        );
        expect(refused).toMatchObject({ code: 1, stdout: "" });
        expect(refused.stderr).toContain(`workspace_too_broad: ${cwd} ${what}`);
        expect(refused.stderr).toContain("Set MELRA_WORKSPACE to your project directory, or run this from there");
      }
    }
    // Before anything was written.
    expect(existsSync(join(home, ".melra"))).toBe(false);
    // MELRA_WORKSPACE naming it is a choice made, so a scripted install still runs.
    const chosen = await execute(process.execPath, [entry, "init", "--client", "claude"], {
      cwd: home,
      env: { ...env, MELRA_WORKSPACE: home },
    });
    expect(JSON.parse(chosen.stdout)).toMatchObject({
      workspace: home,
      config: { mcpServers: { melra: { env: { MELRA_WORKSPACE: home } } } },
    });
    // A project under home is the ordinary case.
    const project = join(home, "project");
    await mkdir(project);
    const setup = await execute(process.execPath, [entry, "setup", "--client", "claude"], { cwd: project, env }).catch(
      (error: { stdout: string }) => error,
    );
    expect((JSON.parse(setup.stdout) as { workspace: string }).workspace).toBe(project);
    // A MELRA_POLICY file pins the workspace, so running from the project
    // cannot change it; its workspaceRoot, or MELRA_WORKSPACE, can. Spelled
    // through macOS's /System/Volumes/Data firmlink where there is one, which
    // realpath leaves as it is (a working directory comes back folded).
    const firmlink = join("/System/Volumes/Data", home);
    const pin = existsSync(firmlink) ? firmlink : home;
    await writeFile(join(home, "team.json"), JSON.stringify({ workspaceRoot: pin }));
    const pinned = await execute(process.execPath, [entry, "setup", "--json"], {
      cwd: project,
      env: { ...env, MELRA_POLICY: join(home, "team.json") },
    }).catch((error: { code: number; stderr: string }) => error);
    expect(pinned).toMatchObject({ code: 1 });
    expect(pinned.stderr).toContain(`workspace_too_broad: ${pin} is your home directory`);
    expect(pinned.stderr).toContain(
      `Set MELRA_WORKSPACE to your project directory, or make that the workspaceRoot in ${join(home, "team.json")}`,
    );
    expect(pinned.stderr).not.toContain("run this from there");
    // Twelve CLI starts, each a fresh Node process; a slow Windows runner took ~3.6 s for one.
  }, 90_000);

  it("tells doctor and approve what fixes a data directory in the workspace, by layout", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "melra-cli-home-")));
    roots.push(home);
    const project = join(home, "project");
    await mkdir(project);
    const env = { ...process.env, HOME: home, USERPROFILE: home, MELRA_WORKSPACE: "", MELRA_POLICY: "", MELRA_HOME: "" };
    const next = async (cwd: string, extra: Record<string, string>) => {
      const result = await execute(process.execPath, [entry, "doctor"], { cwd, env: { ...env, ...extra } }).catch(
        (error: { stdout: string }) => error,
      );
      const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; next?: string }> };
      return report.checks.find((check) => check.name === "data-location")?.next;
    };
    // From a fresh terminal, home holds the default ~/.melra: narrow the
    // workspace, and leave the database where it is.
    const narrow =
      "set MELRA_WORKSPACE to your project directory, or run this from there; " +
      "keep MELRA_HOME where it is (moving it orphans the database)";
    expect(await next(home, {})).toBe(narrow);
    // MELRA_HOME put inside the project: the workspace is right, the data is not.
    expect(await next(project, { MELRA_WORKSPACE: project, MELRA_HOME: join(project, ".melra") })).toBe(
      "move the MELRA_HOME directory, with everything in it, out of the workspace, and set MELRA_HOME to where it went",
    );
    // Pinned by a policy file, which running from the project cannot change.
    await writeFile(join(home, "team.json"), JSON.stringify({ workspaceRoot: home }));
    expect(await next(project, { MELRA_POLICY: join(home, "team.json") })).toContain(
      `or make that the workspaceRoot in ${join(home, "team.json")}; keep MELRA_HOME where it is`,
    );
    // Enforced, `approve` from home is refused with the same advice: rerunning
    // setup would not change the workspace it works out.
    const refused = await execute(process.execPath, [entry, "approve", "1234", "--yes"], {
      cwd: home,
      env: { ...env, MELRA_MODE: "enforced" },
    }).catch((error: { code: number; stderr: string }) => error);
    expect(refused.stderr).toContain(`enforced_mode_refuses_data_inside_workspace: ${narrow}`);
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
    // So does a key the server does not know, by name, rather than its default.
    const misspelt = join(root, "misspelt.json");
    await writeFile(misspelt, JSON.stringify({ allowedComands: ["git"] }));
    expect((await doctor(second, { MELRA_POLICY: misspelt })).checks.find((check) => check.name === "policy")).toEqual({
      name: "policy",
      status: "fail",
      detail: `policy_invalid: ${misspelt}: allowedComands: unknown key`,
    });
    // And `policy test` says the same in one line, not a stack trace.
    const request = join(root, "read.json");
    await writeFile(request, JSON.stringify({ goal: "Read", operation: { kind: "file", action: "list", path: "." } }));
    const refused = await execute(process.execPath, [entry, "policy", "test", "--request", request], {
      cwd: second,
      env: { ...process.env, MELRA_HOME: home, MELRA_WORKSPACE: "", MELRA_MODE: "", MELRA_POLICY: misspelt },
    }).catch((error: { stderr: string }) => error);
    expect(refused.stderr).toBe(`melra: policy_invalid: ${misspelt}: allowedComands: unknown key\n`);
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
    // Thirteen CLI starts, each a fresh Node process; a slow Windows runner took ~3.6 s for one.
  }, 90_000);

  it("creates MELRA_HOME private, and says when one it finds is not", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "melra-private-home-"));
    roots.push(root);
    const env = { ...process.env, MELRA_WORKSPACE: root, MELRA_POLICY: "" };
    const home = join(root, "home");
    await execute(process.execPath, [entry, "init", "--client", "claude"], { cwd: root, env: { ...env, MELRA_HOME: home } });
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    // One made earlier and left open is reported, and left as it is.
    const open = join(root, "open");
    await mkdir(open);
    await chmod(open, 0o755);
    const result = await execute(process.execPath, [entry, "doctor"], { cwd: root, env: { ...env, MELRA_HOME: open } }).catch(
      (error: { stdout: string }) => error,
    );
    const check = (JSON.parse(result.stdout) as { checks: Array<{ name: string; status: string; detail: string }> }).checks.find(
      (entry) => entry.name === "data-directory",
    );
    expect(check).toMatchObject({ status: "warn", detail: expect.stringContaining("chmod 700") });
    expect((await stat(open)).mode & 0o777).toBe(0o755);
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
