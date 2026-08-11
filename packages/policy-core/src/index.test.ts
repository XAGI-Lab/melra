// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import {
  classifyCommand,
  classifyOperation,
  createDefaultPolicy,
  defaultEvidenceFor,
  evaluatePolicy,
  validateApproval,
} from "./index.js";

const root = "/tmp/melra-policy-test";

describe("local policy", () => {
  it("allows a read-only file operation", () => {
    const request = TaskRequestSchema.parse({
      goal: "Read the changelog",
      operation: { kind: "file", action: "read", path: "CHANGELOG.md" },
    });
    const result = evaluatePolicy(
      "4c5a0130-71a5-4c48-b22d-c7901f12688f",
      request,
      createDefaultPolicy(root),
    );
    expect(result.decision.outcome).toBe("allow");
    expect(result.challenge).toBeUndefined();
  });

  it("requires evidence and approval for mutation", () => {
    const missingEvidence = TaskRequestSchema.parse({
      goal: "Write a file",
      operation: {
        kind: "file",
        action: "write",
        path: "result.txt",
        content: "verified",
      },
    });
    expect(
      evaluatePolicy(
        "b47dded2-4e20-4d96-a993-fdf6b0034664",
        missingEvidence,
        createDefaultPolicy(root),
      ).decision.reason,
    ).toBe("mutation_requires_evidence");

    const request = TaskRequestSchema.parse({
      ...missingEvidence,
      requiredEvidence: [{ type: "file_exists", path: "result.txt" }],
    });
    const result = evaluatePolicy(
      "b47dded2-4e20-4d96-a993-fdf6b0034664",
      request,
      createDefaultPolicy(root),
    );
    expect(result.decision.outcome).toBe("confirm");
    expect(result.challenge?.phrase).toMatch(/^APPROVE [a-f0-9]{12}$/);
  });

  it("denies shells even if added to the allowlist", () => {
    const request = TaskRequestSchema.parse({
      goal: "Run an unrestricted shell",
      operation: {
        kind: "terminal",
        action: "run",
        command: "bash",
        args: ["-lc", "echo unsafe"],
      },
    });
    const policy = createDefaultPolicy(root);
    policy.allowedCommands.push("bash");
    expect(
      evaluatePolicy(
        "71942756-af2a-407d-806e-73d7bb4fe5d0",
        request,
        policy,
      ).decision.reason,
    ).toBe("command_not_allowlisted");
  });

  it("allows computer inspection but gates input behind evidence and approval", () => {
    const inspect = TaskRequestSchema.parse({
      goal: "Inspect local computer-use support",
      operation: { kind: "computer", action: "capabilities" },
    });
    expect(
      evaluatePolicy(
        "c4e05bc0-c809-4ba3-a2a4-69102cdcf688",
        inspect,
        createDefaultPolicy(root),
      ).decision.outcome,
    ).toBe("allow");

    const click = TaskRequestSchema.parse({
      goal: "Click a verified desktop target",
      operation: {
        kind: "computer",
        action: "click",
        coordinateSpace: "normalized",
        x: 0.5,
        y: 0.5,
      },
      requiredEvidence: [
        { type: "result_equals", path: "success", value: true },
      ],
    });
    const decision = evaluatePolicy(
      "1aa2432a-a584-4b3f-b256-9ac3a6887630",
      click,
      createDefaultPolicy(root),
    );
    expect(decision.decision.outcome).toBe("confirm");
    expect(decision.decision.risk).toBe("high");
  });

  it("validates the scoped approval phrase", () => {
    const request = TaskRequestSchema.parse({
      goal: "Store a memory",
      operation: {
        kind: "memory",
        action: "put",
        scope: "workspace",
        key: "project",
        value: "MELRA",
      },
      requiredEvidence: [
        { type: "result_equals", path: "stored", value: true },
      ],
    });
    const result = evaluatePolicy(
      "db65d7da-9d59-46a7-86f7-aa1bd205382c",
      request,
      createDefaultPolicy(root),
    );
    const challenge = result.challenge;
    expect(challenge).toBeDefined();
    expect(
      validateApproval(challenge, {
        approvalId: challenge!.approvalId,
        phrase: challenge!.phrase,
      }),
    ).toEqual({ ok: true });
  });

  it("never silently ignores caller constraints or forbidden effects", () => {
    const constrained = TaskRequestSchema.parse({
      goal: "Read with an unenforceable natural-language constraint",
      operation: { kind: "file", action: "read", path: "README.md" },
      constraints: ["only if the file is recent"],
    });
    expect(
      evaluatePolicy(
        "ae8e57dd-e9f7-4821-82d7-ce50dc896008",
        constrained,
        createDefaultPolicy(root),
      ).decision.reason,
    ).toBe("freeform_constraints_not_enforceable");

    const forbidden = TaskRequestSchema.parse({
      goal: "Do not permit a mutation",
      operation: {
        kind: "file",
        action: "write",
        path: "result.txt",
        content: "blocked",
      },
      forbiddenEffects: ["mutate"],
      requiredEvidence: [{ type: "file_exists", path: "result.txt" }],
    });
    expect(
      evaluatePolicy(
        "e299a821-8dbf-4784-8ecf-f79d6812cc64",
        forbidden,
        createDefaultPolicy(root),
      ).decision.reason,
    ).toBe("effect_forbidden_by_request");
  });

  it("allows a browser navigation with the shipped defaults", () => {
    // Regression: allowedDomains defaulted to [] and denied every navigation
    // out of the box, which is what made browser use unusable on a fresh install.
    const request = TaskRequestSchema.parse({
      goal: "Open a docs page",
      operation: {
        kind: "browser",
        action: "navigate",
        url: "https://example.com/docs",
      },
    });
    expect(
      evaluatePolicy(
        "0f9e6d2a-3c41-4b8e-9a77-1d5b8c2e4f60",
        request,
        createDefaultPolicy(root),
      ).decision.outcome,
    ).toBe("allow");
  });
});

describe("default evidence", () => {
  it("derives the obvious post-condition per file action", () => {
    expect(
      defaultEvidenceFor({
        kind: "file",
        action: "write",
        path: "out.txt",
        encoding: "utf8",
        recursive: false,
      }),
    ).toEqual([{ type: "file_exists", path: "out.txt" }]);
    expect(
      defaultEvidenceFor({
        kind: "file",
        action: "delete",
        path: "out.txt",
        encoding: "utf8",
        recursive: false,
      }),
    ).toEqual([{ type: "file_absent", path: "out.txt" }]);
    expect(
      defaultEvidenceFor({
        kind: "file",
        action: "move",
        path: "a.txt",
        destination: "b.txt",
        encoding: "utf8",
        recursive: false,
      }),
    ).toEqual([
      { type: "file_absent", path: "a.txt" },
      { type: "file_exists", path: "b.txt" },
    ]);
  });

  it("derives nothing for a terminal run, so it still denies", () => {
    // The request says nothing about what the command should leave behind, so
    // there is no honest post-condition to synthesize.
    expect(
      defaultEvidenceFor({
        kind: "terminal",
        action: "run",
        command: "npm",
        args: ["run", "build"],
        interactive: false,
        appendNewline: true,
        timeoutMs: 30_000,
        maxOutputChars: 100_000,
      }),
    ).toEqual([]);
  });

  it("derives nothing for a read, which already has a fallback", () => {
    expect(
      defaultEvidenceFor({
        kind: "file",
        action: "read",
        path: "a.txt",
        encoding: "utf8",
        recursive: false,
      }),
    ).toEqual([]);
  });

  it("matches the field each memory action actually reports", () => {
    expect(
      defaultEvidenceFor({
        kind: "memory",
        action: "put",
        scope: "workspace",
        key: "k",
        value: "v",
        confidence: 1,
        tags: [],
        includeSuperseded: false,
        limit: 20,
      }),
    ).toEqual([{ type: "result_equals", path: "stored", value: true }]);
    // `clear` reports a count, not a boolean, so nothing is derivable.
    expect(
      defaultEvidenceFor({
        kind: "memory",
        action: "clear",
        scope: "workspace",
        confidence: 1,
        tags: [],
        includeSuperseded: false,
        limit: 20,
      }),
    ).toEqual([]);
  });

  it("holds a browser mutation to the flag the runtime actually reports", () => {
    // This predicate is only honest because `BrowserRuntime.execute` stamps
    // `success: true` on every result. It did not, so a click with no declared
    // evidence executed, mutated the page, and then verified as `partial`
    // because the derived predicate read a key nobody wrote.
    expect(
      defaultEvidenceFor({
        kind: "browser",
        action: "click",
        target: { selector: "#go" },
        fullPage: false,
        timeoutMs: 30_000,
        settleQuietMs: 180,
        settleTimeoutMs: 1_500,
        maxChars: 20_000,
        delayMs: 0,
        clearFirst: true,
        pixels: 600,
      }),
    ).toEqual([{ type: "result_equals", path: "success", value: true }]);
  });
});

describe("Windows command spellings", () => {
  const plan = (command: string, args: string[] = []) =>
    evaluatePolicy(
      "00000000-0000-4000-8000-000000000000",
      TaskRequestSchema.parse({
        goal: "Run an allowlisted program",
        operation: { kind: "terminal", action: "run", command, args },
        requiredEvidence: [{ type: "exit_code", value: 0 }],
      }),
      createDefaultPolicy(root),
    ).decision;

  it("accepts the extension-qualified spelling Windows actually runs", () => {
    // The deadlock this closes: `npm` passed policy but is a `.cmd` shim that
    // cannot be spawned, while `npm.cmd` could be spawned but was denied — so on
    // Windows no spelling of an allowlisted command worked at all.
    expect(plan("npm").reason).not.toBe("command_not_allowlisted");
    expect(plan("npm.cmd").reason).not.toBe("command_not_allowlisted");
    expect(plan("C:\\Program Files\\nodejs\\npm.cmd").reason).not.toBe(
      "command_not_allowlisted",
    );
  });

  it("still denies a shell however it is spelled", () => {
    // Normalisation must apply to the deny list too, or stripping the extension
    // would have turned it into a bypass.
    for (const command of [
      "powershell",
      "powershell.exe",
      "PowerShell.EXE",
      "C:\\Windows\\System32\\cmd.exe",
      "pwsh.exe",
      "/bin/bash",
    ]) {
      expect(plan(command).reason).toBe("command_not_allowlisted");
    }
  });

  it("does not strip a suffix that is merely part of the name", () => {
    // `python3.11` ends in a dot-segment but not an executable suffix.
    expect(plan("python3.11").reason).toBe("command_not_allowlisted");
  });

  it("classifies a Windows-spelled read command without demanding approval", () => {
    expect(plan("git.exe", ["status"]).effect).toBe("read");
    expect(plan("git.exe", ["push"]).effect).toBe("mutate");
    expect(plan("npm.cmd", ["install"]).risk).toBe("high");
  });
});

describe("interactive terminal input", () => {
  const send = (jobId?: string) =>
    evaluatePolicy(
      "00000000-0000-4000-8000-000000000000",
      TaskRequestSchema.parse({
        goal: "Answer a prompt",
        operation: {
          kind: "terminal",
          action: "send",
          ...(jobId === undefined ? {} : { jobId }),
          input: "y",
        },
        // What `defaultEvidenceFor` supplies on the controller's path; spelled
        // out here because `evaluatePolicy` does not derive it.
        requiredEvidence: [{ type: "result_equals", path: "sent", value: true }],
      }),
      createDefaultPolicy(root),
    );

  it("gates on the job id, since the command was allowlisted at start", () => {
    // `send` carries no command, so the allowlist has nothing to match. Falling
    // through to the command branch would deny every prompt answer outright.
    expect(send().decision.reason).toBe("command_not_allowlisted");
    const decision = send("d1a4c4de-1b0e-4e17-9f4d-2f5c9b6a71e2").decision;
    expect(decision.outcome).toBe("confirm");
    expect(decision.effect).toBe("mutate");
  });

  it("derives the post-condition the runtime actually reports", () => {
    // Without this, a `send` with no declared evidence is denied for missing
    // evidence and interactive commands are unusable through the default path.
    expect(
      defaultEvidenceFor({
        kind: "terminal",
        action: "send",
        jobId: "d1a4c4de-1b0e-4e17-9f4d-2f5c9b6a71e2",
        input: "y",
        interactive: false,
        appendNewline: true,
        timeoutMs: 30_000,
        maxOutputChars: 100_000,
      } as never),
    ).toEqual([{ type: "result_equals", path: "sent", value: true }]);
  });
});

describe("unhinged mode", () => {
  const unhinged = { ...createDefaultPolicy(root), unhinged: true };
  const plan = (request: unknown, policy = unhinged) =>
    evaluatePolicy(
      "00000000-0000-4000-8000-000000000000",
      TaskRequestSchema.parse(request),
      policy,
    );

  it("is off unless something explicitly turns it on", () => {
    expect(createDefaultPolicy(root).unhinged).toBe(false);
  });

  it("allows a shell, an unlisted command, and evidence-free destruction", () => {
    for (const operation of [
      { kind: "terminal", action: "run", command: "bash", args: ["-c", "id"] },
      { kind: "terminal", action: "run", command: "curl", args: ["example.com"] },
      { kind: "file", action: "delete", path: "everything" },
    ]) {
      const result = plan({ goal: "Do it anyway", operation });
      expect(result.decision.outcome).toBe("allow");
      expect(result.decision.reason).toBe("unhinged_mode_no_guardrails");
      // No challenge means no approval step: nothing to echo back, nothing to
      // expire. That is the whole point of the mode and the whole danger of it.
      expect(result.challenge).toBeUndefined();
    }
  });

  it("reports the real effect and risk rather than flattening them", () => {
    // Allowing everything is not the same as pretending everything is harmless:
    // the receipt still has to say a destructive operation was destructive.
    const result = plan({
      goal: "Delete it",
      operation: { kind: "file", action: "delete", path: "everything" },
    });
    expect(result.decision.effect).toBe("destructive");
    expect(result.decision.risk).toBe("high");
  });

  it("still honours limits the caller declared on its own request", () => {
    // `forbiddenEffects` and `constraints` are the caller bounding its own task,
    // not MELRA imposing a guardrail, so unhinged mode does not overrule them.
    expect(
      plan({
        goal: "Delete it",
        operation: { kind: "file", action: "delete", path: "everything" },
        forbiddenEffects: ["destructive"],
      }).decision.reason,
    ).toBe("effect_forbidden_by_request");
    expect(
      plan({
        goal: "Delete it",
        operation: { kind: "file", action: "delete", path: "everything" },
        constraints: ["be careful"],
      }).decision.reason,
    ).toBe("freeform_constraints_not_enforceable");
  });

  it("changes nothing for a policy that did not ask for it", () => {
    expect(
      plan(
        {
          goal: "Run a shell",
          operation: { kind: "terminal", action: "run", command: "bash" },
          requiredEvidence: [{ type: "exit_code", value: 0 }],
        },
        createDefaultPolicy(root),
      ).decision.reason,
    ).toBe("command_not_allowlisted");
  });
});

describe("capability traits", () => {
  const terminal = (command: string, args: string[] = []) =>
    classifyOperation({
      kind: "terminal",
      action: "run",
      command,
      args,
      env: {},
      timeoutMs: 30_000,
      maxOutputChars: 10_000,
    } as never);

  it("tells a package manager's subcommands apart", () => {
    // The old rule was the command's name alone, so all three of these were
    // high-risk mutations — including the one that only reads.
    expect(terminal("npm", ["ls"]).effect).toBe("read");
    expect(terminal("npm", ["run", "build"])).toMatchObject({
      effect: "mutate",
      risk: "medium",
      traits: [],
    });
    expect(terminal("npm", ["install", "left-pad"])).toMatchObject({
      effect: "mutate",
      risk: "high",
      traits: ["package-install", "network"],
    });
  });

  it("reads past flags to find the subcommand", () => {
    expect(classifyCommand("npm", ["--silent", "install"]).traits).toContain(
      "package-install",
    );
    expect(classifyCommand("git", ["-c", "core.pager=cat", "push"])).toEqual({
      read: false,
      traits: ["network"],
    });
  });

  it("marks commands that reach another host", () => {
    expect(classifyCommand("curl", ["https://example.com"]).traits).toEqual([
      "network",
    ]);
    expect(classifyCommand("git", ["status"])).toEqual({
      read: true,
      traits: [],
    });
    expect(classifyCommand("npx", ["cowsay"]).traits).toEqual([
      "package-install",
      "network",
    ]);
    // Browsing is a network act too, so denying `network` denies it as well.
    expect(
      classifyOperation({
        kind: "browser",
        action: "navigate",
        url: "https://example.com",
      } as never).traits,
    ).toEqual(["network"]);
  });

  it("refuses a denied trait before the allowlist is consulted", () => {
    const policy = createDefaultPolicy(root);
    policy.deniedTraits = ["package-install"];
    const run = (args: string[]) =>
      evaluatePolicy(
        "4c5a0130-71a5-4c48-b22d-c7901f12688f",
        TaskRequestSchema.parse({
          goal: "Use npm",
          operation: { kind: "terminal", action: "run", command: "npm", args },
          requiredEvidence: [{ type: "exit_code", value: 0 }],
        }),
        policy,
      ).decision;

    // `allowedCommands` matches on the basename, so it cannot express this.
    expect(run(["install", "left-pad"])).toMatchObject({
      outcome: "deny",
      reason: "trait_denied:package-install",
    });
    expect(run(["run", "test"]).outcome).toBe("confirm");
  });

  it("allows a denied trait when there are no guardrails at all", () => {
    const policy = { ...createDefaultPolicy(root), unhinged: true };
    policy.deniedTraits = ["network"];
    expect(
      evaluatePolicy(
        "4c5a0130-71a5-4c48-b22d-c7901f12688f",
        TaskRequestSchema.parse({
          goal: "Fetch a page",
          operation: { kind: "browser", action: "navigate", url: "https://example.com" },
        }),
        policy,
      ).decision.reason,
    ).toBe("unhinged_mode_no_guardrails");
  });
});

describe("capability grants", () => {
  const taskId = "4c5a0130-71a5-4c48-b22d-c7901f12688f";
  const identity = {
    principal: { kind: "agent", id: "claude-code" },
    onBehalfOf: [
      { kind: "organization", id: "acme" },
      { kind: "human", id: "dheeraj" },
    ],
  };
  const read = (extra: Record<string, unknown> = {}) =>
    TaskRequestSchema.parse({
      goal: "Read the changelog",
      operation: { kind: "file", action: "read", path: "CHANGELOG.md" },
      ...extra,
    });
  const grant = (overrides: Record<string, unknown> = {}) => ({
    id: "g1",
    capability: "file.*",
    effects: ["read"],
    target: "*",
    principal: "agent:claude-code",
    ...overrides,
  });
  const decide = (
    request: ReturnType<typeof read>,
    capabilities: ReturnType<typeof grant>[],
  ) =>
    evaluatePolicy(taskId, request, {
      ...createDefaultPolicy(root),
      capabilities: capabilities as never,
    }).decision;

  it("leaves policy alone when no grants are issued", () => {
    expect(decide(read({ identity }), []).outcome).toBe("allow");
  });

  it("denies an effect no grant covers", () => {
    expect(decide(read({ identity }), [grant({ capability: "browser.*" })])).toMatchObject({
      outcome: "deny",
      reason: "capability_not_granted:file.read",
    });
  });

  it("matches the capability, effect, target, and holder", () => {
    expect(decide(read({ identity }), [grant()]).outcome).toBe("allow");
    // Same grant, different holder.
    expect(
      decide(read({ identity }), [grant({ principal: "agent:other" })]).reason,
    ).toBe("capability_not_granted:file.read");
    // Same holder, target outside the grant.
    expect(decide(read({ identity }), [grant({ target: "/elsewhere/*" })]).reason).toBe(
      "capability_not_granted:file.read",
    );
  });

  it("refuses a grant that has expired or names another policy version", () => {
    expect(
      decide(read({ identity }), [grant({ validUntil: "2020-01-01T00:00:00.000Z" })]),
    ).toMatchObject({ outcome: "deny", reason: "capability_expired:g1" });
    expect(
      decide(read({ identity }), [grant({ policyVersion: "99" })]).reason,
    ).toBe("capability_policy_version_mismatch:g1");
  });

  it("falls back to the local principal when the caller declares none", () => {
    expect(decide(read(), [grant({ principal: "agent:local" })]).outcome).toBe("allow");
    expect(decide(read(), [grant()]).reason).toBe("capability_not_granted:file.read");
  });

  it("grants nothing when there are no guardrails at all", () => {
    expect(
      evaluatePolicy(taskId, read({ identity }), {
        ...createDefaultPolicy(root),
        unhinged: true,
        capabilities: [grant({ capability: "browser.*" })] as never,
      }).decision.reason,
    ).toBe("unhinged_mode_no_guardrails");
  });
});

describe("http destinations", () => {
  const request = (fields: Record<string, unknown>) =>
    TaskRequestSchema.parse({
      goal: "Call an API",
      operation: { kind: "http", action: "request", ...fields },
      requiredEvidence: [{ type: "result_equals", path: "success", value: true }],
    });
  const taskId = "b4b6f2a1-6f2e-4d5a-9c3e-8a1d0f7c2b34";

  it("classifies by method, not by kind", () => {
    expect(
      classifyOperation({
        kind: "http",
        action: "request",
        method: "GET",
        url: "https://api.example.com/v1/orders?page=2",
        maxResponseBytes: 1_000,
        timeoutMs: 1_000,
      }),
    ).toMatchObject({
      effect: "read",
      capability: "http.get",
      // The query is dropped so a capability pattern matches the resource, not
      // whatever token happened to be stapled to the URL.
      target: "https://api.example.com/v1/orders",
      traits: ["network"],
    });
    expect(
      classifyOperation({
        kind: "http",
        action: "request",
        method: "POST",
        url: "https://api.example.com/v1/orders",
        maxResponseBytes: 1_000,
        timeoutMs: 1_000,
      }),
    ).toMatchObject({ effect: "mutate", capability: "http.post" });
  });

  it("holds an HTTP mutation to the same evidence rule as any other", () => {
    const missing = TaskRequestSchema.parse({
      goal: "Create an order",
      operation: {
        kind: "http",
        action: "request",
        method: "POST",
        url: "https://api.example.com/v1/orders",
      },
    });
    expect(
      evaluatePolicy(taskId, missing, createDefaultPolicy(root)).decision.reason,
    ).toBe("mutation_requires_evidence");
    expect(
      evaluatePolicy(
        taskId,
        request({ method: "POST", url: "https://api.example.com/v1/orders" }),
        createDefaultPolicy(root),
      ).decision.outcome,
    ).toBe("confirm");
  });

  it("applies the domain allowlist to HTTP, not only to the browser", () => {
    const policy = {
      ...createDefaultPolicy(root),
      allowedDomains: ["api.example.com"],
    };
    expect(
      evaluatePolicy(
        taskId,
        request({ url: "https://api.example.com/v1/orders" }),
        policy,
      ).decision.outcome,
    ).toBe("allow");
    expect(
      evaluatePolicy(taskId, request({ url: "https://attacker.test/" }), policy)
        .decision.reason,
    ).toBe("destination_domain_not_allowed");
  });

  it("refuses an HTTP call when the network trait is denied", () => {
    expect(
      evaluatePolicy(taskId, request({ url: "https://api.example.com/" }), {
        ...createDefaultPolicy(root),
        deniedTraits: ["network"],
      }).decision.reason,
    ).toBe("trait_denied:network");
  });

  it("derives the response-status post-condition for a mutation", () => {
    expect(
      defaultEvidenceFor({
        kind: "http",
        action: "request",
        method: "POST",
        url: "https://api.example.com/v1/orders",
        maxResponseBytes: 1_000,
        timeoutMs: 1_000,
      }),
    ).toEqual([{ type: "result_equals", path: "success", value: true }]);
  });
});

describe("metered capability grants", () => {
  const taskId = "9f1d5b3a-4c2e-4a71-9d80-2b6f0c4e18aa";
  const spend = (amount: number) =>
    TaskRequestSchema.parse({
      goal: "Refund a charge",
      operation: {
        kind: "http",
        action: "request",
        method: "POST",
        url: "https://api.acme-pay.test/v1/refunds",
        spend: { provider: "acme-pay", amount, currency: "USD" },
      },
      requiredEvidence: [{ type: "result_equals", path: "success", value: true }],
    });
  const policyWith = (
    grant: Record<string, unknown>,
  ): Parameters<typeof evaluatePolicy>[2] => ({
    ...createDefaultPolicy(root),
    capabilities: [
      {
        id: "refunds",
        capability: "http.post",
        effects: ["mutate"],
        target: "*",
        principal: "*",
        ...grant,
      },
    ] as never,
  });
  /** A grant that has already drawn down this much. */
  const drawn = (operations: number, amountToday: number) => () => ({
    operations,
    amountToday,
  });

  it("carries the grant it authorised against, so the commit knows what to meter", () => {
    expect(
      evaluatePolicy(
        taskId,
        spend(1_000),
        policyWith({ maxOperations: 5, provider: { name: "acme-pay" } }),
        drawn(0, 0),
      ).grantId,
    ).toBe("refunds");
  });

  it("names the missing declaration rather than a missing grant", () => {
    // The grant covers `http.post` for this principal and is turned away on the
    // money block alone. `capability_not_granted` would send the caller looking
    // for a grant it already holds; these two say which fix applies.
    const undeclared = TaskRequestSchema.parse({
      goal: "Refund without saying what it moves",
      operation: {
        kind: "http",
        action: "request",
        method: "POST",
        url: "https://api.acme-pay.test/v1/refunds",
      },
      requiredEvidence: [{ type: "result_equals", path: "success", value: true }],
    });
    const policy = policyWith({ provider: { name: "acme-pay" } });
    expect(evaluatePolicy(taskId, undeclared, policy).decision.reason).toBe(
      "capability_spend_not_declared:http.post",
    );
    expect(
      evaluatePolicy(taskId, spend(100), policyWith({ provider: { name: "other-pay" } }))
        .decision.reason,
    ).toBe("capability_provider_mismatch:acme-pay");
  });

  it("refuses when the rolling daily total would go over", () => {    // Under the per-operation ceiling and inside the operation count. What is
    // exhausted is the day, which no other bound can see.
    expect(
      evaluatePolicy(
        taskId,
        spend(3_000),
        policyWith({
          provider: { name: "acme-pay", amountMax: 5_000, dailyMax: 8_000 },
        }),
        drawn(2, 6_000),
      ).decision.reason,
    ).toBe("capability_daily_limit_exceeded:refunds");
  });

  it("refuses a metered grant when nothing can count it", () => {
    // No reader. A budget nobody can count is not a budget, and treating an
    // uncountable one as full would make the metered grant the loosest kind.
    expect(
      evaluatePolicy(taskId, spend(1_000), policyWith({ maxOperations: 1 }))
        .decision.reason,
    ).toBe("capability_usage_unmeterable:refunds");
  });

  it("spends an exhausted grant's sibling rather than refusing", () => {
    // Two grants, one spent out. A grant list is a set of authorities, not a
    // single budget.
    const policy = {
      ...createDefaultPolicy(root),
      capabilities: [
        {
          id: "small",
          capability: "http.post",
          effects: ["mutate"],
          target: "*",
          principal: "*",
          maxOperations: 1,
        },
        {
          id: "large",
          capability: "http.post",
          effects: ["mutate"],
          target: "*",
          principal: "*",
          maxOperations: 100,
        },
      ] as never,
    };
    const evaluation = evaluatePolicy(taskId, spend(1_000), policy, (id) => ({
      operations: id === "small" ? 1 : 0,
      amountToday: 0,
    }));
    expect(evaluation.decision.outcome).toBe("confirm");
    expect(evaluation.grantId).toBe("large");
  });

  it("leaves an unmetered grant alone", () => {
    // No `maxOperations`, no `provider` — nothing to count, so nothing needs a
    // reader and the grant behaves exactly as it did before metering existed.
    expect(
      evaluatePolicy(taskId, spend(1_000), policyWith({})).decision.outcome,
    ).toBe("confirm");
  });
});
