// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, parse, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deploymentMode, TaskRequestSchema, type TaskRequest } from "@melra/protocol";
import { serveHttp } from "./http-server.js";
import {
  assertEnforceable,
  createMelraRuntime,
  unconfinedRoot,
  unhingedFromEnvironment,
  type MelraRuntime,
} from "./runtime.js";

// Parse rather than hand-build: `TaskRequest` is the post-defaults shape, so a
// literal has to restate every default the schema already knows.
function request(overrides: Record<string, unknown>): TaskRequest {
  return TaskRequestSchema.parse({ goal: "Unhinged mode test", ...overrides });
}

describe("unhingedFromEnvironment", () => {
  it("accepts only the affirmative spellings", () => {
    for (const value of ["1", "true", "TRUE", "yes"]) {
      expect(unhingedFromEnvironment({ MELRA_UNHINGED: value })).toBe(true);
    }
    // Anything else is off, so a typo or a leftover `MELRA_UNHINGED=0` cannot
    // silently drop every guardrail.
    for (const value of ["0", "false", "no", "off", "", "maybe"]) {
      expect(unhingedFromEnvironment({ MELRA_UNHINGED: value })).toBe(false);
    }
    expect(unhingedFromEnvironment({})).toBe(false);
  });
});

describe("unconfinedRoot", () => {
  it("is the filesystem root of the path it is given", () => {
    const root = parse(resolve(tmpdir())).root;
    expect(unconfinedRoot(tmpdir())).toBe(root);
    expect(unconfinedRoot(join(tmpdir(), "a", "b", "c"))).toBe(root);
  });
});

describe("unhinged runtime", () => {
  let base: string;
  let workspace: string;
  let data: string;
  let outside: string;
  let runtime: MelraRuntime | undefined;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "melra-unhinged-"));
    workspace = join(base, "workspace");
    data = join(base, "data");
    outside = join(base, "outside.txt");
    await mkdir(workspace, { recursive: true });
    await writeFile(outside, "reachable", "utf8");
  });

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    await rm(base, { recursive: true, force: true });
  });

  it("keeps every guardrail on by default", async () => {
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: data,
      environment: {},
    });
    expect(runtime.policy.unhinged).toBe(false);

    // A shell is denied unconditionally under policy, before any adapter runs.
    const shell = runtime.controller.plan(
      request({
        operation: { kind: "terminal", action: "run", command: "sh", args: [] },
        requiredEvidence: [{ type: "exit_code", value: 0 }],
      }),
    );
    expect(shell.policyDecision.outcome).toBe("deny");
    expect(shell.policyDecision.reason).toBe("command_not_allowlisted");

    // Confined runtime, absolute path outside it: the read is refused by the
    // file runtime even though policy allows reads.
    const read = runtime.controller.plan(
      request({ operation: { kind: "file", action: "read", path: outside } }),
    );
    const result = await runtime.controller.execute(read.id);
    expect(result.task.status).not.toBe("verified_success");
  });

  it("confines to the workspace it was given, not one a shared policy file names", async () => {
    // A policy file another project's `setup` wrote, read by this project's server.
    const other = join(base, "other");
    await mkdir(other);
    await writeFile(join(other, "secret.txt"), "other project", "utf8");
    await writeFile(join(workspace, "secret.txt"), "this project", "utf8");
    const policyPath = join(base, "policy.json");
    await writeFile(policyPath, JSON.stringify({ workspaceRoot: other }), "utf8");
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: data,
      policyPath,
      environment: {},
    });
    expect(runtime.policy.workspaceRoot).toBe(resolve(workspace));
    // A file can narrow the workspace to a directory inside it.
    const narrow = join(base, "narrow.json");
    await mkdir(join(workspace, "app"));
    await writeFile(narrow, JSON.stringify({ workspaceRoot: join(workspace, "app") }), "utf8");
    const narrowed = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: join(base, "narrow-data"),
      policyPath: narrow,
      environment: {},
    });
    expect(narrowed.policy.workspaceRoot).toBe(resolve(workspace, "app"));
    await narrowed.close();
    const read = runtime.controller.plan(
      request({ operation: { kind: "file", action: "read", path: "secret.txt" } }),
    );
    const result = await runtime.controller.execute(read.id);
    expect(result.task.status).toBe("verified_success");
    expect(JSON.stringify(result.output)).toContain("this project");
  });

  it("reads outside the workspace and allows a shell when unhinged", async () => {
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: data,
      environment: {},
      unhinged: true,
    });
    expect(runtime.policy.unhinged).toBe(true);

    const read = runtime.controller.plan(
      request({ operation: { kind: "file", action: "read", path: outside } }),
    );
    expect(read.policyDecision.outcome).toBe("allow");
    const readResult = await runtime.controller.execute(read.id);
    expect(readResult.task.status).toBe("verified_success");

    // Evidence-free destruction: allowed, unapproved, and still reported as
    // destructive so the receipt does not understate what was permitted.
    const destroy = runtime.controller.plan(
      request({
        operation: { kind: "file", action: "delete", path: "anything" },
      }),
    );
    expect(destroy.policyDecision.outcome).toBe("allow");
    expect(destroy.policyDecision.reason).toBe("unhinged_mode_no_guardrails");
    expect(destroy.policyDecision.effect).toBe("destructive");
    expect(destroy.approval).toBeUndefined();

    const shell = runtime.controller.plan(
      request({
        operation: {
          kind: "terminal",
          action: "run",
          command: "sh",
          args: ["-c", "exit 0"],
        },
      }),
    );
    expect(shell.policyDecision.outcome).toBe("allow");
  });

  it("turns on from the environment alone", async () => {
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: data,
      environment: { MELRA_UNHINGED: "1" },
    });
    expect(runtime.policy.unhinged).toBe(true);
  });
});

describe("deploymentMode", () => {
  it("reads only the two exact words", () => {
    expect(deploymentMode(undefined)).toBe("developer");
    expect(deploymentMode("")).toBe("developer");
    expect(deploymentMode(" ENFORCED ")).toBe("enforced");
    // A typo must not read as the permissive mode. Someone who meant to lock a
    // machine down and misspelled it should hear about it, not be handed
    // developer mode with a config file that claims otherwise.
    for (const value of ["enfroced", "strict", "1", "on"]) {
      expect(() => deploymentMode(value)).toThrow(/deployment_mode_unknown/);
    }
  });
});

describe("enforced mode", () => {
  let base: string;
  let workspace: string;
  let data: string;
  let runtime: MelraRuntime | undefined;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "melra-enforced-"));
    workspace = join(base, "workspace");
    data = join(base, "data");
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    await rm(base, { recursive: true, force: true });
  });

  it("refuses to start with the local bypass, from either channel", async () => {
    expect(() => assertEnforceable("enforced", true)).toThrow(
      /enforced_mode_refuses_unsafe_local/,
    );
    expect(() => assertEnforceable("developer", true)).not.toThrow();
    await expect(
      createMelraRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        environment: { MELRA_UNHINGED: "1", MELRA_MODE: "enforced" },
      }),
    ).rejects.toThrow(/enforced_mode_refuses_unsafe_local/);
  });

  it("takes the stricter of flag, environment, and policy file", async () => {
    const policyPath = join(base, "policy.json");
    await writeFile(policyPath, JSON.stringify({ mode: "enforced" }), "utf8");
    // Nothing on the command line or in the environment asks for it, so only the
    // file does — and a file that pinned the mode must not be loosened by an
    // unset variable.
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: data,
      environment: {},
      policyPath,
    });
    expect(runtime.policy.mode).toBe("enforced");
  });

  it("rejects a policy file whose mode is a typo", async () => {
    const policyPath = join(base, "policy.json");
    await writeFile(policyPath, JSON.stringify({ mode: "enfroced" }), "utf8");
    await expect(
      createMelraRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        environment: {},
        policyPath,
      }),
    ).rejects.toThrow(/deployment_mode_unknown/);
  });

  it("names the mode on the receipt of every effect", async () => {
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: data,
      environment: { MELRA_MODE: "enforced" },
    });
    const task = runtime.controller.plan(
      request({ operation: { kind: "system", action: "info" } }),
    );
    const { receipt } = await runtime.controller.execute(task.id);
    // An auditor holding a receipt should not have to ask which deployment
    // produced it — that is the difference between "the only door" and "one of
    // several", and it is not recoverable after the fact.
    expect(receipt?.mode).toBe("enforced");
  });

  it("refuses a bind that is not loopback, and admits no self-registering client", async () => {
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: data,
      environment: { MELRA_MODE: "enforced" },
    });
    await expect(
      serveHttp({
        runtime,
        host: "0.0.0.0",
        port: 0,
        environment: {},
      }),
    ).rejects.toThrow(/enforced_mode_refuses_public_bind/);

    // Loopback is allowed, but OAuth registration is not: enforced mode admits
    // identities the operator issued and nothing that asks to be let in.
    const endpoint = await serveHttp({
      runtime,
      port: 0,
      environment: {},
    });
    try {
      expect(endpoint.oauth).toBe(false);
      const refused = await fetch(`${endpoint.mcpUrl}`, { method: "POST" });
      expect(refused.status).toBe(401);
    } finally {
      await endpoint.close();
    }
  });
});

describe("terminal arguments", () => {
  let base: string;
  let workspace: string;
  let data: string;
  let runtime: MelraRuntime | undefined;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "melra-arguments-"));
    workspace = join(base, "workspace");
    data = join(base, "data");
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    await rm(base, { recursive: true, force: true });
  });

  const terminal = (command: string, args: string[], evidence = false) =>
    request({
      operation: { kind: "terminal", action: "run", command, args },
      ...(evidence ? { requiredEvidence: [{ type: "exit_code", value: 0 }] } : {}),
    });
  /** Plans and runs a task, echoing the phrase back when one is asked for. */
  const run = async (task: TaskRequest) => {
    const planned = runtime!.controller.plan(task);
    const approval =
      planned.approval === undefined
        ? undefined
        : { approvalId: planned.approval.approvalId, phrase: planned.approval.phrase! };
    return { planned, task: (await runtime!.controller.execute(planned.id, approval)).task };
  };

  it("refuses MELRA's own files however an argument reaches them, in every mode", async () => {
    runtime = await createMelraRuntime({ workspaceRoot: workspace, dataDirectory: data, environment: {} });
    const key = join(data, "payload.key");
    // Spread over several programs: three failures of one open its circuit.
    for (const task of [
      terminal("cat", [key]),
      terminal("head", [join("..", basename(data), "melra.sqlite")]),
      // A directory holding them, which a recursive reader reaches unnamed.
      terminal("cat", [base]),
      terminal("rg", ["x", base]),
      // Approval does not open them either.
      terminal("node", ["-e", "process.stdout.write(require('fs').readFileSync(process.argv[1]))", key], true),
    ]) {
      const { planned, task: done } = await run(task);
      expect(planned.status).not.toBe("policy_blocked");
      expect(done.status).toBe("failed");
      expect(done.error).toMatch(/terminal_path_reserved/);
    }
    // `ls` prints names, not contents, so `ls ..` from a project under home works.
    const listed = (await run(terminal("ls", [base]))).task;
    expect(listed.error ?? "").not.toMatch(/terminal_path_reserved/);
    if (process.platform !== "win32") expect(listed.status).toBe("verified_success");
    expect((await run(terminal("ls", [key]))).task.error).toMatch(/terminal_path_reserved/);
    if (process.platform === "darwin") {
      // A firmlink spells the same directory another way.
      for (const task of [
        terminal("cat", [`/System/Volumes/Data${await realpath(key)}`]),
        terminal("rg", ["x", `/System/Volumes/Data${await realpath(base)}`]),
      ]) {
        expect((await run(task)).task.error).toMatch(/terminal_path_reserved/);
      }
    }
    await runtime.close();
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: data,
      environment: {},
      unhinged: true,
    });
    const unhinged = await run(terminal("cat", [key]));
    expect(unhinged.planned.status).toBe("planned");
    expect(unhinged.task.error).toMatch(/terminal_path_reserved/);
  });

  it("in enforced mode, shows a person a read outside the workspace and refuses a link out", async () => {
    await writeFile(join(base, "outside.txt"), "outside", "utf8");
    await mkdir(join(base, "outside"));
    await writeFile(join(base, "outside", "f"), "linked", "utf8");
    await symlink(join(base, "outside"), join(workspace, "out"), "junction");
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: data,
      environment: { MELRA_MODE: "enforced" },
    });
    const outside = runtime.controller.plan(terminal("cat", [join(base, "outside.txt")]));
    expect(outside.status).toBe("awaiting_approval");
    expect(outside.policyDecision.reason).toBe("read_outside_workspace");
    expect(outside.approval).not.toHaveProperty("phrase");
    await expect(runtime.controller.execute(outside.id)).rejects.toThrow(/approval_awaiting_operator/);
    if (process.platform !== "win32") {
      runtime.controller.decide(outside.id, runtime.controller.approvalView(outside.id).renderDigest, "cli:test");
      const approved = await runtime.controller.execute(outside.id);
      expect(approved.task.status).toBe("verified_success");
    }
    // Spelled inside, so policy asked no one; the runtime sees where it leads.
    const linked = await run(terminal("cat", [join("out", "f")]));
    expect(linked.planned.status).toBe("planned");
    expect(linked.task.status).toBe("failed");
    expect(linked.task.error).toMatch(/terminal_path_outside_workspace/);
    await runtime.close();
    runtime = await createMelraRuntime({ workspaceRoot: workspace, dataDirectory: data, environment: {} });
    if (process.platform !== "win32") {
      expect((await run(terminal("cat", [join("out", "f")]))).task.status).toBe("verified_success");
    }
  });

  it("refuses enforced mode when the workspace holds the data directory", async () => {
    await expect(
      createMelraRuntime({
        workspaceRoot: base,
        dataDirectory: join(base, ".melra"),
        environment: { MELRA_MODE: "enforced" },
      }),
    ).rejects.toThrow(
      // Not "move MELRA_HOME": a server pointed at a new one opens an empty
      // database, with none of the tasks waiting in the old one.
      /enforced_mode_refuses_data_inside_workspace: run setup from the project directory, or set MELRA_WORKSPACE to it; keep MELRA_HOME where it is/,
    );
    // Developer mode starts, and the workspace itself is still usable: refusing
    // the directories above the data would refuse every command there.
    runtime = await createMelraRuntime({ workspaceRoot: base, dataDirectory: join(base, ".melra"), environment: {} });
    const { task } = await run(terminal("node", ["-e", "", "."], true));
    expect(task.status).toBe("verified_success");
  });
});

describe("git read hardening", () => {
  let base: string;

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  // POSIX only: the planted programs are `sh`/`cat`. The portable assertion that
  // the hardening argv/env is applied lives in terminal-runtime's hardenGitRead
  // unit test; this one proves end to end that no planted program runs.
  it.skipIf(process.platform === "win32")(
    "a repo-config textconv, external-diff, or fsmonitor program never runs on an approval-free git read, in either mode",
    async () => {
      base = await mkdtemp(join(tmpdir(), "melra-githarden-"));
      const canary = join(base, "canary.txt");
      await writeFile(canary, "CANARY_LEAK_DO_NOT_RETURN", "utf8");

      for (const mode of ["developer", "enforced"] as const) {
        const workspace = join(base, mode, "workspace");
        const data = join(base, mode, "data");
        await mkdir(workspace, { recursive: true });
        const git = (args: string[]) => execFileSync("git", args, { cwd: workspace });
        git(["init", "-q"]);
        git(["config", "user.email", "t@t.t"]);
        git(["config", "user.name", "t"]);
        git(["config", "commit.gpgsign", "false"]);
        await writeFile(join(workspace, "f.txt"), "hello\nworld\n", "utf8");
        git(["add", "f.txt"]);
        git(["commit", "-qm", "init"]);
        await writeFile(join(workspace, "f.txt"), "hello\nchanged\n", "utf8"); // an uncommitted diff

        // The sibling data layout enforced mode requires; it also writes payload.key.
        const runtime = await createMelraRuntime({
          workspaceRoot: workspace,
          dataDirectory: data,
          environment: mode === "enforced" ? { MELRA_MODE: "enforced" } : {},
        });
        try {
          // The planted program writes a marker (proof it ran, immune to output
          // redaction) and echoes the canary to stdout.
          const marker = join(base, `${mode}-ran.txt`);
          const program = `sh -c 'cat "${canary}" > "${marker}"; cat "${canary}"' #`;
          const ran = async () => (await readFile(marker, "utf8").catch(() => "")) !== "";

          const readGit = async (args: string[]) => {
            const planned = runtime.controller.plan(
              request({ operation: { kind: "terminal", action: "run", command: "git", args } }),
            );
            // Approval-free: policy allows the read and asks for no phrase.
            expect(planned.policyDecision.outcome, `${mode} git ${args.join(" ")}`).toBe("allow");
            expect(planned.approval, `${mode} git ${args.join(" ")}`).toBeUndefined();
            const result = await runtime.controller.execute(planned.id);
            const output = (result.output ?? {}) as Record<string, unknown>;
            return { task: result.task, stdout: String(output.stdout ?? "") };
          };

          // textconv, run by `git show`/`git log -p`.
          await writeFile(join(workspace, ".gitattributes"), "f.txt diff=leak\n", "utf8");
          git(["config", "diff.leak.textconv", program]);
          for (const args of [["show", "HEAD"], ["log", "-p"]]) {
            const { task, stdout } = await readGit(args);
            expect(task.status).toBe("verified_success");
            expect(stdout).not.toContain("CANARY_LEAK_DO_NOT_RETURN");
          }
          git(["config", "--unset", "diff.leak.textconv"]);

          // external diff, run by `git diff`.
          git(["config", "diff.leak.command", program]);
          expect((await readGit(["diff"])).stdout).not.toContain("CANARY_LEAK_DO_NOT_RETURN");
          git(["config", "--unset", "diff.leak.command"]);
          await rm(join(workspace, ".gitattributes"));

          // fsmonitor, run by `git status`.
          const fsmonitor = join(base, `${mode}-fsm.sh`);
          await writeFile(fsmonitor, `#!/bin/sh\ncat "${canary}" > "${marker}"\nexit 1\n`, { mode: 0o755 });
          git(["config", "core.fsmonitor", fsmonitor]);
          expect((await readGit(["status"])).task.status).toBe("verified_success");
          git(["config", "--unset", "core.fsmonitor"]);

          expect(await ran(), `${mode}: a planted git-config program ran`).toBe(false);
        } finally {
          await runtime.close();
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")("still returns correct output for ordinary git reads", async () => {
    base = await mkdtemp(join(tmpdir(), "melra-githarden-ok-"));
    const workspace = join(base, "workspace");
    const data = join(base, "data");
    await mkdir(workspace, { recursive: true });
    const git = (args: string[]) => execFileSync("git", args, { cwd: workspace });
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);
    git(["config", "commit.gpgsign", "false"]);
    await writeFile(join(workspace, "f.txt"), "hello\nworld\n", "utf8");
    git(["add", "f.txt"]);
    git(["commit", "-qm", "init"]);
    await writeFile(join(workspace, "f.txt"), "hello\nchanged\n", "utf8");

    const runtime = await createMelraRuntime({ workspaceRoot: workspace, dataDirectory: data, environment: {} });
    try {
      const readGit = async (args: string[]) => {
        const planned = runtime.controller.plan(
          request({ operation: { kind: "terminal", action: "run", command: "git", args } }),
        );
        const result = await runtime.controller.execute(planned.id);
        const output = (result.output ?? {}) as Record<string, unknown>;
        return { task: result.task, stdout: String(output.stdout ?? "") };
      };
      expect((await readGit(["diff", "--stat"])).stdout).toContain("f.txt");
      expect((await readGit(["show", "HEAD:f.txt"])).stdout).toBe("hello\nworld\n");
      expect((await readGit(["log", "--oneline"])).stdout).toContain("init");
      expect((await readGit(["status", "--porcelain"])).stdout).toContain("f.txt");
      const revParse = await readGit(["rev-parse", "HEAD"]);
      expect(revParse.task.status).toBe("verified_success");
      expect(revParse.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await runtime.close();
    }
  });
});
