// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
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
