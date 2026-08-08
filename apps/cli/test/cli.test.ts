// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_VERSION } from "@melra/protocol";
import { parseCliEnvironment, serverLaunch } from "../src/environment.js";

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
      dataDirectory: resolve("/tmp/melra-home"),
      browserExecutablePath: resolve("/Applications/Google Chrome"),
      browserCdpEndpoint: "http://127.0.0.1:9222/",
      browserCdpContextIndex: -1,
      unhinged: false,
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
  });

  it("cannot run unhinged without saying so", async () => {
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
    expect(doctor.stderr).toContain("NO GUARDRAILS ARE APPLIED");
    expect(JSON.parse(doctor.stdout).unhinged).toBe(true);

    // And the flag alone is enough — no environment variable needed.
    const flagged = await execute(
      process.execPath,
      [entry, "doctor", "--unhinged"],
      { cwd: root, env: { ...env, MELRA_UNHINGED: "0" } },
    );
    expect(flagged.stderr).toContain("NO GUARDRAILS ARE APPLIED");
    expect(JSON.parse(flagged.stdout).unhinged).toBe(true);
  });

  it("initializes a safe local policy and client configuration", async () => {    const root = await mkdtemp(join(tmpdir(), "melra-cli-"));
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
      [entry, "demo", "durable-core"],
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
      examplePath: string;
      workflow: { status: string };
      next: string;
    };
    expect(demo.examplePath).toMatch(/restart-safe\.json$/);
    expect(demo.workflow.status).toBe("running");
    expect(demo.next).toMatch(/^melra workflow advance /);
  });
});
