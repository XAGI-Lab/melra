// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, parse, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deploymentMode, TaskRequestSchema, type TaskRequest } from "@melra/protocol";
import { serveHttp } from "./http-server.js";
import {
  assertEnforceable,
  broadWorkspace,
  createMelraRuntime,
  unconfinedRoot,
  unhingedFromEnvironment,
  workspaceInsideData,
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

  it.skipIf(process.platform === "win32")(
    "finds a bare program only through PATH entries outside the workspace, unless unhinged",
    async () => {
      await mkdir(join(workspace, "bin"));
      await writeFile(join(workspace, "bin", "ls"), "#!/bin/sh\necho SHADOWED\n", "utf8");
      await chmod(join(workspace, "bin", "ls"), 0o755);
      vi.stubEnv("PATH", `${join(workspace, "bin")}${delimiter}${process.env.PATH ?? ""}`);
      try {
        const ls = async () => {
          const planned = runtime!.controller.plan(
            request({ operation: { kind: "terminal", action: "run", command: "ls", args: [] } }),
          );
          const output = ((await runtime!.controller.execute(planned.id)).output ?? {}) as Record<string, unknown>;
          return String(output.stdout ?? "");
        };
        runtime = await createMelraRuntime({ workspaceRoot: workspace, dataDirectory: data, environment: {} });
        expect(await ls()).toContain("bin");
        await runtime.close();
        // Unsafe-local keeps the operator's PATH as given: nothing there is approved.
        runtime = await createMelraRuntime({ workspaceRoot: workspace, dataDirectory: data, environment: {}, unhinged: true });
        expect(await ls()).toContain("SHADOWED");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
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

  it("keeps loopback destinations closed unless the policy file opens them", async () => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.end("local service");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    const status = async (host: string) => {
      const task = runtime!.controller.plan(
        request({
          operation: { kind: "http", action: "request", method: "GET", url: `http://${host}:${port}/`, timeoutMs: 2_000 },
          budget: { maxRetries: 0 },
        }),
      );
      return (await runtime!.controller.execute(task.id)).task.status;
    };
    try {
      runtime = await createMelraRuntime({ workspaceRoot: workspace, dataDirectory: data, environment: { MELRA_MODE: "enforced" } });
      for (const host of ["127.0.0.1", "localhost", "[::ffff:127.0.0.1]"]) {
        expect(await status(host), host).not.toBe("verified_success");
      }
      expect(hits).toBe(0);
      await runtime.close();
      // The operator's own choice, in the file, is honoured.
      const policyPath = join(base, "policy.json");
      await writeFile(policyPath, JSON.stringify({ allowLocalhost: true }), "utf8");
      runtime = await createMelraRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        environment: { MELRA_MODE: "enforced" },
        policyPath,
      });
      expect(await status("127.0.0.1")).toBe("verified_success");
      expect(hits).toBe(1);
    } finally {
      server.close();
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
    const { task: done, receipt } = await runtime!.controller.execute(planned.id, approval);
    return { planned, task: done, receipt };
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

  it("refuses MELRA's own files named as a file reference, in every mode", async () => {
    runtime = await createMelraRuntime({ workspaceRoot: workspace, dataDirectory: data, environment: {} });
    const key = join(data, "payload.key");
    // One program each: three failures of one open its circuit.
    for (const task of [
      terminal("cat", [`@${key}`]),
      terminal("head", [`-c@${key}`]),
      terminal("tail", [`--file=@${key}`]),
      terminal("wc", ["-l", `f=<${key}`]),
    ]) {
      const { task: done } = await run(task);
      expect(done.error, JSON.stringify(task.operation)).toMatch(/terminal_path_reserved/);
    }
    // A search pattern, as in `rg "@/" src`, is not a directory a reader walks.
    const patterns = (await run(terminal("node", ["-e", "", "--", "@/", "</", "@.."], true))).task;
    expect(patterns.status, patterns.error).toBe("verified_success");
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
    // So is one named as a file reference.
    expect((await run(terminal("head", [`@${join("out", "f")}`]))).task.error).toMatch(/terminal_path_outside_workspace/);
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
      // A project workspace someone put MELRA_HOME inside: narrowing the
      // workspace cannot help, so the data moves, database and all.
      "enforced_mode_refuses_data_inside_workspace: move the MELRA_HOME directory, with everything in it, out of the workspace",
    );
    if (process.platform === "darwin") {
      // The data volume mounted whole holds it too, through no `..` from it.
      for (const workspaceRoot of ["/System/Volumes/Data", "/System"]) {
        await expect(
          createMelraRuntime({ workspaceRoot, dataDirectory: data, environment: { MELRA_MODE: "enforced" } }),
          workspaceRoot,
        ).rejects.toThrow(/enforced_mode_refuses_data_inside_workspace/);
      }
    }
    // Developer mode starts, and the workspace itself is still usable: refusing
    // the directories above the data would refuse every command there.
    runtime = await createMelraRuntime({ workspaceRoot: base, dataDirectory: join(base, ".melra"), environment: {} });
    const { task } = await run(terminal("node", ["-e", "", "."], true));
    expect(task.status).toBe("verified_success");
  });

  it("refuses the policy file a later start reads, without counting it as data in the workspace", async () => {
    const policyPath = join(workspace, "melra-policy.json");
    await writeFile(policyPath, "{}", "utf8");
    runtime = await createMelraRuntime({ workspaceRoot: workspace, dataDirectory: data, environment: {}, policyPath });
    const write = await run(
      request({
        operation: { kind: "file", action: "write", path: "melra-policy.json", content: "{ }" },
        requiredEvidence: [{ type: "file_exists", path: "melra-policy.json" }],
      }),
    );
    expect(write.task.error).toMatch(/path_reserved/);
    expect(await readFile(policyPath, "utf8")).toBe("{}");
    expect((await run(terminal("cat", [policyPath]))).task.error).toMatch(/terminal_path_reserved/);
    // Commands in the workspace holding it still run, and enforced mode starts.
    expect((await run(terminal("node", ["-e", "", "."], true))).task.status).toBe("verified_success");
    await runtime.close();
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: data,
      environment: { MELRA_MODE: "enforced" },
      policyPath,
    });
  });

  it("refuses MELRA's data spelled through the workspace as configured, through a link", async () => {
    const real = join(base, "real");
    const linked = join(base, "linked");
    await mkdir(real);
    await symlink(real, linked, "junction");
    runtime = await createMelraRuntime({ workspaceRoot: linked, dataDirectory: join(real, ".melra"), environment: {} });
    const write = (path: string, evidence = path) =>
      run(
        request({
          operation: { kind: "file", action: "write", path, content: "x" },
          requiredEvidence: [{ type: "file_exists", path: evidence }],
        }),
      );
    // That spelling reaches the workspace...
    expect((await write(join(linked, "notes.txt"))).task.status).toBe("verified_success");
    // ...and not the data directory inside it, present or absent, nor does evidence.
    for (const path of [join(linked, ".melra", "payload.key"), join(linked, ".melra", "planted")]) {
      expect((await write(path)).task.error, path).toMatch(/path_reserved/);
    }
    const checked = await write(join(linked, "notes.txt"), join(linked, ".melra", "payload.key"));
    expect(checked.receipt?.evidence[0]?.summary).toBe("verification_path_reserved");
  });

  it("refuses, in every mode, a workspace that is or sits inside the data directory", async () => {
    // Also one reached through a link that leads well inside it.
    const linked = join(base, "linked");
    await mkdir(join(data, "projects", "app"), { recursive: true });
    await symlink(join(data, "projects", "app"), linked);
    expect(await workspaceInsideData(linked, data)).toBe(true);
    for (const [workspaceRoot, environment] of [
      [data, {}],
      [join(data, "workspace"), {}],
      [join(data, "workspace"), { MELRA_MODE: "enforced" }],
      [join(data, "workspace"), { MELRA_UNHINGED: "1" }],
      [linked, {}],
      [linked, { MELRA_MODE: "enforced" }],
    ] as const) {
      await expect(
        createMelraRuntime({ workspaceRoot, dataDirectory: data, environment }),
        `${workspaceRoot} ${JSON.stringify(environment)}`,
      ).rejects.toThrow(/workspace_inside_data_directory/);
    }
  });

  describe("the browser's and the credential broker's secret files", () => {
    let outside: string;
    beforeEach(async () => {
      outside = join(base, "outside");
      await mkdir(outside);
    });
    const secret = async (path: string) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "sk_live_reservedsecretvalue0000", { mode: 0o600 });
    };
    /** A policy file naming a credential read from `file`. */
    const policyWith = async (file: string, extra: Record<string, unknown> = {}) => {
      const path = join(outside, "policy.json");
      const credential = {
        source: { file },
        inject: { header: "Authorization", scheme: "Bearer" },
        hosts: ["api.example.com"],
        capability: "http.post:*",
      };
      await writeFile(path, JSON.stringify({ ...extra, credentials: { billing: credential } }), "utf8");
      return path;
    };
    const write = (path: string) =>
      request({
        operation: { kind: "file", action: "write", path, content: "x" },
        requiredEvidence: [{ type: "file_exists", path }],
      });

    it("are reserved wherever they lie, in every mode", async () => {
      await secret(join(workspace, "secrets", "billing.key"));
      await secret(join(workspace, "profile", "Default", "Cookies"));
      await secret(join(outside, "replay.har"));
      runtime = await createMelraRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        environment: {},
        policyPath: await policyWith(join(workspace, "secrets", "billing.key")),
        browserProfileDir: join(workspace, "profile"),
        // Its directory is not there until the browser first starts.
        browserHarPath: join(workspace, "recordings", "session.har"),
      });
      for (const task of [
        request({ operation: { kind: "file", action: "read", path: join("secrets", "billing.key") } }),
        request({ operation: { kind: "file", action: "read", path: join("profile", "Default", "Cookies") } }),
        write(join("recordings", "session.har")),
      ]) {
        expect((await run(task)).task.error, JSON.stringify(task.operation)).toMatch(/path_reserved/);
      }
      expect((await run(terminal("head", [join("profile", "Default", "Cookies")]))).task.error).toMatch(
        /terminal_path_reserved/,
      );
      // A workspace holding them is still an ordinary one in developer mode.
      expect((await run(terminal("node", ["-e", "", "."], true))).task.status).toBe("verified_success");
      await runtime.close();
      // Unsafe-local reaches every other file, but not these.
      runtime = await createMelraRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        environment: {},
        unhinged: true,
        policyPath: await policyWith(join(workspace, "secrets", "billing.key")),
        browserHarReplayPath: join(outside, "replay.har"),
      });
      expect((await run(terminal("cat", [join(outside, "replay.har")]))).task.error).toMatch(/terminal_path_reserved/);
      expect((await run(terminal("tail", [join(workspace, "secrets", "billing.key")]))).task.error).toMatch(
        /terminal_path_reserved/,
      );
    });

    it("refuse enforced mode when the workspace holds one, naming it, and stay refused outside it once approved", async () => {
      const enforced = { MELRA_MODE: "enforced" };
      await secret(join(workspace, "secrets", "billing.key"));
      await secret(join(workspace, "replay.har"));
      for (const [options, name] of [
        [{ browserProfileDir: join(workspace, "profile") }, "MELRA_BROWSER_PROFILE"],
        [{ browserHarPath: join(workspace, "recordings", "session.har") }, "MELRA_BROWSER_HAR_PATH"],
        [{ browserHarReplayPath: join(workspace, "replay.har") }, "MELRA_BROWSER_HAR_REPLAY"],
        [{ policyPath: await policyWith(join(workspace, "secrets", "billing.key")) }, "credentials.billing"],
      ] as const) {
        await expect(
          createMelraRuntime({ workspaceRoot: workspace, dataDirectory: data, environment: enforced, ...options }),
          name,
        ).rejects.toThrow(`enforced_mode_refuses_secret_inside_workspace: ${name}`);
      }
      await secret(join(outside, "billing.key"));
      runtime = await createMelraRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        environment: enforced,
        policyPath: await policyWith(join(outside, "billing.key")),
        browserProfileDir: join(outside, "profile"),
      });
      const planned = runtime.controller.plan(terminal("cat", [join(outside, "billing.key")]));
      expect(planned.policyDecision.reason).toBe("read_outside_workspace");
      runtime.controller.decide(planned.id, runtime.controller.approvalView(planned.id).renderDigest, "cli:test");
      expect((await runtime.controller.execute(planned.id)).task.error).toMatch(/terminal_path_reserved/);
    });

    it("refuse, in every mode, a workspace inside the browser profile", async () => {
      const profile = join(base, "profile");
      await mkdir(join(profile, "Default"), { recursive: true });
      for (const [workspaceRoot, environment] of [
        [profile, {}],
        [join(profile, "Default"), {}],
        [join(profile, "Default"), { MELRA_MODE: "enforced" }],
        [join(profile, "Default"), { MELRA_UNHINGED: "1" }],
      ] as const) {
        await expect(
          createMelraRuntime({ workspaceRoot, dataDirectory: data, environment, browserProfileDir: profile }),
          `${workspaceRoot} ${JSON.stringify(environment)}`,
        ).rejects.toThrow(/workspace_inside_browser_profile/);
      }
    });
  });
});

describe("a broad workspace", () => {
  let base: string;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "melra-broad-")));
  });

  afterEach(async () => {
    // Restored in place, so os.homedir() reads the real environment again.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(base, { recursive: true, force: true });
  });

  it("is home, a directory holding it, or a filesystem root, however it is spelled", async () => {
    const home = join(base, "home");
    await mkdir(join(home, "project"), { recursive: true });
    await mkdir(join(base, "beside"));
    await symlink(home, join(base, "link"));
    expect(await broadWorkspace(home, home)).toBe("home");
    // Through a link, either side: a symlinked home is still home.
    expect(await broadWorkspace(join(base, "link"), home)).toBe("home");
    expect(await broadWorkspace(home, join(base, "link"))).toBe("home");
    // What holds home holds every user's files, as /Users, /home or C:\Users do.
    expect(await broadWorkspace(base, home)).toBe("holds-home");
    // A project under home, or a directory beside it, is the ordinary case.
    expect(await broadWorkspace(join(home, "project"), home)).toBeUndefined();
    expect(await broadWorkspace(join(base, "beside"), home)).toBeUndefined();
    // `/`, or the drive root on Windows.
    expect(await broadWorkspace(parse(base).root, home)).toBe("root");
    // One that does not resolve is doctor's to report.
    expect(await broadWorkspace(join(base, "missing"), home)).toBeUndefined();
    // macOS reaches every directory on the data volume through the
    // /System/Volumes/Data firmlink too, which realpath does not fold.
    const firmlink = join("/System/Volumes/Data", home);
    if (existsSync(firmlink)) {
      expect(await broadWorkspace(firmlink, home)).toBe("home");
      expect(await broadWorkspace(join("/System/Volumes/Data", base), home)).toBe("holds-home");
      expect(await broadWorkspace("/System/Volumes/Data", home)).toBe("holds-home");
      expect(await broadWorkspace(join(firmlink, "project"), home)).toBeUndefined();
    }
  });

  it("is what an enforced refusal tells you to narrow, keeping MELRA_HOME where it is", async () => {
    Object.assign(process.env, { HOME: base, USERPROFILE: base });
    const refusal = (workspaceRoot: string, policyPath?: string) =>
      expect(
        createMelraRuntime({
          workspaceRoot,
          dataDirectory: join(base, ".melra"),
          environment: { MELRA_MODE: "enforced" },
          ...(policyPath === undefined ? {} : { policyPath }),
        }),
      ).rejects;
    // Home holding the default ~/.melra, as from a fresh terminal. Not "run
    // setup", which does not change the workspace `approve` or `console` use.
    const narrow =
      "enforced_mode_refuses_data_inside_workspace: set MELRA_WORKSPACE to your project directory, " +
      "or run this from there; keep MELRA_HOME where it is (moving it orphans the database).";
    await refusal(base).toThrow(narrow);
    // Above home, likewise.
    await refusal(dirname(base)).toThrow(narrow);
    // The shared policy only narrows the workspace, so the advice stands.
    await mkdir(join(base, ".melra"), { recursive: true });
    await writeFile(join(base, ".melra", "policy.json"), "{}");
    await refusal(base, join(base, ".melra", "policy.json")).toThrow(narrow);
    // An operator's policy file can pin the workspace, so running from the
    // project would not help; its workspaceRoot would.
    await writeFile(join(base, "team.json"), "{}");
    await refusal(base, join(base, "team.json")).toThrow(
      `set MELRA_WORKSPACE to your project directory, or make that the workspaceRoot in ${join(base, "team.json")}; ` +
        "keep MELRA_HOME where it is",
    );
    // MELRA_HOME inside a project under home: narrowing comes first, but it
    // is not told to stay, since the next refusal would say to move it.
    await expect(
      createMelraRuntime({
        workspaceRoot: base,
        dataDirectory: join(base, "project", ".melra"),
        environment: { MELRA_MODE: "enforced" },
      }),
    ).rejects.toThrow(
      /^enforced_mode_refuses_data_inside_workspace: set MELRA_WORKSPACE to your project directory, or run this from there\.$/,
    );
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
