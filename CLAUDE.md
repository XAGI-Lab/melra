# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MELRA is an agent-independent **autonomy kernel**: the layer an agent asks to
change the world through. Three layers, and the split is the whole design — the
LLM reasons, the harness manages the loop, MELRA owns the effect lifecycle.
MELRA begins where the tool call leaves the model loop. It owns effects, never
reasoning — nothing in `packages/` may call a model, and no decision in the
execution path may depend on model output.

**The feature test.** Before adding anything, ask: *would this feature still
make sense if the effect request came from ordinary deterministic software
rather than an LLM?* Authorization, idempotency, credential isolation, recovery,
verification, effect history, capabilities — yes, they belong here. Prompt
optimization, LLM memory, model selection, a planner, agent personality — no,
they belong to the harness above.

For every effect it does exactly nine things and nothing else: type it against a
strict schema, classify it, authorise it against policy, gate it on an exact
approval phrase, record it durably before anything runs, deduplicate it by
idempotency key, run it under a budget and cancel signal, verify it against
declared evidence, and receipt it. Work that is not one of those nine jobs — a
model router, a planner, a prompt library, semantic memory about the user —
belongs to the agent above and does not go in this repo.

MCP over stdio is one of several interfaces onto the same runtime (MCP stdio,
MCP over loopback HTTP, CLI, TypeScript SDK, Python SDK, read-only JSON API);
none of them is a shortcut past a stage of the pipeline. Eleven MCP tools sit in
front of four reference effect adapters (files, terminal, browser, computer) plus
operational memory as a kernel service: six task tools (`melra_capabilities`,
`melra_plan`, `melra_execute`, `melra_task_status`, `melra_task_cancel`,
`melra_receipt`) and five durable-workflow tools (`melra_workflow_plan`,
`melra_workflow_advance`, `melra_workflow_status`, `melra_workflow_cancel`,
`melra_workflow_control`). pnpm workspace of TypeScript packages (Node 22+, ESM,
strict tsc), plus two Python projects managed by `uv` (`sdk-py`,
`benchmarks/browser-agent`).

## Commands

```bash
pnpm install --frozen-lockfile
pnpm build                  # tsc -p per package; required before tests (see below)
pnpm check                  # versions:check + typecheck + test + python:check — the CI gate
pnpm evals                  # 40 deterministic policy/execution scenarios → evals/results/latest.json
pnpm e2e                    # packages/server/test/e2e.test.ts against a live stdio server
pnpm pack:check              # npm pack --dry-run for the published CLI
pnpm readme:check           # typecheck every ```ts block in every package README
pnpm security:audit          # pnpm audit --prod + scripts/python-audit.mjs
pnpm melra <cmd>            # run the CLI from source via tsx (doctor | init | serve | run | inspect | policy test)
```

Single test file (vitest args pass through the package script):

```bash
pnpm --filter @melra/memory test src/index.test.ts
pnpm --filter @melra/memory test -t "ranks exact phrases"
```

Python:

```bash
pnpm python:check           # ruff + pytest for sdk-py
pnpm benchmark:browser:check # ruff + pytest for benchmarks/browser-agent
```

Benchmarks (see README "Reproduce the scores" for the full MiniWoB/LoCoMo invocations):

```bash
pnpm benchmark:core         # builds, then scripts/bench-core.mjs
pnpm benchmark:locomo -- --dataset <locomo10.json> --output <artifact.json>
pnpm benchmark:browser:verify-upstream
```

**Tests import workspace siblings through their `exports` → `dist/`, so `pnpm build` must
run before `pnpm test`** (this is why `typecheck` and `benchmark:*` scripts build first). A
test failing with an unresolved `@melra/*` import means a stale or missing `dist`.

`build`, `typecheck`, and `test` go through `scripts/run-recursive.mjs` rather than calling
`pnpm -r <script>` directly, because every recursive fan-out here multiplies. There is no
vitest config in the repo, so every package defaults to a fork pool of `cores−1`; multiplied
by pnpm's default workspace-concurrency of 4 that is roughly `4 × (cores−1)` Node processes,
each with its own V8 heap. `tsc` has one level instead of two but holds a whole program graph
per process, so four builds in flight is several GiB on its own. Either one is enough to
exhaust memory on a 16 GiB machine. The script sizes the fan-out against RAM and core count
(≈0.4 GiB per test fork, ≈1.5 GiB per `tsc`) and passes it down as `--workspace-concurrency`
plus `VITEST_MAX_FORKS`/`VITEST_MAX_THREADS`. Run `pnpm test:peak-rss` to measure peak
resident memory before and after changing anything about how these are spawned. New recursive
scripts should route through the same runner, not add a second cap.

There is no ESLint/Prettier for TypeScript — `tsc --strict` is the only static gate. Python
uses ruff (line-length 100, py311).

## Execution pipeline (the core invariant)

`melra_plan` never executes. It classifies the operation, evaluates policy, persists a
`TaskRecord`, and — for mutations — returns a task-scoped, expiring approval challenge whose
exact phrase must be echoed back. `melra_execute` **re-evaluates policy** so a stale plan
cannot ride a since-tightened policy, validates the approval, runs the adapter under an
`AbortSignal` armed with `budget.maxDurationMs`, then verifies.

Verification is what decides success. `TaskController` (`packages/runtime-core/src/task-controller.ts`)
marks a task `verified_success` only when the adapter succeeded *and* every
`requiredEvidence` predicate passed; an adapter that succeeded with failing evidence is
`partial`, never success. Read-only ops with no declared evidence get a synthetic
`operation_completed` item. Retries apply to `read` effects only — mutations and destructive
ops run at most once.

Policy (`packages/policy-core/src/index.ts`) denies before the adapter is reached. Non-obvious
defaults that trip people up:

- A non-empty `constraints` array is an outright **deny** (`freeform_constraints_not_enforceable`) — freeform prose is not enforceable, so leave it `[]`.
- Any non-`read` effect with empty `requiredEvidence` is denied (`mutation_requires_evidence`).
- Terminal commands must be in `allowedCommands` by basename; shells and `sudo`/`su` are denied unconditionally. `git`'s effect is `read` only for a small read-only subcommand set; `npm`/`npx`/`pnpm` are high-risk mutations.
- Browser destinations default to `allowedDomains: ["*"]` with `allowLocalhost: true`, so browsing works without a policy JSON. The allowlist is a narrowing control; `assertSafeUrl` in `browser-runtime` is the actual boundary and independently rejects non-http(s) protocols, URL credentials, private/link-local ranges, and cloud metadata, resolving DNS first so a public name cannot be rebound.
- Effect/risk classification lives in one place, `classifyOperation`. Adding an action without updating it silently mis-classifies (usually as a mutation).

`policy.unhinged` (from `--unhinged` or `MELRA_UNHINGED=1`) short-circuits
`evaluatePolicy` to `allow` — but *after* the `forbiddenEffects` and `constraints`
checks, because those are the caller bounding its own task rather than a guardrail
MELRA imposes. Confinement is lifted by rooting the file runtime, terminal
runtime, and verifier at `unconfinedRoot()` instead of the workspace, never by a
bypass branch inside the confinement code, so that code keeps exactly one
behaviour. `createMelraRuntime` resolves the flag once and `runtime.policy.unhinged`
is the only place to read it. A new guardrail needs a deliberate decision about
this mode: if it belongs to MELRA's judgement it goes above the early return, if
it protects the host from a crash (like `maxFileBytes`) it stays unconditional.
- `policy.unhinged` (`--unhinged` / `MELRA_UNHINGED=1`) short-circuits `evaluatePolicy` to `allow` with reason `unhinged_mode_no_guardrails`, *after* the `forbiddenEffects` and `constraints` checks — those are the caller bounding its own request, not a guardrail MELRA imposes. Confinement is lifted in `createMelraRuntime` by rooting the file/terminal runtimes and the verifier at `unconfinedRoot(workspaceRoot)` rather than by branching inside them, so confinement code keeps exactly one behaviour. New guardrails should follow the same shape: either move the boundary or check `policy.unhinged` at the single point that owns the boundary, never scatter bypasses.

## Making changes

Adding or changing an operation action touches a fixed set of places, in this order:

1. `packages/protocol/src/index.ts` — the `*OperationSchema` (all schemas are `.strict()`, bounded, with defaults; unknown fields are rejected by design).
2. `packages/policy-core` `classifyOperation` — effect, risk, capability string, target.
3. The owning runtime package (`file-runtime`, `terminal-runtime`, `browser-runtime`, `computer-runtime`, `memory`).
4. `RuntimeRouter` in `packages/server/src/runtime.ts` if a new `kind` is introduced.
5. The `operations` map in `melra_capabilities` (`packages/server/src/mcp-server.ts`) — it is a hand-maintained list, not derived from the schemas.
6. A scenario in `evals/src/scenarios.ts` asserting both `expectedPlan` and `expectedFinal`.

New evidence predicate types need `EvidencePredicateSchema` plus a branch in
`packages/verifier-core`. The verifier resolves every path through `realpath` and rejects
anything outside the workspace root, including the root itself — keep that confinement when
adding predicates.

Redaction happens at multiple layers: `redactStructuredValue` on task requests, results, and
error messages before persistence, plus `redactMemoryValue` inside the memory package. Raw
output goes only to the live caller; SQLite holds the redacted copy. New fields that can
carry secrets must pass through one of these.

`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on, which is why the codebase
uses the conditional-spread idiom (`...(x === undefined ? {} : { x })`) instead of passing
`undefined`. Match it rather than loosening types.

Every source file carries the two-line `Copyright 2026 XAGI Labs Private Limited` /
`SPDX-License-Identifier: Apache-2.0` header.

## Durable workflows

`WorkflowController` (`packages/runtime-core/src/workflow-controller.ts`) layers a bounded
graph over the same task pipeline — every workflow node that does work goes through
`TaskController`, so policy, approvals, verification, and receipts are never bypassed. Nine
node types: `operation`, `approval`, `condition`, `parallel`, `bounded_loop`, `checkpoint`,
`compensation`, `human_input`, `delegation`. The last two block on a person or an outside
worker; `advance(id, approvals, inputs)` clears them, and a `delegation` node's declared
evidence still decides the outcome — a delegate reporting "done" is not evidence.

Invariants worth knowing before touching this code:

- `validateWorkflow` (`workflow-graph.ts`) rejects dependency cycles at plan time (`workflow_dependency_cycle`), so `advance` can assume a finite graph. Loop bounds come from the schema instead: `bounded_loop.maxIterations` is capped at 100 by `WorkflowNodeSchema` and enforced by the controller's iteration guard. Adding a node type means updating both `validateWorkflow` and `readyNodeIds`.
- `advance()` chains per-workflow promises in an in-process map, so concurrent advances for one workflow serialize before any adapter runs. Duplicate effects and duplicate receipts are prevented here, not in the adapters. Across processes the same job is done by an expiring SQLite lease taken in `leasedAdvance` before any adapter runs; a second holder is refused with `workflow_lease_held`.
- Effects are deduplicated across restarts by `idempotencyKey` (`taskIdempotencyKey(identity, request)`) recorded in the `idempotency_commits` table. `recoverInterrupted()` replays committed work from that table rather than rerunning adapters. A verified task committed before its workflow projection is recovered, not re-executed.
- Events are append-only and ordered; projections and snapshots are derived. Read state through `status()`/`events()` rather than querying tables directly.
- Exact workflow definitions and adapter results are sealed with AES-256-GCM (`payload-cipher.ts`) bound to record identity and purpose. Keys come from `MELRA_PAYLOAD_KEY` or a mode-`0600` file (`packages/server/src/payload-key.ts`); permissive key files fail closed.

All of this lives in SQLite migration version 1 (`packages/storage-sqlite/src/index.ts`).
Schema changes need a new migration, not an edit to the version-1 statements.

## Versions must move in lockstep

`scripts/check-versions.mjs` (run by `pnpm check`) requires the root `package.json` version to
match every `apps/*` and `packages/*` manifest, the `PRODUCT_VERSION` constant in
`packages/protocol/src/index.ts`, and `sdk-py/pyproject.toml` (with `-alpha.N` rewritten as
`aN`). Bump all four together.

## Contribution conventions

- Commits are signed off (DCO); `scripts/check-dco.mjs` and `.github/workflows/dco.yml` enforce it. Commit subjects follow `type(scope): summary`, e.g. `bench(browser): add paired evaluator`.
- User-visible changes get a `CHANGELOG.md` entry under `## [Unreleased]` (Keep a Changelog sections).
- CI runs `pnpm check` on ubuntu/macos/windows × Node 22/24, so avoid platform-specific paths and shell assumptions.

## Benchmark and claims discipline

Public numbers must be reproducible from committed scripts and JSON artifacts under
`docs/research/results/`, with dataset hashes and claim boundaries stated. Benchmark datasets
are deliberately not vendored (licensing). The browser benchmark is pre-registered: task IDs,
upstream revisions, and dataset hashes are frozen in `benchmarks/browser-agent/manifests/`
and checked by `verify-upstream`. Run outputs (`benchmarks/browser-agent/runs/`, HAR, PNG,
webm, transcripts) are gitignored — never commit raw traces, headers, or typed text. Do not
describe results as an official OSWorld/WebArena/LongMemEval score; the registered subset is
called "WebArena-Verified Hard-30 registered subset".
