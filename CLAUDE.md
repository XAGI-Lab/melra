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
approval (a phrase in developer mode, an operator's out-of-band decision in
enforced mode), record it durably before anything runs, deduplicate it by
idempotency key, run it under a budget and cancel signal, verify it against
declared evidence, and receipt it. Work that is not one of those nine jobs — a
model router, a planner, a prompt library, semantic memory about the user —
belongs to the agent above and does not go in this repo.

MCP over stdio is one of several interfaces onto the same runtime (MCP stdio,
MCP over loopback HTTP or a mode-`0600` Unix socket, CLI, TypeScript SDK, Python
SDK, read-only JSON API);
none of them is a shortcut past a stage of the pipeline. Eleven MCP tools sit in
front of five reference effect adapters (files, terminal, browser, computer, http)
plus
operational memory as a kernel service: six task tools (`melra_capabilities`,
`melra_plan`, `melra_execute`, `melra_task_status`, `melra_task_cancel`,
`melra_receipt`) and five durable-workflow tools (`melra_workflow_plan`,
`melra_workflow_advance`, `melra_workflow_status`, `melra_workflow_cancel`,
`melra_workflow_control`). pnpm workspace of TypeScript packages (Node 22.13+ or 23.4+, ESM,
strict tsc), plus two Python projects managed by `uv` (`sdk-py`,
`benchmarks/browser-agent`).

## Commands

```bash
pnpm install --frozen-lockfile
pnpm build                  # tsc -p per package; required before tests (see below)
pnpm typecheck              # builds, then tsc -p tsconfig.test.json per package (src + tests, no emit)
pnpm check                  # versions:check + docs:check + scripts/release.test.mjs (release scripts and workflow wiring) + typecheck + check-dist (no tests in dist/) + README examples + test + python:check — the CI gate
pnpm docs:check             # every relative link and #anchor in every *.md resolves; every MELRA_* variable has a row in docs/INSTALLATION.md; CHANGELOG.md is in Keep a Changelog shape, with a non-empty section for package.json's version
pnpm evals                  # 52 deterministic policy/execution scenarios → evals/results/latest.json
pnpm e2e                    # packages/server/test/e2e.test.ts against a live stdio server
pnpm pack:check              # npm pack --dry-run for the published CLI
pnpm readme:check           # typecheck every ```ts block in every package README
pnpm security:audit          # pnpm audit --prod + scripts/python-audit.mjs
pnpm melra <cmd>            # run the CLI from source via tsx (setup | doctor | conformance | init | serve | run | approve | console | inspect | export | tasks | watch | status | workflow | demo | clients | policy test | version)
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
pnpm benchmark:govbench     # builds, then GovBench (evals/src/govbench) → docs/research/results/govbench-*.json
pnpm benchmark:locomo -- --dataset <locomo10.json> --output <artifact.json>
pnpm benchmark:browser:verify-upstream
```

**Tests import workspace siblings through their `exports` → `dist/`, so `pnpm build` must
run before `pnpm test`** (this is why `typecheck` and `benchmark:*` scripts build first). A
test failing with an unresolved `@melra/*` import means a stale or missing `dist`.

`build`, `typecheck`, and `test` go through `scripts/run-recursive.mjs` rather than calling
`pnpm -r <script>` directly, because every recursive fan-out here multiplies. There is no
vitest pool config in the repo (`packages/browser-runtime/vitest.config.ts` sets only a CI retry), so every package defaults to a fork pool of `cores−1`; multiplied
by pnpm's default workspace-concurrency of 4 that is roughly `4 × (cores−1)` Node processes,
each with its own V8 heap. `tsc` has one level instead of two but holds a whole program graph
per process, so four builds in flight is several GiB on its own. Either one is enough to
exhaust memory on a 16 GiB machine. The script sizes the fan-out against RAM and core count
(≈0.4 GiB per test fork, ≈1.5 GiB per `tsc`) and passes it down as `--workspace-concurrency`
plus vitest's `--maxWorkers` flag (not `VITEST_MAX_WORKERS`, which vitest applies after
`--no-file-parallelism` and so overrides it). Run `pnpm test:peak-rss` to measure peak
resident memory before and after changing anything about how these are spawned. New recursive
scripts should route through the same runner, not add a second cap. A package whose test
files must not overlap uses `--no-file-parallelism` in its own `test` script (it only ever
lowers the fork count): `storage-sqlite`, and `browser-runtime`, whose files each launch
Chrome and hang on macOS CI runners when several run at once.

There is no ESLint/Prettier for TypeScript — `tsc --strict` is the only static gate. Python
uses ruff (line-length 100, py311). Vitest strips types without checking them, so tests are
type-checked only by `pnpm typecheck`: each package's `tsconfig.json` is the build (`src/`,
minus `src/**/*.test.ts`, so tests never reach `dist/` or the tarball) and its
`tsconfig.test.json` extends it with `src/` + `test/` and `noEmit`. A new package needs both.

## Execution pipeline (the core invariant)

`melra_plan` never executes. It classifies the operation, evaluates policy, persists a
`TaskRecord`, and — for mutations — returns a task-scoped, expiring approval challenge. In
developer mode its exact phrase must be echoed back; in enforced mode it has no phrase,
`melra_execute` refuses any approval the caller sends (`approval_in_band_refused`), and
only an `out_of_band` decision recorded by an enforced-mode process (`melra approve`,
`melra console`, or `melra run`'s prompt) lets it run
(`approval_awaiting_operator` until then). `melra_execute` **re-evaluates policy** so a stale plan
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

`policy.unhinged` (from `--unsafe-local`, the deprecated `--unhinged`, or
`MELRA_UNHINGED=1`) short-circuits
`evaluatePolicy` to `allow` — but *after* the `forbiddenEffects` and `constraints`
checks, because those are the caller bounding its own task rather than a guardrail
MELRA imposes. Confinement is lifted by rooting the file runtime, terminal
runtime, and verifier at `unconfinedRoot()` instead of the workspace, never by a
bypass branch inside the confinement code, so that code keeps exactly one
behaviour. `createMelraRuntime` resolves the flag once and `runtime.policy.unhinged`
is the only place to read it. A new guardrail needs a deliberate decision about
this mode: if it belongs to MELRA's judgement it goes above the early return, if
it protects the host from a crash (like `maxFileBytes`) it stays unconditional.

`policy.mode` is the orthogonal axis: `developer` (default) or `enforced`, parsed
by `deploymentMode` from `--mode`, `MELRA_MODE`, or `"mode"` in the policy JSON,
strictest of the three winning. Enforced mode is the operator asserting the
harness has no second path; MELRA cannot verify that, so it closes the doors it
owns — `assertEnforceable` refuses `--unsafe-local`, `serveHttp` refuses a
non-loopback bind (a mode-`0600` Unix socket via `socketPath` / `--socket` is
allowed) and serves no OAuth registration, and `mode` is stamped on
every receipt. It never grants anything, so a new feature only needs to ask
whether enforced mode should *refuse* it.

## Making changes

Adding or changing an operation action touches a fixed set of places, in this order:

1. `packages/protocol/src/index.ts` — the `*OperationSchema` (all schemas are `.strict()`, bounded, with defaults; unknown fields are rejected by design).
2. `packages/policy-core` `classifyOperation` — effect, risk, capability string, target.
3. The owning runtime package (`file-runtime`, `terminal-runtime`, `browser-runtime`, `computer-runtime`, `http-runtime`, `memory`).
4. `RuntimeRouter` in `packages/server/src/runtime.ts` if a new `kind` is introduced.
5. A scenario in `evals/src/scenarios.ts` asserting both `expectedPlan` and `expectedFinal`.

New evidence predicate types need `EvidencePredicateSchema` plus a `PredicateVerifier` in
`packages/verifier-core`'s `BUILT_IN` list; strength is stamped from the type in `verify`, never by
the verifier. The verifier resolves every path through `realpath` and rejects
anything outside the workspace root, including the root itself — keep that confinement when
adding predicates.

Redaction happens at multiple layers: `redactStructuredValue` on task requests, results, and
error messages before persistence, plus `redactMemoryValue` inside the memory package and
`redactTerminalOutput` in the terminal runtime. All three apply one secret-pattern list,
`SECRET_PATTERNS` in `packages/receipt-schema`, so a new secret format is added there once. Raw
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
- `advance()` chains per-workflow promises in an in-process map, so concurrent advances for one workflow serialize before any adapter runs. Duplicate effects and duplicate receipts are prevented here, not in the adapters. Across processes the same job is done by an expiring SQLite lease taken in `leasedAdvance` before any adapter runs; a second holder is refused with `workflow_lease_held`, and an advance whose lease was taken over fails with `workflow_lease_lost` before its next step and before it commits.
- Recovery only touches work whose process is gone. `saveTask(task, store.ownerId())` records the running task's owner, whose liveness is an exclusive SQLite lock on `<db>-owners/<ownerId>` that the kernel drops on exit; `claimInterruptedTask` takes a task by compare-and-set only when that lock is free. Workflow recovery runs under the run's lease (a distinct `recoveryOwner`), skips runs with a task still running, and `leasedAdvance` recovers a run whose lease expired before taking it over. The runtime sweeps every 30 s with `recoverInterrupted({ abandonedOnly: true })`. Locks are POSIX `fcntl` locks, which any in-process close of the same inode drops, so `createMelraRuntime` passes the data directory, the database files, `-owners`, `payload.key` and the `MELRA_POLICY` file to `FileRuntime` as `reserved` (matched by the holding directory's dev/ino and a case-insensitive name, so firmlinks, bind mounts and case variants are caught, and judged again with links resolved), and the `Verifier`, terminal and browser ask `files.isReserved`; none will open them, and no file effect may move, replace or remove a directory holding them. The one exception is `readable` (the artifacts directory): `isReserved(path, true)`, which the file adapter's read actions, the `Verifier` and the browser pass, lets them read inside it, and nothing may change it. A workspace inside the data directory is refused at startup (`workspace_inside_data_directory`). Tasks in flight are tracked on the store (`store.inFlight`), not per controller, because ownership is per store.
- Effects are deduplicated across restarts by `idempotencyKey` (`taskIdempotencyKey(identity, request)`) recorded in the `idempotency_commits` table. `recoverInterrupted()` replays committed work from that table rather than rerunning adapters. A verified task committed before its workflow projection is recovered, not re-executed.
- Events are append-only and ordered; projections and snapshots are derived. Read state through `status()`/`events()` rather than querying tables directly.
- Exact workflow definitions and adapter results are sealed with AES-256-GCM (`payload-cipher.ts`) bound to record identity and purpose. Keys come from `MELRA_PAYLOAD_KEY` or a mode-`0600` file (`packages/server/src/payload-key.ts`); permissive key files fail closed.

All of this lives in SQLite migrations 1–5 (`packages/storage-sqlite/src/index.ts`).
Schema changes need a new migration, not an edit to an existing one's statements.

## Versions must move in lockstep

`scripts/check-versions.mjs` (run by `pnpm check`) requires the root `package.json` version to
match every `apps/*` and `packages/*` manifest, the `PRODUCT_VERSION` constant in
`packages/protocol/src/index.ts`, `sdk-py/pyproject.toml` (with `-alpha.N` rewritten as
`aN`), and the `melra` entry in `sdk-py/uv.lock` and `benchmarks/browser-agent/uv.lock`. Bump
them together with `pnpm versions:set <version>`.

## Contribution conventions

- Commits are signed off (DCO); `scripts/check-dco.mjs` and `.github/workflows/dco.yml` enforce it. Commit subjects follow `type(scope): summary`, e.g. `bench(browser): add paired evaluator`.
- User-visible changes get a `CHANGELOG.md` entry under `## [Unreleased]`, in the existing `### Added`/`Changed`/`Deprecated`/`Removed`/`Fixed`/`Security` section (canonical order, one of each). `scripts/check-changelog.mjs` enforces the shape, and `.gitattributes` merges the file with `merge=union` so parallel branches stop conflicting there locally; GitHub's web merge ignores that, so rebase before merging and rerun `pnpm docs:check`.
- CI runs `pnpm check` on ubuntu/macos/windows × Node 22/24 (Python 3.11), plus the Python SDK tests and pyright on CPython 3.12–3.14, so avoid platform-specific paths and shell assumptions.

## Benchmark and claims discipline

Public numbers must be reproducible from committed scripts and JSON artifacts under
`docs/research/results/`, with dataset hashes and claim boundaries stated. Benchmark datasets
are deliberately not vendored (licensing). The browser benchmark is pre-registered: task IDs,
upstream revisions, and dataset hashes are frozen in `benchmarks/browser-agent/manifests/`
and checked by `verify-upstream`. Run outputs (`benchmarks/browser-agent/runs/`, HAR, PNG,
webm, transcripts) are gitignored — never commit raw traces, headers, or typed text. Do not
describe results as an official OSWorld/WebArena/LongMemEval score; the registered subset is
called "WebArena-Verified Hard-30 registered subset".
