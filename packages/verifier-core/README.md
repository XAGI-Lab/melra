# @melra/verifier-core

Evidence verification for [MELRA](https://github.com/XAGI-Lab/melra). Checks
declared predicates against the real filesystem and the real adapter output
after an operation runs, so success is something observed rather than something
an adapter claimed.

```bash
npm install @melra/verifier-core
```

```ts
import { Verifier } from "@melra/verifier-core";

const verifier = await Verifier.create(workspaceRoot);
const items = await verifier.verify(request.requiredEvidence, output);
```

Supported predicates cover file existence, absence, and content hashes, exit
codes, result values and substrings, URL globs, page text, and
`http_resource_matches`, a second `GET`/`HEAD` that asks the provider rather
than the call that acted. Read-only operations with no declared
evidence get a synthetic `operation_completed` item, so a receipt never has an
empty evidence list.

Every path is resolved through `realpath` and rejected if it lands outside the
workspace root, including the root itself — a symlink cannot be used to verify a
file the task was never allowed to touch.

## Your own verifiers

Each predicate type is checked by a `PredicateVerifier`, the built-ins included.
An embedder can register more for types the kernel does not ship:

```ts
import { Verifier, type PredicateVerifier } from "@melra/verifier-core";

const rowExists: PredicateVerifier<{ type: "row_exists"; id: string }> = {
  type: "row_exists",
  async check(predicate, result) {
    const passed = Array.isArray(result.rows) && result.rows.includes(predicate.id);
    return { passed, summary: `row ${predicate.id} ${passed ? "present" : "missing"}` };
  },
};

const withRows = await Verifier.create(workspaceRoot, { verifiers: [rowExists] });
await withRows.verify([{ type: "row_exists", id: "r1" }], output);
```

What a verifier does **not** decide:

- **Its strength.** `type` and `strength` are stamped by the kernel from the
  predicate type, over anything `check` returns, so a new type reads as the
  weakest claim (`execution`) rather than declaring itself `independent`.
- **Whether an unanswerable question passes.** A type with no verifier, and a
  `check` that throws, are failed items marked `inconclusive`: no answer, not a
  no. The kernel's own refusals (a path outside the workspace, a URL token with
  nothing to fill it, a type with no verifier) are also `unanswerable`, and a
  verifier cannot set that flag itself. `outsideWorkspace(predicate)` says
  before anything runs whether a file predicate's path could only be refused.
- **What a built-in means.** Registering a built-in type is refused
  (`verifier_type_taken`).
- **Where files are.** The only file access offered is
  `context.workspacePath()`, which applies the confinement above.

A task request reaches a registered verifier with
`{ "type": "custom", "verifier": "row_exists", "params": { "id": "r1" } }`, once
the runtime has it (`createMelraRuntime({ evidenceVerifiers })` in
`@melra/server`). The evidence is stamped `custom:row_exists`, and `custom` can
never name a built-in.

Requires Node.js 22 or newer. Full documentation:
[github.com/XAGI-Lab/melra](https://github.com/XAGI-Lab/melra)

Apache-2.0
