# Validation

Suite-size rows — Vitest case counts and evaluation scenario counts — are
refreshed whenever those suites grow, so they report the current `main` rather
than the dated run they sit under. Every other row is the record of that run.

## MELRA Durable Core Alpha release candidate

Date: 2026-07-30

Version: `0.3.0-alpha.1`

Durable implementation and evaluation commit: `e3ec704`

Host exercised locally: macOS arm64, Node.js 24.10.0, Python 3.11.14

| Gate | Observed result |
|---|---|
| Package-version consistency | all 16 workspace manifests, protocol constant, and Python distribution match |
| TypeScript build and strict typecheck | passed across 15 packages/apps |
| JavaScript/Vitest cases | 1,136 passed, 8 platform-skipped (current `main`, ubuntu / Node 24 CI) |
| Python lint and SDK tests | ruff passed; 2 tests passed |
| Safety/execution evaluation | 55 of 55 passed |
| Durable Core evaluation | 8 valid, 0 invalid |
| Durable recovery rate | `1.0` |
| Duplicate-execution rate | `0.0` |
| False-success rate | `0.0` |
| Event-consistency rate | `1.0` |
| Real MCP stdio E2E | 16 cases passed |
| CLI package dry run | `melra-cli-0.3.0-alpha.1.tgz` produced |
| Hardened container MCP smoke | all 11 tools discovered; verified certificate produced |
| Shipped Node and Python dependency audit | no known vulnerabilities |
| Core component microbenchmark | passed; no cross-product score claimed |
| Browser harness lint and tests | ruff clean; 28 passed, 2 optional suites skipped |
| Registered browser selection | 30 tasks and 30 unique templates reproduced from pinned upstream data |
| Durable manifest digest | `b2f8e2a6819be1c18ffe799df9ce80a44301b1bc79835ea2f7c6facdf8275c38` |
| DCO branch audit | every non-bot commit signed off |

The real-process workflow test:

- discovers exactly twelve MCP tools;
- plans the committed restart-safe workflow;
- executes one verified node and records its event sequence;
- closes the MCP client and child process;
- starts a different child PID against the same SQLite and key;
- rejects a tampered approval without creating the file;
- accepts the exact scoped approval;
- independently reads the final file from `node:fs`;
- retrieves the mutation receipt and `VERIFIED_SUCCESS` certificate;
- confirms unique monotonic event sequences; and
- confirms a known secret is absent from SQLite/WAL, workflow status, workflow
  events, and child stderr.

The immutable Durable Core manifest covers planned-task restart, workflow-node
restart, post-approval restart, post-adapter/pre-receipt failure,
post-receipt/pre-projection failure, interrupted-read retry,
interrupted-mutation reconciliation, and a duplicate-advance race. Raw JSONL
is written before the summary and records the implementation commit, runtime,
platform, receipts, and certificates.

That run used `evals/manifests/durable-core-alpha-v1.json`, which stays
byte-identical with the digest above. After `0.3.0-alpha.19` the evaluation
reads `durable-core-alpha-v2.json` (digest
`3d9a072dad1945104edbfe2cea606d624d3df369250bd29052754fb284327986`): the same
eight scenarios, crash points and terminal classes, except that three restart
scenarios no longer expect a `workflow.recovered` event, which recovery stopped
recording for a run it leaves as it was (#406).

### Local candidate artifacts

The following artifacts were built from signed commit `72f7e21`. They are
local release-candidate evidence, not published release artifacts; the tag
workflow rebuilds and attests its own files.

| Artifact | SHA-256 |
|---|---|
| `melra-node-0.3.0-alpha.0.tar.gz` | `e3837a0399c54e625d547e14b480a5208521f8288fe9460b0909e3176e438c9c` |
| `melra-source-0.3.0-alpha.0.tar.gz` | `d7fd669c0eef7c9b54372e51b1d856bff912bb96f53e9f8a6f861049b48522f7` |
| `melra-0.3.0a0-py3-none-any.whl` | `621fc6048414070c2f4e39839ba902fabc6114a1204b446011c1b16a3f34e7fb` |
| `melra-0.3.0a0.tar.gz` | `6458d266a4e1bbd7bc9b888fdf252609ea30de8d34ab2cfdf1d40fac0a457bfc` |

The portable Node runtime passed `melra doctor`; both tar archives enumerated
successfully, and the wheel passed ZIP integrity validation.

Public component benchmark artifacts remain:

- LoCoMo objective evidence retrieval: 1,982 questions, coverage@20
  `0.759652`, complete evidence recall@20 `0.716448`, p50 `21.060 ms`,
  zero model/embedding/network calls;
- planted-fact memory regression: 100/100 Recall@1;
- browser stable-DOM fixture: static p50 `183.703 ms` and slow-render
  correctness 10/10;
- terminal: 30/30 verified shell-free process executions; and
- computer: 30/30 read-only capability probes.

## Browser-agent benchmark harness evidence

Date: 2026-07-29

Branch: `coder/representative-browser-benchmark`

Host exercised locally: macOS arm64 (Darwin 25.5.0), Node.js 24, Python 3.11.14

| Gate | Result |
|---|---|
| `pnpm check` | passed (versions, strict typecheck, tests, Python) |
| TypeScript/Vitest cases | 1,134 passed, 8 platform-skipped (current `main`, ubuntu / Node 24 CI) |
| `pnpm evals` | 55 of 55 scenarios passed, 0 failed |
| `pnpm e2e` | 16 end-to-end cases passed over real stdio |
| `pnpm pack:check` | passed |
| `pnpm security:audit` | no known vulnerabilities, Node and Python |
| `pnpm benchmark:browser:check` | ruff clean, 28 pytest cases passed |
| `pnpm benchmark:browser:verify-upstream` | `suite=webarena-verified-hard-30-v1 tasks=30 unique_templates=30` |
| Both benchmark extras installed | `browsergym-miniwob==0.14.3` and `webarena-verified==1.2.3` resolve; 28 pytest cases passed |

This verifies the harness, not a browser-agent score.

### Resolved dependency risk

**GHSA-vfmq-68hx-4jfw** (`lxml < 6.1.0`, high — XXE through the default
`iterparse()` and `ETCompatXMLParser()` configuration) was previously allowed
through the dependency-review gate on the grounds that it could not be patched:
`browsergym-core==0.14.3` caps `lxml` below `6.0.0`, and that browsergym version
is frozen by the pre-registered benchmark manifests.

That reasoning was wrong about the cost. A `uv` `override-dependencies` entry
resolves `lxml>=6.1.0` without changing the `browsergym-core` pin, so the
registered upstream selection that `verify-upstream` enforces is untouched. The
benchmark project now locks `lxml` 6.1.1, the advisory is patched rather than
accepted, and the `allow-ghsas` entry has been deleted — the gate carries no
exemptions.

The cap is browsergym being cautious, not a known incompatibility.
`benchmark:browser:check` passes on 6.1.1. That check does not install the
MiniWoB or WebArena extras, so if a future browsergym release genuinely breaks
on `lxml` 6 it surfaces in a benchmark run rather than in CI.

**No representative browser-agent result is published, and none is claimed.**
`docs/research/results/` deliberately contains no
`browser-agent-benchmark.json`. Two prerequisites are outstanding and are both
approval-gated by design:

- the 125-task MiniWoB development run needs an authorized model and a
  credential in the environment named by the agent configuration;
- the `WebArena-Verified Hard-30 registered subset` run needs the six official
  site containers. The registered 30 tasks span all six families
  (`gitlab` 9, `shopping` 7, `reddit` 7, `shopping_admin` 6, `wikipedia` 4,
  `map` 3), so none can be dropped without breaking the pre-registration.
  WebArena's own setup guide provisions a 1,000 GB volume per instance and
  notes the map backend alone is a ~180 GB download; this host has 107 GiB
  free, so the run needs an explicitly authorized environment.

Until both complete, the run manifest stays unfrozen and the publication gate
has nothing to accept. Any score quoted before then is unsupported.

## Reproduce

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm evals
pnpm conformance
pnpm --filter @melra/evals evaluate:durable-core -- --publishable
pnpm e2e
pnpm pack:check
pnpm security:audit
pnpm benchmark:core
pnpm benchmark:browser:check
pnpm benchmark:browser:verify-upstream
docker build -t melra:local .
docker run --rm melra:local doctor
pnpm docker:smoke
```

To exercise a published build the way an end user gets it, install it and point
the smoke at the installed binary rather than a source build:

```bash
npm install --prefix /tmp/melra-check @melra/cli@0.4.0-alpha.2
MELRA_COMMAND=/tmp/melra-check/node_modules/.bin/melra \
  MELRA_EXPECTED_VERSION=0.4.0-alpha.2 \
  pnpm registry:smoke
```

Evaluation reports are generated under `evals/results/` and are intentionally
ignored by Git because timestamps and local paths vary. Release evidence must
be attached to the immutable release or workflow run.

## Conformance level

`melra conformance` reached **L3 verified effects** — 14 of 14 checks — against
this build's own stdio server on macOS arm64, Node 24.10.0, with the probe file
written, read back through the kernel, and cleaned up. With
`MELRA_UNHINGED=1` the same endpoint reaches L1 and stops there, which is the
intended cost of the flag rather than a regression. Both results are asserted in
`apps/cli/test/cli.test.ts`, so they are re-checked on every CI platform rather
than resting on this one observation.

The published package earns the same level: `npx -y @melra/cli@alpha
conformance` in an empty directory reported level 3, 14 of 14, exit 0, no
leftover probe file — so L3 is a property of the tarball an end user installs,
not only of a source checkout.

The level definitions, the check list, and — importantly — the `notProven`
boundary are published in [CONFORMANCE.md](CONFORMANCE.md). A level says the
endpoint governs the effects it is asked for. It does not say the harness on the
other side lacks a second, ungoverned path to the same disk; that is the P2 gap
listed under known limitations below.

## Security behavior covered

- traversal and symlink escapes are rejected;
- disallowed commands and shell interpreters are rejected;
- terminal working directories remain inside the workspace;
- output and memory secret patterns are redacted;
- exact executable payloads are encrypted and identity-bound while public
  projections and evidence remain redacted;
- private and metadata network targets are rejected, including bracketed IPv6
  literals, which are checked as addresses rather than looked up as names;
- mutations without required evidence are policy-blocked;
- in developer mode, wrong or missing approval phrases are rejected;
- in developer mode, a mutation planned by one harness stays gated after that
  harness's process is gone, and a second harness on a different transport,
  vocabulary, and runtime object can only finish it by echoing the original
  phrase;
- in enforced mode, no approval phrase is issued on any MCP reply, task or
  workflow route, or workflow event; any approval the agent sends is refused,
  including the phrase a developer-mode kernel would have issued; and a
  mutation runs only on an operator's `out_of_band` decision, which the receipt
  and certificate record;
- tampered action digests and approval IDs fail before adapter execution;
- read retries are bounded and mutations are not retried;
- independently observed file mutations reconcile after interruption while
  uncertain mutations enter `recovery_required`;
- duplicate concurrent advances do not duplicate adapter effects;
- workflow event sequences are transactional, monotonic, and replay-validated;
- wall-clock budget exhaustion is distinguished from user cancellation;
- a stalled browser page fails the action within its bound instead of hanging,
  stops on the task's cancel signal, and a mutation that stalls after its input
  was sent is reported as an unknown outcome rather than `failed`;
- failed verification cannot become `verified_success`;
- memory reads and deletion remain scope-aware;
- computer input is classified high-risk and requires scoped approval.

Every item above describes the default posture. Unsafe-local mode
(`--unsafe-local` / `MELRA_UNHINGED=1`) removes rows 1–3 and 6–9 by design; what is
covered *about* that mode is separate:

- the mode is off unless explicitly enabled, and only `1`/`true`/`yes`/`on`
  enable it, so a leftover `MELRA_UNHINGED=0` cannot disarm a machine
  (`packages/server/src/runtime.test.ts`);
- limits the caller declared on its own request — `forbiddenEffects`,
  `constraints` — still deny in the mode
  (`packages/policy-core/src/index.test.ts`);
- the mode reports the true effect and risk rather than flattening a destructive
  operation to a harmless one, so receipts do not understate what was permitted
  (same file);
- a CLI invocation in the mode cannot stay silent: the stderr banner and the
  `doctor` flag are asserted (`apps/cli/test/cli.test.ts`);
- the same run without the mode still refuses a read outside the workspace and
  still denies a shell (`packages/server/src/runtime.test.ts`).

## CI evidence

The `0.3.0-alpha.1` tag build ran the full Release workflow to success:
`pnpm check`, `pnpm e2e`, `pnpm security:audit`, `pnpm evals`, the publishable
durable-core evaluation, and `pnpm pack:check` all passed before any artifact
was published, and the multi-architecture container was built and attested.
Local success is not treated as a substitute for that gate.

Historical public evidence:

Pull request [#3](https://github.com/XAGI-Lab/melra/pull/3) exercised
source commit `ede8281` through:

- [six Node jobs](https://github.com/XAGI-Lab/melra/actions/runs/30357518365)
  across Linux, macOS, and Windows on Node 22 and 24;
- [CodeQL](https://github.com/XAGI-Lab/melra/actions/runs/30357512893)
  for Actions workflows, JavaScript/TypeScript, and Python;
- [dependency review](https://github.com/XAGI-Lab/melra/actions/runs/30357513471)
  and a separate
  [dependency audit](https://github.com/XAGI-Lab/melra/actions/runs/30357513022);
- [Docker build, doctor, and actual MCP smoke](https://github.com/XAGI-Lab/melra/actions/runs/30357515676);
- [DCO validation](https://github.com/XAGI-Lab/melra/actions/runs/30357515885).

## Immutable release evidence

Release [`v0.1.0-alpha.1`](https://github.com/XAGI-Lab/melra/releases/tag/v0.1.0-alpha.1)
was built from main commit `b2ca3cd1` by
[release workflow run 30359767921](https://github.com/XAGI-Lab/melra/actions/runs/30359767921).
Both the artifact and container jobs passed.

- All five downloadable archives and distributions passed the published
  `SHA256SUMS` manifest.
- GitHub attestation verification passed for the Node runtime archive and
  Python wheel.
- The public container index
  `sha256:ec34cccf003a9555aeb4a2939f4c35e589c84661fcbae1ef1c08bdbdb206e76d`
  contains Linux AMD64 and ARM64 manifests, each with SBOM and provenance
  attestations.
- Both published architectures were pulled from GHCR without package
  credentials and exercised through an actual hardened MCP stdio session.
- Each session discovered exactly six tools, reached `verified_success`, and
  produced a `VERIFIED_SUCCESS` certificate with a 64-character SHA-256 digest.

## Remaining named-client and platform gates

The current verified client is the official MCP TypeScript and Python SDKs.
Before an alpha is called broadly installable, the built artifact must also be
exercised in the then-current versions of:

- Claude Desktop;
- Cursor;
- VS Code’s MCP support;
- at least one additional independent MCP inspector or client.

Partial progress: Claude Code, OpenCode, and Hermes Agent each completed an MCP
handshake and tool discovery against the packed `0.3.0-alpha.12` install, run by
their own CLIs, and Codex parsed the entry
([details](COMPATIBILITY.md#mcp-and-sdk-compatibility)). That covers discovery only; the
rest of the checklist has not been run in any of them.

The two HTML surfaces — the console at `/` and the OAuth consent page at
`/oauth/authorize` — are covered at the HTTP level against a live `melra serve
--http`: the console is served with its posture line, workflow list and
`EventSource` tail; the consent page names the client, its id, redirect and
registration time, carries `client_id`, `redirect_uri`, `state` and
`code_challenge` through to the POST, escapes a hostile client name
(`<img src=x onerror=…>` arrives as text, not markup), refuses framing,
refuses an approval without the operator's token (`403`, no code), and its
deny button returns `302` to the client's redirect with `error=access_denied`.
A sign-in request whose `Host` is not a loopback name gets `421`. **Neither
page has been rendered in a real browser here**, so layout, focus order and
contrast are unverified; that stays part of the manual gate above.

The released artifact itself is now covered on all three supported platforms.
Every tag runs an `installed` job on `ubuntu-latest`, `macos-latest`, and
`windows-latest` after publishing: each runner checks out nothing but
`scripts/registry-smoke.mjs`, installs the just-published `@melra/cli` from the
npm registry, runs `melra doctor`, and drives a real MCP stdio session that
discovers exactly twelve tools and takes a `{kind:"system",action:"info"}` task
to `verified_success` with a `VERIFIED_SUCCESS` certificate and a 64-character
digest. It asserts the reported version against the tag, so a cached older build
cannot pass for the new one. That is evidence about the tarball an end user
installs, which is a different claim from CI building the source tree.

On `v0.3.0-alpha.12` that job passed on all six runners (ubuntu, macOS, and
Windows, each on Node 22 and 24) against the package as published:
`version 0.3.0-alpha.12`, 11 tools, `verified_success`, `VERIFIED_SUCCESS`,
digest `4ee5db435f8ceaeb14d165134522edaccc0287eca86ddbc3aeb6e973a1683b79`
(macos-latest, Node 24; run 38618292628). Its first attempt failed on all six
for a reason outside the package: the CLI was visible on npm a moment before
`@melra/browser-runtime`, so the install could not resolve it yet; a rerun of
those jobs passed, and the step now retries the whole install (#147).

On `v0.3.0-alpha.15` it passed on all six runners on the first attempt:
`version 0.3.0-alpha.15`, 11 tools, `verified_success`, `VERIFIED_SUCCESS`,
digest `127de12c047c28b1b12d8da2185908e435dc8c35b9b7148f4715376217efbda8`
(macos-latest, Node 24; run 39604403725).

On `v0.3.0-alpha.16` it passed on all six runners: `version 0.3.0-alpha.16`, 11
tools, `verified_success`, `VERIFIED_SUCCESS`, digest
`32999f0acbaa4bd2cbbafdeea565fbccba0edfc9c255d81dc125da25ee1e9b3c`
(macos-latest, Node 24; run 39631163379, attempt 3: the first two attempts were
cancelled from outside the workflow before this job ran).

On `v0.3.0-alpha.17` it passed on all six runners on the first attempt:
`version 0.3.0-alpha.17`, 11 tools, `verified_success`, `VERIFIED_SUCCESS`,
digest `b704b12864b5a992222219c95afb239175c1ab12fdec4e129e7ab2ca0dfaf658`
(macos-latest, Node 24; run 39698282941).

On `v0.3.0-alpha.18` it passed on all six runners on the first attempt:
`version 0.3.0-alpha.18`, 12 tools, `verified_success`, `VERIFIED_SUCCESS`,
digest `3e48c60a6f4220d88147aa0eb08b0db9c0b30b888d81c9566949e28d9036640f`
(macos-latest, Node 24; run 39802175193).

On `v0.3.0-alpha.19` it passed on all six runners on the first attempt:
`version 0.3.0-alpha.19`, 12 tools, `verified_success`, `VERIFIED_SUCCESS`,
digest `a74ad216a936cceb6de7c5f44414aacaf056873a5b3dec1b9a4b07fb5a9c74fe`
(macos-latest, Node 24; run 39991858982).

On `v0.3.0-alpha.20` it passed on all six runners on the first attempt:
`version 0.3.0-alpha.20`, 12 tools, `verified_success`, `VERIFIED_SUCCESS`,
digest `1eceeb895775d8845d15f6b04e429d43e892f7403c2cecc9cc85ad547b56bed1`
(macos-latest, Node 24; run 40081322623).

On `v0.3.0-alpha.21` it passed on all six runners on the first attempt:
`version 0.3.0-alpha.21`, 12 tools, `verified_success`, `VERIFIED_SUCCESS`,
digest `a19582e906f0c00ef1c154061b076f37a3047ae899d242aef3d90f71d19f1a22`
(macos-latest, Node 24; run 40141176151).

On `v0.3.0-alpha.22` it passed on all six runners on the first attempt:
`version 0.3.0-alpha.22`, 12 tools, `verified_success`, `VERIFIED_SUCCESS`,
digest `cac43ebe148e942f5c9500fdd2d605938004e46a5d027e3247cba2201625803a`
(macos-latest, Node 24; run 40209441631).

On `v0.4.0-alpha.0` it passed on all six runners on the first attempt:
`version 0.4.0-alpha.0`, 12 tools, `verified_success`, `VERIFIED_SUCCESS`,
digest `8e13ae15473df3d4b5c620578213aa572346ff5a5b30e84954f32584a5453204`
(macos-latest, Node 24; run 40328082376).

On `v0.4.0-alpha.1` it passed on all six runners on the first attempt:
`version 0.4.0-alpha.1`, 12 tools, `verified_success`, `VERIFIED_SUCCESS`,
digest `7c7c578710ad164b8aa4831a2386a36714af7ed32f959c62df72dcfdd9672e38`
(macos-latest, Node 24; run 40413170091).

On `v0.4.0-alpha.2` it passed on all six runners on the first attempt:
`version 0.4.0-alpha.2`, 12 tools, `verified_success`, `VERIFIED_SUCCESS`,
digest `5ac5763d6a758be21dd894463ab0113ae5f350609e0ebd4234157882a1450886`
(macos-latest, Node 24; run 40716123605).

Before `1.0`, an independent security review must resolve all critical
findings.

## Known alpha limitations

- Stdio, loopback HTTP, and a mode-`0600` Unix socket (not on Windows) are the
  transports. The HTTP surface, on either listener, takes the
  operator's bearer token, or a token an OAuth 2.1 client got after the
  operator approved it in a browser with that token; treat the operator's token as equal to shell access
  on the host. An approved client is named on every receipt it produces, which
  makes an effect history attributable — it does not make one client's authority
  narrower than another's.
- One task contains one typed operation; workflows are the bounded composition
  layer.
- Only filesystem predicates can currently reconcile an interrupted mutation
  independently. Other mutations require operator reconciliation.
- Multiple server processes may share one `MELRA_HOME`; workflow advances take
  an expiring SQLite lease, so a second process is refused rather than starting
  duplicate effects.
- Browser sessions are isolated and, unless `MELRA_BROWSER_PROFILE` names a
  directory to keep, thrown away when the run ends.
- A recorded HTTP archive (`MELRA_BROWSER_HAR_PATH`) now embeds response bodies
  so it can be replayed. It holds page content, not only URLs and headers —
  handle one as the session itself.
- Browser requests are routed through a loopback proxy so a destination connects
  to the address it was validated against. Attaching to a running browser over
  CDP (`MELRA_BROWSER_CDP_ENDPOINT`) cannot use it, so that path stays open to DNS
  rebinding.
- Computer screenshot and input adapters are alpha; focus verification,
  an interactive PTY, and extension loading remain roadmap items, and semantic
  memory embeddings are deliberately left to the harness. Accessibility targeting ships on macOS and Windows. X11 exposes no
  element tree, so a named target on Linux resolves by reading the screen, which
  needs `tesseract` installed and only finds text — an unlabelled icon is
  unreachable there.
- Node's built-in SQLite API emits an experimental warning on Node 22/24. The
  `melra` executable suppresses that one warning so it does not appear on every
  command or in MCP server logs; embedding `@melra/storage-sqlite` as a library
  still surfaces it, because silencing a host's warnings is not a library's call.
- Alpha database downgrades and migrations are not guaranteed.
- Unsafe-local mode is an explicit opt-out of the safety model, not a limitation of
  it. On Windows it lifts confinement to the root of the drive MELRA runs from;
  reaching a second drive still needs a second server there.
