# MELRA GovBench

GovBench measures what MELRA is for: governing effects. Every case is a
request plus the outcome MELRA must produce. Each one runs through the real
runtime (`createMelraRuntime`, then `TaskController` plan → approve → execute
→ verify) with the real file, terminal, HTTP, memory, and browser adapters. It
makes no model calls. The only network it uses is a loopback fixture server
that the harness starts itself.

## Current result

| | Result |
|---|---:|
| Safety (containment + approval + verification + exactly-once + redaction) | **312/312** (100%) |
| Utility (benign operations allowed and `verified_success`) | **50/50** (100%) |
| Containment | 197/197 |
| Approval integrity | 19/19 |
| Verification honesty | 30/30 |
| Exactly-once | 11/11 |
| Redaction | 55/55 |

These scores come from the 362-case corpus (sha256 `e09038f9…`), run against
MELRA `0.3.0-alpha.12` at commit `02a9533` (clean tree) on an Apple M4 with Node
`v26.8.2` and Chrome present. No cases were skipped. The full run takes about
15–30 s. The raw artifact is
[`results/govbench-0.3.0-alpha.12-2026-10-14.json`](results/govbench-0.3.0-alpha.12-2026-10-14.json).

That corpus adds five verification cases for `custom` evidence to the
original 357: a satisfied and an unsatisfied registered verifier, one pointed
outside the workspace, evidence no registered verifier can check (refused at
plan time), and `custom` naming a built-in (refused). The earlier 357-case run,
safety `307/307`, is kept as
[`results/govbench-0.3.0-alpha.11-2026-10-14.json`](results/govbench-0.3.0-alpha.11-2026-10-14.json).

Governance overhead on that run, median of 40 against the raw adapter call:
file read +0.57 ms, approved file write +0.57 ms, loopback HTTP GET +0.51 ms,
approved memory put +0.47 ms, approved terminal run +1.31 ms. Overhead depends
on machine load; the first run, taken while other builds were running, measured
+1.1 to +4.4 ms.

### What the first run found

The first run, on the original 357-case corpus before any fix, scored **293/307** safety.
Its 14 failures were not marked as expected; they were two real bugs, both since
fixed, and the run above is the same corpus after the fixes:

1. **Bracketed IPv6 literals skip the private-address check (12 cases).**
   WHATWG `URL.hostname` keeps the brackets (`"[::1]"`), so `isIP(host)` in
   `assertSafeDestination` (`packages/policy-core/src/network-policy.ts`)
   returns `0`. The code then treats the literal as a DNS name. Every such
   request still failed, and the canary server saw no hit, but only because
   `getaddrinfo` cannot resolve a bracketed string (`ENOTFOUND`). The
   documented boundary never ran. Containment here depends on resolver
   behaviour, and public IPv6 literals cannot be used at all. Affected
   destinations: `[::1]`, `[::]`, `[fd00::1]`, `[fe80::1]`, and IPv4-mapped
   `[::ffff:…]` forms of loopback and `169.254.169.254`, over both HTTP and
   the browser.
   Fixed in [#119](https://github.com/XAGI-Lab/melra/pull/119): the brackets
   are stripped before the address is classified.
2. **Memory values keep PEM private keys and AWS access key ids (2 cases).**
   `redactMemoryValue` is pattern-based, and it has no pattern for
   `-----BEGIN PRIVATE KEY-----` blocks or `AKIA…` ids. When one of these is
   stored with `memory put`, it is written verbatim to `melra.sqlite`. The
   same secrets placed in every other sink tested are absent from the
   database: goal, file content, terminal args/stdout, HTTP body, response,
   headers and query, and evidence values. Those sinks are covered by
   key-based redaction or by sealing.
   Fixed in [#120](https://github.com/XAGI-Lab/melra/pull/120): memory,
   terminal output, and receipts now share one secret-pattern list, which
   knows both shapes.

## What each category asserts

| Category | Cases | Pass condition |
|---|---:|---|
| Containment | 197 | Refused at the schema, plan-time policy, execute-time policy, or the adapter boundary, with the documented reason. No effect is observed: the loopback canary is not hit, the directory outside the workspace is byte-identical, no outside content is returned, and no `pwned*` file appears. Anything that asks for approval **is approved**, so a pass means the boundary held after a human said yes. Shell-metacharacter arguments to `echo` must stay inert. |
| Approval integrity | 19 | Missing, wrong, case-changed, padded, wrong-id, other-task, expired, replayed, cancelled, and policy-blocked approvals are refused, and the effect (file or fixture hit) never happens. Plans made under a looser policy are refused at execute after a restart under a tighter one, covering mutations, grants, allowlist, network trait, localhost, domains, and unhinged → guarded. |
| Verification honesty | 30 | The final status is exactly the expected one. Adapter success with failing evidence is `partial`. Evidence pointing outside the workspace or at its root never passes. Non-zero exits and 5xx/3xx responses are `failed`. A mutation sent but never answered is `recovery_required`, while a read is `failed`. `custom` evidence decides through its registered verifier, gets no read outside the workspace, and is refused at plan time when no verifier is registered or when it names a built-in. |
| Exactly-once | 11 | The side effect is counted at the source (fixture hits, file content, memory rows). Same idempotency key twice, concurrent executes, re-execute, restart with the same key, re-executing a parked task, and `maxRetries` on a mutation all produce one effect. |
| Redaction | 55 | Seven fake secret shapes go into seven sinks (plus headers and URL queries for three of them). After the runtime closes, every file in the data directory (`melra.sqlite`, `-wal`, `-shm`, artifacts) is scanned byte-for-byte for the secret, its JSON-escaped form, and its long fragments. |
| Utility | 50 | Routine file, terminal, HTTP (loopback with `allowLocalhost`), memory, system, and browser work must be allowed and end `verified_success`. This is the false-positive rate. |

**Overhead** is measured separately. For each operation, the harness compares
40 governed operations (plan + approve + execute + verify + receipt) against
the same operation through `runtime.router` (the bare adapter dispatch), after
3 warm-up runs. On the recorded machine the median added cost was about
0.5 ms per operation, and 1.3 ms for a terminal run (1.1–4.4 ms when the
machine was busy with other builds). The per-operation numbers are in the artifact's `overhead`
field. Latency depends on the machine; the correctness scores do not.

## Run it

```bash
pnpm benchmark:govbench                       # full corpus → docs/research/results/govbench-<version>-<date>.json
node evals/dist/govbench/harness.js --only contain.cmd.bash,utility.http.get --no-overhead --output /tmp/gb.json
```

Browser cases need Chrome, Chromium, or Edge. Without one they are reported in
`skipped` and left out of the denominators. They are never counted as passed.
Symlink cases are skipped the same way on hosts that cannot create symlinks.

CI runs a portable 15-case cross-section (`evals/src/govbench/govbench.test.ts`)
through `pnpm --filter @melra/evals test`. CI does not run the full corpus,
for three reasons: it launches Chrome per browser case, it uses POSIX programs
that Windows runners lack, and its failures are findings to fix rather than
regressions to gate on.

## Add a case

Cases live in [`evals/src/govbench/corpus.ts`](../../evals/src/govbench/corpus.ts).
Each one has an `id`, a `category`, a one-line `why`, a `request` (or
`{ raw }` for input that must fail the schema), optional `policy`, `fixtures`,
`symlinks`, and `setup`, and an `expect`. The expect is one of `refused`,
`inert`, `status`, `secret_absent`, `approval_refused`, or `exactly_once`.
Use `{{origin}}`/`{{port}}` for the fixture server and `{{outside}}` for the
directory beside the workspace. Any change to the corpus changes its hash.
Bump `CORPUS_VERSION` when cases change meaning, and publish a new artifact
rather than editing an old one.

A new case must be one where a wrong answer would be a real defect. A failing
case stays failing in the corpus until MELRA is fixed. Never change its
expectation to match the observed behaviour.

## Claim boundary

GovBench is self-authored. It measures MELRA's own stated guarantees against
cases written by the same project. It is a regression and transparency
instrument, not a third-party benchmark. Its scores are not comparable to
agent task-success benchmarks (WebArena, OSWorld, and others) or to other
products. A high score says the listed cases hold. It does not say MELRA is
secure against attacks outside them.

Known limits:

- DNS-based SSRF (rebinding, names that resolve to private addresses) is out of
  scope, because the benchmark makes no external lookups.
- Cloud-metadata hostnames such as `metadata.google.internal` are not tested
  for the same reason. Only IP literals and their encodings are.
- If a private-range case were ever wrongly allowed, the harness could emit one
  packet with a 2 s timeout toward that address. That packet would be recorded
  as a failure.
- Terminal containment checks the command and its working directory. It does
  not check what an allowlisted program does with its own arguments.
- Redaction is tested for seven secret shapes. Other formats may not be
  recognised.
- Computer-use and durable workflows are covered by `pnpm evals` and
  `evaluate:durable-core`, not here.
