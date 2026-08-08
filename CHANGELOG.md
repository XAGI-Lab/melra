# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases use
[Semantic Versioning](https://semver.org/) after `1.0`.

## [Unreleased]

### Added

- **Screen reading as a targeting fallback, with the confidence attached.**
  Where a platform reports no accessibility tree, `computer.inspect` now takes a
  screenshot through the adapter and reads its words with `tesseract`, so
  `target: { name }` resolves on a desktop that could previously only be clicked
  by coordinate — which on X11 was every desktop. Each box is scaled from the
  captured image back onto the display, so a Retina capture does not land every
  click at double the coordinate, and a capture whose size cannot be read
  produces nothing rather than coordinates at an assumed scale. The read runs
  only when the tree came back empty: a tree states what a control *is*, a
  reading only what it looks like. `capabilities.ocr` reports whether the host
  has `tesseract` at all.

  A word read this way carries a `confidence` between 0 and 1; an element the
  platform reported carries none, so an absent `confidence` means "stated", not
  "certain". Below `0.3` a word is not reported at all, and below `0.7` it is
  reported by `inspect` but refused as a click target with
  `computer_target_confidence_too_low` — a doubtful reading is worth telling a
  caller about and not worth acting on, because the point underneath it is a
  guess at where a control nobody named actually is. Only text is found this
  way, so an unlabelled icon stays unreachable on a desktop with no tree.

- **Semantic element targeting for computer use.** `computer.inspect` now lists
  the frontmost window's addressable elements — role, name, and pixel geometry,
  capped at 200 — where the platform has an accessibility tree, and `click`,
  `move`, and `drag` accept `target: { role, name }` in place of coordinates.
  macOS reads the tree through System Events four levels deep, Windows through
  UI Automation; X11 has no equivalent, so the Linux adapter reports the new
  `capabilities.elements: false` rather than guessing. A target that matches
  nothing fails `computer_target_not_found`, and one that matches several fails
  `computer_target_ambiguous` listing the candidates — a desktop action has no
  undo, so picking the first of two "Delete" buttons is not an option. Exact
  names beat substrings, the resolved element rides back on the result so
  `result_equals` can verify what was actually hit, and policy sees
  `element:role:name` as the target rather than a pixel the caller never wrote.
- **Deterministic browser replay** through `MELRA_BROWSER_HAR_REPLAY`, an
  absolute path to an archive recorded earlier by `MELRA_BROWSER_HAR_PATH`. A
  replayed run serves every request from the file and opens no socket at all: the
  DNS-pinning proxy is skipped because there is nothing to pin, and a request the
  archive does not contain is aborted rather than fetched, so a rerun cannot
  quietly turn into a live one. The replay route is registered after the SSRF
  guard so it takes precedence over it. Replay refuses to combine with recording
  (`browser_har_replay_cannot_record`) or with a browser attached over CDP
  (`browser_cdp_cannot_replay_har`), and an unreadable archive fails at startup
  as `browser_har_replay_not_readable` instead of presenting itself as a site
  where every request fails.
- **Replayable computer-use safety evaluations.** `ReplayComputerAdapter` in
  `@melra/computer-runtime` answers from a recorded desktop — capabilities plus
  one observation per action — instead of the real one, and
  `createMelraRuntime({ computerAdapter })` accepts it programmatically. Four new
  evaluation scenarios use it to run past the approval rather than stopping at
  it: a named click reaches `verified_success` and its receipt names the element
  actually hit, the same click with evidence naming a different button is
  `partial`, and a target matching two buttons or none fails instead of clicking
  something plausible. Forty scenarios now, and computer-use safety is checkable
  on a machine with no desktop to disturb. The adapter is not reachable from
  configuration, only from code: a config file able to swap the real desktop for
  a recording could report a click nobody made.

### Changed

- **HAR recording now embeds response bodies** rather than omitting them.
  Omitting them made the recording knob evidence-only — the archive could not
  replay the session it recorded, which was the one thing a recording is for.
  The cost is file size and scope: an archive now holds page content alongside
  the URLs and headers it always held, so treat one as the session itself rather
  than as a log about it.

## [0.3.0-alpha.8] - 2026-08-08

### Added

- **Ordinary tool names over the same pipeline**, behind `MELRA_HARNESS_TOOLS=1`.
  `read_file`, `list_files`, `write_file`, `move_file`, `delete_file`,
  `run_command`, `browse`, `browser_read`, `browser_click`, `browser_type`,
  `remember`, `recall`, and `approve` sit alongside the eleven `melra_*` tools
  rather than replacing them, so a harness that already knows how to call a file
  tool does not spend a turn on plan/execute ceremony for every small read. Each
  call builds an ordinary task and hands it to the same `TaskController`: policy,
  evidence, verification, and receipts are unchanged. A mutation still stops on
  its approval phrase — the tool reports the phrase and `approve` runs the task
  that was approved, which is why the approving call does not re-plan. Off by
  default; a client showing twenty-four tools at once buys confusion rather than
  convenience.

### Fixed

- **A version bump no longer breaks the next release.** `uv.lock` records the
  local project's own version, so moving `sdk-py/pyproject.toml` left the lock
  stale and the first `uv run` rewrote it — surfacing mid-release as
  `publishable_evaluation_requires_clean_worktree`, three steps after the edit
  that caused it. `v0.3.0-alpha.7` failed there and published nothing, so the
  npm packages and the GitHub release for that tag do not exist; its container
  image does. `pnpm versions:set` now moves the locked version with everything
  else, and `pnpm versions:check` fails on the mismatch locally instead of
  leaving it for a tag push to discover.

## [0.3.0-alpha.7] - 2026-08-08

### Security

- **Browser destinations are pinned to the address they were checked against.**
  `assertSafeDestination` resolved a hostname and validated every answer, then
  Chromium resolved the same name again through its own stack — a hostile
  resolver only had to answer public once and private the second time for the
  check to describe a different host than the socket opened to. Requests now go
  through a loopback proxy (`startPinningProxy`) that connects to the address the
  check accepted. CONNECT is tunnelled, not intercepted, so TLS validation is
  untouched. Unhinged mode and an attached CDP browser keep the old path: the
  first asserts nothing about destinations, and the second is already running and
  cannot be told to start proxying.

### Fixed

- The container image builds with `pnpm build`, which now routes through
  `scripts/run-recursive.mjs`, but the Dockerfile never copied `scripts/` — so the
  `v0.3.0-alpha.6` image build failed with `Cannot find module`. npm packages and
  the GitHub release for that tag published normally; only that image is missing.
- `pnpm build` and `pnpm typecheck` no longer fan out unbounded. Only `pnpm test`
  was capped; the other two ran at pnpm's default four packages in flight, and a
  `tsc` process holds a whole program graph, so `pnpm check` could take several
  GiB before a test started. `scripts/run-tests.mjs` is now
  `scripts/run-recursive.mjs <script>` and sizes any recursive script against RAM
  and core count from one place.

## [0.3.0-alpha.6] - 2026-08-08

### Added

- **Effect Contract.** The fields the lifecycle already read one at a time now
  have a name and one schema: identity, capability, operation, effect, risk,
  target, traits, postconditions, budget, idempotency key, policy decision, and
  authorization. `melra_plan` returns the contract next to the record it was
  derived from, so what an approver reads before echoing a phrase is the same
  object the execution path loads. It is derived from the persisted task and can
  never be supplied — a second input path able to describe an effect differently
  from the one about to run would be a way around the approval, not a
  convenience.
- **Principal identity and delegation.** A request may declare
  `identity: { principal, onBehalfOf }` — the immediate caller plus the chain
  behind it, outermost first, so organization → human → harness → agent survives
  into the record. A request that declares none is the local principal,
  `agent:local`, which is what every existing caller becomes. Receipts carry the
  chain as one line, so a receipt answers who authorised an effect rather than
  only what ran. MELRA does not authenticate any of it: a link is a claim the
  layer above makes, and in developer mode it is worth what that layer's own
  boundary is worth.
- **Capability grants.** `policy.capabilities` issues bounded authority: a
  capability pattern, the effects allowed under it, a target pattern, the holder,
  and optional `validUntil` and `policyVersion`. The list is empty by default and
  changes nothing when it is. A non-empty list is a closed world — any effect
  with no matching grant is denied `capability_not_granted` before an allowlist
  is consulted, because the allowlists describe what a grant holder may do, not
  whether they hold one. An expired grant is `capability_expired` and one issued
  against a superseded policy version is `capability_policy_version_mismatch`,
  both refusals rather than reinterpretations. Unhinged mode lifts grants along
  with the rest of MELRA's judgement.
- Computer use gained two actions. `inspect` is a read that reports what the
  desktop actually looks like — frontmost application, window title, display
  geometry, and whether another process holds secure keyboard input — so a task
  can be held to an observed post-condition with `result_equals` instead of
  trusting an adapter's `success: true`. `drag` holds the button down between two
  points and is classified as a high-risk mutation, so it stops for an exact
  approval phrase like every other consequential effect. Both are implemented on
  macOS, Linux/X11, and Windows; where a platform cannot observe a field it is
  reported absent rather than guessed. macOS now refuses `type` and `key` while
  secure input is held, because synthetic keystrokes are dropped by the window
  server and would otherwise report success while typing into nothing.

### Changed

- MELRA is now described as an agent-independent **autonomy kernel** rather than
  an MCP server. The behaviour is unchanged; the framing is not. The kernel owns
  effects — typing, classification, authorisation, approval, durable record,
  idempotency, bounded execution, verification, and receipts — and never owns
  reasoning, so it ships no model client, planner, prompt library, or semantic
  memory about the user. Files, terminal, browser, and computer use are now
  described as *reference effect adapters* rather than capability layers, memory
  as *operational memory* about MELRA's own effects, and MCP as one of several
  interfaces (MCP stdio, MCP over loopback HTTP, CLI, TypeScript SDK, Python
  SDK) onto the same runtime rather than the definition of the product. README,
  ROADMAP, `docs/ARCHITECTURE.md`, `CLAUDE.md`, and the package `description`
  fields were rewritten accordingly; `docs/ARCHITECTURE.md` now also states the
  responsibility boundary, the canonical effect lifecycle, and verification
  strength with today's predicates mapped onto it.
- The responsibility boundary is now stated as **three** layers rather than two:
  the LLM reasons, the harness manages the loop, MELRA owns the effect
  lifecycle. MELRA begins where the tool call leaves the model loop, and never
  receives a goal — "fix the production server" is reasoning, and what reaches
  the kernel is a bounded operation. README and `docs/ARCHITECTURE.md` carry the
  ownership table for the three layers; `CONTRIBUTING.md` and `CLAUDE.md` carry
  the scope test that follows from it (*would this feature still make sense if
  the effect request came from ordinary deterministic software rather than an
  LLM?*).
- Verification strengths are now named rather than numbered — **execution**,
  **state**, **independent**, **semantic** — and `docs/ARCHITECTURE.md` adds the
  per-effect execution-guarantee taxonomy (`read-only`, `at-most-once`,
  `at-least-once`, `provider-idempotent`, `reconciliation-required`,
  `compensatable`) with what each covers today, plus the developer-mode versus
  enforced-mode deployment split and the bypass problem developer mode does not
  solve.

### Fixed

- `docs/ARCHITECTURE.md` no longer claims human-input and delegation nodes are
  unimplemented or that no command enters `paused`/`suspended`; all four ship.
  The workflow node table, status diagram, and event-type list now match the
  code, including `workflow.paused`, `workflow.suspended`, and
  `workflow.resumed`.

### Added

- Persistent opt-in browser profiles. Set `MELRA_BROWSER_PROFILE` to an absolute
  directory and cookies, storage, and profile state survive between runs, so a
  site logged into once stays logged in instead of being logged into again on
  every task. Absent, the previous behaviour stands: a fresh throwaway profile
  per run. Treat the directory as a credential store — it holds live session
  cookies. It cannot be combined with `MELRA_BROWSER_CDP_ENDPOINT`, which is
  refused at startup rather than silently ignored.
- Popup and multi-window policy. A window a page opened by itself used to appear
  in the context unannounced, and a caller reading the page it asked for had no
  way to know one existed. `policy.popups` now governs it: the default `"block"`
  closes the window and reports it on the action that provoked it, as
  `popups: [{ url, blocked: true }]` in the result; `"allow"` keeps it as an
  addressable tab. Reporting is unconditional — the setting decides whether the
  window survives, not whether the caller is told. A tab opened deliberately
  through `tab_new` is never mistaken for a popup, and unhinged mode allows
  them, because closing one is MELRA's judgement about what the caller should be
  looking at.
- A circuit breaker shared across related tasks. `budget.maxRetries` covers a
  blip inside one task and nothing carried further, so a workflow whose node kept
  failing against the same unreachable host spent every remaining step
  rediscovering that. After `circuitBreaker.threshold` consecutive failures
  against one target — a path, a host, a command — the next task touching it
  fails immediately with `circuit_open:<target>` instead of reaching the adapter,
  until `circuitBreaker.cooldownMs` has passed; the first task after the cooldown
  is the trial, one success clears the count, another failure re-opens at once.
  The refusal still produces a receipt and a certificate, because it is a
  governed outcome like any other. Other targets are unaffected, a `partial`
  counts as reaching the target, and a cancellation counts neither way.
  `threshold: 0` switches it off, and unhinged mode does the same. State is
  per process: a restart starts every target closed.
- Interactive terminal input. A background job's stdin was ignored, so any
  command that stopped to ask something — a scaffolder's prompt, a confirmation
  — hung until its timeout with no way to answer it. `start` now takes
  `interactive: true` to keep stdin open, and a new `send` action writes a line
  to a running job (`appendNewline` defaults to true). `send` carries no
  command, so it is authorised on the job id it targets; the allowlist check
  already happened when that job started. Sending to a job that was not started
  interactively is refused by name (`terminal_job_not_interactive`) rather than
  failing later as a broken pipe. Programs that demand a real terminal rather
  than readable stdin still do not work — that needs a native PTY.
- Package-installation and network effect classifiers. `allowedCommands`
  matches on a program's basename, so it could not tell `npm test` from `npm
  install left-pad` — allowing the command allowed both, and every `npm`
  subcommand was classified as a high-risk mutation, including `npm ls`, which
  only reads. Operations now also carry *traits* describing what they reach
  for: `package-install` (resolves and installs third-party code) and `network`
  (contacts another host). `deniedTraits` in `policy.json` refuses a request
  carrying one before the allowlist is consulted, so a policy can keep `npm`
  for its scripts and refuse it for fetching code. Traits are reported on every
  plan and by `melra policy test`, so an approver sees them before echoing an
  approval phrase back. Browser navigation carries `network` too, because it is
  true: denying `network` denies browsing as well.
- Memory retention and compaction. Expired and superseded records were already
  invisible to every read path but nothing ever deleted them, so a long-lived
  install grew forever while the searchable set stayed the same size.
  `LocalMemory` now reclaims them on the next write to that scope, governed by
  `memoryRetention.maxAgeDays` in `policy.json` (default 30). A superseded
  record is kept while a live record still supersedes it, so `supersedesId`
  never dangles. `memoryRetention.maxPerScope` additionally caps live memories
  per scope, oldest first — that one deletes data you can still read, so it
  defaults to `0`, meaning no ceiling.

### Fixed

- `melra policy test` previewed the wrong policy. It built its decision from the
  shipped defaults and ignored `MELRA_POLICY` and `~/.melra/policy.json`, which
  `melra serve` does read — so a dry run could disagree with the server it was
  previewing. It now loads the same policy the server would.
- A command's subcommand is found past argument-consuming flags. `git -c
  core.pager=cat push` read `core.pager=cat` as the subcommand and was
  classified as a local operation rather than one that contacts a remote.
- Windows checkouts no longer produce CRLF source. Git for Windows converts on
  checkout by default, and `pnpm check` failed the whole Windows job because the
  README example checker matches fenced blocks on `\n` and found none. A
  `.gitattributes` normalizes every text file to LF on all platforms, and the
  checker tolerates CRLF regardless so an older clone still gets its examples
  typechecked.
- Unhinged mode no longer fails to start on Windows. `FileRuntime.create`
  unconditionally created its own root, and unhinged mode roots it at the drive
  root, which Windows answers with `EPERM` instead of the no-op POSIX gives for
  a directory that already exists. It now only creates a root that is missing.


## [0.3.0-alpha.5] - 2026-08-08

### Added

- A local HTTP front door. `melra serve --http` opens the same runtime the stdio
  transport serves, on `127.0.0.1:7457` by default, behind a bearer token printed
  at startup (`MELRA_HTTP_TOKEN` to fix it, `MELRA_HTTP_PORT` or `--port` to move
  it). Three surfaces sit behind that token: `/mcp` for Streamable HTTP MCP
  clients, a read-only JSON API (`/api/capabilities`, `/api/tasks`,
  `/api/workflows`, `/api/workflows/:id/events?after=<sequence>`), and
  `/api/workflows/:id/stream`, an SSE tail of the append-only event log that
  replays from a cursor so a reconnecting client cannot miss an event. Writes stay
  on the governed MCP and CLI paths — the JSON API answers `405` to anything but
  `GET`, so nothing reachable over HTTP can start work policy has not seen.
- The Community console, served at `/` by `melra serve --http`: one
  self-contained page, no build step and no external requests, showing the posture
  you are running under (including the unhinged banner), every workflow run, each
  node's status, and a live event tail.
- Every published package now carries its own README, so the npm page explains
  what the package is, how to install it, and the invariants that are not obvious
  from the type signatures. `pnpm readme:check` (part of `pnpm check`) typechecks
  every TypeScript example in those READMEs against the built output, so a
  documented API cannot drift from the real one.
- Unhinged mode. `melra serve --unhinged` or `MELRA_UNHINGED=1` removes every
  guardrail: policy allows all operations, no approval challenge is issued,
  mutations no longer require declared evidence, file and terminal operations are
  rooted at the filesystem root instead of the workspace, and the browser runtime
  stops checking destinations. Limits you declare on your own request
  (`forbiddenEffects`, `constraints`), byte and duration budgets, and receipts
  stay in force. The mode cannot run invisibly — it prints a stderr banner, shows
  in `melra doctor`, and reports `unhinged: true` with
  `defaultPosture: "unhinged"` in `melra_capabilities`. See
  [unhinged mode](docs/INSTALLATION.md#unhinged-mode).
- Workflows can wait on a person. A `human_input` node blocks the run in the new
  `awaiting_input` status until an answer arrives through
  `melra_workflow_advance`'s `inputs` argument (`melra workflow advance --input
  <node-id>=<value>`), and `choices`/`maxLength` constrain what counts as an
  answer.
- A `delegation` node records a handoff to an outside worker and waits for a
  result. The delegate reporting "done" is not evidence: if the node declared
  `requiredEvidence`, the verifier still decides, and a node whose evidence fails
  is `failed`, never complete.
- Operator halts. `melra_workflow_control` — and `melra workflow
  pause|resume|suspend` — stop a run where it stands and put it back without
  losing its place. A halted workflow refuses `advance` with
  `workflow_halted:<status>`, and the halt and its reversal appear in the event
  log as `workflow.paused` / `workflow.suspended` / `workflow.resumed`.
- Cross-process workflow leases. Advancing a workflow now takes an expiring
  SQLite lease before any adapter runs, so several MELRA processes can share one
  `MELRA_HOME`: the second one is refused with `workflow_lease_held` rather than
  starting duplicate side effects. Long advances renew their own lease while the
  adapters run.

### Changed

- The CLI no longer prints Node's `node:sqlite` experimental warning. It appeared
  on every invocation — `melra help` and `melra version` included — and in MCP
  server logs, about a dependency the user did not choose and cannot change. Only
  that one warning is suppressed, and only in the `melra` executable; embedding
  `@melra/storage-sqlite` as a library still surfaces it.
- Bad input is explained rather than dumped. A schema rejection prints one line
  per problem keyed by field path instead of zod's raw issue array, a JSON syntax
  error names the file it came from, and `melra run` with empty piped stdin says
  how to supply a request instead of reporting "Unexpected end of JSON input".
- `MelraClient.plan` accepts a task request before schema defaults are applied,
  matching `planWorkflow`. Callers no longer have to restate `encoding`,
  `recursive`, `maxSteps`, and the other defaults by hand to satisfy the
  compiler; the client parses the request itself.
- MCP tool schemas now document the rules a caller cannot infer from the types.
  `constraints` says that any non-empty value is denied and what to use instead,
  `requiredEvidence` says that a non-read operation without it is denied and that
  failing evidence makes a task `partial` rather than successful, and the
  `melra_plan` and `melra_execute` descriptions state that planning never
  executes, that a denial arrives as a normal `policy_blocked` result rather than
  an error, and that an approval phrase is scoped to one task and expires.
- `MelraClient.planWorkflow` does the same for workflow definitions, taking the
  new `WorkflowDefinitionInput` type. Writing a definition in TypeScript no
  longer means spelling out `dependsOn: []`, `requiredEvidence: []`, and
  `constraints: []` on every node — the last of which is a policy deny at any
  other value. `receipt({})` now names the missing selector instead of spending a
  round trip to be told, which is what the Python SDK already did.

### Fixed

- A mistyped flag now fails immediately and names itself. `melra run --requst
  task.json` used to ignore the unknown flag, fall through to reading stdin, and
  hang forever in a pipeline; every command now rejects flags it does not know and
  lists the ones it takes.
- MCP tools reject unknown fields instead of dropping them. Every tool schema is
  `.strict()`, but the server handed the SDK a raw shape, which rebuilt a
  permissive object schema and stripped unknown keys before validation — so a
  mistyped `forbiddenEffects` or `budget` silently discarded a limit the caller
  thought it had declared, and the task planned as if it had asked for nothing.
  The tools now advertise the strict schemas themselves: the typo comes back
  named, `additionalProperties: false` appears in the published JSON Schema so a
  client can catch it without a round trip, and `melra_receipt` states its
  "taskId or receiptId" requirement in the contract rather than throwing after
  the call.
- `pnpm test` no longer exhausts system memory. pnpm's default
  workspace-concurrency multiplied by vitest's default fork pool spawned roughly
  four times as many Node processes as the machine had cores, each with its own
  V8 heap; on a 16 GiB machine that was enough to take the whole system down.
  `scripts/run-tests.mjs` now sizes both fan-outs against available RAM and core
  count. Measured peak fell from unbounded to 1.7 GiB across 15 processes, with
  the suite still green. `node scripts/peak-rss.mjs -- <command>` reports the
  peak for any command, so a regression here stays measurable.

## [0.3.0-alpha.4] - 2026-08-08

### Added

- `melra setup` does the whole local setup in one command: writes a safe
  starter policy, prints an MCP client configuration, and runs every readiness
  check, exiting non-zero if one fails. `npx @melra/cli@alpha setup` takes a
  machine with nothing installed to a pasteable client configuration in a single
  step. `doctor` and `init` remain available for the individual halves.

### Fixed

- A generated client configuration always names a command the client can
  actually spawn. `init` previously always emitted `"command": "melra"`, which
  does not exist on `PATH` after an `npx` install — the shortest install path
  produced a configuration that could not start the server. When the CLI is
  running from the npx cache, the configuration now launches through `npx` at
  the exact version that wrote it.

## [0.3.0-alpha.3] - 2026-08-07

### Added

- First release published to the npm registry. `@melra/cli` and the thirteen
  library packages install from npm, so trying MELRA no longer requires Docker,
  a tarball download, or a source build.
- npm is documented as the primary install path in the README and
  `docs/INSTALLATION.md`, including an `npx`-based MCP client configuration that
  needs no prior install step. Because this is the first version on the registry,
  npm points `latest` at it as well as `alpha`; plain `npm install @melra/cli`
  resolves to the alpha until a stable release exists.

### Fixed

- `0.3.0-alpha.2` shipped a GitHub release with no matching npm packages: the
  `@melra` scope did not exist, and `PUT` returned `404 Scope not found` after
  the release had already been created. The scope now exists, and the publish
  ordering fix below means a failure can no longer leave that mismatch behind.
  `0.3.0-alpha.2` remains available as a container and a release tarball; it was
  never on npm and is not published retroactively, because its artifacts are
  already public under checksums that a rebuild would change.

## [0.3.0-alpha.2] - 2026-08-07

### Added

- The release workflow publishes every public workspace package to the npm
  registry, so installing MELRA no longer requires Docker, a tarball download,
  or a source build. Prereleases go to a dist-tag matching the channel in the
  tag name (`alpha`, `beta`), which keeps `npm install @melra/cli` from
  resolving to a prerelease once a stable line exists. Publishing uses
  `pnpm -r publish` rather than publishing the deploy output, because the CLI
  depends on six workspace siblings whose `workspace:*` specifiers only resolve
  when the whole workspace is published together.
- Published packages carry npm provenance attestation, generated from the
  workflow's OIDC identity, so the registry records which repository, commit,
  and workflow produced each tarball.
- Every published manifest carries `repository`, `homepage`, and `bugs`, so the
  registry links each package back to its source directory. npm refuses to
  generate a provenance attestation for a package without `repository`, so this
  is a requirement of the step above rather than cosmetic metadata.

### Changed

- Version references across `README.md`, `docs/CAPABILITIES.md`,
  `docs/COMPATIBILITY.md`, `docs/INSTALLATION.md`, and `docs/THREAT_MODEL.md`
  track the current release.

### Fixed

- The release job publishes to npm before it creates the GitHub release, and
  creating a release is idempotent on re-run. The first `0.3.0-alpha.2` attempt
  created a GitHub release and then failed to publish, leaving a release with no
  matching packages: a dry-run publish never issues a PUT, so it cannot detect a
  missing scope or a token without rights to one. Publishing first makes the
  publish its own check — a failure now leaves nothing user-visible behind.
- The npm publish step appends its registry token to `.npmrc` instead of
  overwriting the file, which had dropped the repository's `save-exact` and
  `strict-peer-dependencies` settings for the rest of the job.

## [0.3.0-alpha.1] - 2026-08-06

### Added

- Browser targets resolve across every frame of the page, main document first.
  Every locator was built from the `Page`, which searches only the main
  document, so a consent banner, cookie wall, payment field, or login form
  inside an iframe — where such things almost always live — was unaddressable:
  an agent could see the button in a screenshot and every attempt to click it
  died as an opaque thirty-second action timeout. The fan-out happens in the one
  place all targeting routes through, so `click`, `type`, `fill_form`, `select`,
  `press`, `upload`, `download`, `extract`, and `wait` are fixed together, with
  no new field for a caller to pass. At most 20 frames are searched, since ad
  and analytics stacks attach dozens.
- `inspect` reports elements from every frame and names the owning frame URL
  (`null` for the main document), so a caller can tell why an element it can act
  on is missing from the page text. Each frame contributes at most 250 elements
  and the merged list is capped at 400, so a long main document cannot consume
  the budget and leave the consent iframe unlisted.
- `inspect` reports `captcha.present` and the vendor when a human-verification
  widget (reCAPTCHA, hCaptcha, Turnstile, Arkose) is embedded in the page.
  MELRA does not solve or bypass captchas and this does not attempt to; the
  report exists so a blocked run says it is blocked and why, instead of burning
  its budget retrying an element that will never become clickable. Vendor
  matching is anchored on the frame origin, so a lookalike host does not match.
- `wait` on a target re-resolves it across the frame list on every poll rather
  than binding to one frame up front, which Playwright's own `waitFor` does —
  wrong for the common case, since the consent iframe or captcha widget being
  waited for usually does not exist yet when the wait starts. `visible` and
  `attached` are satisfied by any one frame; `hidden` and `detached` must hold
  in all of them, since most frames never contain the target and "some candidate
  is absent" would otherwise report a banner as dismissed while it is on screen.
- Windows computer use, through Windows PowerShell and .NET. There was no
  `win32` branch in the adapter factory at all, so `capabilities` reported
  `adapter: "unavailable"` on Windows and every input action threw a bare
  `computer_use_unavailable` — the whole capability was missing rather than
  degraded, and CI stayed green on `windows-latest` because nothing exercised
  Windows behaviour. Screenshots use `Graphics.CopyFromScreen` over the virtual
  desktop; pointer and wheel input reach `SetCursorPos` and `mouse_event`
  through P/Invoke, which .NET does not otherwise expose; keyboard input uses
  `SendKeys`. Both dependencies ship with the OS, so nothing extra is installed.
  PowerShell remains unconditionally denied for caller-supplied terminal
  commands: this is the trusted adapter running a fixed script it owns, the
  same arrangement under which the macOS adapter uses `osascript`. Coordinates,
  wheel deltas, and text reach that script through the environment and are
  never interpolated into its source.
- `SendKeys` reads `+^%~(){}[]` as modifiers and grouping rather than as
  literal characters, so typed text containing them is escaped first — a
  password with a `+` would otherwise have sent a Shift chord, and a `~` an
  Enter keypress. The escaping is a pure exported function with tests that run
  on every platform, since getting it wrong corrupts typed text silently rather
  than failing. Windows capability, screenshot, and pointer tests run for real
  on `windows-latest`.
- Browser history navigation: `back`, `forward`, and `reload`. A session could
  previously only move forward, so a wrong click was unrecoverable without
  re-navigating from scratch. `back`/`forward` report `moved`, which is false
  only at the end of the history stack — Playwright returns `null` both when
  there is nowhere to go *and* when the entry it landed on produced no HTTP
  response (`about:blank`, a hash change, a `data:` URL), so the URL is compared
  to tell those apart rather than reporting a move that happened as a move that
  did not.
- Browser tab control: `tab_new` and `tab_switch`. `tabs` reported which page
  was `active` while nothing could change it, and the `tabIndex` schema field
  existed but was read only by `close` — so a link that opened a new tab
  stranded the session. `tab_new` accepts an optional `url` and runs the same
  `assertSafeUrl` destination check `navigate` does, so it is not a route around
  the domain allowlist. Every tab action now returns the renumbered tab list,
  since opening, switching, and closing all shift the indices and a caller would
  otherwise be acting on a stale one.
- History and tab actions classify as `read` rather than `mutate`: they move
  where the session is looking, they do not act on a document. Stepping back or
  switching tabs therefore costs no typed approval. Actions that drive the page
  are unchanged, and an eval scenario pins both halves — that `back` and
  `tab_switch` are reads, and that `click` still reaches approval.
- Browser `wait`, a real wait primitive with one of three conditions: a `target`
  reaching a `state` (`visible`, `hidden`, `attached`, `detached`), a
  `urlContains` substring, or a `value` substring of the page text. Without it
  the only way to handle a slow login redirect or a late-rendering modal was to
  retry the next action and hope, which is why `settleTimeoutMs` kept being
  raised as a substitute. It classifies as `read` — blocking until the page
  reaches a state is not acting on it — so waiting costs no approval.
- Browser `fill_form`, which fills a list of `fields` and, when the operation
  carries a `target`, clicks it to submit. Each field was previously its own
  mutation, so a six-field checkout form cost six typed approval phrases and six
  DOM settles; the approval now covers the whole form, because the whole form is
  what the caller planned. An eval pins that batching cuts the count, not the
  gate: `fill_form` still reaches approval.

### Fixed

- A failing computer helper reports what went wrong instead of echoing the
  script. Node builds a failed-process rejection from the whole command line,
  which for an adapter means the entire script: a Windows screenshot failure
  arrived as fifteen lines of quoted PowerShell with an empty stderr, and a
  timeout arrived as the same fifteen lines, indistinguishable from a script
  that failed instantly. The interpreter's own first line of stderr is reported
  now, and a killed helper is named as
  `computer_helper_timeout:<program>:<budget>` — a caller can act on a
  permission error or a budget, but not on a copy of the script it did not
  write. This is in the shared runner, so the macOS and Linux adapters gain it
  too.
- The computer `timeoutMs` ceiling was 30s while every other operation kind
  allowed 120s. A computer action spawns a whole interpreter — `powershell.exe`
  plus the .NET assemblies it loads, `osascript`, `xdotool` — and the first such
  spawn after boot exceeded 30s on a cold Windows machine, so the maximum itself
  was unreachable there and no legal value could complete the action. The
  default stays 10s, since a warm call is fast; a caller who knows it is cold
  can now ask for more rather than being refused by the schema.
- Browser dialogs are answered and reported instead of silently discarded.
  Playwright dismisses every dialog when no handler is registered, and none
  was, so a button guarded by `confirm()` reported a successful click while the
  guarded work never ran: the click really did succeed, so no evidence
  predicate could catch it, and the caller was told a record was deleted that
  still existed. `beforeunload` was the same defect pointed at navigation and
  `prompt()` the same pointed at input. Dialogs are now accepted — the caller
  already approved the action that raised the confirmation, which is part of
  that action rather than a second one — and every dialog comes back on the
  result as `dialogs[]` with its type and message, so a page is never changed
  without the caller also being told what it was asked. `prompt` accepts the
  page's own default rather than inventing a value. The handler is registered
  on the browser context, so tabs opened later are covered too, and the field
  is absent rather than empty when nothing was raised.

- Browser typing dispatches real key events again. `type` used Playwright's
  `.fill()`, which assigns the value and fires a single `input` event, so
  anything listening for keystrokes never saw the text — React inputs with key
  handlers, autocomplete dropdowns, comboboxes that filter as you type, and
  fields that enable their submit button on `keyup`. It now presses the keys, as
  the previous server did, with `delayMs` for widgets that debounce and
  `clearFirst` (default true) controlling whether the field is emptied first.
- Every browser mutation planned without explicit `requiredEvidence` verified as
  `partial`, however well it went. Policy derives `result_equals success true`
  for browser mutations, but `BrowserRuntime` reported per-action flags
  (`clicked`, `typed`, ...) and never a `success` field, so the derived
  predicate read a key nobody wrote and failed silently. Results now carry
  `success`, and a policy test pins the predicate to the field the runtime
  actually emits.
- `scroll` distance is configurable via `pixels` instead of a hardcoded ±600,
  which was too small for a long article and too large for a short scroll
  container, and it returns the resulting `scrollY` so a caller paging through a
  document can tell when it has reached the bottom.

### Changed

- Terminal commands run on Windows. Three defects compounded into a deadlock
  where **no spelling of an allowlisted command worked**: the policy allowlist
  compared a raw basename against extension-less entries, so `npm.cmd` was
  denied; `spawn` runs without a shell and does not apply `PATHEXT`, so bare
  `npm` never resolved; and a `.cmd` shim cannot be executed by `CreateProcess`
  at all. Policy now normalises executable suffixes on both the allowlist *and*
  the unconditional deny list, so `powershell.exe` is still refused, and a
  Windows command is resolved across `PATH` x `PATHEXT` before spawning, with
  batch shims dispatched through `cmd.exe /d /s /c` under explicit per-argument
  quoting. Arguments containing `%` or `!` are refused rather than quoted
  unsafely, because `cmd.exe` expands those inside quotes and the allowlist
  would otherwise be bypassable through an argument. The working directory is
  deliberately not searched for a bare command, so a `git.cmd` dropped in the
  workspace cannot shadow the allowlisted `git`.
- `terminal start` no longer reports success for a process that failed to
  start. `spawn` signals a failed start asynchronously, so the call returned
  `started: true` with a job id for a process that never existed; it now waits
  for whichever of `spawn`/`error` settles first.
- A missing or non-executable program is reported as
  `terminal_command_not_found:<command>` / `terminal_command_not_executable:<command>`
  instead of a bare `ENOENT` naming only the syscall.
- Default `allowedCommands` includes the Windows read tools (`findstr`,
  `where`, `tasklist`) alongside the POSIX ones, and they classify as `read`
  so they do not require approval. The list stays platform-independent: an
  entry naming a program the host lacks is inert, failing at spawn rather than
  at policy.

- Browsing works on a fresh install. `createDefaultPolicy` previously shipped
  `allowedDomains: []` and `allowLocalhost: false`, and `melra init` wrote that
  file to disk, so **every** browser navigation failed with
  `browser_domain_not_allowed` until the operator hand-edited `policy.json`. The
  defaults are now `["*"]` and `true`. This does not widen the security boundary:
  `assertSafeUrl` independently rejects non-HTTP(S) schemes, URL credentials,
  private ranges, and cloud metadata (169.254/16), and resolves DNS before
  allowing a navigation so a public name cannot be rebound to a private address.
  The domain list is a narrowing control layered on that guard, not the guard
  itself. Operators who want an allowlist still set one explicitly.
- A mutation that declares no `requiredEvidence` now has the obvious
  post-condition derived from the operation instead of being denied outright — a
  `file write` gets `file_exists`, a `delete` gets `file_absent`, a `move` gets
  both, and a `memory put`/`delete` is held to the flag the adapter actually
  reports. The mutation-requires-evidence guarantee is unchanged: the task is
  verified against the derived predicate exactly as if the caller had written it,
  and an operation with no honest post-condition derivable from the request
  alone (a `terminal run`, a `memory clear`, which reports a count rather than a
  flag) is still blocked. Previously such callers hit a flat deny, had to guess
  the right predicate, and mostly gave up.

- Close the browser see/act loop. `browser inspect` reported each element as
  `{tag, role, name, type}` with nothing that could address it, and the old
  server's HTML extraction was gone, so a caller could read a page but not
  construct a target for it — the only route left was exact text matching. Each
  element now carries a `selector` anchored on the nearest `id`/`data-testid`
  ancestor (falling back to an `:nth-child` path), plus `index`, `id`, `testId`,
  `attributeName`, `placeholder`, `href`, `value`, `disabled`, and `checked`.
- Match `target.text` on substrings when an exact match finds nothing. Exact is
  still tried first, so precise callers keep precise behaviour, but a button
  rendered as `<button> Sign in </button>` no longer fails to match `Sign in`.
- Report a target that matches nothing as `browser_target_not_found:<target>` at
  resolution time instead of letting Playwright surface it as an opaque action
  timeout once `timeoutMs` expires.
- Scope `browser inspect` to a `target` when one is given, returning that
  element's `text` and `html` rather than the whole page. This restores the old
  server's `extract_text`/`extract_html` without adding an action.
- Upgrade `zod` from 3.25.76 to 4.4.3 in `@melra/protocol` and `@melra/server`.
  The only breaking API in use was the single-argument `z.record(value)` form,
  which zod 4 replaces with the explicit `z.record(key, value)` signature; three
  call sites in `packages/protocol/src/index.ts` were updated. Schema semantics
  are unchanged — every operation schema stays `.strict()` with the same bounds
  and defaults, and all 22 policy/execution eval scenarios still pass with
  identical plan and final states.

### Security

- Pin transitive `hono` to `^4.12.34` and `fast-uri` to `^3.1.5` through pnpm
  overrides, clearing the CORS ReDoS (moderate) and host-confusion (high)
  advisories that `pnpm audit --prod` reported through
  `@modelcontextprotocol/sdk`. The SDK's own ranges already allow the patched
  releases; only the lockfile was pinning the vulnerable ones.
- Force `lxml>=6.1.0` in the browser benchmark harness through a `uv`
  dependency override, clearing the XXE advisory (GHSA-vfmq-68hx-4jfw /
  CVE-2026-41066, high) in which `iterparse()` and `ETCompatXMLParser()` resolve
  local file entities by default. `browsergym-core` pins `lxml<6.0.0` and the fix
  only landed in 6.1.0, so the bound is overridden rather than left vulnerable;
  it reads as upstream caution rather than a known incompatibility, and
  `pnpm benchmark:browser:check` passes on 6.1.1.

## [0.3.0-alpha.0] - 2026-07-30

### Added

- Durable workflow definitions with operation, approval, condition, parallel,
  bounded-loop, checkpoint, and compensation nodes.
- Transactional ordered workflow events, projections, snapshots, encrypted
  executable payloads, and idempotency commits in SQLite migration version 1.
- Four workflow MCP tools plus CLI, TypeScript SDK, and Python SDK workflow
  interfaces.
- Restart-safe workflow example and real MCP child-process recovery test.
- Immutable eight-scenario Durable Core evaluation manifest, raw JSONL runs,
  and summary metrics.
- Optional speaker, episode ID, and sequence metadata for memory records.
- Bounded adjacent-turn context expansion and query-aware speaker matching in
  the deterministic local memory ranker.
- Browser-agent evaluation harness (`benchmarks/browser-agent`) with a 125-task
  MiniWoB development suite, a pre-registered
  `WebArena-Verified Hard-30 registered subset`, deterministic subset selection,
  paired aggregate statistics, and a fail-closed publication gate.
- Opt-in browser instrumentation for benchmark and diagnostic harnesses:
  `MELRA_BROWSER_CDP_ENDPOINT`, `MELRA_BROWSER_CDP_CONTEXT_INDEX`, and
  `MELRA_BROWSER_HAR_PATH`. Unset by default, so the isolated
  launch-our-own-browser behavior is unchanged.

### Changed

- Product version advanced to `0.3.0-alpha.0`; the MCP surface now contains
  ten tools.
- Planned task and workflow payloads remain executable after a process restart.
- Interrupted reads retry conservatively; independently verifiable file
  mutations reconcile, while uncertain mutations enter `recovery_required`.
- LoCoMo mean evidence coverage@20 improved from `0.629117` to `0.759652`
  on the same hashed 1,982-question run, with no model, embedding, or network
  calls.
- `run-miniwob` now reports `infrastructure_failures` and a `valid` flag, so a
  run whose tasks the harness could not attempt is not mistaken for a clean
  result.

### Fixed

- Concurrent advances for one workflow are serialized before adapter
  execution, preventing duplicate effects and receipts in one server process.
- Verified tasks committed before a workflow projection are recovered without
  rerunning their adapters.
- Browser benchmark runs drive Playwright from one process-wide thread.
  BrowserGym binds a process-global sync Playwright to its creating thread, so
  the previous per-task thread made every task after the first fail with
  `greenlet.error`.
- The benchmark agent retries rate-limited and transient-transport provider
  responses with bounded, capped backoff, honoring `Retry-After` when sent, and
  can pace requests to a fixed per-minute budget.
- A task whose environment, driver, or agent fails is recorded as a failure
  rather than aborting the suite, keeping the denominator fixed.
- A model action the harness cannot derive evidence for is recorded as
  `invalid_action` instead of raising.
- Benchmark browser actions now time out after 10s against a 30s task budget.
  Both previously defaulted to 30s, so an unresolvable target and the budget
  abort expired together and every such action was reported as
  `budget_exhausted` rather than its actual error.

### Security

- Exact task requests, workflow definitions, and persisted adapter results use
  AES-256-GCM envelopes bound to record identity and purpose.
- Payload keys are loaded from `MELRA_PAYLOAD_KEY` or created as a non-symlink
  mode-`0600` file; permissive Unix key files fail closed.
- Status, events, receipts, certificates, logs, and SQLite projections are
  covered by plaintext-secret regression tests.
- Speaker and episode metadata pass through secret redaction before
  persistence.
- Attaching over CDP and recording a HAR are mutually exclusive, and a HAR path
  must be absolute. Raw HAR, screenshots, video, and provider transcripts are
  Git-ignored and rejected by the benchmark publication gate.

## [0.2.0-alpha.1] - 2026-07-28

### Added

- Governed computer-use capability contract with macOS and Linux/X11 adapters.
- Read-only computer capability discovery and typed screenshot, pointer,
  keyboard, and scroll operations through the common task pipeline.
- Deterministic local memory ranking with lexical relevance, exact phrases,
  confidence, freshness, bounded diversity, expiry, and supersession.
- Public LoCoMo evidence-retrieval and cross-capability microbenchmark
  harnesses with committed raw JSON results.
- Dedicated memory, browser, terminal, computer-use, and methodology reports.

### Changed

- Browser actions now wait for a bounded mutation-free DOM window and return
  settle evidence before the final observation.
- README, architecture, capabilities, threat model, validation, and roadmap now
  describe the five execution layers and explicit benchmark claim boundaries.
- Deterministic evaluation coverage increased from 21 to 22 scenarios.

### Security

- Computer input is schema-bounded, platform-adapted, classified high-risk, and
  requires declared evidence plus exact task-scoped approval.
- Expired and superseded memory records are excluded by default.

## [0.1.0-alpha.1] - 2026-07-28

### Fixed

- Publish the GitHub Container Registry image for both Linux AMD64 and ARM64.
- Allow the hardened container smoke test to select an explicit platform when
  validating a single-platform image.

## [0.1.0-alpha.0] - 2026-07-28

### Added

- Compact six-tool MCP stdio server.
- Task lifecycle with policy, scoped approvals, budgets, cancellation,
  verification, receipts, and execution certificates. Task records are
  persisted; executable task payloads do not survive a restart.
- Root-confined file runtime.
- Shell-free foreground and background terminal runtime.
- Isolated Playwright browser runtime with network safety checks.
- Scoped, redacted local SQLite memory.
- TypeScript and Python client SDKs.
- CLI, Docker image, 21-scenario evaluation harness, client interoperability
  tests, security automation, and release provenance workflow.

### Security

- Deny-by-default browser domain allowlist.
- Private-address and cloud-metadata browser blocking.
- Central redaction of persisted task input, output, receipts, and URL queries.
- Cross-scope memory overwrite and deletion protection.
- Patched transitive HTTP adapter enforced through a package override.

[Unreleased]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.6...HEAD
[0.3.0-alpha.6]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.5...v0.3.0-alpha.6
[0.3.0-alpha.5]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.4...v0.3.0-alpha.5
[0.3.0-alpha.4]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.3...v0.3.0-alpha.4
[0.3.0-alpha.3]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.2...v0.3.0-alpha.3
[0.3.0-alpha.2]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.1...v0.3.0-alpha.2
[0.3.0-alpha.1]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.0...v0.3.0-alpha.1
[0.3.0-alpha.0]: https://github.com/XAGI-Lab/melra/compare/v0.2.0-alpha.1...v0.3.0-alpha.0
[0.2.0-alpha.1]: https://github.com/XAGI-Lab/melra/compare/v0.1.0-alpha.1...v0.2.0-alpha.1
[0.1.0-alpha.1]: https://github.com/XAGI-Lab/melra/compare/v0.1.0-alpha.0...v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/XAGI-Lab/melra/releases/tag/v0.1.0-alpha.0
