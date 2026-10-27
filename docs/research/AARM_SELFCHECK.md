# AARM v1.0 self-check

> Self-run mapping of MELRA against the AARM v1.0 minimum tests, using cases written by the MELRA project. Not AARM conformance, not an "AARM-compliant" claim, and not reviewed by the AARM Technical Working Group or the CSA. AARM publishes no test IDs or harness. The IDs (R1-T1..R9-T1, in page order), the case design and the pass criteria are MELRA's own reading of the spec.

The harness runs MELRA's cases for the 21 minimum tests on
[aarm.dev/conformance](https://aarm.dev/conformance) (17 MUST, 4 SHOULD)
through the real runtime, as GovBench does. It makes no model calls. Its only
network is a loopback fixture it starts itself, plus a loopback MELRA HTTP
server for the identity cases. This page reports no result: publishing a
tally is a separate decision, so the harness writes an artifact only where
`--output` points.

## Running it

```bash
pnpm benchmark:aarm                                    # builds, prints the tally, writes nothing
pnpm benchmark:aarm -- --output "$(mktemp -d)/aarm.json"
node evals/dist/aarm/harness.js --only r1t1.sudo,r4t2.task --output "$(mktemp -d)/aarm.json"
```

It is one process, needs no browser and takes a few seconds. Each case gets a
fresh temporary workspace and data directory, removed afterwards; the artifact
names it `{{sandbox}}`, never the machine's temporary path.
`evals/src/aarm/aarm.test.ts` runs the cases that pass today and run the same on
every CI platform, and checks that the effects of the partial ones still hold,
along with the decisions of theirs that hold today.

## What it counts

- A case is `pass` when every assertion holds, `fail` when anything it guards
  against happened or no assertion holds, and `partial` otherwise: in practice,
  nothing happened but the record fell short. Content from outside the
  workspace handed back by a read counts as something that happened.
- A case that needs an interface MELRA does not have yet (defer, modify, a
  read-only record verifier the harness can call, signed receipts, an audit
  export, sessions, sensitivity labels) is `not_implemented`, and so is one
  whose steps are not written yet, whatever the interface probes report. It is never run, and it
  counts as a fail.
- A test passes only when every case passes. A case skipped for the
  environment (no symlinks, no POSIX file modes) is reported and never counts
  as a pass.
- `n/a` comes only from the manifest, only for a SHOULD, with a written reason.
  R7-T1 is n/a: its drift metric needs an embedding model, and nothing on
  MELRA's decision path may call one. A deterministic proxy is reported beside
  the tally, never in it.

Most cases run in process. The tamper cases write `melra.sqlite` directly as a
full writer of the file, dropping the append-only triggers first, and then ask
the record verifier. The signature cases export receipts and check them with
`node:crypto` and the public key alone. Both wait on interfaces MELRA lacks:
since 0.4.0-alpha.2 the records are chained and `melra audit verify` checks
them read-only, but `@melra/server` does not export the `verifyRecords`
function the harness probes for yet
([#465](https://github.com/XAGI-Lab/melra/issues/465)), so the tamper cases
stay `not_implemented`.

## Sources and pre-registration

[`evals/manifests/aarm-v1.0-minimum-tests-v1.json`](../../evals/manifests/aarm-v1.0-minimum-tests-v1.json)
maps each test to its requirement, paper section, level, case ids and
assertion names. It also gives our one-line paraphrase of each test, the
deviations where the site and the paper differ (the case asserts the stricter
reading), and the sources:

- arXiv:2602.09433v1, CC BY 4.0: Errico, H. (2026), *Autonomous Action Runtime
  Management (AARM): A System Specification for Securing AI-Driven Actions at
  Runtime*.
- aarm.dev/conformance, which states no licence. The repository keeps our
  paraphrases and a SHA-256 of the page's table, never its text.

The harness pins the manifest's SHA-256 (line endings aside) and refuses to
run against any other, and its test checks the claim boundary at the top of
this page against the manifest's. Once a published result cites a manifest,
that manifest stays byte-identical. A change of meaning goes into a new `-v2`
file. Every artifact records the manifest's SHA-256 and the SHA-256 of the
canonical JSON of the cases.
