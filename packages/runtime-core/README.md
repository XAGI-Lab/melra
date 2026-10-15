# @melra/runtime-core

The execution core of [MELRA](https://github.com/XAGI-Lab/melra): the task
controller, the durable workflow controller, verification gating, retry rules,
and the payload cipher.

```bash
npm install @melra/runtime-core
```

`TaskController` owns the pipeline. `plan()` classifies the operation, evaluates
policy, persists a `TaskRecord`, and returns any approval challenge — it never
executes. `execute()` re-evaluates policy, validates the approval (or, in
enforced mode, requires an operator's out-of-band decision), runs the adapter
under an `AbortSignal` armed with the duration budget, then verifies.

Verification decides success, not the adapter. A task reaches
`verified_success` only when the adapter succeeded *and* every declared evidence
predicate passed; an adapter that reported success with failing evidence is
`partial`. Retries apply to `read` effects only — mutations and destructive
operations run at most once, because a retried delete is a second delete.

`WorkflowController` layers a bounded graph over that same pipeline. Nine node
types (`operation`, `approval`, `condition`, `parallel`, `bounded_loop`,
`checkpoint`, `compensation`, `human_input`, `delegation`), and every node that
does work goes through `TaskController` — so policy, approvals, verification, and
receipts are never bypassed by being inside a workflow.

Workflow durability, briefly:

- Dependency cycles are rejected at plan time, so `advance` can assume a finite
  graph. Loop bounds are capped by the schema and enforced by an iteration guard.
- Concurrent advances for one workflow serialize before any adapter runs, and a
  cross-process lease keeps a second server from advancing the same workflow.
- Effects are deduplicated across restarts by idempotency key. Recovery replays
  committed work rather than rerunning adapters, so a task that committed before
  its projection was written is recovered, not re-executed.
- Events are append-only and ordered; projections and snapshots are derived. Read
  state through `status()`/`events()`.
- Definitions and adapter results are sealed with AES-256-GCM bound to record
  identity and purpose.

Requires Node.js 22 or newer. Full documentation:
[github.com/XAGI-Lab/melra](https://github.com/XAGI-Lab/melra)

Apache-2.0
