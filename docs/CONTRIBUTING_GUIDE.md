# Where to make a change

`CONTRIBUTING.md` covers the rules — DCO, review, scope. This page covers the
part that is actually hard the first time: *which files does my change touch?*

Every entry below is a real path in this repository, and every checklist is the
one a maintainer will read your pull request against.

## Get it running first

```bash
git clone https://github.com/XAGI-Lab/melra.git
cd melra
pnpm install --frozen-lockfile
pnpm build          # required before tests — see below
pnpm melra doctor   # should print a green report
```

**`pnpm build` before `pnpm test`, always.** Tests import workspace siblings
through their `exports` map, which points at `dist/`. A test failing with an
unresolved `@melra/*` import means a stale or missing `dist`, not a broken test.

The full gate is `pnpm check` (versions + typecheck + README examples + tests +
Python). It is what CI runs. On a 16 GiB machine it peaks around 13 GiB, so
close your browser first — or run the pieces individually while iterating:

```bash
pnpm --filter @melra/policy-core test          # one package
pnpm --filter @melra/memory test -t "ranks exact phrases"   # one test
pnpm evals                                     # 48 policy/execution scenarios
pnpm e2e                                       # real MCP stdio session
pnpm conformance                               # black-box level check
```

There is no ESLint and no Prettier. `tsc --strict` is the only static gate for
TypeScript; Python uses ruff (line length 100, py311).

## The one question before you write anything

> **Would this feature still make sense if the effect request came from
> ordinary deterministic software rather than an LLM?**

Yes → it belongs here. No → it belongs to the harness above, and putting it here
would make MELRA's guarantees depend on a model's judgement. This settles most
scope arguments before they start, and a pull request that fails it will be
closed with a link back to this line, however good the code is.

## I want to…

### …add or change an operation action

Five files, in this order. Skipping step 2 is the classic mistake: the operation
works, and is silently classified as a mutation with the wrong risk.

1. **`packages/protocol/src/index.ts`** — the `*OperationSchema`. Every schema
   is `.strict()`, bounded, and has defaults. Unknown fields are rejected by
   design; do not relax that to make a field optional.
2. **`packages/policy-core/src/index.ts`** — `classifyOperation`. Effect
   (`read` / `mutation` / `destructive`), risk, capability string, target. This
   is the single place classification lives.
3. **The owning runtime package** — `file-runtime`, `terminal-runtime`,
   `browser-runtime`, `computer-runtime`, or `memory`.
4. **`packages/server/src/runtime.ts`** — `RuntimeRouter`, only if you introduced
   a new `kind`.
5. **`packages/server/src/mcp-server.ts`** — the `operations` map inside
   `melra_capabilities`. It is hand-maintained, not derived from the schemas.
6. **`evals/src/scenarios.ts`** — a scenario asserting both `expectedPlan` and
   `expectedFinal`. Not optional: an operation without a scenario is an operation
   whose policy behaviour nobody has stated.

### …add an evidence predicate

- `EvidencePredicateSchema` in `packages/protocol`
- a branch in `packages/verifier-core`
- the verifier resolves every path through `realpath` and rejects anything
  outside the workspace root, **including the root itself**. Keep that
  confinement. A predicate that can be pointed at `/etc` is not a predicate, it
  is a file-read primitive with extra steps.

### …add a policy rule

`packages/policy-core/src/index.ts`. Read the existing defaults first — several
are non-obvious and deliberate:

- a non-empty `constraints` array is an outright **deny**
  (`freeform_constraints_not_enforceable`) — prose is not enforceable;
- any non-`read` effect with no derivable evidence is denied
  (`mutation_requires_evidence`);
- shells and `sudo`/`su` are denied unconditionally, not allowlistable.

Then decide the `unhinged` question explicitly, because there is no default that
is right for every rule: if your rule is **MELRA's judgement** about what a
caller should be allowed to do, it goes *above* the early return and is lifted
by unhinged mode. If it protects the host from a crash (like `maxFileBytes`), it
stays unconditional. Never scatter a `policy.unhinged` check inside the code that
owns a boundary — move the boundary instead, the way `createMelraRuntime` roots
the runtimes at `unconfinedRoot()`.

### …add a workflow node type

`packages/runtime-core/src/workflow-controller.ts`, plus **both**
`validateWorkflow` and `readyNodeIds` in `workflow-graph.ts`. Updating one and
not the other produces a node that either never becomes ready or never gets
validated.

### …change the database

`packages/storage-sqlite/src/index.ts`. Everything currently lives in migration
version 1. A schema change needs a **new migration**, never an edit to the
version-1 statements — someone out there has a database that already ran them.

### …touch anything that can carry a secret

It must pass through `redactStructuredValue` (task requests, results, error
messages) or `redactMemoryValue` (memory). Raw output goes only to the live
caller; SQLite holds the redacted copy. A new field that carries a token and
skips both is a data leak with a passing test suite.

## House style

- `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on. That is
  why the codebase writes `...(x === undefined ? {} : { x })` instead of passing
  `undefined`. Match it rather than loosening the types.
- Every source file carries the two-line copyright and `SPDX-License-Identifier`
  header.
- Comments explain *why*, not *what*. If a line needs a comment saying what it
  does, the line is the problem.
- Commit subjects are `type(scope): summary` — `fix(terminal):`, `docs:`,
  `bench(browser):`. Sign off with `git commit -s` (DCO, enforced by CI).
- User-visible changes get a `CHANGELOG.md` entry under `## [Unreleased]`.

## Before you open the pull request

- [ ] `pnpm check` passes
- [ ] new behaviour has a test that fails without your change
- [ ] `pnpm evals` still reports 48/48 if you touched policy or execution
- [ ] docs updated for any public contract
- [ ] `CHANGELOG.md` entry under `## [Unreleased]` if a user would notice
- [ ] commits signed off

CI runs the gate on ubuntu/macOS/windows × Node 22/24, so avoid
platform-specific paths and shell assumptions. Windows is the one that catches
people: `win32` path handling and `.cmd` resolution are both real concerns here.

## Where to start

Issues labelled [`good first issue`](https://github.com/XAGI-Lab/melra/labels/good%20first%20issue)
are scoped so that the description tells you which files to open.
[`help wanted`](https://github.com/XAGI-Lab/melra/labels/help%20wanted) is larger
work that is nonetheless well-specified. The
[roadmap milestones](https://github.com/XAGI-Lab/melra/milestones) hold the big
pieces — P2 enforced mode, P3 verification framework, P4 credentials and API
effects — each with an issue explaining the design before any code exists, which
is the right time to argue with it.

Unsure whether an idea fits? Open a
[discussion](https://github.com/XAGI-Lab/melra/discussions) rather than a pull
request. Scope disagreements are much cheaper before the code is written.
