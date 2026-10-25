// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PRODUCT_VERSION, TaskRequestSchema } from "@melra/protocol";
import {
  classifyCommand,
  classifyOperation,
  createDefaultPolicy,
  defaultEvidenceFor,
  evaluatePolicy,
  loadPolicy,
  validateApproval,
  type LocalPolicy,
} from "./index.js";

const root = "/tmp/melra-policy-test";

describe("approval window", () => {
  const write = () =>
    TaskRequestSchema.parse({
      goal: "Write",
      operation: { kind: "file", action: "write", path: "a.txt", content: "x" },
      requiredEvidence: [{ type: "file_exists", path: "a.txt" }],
    });
  afterEach(() => {
    vi.useRealTimers();
  });
  // On a stopped clock, so the window is exact rather than racing a tick.
  const window = (policy: LocalPolicy) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const { challenge } = evaluatePolicy("t", write(), policy);
    return Date.parse(challenge!.expiresAt);
  };

  it("gives an operator approving out of band longer in enforced mode", () => {
    const developer = createDefaultPolicy(root);
    expect(window(developer)).toBe(5 * 60_000);
    expect(window({ ...developer, mode: "enforced" })).toBe(30 * 60_000);
    // A window the policy names is the window, in either mode.
    expect(window({ ...developer, mode: "enforced", approvalTtlMs: 60_000 })).toBe(60_000);
  });

  it("refuses a window that would leave every challenge expired or open for good", async () => {
    const directory = await mkdtemp(join(tmpdir(), "melra-policy-"));
    try {
      const load = async (approvalTtlMs: unknown) => {
        const path = join(directory, "policy.json");
        await writeFile(path, JSON.stringify({ approvalTtlMs }));
        return loadPolicy(path, directory);
      };
      for (const bad of [0, -1, 1.5, "300000", 24 * 60 * 60_000 + 1]) {
        await expect(load(bad)).rejects.toThrow("policy_approval_ttl_invalid");
      }
      expect((await load(1)).approvalTtlMs).toBe(1);
      expect((await load(24 * 60 * 60_000)).approvalTtlMs).toBe(24 * 60 * 60_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("policy file", () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "melra-policy-file-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const file = () => join(directory, "policy.json");
  const load = async (policy: unknown) => {
    await writeFile(file(), JSON.stringify(policy));
    return loadPolicy(file(), directory);
  };

  it("refuses an empty allowlist entry, which an unset variable leaves", async () => {
    await expect(load({ allowedDomains: [""] })).rejects.toThrow(`policy_invalid: ${file()}: allowedDomains[0]:`);
    await expect(load({ allowedCommands: ["git", ""] })).rejects.toThrow(`policy_invalid: ${file()}: allowedCommands[1]:`);
  });

  it("refuses a key it does not know, at any depth, naming the file and the path", async () => {
    const unknown: Array<[unknown, string]> = [
      [{ allowedComands: ["git"] }, "allowedComands"],
      [{ mdoe: "enforced" }, "mdoe"],
      [{ memoryRetention: { maxAge: 3 } }, "memoryRetention.maxAge"],
      [{ circuitBreaker: { threshold: 3, cooldown: 1 } }, "circuitBreaker.cooldown"],
      [{ capabilities: [{ id: "r", capability: "file.read", effects: ["read"], scope: "x" }] }, "capabilities[0].scope"],
      [
        {
          credentials: {
            gh: { source: { env: "T" }, inject: { header: "A", schema: "B" }, hosts: ["h"], capability: "*" },
          },
        },
        "credentials.gh.inject.schema",
      ],
    ];
    for (const [policy, at] of unknown) {
      await expect(load(policy), at).rejects.toThrow(`policy_invalid: ${file()}: ${at}: unknown key`);
    }
  });

  it("refuses a value of the wrong type, at any depth, naming the file and the path", async () => {
    const wrong: Array<[unknown, string]> = [
      [{ allowedCommands: "git" }, "allowedCommands"],
      [{ allowLocalhost: "false" }, "allowLocalhost"],
      // A truthy string: read loosely, this one switched the guardrails off.
      [{ unhinged: "false" }, "unhinged"],
      [{ maxFileBytes: "10mb" }, "maxFileBytes"],
      [{ mutations: "Deny" }, "mutations"],
      [{ deniedTraits: ["packge-install"] }, "deniedTraits[0]"],
      [{ mode: 1 }, "mode"],
      [{ memoryRetention: { maxAgeDays: "30" } }, "memoryRetention.maxAgeDays"],
      [{ circuitBreaker: { threshold: "3" } }, "circuitBreaker.threshold"],
      [{ capabilities: [{ id: "r", capability: "file.read", effects: "read" }] }, "capabilities[0].effects"],
      [[], "(root)"],
    ];
    for (const [policy, at] of wrong) {
      await expect(load(policy), at).rejects.toThrow(`policy_invalid: ${file()}: ${at}: `);
    }
    // The mode's own code, but blamed on the file rather than MELRA_MODE.
    await expect(load({ mode: "enfroced" })).rejects.toThrow(
      `policy_invalid: ${file()}: mode: deployment_mode_unknown`,
    );
  });

  it("lists a bad approval window with the file's other problems, naming the file", async () => {
    // It was checked ahead of the schema: the window alone, and no file named.
    await expect(load({ approvalTtlMs: 0, bogus: 1 })).rejects.toThrow(
      new Error(
        `policy_invalid: ${file()}: approvalTtlMs: policy_approval_ttl_invalid: must be a whole number of milliseconds from 1 to 86400000 (24 hours); bogus: unknown key`,
      ),
    );
  });

  it("brackets a key that is not an identifier, and says what a credential source is", async () => {
    const credential = { source: { env: "T" }, inject: { header: "A" }, hosts: ["h"], capability: "*" };
    const source = 'expected {"env": ...} or {"file": ...}';
    const cases: Array<[unknown, string]> = [
      [{ credentials: { "a.b": { ...credential, inject: { header: "A", extra: 1 } } } }, 'credentials["a.b"].inject.extra: unknown key'],
      [{ credentials: { "": credential } }, 'credentials[""]: '],
      [{ "allowed-commands": [] }, '["allowed-commands"]: unknown key'],
      [{ credentials: { gh: { ...credential, source: { envv: "T" } } } }, `credentials.gh.source: ${source}`],
      [{ credentials: { gh: { ...credential, source: "T" } } }, `credentials.gh.source: ${source}`],
    ];
    for (const [policy, at] of cases) {
      await expect(load(policy), at).rejects.toThrow(`policy_invalid: ${file()}: ${at}`);
    }
  });

  it("says where a file stops being JSON, never what it says there", async () => {
    const refusal = async (text: string) => {
      await writeFile(file(), text);
      return loadPolicy(file(), directory).then(
        () => "loaded",
        (error: Error) => error.message,
      );
    };
    // V8 quotes the text around a bad token, a bare secret included.
    const token = `ghp_${"a1B2c3D4".repeat(4)}e5F6`;
    const secret = await refusal(`{"credentials": {"gh": ${token}}}`);
    expect(secret).toMatch(/: not valid JSON( at line \d+ column \d+)?$/);
    expect(secret.startsWith(`policy_invalid: ${file()}: `)).toBe(true);
    expect(secret).not.toContain("ghp_");
    // Where V8 gives a position, it is the line and column, counted from 1.
    expect(await refusal('{\n  "allowedCommands": ["git"],\n}')).toBe(
      `policy_invalid: ${file()}: not valid JSON at line 3 column 1`,
    );
  });

  it("fingerprints the file as sha256sum would, and the defaults by version", async () => {
    const text = JSON.stringify({ allowedCommands: ["git", "ls"] });
    await writeFile(file(), text);
    const loaded = await loadPolicy(file(), directory);
    expect(loaded.digest).toBe(`sha256:${createHash("sha256").update(text).digest("hex")}`);
    // One allowlist entry changed under the same label: only the digest says so.
    const edited = await load({ allowedCommands: ["git", "cat"] });
    expect(edited.version).toBe(loaded.version);
    expect(edited.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(edited.digest).not.toBe(loaded.digest);
    expect((await loadPolicy(undefined, directory)).digest).toBe(`default:${PRODUCT_VERSION}`);
    // Every decision made under a policy names it.
    const list = TaskRequestSchema.parse({
      goal: "List",
      operation: { kind: "file", action: "list", path: "." },
    });
    expect(evaluatePolicy("t", list, edited).decision).toMatchObject({
      policyVersion: "1",
      policyDigest: edited.digest,
    });
  });

  it("loads every committed example policy, and the one init writes", async () => {
    const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
    const found = (await readdir(examples, { recursive: true }))
      .filter((path) => basename(path) === "policy.json")
      .sort();
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const path of found) await loadPolicy(join(examples, path), directory);
    // What `melra init` writes: the defaults without a workspace, in a mode.
    const { workspaceRoot: _shared, ...defaults } = createDefaultPolicy(directory);
    expect(await load({ ...defaults, mode: "enforced" })).toEqual({
      ...createDefaultPolicy(directory),
      mode: "enforced",
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    // Unchanged semantics: a relative root is the file's, retention merges over
    // the defaults, and a grant gets its defaults.
    const loaded = await load({
      workspaceRoot: "inner",
      memoryRetention: { maxPerScope: 5 },
      capabilities: [{ id: "r", capability: "file.read", effects: ["read"] }],
    });
    expect(loaded.workspaceRoot).toBe(join(directory, "inner"));
    expect(loaded.memoryRetention).toEqual({ maxAgeDays: 30, maxPerScope: 5 });
    expect(loaded.capabilities[0]).toMatchObject({ target: "*", principal: "*" });
  });
});

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

  it("never lets a semantic question be the deciding evidence for a destructive effect (#54)", () => {
    const semantic = { type: "semantic", question: "Was the right thing removed?" };
    const decide = (operation: Record<string, unknown>, requiredEvidence: unknown[], policy = createDefaultPolicy(root)) =>
      evaluatePolicy(
        "b47dded2-4e20-4d96-a993-fdf6b0034665",
        TaskRequestSchema.parse({ goal: "Judge an effect", operation, requiredEvidence }),
        policy,
      ).decision;
    const deletion = { kind: "file", action: "delete", path: "result.txt", recursive: false };
    const forget = { kind: "memory", action: "delete", key: "note" };
    // Alone, or beside only the actor's own report.
    for (const evidence of [
      [semantic],
      [{ type: "result_equals", path: "deleted", value: true }, semantic],
      [{ type: "custom", verifier: "row_gone", params: {} }, semantic],
    ]) {
      expect(decide(deletion, evidence).reason, JSON.stringify(evidence)).toBe("semantic_only_destructive");
    }
    expect(decide(forget, [semantic, { type: "result_equals", path: "deleted", value: true }]).reason).toBe(
      "semantic_only_destructive",
    );
    // Beside evidence the kernel re-reads, a delete goes on to approval.
    expect(decide(deletion, [{ type: "file_absent", path: "result.txt" }, semantic]).outcome).toBe("confirm");
    // Not destructive: a write, and a read.
    expect(decide({ kind: "file", action: "write", path: "result.txt", content: "x" }, [semantic]).outcome).toBe("confirm");
    expect(decide({ kind: "file", action: "read", path: "result.txt" }, [semantic]).outcome).toBe("allow");
    // Unsafe-local lifts it with the other evidence rules.
    expect(decide(deletion, [semantic], { ...createDefaultPolicy(root), unhinged: true }).outcome).toBe("allow");
  });

  it("refuses a semantic question beside reconciliation, which cannot settle one, in every mode (#54)", () => {
    const semantic = { type: "semantic", question: "Is it right?" };
    const write = { kind: "file", action: "write", path: "result.txt", content: "x" };
    for (const policy of [createDefaultPolicy(root), { ...createDefaultPolicy(root), unhinged: true }]) {
      for (const [requiredEvidence, reconciliation] of [
        [[{ type: "file_exists", path: "result.txt" }, semantic], [{ type: "file_exists", path: "result.txt" }]],
        [[{ type: "file_exists", path: "result.txt" }], [semantic]],
      ]) {
        expect(
          evaluatePolicy(
            "b47dded2-4e20-4d96-a993-fdf6b0034666",
            TaskRequestSchema.parse({ goal: "Judge and reconcile", operation: write, requiredEvidence, reconciliation }),
            policy,
          ).decision.reason,
        ).toBe("semantic_evidence_not_reconcilable");
      }
    }
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

  it("denies every shell, privilege-escalation program and script host the docs name, even when allowlisted", () => {
    for (const command of [
      "ash", "busybox", "csh", "dash", "elvish", "ksh", "ksh93", "mksh", "nu", "oksh",
      "pdksh", "rbash", "tcsh", "toybox", "xonsh", "yash", "powershell_ise.exe", "wsl.exe",
      "doas", "gsudo.exe", "pkexec", "run0", "runas.exe", "runuser", "sudoedit",
      "cscript.exe", "mshta.exe", "WScript.exe", "sudo-rs", "su-rs", "lksh", "rlksh",
      "mksh-static", "rmksh", "bsd-csh", "ksu", "pfexec", "pwsh-preview.exe",
      "bash-static", "zsh-static", "rzsh", "rksh93", "pwsh-lts", "systemd-run",
    ]) {
      const policy = createDefaultPolicy(root);
      policy.allowedCommands.push(command);
      const decision = evaluatePolicy(
        "71942756-af2a-407d-806e-73d7bb4fe5d0",
        TaskRequestSchema.parse({
          goal: "Run an allowlisted program",
          operation: { kind: "terminal", action: "run", command, args: [] },
          requiredEvidence: [{ type: "exit_code", value: 0 }],
        }),
        policy,
      ).decision;
      expect(decision.reason, command).toBe("command_not_allowlisted");
    }
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
        phrase: challenge!.phrase!,
      }),
    ).toEqual({ ok: true });
  });

  it("issues no phrase in enforced mode, and developer mode's challenge is unchanged", () => {
    const write = TaskRequestSchema.parse({
      goal: "Write",
      operation: { kind: "file", action: "write", path: "x.txt", content: "x" },
      requiredEvidence: [{ type: "file_exists", path: "x.txt" }],
    });
    const id = "db65d7da-9d59-46a7-86f7-aa1bd205382c";
    const developer = evaluatePolicy(id, write, createDefaultPolicy(root)).challenge!;
    expect(Object.keys(developer)).toEqual(["approvalId", "taskId", "actionDigest", "phrase", "expiresAt"]);
    expect(developer.phrase).toBe(`APPROVE ${developer.actionDigest.slice(0, 12)}`);
    const enforced = evaluatePolicy(id, write, { ...createDefaultPolicy(root), mode: "enforced" }).challenge!;
    expect(Object.keys(enforced)).toEqual(["approvalId", "taskId", "actionDigest", "expiresAt"]);
    // The phrase it would have been is derivable, and matches nothing.
    expect(
      validateApproval(enforced, { approvalId: enforced.approvalId, phrase: `APPROVE ${enforced.actionDigest.slice(0, 12)}` }),
    ).toEqual({ ok: false, reason: "approval_phrase_mismatch" });
    // An in-process caller reading the missing phrase passes undefined, and
    // undefined is not a match for undefined.
    const { phrase: _phrase, ...withoutPhrase } = developer;
    expect(
      validateApproval(withoutPhrase, { approvalId: developer.approvalId, phrase: undefined as never }),
    ).toEqual({ ok: false, reason: "approval_phrase_mismatch" });
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
  });

  it("allows a path-qualified command only by its exact path, never as a read", () => {
    // A bare allowlist entry means the program on PATH. `tools/ls` is whatever
    // file sits there, a link to `/bin/sh` included, so it is not `ls`.
    for (const command of ["tools/ls", "./ls", "/usr/bin/git", "C:\\Program Files\\nodejs\\npm.cmd"]) {
      expect(plan(command).reason).toBe("command_not_allowlisted");
    }
    const exact = evaluatePolicy(
      "00000000-0000-4000-8000-000000000000",
      TaskRequestSchema.parse({
        goal: "Run a workspace script the operator allowlisted by path",
        operation: { kind: "terminal", action: "run", command: "scripts/check.sh", args: [] },
        requiredEvidence: [{ type: "exit_code", value: 0 }],
      }),
      { ...createDefaultPolicy(root), allowedCommands: ["scripts/check.sh"] },
    ).decision;
    expect(exact.reason).not.toBe("command_not_allowlisted");
    expect(exact.effect).not.toBe("read");
  });

  it("classifies a read only when every argument keeps it a read", () => {
    // Each of these ran a command, wrote outside the workspace, or changed
    // refs or config while classified as a read, so with no approval.
    for (const [command, args] of [
      ["git", ["-c", "core.fsmonitor=touch pwned", "status"]],
      ["git", ["-C", "/etc", "log"]],
      ["git", ["log", "-1", "--output=/tmp/out"]],
      ["git", ["diff", "--no-index", "/etc/passwd", "/dev/null"]],
      // Wins over the `--no-textconv` the runtime adds to a read, last flag first.
      ["git", ["show", "--textconv", "HEAD:notes.bin"]],
      ["git", ["branch", "-D", "main"]],
      ["git", ["branch", "new"]],
      ["git", ["tag", "-d", "v1"]],
      ["git", ["tag", "v2"]],
      ["rg", ["--pre", "node", "x", "."]],
      ["rg", ["--hostname-bin=/tmp/x", "x"]],
      ["rg", ["-iz", "x"]],
      ["npm", ["config", "set", "registry", "http://example.test"]],
      ["uv", ["lock"]],
      // `--color`, `--column` and `--abbrev` never take the next argument, so
      // it is still git's to act on.
      ["git", ["branch", "--color", "-D", "--color", "main"]],
      ["git", ["branch", "--column", "-M", "--abbrev", "a", "--color", "b"]],
      ["git", ["branch", "--color", "--set-upstream-to=main", "--color", "x"]],
      ["git", ["branch", "--abbrev", "new"]],
      ["git", ["tag", "--color", "-s", "--color", "-mx", "--color", "v8"]],
      // `--format` takes `-l` as its value, so git never lists and creates the name.
      ["git", ["branch", "--format", "-l", "new", "HEAD~1"]],
      ["git", ["tag", "--format", "--list", "v10"]],
      // Before git 2.20, `branch -l` was --create-reflog: this creates `new`.
      ["git", ["branch", "-l", "new", "HEAD~1"]],
      // Another spelling is not the subcommand: git looks it up as an alias.
      ["git", ["Status"]],
      ["git.exe", ["LOG"]],
      // Another machine, as the logged-on user.
      ["tasklist", ["/S", "10.0.0.5", "/U", "u", "/P", "p"]],
      ["tasklist.exe", ["-s", "attacker.example"]],
      ["findstr", ["/S", "/C:x", "\\\\attacker.example\\share\\*"]],
      ["findstr", ["/G:\\\\attacker.example\\share\\p", "x"]],
      ["cat", ["//attacker.example/share/f.txt"]],
      ["rg", ["--ignore-file=\\\\?\\UNC\\host\\share\\x", "x"]],
      ["npm", ["ls", "--userconfig=//host/share/npmrc"]],
      ["rg", ["x", "\\??\\UNC\\host\\share"]],
      ["rg", ["-f\\\\host\\share\\pats", "x"]],
      // Package-manager "reads" that write the lockfile, run build tools, or run
      // a program the repository names.
      ["uv", ["tree"]],
      ["cargo", ["tree"]],
      ["cargo", ["metadata"]],
      ["apt-get", ["download", "curl"]],
      ["go", ["list", "-toolexec", "touch pwned", "./..."]],
      ["go", ["vet", "-vettool=/tmp/x", "./..."]],
      ["go", ["env", "-w", "GOFLAGS=-mod=mod"]],
      ["yarn", ["info", "react"]],
      // Toolchain switching, interpreter selection, plugins, self-update.
      ["go", ["version"]],
      ["cargo", ["search", "serde"]],
      ["pip", ["--python=.venv/bin/python", "list"]],
      ["pip3", ["list", "--log", "/tmp/x.log"]],
      ["gem", ["list", "--config-file", "proj.gemrc"]],
      ["brew", ["outdated"]],
      ["apt", ["search", "x", "-o", "AptCli::Hooks::Search::=touch x"]],
      ["pnpm", ["ls"]],
      ["npm", ["ls", "--logs-dir", "/tmp/elsewhere"]],
      // Followed links and list files reach paths no argument names.
      ["rg", ["-L", "x"]],
      ["rg", ["--follow", "x"]],
      ["rg", ["-nL", "x"]],
      ["findstr", ["/F:list.txt", "x"]],
      ["findstr", ["/S", "/D:..;C:\\Users", "x", "*"]],
      ["wc", ["--files0-from=list"]],
    ] as const) {
      expect(classifyCommand(command, [...args]).read, `${command} ${args.join(" ")}`).toBe(false);
    }
    for (const [command, args] of [
      ["git", ["status", "--porcelain"]],
      ["git", ["log", "--oneline", "-5"]],
      ["git", ["diff", "HEAD~1", "--stat"]],
      ["git", ["branch", "-a", "-v"]],
      ["git", ["branch", "--list", "feat/*"]],
      ["git", ["branch", "--contains", "abc123"]],
      ["git", ["branch", "-l"]],
      ["git", ["branch", "--contains", "-r"]],
      ["git", ["branch", "--color", "-v", "--sort=-committerdate"]],
      ["git", ["branch", "--format", "%(refname)", "--list", "feat/*"]],
      ["git", ["tag", "-l", "v*"]],
      ["git", ["tag", "--sort", "-version:refname", "-l", "v*", "--color=always"]],
      ["tasklist", ["/V", "/FO", "CSV"]],
      ["findstr", ["/S", "/C:x", "src\\*"]],
      ["git", ["show", "HEAD:README.md"]],
      ["rg", ["-n", "TODO", "src"]],
    ] as const) {
      expect(classifyCommand(command, [...args]).read, `${command} ${args.join(" ")}`).toBe(true);
    }
  });

  it("classifies no npm call as a read", () => {
    // npm also takes its settings from `.npmrc` files in the workspace, which
    // policy never sees, and a setting there can send its log or cache
    // anywhere. No argument list can show that a call only reads.
    for (const args of [
      ["ls"],
      ["list", "--depth", "0"],
      ["view", "react"],
      ["info", "react"],
      ["outdated"],
      ["why", "react"],
      ["config", "get", "registry"],
      ["config", "list"],
    ]) {
      expect(classifyCommand("npm", args).read, `npm ${args.join(" ")}`).toBe(false);
      expect(plan("npm.cmd", args).effect, `npm.cmd ${args.join(" ")}`).toBe("mutate");
    }
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

describe("enforced-mode reads that leave the workspace", () => {
  const enforced = { ...createDefaultPolicy(root), mode: "enforced" as const };
  const outside = resolve(root, "..", "outside");
  const read = (command: string, args: string[], cwd?: string, policy: LocalPolicy = enforced) =>
    evaluatePolicy(
      "00000000-0000-4000-8000-000000000000",
      TaskRequestSchema.parse({
        goal: "Read",
        operation: { kind: "terminal", action: "run", command, args, ...(cwd === undefined ? {} : { cwd }) },
      }),
      policy,
    );
  const leaving: Array<[string, string[], string?]> = [
    ["cat", [resolve(root, "..", "x")]],
    ["cat", ["../x"]],
    ["ls", [".."]],
    ["rg", [`--ignore-file=${outside}`, "y"]],
    ["rg", [`-f${outside}`, "y"]],
    ["head", ["../../x"], "src"],
  ];

  it("shows a person a read that names a path outside the workspace, and no other", () => {
    for (const [command, args, cwd] of leaving) {
      const result = read(command, args, cwd);
      expect(result.decision, `${command} ${args.join(" ")}`).toMatchObject({
        outcome: "confirm",
        reason: "read_outside_workspace",
        effect: "read",
      });
      expect(result.challenge?.actionDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.challenge).not.toHaveProperty("phrase");
    }
    // Inside the workspace, however spelled, and every read in developer mode,
    // are as they were.
    for (const [command, args] of [
      ["cat", [resolve(root, "src", "x.ts")]],
      ["rg", ["-n", "TODO", "src"]],
      ["git", ["diff", "HEAD~1..HEAD", "--stat"]],
      ["head", ["-n", "1", "fixture.txt"]],
      ["rg", ["foo.*", "src"]],
      // An @ that is not a file reference still names something inside.
      ["git", ["show", "@~1"]],
      ["git", ["log", "@{u}"]],
      // No read here takes `@x` or `<x` as a file to read, so these are
      // patterns and names inside (`./@/x`); the runtime judges references.
      ["rg", ["-n", "</div>", "src"]],
      ["rg", ["-n", "@/components/Button", "src"]],
      ["rg", ["-F", "</script>", "index.html"]],
      ["rg", ["-e", "@/lib/utils", "src"]],
      ["cat", [`@${outside}`]],
      ["rg", ["-F", `--file=@${outside}`]],
    ] as const) {
      expect(read(command, [...args]).decision.reason, `${command} ${args.join(" ")}`).toBe("read_only_operation");
    }
    for (const [command, args, cwd] of leaving) {
      expect(read(command, args, cwd, createDefaultPolicy(root)).decision.outcome).toBe("allow");
    }
  });

  it("asks even when mutations are off, which still refuse a mutation", () => {
    const closed = { ...enforced, mutations: "deny" as const };
    expect(read("cat", ["../x"], undefined, closed).decision.reason).toBe("read_outside_workspace");
    const write = evaluatePolicy(
      "00000000-0000-4000-8000-000000000000",
      TaskRequestSchema.parse({
        goal: "Write",
        operation: { kind: "file", action: "write", path: "x.txt", content: "x" },
        requiredEvidence: [{ type: "file_exists", path: "x.txt" }],
      }),
      closed,
    );
    expect(write.decision.reason).toBe("mutations_disabled");
  });

  it.skipIf(process.platform !== "win32")("does not take a bare Windows switch for a path", () => {
    expect(read("findstr", ["/S", "/I", "x", "*.ts"]).decision.reason).toBe("read_only_operation");
    // A value attached to one is still judged.
    expect(read("findstr", [`/G:${outside}`, "x"]).decision.reason).toBe("read_outside_workspace");
  });
});

describe("enforced-mode network reads", () => {
  const enforced = { ...createDefaultPolicy(root), mode: "enforced" as const };
  const plan = (operation: Record<string, unknown>, policy: LocalPolicy = enforced) =>
    evaluatePolicy(
      "00000000-0000-4000-8000-000000000000",
      TaskRequestSchema.parse({ goal: "Read", operation }),
      policy,
    );
  const get = (url: string) => ({ kind: "http", action: "request", method: "GET", url });
  const reads = [
    get("https://example.com/x?q=1"),
    { kind: "http", action: "request", method: "HEAD", url: "https://example.com/" },
    { kind: "browser", action: "navigate", url: "https://example.com/x?q=1" },
    { kind: "browser", action: "tab_new", url: "https://example.com/" },
  ];

  it("shows a person a read to a host only the wildcard lets through", () => {
    for (const operation of reads) {
      const result = plan(operation);
      expect(result.decision, JSON.stringify(operation)).toMatchObject({
        outcome: "confirm",
        reason: "network_read_unlisted_host",
        effect: "read",
      });
      expect(result.challenge?.actionDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.challenge).not.toHaveProperty("phrase");
      // Mutations being off does not turn the question into a refusal.
      expect(plan(operation, { ...enforced, mutations: "deny" }).decision.reason).toBe("network_read_unlisted_host");
      // Developer mode is as it was.
      expect(plan(operation, createDefaultPolicy(root)).decision.reason).toBe("read_only_operation");
    }
  });

  it("lets a read to a host the policy names run without one", () => {
    const named = { ...enforced, allowedDomains: ["*", "example.com"] };
    for (const operation of reads) {
      expect(plan(operation, named).decision.reason, JSON.stringify(operation)).toBe("read_only_operation");
    }
    expect(plan(get("https://api.example.com/"), named).decision.reason).toBe("read_only_operation");
    expect(plan(get("https://example.org/"), named).decision.reason).toBe("network_read_unlisted_host");
    // Loopback the operator opened is named by that, and a private address is
    // the destination guard's to refuse.
    expect(plan(get("http://127.0.0.1:8080/"), { ...enforced, allowLocalhost: true }).decision.reason).toBe(
      "read_only_operation",
    );
    expect(plan(get("http://localhost:8080/"), { ...enforced, allowLocalhost: true }).decision.reason).toBe(
      "read_only_operation",
    );
  });

  it("shows a person a read whose evidence is read from a host the policy does not name", () => {
    const named = { ...enforced, allowedDomains: ["*", "example.com"] };
    const checked = (url: string, field: string, policy: LocalPolicy = enforced) =>
      evaluatePolicy(
        "00000000-0000-4000-8000-000000000000",
        TaskRequestSchema.parse({
          goal: "Read",
          operation: { kind: "file", action: "read", path: "notes.txt" },
          [field]: [{ type: "http_resource_matches", url, path: "status", value: 200 }],
        }),
        policy,
      ).decision.reason;
    for (const field of ["requiredEvidence", "reconciliation"]) {
      expect(checked("https://example.com/c?d={{content}}", field), field).toBe("network_read_unlisted_host");
      expect(checked("https://api.example.com/c?d={{content}}", field, named), field).toBe("read_only_operation");
      // A token in the scheme or authority leaves the host to the result.
      for (const url of [
        "https://{{json.host}}/c",
        "https://{{json.sub}}.example.com/c",
        "https://api.example.com{{json.tld}}/c",
        "https://api.example.com:{{json.port}}/c",
        "https://{{json.user}}@api.example.com/c",
        "{{json.scheme}}://api.example.com/c",
      ]) {
        expect(checked(url, field, named), `${field} ${url}`).toBe("network_read_unlisted_host");
      }
      expect(checked("https://example.com/c", field, createDefaultPolicy(root)), field).toBe("read_only_operation");
    }
  });

  it("does not ask again for a page already reached", () => {
    for (const action of ["inspect", "screenshot", "reload", "back", "tabs"]) {
      expect(plan({ kind: "browser", action, url: "https://example.com/" }).decision.reason, action).toBe(
        "read_only_operation",
      );
    }
  });
});

describe("enforced-mode browser actions", () => {
  const enforced = { ...createDefaultPolicy(root), mode: "enforced" as const };
  const target = { selector: "#go" };
  const driving: Array<Record<string, unknown>> = [
    { action: "click", target },
    { action: "type", target, value: "x" },
    { action: "fill_form", fields: [{ target, value: "x" }] },
    { action: "select", target, values: ["a"] },
    { action: "press", key: "Enter" },
    { action: "upload", target, filePaths: ["a.txt"] },
    { action: "download", target },
    { action: "close", tabIndex: 1 },
    { action: "tab_switch", tabIndex: 1 },
  ];
  const plan = (operation: Record<string, unknown>, policy: LocalPolicy = enforced) =>
    evaluatePolicy(
      "00000000-0000-4000-8000-000000000000",
      TaskRequestSchema.parse({
        goal: "Drive a page",
        operation: { kind: "browser", ...operation },
        requiredEvidence: [{ type: "result_equals", path: "clicked", value: true }],
      }),
      policy,
    ).decision.reason;

  it("refuses an action that drives a page without naming it", () => {
    for (const operation of driving) {
      expect(plan(operation), String(operation.action)).toBe("browser_action_requires_url");
      expect(plan({ ...operation, url: "https://example.com/" }), String(operation.action)).not.toBe(
        "browser_action_requires_url",
      );
      // Developer mode is as it was.
      expect(plan(operation, createDefaultPolicy(root)), String(operation.action)).not.toBe(
        "browser_action_requires_url",
      );
    }
    // Reads that drive nothing need no url.
    for (const operation of [{ action: "inspect" }, { action: "scroll" }, { action: "tabs" }]) {
      expect(plan(operation), String(operation.action)).not.toBe("browser_action_requires_url");
    }
  });

  it("says so before a grant scoped to pages could refuse the request as ungranted", () => {
    const scoped = {
      ...enforced,
      capabilities: [
        { id: "g1", capability: "browser.click", effects: ["mutate"], target: "https://example.com/*", principal: "*" },
      ] as never,
    };
    expect(plan({ action: "click", target }, scoped)).toBe("browser_action_requires_url");
    expect(plan({ action: "click", target, url: "https://example.com/pay" }, scoped)).toBe("explicit_approval_required");
  });

  it("matches a grant scoped to pages against the page, never an element spelled like one", () => {
    const grants = (target: string, policy: LocalPolicy) => ({
      ...policy,
      capabilities: [
        { id: "g1", capability: "browser.*", effects: ["read", "mutate"], target, principal: "*" },
      ] as never,
    });
    const developer = grants("https://example.com/*", createDefaultPolicy(root));
    for (const element of [{ selector: "https://example.com/pay" }, { name: "https://example.com/pay" }]) {
      expect(plan({ action: "click", target: element }, developer)).toBe("capability_not_granted:browser.click");
      // A read needs no url in enforced mode either.
      expect(plan({ action: "inspect", target: element }, grants("https://example.com/*", enforced))).toBe(
        "capability_not_granted:browser.inspect",
      );
    }
    // The page itself is still covered, and so is the element by a grant scoped to elements.
    expect(plan({ action: "click", target, url: "https://example.com/pay" }, developer)).toBe(
      "explicit_approval_required",
    );
    const { operation } = TaskRequestSchema.parse({
      goal: "Click",
      operation: { kind: "browser", action: "click", target: { name: "Pay" } },
    });
    expect(classifyOperation(operation).target).toBe("element:Pay");
    expect(plan({ action: "click", target: { name: "Pay" } }, grants("element:*", createDefaultPolicy(root)))).toBe(
      "explicit_approval_required",
    );
  });

  it("takes the url of `close` and `tab_switch` for the tab, not a destination", () => {
    for (const action of ["close", "tab_switch"]) {
      for (const url of ["about:blank", "http://10.0.0.1/", "https://elsewhere.example/"]) {
        const tight = { ...enforced, allowedDomains: ["example.com"] };
        expect(plan({ action, tabIndex: 1, url }, tight), `${action} ${url}`).not.toBe("destination_domain_not_allowed");
      }
    }
    // So in developer mode too.
    expect(plan({ action: "close", tabIndex: 1, url: "about:blank" }, createDefaultPolicy(root))).not.toBe(
      "destination_domain_not_allowed",
    );
    // A page an input action names is still a destination.
    expect(plan({ action: "click", target, url: "about:blank" })).toBe("destination_domain_not_allowed");
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

  it("counts a destructive effect as a mutation the caller forbade, in every mode", () => {
    const deletions = [
      [{ kind: "file", action: "delete", path: "src", recursive: true }, { type: "file_absent", path: "src" }],
      [{ kind: "memory", action: "clear", scope: "project" }, { type: "result_equals", path: "scope", value: "project" }],
    ] as const;
    for (const policy of [createDefaultPolicy(root), unhinged]) {
      for (const [operation, evidence] of deletions) {
        expect(
          plan({ goal: "Stay read-only", operation, forbiddenEffects: ["mutate"], requiredEvidence: [evidence] }, policy)
            .decision,
          `${operation.kind}.${operation.action}, unhinged: ${policy.unhinged}`,
        ).toMatchObject({ outcome: "deny", effect: "destructive", reason: "effect_forbidden_by_request" });
      }
    }
    // A command that deletes is a mutation, not a destructive effect: only
    // forbidding `mutate` excludes it.
    const clean = (forbiddenEffects: string[]) =>
      plan({
        goal: "Clean",
        operation: { kind: "terminal", action: "run", command: "git", args: ["clean", "-fdx"] },
        forbiddenEffects,
        requiredEvidence: [{ type: "exit_code", value: 0 }],
      }).decision;
    expect(clean(["destructive"])).toMatchObject({ outcome: "allow", effect: "mutate" });
    expect(clean(["mutate"]).reason).toBe("effect_forbidden_by_request");
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
    // The old rule was the command's name alone, so both of these were
    // high-risk mutations, including the one that installs nothing.
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

  it("keeps the traits of a subcommand that follows an option", () => {
    expect(classifyCommand("npm", ["--silent", "install"]).traits).toContain(
      "package-install",
    );
    expect(classifyCommand("git", ["-c", "core.pager=cat", "push"])).toEqual({
      read: false,
      traits: ["network"],
    });
  });

  it("gives a package manager's call both traits unless it names a local subcommand first", () => {
    // Aliases, abbreviations, options that take the next argument, and a
    // repository's own settings all decide what a manager does, so only a call
    // whose first argument is a known-local subcommand carries no trait.
    for (const [command, args] of [
      ["npm", ["isntall", "left-pad"]],
      ["npm", ["it"]],
      ["npm", ["exec", "cowsay"]],
      ["npm", ["--loglevel", "silent", "install"]],
      ["npm", ["--silent", "run", "build"]],
      ["npm.cmd", ["ls"]],
      ["pnpm", ["test"]],
      ["yarn", []],
      ["yarnpkg", ["add", "left-pad"]],
      ["cargo", ["build"]],
      ["go", ["build", "./..."]],
      ["uv", ["run", "pytest"]],
      ["pip3.12", ["install", "left-pad"]],
      ["corepack", ["pnpm", "add", "left-pad"]],
    ] as const) {
      expect(classifyCommand(command, [...args]).traits, `${command} ${args.join(" ")}`).toEqual([
        "package-install",
        "network",
      ]);
    }
    for (const args of [["run", "build"], ["run-script", "lint"], ["test"], ["start"]]) {
      expect(classifyCommand("npm", args).traits, `npm ${args.join(" ")}`).toEqual([]);
    }
  });

  it("gives git the network trait unless it names a local subcommand first", () => {
    for (const args of [
      ["remote", "update"],
      ["archive", "--remote=origin", "HEAD"],
      ["maintenance", "run"],
      ["lfs", "pull"],
      ["--git-dir", ".git", "fetch"],
      ["-c", "core.pager=cat", "status"],
      ["Status"],
      ["--version"],
    ]) {
      expect(classifyCommand("git", args).traits, `git ${args.join(" ")}`).toEqual(["network"]);
    }
    for (const args of [["status"], ["add", "."], ["commit", "-m", "x"], ["switch", "-c", "x"]]) {
      expect(classifyCommand("git.exe", args).traits, `git ${args.join(" ")}`).toEqual([]);
    }
  });

  it("gives git config, rebase and grep the network trait", () => {
    // Each can be told to run another program, so none is known to stay local.
    for (const args of [
      ["rebase", "-x", "c", "HEAD~1"],
      ["rebase", "main"],
      ["grep", "-Oc", "x"],
      ["config", "core.fsmonitor", "c"],
    ]) {
      expect(classifyCommand("git", args).traits, `git ${args.join(" ")}`).toEqual(["network"]);
    }
    const policy = createDefaultPolicy(root);
    policy.deniedTraits = ["network"];
    expect(
      evaluatePolicy(
        "0b6f4a52-5d0e-4f43-9a0c-3f6d2f1c9e11",
        TaskRequestSchema.parse({
          goal: "Rebase",
          operation: { kind: "terminal", action: "run", command: "git", args: ["rebase", "-x", "c", "HEAD~1"] },
          requiredEvidence: [{ type: "exit_code", value: 0 }],
        }),
        policy,
      ).decision.reason,
    ).toBe("trait_denied:network");
  });

  it("gives the network trait to a call with a Windows network path argument", () => {
    for (const [command, args] of [
      ["git", ["init", "\\\\h\\s\\r"]],
      ["npm", ["test", "--prefix", "\\\\h\\s"]],
      ["npm", ["test", "--prefix=//h/s"]],
      ["findstr", ["/G:\\\\h\\s\\x", "y"]],
      ["node", ["-r\\\\h\\s\\x.js"]],
      ["cat", ["\\??\\UNC\\h\\s\\x"]],
      ["tar", ["-xf//h/s/a.tar"]],
      ["cat", ["\\\\\\h\\s\\x"]],
      ["cat", ["///x"]],
      ["git", ["commit", "-aF\\\\h\\s\\msg"]],
    ] as const) {
      expect(classifyCommand(command, [...args]).traits, `${command} ${args.join(" ")}`).toEqual([
        "network",
      ]);
    }
    // A URL in a message or an option's value is not a path the program opens.
    for (const args of [
      ["commit", "-m", "see https://example.com"],
      ["commit", "--message=https://example.com"],
      ["commit", "-m", "// WIP"],
    ]) {
      expect(classifyCommand("git", args).traits, `git ${args.join(" ")}`).toEqual([]);
    }
    // Nor is a code-comment pattern, or a separator with no host after it.
    for (const args of [["// TODO", "src"], ["-e", "//"], ["/// doc"]]) {
      expect(classifyCommand("rg", args).traits, `rg ${args.join(" ")}`).toEqual([]);
    }
  });

  it("knows the other names of the programs it lists", () => {
    for (const command of [
      "netcat", "nc.openbsd", "wget2", "slogin", "rsync-ssl", "inetutils-telnet",
      "inetutils-ftp", "dbclient", "telnet-ssl", "tnftp", "plink", "pscp", "psftp",
    ]) {
      expect(classifyCommand(command, []).traits, command).toEqual(["network"]);
    }
    for (const command of ["pip3", "pip-3", "pip-3.15", "go1.22.0", "go1.23rc1", "gotip"]) {
      expect(classifyCommand(command, ["install", "x"]).traits, command).toEqual([
        "package-install",
        "network",
      ]);
    }
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

  it("matches a grant against the path the file runtime will touch", () => {
    const docs = [grant({ target: "docs/*" })];
    const at = (path: string) =>
      read({ identity, operation: { kind: "file", action: "read", path } });
    // Asked of the resolver the file runtime uses rather than restated: a
    // backslash separates on Windows and is part of a name elsewhere.
    const insideDocs = (path: string) => {
      const rel = relative(resolve(root, "docs"), resolve(root, path));
      return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    };
    for (const path of [
      "docs/guide.md",
      "./docs/guide.md",
      "docs/../.env",
      "docs/a/../../.env",
      "docs\\..\\.env",
      "docs/..\\.env",
      "docs\\a/../.env",
      "docs/a\\b/../../.env",
      ".env/w\\..\\..\\docs\\x\\c/..",
      "docs/",
      "docs/x/../",
    ]) {
      expect([path, decide(at(path), docs).outcome]).toEqual([
        path,
        insideDocs(path) ? "allow" : "deny",
      ]);
    }
    expect(decide(at("docs/guide.md"), [grant({ target: "./docs/*" })]).outcome).toBe("allow");
  });

  it("matches a grant's stars in time linear in the target", () => {
    const deep = [grant({ target: "docs/*/*/*/*.md" })];
    const at = (path: string) => read({ identity, operation: { kind: "file", action: "read", path } });
    expect(decide(at("docs/a/b/c/d.md"), deep).outcome).toBe("allow");
    const started = performance.now();
    expect(decide(at(`docs/${"a/".repeat(600)}b.txt`), deep).reason).toBe("capability_not_granted:file.read");
    // Generous, so a loaded runner does not flake: linear time is well under a
    // millisecond here.
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("requires a move's destination to be granted as well as its source", () => {
    const docs = [grant({ target: "docs/*", effects: ["mutate"] })];
    const move = (destination: string) =>
      read({
        identity,
        operation: { kind: "file", action: "move", path: "docs/a.md", destination },
        requiredEvidence: [{ type: "file_exists", path: destination }],
      });
    expect(decide(move("docs/b.md"), docs).outcome).not.toBe("deny");
    expect(decide(move("src/index.ts"), docs).reason).toBe("capability_not_granted:file.move");
    expect(decide(move("docs/../src/index.ts"), docs).reason).toBe(
      "capability_not_granted:file.move",
    );
  });

  it("matches a memory grant against what the action touches", () => {
    const effects = ["read", "mutate", "destructive"];
    const scratch = [grant({ capability: "memory.*", effects, target: "project:*:scratch-*" })];
    const scope = [grant({ capability: "memory.*", effects, target: "project:*" })];
    const memory = (operation: Record<string, unknown>) =>
      read({
        identity,
        operation: { kind: "memory", scope: "project", ...operation },
        requiredEvidence: [{ type: "result_equals", path: "scope", value: "project" }],
      });
    // These act on the whole scope, whatever key or id they carry.
    for (const action of ["list", "search", "clear"]) {
      for (const named of [{ key: "scratch-1" }, { id: "9b2f4c1e-8a7d-4e3b-9c6f-2d1e0a5b7c84" }, {}]) {
        const request = memory({ action, query: "notes", ...named });
        expect(decide(request, scratch).reason, `${action} ${JSON.stringify(named)}`).toBe(
          `capability_not_granted:memory.${action}`,
        );
        expect(decide(request, scope).outcome, `${action} ${JSON.stringify(named)}`).not.toBe("deny");
      }
    }
    // A put names its key, and the record it supersedes has to be covered too.
    expect(decide(memory({ action: "put", key: "scratch-2", value: "v" }), scratch).outcome).not.toBe("deny");
    const superseding = memory({
      action: "put",
      key: "scratch-2",
      value: "v",
      supersedesId: "9b2f4c1e-8a7d-4e3b-9c6f-2d1e0a5b7c84",
    });
    expect(decide(superseding, scratch).reason).toBe("capability_not_granted:memory.put");
    expect(decide(superseding, scope).outcome).not.toBe("deny");
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

  it("lets an empty allowlist entry through nothing", () => {
    // Empty, `.${entry}` was "." and every host spelled with a trailing dot
    // ended with it: the allowlist let any public host through that way.
    const policy = { ...createDefaultPolicy(root), allowedDomains: [""] };
    for (const url of ["https://example.com./x", "https://example.com/x"]) {
      expect(evaluatePolicy(taskId, request({ method: "GET", url }), policy).decision.reason, url).toBe(
        "destination_domain_not_allowed",
      );
    }
  });

  it("reaches a loopback name by default only in developer mode, and as the policy says in either", () => {
    const reason = (fields: Partial<LocalPolicy>) =>
      evaluatePolicy(taskId, request({ method: "GET", url: "http://localhost:8080/x" }), {
        ...createDefaultPolicy(root),
        ...fields,
      }).decision.reason;
    expect(reason({})).toBe("read_only_operation");
    // Enforced mode refuses what the operator did not open.
    expect(reason({ mode: "enforced" })).toBe("destination_domain_not_allowed");
    expect(reason({ mode: "enforced", allowLocalhost: true })).toBe("read_only_operation");
    expect(reason({ allowLocalhost: false })).toBe("destination_domain_not_allowed");
  });

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

  it("takes a GET or HEAD that carries content for a mutation, in every mode", () => {
    for (const method of ["GET", "HEAD"] as const) {
      const sends = request({ method, url: "https://api.example.com/v1/orders", content: "x" });
      expect(classifyOperation(sends.operation).effect, method).toBe("mutate");
      for (const mode of ["developer", "enforced"] as const) {
        const named = { ...createDefaultPolicy(root), allowedDomains: ["api.example.com"], mode };
        expect(evaluatePolicy(taskId, sends, named).decision, `${method} ${mode}`).toMatchObject({
          outcome: "confirm",
          reason: "explicit_approval_required",
          effect: "mutate",
        });
      }
      // Without content it is the read it was.
      expect(classifyOperation(request({ method, url: "https://api.example.com/" }).operation).effect).toBe("read");
    }
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
