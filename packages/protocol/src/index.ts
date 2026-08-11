// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

export const PROTOCOL_VERSION = "2025-11-25";
export const PRODUCT_VERSION = "0.3.0-alpha.10";

const boundedPath = z.string().min(1).max(4096);
const boundedText = z.string().max(200_000);

export const FileOperationSchema = z
  .object({
    kind: z.literal("file"),
    action: z.enum([
      "list",
      "read",
      "stat",
      "hash",
      "write",
      "move",
      "delete",
      "mkdir",
    ]),
    path: boundedPath,
    destination: boundedPath.optional(),
    content: boundedText.optional(),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
    recursive: z.boolean().default(false),
  })
  .strict();

export const TerminalOperationSchema = z
  .object({
    kind: z.literal("terminal"),
    action: z.enum(["run", "start", "status", "output", "stop", "send"]),
    command: z.string().min(1).max(512).optional(),
    args: z.array(z.string().max(4096)).max(100).default([]),
    jobId: z.string().uuid().optional(),
    cwd: boundedPath.optional(),
    env: z.record(z.string(), z.string().max(8192)).optional(),
    /**
     * Hold `start`'s stdin open so `send` can answer a prompt. Off by default
     * because it changes what the program sees: with stdin ignored a read gets
     * EOF at once, while an open pipe makes the same program wait for input
     * that may never come.
     */
    interactive: z.boolean().default(false),
    /** What `send` writes to the job's stdin. */
    input: z.string().max(8_192).optional(),
    /**
     * Append a newline to `input`. A prompt waits for the line to end, so the
     * common case is the default; turn it off to send a bare keystroke.
     */
    appendNewline: z.boolean().default(true),
    timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
    maxOutputChars: z.number().int().min(1_000).max(1_000_000).default(100_000),
  })
  .strict();

export const BrowserTargetSchema = z
  .object({
    selector: z.string().min(1).max(2_000).optional(),
    role: z.string().min(1).max(100).optional(),
    name: z.string().max(500).optional(),
    text: z.string().max(2_000).optional(),
  })
  .strict();

export const BrowserOperationSchema = z
  .object({
    kind: z.literal("browser"),
    action: z.enum([
      "navigate",
      "back",
      "forward",
      "reload",
      "inspect",
      "wait",
      "click",
      "type",
      "fill_form",
      "select",
      "press",
      "scroll",
      "screenshot",
      "upload",
      "download",
      "tabs",
      "tab_new",
      "tab_switch",
      "close",
    ]),
    url: z.string().url().max(8_192).optional(),
    target: BrowserTargetSchema.optional(),
    value: z.string().max(100_000).optional(),
    values: z.array(z.string().max(2_000)).max(50).optional(),
    // One task, one approval: a login form is two fields and a submit, not
    // three separate governed mutations.
    fields: z
      .array(
        z
          .object({
            target: BrowserTargetSchema,
            value: z.string().max(100_000),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .optional(),
    filePaths: z.array(boundedPath).min(1).max(20).optional(),
    key: z.string().max(100).optional(),
    direction: z.enum(["up", "down", "top", "bottom", "into_view"]).optional(),
    // `wait` conditions. A URL is matched by substring rather than by equality
    // because the interesting part of a post-login redirect is the path, not
    // the session token stapled to it.
    state: z.enum(["visible", "hidden", "attached", "detached"]).optional(),
    urlContains: z.string().min(1).max(2_000).optional(),
    tabIndex: z.number().int().min(0).max(100).optional(),
    // Per-keystroke delay. Some widgets debounce, and some deliberately ignore
    // input that arrives faster than a human could produce it.
    delayMs: z.number().int().min(0).max(500).default(0),
    clearFirst: z.boolean().default(true),
    pixels: z.number().int().min(1).max(100_000).default(600),
    fullPage: z.boolean().default(false),
    timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
    settleQuietMs: z.number().int().min(25).max(2_000).default(180),
    settleTimeoutMs: z.number().int().min(25).max(10_000).default(1_500),
    maxChars: z.number().int().min(100).max(200_000).default(20_000),
  })
  .strict();

export const MemoryScopeSchema = z.enum([
  "session",
  "task",
  "project",
  "workspace",
  "user",
  "procedural",
]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemoryOperationSchema = z
  .object({
    kind: z.literal("memory"),
    action: z.enum(["put", "search", "list", "delete", "clear"]),
    id: z.string().uuid().optional(),
    scope: MemoryScopeSchema.default("workspace"),
    key: z.string().min(1).max(512).optional(),
    value: boundedText.optional(),
    query: z.string().max(10_000).optional(),
    source: z.string().max(4_096).optional(),
    confidence: z.number().min(0).max(1).default(1),
    tags: z.array(z.string().min(1).max(128)).max(50).default([]),
    speaker: z.string().min(1).max(256).optional(),
    episodeId: z.string().min(1).max(256).optional(),
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    expiresAt: z.string().datetime().optional(),
    supersedesId: z.string().uuid().optional(),
    includeSuperseded: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const ComputerOperationSchema = z
  .object({
    kind: z.literal("computer"),
    action: z.enum([
      "capabilities",
      "inspect",
      "screenshot",
      "click",
      "move",
      "drag",
      "type",
      "key",
      "scroll",
    ]),
    coordinateSpace: z.enum(["normalized", "pixel"]).default("normalized"),
    x: z.number().min(0).max(100_000).optional(),
    y: z.number().min(0).max(100_000).optional(),
    // `drag` only: where the press is released. Kept as separate fields rather
    // than a nested point so `x`/`y` keep meaning "where the action starts" for
    // every action that has a position.
    toX: z.number().min(0).max(100_000).optional(),
    toY: z.number().min(0).max(100_000).optional(),
    text: z.string().max(100_000).optional(),
    key: z
      .enum([
        "ENTER",
        "TAB",
        "SPACE",
        "BACKSPACE",
        "ESCAPE",
        "LEFT",
        "RIGHT",
        "DOWN",
        "UP",
        "HOME",
        "END",
        "PAGEUP",
        "PAGEDOWN",
        "DELETE",
      ])
      .optional(),
    deltaY: z.number().int().min(-2_000).max(2_000).optional(),
    /**
     * Where to act, named rather than measured. `inspect` reports the elements
     * the platform can see with the roles and names that address them, and a
     * caller naming one here has the runtime resolve it to a point instead of
     * reading pixels off a screenshot. Coordinates still work unchanged;
     * supplying both is rejected rather than silently resolved one way, because
     * the two can disagree and the caller is the only one who knows which it
     * meant.
     */
    target: z
      .object({
        role: z.string().min(1).max(100).optional(),
        name: z.string().min(1).max(500).optional(),
      })
      .strict()
      .optional(),
    // Capped at 120s like every other operation kind rather than 30s. A
    // computer action spawns a whole interpreter — `powershell.exe` plus the
    // .NET assemblies it loads, `osascript`, `xdotool` — and the first such
    // spawn after boot exceeded the old 30s ceiling on a cold Windows machine,
    // which made the maximum itself unreachable there. The default stays 10s
    // because a warm call is fast; a caller who knows it is cold can now ask
    // for more instead of being denied by the schema.
    timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  })
  .strict();

export const HttpOperationSchema = z
  .object({
    kind: z.literal("http"),
    action: z.literal("request"),
    method: z
      .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
      .default("GET"),
    url: z.string().url().max(4_096),
    headers: z.record(z.string().min(1).max(256), z.string().max(8_192)).optional(),
    /**
     * The request payload, sent verbatim.
     *
     * Named `content` rather than `body` because that is the key
     * `redactStructuredValue` already strips — an API call is the most likely
     * place for a bearer token or a password to be written down, and the
     * persisted copy must not hold one. `body` is taken: a `bounded_loop`
     * workflow node uses it for its step list, which must survive redaction to
     * stay parseable.
     */
    content: boundedText.optional(),
    /**
     * Sent as `Idempotency-Key` so a provider that supports it can collapse a
     * duplicate submission of its own accord.
     *
     * ponytail: caller-supplied, not derived from the task — the adapter is
     * handed an operation, not a task id. It does not upgrade the execution
     * guarantee either: MELRA cannot check that the far end honours the header,
     * and a mutation still runs at most once from here.
     */
    idempotencyKey: z.string().min(1).max(256).optional(),
    /**
     * What this call is about to cost, declared by the caller.
     *
     * MELRA cannot read an amount out of an arbitrary provider's payload, so a
     * money bound needs the caller to state one. The declaration is checked
     * against `CapabilityGrant.provider`, and the direction of the check is
     * what makes it safe to take a caller's word: a grant with money bounds
     * covers only operations that declare a spend, so understating is a lie the
     * grant does not cover and omitting it means no grant matches at all.
     */
    spend: z
      .object({
        provider: z.string().min(1).max(100),
        account: z.string().min(1).max(200).optional(),
        /** Minor units — 5000 is $50.00, never 5000 dollars. */
        amount: z.number().int().min(0).max(1_000_000_000_000),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict()
      .optional(),
    /** Bounds one response the way `maxFileBytes` bounds one read. */
    maxResponseBytes: z
      .number()
      .int()
      .min(1_000)
      .max(10 * 1024 * 1024)
      .default(1024 * 1024),
    timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  })
  .strict();

export const SystemOperationSchema = z
  .object({
    kind: z.literal("system"),
    action: z.literal("info"),
  })
  .strict();

export const OperationSchema = z.discriminatedUnion("kind", [
  FileOperationSchema,
  TerminalOperationSchema,
  BrowserOperationSchema,
  MemoryOperationSchema,
  ComputerOperationSchema,
  HttpOperationSchema,
  SystemOperationSchema,
]);

export type FileOperation = z.infer<typeof FileOperationSchema>;
export type TerminalOperation = z.infer<typeof TerminalOperationSchema>;
export type BrowserTarget = z.infer<typeof BrowserTargetSchema>;
export type BrowserOperation = z.infer<typeof BrowserOperationSchema>;
export type MemoryOperation = z.infer<typeof MemoryOperationSchema>;
export type ComputerOperation = z.infer<typeof ComputerOperationSchema>;
export type HttpOperation = z.infer<typeof HttpOperationSchema>;
export type SystemOperation = z.infer<typeof SystemOperationSchema>;
export type Operation = z.infer<typeof OperationSchema>;

export const EvidencePredicateSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("result_equals"),
      path: z.string().min(1).max(512),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    })
    .strict(),
  z
    .object({
      type: z.literal("result_contains"),
      path: z.string().min(1).max(512),
      value: z.string().max(10_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("file_exists"),
      path: boundedPath,
    })
    .strict(),
  z
    .object({
      type: z.literal("file_absent"),
      path: boundedPath,
    })
    .strict(),
  z
    .object({
      type: z.literal("file_hash"),
      path: boundedPath,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("exit_code"),
      value: z.number().int(),
    })
    .strict(),
  z
    .object({
      type: z.literal("url_matches"),
      pattern: z.string().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("page_contains"),
      text: z.string().min(1).max(10_000),
    })
    .strict(),
  /**
   * Confirm the effect through a channel that did not perform it.
   *
   * Re-reading a file after writing it is honest because the filesystem is the
   * authority. An API response is not: the client that got `200 OK` is the same
   * client being asked whether the thing happened. This predicate asks the
   * provider's own state instead — `POST /refunds` executes, `GET /refunds/:id`
   * decides — which is why it is the only predicate that carries
   * `strength: "independent"`.
   *
   * The request is an effect and gets no shortcut: it goes out through the same
   * adapter, the same destination boundary, and the same allowlist as any other
   * HTTP call. `GET` and `HEAD` only — a verification that changes something is
   * not a verification.
   */
  z
    .object({
      type: z.literal("http_resource_matches"),
      /**
       * May contain `{{token}}` placeholders, which is why this is not
       * `z.string().url()` — it becomes a URL only after interpolation.
       * A token names a dotted path in the *recorded result* of the operation
       * being verified (`{{json.id}}` reads the parsed response body,
       * `{{status}}` the status), never caller-supplied text, and its value is
       * percent-encoded before it is spliced in.
       */
      url: z.string().min(1).max(4_096),
      method: z.enum(["GET", "HEAD"]).default("GET"),
      /** Dotted path into the probe's result; `json.` reads the parsed body. */
      path: z.string().min(1).max(512),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
    })
    .strict(),
]);

export type EvidencePredicate = z.infer<typeof EvidencePredicateSchema>;

export const PrincipalKindSchema = z.enum([
  "organization",
  "human",
  "harness",
  "agent",
  "session",
  "subagent",
  "service",
]);

export const PrincipalSchema = z
  .object({
    kind: PrincipalKindSchema,
    id: z.string().min(1).max(200),
  })
  .strict();

/**
 * Who is asking, and on whose behalf.
 *
 * `principal` is the immediate caller — the agent or session that dispatched
 * this effect. `onBehalfOf` is the delegation chain behind it, outermost first
 * (organization → human → harness → parent agent), so a receipt answers "who
 * authorised this" rather than only "what ran". MELRA does not authenticate any
 * of it; a link is a claim the layer above makes, and it is worth exactly as
 * much as that layer's own boundary.
 */
export const IdentitySchema = z
  .object({
    principal: PrincipalSchema,
    onBehalfOf: z.array(PrincipalSchema).max(7).default([]),
  })
  .strict();

export type Principal = z.infer<typeof PrincipalSchema>;
export type Identity = z.infer<typeof IdentitySchema>;

/** The one principal assumed when a caller declares none. */
export const LOCAL_IDENTITY: Identity = {
  principal: { kind: "agent", id: "local" },
  onBehalfOf: [],
};

export function principalRef(principal: Principal): string {
  return `${principal.kind}:${principal.id}`;
}

/**
 * Records a caller the transport authenticated above whatever the request
 * declared.
 *
 * The authenticated link sits at the outermost end, because anything the
 * client names — a session, a subagent — is inside it and never above it. A
 * request that declared nothing is simply that client acting for itself. This
 * is the one link in a chain that is not a claim; the rest still are, so a
 * capability grant matching the immediate principal is a narrowing control
 * rather than an authentication boundary.
 */
export function attributeTo(
  principal: Principal,
  identity?: Identity,
): Identity {
  if (identity === undefined) return { principal, onBehalfOf: [] };
  const onBehalfOf = [principal, ...identity.onBehalfOf];
  if (onBehalfOf.length > 7) throw new Error("identity_chain_too_deep");
  return { principal: identity.principal, onBehalfOf };
}

/** The delegation chain as one line, outermost first. */
export function delegationChain(identity: Identity): string {
  return [...identity.onBehalfOf, identity.principal]
    .map(principalRef)
    .join("/");
}

export const TaskBudgetSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(100).default(10),
    maxDurationMs: z.number().int().min(100).max(900_000).default(120_000),
    maxRetries: z.number().int().min(0).max(10).default(2),
  })
  .strict();

export const TaskRequestSchema = z
  .object({
    goal: z
      .string()
      .min(1)
      .max(10_000)
      .describe("Why this task is being run, in one human-readable sentence."),
    operation: OperationSchema,
    // These three carry the rules callers get wrong, and a description is the
    // only channel that reaches a model reading the tool's JSON Schema.
    constraints: z
      .array(z.string().max(2_000))
      .max(50)
      .default([])
      .describe(
        "Leave empty. Freeform prose cannot be enforced, so a non-empty array is denied with freeform_constraints_not_enforceable. Express real limits as forbiddenEffects, budget, or requiredEvidence.",
      ),
    forbiddenEffects: z
      .array(z.enum(["read", "mutate", "destructive"]))
      .max(3)
      .default([])
      .describe(
        "Effects this task must never take. Denied before the adapter runs, and honoured even in unhinged mode.",
      ),
    budget: TaskBudgetSchema.default({
      maxSteps: 10,
      maxDurationMs: 120_000,
      maxRetries: 2,
    }),
    requiredEvidence: z
      .array(EvidencePredicateSchema)
      .max(20)
      .default([])
      .describe(
        "Predicates that must hold after execution for the task to be verified_success. Required for any non-read operation: a mutation with none is denied with mutation_requires_evidence. An adapter that succeeded while a predicate failed is partial, never success.",
      ),
    reconciliation: z
      .array(EvidencePredicateSchema)
      .max(5)
      .default([])
      .describe(
        "How to settle this effect if MELRA never learns whether it happened — a request that went out and was never answered, or a crash mid-flight. Read against the facts that were true before the call (idempotencyKey, url, method), never against a response, because there is none. Declaring these makes the executionGuarantee reconciliation-required instead of at-most-once.",
      ),
    identity: IdentitySchema.optional().describe(
      "Who is asking, and on whose behalf. Recorded on the task and every receipt, and matched against policy.capabilities when the operator has issued grants. Omitted means the implicit local principal.",
    ),
  })
  .strict();

export type TaskRequest = z.infer<typeof TaskRequestSchema>;
export type TaskRequestInput = z.input<typeof TaskRequestSchema>;
export type TaskBudget = z.infer<typeof TaskBudgetSchema>;

export const EffectSchema = z.enum(["read", "mutate", "destructive"]);
export const RiskSchema = z.enum(["low", "medium", "high", "critical"]);
export const PolicyOutcomeSchema = z.enum(["allow", "deny", "confirm"]);

/**
 * What an operation reaches for, as opposed to what it is named. `npm ls` and
 * `npm install` are the same allowlisted command; only the second one installs
 * a package and talks to a registry. Traits are what `policy.deniedTraits`
 * matches on and what a caller sees before it echoes an approval phrase.
 */
export const CapabilityTraitSchema = z.enum(["package-install", "network"]);

export const PolicyDecisionSchema = z
  .object({
    outcome: PolicyOutcomeSchema,
    effect: EffectSchema,
    risk: RiskSchema,
    reason: z.string(),
    policyVersion: z.string(),
    traits: z
      .array(CapabilityTraitSchema)
      .max(8)
      .default([])
      .describe(
        "What the operation reaches for beyond the local workspace. Denied by policy.deniedTraits; shown so an approver knows a command installs packages or contacts another host before approving it.",
      ),
  })
  .strict();

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type CapabilityTrait = z.infer<typeof CapabilityTraitSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type Risk = z.infer<typeof RiskSchema>;

export const ApprovalChallengeSchema = z
  .object({
    approvalId: z.string().uuid(),
    taskId: z.string().uuid(),
    actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    phrase: z.string(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type ApprovalChallenge = z.infer<typeof ApprovalChallengeSchema>;

export const ApprovalResponseSchema = z
  .object({
    approvalId: z.string().uuid(),
    phrase: z.string().min(1).max(256),
  })
  .strict();

export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

/**
 * Bounded authority to take one kind of effect, issued to a principal by the
 * operator rather than derived from a credential.
 *
 * `capability` and `target` are matched against what `classifyOperation`
 * reports, with `*` standing for any run of characters, so `file.*` over
 * `/repo/build/*` grants file work inside one directory and nothing else. An
 * empty grant list means no capability narrowing is configured — the rest of
 * policy still applies. A non-empty list is a closed world: an effect with no
 * matching grant is denied before any allowlist is consulted.
 */
export const CapabilityGrantSchema = z
  .object({
    id: z.string().min(1).max(200),
    capability: z.string().min(1).max(200),
    effects: z.array(EffectSchema).min(1).max(3),
    target: z.string().min(1).max(4096).default("*"),
    /** `kind:id` of the holder, matched against the immediate principal. */
    principal: z.string().min(1).max(200).default("*"),
    validUntil: z.string().datetime().optional(),
    /**
     * Policy version this grant was issued against. A grant that names a
     * version the running policy no longer has is refused rather than silently
     * reinterpreted under different rules.
     */
    policyVersion: z.string().max(64).optional(),
    /**
     * How many times this grant may be spent, ever.
     *
     * `validUntil` bounds a window; this bounds what happens inside it. The
     * count is durable and increments on commit, so a restart does not refill
     * it and an operation that was refused, failed verification, or was
     * cancelled does not draw it down.
     */
    maxOperations: z.number().int().min(1).max(1_000_000).optional(),
    /**
     * Money bounds, for grants over effects that move some.
     *
     * A grant carrying this block covers *only* operations that declare a
     * matching `spend` (see `HttpOperationSchema`), so an undeclared spend is
     * an ungranted one rather than a free one. `name` and `account` are
     * compared exactly, not as patterns: `stripe` and `stripe-test` are
     * different providers and a grant meaning one must not cover the other.
     */
    provider: z
      .object({
        name: z.string().min(1).max(100),
        account: z.string().min(1).max(200).optional(),
        /** Ceiling on one operation's declared amount, in minor units. */
        amountMax: z.number().int().min(0).max(1_000_000_000_000).optional(),
        /** Ceiling on declared amounts committed in the last 24 hours. */
        dailyMax: z.number().int().min(0).max(1_000_000_000_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

/**
 * One secret the kernel holds so the agent does not have to.
 *
 * The whole point is the asymmetry between the two lists. `hosts` says where
 * the secret may travel; `capability` says what may be done while holding it.
 * A request to a host outside `hosts` is sent *without* the credential, because
 * a secret that follows the caller wherever it points is not scoped to
 * anything. A request to a host inside `hosts` that the capability does not
 * cover is *refused* — that is the caller reaching past the authority it was
 * delegated, and it is the difference between possessing a credential and
 * possessing authority.
 */
export const CredentialDefinitionSchema = z
  .object({
    source: z.union([
      z.object({ env: z.string().min(1).max(256) }).strict(),
      z.object({ file: z.string().min(1).max(4096) }).strict(),
    ]),
    inject: z
      .object({
        header: z.string().min(1).max(256),
        /** Prefix written before the secret, e.g. `Bearer`. */
        scheme: z.string().max(64).optional(),
      })
      .strict(),
    /** Hosts the secret may be sent to. `*` matches any run of characters. */
    hosts: z.array(z.string().min(1).max(256)).min(1).max(64),
    /**
     * Matched against `<capability>:<target>` as `classifyOperation` reports
     * them — `http.post:https://api.stripe.com/v1/refunds/re_1` against
     * `http.post:https://api.stripe.com/v1/refunds/*`.
     */
    capability: z.string().min(1).max(512),
  })
  .strict();

export type CredentialDefinition = z.infer<typeof CredentialDefinitionSchema>;

export const CredentialsSchema = z
  .record(z.string().min(1).max(128), CredentialDefinitionSchema)
  .refine((value) => Object.keys(value).length <= 64, {
    message: "too_many_credentials",
  });

/**
 * What MELRA promises about how many times an effect can run.
 *
 * Stating it is the point. The rule that mutations are never retried already
 * governed execution, but it lived inside the controller, so a caller setting
 * `budget.maxRetries: 3` on a write had no way to learn that the number would
 * be ignored. Derived from the classified effect, never taken from the caller —
 * a caller that could declare its own `POST` `provider-idempotent` would have
 * bought itself a retry it is not entitled to.
 */
export type ExecutionGuarantee =
  /** No state change, so there is nothing to guarantee. Freely retried. */
  | "read-only"
  /** Executed zero or one times. Never retried. */
  | "at-most-once"
  /** May run more than once; the caller must tolerate a repeat. */
  | "at-least-once"
  /** Retry-safe because the provider dedupes on a key MELRA sends. */
  | "provider-idempotent"
  /** Outcome may be unknown after a crash; a reconciliation pass decides. */
  | "reconciliation-required"
  /** Undone by a declared compensating effect. */
  | "compensatable";

/**
 * How the kernel is deployed. Not a property of a request — a property of the
 * process, recorded on every effect that process runs.
 *
 * `developer` is the default and the reason MELRA can be tried in thirty
 * seconds: it governs the effects it is asked for, and says plainly that a
 * harness holding a native terminal as well makes it optional. `enforced` is the
 * operator asserting the alternative has been removed. MELRA cannot check that
 * assertion from inside the process, so it does the part it can: it closes every
 * door of its own that would contradict the claim.
 */
export type DeploymentMode = "developer" | "enforced";

/**
 * Only the exact word counts. A stray `MELRA_MODE=Enforced` left in a shell
 * profile is a typo, and quietly reading it as developer mode would hand back
 * the bypasses the operator thought they had turned off.
 */
export function deploymentMode(value: string | undefined): DeploymentMode {
  const raw = value?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "developer") return "developer";
  if (raw === "enforced") return "enforced";
  throw new Error("deployment_mode_unknown");
}

/**
 * `at-least-once`, `provider-idempotent` and `compensatable` still need an
 * adapter that can offer them, so nothing derives those three yet.
 * `reconciliation-required` is real: a caller that declared `reconciliation`
 * predicates has given MELRA a way to settle an outcome it could not observe,
 * and that is a different promise from `at-most-once`, which says the effect
 * ran zero or one times but not which.
 */
export function executionGuaranteeFor(
  effect: Effect,
  /** Whether the request declared a way to settle an unknown outcome. */
  reconcilable = false,
): ExecutionGuarantee {
  if (effect === "read") return "read-only";
  return reconcilable ? "reconciliation-required" : "at-most-once";
}

/**
 * Prefix on an adapter error that does *not* claim the effect failed to happen.
 *
 * The distinction is the whole of it. A request that never left the machine —
 * DNS failure, connection refused — definitely did nothing, and `failed` is the
 * truth. A request that was written to the socket and went unanswered is a
 * different fact: the far end may have done the work and lost the reply.
 * Reporting the second as `failed` is the one lie a kernel that owns effects
 * cannot afford to tell, so an adapter that can tell the two apart marks it and
 * the executor parks the task for reconciliation instead of asserting either
 * outcome.
 */
export const OUTCOME_UNKNOWN_PREFIX = "effect_outcome_unknown:";

/** Wraps a reason as an error whose outcome MELRA cannot determine. */
export function outcomeUnknown(reason: string): Error {
  return new Error(
    isOutcomeUnknown(reason) ? reason : `${OUTCOME_UNKNOWN_PREFIX}${reason}`,
  );
}

export function isOutcomeUnknown(message: string): boolean {
  return message.startsWith(OUTCOME_UNKNOWN_PREFIX);
}

const RETRIABLE: ReadonlySet<ExecutionGuarantee> = new Set([
  "read-only",
  "at-least-once",
  "provider-idempotent",
]);

/**
 * Whether more than one attempt is permitted. The executor asks the guarantee
 * rather than re-deriving the rule from the effect, so the promise on the
 * contract and the behaviour in the loop cannot drift apart.
 */
export function allowsRetry(guarantee: ExecutionGuarantee): boolean {
  return RETRIABLE.has(guarantee);
}

/**
 * One bounded effect, named as a single object.
 *
 * Every field here already governed execution; the contract is what they are
 * called together. It is derived from a persisted task rather than supplied,
 * so there is no second input path that could describe an effect differently
 * from the one that will run.
 */
export interface EffectContract {
  contractVersion: string;
  taskId: string;
  identity: Identity;
  capability: string;
  operation: Operation;
  effect: Effect;
  risk: Risk;
  target: string;
  traits: CapabilityTrait[];
  /** How many times this effect can run. See `ExecutionGuarantee`. */
  executionGuarantee: ExecutionGuarantee;
  /** Effects this request refuses for itself, honoured even in unhinged mode. */
  forbiddenEffects: Effect[];
  /** What must hold afterwards for the effect to count as a success. */
  postconditions: EvidencePredicate[];
  budget: TaskBudget;
  idempotencyKey?: string;
  policy: PolicyDecision;
  authorization?: ApprovalChallenge;
  metadata: { goal: string };
}

export const WorkflowNodeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

const NodeBaseSchema = z.object({
  id: WorkflowNodeIdSchema,
  dependsOn: z.array(WorkflowNodeIdSchema).max(100).default([]),
});

export const OperationNodeSchema = NodeBaseSchema.extend({
  type: z.literal("operation"),
  request: TaskRequestSchema,
}).strict();

export const ApprovalNodeSchema = NodeBaseSchema.extend({
  type: z.literal("approval"),
  forNodeId: WorkflowNodeIdSchema,
}).strict();

export const ConditionNodeSchema = NodeBaseSchema.extend({
  type: z.literal("condition"),
  sourceNodeId: WorkflowNodeIdSchema,
  predicate: EvidencePredicateSchema,
  whenTrue: z.array(TaskRequestSchema).max(50).default([]),
  whenFalse: z.array(TaskRequestSchema).max(50).default([]),
}).strict();

export const ParallelNodeSchema = NodeBaseSchema.extend({
  type: z.literal("parallel"),
  branches: z
    .array(z.array(TaskRequestSchema).min(1).max(50))
    .min(2)
    .max(20),
}).strict();

export const BoundedLoopNodeSchema = NodeBaseSchema.extend({
  type: z.literal("bounded_loop"),
  body: z.array(TaskRequestSchema).min(1).max(50),
  maxIterations: z.number().int().min(1).max(100),
  until: EvidencePredicateSchema.optional(),
}).strict();

export const CheckpointNodeSchema = NodeBaseSchema.extend({
  type: z.literal("checkpoint"),
}).strict();

export const CompensationNodeSchema = NodeBaseSchema.extend({
  type: z.literal("compensation"),
  forNodeId: WorkflowNodeIdSchema,
  request: TaskRequestSchema,
}).strict();

// A workflow that needs a person to answer something stops here. The answer is
// supplied to `advance`, recorded on the node, and readable by later nodes —
// it is data the graph waited for, not an approval to run a pending mutation.
export const HumanInputNodeSchema = NodeBaseSchema.extend({
  type: z.literal("human_input"),
  prompt: z.string().min(1).max(2_000),
  // Free text is unconstrained by design; `choices` narrows it to a fixed set
  // so a workflow can branch on an answer it can actually enumerate.
  choices: z.array(z.string().min(1).max(200)).max(20).default([]),
  maxLength: z.number().int().min(1).max(10_000).default(1_000),
}).strict();

// Delegation hands a named sub-goal to an outside worker (another agent, a
// person, a queue). MELRA does not execute it — it records the handoff and
// waits for a result, so the run stays governed and receipted either way.
export const DelegationNodeSchema = NodeBaseSchema.extend({
  type: z.literal("delegation"),
  assignee: z.string().min(1).max(200),
  goal: z.string().min(1).max(2_000),
  requiredEvidence: z.array(EvidencePredicateSchema).max(20).default([]),
}).strict();

export const WorkflowNodeSchema = z.discriminatedUnion("type", [
  OperationNodeSchema,
  ApprovalNodeSchema,
  ConditionNodeSchema,
  ParallelNodeSchema,
  BoundedLoopNodeSchema,
  CheckpointNodeSchema,
  CompensationNodeSchema,
  HumanInputNodeSchema,
  DelegationNodeSchema,
]);

// What an operator supplies to `advance` to satisfy a waiting human_input or
// delegation node.
export const WorkflowInputSchema = z
  .object({
    nodeId: WorkflowNodeIdSchema,
    value: z.string().min(1).max(10_000),
  })
  .strict();

export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

export const WorkflowDefinitionSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    id: z.string().uuid(),
    version: z.number().int().positive(),
    name: z.string().min(1).max(200),
    description: z.string().max(2_000).optional(),
    nodes: z.array(WorkflowNodeSchema).min(1).max(500),
    budget: TaskBudgetSchema.optional(),
  })
  .strict();

export const WorkflowStatusSchema = z.enum([
  "draft",
  "planned",
  "awaiting_approval",
  // Blocked on a person supplying input. Distinct from `paused`/`suspended`,
  // which are operator halts: this one clears by answering, not by resuming.
  "awaiting_input",
  "running",
  "paused",
  "suspended",
  "partially_complete",
  "verified_complete",
  "recovery_required",
  "failed",
  "cancelled",
]);

export const WorkflowNodeStatusSchema = z.enum([
  "pending",
  "ready",
  "awaiting_approval",
  "awaiting_input",
  "running",
  "verifying",
  "verified_complete",
  "skipped",
  "recovery_required",
  "failed",
  "cancelled",
  "compensated",
]);

export const EncryptedPayloadSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("aes-256-gcm"),
    iv: z.string().regex(/^[A-Za-z0-9_-]+$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/),
    tag: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

export const WorkflowEventSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    id: z.string().uuid(),
    aggregateId: z.string().uuid(),
    sequence: z.number().int().positive(),
    traceId: z.string().uuid(),
    type: z.string().regex(/^[a-z]+(?:\.[a-z_]+)+$/),
    data: z.record(z.string(), z.unknown()),
    occurredAt: z.string().datetime(),
  })
  .strict();

export const WorkflowNodeStateSchema = z
  .object({
    status: WorkflowNodeStatusSchema,
    taskIds: z.array(z.string().uuid()).max(5_000).default([]),
    approval: ApprovalChallengeSchema.optional(),
    iterations: z.number().int().min(0).max(100).optional(),
    // What a human_input or delegation node is waiting on, and what it got.
    prompt: z.string().max(2_000).optional(),
    input: z.string().max(10_000).optional(),
    error: z.string().max(10_000).optional(),
  })
  .strict();

export const WorkflowRunSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    id: z.string().uuid(),
    definitionId: z.string().uuid(),
    definitionVersion: z.number().int().positive(),
    status: WorkflowStatusSchema,
    stateVersion: z.number().int().positive(),
    nodes: z.record(WorkflowNodeIdSchema, WorkflowNodeStateSchema),
    traceId: z.string().uuid(),
    error: z.string().max(10_000).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const WorkflowSnapshotSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    workflowId: z.string().uuid(),
    sequence: z.number().int().positive(),
    run: WorkflowRunSchema,
    createdAt: z.string().datetime(),
  })
  .strict()
  .refine((snapshot) => snapshot.sequence === snapshot.run.stateVersion, {
    message: "sequence must match run.stateVersion",
    path: ["sequence"],
  });

export const WorkflowAdvanceResultSchema = z
  .object({
    run: WorkflowRunSchema,
    tasks: z.array(z.record(z.string(), z.unknown())),
    events: z.array(WorkflowEventSchema),
  })
  .strict();

export const WorkflowPlanInputSchema = z
  .object({
    definition: WorkflowDefinitionSchema,
  })
  .strict();

export const WorkflowAdvanceInputSchema = z
  .object({
    workflowId: z.string().uuid(),
    approvals: z.array(ApprovalResponseSchema).max(50).default([]),
    // Answers for nodes parked on a person. Supplied on the same call that
    // resumes the wave, so one round trip both answers and advances.
    inputs: z.array(WorkflowInputSchema).max(50).default([]),
  })
  .strict();

export const WorkflowIdInputSchema = z
  .object({
    workflowId: z.string().uuid(),
  })
  .strict();

// Operator halts and their reversal. One tool with an action beats three tools
// that differ only in a verb.
export const WorkflowControlInputSchema = z
  .object({
    workflowId: z.string().uuid(),
    action: z.enum(["pause", "resume", "suspend"]),
  })
  .strict();

export type WorkflowNodeId = z.infer<typeof WorkflowNodeIdSchema>;
export type OperationNode = z.infer<typeof OperationNodeSchema>;
export type ApprovalNode = z.infer<typeof ApprovalNodeSchema>;
export type ConditionNode = z.infer<typeof ConditionNodeSchema>;
export type ParallelNode = z.infer<typeof ParallelNodeSchema>;
export type BoundedLoopNode = z.infer<typeof BoundedLoopNodeSchema>;
export type CheckpointNode = z.infer<typeof CheckpointNodeSchema>;
export type CompensationNode = z.infer<typeof CompensationNodeSchema>;
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
// What a caller writes, before the schema fills in `dependsOn`, `constraints`,
// `requiredEvidence`, and the rest. Requiring the parsed shape would make an
// author state every default by hand — including `constraints: []`, where any
// other value is a deny.
export type WorkflowDefinitionInput = z.input<typeof WorkflowDefinitionSchema>;
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;
export type WorkflowNodeStatus = z.infer<typeof WorkflowNodeStatusSchema>;
export type EncryptedPayload = z.infer<typeof EncryptedPayloadSchema>;
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;
export type WorkflowNodeState = z.infer<typeof WorkflowNodeStateSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshotSchema>;
export type WorkflowAdvanceResult = z.infer<
  typeof WorkflowAdvanceResultSchema
>;
export type WorkflowPlanInput = z.infer<typeof WorkflowPlanInputSchema>;
export type WorkflowAdvanceInput = z.infer<typeof WorkflowAdvanceInputSchema>;
export type WorkflowIdInput = z.infer<typeof WorkflowIdInputSchema>;
export type WorkflowControlInput = z.infer<typeof WorkflowControlInputSchema>;
export type HumanInputNode = z.infer<typeof HumanInputNodeSchema>;
export type DelegationNode = z.infer<typeof DelegationNodeSchema>;

export const TaskStatusSchema = z.enum([
  "planned",
  "awaiting_approval",
  "running",
  "verifying",
  "verified_success",
  "partial",
  "failed",
  "cancelled",
  "waiting_user",
  "policy_blocked",
  "budget_exhausted",
  "recovery_required",
]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export interface TaskRecord {
  id: string;
  request: TaskRequest;
  status: TaskStatus;
  policyDecision: PolicyDecision;
  idempotencyKey?: string;
  attempt?: number;
  approval?: ApprovalChallenge;
  result?: Record<string, unknown>;
  error?: string;
  attempts?: number;
  receiptIds: string[];
  certificateId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Assemble the contract for a planned task.
 *
 * `classification` comes from `classifyOperation`, which lives in the policy
 * package; passing it in keeps this file free of dependencies and keeps one
 * classifier authoritative instead of a second copy that could disagree.
 */
export function effectContract(
  task: TaskRecord,
  classification: { capability: string; target: string },
): EffectContract {
  return {
    contractVersion: PROTOCOL_VERSION,
    taskId: task.id,
    identity: task.request.identity ?? LOCAL_IDENTITY,
    capability: classification.capability,
    operation: task.request.operation,
    effect: task.policyDecision.effect,
    risk: task.policyDecision.risk,
    target: classification.target,
    traits: task.policyDecision.traits,
    executionGuarantee: executionGuaranteeFor(
      task.policyDecision.effect,
      // `?? []` because a task record is durable JSON that outlives the code
      // that wrote it, and one persisted before this field existed has none.
      (task.request.reconciliation ?? []).length > 0,
    ),
    forbiddenEffects: task.request.forbiddenEffects,
    postconditions: task.request.requiredEvidence,
    budget: task.request.budget,
    ...(task.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: task.idempotencyKey }),
    policy: task.policyDecision,
    ...(task.approval === undefined ? {} : { authorization: task.approval }),
    metadata: { goal: task.request.goal },
  };
}

export const MelraCapabilitiesInputSchema = z.object({}).strict();
export const MelraPlanInputSchema = TaskRequestSchema;
export const MelraExecuteInputSchema = z
  .object({
    taskId: z.string().uuid(),
    approval: ApprovalResponseSchema.optional(),
  })
  .strict();
export const MelraTaskStatusInputSchema = z
  .object({ taskId: z.string().uuid() })
  .strict();
export const MelraTaskCancelInputSchema = z
  .object({ taskId: z.string().uuid() })
  .strict();
export const MelraReceiptBaseSchema = z
  .object({
    taskId: z.string().uuid().optional(),
    receiptId: z.string().uuid().optional(),
  })
  .strict();
export const MelraReceiptInputSchema = MelraReceiptBaseSchema
  .refine((value) => value.taskId !== undefined || value.receiptId !== undefined, {
    message: "taskId or receiptId is required",
  });

export const TOOL_NAMES = [
  "melra_capabilities",
  "melra_plan",
  "melra_execute",
  "melra_task_status",
  "melra_task_cancel",
  "melra_receipt",
  "melra_workflow_plan",
  "melra_workflow_advance",
  "melra_workflow_status",
  "melra_workflow_cancel",
  "melra_workflow_control",
] as const;
