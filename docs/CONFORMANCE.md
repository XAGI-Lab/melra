# Conformance

A runtime that speaks the MELRA tools is asking to be trusted with real
effects. Having the right tool names is not that claim. This page defines what
a conformance level means, how to earn one, and — as important — what a level
does not tell you.

```bash
npx -y @melra/cli conformance                        # spawn a local stdio server and check it
npx -y @melra/cli conformance --url http://127.0.0.1:7457/mcp --token "$MELRA_HTTP_TOKEN"
npx -y @melra/cli conformance --level 2              # claim L2; exit 0 if the endpoint reaches it
```

The suite is a black-box client. It connects over a real transport, drives one
probe effect through the whole pipeline, and reports the highest level with no
failed check at or below it. It never reads the endpoint's disk, so it works
against a remote endpoint: the probe effect is verified by reading it back
*through the kernel*.

One exception, in enforced mode only: the agent may not approve anything there,
so the L3 checks need an operator's yes. When the suite spawned the server
itself, it gives that yes by running its own
`melra approve <task-id> --yes --mode enforced` (approver
`cli:melra-conformance`), which writes the decision through the local data
directory, so that run is no longer purely black-box. Against `--url` there is
no such approver, and an enforced endpoint stops at L2.

Exit code is `0` when the endpoint reaches the claimed level and `1` when it
falls short. `--level` defaults to `3`. In a terminal it prints each check, the
level reached, and what the suite does not prove; with `--json` or through a
pipe the report is JSON on stdout. Publish the JSON verbatim to claim a level.

## The levels

Levels are cumulative and ordered by what they let you conclude.

### L1 — typed effects

Every effect is a strict, bounded, typed request. An effect that cannot be
expressed as one cannot be run.

| Check | What it establishes |
|---|---|
| `kernel-tools-present` | All eleven kernel tools are exposed. An adapter may add tools; it may not remove one. |
| `capabilities-describe-the-surface` | The endpoint describes its own operations, so a caller does not have to guess them. |
| `unknown-field-rejected` | A request carrying an unrecognised field is refused, not silently accepted with the field dropped. |
| `incomplete-operation-rejected` | A request missing a required field is refused before anything runs. |
| `plan-returns-an-effect-contract` | Planning yields a typed contract naming the effect, its classification, and the execution guarantee it carries. |

### L2 — governed effects

Policy and approval decide before anything runs, and a refusal means the effect
did not happen.

| Check | What it establishes |
|---|---|
| `mutation-is-held-for-approval` | Planning a mutation produces a task-scoped, expiring approval challenge rather than running it — and publishes `at-most-once`, so the caller knows a failure will not be retried before it approves. |
| `no-approval-is-refused` | Executing without the approval is refused. |
| `wrong-phrase-is-refused` | Developer mode only. Executing with the wrong phrase is refused; the challenge is not decorative. |
| `approval-credential-withheld` | Enforced mode only. Neither the plan nor the task record carries an approval phrase, by key or by value: the agent is handed nothing to echo. |
| `in-band-approval-refused` | Enforced mode only. Executing with the phrase a developer-mode kernel would have issued, which anyone can derive from the challenge, is refused and the task is still awaiting approval. |
| `refused-effects-did-not-happen` | After both refusals the file they would have created does not exist. This is the one that matters: a refusal is a fact about the world, not a message. |
| `freeform-constraints-are-denied-as-a-result` | Unenforceable prose constraints are denied as a policy result — and still denied at execute, so a stale plan cannot ride past a decision. |

### L3 — verified effects

Nothing counts as success without evidence, and every effect leaves a receipt
that outlives the call.

| Check | What it establishes |
|---|---|
| `approved-mutation-verifies` | An approved mutation reaches `verified_success` with passing evidence, not merely "the adapter returned" — and every item says how it was established, with at least one the kernel re-read for itself (`strength: "state"`). |
| `the-effect-really-happened` | The approved bytes are on disk, read back through the kernel. |
| `the-receipt-outlives-the-call` | The receipt for a finished task is still retrievable after other tasks have run. |
| `approval-provenance-recorded` | Enforced mode only. The receipt and the certificate both say the approval came `out_of_band`. |
| `destructive-effects-are-gated-and-verified` | A destructive effect needs its own approval and verifies as absent afterwards. |

## What a level does not prove

The report carries these in a `notProven` array. Read them before quoting a
result.

- **That the harness has no second, ungoverned path to the same systems.** A
  harness holding both a MELRA terminal and a native one makes the kernel
  optional, and an optional boundary is not a trust boundary. Nothing
  observable from this side distinguishes the two. If you are certifying your
  own harness, this is the part only you can answer.

  This is the one entry that changes with the endpoint. `melra_capabilities`
  publishes `policy.mode`, and the report echoes it. Against an endpoint
  reporting `enforced`, the caveat narrows to *"that the operator's
  enforced-mode claim is true"* — the suite checked the refusals MELRA owns
  (no `--unsafe-local`, loopback only, no self-registering client, and it fails
  the endpoint outright if it claims enforced mode while running with no
  guardrails), and what is left is a fact about the deployment rather than about
  the endpoint. That includes approvals: `melra approve` counts as out of band
  because it runs with OS access to the data directory, which makes it an
  operator only if the agent has none. Enforced mode swaps checks rather than
  earning any: 14 in developer mode, 16 in enforced (5 at L1, 6 at L2, 5 at
  L3).
- **That the endpoint's own policy is well chosen.** The suite checks that
  policy is consulted and obeyed, not that it says the right thing. An endpoint
  that allows everything and an endpoint with a careful allowlist both reach
  L3; they differ in a way this suite cannot see.
- **Anything about effects the suite does not exercise.** It probes one file
  effect end to end. Browser, terminal, computer, and memory adapters are out
  of scope.

`--unsafe-local` removes the guardrails by design, so an unsafe-local endpoint reaches
L1 and stops there. That is the correct result, not a bug.

## The probe effect

The suite writes one file, reads it back, and deletes it. The name is
`melra-conformance-<8 hex>.txt` in the workspace root — unique per run, so it
cannot collide with or delete a file that was already there, and flat rather
than a directory, so cleanup is one named file and never a recursive delete.

If a failure between the write and the delete leaves the probe behind, the
report says so in `uncleanedProbeFile` rather than staying quiet.

## Reproducing

`pnpm conformance` builds, then runs the suite from source against a stdio
server in the current workspace (`MELRA_WORKSPACE`, or the directory you run it
from), where it writes and removes the one probe file.
The result observed for this release is recorded in
[VALIDATION.md](VALIDATION.md).
