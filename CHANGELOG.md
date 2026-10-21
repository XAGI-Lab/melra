# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases use
[Semantic Versioning](https://semver.org/) after `1.0`.

## [Unreleased]

### Security

- **Breaking:** a capability grant's `maxOperations` and `provider.dailyMax`
  are drawn down whenever the adapter may have done the work, whatever the
  evidence then says, so grants run out sooner. A task that ends `partial`,
  one whose adapter ran and reported failure, and a change left
  `recovery_required` by an outcome-unknown error or an interruption are each
  charged once, as a verified task or one waiting on a `semantic` question
  already was, and a metered read is charged the same way. `verified_success`
  stays the evidence verdict only, and a grant's limits now bound every effect
  attempted under it, not only the ones that verified. A charge stands if
  reconciliation later finds the effect did not happen. A policy refusal, a
  cancel before the adapter ran, an adapter error saying nothing went out, and
  a duplicate stopped before it ran still cost nothing. Upgrading: a grant
  sized for verified effects alone may need a larger `maxOperations` or
  `dailyMax`.

## [0.3.0-alpha.15] - 2026-10-21

### Added

- A `semantic` evidence predicate (#54): a yes/no `question` about meaning,
  with `artifacts` naming result paths, for a judge outside MELRA. The kernel
  runs no model and never answers it; its item has strength `semantic` and
  fails as inconclusive. Once the effect has run and every other predicate has
  held, the task waits in `waiting_user`, its `judgements` saying what it waits
  on and until when (`approvalTtlMs`). Nothing can answer a judgement in this
  release, so at expiry the task settles closed: `recovery_required` for a
  change, whose effect did happen, `partial` for a read, error
  `semantic_judgement_expired`, settled by the startup pass and the 30 s
  recovery sweep, or as soon as one cut off after its effect is recovered:
  one that committed its idempotency key, or a change whose other evidence is
  all `file_*` and still holds. A destructive effect whose evidence has a `semantic`
  predicate but nothing at the state or independent level is refused at
  planning outside unsafe-local mode (`semantic_only_destructive`). `semantic`
  is refused beside `reconciliation` (`semantic_evidence_not_reconcilable`),
  which cannot settle a question about meaning, and in any workflow node
  (`workflow_semantic_evidence_unsupported:<node>`) until a workflow can wait on a
  verdict. `pnpm evals` has two new scenarios (54).

- `ComputerRuntimeOptions.ocrProgram` names the OCR program for a library
  embedder whose `tesseract` is outside its usual install paths; naming it
  makes reading the screen available wherever screenshots are. The server and
  CLI do not set it. (#251)

- Each GitHub release attaches the single executable (Node inside, no Node
  install needed) for linux-x64, linux-arm64, darwin-arm64 and win-x64, built
  and smoke-tested by the same workflow every pull request runs, and covered by
  the release's `SHA256SUMS` and provenance attestation. The binaries are not
  code-signed: macOS quarantines a downloaded copy and Windows SmartScreen
  warns, and `docs/INSTALLATION.md` shows how to verify one first. (#76)

- A release dry run (`.github/workflows/release-dry-run.yml`): on demand, and
  on any pull request that touches the release files, it builds the binaries
  and every release file through the same steps a `v*` tag runs (now one
  shared `release-artifacts` action), checks the versions, `npm publish
  --dry-run`s every package and checks the GitHub release's asset list (each
  name once) and checksums, with read-only permissions throughout. (#204)

- `melra console` approves in a browser, with the same authority as
  `melra approve`. Run in a terminal, it starts a loopback server of its own,
  with no MCP endpoint and no client registration, that ignores
  `MELRA_HTTP_TOKEN`, and opens a page; the first page to use the one-time
  code in its URL fragment, normally that one, pairs with it once. The code is
  never printed, and the session it buys is held in memory only, by the
  console and that page, so
  reloading or leaving the page ends the pairing, as does any change to its
  URL the page did not make: it picks the task from the operator's clicks,
  never from the URL. The page hands the session back as it goes, and the
  console refuses it from then on. Approve and Deny act only once the page
  has been visible, focused and unscrolled for a second, and show as not yet
  active until then; in a browser MELRA's runtime is attached to, Playwright's
  focus emulation hides raises from the page, so there the hold restarts
  only on scroll and resize. The page shows the screen `melra approve` shows,
  with MELRA's summary right above Approve, a decision bound to the task and the
  digest it drew, and Deny, which cancels the task; the full contract sits
  folded above the summary, and hidden characters in anything the agent sent,
  and combining marks stacked past two on one character, are spelled out as
  `\uXXXX`. The terminal approval screen (`melra approve`, `melra run`) now
  spells out such marks the same way, and wherever the CLI spells out hidden
  characters it now spells out unassigned code points too, which a terminal
  may draw as nothing. Receipts name the approver as `console:` plus
  `MELRA_APPROVER`. Run it with the `MELRA_HOME`, `MELRA_WORKSPACE` and mode
  the agent's server uses.
  It refuses to start without a terminal (`console_needs_a_terminal`) or a
  browser opener (`console_needs_a_browser`). The server an agent connects to
  still has no approval route. `@melra/server` exports `approvalScreen`,
  `approvalSummary` and `printable`, and `serveHttp` takes `approver`,
  `onPaired` and `onApproved`, refused on a socket or off loopback
  (`approval_console_loopback_only`) on every platform and in every mode.

### Changed

- A grant is now drawn down, and an idempotency key committed, when a task's
  every kernel check has held: when it is verified, as before, and also when
  it enters `waiting_user` on a `semantic` question, since its effect ran. A
  key that ran does not run again, and a grant does not fund a second effect
  while the first waits. (#54)

- **Breaking:** `semantic` is now a built-in verifier type, so
  `createMelraRuntime` refuses an `evidenceVerifiers` entry of that type
  (`verifier_type_taken:semantic`) and the runtime does not start. Rename such
  a verifier, and the `custom` predicates that name it. (#54)

- **Breaking:** `SqliteStore.getWorkflowDefinition` in `@melra/storage-sqlite`
  returns a `RedactedWorkflowDefinition`: the redacted copy kept for reading,
  of which only `id` and `version` are checked, since redaction may have
  rewritten a node id or a URL in it. The definition a run uses is the sealed
  payload. `createWorkflow` takes that redacted copy as `unknown`. (#278)

- The eleven MCP tools describe themselves fully: each says what it does,
  when to use it instead of its siblings, what it returns and how its
  parameters relate, and every top-level parameter now carries a description
  (most had none). The server's instructions add that no tool lists all tasks
  or runs, so an agent keeps the ids it is given, and that
  `melra_workflow_control` halts a run while `melra_workflow_cancel` ends it.

- **Breaking:** in enforced mode, a browser action that drives a page
  (`click`, `type`, `fill_form`, `select`, `press`, `upload`, `download`,
  `close`, `tab_switch`) must name it with `url`, or it is refused at planning
  with `browser_action_requires_url`, ahead of any grant check. The operator
  approving it always sees which page it lands on, and a grant always has a
  page to match. A harness in enforced mode sends the page's url, from `tabs`
  or the last `inspect`, with each of these actions; the harness tools
  `browser_click` and `browser_type` take a `url` for it. Developer mode does
  not require one. In every mode, the url
  of `close` and `tab_switch` names the tab, which can be `about:blank` or off
  the allowlist, since neither loads anything. (#196)

- Node.js 22.13 is the stated and declared minimum, the first 22.x where
  `node:sqlite` needs no flag (23.4 on the 23 line). `@melra/cli`,
  `@melra/server`, `@melra/storage-sqlite`, and `@melra/memory` and
  `@melra/runtime-core`, which work only with a SQLite store, declare it in
  `engines`, so npm and pnpm warn, and Yarn 1 refuses, on an older Node; their
  docs say 22.13 where they said 22. (#218)

- The hardened deployment recipes name Docker Desktop and WSL2 as the way to
  get OS isolation on Windows, and `melra doctor`'s `isolation` line on native
  Windows says so instead of mentioning a Job Object. A Job Object limits
  processes and memory but not file access, so no native Windows recipe is
  offered. (#52)

- **Breaking:** only `melra serve --socket <path>` moves `serve` off stdio.
  `MELRA_SOCKET` no longer does: exported in a shell profile, it moved every
  stdio MCP client launched from that shell onto a socket it never connects
  to, and the client hung waiting for a reply. It still names the socket
  `melra doctor` checks and `melra status` probes. A service that relied on it
  passes `--socket "$MELRA_SOCKET"` instead. The stderr warning `serve` printed
  in that case is gone with it. (#105)

- **Breaking:** `melra setup` and `melra init` show the workspace they give
  the agent, as a `Workspace` row and as `workspace` in the JSON, and no
  longer make it the home directory, a directory holding it (`/Users`,
  `/home`, `C:\Users`) or a filesystem root (`/`, or a drive root on
  Windows) unasked. The workspace is the current directory unless
  `MELRA_WORKSPACE` is set or a `MELRA_POLICY` file's `workspaceRoot` pins
  it, so the README's `npx @melra/cli@alpha setup` run in a fresh terminal
  gave the agent the whole home directory, with nothing printed to say so.
  In a terminal they now say so and ask, defaulting to no; elsewhere (piped,
  captured, `--json`) they refuse with `workspace_too_broad` and write
  nothing. Either way they say to set `MELRA_WORKSPACE` to the project
  directory or run from there; when a `MELRA_POLICY` file set the workspace,
  to make the project that file's `workspaceRoot` instead of running from
  it. A script that means it sets `MELRA_WORKSPACE`, which is never
  questioned. Directories
  are compared by identity, so a symlinked home and macOS's
  `/System/Volumes/Data/...` spelling of it count.

- Each GitHub release's notes are its version's `CHANGELOG.md` section, so a
  breaking change is called out in them as `GOVERNANCE.md` asks, instead of a
  list of pull request titles. Wrapped lines are joined, since a release body
  shows every newline as a line break. `pnpm docs:check` fails while
  `package.json`'s version has no section or an empty one, so a version bump
  without notes fails its pull request rather than the tag release. The
  container takes the tags npm does: the version, the release channel
  (`:alpha`, `:beta`, `:rc`, or `:latest` for a stable version) and, before
  1.0, `:latest` on every release, instead of always `:alpha`. `:latest`
  follows every release, while `:alpha` stays on the last alpha once betas
  begin, as npm's `@alpha` does.
  `scripts/release-channel.mjs` picks the channel for the release and its dry
  run alike, and a prerelease id other than alpha, beta or rc fails
  `pnpm check` instead of publishing under `latest`. The release dry run also
  runs `pnpm security:audit` and extracts the notes, which otherwise stopped a
  release only once its tag was cut.

### Fixed

- The web console advises on a task waiting for approval by the rule
  `melra tasks` and `melra status` use (#284), where it went by the
  challenge's expiry alone. A task approved in time and not yet run shows as
  approved, waiting for its agent or, for a workflow step its run names, its
  run (resumed first if paused or suspended), not as closed; an older
  duplicate the run does not name points at `melra workflow inspect`, since no
  advance runs it. An expired workflow step is
  never told to deny, which would fail its run: one its run names points at
  `melra workflow advance <workflow-id>` while that run is running or waiting
  on approval, and at `melra workflow resume` first while it is paused or
  suspended; otherwise, an older duplicate or a step a lost commit left
  unnamed included, at `melra workflow inspect`.
  Only a task outside a workflow, or one whose run is cancelled or
  verified_complete, is told to plan again or clear it with
  `melra approve <task-id> --deny`, and in enforced mode that includes one
  answered in band, which can no longer be approved. "Need attention" counts
  what its filter lists, the newest 500 tasks, says how many more are older,
  and redraws when a decision is recorded or lapses. `/api/tasks` adds
  `approvalPendingIds` and `attentionCount`, `/api/tasks/<id>/approval-state`
  is new, and `@melra/server` exports `workflowStepJudge`, the step rule the
  CLI and the console share. (#303)

- A task settled after the fact, by recovery or by `melra_execute`
  reconciling it, is no longer charged twice when its own draw had landed.
  Settling asked policy for the paying grant as if nothing were drawn, which
  names the first grant that matches, so a task execute charged to a later
  grant, the first being spent, was charged to both: an operation more on the
  first, or its amount twice in a `dailyMax` window. A late draw now happens
  only when the task drew nothing.

- A browser tab action no longer fails in the tab list it returns because some
  other tab does not answer. Every tab action lists the tabs after its effect, and that list
  waited for each tab's title, so one stuck tab (a page in a long script) or
  one closing meanwhile failed `tab_new` and `tab_switch` after they had run,
  which the controller retried as reads, opening another tab each time, and
  turned a finished `close` into an unknown outcome. Each title now gets at
  most a second, less when the action's `timeoutMs` is shorter, and none once
  the action is cancelled, and is `null` when it does not come; a tab closed
  during the listing is left out. `tabs` lists the same way.
- A `tab_new` that fails no longer leaves a tab behind. It is a read, so it is
  retried, and each run that failed with its tab open left one more: one whose
  destination the browser runtime refused, and one whose page then failed to
  load (a refused connection, a timeout, a redirect the runtime refuses). The
  destination is now checked before the tab opens, and a tab whose page fails
  to load is closed before the action fails.
- A `browser` wait now ends within about its `timeoutMs` instead of running
  several times longer on a busy page or one with many frames: calls get the
  time left, with a 500 ms floor capped at the requested timeout, and retain
  any shorter explicit bound. A poll stops walking candidates at the deadline
  after looking at least once, then checks the page again before deciding;
  its delay uses only the remaining time. A wait that times out ends with
  `browser_wait_timeout`, or `browser_secret_field_filled` /
  `browser_secret_check_unavailable` when its last poll could not vouch for
  the page. (#297)
- A `parallel` node runs each branch's steps in order, as documented. Every
  step of every branch started at once, so a branch's read-back ran before
  its write, a step ran after the one before it had failed, and challenges
  were minted for steps that should never be reached. A step is now planned,
  and asks for approval, only once the step before it has verified; branches
  still run side by side. Recovery no longer records a parallel node complete
  while a branch has steps that never ran. (#245)

- A workflow node waiting for input or approval no longer holds up nodes that
  do not depend on it. While any node waited, `melra_workflow_advance`
  offered only the waiting ones, so an independent branch stopped until the
  person answered. Each advance now offers the waiting nodes and the newly
  ready ones together, except one that finds a waiting step's task denied or
  otherwise moved since the last advance: it offers only the waiting nodes, so
  nothing new starts on a run that may now fail. (#247)

- A workflow step stopped by `workflow cancel` no longer reads in flight for
  good when something else held the run's lease as its task ended. Its record
  was written once and dropped on `workflow_lease_held`, so the step kept
  reading `recovery_required` / `task_still_in_flight` while its task read
  `cancelled` or `verified_success`. It is now tried again while the lease is
  held, and cancelling the run again records any such step whose task has
  ended, in this process or another. (#325)

- A failing step no longer unwinds past a condition's step whose outcome is
  unknown when the advance that ran it lost its commit (a locked database) and
  the next advance cannot ask the condition's check (inconclusive or
  unresolvable). The condition waited or failed naming no step, so a failed
  sibling started the unwind and compensated what that step may depend on.
  It now halts the run on that step (`recovery_required`), as after a
  restart. (#318)

- A deny and an execute in different processes no longer both win. Starting a
  task, and cancelling one (`melra approve --deny`, the console's Deny,
  `melra_task_cancel`), now moves it out of `planned` or `awaiting_approval`
  only if it is still there when written. Before, an execute that read the
  task just before a deny landed went on to run the effect the deny had
  reported cancelled; a deny that read it just before an execute started it
  rewrote the running task as `cancelled` while its effect ran; and two
  processes executing one task could both run it. Now the second writer
  loses: an execute is refused with `task_not_executable:<status>`, a cancel
  returns the task as it now stands (exit 1 from `melra approve --deny`), and
  the console refuses the Deny with `task_not_cancellable:<status>` where it
  showed the task as denied. A workflow advance asking a step's expired
  challenge again likewise reads the step as the running task when an execute
  started it just first, where it asked again beside it and approving that
  ran the effect twice. (#244)

- Two reconciles of one parked task no longer both write. `melra_execute` on
  a `recovery_required` task asks the provider and records the answer; a
  second call meanwhile, or the sweep's recovery beside an agent's call, asked
  too, and the slower answer was written over the first: one that could not
  reach the provider, or that said the effect never happened, rewrote a task
  already settled `verified_success` as parked or `failed` and dropped its
  receipt. Now an answer is recorded, with its receipt and certificate, only
  while the task is still `recovery_required`, and the later call writes
  nothing and returns the task as it now stands. (#244)

- `workflow pause`, `suspend`, `resume` and `cancel` (`melra_workflow_control`,
  `melra_workflow_cancel`) no longer land under an advance that is running a
  step. They wrote the run at once, so the advance's commit then failed with
  `workflow_state_conflict`: a step whose effect ran and verified was left
  `pending` with no task, a resumed run planned it again and wedged on the
  duplicate, and a cancelled run left the effect out of its record for good.
  Each now takes the run's lease for the moment it writes, as recovery does:
  while an advance in any process holds it, each is refused with
  `workflow_lease_held` and changes nothing, so retry once the advance
  returns. Cancelling a running step's task with `melra_task_cancel` instead
  fails that step, and the advance still running it starts the run's unwind
  before the cancel can land.
  An advance whose lease lapsed (it stalled, as across a laptop's sleep) is
  taken over instead: it stops with `workflow_lease_lost` before its next
  step, where before it ran that step on a paused or cancelled run. A pause,
  suspend or resume leaves its expired lease in place, so the run is
  recovered before it is next advanced. A cancel recovers the run itself
  first, as it does for one whose advance died holding the lease or lost its
  commit: each step is read again from the tasks under its keys, so the steps
  that advance ran are recorded on the cancelled run rather than left off it
  for good, and a task still running there is cancelled as the run's own.
  That step is recorded as still in flight (`recovery_required`,
  `task_still_in_flight`) rather than as cancelled, since in another process,
  or one that died mid-effect, its effect may still land; one running in the
  cancelling process is recorded as it ended once it stops. (#244)

- `workflow cancel` (`melra_workflow_cancel`) cancels a run's tasks only once
  the run's own cancel is recorded. It cancelled the challenges on the run's
  steps, and whatever a lost advance left under them, first, so a cancel whose
  write then failed (a locked database) left a step's challenge cancelled on a
  run that went on: the next advance read it as a denial, failed the run and
  offered its compensations. Now such a cancel changes no task; a failure
  while cancelling the tasks after it is reported, and cancelling the
  cancelled run again sweeps again. (#244)

- A workflow step whose advance lost its commit is taken up by its
  idempotency key on the next advance instead of planned afresh. An
  `operation` or `approval` node, a `parallel` branch, a `bounded_loop`
  iteration or a `compensation` that the run named no task for planned a new
  one without looking for the task the lost advance left under the same key:
  a leftover challenge stayed approvable beside the new one, a step that took
  effect but failed its evidence (`partial`) ran a second time, and one that
  verified was cancelled as its own duplicate and halted the run; one that
  failed or was denied was run after all, while a compensation the lost
  advance had already run for it was recorded as skipped. Now every step,
  a condition's branch included, takes up the task committed under its key,
  else the one recovery prefers of every task there, one that failed, was
  denied or cancelled, ran out of budget or was refused by policy included,
  and is planned afresh only when its key holds no task at all. A loop that
  such an advance carried into its next iteration goes on there, rather than
  ask `until` again of the iteration before and stop short of one that ran.
  A pause no longer loses an advance's commit (above), but a failed write
  still can, and runs an earlier version left this way heal on their next
  advance. Each step finds the tasks under its key in SQL, on an index
  (migration 6), so a long task history does not slow it. (#319)

- Workflow recovery, at startup, in the sweep and when a parked step
  settles, reads each step's tasks by its idempotency key, on the migration 6
  index, instead of the newest 100,000 tasks in the home. Past that many, a
  step's task could be missed: a `parallel` step with one branch run and
  another still waiting for approval was recorded as complete. And each read
  scanned the whole listing once per step key: recovering a 100-iteration
  loop of 50 steps in a home of 100,000 tasks took 15-20 s per run, and
  now takes about 0.1 s. `workflow cancel`, which now recovers the run first
  (above), reads its steps the same way and never the whole history.

- A condition step whose advance lost its commit (a pause landed while it ran)
  keeps to one branch. Recovery read both branches' tasks together and could
  reopen the step on the branch it had abandoned, or, when the branch it took
  was empty, on the other one: that offered the abandoned branch's approval
  again, ran both branches' effects, and counted a step done that never ran.
  Without a restart, the challenge such an advance left on the branch not
  taken stayed approvable, even once the run had finished. Now the branch with
  a committed step is the branch, then the one the run recorded (a condition
  recorded done with no task took its empty branch), and only then the
  predicate. At recovery and at the advance that decides, the other branch's
  tasks still planned or waiting for approval are cancelled, and each cancel
  is read back, as `workflow cancel` does for a condition not yet decided.
  A task there that may have had an effect, or one started before its cancel
  landed, halts the run as `recovery_required` with
  `workflow_condition_branch_conflict:<node>` instead of running the other
  branch beside it. A task there that did not happen (its adapter reported it
  failed, it ran out of budget, it was cancelled or refused by policy, or it
  was reconciled as never applied) counts for nothing, and the run moves on.
  One that took effect (it verified, or its evidence did not hold) cannot be
  reconciled, so the run stays halted: inspect what that branch did, undo it
  by hand, then `workflow cancel`, which compensates nothing, so what earlier
  steps did is undone by hand too where it should not stand. A restart before
  the condition is decided still reads a step such an advance ran whose
  outcome is unknown as the condition's, so it halts the run rather than let
  a failed sibling unwind past it; anything else such an advance left waits
  for the next advance, so the run halts or moves on the same with or without
  a restart. `workflow cancel` cancels whatever a lost advance left planned or waiting
  for approval under any of the run's steps, not only the tasks the run
  names, and cancelling an already cancelled run sweeps again; a run whose
  definition can no longer be opened is still ended, but nothing is swept.
  A branch's step is found by its idempotency key, so an advance no longer
  asks again for a step whose effect already committed, nor reuses another
  branch's task by position. (#268)

- A workflow advance that lost its lease starts no further step. This happens
  when the advance stalls past the lease, as across a laptop's sleep or a long
  pause, and another process recovers the run and takes it over. The advance
  now renews its lease before it plans each step of a sequence, loop
  iteration, condition or parallel branch, or compensation, and before it
  commits; when the lease has been taken it fails with `workflow_lease_lost`
  and commits nothing. Before, it carried on and ran that step's effect a
  second time beside the process that took over, and found out only at its
  final commit (`workflow_state_conflict`). A lease that lapsed but that nobody
  has taken yet is renewed there and kept, so a takeover landing after that
  check is refused rather than running the step as well. A step already
  running is not interrupted. A renewal the database was too busy for still
  does not count as losing the lease between steps (#304); one just before a
  step fails the advance with that error rather than start the step. Advance
  the run again to carry on from wherever the other process left it. (#309)

- An absolute path spelled through the workspace root as configured is
  accepted when a symlink or junction lies in the root, as with macOS's
  `/tmp` and `/var/folders`, a symlinked project directory or a Windows 8.3
  short-name `TEMP`. A file operation's `path` and a move's `destination`,
  file evidence (`file_exists`, `file_absent`, `file_hash`, and a registered
  verifier's path through `workspacePath`) when planned and when checked, a
  terminal `cwd` and a browser upload's `filePaths` were refused as outside
  the workspace (`path_outside_workspace`, `evidence_path_outside_workspace`,
  `verification_path_outside_workspace`, `cwd_outside_workspace`,
  `browser_upload_outside_workspace`); only a relative path or the root's
  resolved spelling worked. Such a path is read as the same path under the
  root as resolved at startup, where the caller's input enters, and is then
  checked like any other: the root itself (but for `list`), MELRA's own files
  and `.git` are refused as before, a sibling whose name only starts like the
  root's is still outside, and a link inside the workspace is still judged by
  where it leads. The browser runtime now resolves the root once at startup,
  as the others do, so a link in the root re-pointed while the server runs
  takes effect after a restart. (#305)

- `melra doctor`'s `data-location` advice and the enforced-mode refusal
  `enforced_mode_refuses_data_inside_workspace` give the fix that fits the
  layout. A workspace that is home or holds it, the usual cause, gets: set
  `MELRA_WORKSPACE` to the project directory or run the command from there
  (with a `MELRA_POLICY` file, or make the project its `workspaceRoot`), and
  keep `MELRA_HOME` where it is. Only a `MELRA_HOME` put inside a project
  gets: move it out of the workspace, with everything in it. Both always
  said to move `MELRA_HOME`, which for the usual cause points the server at
  a new, empty database and orphans the tasks and approvals in the old one.
  `doctor --json` carries the advice as the check's `next`.

- A parked mutation whose `reconciliation` predicate could not be asked stays
  `recovery_required`: a URL token with nothing to fill it (`{{json.id}}`,
  when there is no response on that path), a custom verifier the runtime does
  not have, or one whose backend timed out. It was settled as `failed`,
  `reconciliation_confirms_effect_not_applied`, without the provider being
  asked, and the agent ran the effect again. A predicate whose check throws is
  now `inconclusive` in the receipt, as an unreachable provider already was; a
  missing file is still a plain no for `file_exists` and `file_hash`, and a
  path under a regular file (`ENOTDIR`) is absent for `file_absent`, where it
  was an error. An item the kernel itself refused to ask (a path outside the
  workspace or reserved, a path the filesystem will not take whole, a URL
  token with nothing to fill it, a verifier or probe the runtime does not
  have) also carries `unanswerable: true`, so a caller can tell a question that
  is refused every time from one worth asking again without reading its
  summary; a verifier cannot set it. The task's `error` says which:
  `reconciliation_unanswerable:<refusal>` means the declaration needs fixing,
  `reconciliation_inconclusive` that the provider may answer later. Planning
  refuses a `reconciliation` verifier the runtime does not have
  (`evidence_verifier_unavailable`), as it did for `requiredEvidence`, a
  `file_exists`, `file_absent` or `file_hash` path in either that can only
  land outside the workspace or on its root
  (`evidence_path_outside_workspace`), and a reconciliation URL token the
  facts it is read against (`taskId`, `url`, `method`, `idempotencyKey`)
  cannot fill (`reconciliation_unanswerable:verification_token_unresolved:<token>`):
  such evidence ended `partial` after the effect ran, and such a
  reconciliation left the task parked for good. A workflow run accepted before
  this change is not stopped at that step.

- A mutation whose adapter returned, but whose result, receipt or task could
  not then be written (a locked or full database), parks as
  `recovery_required` with inconclusive evidence. It was recorded as
  `failed`, which reads as the effect not having happened, and counted against
  the target's circuit breaker though the target had answered. A task already
  recorded as `verified_success` keeps that outcome when only its certificate
  fails to write; it was rewritten as `failed` beside its own verified
  receipt. A workflow step's certificate is then written by the run's next
  `advance`, so the run still finishes. It is written only if none is stored,
  as the executor's own now is, so two processes never hand out different
  certificates for one task, and reading receipts writes nothing. A mutation
  that had verified and committed its idempotency key before the write failed
  settles as `verified_success` when it is next reconciled (`melra_execute`),
  declared `reconciliation` or not.

- A workflow step whose adapter error runs past 10,000 characters is
  recorded. The task kept the whole message and a workflow node's `error`
  holds 10,000, so writing the run failed after the step ran, and the next
  `advance` ran the step again. The task, its receipt and the node now keep
  the first 10,000 characters.

- A workflow `condition`, a `bounded_loop`'s `until` and a `delegation`'s
  `requiredEvidence` no longer read a check the provider did not answer (an
  `http_resource_matches` read that got a 503, a 429 or no connection) as a
  "no". The condition took its other branch for good, refunding a charge that
  went through while the provider was briefly down; the loop ran another
  iteration of its body; and the delegation failed its run. Nothing is decided
  on such a check now: the advance records the other nodes and fails with
  `workflow_check_inconclusive:<node>`, the condition runs neither branch, the
  loop keeps the iteration it ran and starts no other, the delegation stays
  `awaiting_input` and keeps the report it was sent, and the next advance asks
  again. The node's `error` names the check it waits on, by type and source (a
  URL without its query, which can carry a token), and asking again writes
  nothing, however the provider words its failure. A definite no among a
  delegation's checks still fails it while another goes unanswered. A provider
  that never answers holds the run until `melra_workflow_cancel`, which does
  not compensate. Planning refuses a check no registered verifier can ask
  (`evidence_verifier_unavailable`) or on a file path outside the workspace
  (`evidence_path_outside_workspace`). A condition or delegation check the
  kernel refuses to ask when it runs (an `unanswerable` item: a URL `{{token}}`
  its source result cannot fill, a verifier gone since planning, a reserved
  path) fails its node (`workflow_check_unresolvable:<node>`) rather than
  waiting on an answer that cannot change. A loop's `until` reads it as a no,
  since the next iteration's result may fill the token, and runs to
  `maxIterations` at most.

- `melra_workflow_advance` on a run with nothing due, such as a step still
  waiting for approval or input, changes nothing, as its description says. Each
  call recorded each waiting step again, so every poll bumped `stateVersion`
  and appended a `workflow.node_changed` event per waiting step. It now returns
  the run as it was, with no events, and the waiting steps' tasks as before.

- `melra policy test` previews a mutation that declares no evidence with the
  evidence the server derives for it, as `melra_plan` does, and prints it as
  `requiredEvidence`. It previewed such a mutation as `deny
  mutation_requires_evidence` even where the server derives evidence for it
  and asks for approval, as for most file, memory, browser, computer and http
  mutations. (#283)

- `melra tasks` and `melra status` count a task whose approval has expired
  apart from those still waiting, and say to plan it again or clear it with
  `melra approve <task-id> --deny`. They counted it as waiting forever and
  pointed at `melra approve`, which refused it. An expired workflow step is
  counted on its own and pointed at its run with `melra workflow inspect`,
  with no advice to deny: where the run still waits on the step, its next
  advance asks again, and a deny would fail the run, or for a compensation
  stall its unwind. Only a step that
  a cancelled or verified_complete run names gets the plain hint, since that
  run never advances again. A task
  approved in time and not yet run counts as neither, since its agent can
  still run it, and in enforced mode a task answered in band is no longer
  counted as waiting for an answer it cannot take. `status --json` adds
  `expiredApprovals` and `expiredWorkflowSteps`; `awaitingApproval` counts only
  approvals that can still be given. (#284)

- `melra tasks --status` and `--limit` with nothing after them are refused.
  They were ignored, so `--status $S` with `S` unset listed every status as if
  filtered. (#285)

- A process whose database is closed while a workflow advance is still
  running, as at shutdown, no longer dies on an uncaught `database is not
  open` from the lease renewal timer. The timer stops renewing, and the
  advance fails on its own next write. A renewal that fails for any other
  reason, such as a database too busy to answer, is tried again on the next
  tick, so the lease never lapses under a running step (#304).

- A file `move` that only changes letter case (`Readme.md` to `README.md`)
  verifies on a case-insensitive disk, such as macOS's default. The
  `file_absent` evidence derived for the source found the renamed file under
  the old spelling, so a correct rename ended `partial`. Against a move's own
  result, the move's source now reads absent when what its spelling reaches is
  the destination's own entry, with no other name, and the directory no longer
  holds that spelling; a symlink renamed by case included, and one recovered
  after a crash interrupted its verification. Anywhere else, a path that
  reaches a file still reads present, however it is spelled. (#280)

- Deleting a live memory that superseded another makes the one it replaced
  live again, and so does editing it to supersede something else or nothing;
  deleting one in the middle of a chain links the records on either side. The
  replaced record used to stay hidden with nothing live pointing at it: it
  could not be read, edited or superseded, and compaction deleted it a
  `maxAgeDays` later. A correction that expires, or that `maxPerScope`
  evicts, revives nothing, and `docs/INSTALLATION.md` says why, and how far
  back deleting corrections reaches once compaction has run. Edits and
  deletes of one chain from two processes no longer interleave. (#250)

- A terminal `run` stopped by its own `timeoutMs` is an unknown outcome
  (`recovery_required` for a mutation), as it already was when the task's
  budget or a cancel stopped it. It was recorded `failed`, though the program
  may have done its work first, and a retry then ran it again. A computer
  input action (click, move, drag, type, key, scroll) whose helper is stopped
  by its timeout, or by a cancel while it runs, is an unknown outcome too.
  Reads, screenshots and target resolution are unchanged, except that a
  terminal read stopped by its timeout is now retried up to
  `budget.maxRetries`, as other failed reads are. A timed-out `run` no longer
  returns a result with `timedOut: true`. (#248)

- `melra serve --http` and `--socket` no longer keep every MCP session for the
  life of the process. The TypeScript SDK's `close()` and `melra conformance
  --url` now end their session, which they never did, waiting at most two
  seconds for the server. Past 256 sessions, a new one ends the least
  recently used session with no request in flight and no event stream open,
  such as one whose client vanished; a client holding the event stream open,
  as both SDKs do, is never ended. A
  request naming a session the server does not have, such as one from before
  a restart, gets 404 with JSON-RPC error -32001, which tells an MCP client to
  start a new session. It used to get 400. (#253, #257)

- A file `write` with `encoding: "base64"` refuses content that is not base64
  (`file_content_invalid_base64`) before anything is written; line breaks,
  missing padding and the URL-safe alphabet are accepted. Node's lenient
  decoder wrote two joined chunks as the first, plain text as noise and `!!!!`
  as an empty file, each verifying as a success. (#279)

- A file `write` to a symlink inside the workspace writes the file it points
  to, as `read` reads it, and keeps that file's permissions. It replaced the
  link with a plain file and left the target unchanged. A write to a dangling
  link is refused (`file_write_dangling_symlink`). (#281)

- A file `list` of the workspace root works however the root is spelled
  relative to itself (`./`, `sub/..`) or by its resolved absolute path, not
  only `.`. The others were refused as `path_outside_workspace`. (#282)

- A workflow step parked as `recovery_required` moves at the run's next
  `advance` once its task is settled, for example by `melra_execute`
  reconciling it against the provider, and so does a compensation an unwind
  stopped at. The run used to stay
  `recovery_required`, with no events, until a process restart ran recovery:
  a long-running server could not finish the workflow, the steps waiting on a
  reconciled success never ran, and a reconciled failure never failed the run
  or started its unwind. (#246)

- A workflow step that fails no longer starts the unwind while another step's
  outcome is unknown or unsettled (`recovery_required`: an effect that may have
  happened, or a task still running). The run halts as `recovery_required`,
  starts no further step, and fails and unwinds only once that step is
  settled by its `reconciliation`, as a denied step already did; one that
  declares none leaves `workflow cancel` as the way out. It used to refund a charge whose
  shipment might be in transit, and skip the compensation of a step that went
  on to verify. This holds for sibling steps and for branches of one
  `parallel` node, live and after a restart; a branch refused for a wrong
  approval no longer reports before the others finish, which left the node
  recorded as it was and let the unwind start. A run an earlier version left
  `failed` beside such a step, including a `parallel` node it recorded as
  failed, is halted the same way at its next advance. The unknown step's
  compensation, which that unwind skipped, is offered again, also when the step
  ran under its `approval` node or when that unwind had stalled. (#270)

- A workflow with an `exit_code` evidence predicate can be planned, and so can
  one with a node id, verifier name or URL that looks like an API key
  (`api-integration-tests`). Planning parsed the redacted copy it stores
  against the definition schema, and redaction had turned the exit status into
  a string and such names into `[REDACTED_API_KEY]`, so every interface refused
  the plan and blamed the caller's valid input. The redacted copy is now
  stored as it is; the sealed definition is the one that runs. An `exit_code`
  predicate's whole-number value is also kept in that copy, since no secret
  can hide in it. Any other `value` is still redacted. (#278)

- An `http` response past `maxResponseBytes` returns the body up to the cap.
  The chunk that crossed the cap was dropped whole, so a body that arrived in
  one read (anything up to tens of KB) came back empty, and `bytes` counted
  the dropped chunk; it now counts the bytes delivered. An
  `http_resource_matches` read that misses on a path into a 2xx body cut at
  the cap (`json.*`, or a `bytes` or `content` larger than what arrived) is
  inconclusive, not a "did not match": as reconciliation it leaves the task
  `recovery_required` instead of `failed`, and as evidence the item is marked
  inconclusive. A cut body never matches an exact `bytes` or `content`,
  whether in `http_resource_matches` or in `result_equals` on the adapter's
  own result, since the whole body is longer than what arrived. A miss on the
  status or a header is still the provider's answer. (#249)

- The screen reading that `inspect` falls back to when no element tree came
  back deletes its screenshot once `tesseract` has read it. Each such
  `inspect`, and each `click`, `move` or `drag` given a `target`, used to leave
  a full-screen capture in `<MELRA_HOME>/artifacts` that no result named. A
  reading that fails no longer fails the `inspect`: it returns what the adapter
  observed, without `elements`, as on a host without `tesseract`. A `target`
  still fails with the reason the reading failed. (#251)

- `docs/COMPATIBILITY.md` names MCP Python SDK `1.30.x`, the version `sdk-py`
  pins and tests, not `1.28.x`. `pnpm check` now fails when either SDK line
  stops naming the pinned version. (#286)

- The TypeScript SDK's `execute()` and `advanceWorkflow()` wait up to 36
  minutes for the server, past a task's budget and its built-in evidence
  reads, instead of the MCP client's 60 s default. A task that
  ran longer than a minute was reported to the caller as `Request timed out`
  while the server went on and verified it, and a caller that took that as a
  failure could run it again. `MelraClient.connect({ runTimeoutMs })` sets the
  limit, and refuses a value that is not a whole number of milliseconds from 1
  to 2147483647. (#256)

- `send` to an interactive terminal job whose program has closed its stdin is
  refused as `terminal_job_stdin_closed`. Every send after the failed write
  was refused as `terminal_job_not_interactive`, and the send whose write
  failed on the spot was reported as sent. A send to a job whose program has
  exited is refused as `terminal_job_not_running` even while something it
  started still holds its output open. (#271)

- The Python SDK's README says how to install it: the wheel attached to each
  GitHub release, checked against `SHA256SUMS` and its attestation, or
  `pip install ./sdk-py` from a checkout. No doc said so before, and the SDK
  is not on PyPI, so `pip install melra` does not install it. (#259)

- Denying a durable workflow's step (`melra approve <id> --deny`, the
  console's Deny) or cancelling its task (`melra_task_cancel`) no longer leaves
  the run `running` for good with nothing left to run. The step did not
  happen, so the run is `failed`, as when a step fails, and the compensations
  declared for the steps already done unwind newest first, each still a
  governed task that waits for its own approval. `melra workflow cancel` still
  ends a run without unwinding it. Denying or cancelling a compensation now
  stops the unwind as a failed one does: the run is `recovery_required` with
  `workflow_compensation_incomplete:<node>`. It used to read `failed`, and the
  next advance went on to undo the step before it. A run where another step's
  outcome is unknown (`recovery_required`) halts there instead of unwinding
  past it. A parallel node with a denied branch now ends when an advance reads
  the denial, live and after a restart, instead of keeping its other branches'
  approvals on offer. A run an earlier version left `running` this way is
  repaired the next time the runtime starts (`melra serve`, any `melra
  workflow` command, `approve`, `run`, `console`, `inspect`, `export` or
  `demo`), and one it left `failed`
  past a denied compensation reports `recovery_required` at its next advance.
  Only an operator's or agent's cancel counts as a denial. A step cancelled as
  a duplicate (its effect committed under an attempt the run does not record,
  after a pause cost an advance its commit), or a step still running or
  verifying, leaves the run `recovery_required` for recovery to settle when
  the runtime next starts, and is not read as denied or failed. A step an
  approval node already ran counts as done when deciding what to undo, and
  an unwind stops when a cancel or pause lands under it. A condition no
  longer asks its predicate again once a branch's first step has committed, so
  the other branch cannot run as well. A read that committed its key before a
  crash recovers as verified instead of running again only to be cancelled as
  a duplicate of itself. (#243)

- `melra clients` lists a client whose tokens were revoked as `pending`, not
  `approved`: a revoke now clears the client's approval along with its tokens.
  `melra clients --revoke <id>` exits 1 with `no such client` for an id that is
  not registered, and a `--revoke` with no value is refused; both used to exit
  0, the first reporting "Revoked 0 tokens". (#255)

- The TypeScript SDK's `MelraClient.connect()` says why a `melra serve` it
  started refused to start: the error quotes the server's stderr (an invalid
  policy, an unwritable `MELRA_HOME`, a Node without `node:sqlite`) instead
  of only `MCP error -32000: Connection closed`. It also reads that stderr
  for the life of the connection, so a server with a lot to say no longer
  blocks on a full pipe. (#258)

- `melra serve --http` with neither `--port` nor `MELRA_HTTP_PORT` listens on
  the documented `127.0.0.1:7457` again. An unset variable read as port `0`,
  so the server took a random port on every start, clients set up from the
  docs got connection refused, and `melra status` reported a running server
  as not running. `MELRA_HTTP_PORT=0` and `--port 0` still ask for any free
  port. A blank `--port` (`--port "$PORT"` with `PORT` unset), or one with no
  value, is refused instead of taking a random port the same way. (#252)

- An unknown flag after `--write` or `--open` is refused like any other: the
  token after them was skipped unchecked, so `melra setup --client claude-code
  --write --dry-run` wrote the client config. `melra serve --port` and `serve
  --open` without `--http` are refused rather than serving stdio while the
  operator waits on a port nobody listens on. (#254)

- In block mode (the default), a popup whose first response never arrives is
  now closed. Playwright never hands such a window over, so it used to stay
  open for the life of the context, unreported. Once the action that opened it
  has given up on it, it has as long again to load, that action's
  `timeoutMs`; one that loads is reported with its address and closed as
  before, and one that does not is closed by its target id and reported, with
  no address and marked `betweenActions`, by the action running then or the
  next. With `popups: "allow"` it is left open. (#240)

- A window an action gave up on that is handed over later, during another
  action's wait, no longer stands in for a window that action opened, which
  was then not waited for and was reported by whichever action ran when it
  arrived. The windows an action is owed are tracked by target id rather than
  counted: in a launched browser in block mode a popup costs no extra call, and
  the runtime's own new tab, or a popup left open, costs one lookup. (#234)

- In a launched browser, a popup handed over while `tab_new` is opening its tab
  is no longer taken for the runtime's own tab and left open and unreported.
  Windows handed over while `newPage` is in flight are held until it returns;
  the tab it returned is counted as the runtime's own, and every other one is
  reported, and closed in block mode, before `tab_new` lists the tabs. If
  `newPage` fails, the windows a page opened meanwhile are closed the same way
  and reported by the next action, except one that has already closed itself
  and is handed over last: that one is taken for the tab `newPage` was
  opening, and not reported. (#233)

- A popup the runtime waits for whose first response never arrives now holds
  up only the action that opened it, which still waits its `timeoutMs` for it,
  as for any window it opened. Every later action used to wait out its whole
  `timeoutMs` too, for as long as that window stayed open, in a launched
  browser and an attached one. An action that fails or is cancelled after
  opening one gives it up as well, and a cancel that comes during the wait now
  ends it at once instead of at the deadline. A window given up on is still
  reported, by the action running if it is ever handed over. One limit: a
  window a page opens between actions that never loads still holds up the next
  action once. (#226)

- On a Node.js release whose `node:sqlite` needs a flag (before 22.13, or
  23.0 to 23.3), every `melra` command, `doctor` included, now exits 1 with a
  line naming the Node.js versions it needs, instead of an unhandled
  `ERR_UNKNOWN_BUILTIN_MODULE` before any check could run. On a supported
  release with the module turned off or built without it, the line says so
  and points at `NODE_OPTIONS`. The single executable does the same: its
  bundle now loads `node:sqlite` after those checks instead of before them. `melra doctor`'s
  hint for a `node:sqlite` that loads but cannot open a database no longer
  points at the Node version. (#230)

- In a browser the runtime is attached to over CDP, it no longer closes tabs it
  did not open between its actions: a tab Chromium creates then is the
  operator's (one they opened, or a console `melra console` opened), left
  open and not reported as a popup, unless it is the runtime's. The
  runtime's are the tabs it opened, every window one of those opened, down
  any chain, and what the tab it is driving opens: a tab it picked up becomes
  its own only once it navigates it or sends it input (an action refused, or
  one whose target was never found, does not count), and stops being so when
  it moves on. That is decided when Chromium creates the window, from the
  opener it names, and holds even when Playwright hands the window over
  during the next action. A tab a link opens with a modifier or middle click
  has no opener, so between actions it counts as the operator's whoever
  clicked; it is still listed by `tabs`, and its loads are still checked. A
  tab created while an action runs is judged as the #223 entry below says.
  A window that closes before it can be looked up, such as a tab that turns
  into a download, is reported either way. Ownership lasts for one attach:
  after MELRA restarts or reconnects, the tabs it opened before count as the
  operator's until it drives one again. A reported popup's URL no longer
  carries its fragment, where a console keeps its one-time pairing code until
  its page has read it. (#203)

- In a browser the runtime is attached to, a window the operator opens
  between the runtime's actions whose first response never arrives no longer
  makes every later action wait out its whole `timeoutMs`, before or after
  they close it. The wait after an action, for windows Chromium has
  created and Playwright has not yet handed over, now counts only the ones the
  runtime will report: its actions' popups and what its own tabs open. A
  launched browser waits as before. (#221)

- In a browser the runtime is attached to, a tab the operator opens while an
  action runs is no longer always closed and reported as that action's popup.
  While an action runs, a new window is the action's unless Chromium names one
  of the operator's tabs as its opener, or it has no opener and Chromium
  creates it blank or at one of its own pages: a tab another CDP client opens,
  or one from the toolbar. No page can have the browser open one of those, so,
  like the operator's windows between actions, they are left open, not
  reported, and not waited for. A tab that starts at a web address is still
  the action's, because a page can have the browser open one for it (a sign-in
  window, say), and so is one `melra console` or another app hands the browser
  while an action runs. A tab the runtime only landed on stays the operator's
  during a read; what it opens while the runtime navigates it or sends it
  input is the action's. Windows the agent's pages open are still closed and
  reported. A tab a link opens with a modifier or middle click has no opener
  and starts out empty whichever page clicked it, so while an action runs it
  is still taken for the action's. A window handed over in the instant the
  runtime opens a tab of its own (`tab_new`) is now judged like any other;
  it used to be taken silently for the runtime's new tab, neither closed nor
  reported, and what it opened later counted as the runtime's. (#223)

- The y/N question `melra approve` and `melra run` ask in a terminal takes
  input that ends before an answer as a no: both say `Not approved.` and
  exit with status 1. Ctrl-D or Ctrl-C there used to stop with `melra:
  Aborted with Ctrl+D` (or `Ctrl+C`). With stderr redirected, Ctrl-D or the
  end of input, and on Node before 22.15 (23.8 on the 23 line) either key,
  left the question open and the command exited 0 without a word.

- A release run that fails after publishing to npm can be re-run: packages
  already on the registry at that version are skipped instead of stopping the
  run. The provenance check waits up to 15 minutes per package for the
  registry to show the attestation (0.3.0-alpha.14 stopped after 2.5 minutes,
  with every attestation present minutes later), and the GitHub release is
  created before `latest` is moved, which now warns, rather than failing the
  run, when the package's trusted publisher may not move dist-tags.
- `pnpm versions:set` moves `server.json`'s versions too, and `pnpm
  versions:check` fails when they, or the CLI's `mcpName` and `server.json`'s
  name, disagree. Both also cover the three sentences that name the current
  release (the top of `docs/CAPABILITIES.md`, the pre-stable note in
  `docs/COMPATIBILITY.md`, and the README's `melra version` sample), which had
  stayed at 0.3.0-alpha.12 through two releases. `docs/RELEASES.md` lists the
  MCP Registry publish step.

- The container image moves only once a release run has passed everything
  else, the install smoke on every runner included. The 0.3.0-alpha.13 and
  alpha.14 runs pushed `ghcr.io/xagi-lab/melra:alpha` while their artifacts
  jobs failed after the npm publish and before creating the GitHub release,
  because the container job waited for nothing. npm still moves first, so
  after such a failure npm's dist-tags lead the image's until the failed jobs
  are re-run. npm packages publish in dependency order with `@melra/cli` last,
  so a run that stops partway leaves no published package whose `@melra/*`
  dependencies are missing; the order came from a glob that could put the CLI
  first. The order is worked out in full before the first publish, so a
  dependency cycle stops the run with nothing published.

### Security

- **Breaking:** in enforced mode, HTTP and browser effects no longer reach
  this machine's loopback names and addresses unless the policy file sets
  `"allowLocalhost": true`. Left out, `allowLocalhost` now follows the mode:
  open in developer mode, as before, and closed in enforced mode, which grants
  nothing the operator did not write down. `melra init` and `melra setup` no
  longer write the key, `melra_capabilities` publishes the value in force, and
  `melra doctor` warns on a new `loopback` line when an enforced deployment's
  policy opens it. `LocalPolicy.allowLocalhost` in `@melra/policy-core` is
  optional, and `localhostAllowed` resolves it. THREAT_MODEL said loopback
  was refused unless explicitly enabled; it now gives each mode's default.
  Upgrading: a `policy.json` that `melra init` or `melra setup` wrote with an
  earlier release sets `"allowLocalhost": true`, which keeps loopback open in
  enforced mode; delete that key unless a task needs a service on this
  machine.

- **Breaking:** the files the browser keeps its session in and credentials
  are read from are reserved like the `MELRA_POLICY` file, wherever they lie
  and in every mode: the browser profile (`MELRA_BROWSER_PROFILE`), both HTTP
  archives (`MELRA_BROWSER_HAR_PATH`, `MELRA_BROWSER_HAR_REPLAY`) and every
  credential's `source.file`. No file effect, verification or browser upload
  may name them, nor a terminal argument as a path or a plain `@`/`<`
  reference (`path_reserved`, `terminal_path_reserved`), approved or not; a
  program reading files by means of its own stays the accepted residual of
  approving it. Enforced mode now refuses to start in a workspace that holds
  one, with `enforced_mode_refuses_secret_inside_workspace` naming which; move
  it out of the workspace. A workspace inside the browser profile is refused at
  startup in every mode (`workspace_inside_browser_profile`). The recording's
  directory is made at startup rather than at the browser's first start.
  `melra doctor` reports the layout on a new `secret-location` line, which
  fails where the server would refuse to start and warns where a developer
  mode workspace holds one.

- **Breaking:** a bare program name in a terminal command is looked up only
  in `PATH` entries outside the workspace, as written and through links.
  Entries inside it, and empty or relative ones, which name the working
  directory, are skipped, and the program's own `PATH` leaves them out too,
  so a file left in the workspace is not run in place of an allowlisted
  program. A tool found only in a project's `node_modules/.bin`
  (`vitest`, `tsc`) now fails with `terminal_command_not_found`; run it
  through `npx` or `pnpm exec`, or allowlist its path. A workspace that holds
  tool directories, such as a home directory with `~/.local/bin` or a
  version manager's, loses those programs the same way, which is one more
  reason to narrow it. If no entry is left, as with a workspace at the
  filesystem root, or `PATH` is not set at all, every command fails with
  `terminal_path_empty_after_filter`, a path-qualified one too: a program
  given an empty `PATH`, or none, may search the working directory.
  `--unsafe-local` keeps `PATH` as given. On Windows, the program lookup
  also skips relative `PATH` entries.

- A terminal argument that names a file for the program to read as a plain
  reference (`@file`, `-d@file`, `--data=@file`, `name=@file`, `name=<file`)
  has that file judged too, as the one file it names: MELRA's own files are
  refused in every mode (`terminal_path_reserved`), and enforced mode
  refuses one spelled inside that leads out
  (`terminal_path_outside_workspace`). Only these plain forms are judged; a
  program's own other ways of naming a file stay the accepted residual of
  approving that program. Text that only looks like a reference, as in
  `rg "@/" src`, `rg "</div>" src` or `git show @~1`, runs as before, and so does approval: no command that runs without one reads a
  reference, and one that does, such as `curl`, already needs it.

- **Breaking:** MELRA's data directory is reserved as a whole, by every adapter and by
  verification, in every mode. A file effect can no longer write into it,
  replace it, or move or remove it or any directory that holds it (`path_reserved`),
  and the files there are no longer read through the file adapter or named in
  a terminal command. A path is judged as written and with its links
  resolved, a link whose target does not exist included, and a terminal
  argument also at each directory it climbs back out of (at most 128 per
  command, `terminal_path_too_complex`) and as a program that folds `..` as
  text reads it; a chain of more links than the system follows is refused.
  These checks narrow what a refusal can reveal about the data directory;
  they do not yet promise the same answer for every spelling of a path.
  Artifacts
  (screenshots and downloads) are the exception for reading: the file
  adapter's `list`, `read`, `stat` and `hash`, file
  verification, and the browser's upload and `file:` loads still reach them
  where they did before, but nothing may change them. The browser no longer
  uploads other reserved files or loads them through a `file:` URL, which only
  `--unsafe-local` allows (`browser_path_reserved`), whether or not the file
  exists, and refuses such an upload before it starts a browser; a download
  refused that way is still an unknown outcome, since the click went out, and
  now names `browser_path_reserved`. `file_exists`,
  `file_absent` and registered verifiers get no answer about a reserved path,
  whether or not it exists (`verification_path_reserved`), and a path a link
  leads out of the workspace gets the same refusal present or absent. On
  macOS, enforced mode now also recognises a workspace that holds the data
  directory through the data volume, and refuses to start there, and a path
  that names a file by its inode number alone is refused. The policy file
  `MELRA_POLICY` names is reserved the same way wherever it lies, since every
  start reads it again; a workspace holding it is still an ordinary one.

- In enforced mode, a terminal argument spelled inside the workspace is
  judged at each directory it climbs out of and where it ends, with its links
  followed (a link to a name not there yet included), also past a `..` or
  parts not there yet, and where a program that folds `..` as text would
  land from its working directory, so one that leads out, even on its way
  back in, is refused (`terminal_path_outside_workspace`).

- **Breaking:** a workspace that is the data directory, or sits inside it, including through
  a link, is refused at startup in every mode with
  `workspace_inside_data_directory`, and `melra doctor` fails its
  `data-location` check for it, rather than starting with every path refused.
  Point `MELRA_WORKSPACE` at the project instead.

- **Breaking:** the policy file is read strictly, against `PolicyFileSchema`
  in `@melra/protocol`. A key MELRA does not know, at any depth
  (`"allowedComands"`, `memoryRetention.maxAge`), or a value of the wrong type
  (`"allowedCommands": "git"`, `"maxFileBytes": "10mb"`, `"mutations": "Deny"`,
  an unknown trait in `deniedTraits`) now stops the server from starting, with
  every problem named by its path: `policy_invalid:
  /home/you/.melra/policy.json: allowedComands: unknown key`. Before, an
  unknown key was dropped for the default the operator meant to replace, and a
  wrong type reached policy as written. Some of those files were read more
  permissively than they said: `"unhinged": "false"` and `"allowLocalhost":
  "false"` are truthy strings, so the first switched the guardrails off and the
  second let localhost through; `"mutations": "Deny"` still asked for approval
  instead of refusing; `"mdoe": "enforced"` left the machine in developer mode;
  an empty entry in `allowedDomains`, as an unset variable leaves, let through
  any host written with a trailing dot. An empty entry in `allowedDomains` or
  `allowedCommands` is now refused, and the domain allowlist matches nothing
  with one.
  Others were harmless and are refused all the same, which is why this is
  breaking: a `"comment"` or `"$schema"` key (MELRA defines neither), and `null` as
  "use the default". `"mode"`, `"allowedCommands"`, `"allowedDomains"`,
  `"deniedTraits"`, `"memoryRetention"` and `"circuitBreaker"` set to `null`
  used to load as the defaults and now refuse (`mode: Invalid input: expected
  string, received null`); leave the key out instead. A misspelt field in a
  grant or credential was already refused; only its message changed, from
  zod's raw JSON to the same one line. A key that is not an identifier is
  bracketed (`credentials["stripe-test"].inject.extra: unknown key`), and a
  credential `source` of neither shape says `expected {"env": ...} or {"file":
  ...}`. A mode typo reads `policy_invalid: <file>: mode:
  deployment_mode_unknown`, so it is not blamed on `MELRA_MODE`. A bad
  `approvalTtlMs` is listed with the file's other problems, as `approvalTtlMs:
  policy_approval_ttl_invalid: must be a whole number of milliseconds from 1 to
  86400000 (24 hours)` after `policy_invalid: <file>:`, rather than leading the
  message alone. A file that is not JSON says only where (`policy_invalid:
  <file>: not valid JSON at line 3 column 1`, or no position for a mistake
  Node gives none for, such as a trailing comma in a list), never the text there, which V8 quoted and which could be a
  token. Every policy a release's `melra init` or `melra setup` wrote still
  loads. `melra doctor` fails its `policy` check with the message, `melra
  policy test` prints it, and `melra tasks --json` gives it as `policyError`,
  as `melra status` does, rather than counting approvals by the defaults
  without a word.

- An authorization code issued to an OAuth client before `melra clients
  --revoke` can no longer be redeemed after it. The revoke runs in another
  process and cannot reach the server's pending codes, which live for five
  minutes, so the client could still get a fresh token in that window. Each
  code is now bound to the approval it came from, and a revoke ends it. (#255)

- A background terminal job keeps the processes its program leaves in its
  process group under supervision until that group is empty. Once the program
  exited, `stop`, the job's `timeoutMs` and the runtime's `close()` stopped
  signalling them, so they could outlive the job and the server, while `stop`
  still reported `stopped: true`. Supervision ends with the job's timeout and
  the SIGKILL after it. POSIX only: Windows has no process groups. A process
  that leaves the group (`setsid`) is still out of reach. `compose.yaml` and
  the documented `docker run` now start the container with an init (`init:
  true`, `--init`), so a process a job leaves behind is reaped when it exits;
  Node as PID 1 reaped only the processes it started.

- `melra setup` and `melra init` run with `--mode enforced` (or
  `MELRA_MODE=enforced`) write `MELRA_MODE=enforced` into the client entry they
  generate, and `"mode": "enforced"` into a policy file they create. They
  reported enforced mode while the entry started a developer-mode server. An
  existing policy file is left as it is. `melra conformance` likewise passes
  `--mode enforced` and `--unsafe-local` to the server it starts, which ran
  without them, and when that server refuses to start it now says why
  instead of only "Connection closed".

- `file.write` keeps the permissions of a file it replaces: a private file
  stayed private only until it was written, when it came back with the default
  mode, and a script lost its execute bit. A file with a name near the file
  system's length limit can now be written too.

- The Python SDK no longer passes an inherited `MELRA_UNHINGED` or
  `MELRA_SOCKET` to the server it starts, as the TypeScript SDK already did
  not: one left exported in a shell made every Python app's server run in
  unsafe-local mode. Pass either in `environment` to mean it.

- `MELRA_HOME` is created private (mode `0700`) by `melra setup`, `init` and
  `doctor`, by the server's task store, and in the container image (`/data`);
  they could be created readable by other local users. The store creates the
  task database `0600` and keeps it so. `doctor` warns when an existing
  `MELRA_HOME` is readable by others, says to `chmod 700` it, and leaves it as
  it is; a named Docker volume made by an older image keeps its old mode.

- A browser input action (`click`, `type`, `fill_form`, `select`, `press`,
  `upload`, `download`) is held to the page its checks read, the `url` it
  names and the approval-surface marker, and its target to the document it
  was found in (a frame's, for a target in a frame). The input goes through
  that element, and the target is found again only in the same document, so a
  page or frame that navigates itself while the action waits for its target,
  even to the same address, gets nothing: the action is refused with
  `browser_page_changed`. The page, and its address until the action's first
  input, are checked again after the target is first waited for (as the
  action would wait for it, sending nothing), just before the input, and
  typing stops at the first key after the page reports a new document: a page
  may rewrite its own path as it is typed into, or between a form's fields.
  What is left: a navigation that commits in the instant Playwright
  dispatches can still receive that one click or key; the address is not
  checked again during Playwright's own waits after that check (for a target
  found again after a re-render, or its hit-target retries); keys go wherever
  the page has put focus, a frame inside it included; and the checks read the
  top-level page, not a frame's content. (#196)

- The terminal approval screen (`melra approve`, `melra run`'s prompt) wraps
  every line to the terminal's width when it is printed, indenting each
  continuation and counting anything past ASCII as two columns, so the
  terminal has no line of its own to wrap: its wrap could start agent text,
  padded to the right length, at column 0, where it read like a line MELRA
  wrote, its `Effect:` line included. A terminal narrower than 20 columns, or
  one narrowed after the screen is printed, still wraps it; piped output is
  unchanged. `approvalScreen` takes the terminal's width as a third
  argument. (#210)

- `browser.inspect` no longer returns what was typed into a secret field (a
  password input, or one masked with CSS): neither the field list nor a
  targeted inspect's markup carries it, even where a framework such as React
  mirrors input into the `value` attribute. And while any frame holds a secret
  field with something in it, live or still in its markup, a read aimed at part
  of the page (`inspect`, `wait`, `scroll` or `screenshot` with a target) is
  refused (`browser_secret_field_filled`), because whether a target exists can
  be made to depend on the secret however the selector is spelled. Every frame
  is asked, before the read looks and again after, so a field filled while it
  looks voids what it found; a read whose `url` names another page is refused
  before any of this. A `wait` asks on every poll and looks for nothing while a field is
  filled, so a sign-in form that stays filled while it submits holds it up but
  does not fail it; it is refused only if a field is still filled at its end.
  A read that cannot get an
  answer from some frame is refused too (`browser_secret_check_unavailable`),
  as is a `wait` whose last poll could not tell; a frame with no document yet does
  not hold a read up, and the read does not search it. Such a read uses an
  element only when its own document is one the check read, however its target
  is written. These reads run without approval, so in a browser someone else
  also types into, such as one attached over CDP, a password they typed could
  be read back or guessed.

- The browser runtime refuses every action that sends input to a page
  carrying `<meta name="melra-approval-surface">`, as `melra console`'s page
  does: `click`, `type`, `fill_form`, `select`, `press`, `upload` and
  `download` fail with `browser_refuses_approval_surface`, in every mode and
  whatever approved them. So do the actions that can raise or move the
  console under the operator's own pointer, which the console cannot see in
  an attached browser, where Playwright's focus emulation makes every page
  report itself visible and focused: `tab_switch` onto a marked tab, `scroll`
  on a marked page, and, in a browser it is attached to, `close` of any tab,
  and `tab_switch` to any, while another marked page is open there, whatever
  the tab acted on carries, since the browser then raises a neighbour or a
  split view's partner. A runtime attached over CDP to
  the browser an operator approves in could otherwise reach the console tab
  with reads and aim a click at it. Other reads still work. In an attached
  browser, a page that does not answer within a second could be a busy
  console, so it holds `close` and `tab_switch` of the others the same
  way (`browser_approval_surface_check_unavailable`, naming its tab); it can be
  closed itself unless another tab does not answer either. `tab_switch` and
  `close` act on the very tab they checked, even if tabs before it close
  meanwhile. The check is made when the action starts. `melra doctor` now warns when
  `MELRA_BROWSER_CDP_ENDPOINT` is set: every tab in that browser, signed-in
  sites included, is a `tab_switch` away from the agent; its next step says to
  point that endpoint at a browser you do not use yourself, or unset it.

- More credential formats are redacted wherever MELRA redacts text (stored
  records, receipts, memory and terminal output): fine-grained GitHub tokens,
  npm tokens, Google API keys, Stripe restricted keys and webhook secrets,
  more kinds of Slack token, and PGP private key blocks. So is an
  `Authorization` or `Proxy-Authorization` header value: a `Digest` or
  `AWS4-HMAC-SHA256` parameter list to the end of its line, a value under
  another known scheme (Basic, Bearer, Negotiate, NTLM, token) that holds a
  digit or `=` or is sixteen characters long, and a bare value of sixteen
  characters with a digit that is not a dotted name. So are token and API-key
  headers and assignments (`x-api-key: ...`, `access_token=...`,
  `"apiKey": "..."`) whose value is eight or more token characters with a
  digit, and URL userinfo: a password of any length (an RDS IAM token is
  hundreds of characters) holding `/`, brackets or braces, a literal password
  after a `{user}`, `{{ user }}` or `${USER}` template, and an http(s) user
  alone of twenty or more URL-safe characters with a digit, the shape of an
  issued token. A stored field whose name ends in a credential word (`access_token`,
  `clientSecret`, `x-api-key`) is redacted whole unless it holds a boolean or
  null, so `isSecret: false` keeps its type; a number or any string there
  still goes, a tokenizer's `eos_token` and a `nextPageToken` included.
  Kept as they were: counts and kinds (`max_tokens`, `token_type`), the
  `credentials` list of names, code and prose that name a credential without
  holding one (`token: string`, `tokens[0]`, `z.string().min(1)`,
  `process.env.API_TOKEN_V2`, a CSS `#00ff00ab`, `Authorization: required`,
  `Basic credentials`), a plain user name such as `https://alice@host`, the
  host after `x-access-token:<token>@`, and a `{password}` or `${DB_PASS}`
  template. Limits: a URL whose port is followed by an `@` later in its path
  or query is not read as carrying credentials, so a password of digits
  followed by a raw `?` is read as a port and kept; a URL's user name stops at
  a comma, quote, bracket or brace and its password at a quote, a space, `${`
  or `://`, so a password holding one of those is not recognised; a scheme value
  under sixteen characters with no digit or `=` is kept; an assigned token is
  redacted only up to the first character outside the token set; and the rest
  of a line after a `Digest` or `AWS4-HMAC-SHA256` header goes with it. A
  dotted expression with a digit assigned to a key name
  (`apiKey: settings.keyV2`) and a page token in text are redacted too.

- Redacting text built to make a secret pattern backtrack, such as a long run
  of a repeated name fragment or of URL scheme characters, takes one pass
  instead of seconds to a minute.

- Evidence is redacted before it is stored in a receipt or certificate, as
  the rest of a receipt already was. An `http_resource_matches` item names the
  URL it read without its query or userinfo, while the request itself goes out
  as declared, and every item's summary and source pass the shared secret
  patterns, so a token in a verification URL or in a provider's error text no
  longer reaches either record. Records written earlier keep what they stored.

- **Breaking:** a credential the kernel brokered into an `http` request no longer comes back
  in the result when the far end echoes it. Each copy of the value in the
  reason phrase, a response header or the body is replaced with
  `[REDACTED_CREDENTIAL]` before the caller, the verifier or any stored record
  sees it, and the result lists that marker under `redactions`. A body cut at
  the size cap on such a call always ends in the marker in place of as many
  of its last characters as the longest brokered value has, whatever they
  held, so neither a value cut partway nor the cut itself says anything about
  it. A brokered value must be printable ASCII, so each character is one byte
  and an echo is matched byte for byte; one holding anything else is refused
  with `credential_source_invalid:<name>`. `bytes` still counts what arrived.
  Only a copy as sent is recognised, not one the provider encoded or altered.

- Development dependency: Vite, which Vitest runs on, is held at 7.3.7 or
  later (GHSA-587h-7wmj-h5pm, GHSA-r825-w8mm-5pxw, GHSA-698v-4r3x-3vcv, all in
  the editor launcher its dev server bundles). It does not ship in a published
  package.

## [0.3.0-alpha.14] - 2026-10-16

### Fixed

- The MCP Registry listing uses the exact `XAGI-Lab` GitHub owner casing in
  both the package manifest and server metadata.

## [0.3.0-alpha.13] - 2026-10-16

### Added

- `melra approve <task-id>` shows an approver the effect a task is waiting on
  (operation, target, evidence, budget, and the goal the agent stated, marked
  unverified) and records a yes bound to exactly that, without running
  anything; the agent that planned the task runs it. `--yes` skips the
  question, `--deny` cancels the task, and off a terminal it prints the effect
  and exits 3. The receipt names the approver as `cli:` plus `MELRA_APPROVER`
  (default `operator`), a label the operator chooses rather than the OS
  account. `melra run` asks the same way in a terminal instead of having the
  phrase retyped, and the console and `melra tasks` point at `melra approve`.

- `melra doctor` reports a data directory inside the workspace in a new
  `data-location` check, decided exactly as the server decides it: a `warn` in
  developer mode, where a recursive read that names no path still reaches
  `payload.key`, and a `fail` in enforced mode, which refuses to start that way.
  Unsafe-local mode, which reaches every file, gets no such verdict; its
  guardrails warning already says so.
- The CLI package publishes its MCP Registry name in `mcpName`, and the root
  `server.json` describes the stdio npm install for the next registry listing.
- Receipts say who approved an effect and how. `policyDecision.approval` records
  the channel (`in_band` for an echoed phrase, which anything that knows the
  task can compute; `out_of_band` for a decision recorded through an operator
  surface in enforced mode), the approver, when they decided, and the digest of
  the effect contract they were shown. Certificates carry `mode` and
  `approvalChannel`. `TaskController.decide` records an operator's decision,
  bound to that render, in a new insert-once table (migration 5); one made
  before the challenge expired stays usable for a TTL after it was made, and a
  workflow no longer re-plans a step whose approval was decided in time.
- GovBench covers custom evidence: five verification cases check that a
  registered verifier decides success, that it cannot read outside the
  workspace, and that evidence no verifier can check, or `custom` naming a
  built-in, is refused at plan time. 362 cases; safety `312/312`, utility
  `50/50`, published in
  `docs/research/results/govbench-0.3.0-alpha.12-2026-10-14.json`.

- A macOS sandbox profile, `examples/deploy/macos/melra.sb`: under
  `sandbox-exec`, the kernel confines every write by MELRA and the commands it
  runs to the workspace, the data directory, and temp folders, and refuses
  `sudo`/`su`/`login`. CI runs MELRA inside it on macOS: conformance must reach
  L3, a workspace write must succeed, and a write to the home folder must be
  refused. The browser adapter is not covered, since Chrome will not start
  inside another sandbox. (#52)

### Changed

- Breaking: `ApprovalChallenge.phrase` in `@melra/protocol` is optional, and
  absent on every challenge an enforced-mode kernel issues. Harnesses that
  echoed phrases in enforced mode must switch to operator approval
  (`melra approve <task-id>`, then `melra_execute` with no approval); the
  harness `approve` tool takes no phrase there. Conformance against an enforced
  endpoint swaps `wrong-phrase-is-refused` for `approval-credential-withheld`
  and `in-band-approval-refused` (L2), adds `approval-provenance-recorded` (L3),
  and needs an out-of-band approver: the suite runs its own `melra approve`
  when it spawned the server, and stops at L2 against `--url`. Developer-mode
  conformance is unchanged at 14 checks. A developer-mode `melra approve` on a
  task with no phrase is refused (`approval_needs_enforced_mode`) and records
  nothing. Tasks planned before the upgrade keep their phrase and stored expiry;
  echoing it is refused, and a developer-mode decision on one is ignored until
  it expires. 0.3.0-alpha.12 and earlier cannot read back a workflow that
  reached an approval in enforced mode, so do not downgrade past one.

- In enforced mode an approval challenge stays open for 30 minutes by default,
  not 5: an operator approves out of band, with `melra approve`, and needs the
  time. Developer mode keeps 5 minutes, and a policy file's `approvalTtlMs`
  applies in either mode. A policy file's `approvalTtlMs` must now be a whole
  number of milliseconds from 1 to 24 hours (`policy_approval_ttl_invalid`).
  Upgrading: `melra init` and `melra setup` used to write
  `"approvalTtlMs": 300000` into `policy.json`, which pins 5 minutes in either
  mode; delete that key to get the new default.

- `rg -L`/`--follow`, `findstr /D: /F:` and `wc --files0-from` now need
  approval and evidence. Each reads files no argument names: `rg -L` follows a
  link in the workspace wherever it leads, and the others take their files
  from a list.
- Releases publish to npm by trusted publishing: the registry accepts the
  release workflow's GitHub OIDC identity, so no npm token is stored, and npm
  attaches provenance to every `@melra/*` package. Owners register the trust
  once with `node scripts/npm-trust.mjs`; see `docs/RELEASES.md`. (#152)
- Planning refuses a browser operation carrying a list its action never reads
  (`browser_field_unused:<field>`): `values` belongs to `select`, `fields` to
  `fill_form`, `filePaths` to `upload`. The runtime ignored such a list, so it
  showed the person approving an effect that would not happen, and it padded
  the approval summary. A workflow run accepted before this change keeps
  running: its stored steps are not checked again as it advances.

### Fixed

- A workflow advance in which one node's task refused (a wrong approval
  phrase, a stale render) no longer throws away what its siblings did in the
  same wave. A sibling whose challenge had lapsed was cancelled and planned
  again there; with the wave's changes discarded, the run kept pointing at the
  cancelled task and read the node as cancelled for good. The other nodes'
  changes are committed first, then the refusal is reported.

- `melra doctor` no longer reports ready when enforced mode and unsafe-local
  are asked for together through a policy file, which the flag check does not
  see: its `mode` check now fails with the server's own refusal
  (`enforced_mode_refuses_unsafe_local`) and says how to clear it.

- A receipt written when reconciliation found an effect never happened kept no
  approval id, and one settled later as verified carried a made-up approval
  response. Both now carry the approval the task actually ran under.
- A receipt written by recovery or reconciliation in a process deployed in a
  different mode stamped that process's `mode`, not the one the effect ran
  under. The mode is now recorded when the task starts running.
- Recovery keeps a bounded loop's place. A loop waiting on a step past its
  first iteration lost its iteration count on any restart, so the next
  advance started again at iteration 0. If `until` had come true meanwhile,
  the loop finished there, the approved step never ran, and the run never
  completed. A loop that had already finished early on `until` was also
  reopened by a restart, so `until` was asked again of a world that had moved
  on and another iteration could run after later steps had used its result.
- Workflow recovery no longer reopens a parallel branch that was waiting for
  approval beside a branch that failed. The live path counted such a node as
  failed and began the rollback; recovery ranked the waiting branch first and
  offered its approval again, so approving it ran a forward step on a saga
  already being undone. A failed run whose rollback died inside a
  compensation is also repaired before its next advance, which used to run
  that compensation a second time. A repaired run whose rollback stalled now
  names the compensation, as a live one does.
- The docs said the `@melra/*` npm packages carry provenance attestations.
  None has: every release so far passed `--provenance` to `pnpm publish`,
  which did not attach it. The README, INSTALLATION, and STATUS now say so;
  the packages are registry-signed (`npm audit signatures`), and provenance
  arrives with the first trusted-publishing release. The GitHub release files
  and container images were attested all along.

- An HTTP or browser request to `http://localhost:<port>` reaches a server that
  listens only on 127.0.0.1, even where `localhost` resolves to `::1` first, as
  it does on macOS. The destination check resolves every address and accepts
  them all, but only the first was used, so the connection was refused. Every
  checked address is now offered to the connection, still without resolving
  the name a second time. Found by GovBench (`utility.http.get-localhost-name`).
- HTTPS to an IPv6 literal (`https://[2606:4700:4700::1111]/`) passes
  certificate verification. The bracketed host was sent as the TLS server
  name, so the certificate's IP address never matched, and a credential scoped
  to the address never applied.

- The OAuth consent page's Approve and Deny buttons work for a client that
  leaves `redirect_uri` out of its authorization request, which OAuth allows
  when one URI is registered. Both used to fail with `invalid_redirect_uri`.

- An HTTP response that stops partway through its body, after a POST has
  been sent and its headers have arrived, is an unknown outcome, as a reset
  after the write already was. It was reported as a plain failure, which
  reads as "the charge did not happen" and invites sending it again.
- An HTTP call's `timeoutMs` bounds the whole exchange. It only bounded quiet
  gaps, so a server sending a byte at a time held the call, and any
  verification or reconciliation waiting on it, indefinitely.
- An HTTP request cancelled while its credential was being read from a file
  is not sent. The cancel was missed in that window and the request went out.

- Editing a memory that superseded another, by sending its fields back with
  the same `supersedesId`, deleted it and left the one it replaced hidden for
  good. The edit now applies; superseding a record that something else has
  already superseded is refused before anything is written.
- A reconciliation or evidence probe that gets `503`, `429` or another error
  status is inconclusive, as a dropped connection is. It was read as the
  provider saying the effect never happened, so a charge that went through
  was marked `failed` and could be sent again.
- A terminal mutation cancelled, or stopped by its budget, after the process
  started is `recovery_required`: it may have done its work before it was
  killed. It was `cancelled` or `budget_exhausted` with conclusive evidence.
- Recovering a task interrupted while `verifying` honours the adapter's own
  report. An action that reported failure no longer recovers as verified
  because its evidence happened to hold.

- A terminal `send` to a job whose program had stopped reading stdin no
  longer crashes the server. The write's EPIPE arrived later as an unhandled
  error event and took the whole process down; the job now refuses further
  input with `terminal_job_stdin_closed`.
- A terminal command runs in its own process group (on Windows, `taskkill /T`
  reaches its tree), so a timeout, cancel or `stop` reaches what it started.
  A run finishes when its program exits, even if a process it started holds
  the output open; that held the run, its timeout and its cancel until that
  process ended. A cancelled program that ignores SIGTERM is killed a second
  later rather than left running.
- At most 64 terminal jobs are kept; the oldest finished one makes room, so a
  caller looping `start` no longer grows memory and processes without bound.
- Terminal output is decoded across pipe reads, so a multi-byte character
  split between two reads is no longer replaced with `�`.

- A file `hash` checks that the path is a regular file within `maxFileBytes`
  before reading it. It read the whole file first, so hashing a 1.5 GB pack
  file allocated 1.5 GB, and a FIFO blocked forever. The verifier's
  `file_hash` streams the file and refuses anything but a regular file.
- A file write whose final rename fails removes its temporary copy, which
  otherwise stayed in the workspace with the content, one per retry.
- Two servers starting at once on a fresh `MELRA_HOME` get the same payload
  key. The key file appeared empty before it was filled, so a second process
  could read it empty and refuse to start, and a crash in that moment left an
  empty key that blocked every later start.

- Durable workflows keep their order, decisions and recoveries straight:
  - an approval node is offered only once its target's other dependencies
    are done, so an approved delete no longer runs before the backup it
    depends on (and skips its undo when the backup fails). A definition where
    another dependency of the target itself waits on the approval is refused,
    as is a condition whose source is not one of its dependencies;
  - an advance waits for every node it started before reporting one node's
    error, instead of releasing the lease with effects still running;
  - a condition keeps the branch it started on rather than re-evaluating a
    live predicate into the other branch and reusing its tasks;
  - an approval challenge that expired before anyone answered is asked again
    instead of leaving the node unapprovable;
  - recovery after a restart no longer fails an approved effect, and no
    longer marks a loop or branch complete when only some of its steps ran;
  - a run that needs recovery can be paused and resumed, and resuming it
    reports `recovery_required` rather than `running`.

### Security

- In enforced mode an approval challenge carries no phrase, so the agent is
  handed nothing to echo, and any approval it sends to `melra_execute`, the
  harness `approve` tool or `melra_workflow_advance` is refused
  (`approval_in_band_refused`), even after an operator has decided, and a
  workflow advance carrying one is refused before any node moves. Only an
  operator's decision recorded in enforced mode (`melra approve`, or
  `melra run`'s prompt; `out_of_band`) runs the effect; until then the answer is `approval_awaiting_operator`, or
  `approval_expired` once the challenge has expired. An `in_band` decision row
  counts as none in enforced mode. `validateApproval` also refuses a challenge
  with no phrase, where an in-process `phrase: undefined` used to match it.

- A browser action other than `navigate` and `tab_new` that carries a `url` is
  refused unless the page it acts on (the active page, or the tab `close` and
  `tab_switch` name) is at that url when the action starts
  (`browser_page_not_at_url`). Policy shows that url to the person approving as
  the action's target and matches grants and domain rules against it, but the
  runtime never read it, so a click could carry one page's url and land on
  another. A page that navigates itself while the action waits for its target
  can still receive it.

- A `git` read that runs without approval (`diff`, `show`, `log`, `status`,
  `rev-parse`, `branch`, `tag`) no longer runs programs the repository's own
  config or attributes name. Those live in the git directory, which the
  terminal argument check never sees, so a read could run a program able to
  read `payload.key`. The file capability now refuses to write, create or move
  anything into a git directory (`path_git_metadata`, every mode), so only a
  person approving a command can change what git's config makes it run. As
  defence in depth, the terminal runtime spawns a git read with system and
  global config off and fsmonitor, hooks, signature verifiers, fetching of
  missing objects, external diff and textconv disabled; only the spawned
  command changes, so receipts still quote what was asked, and git mutations
  keep their configured identity. `--textconv` on a git read now needs
  approval, like `--ext-diff`.

- Terminal commands can no longer reach `payload.key`, `melra.sqlite` or a
  directory holding them through an absolute, `..`, symlinked, firmlinked or
  option-attached argument, in any mode (`terminal_path_reserved`). `ls`,
  `where` and `pwd` print names only, so they may still be given a directory
  holding them. In enforced mode a read-only command naming a path outside the
  workspace needs approval (`read_outside_workspace`), an argument that links
  out of the workspace is refused, and a data directory inside the workspace
  refuses to start (`enforced_mode_refuses_data_inside_workspace`).

- The Python SDK no longer sends the bearer token through a proxy from
  `HTTP_PROXY`, `ALL_PROXY` or the macOS system settings when it connects to
  a loopback or plain-http server. httpx routed the request, `Authorization`
  header and all, in cleartext to the proxy, which also could not reach a
  loopback server. Remote `https://` servers may still be reached through
  one.

- A capability grant's file target is matched against the path the file
  runtime will actually touch. It was matched against the raw string, so
  `docs/../.env` passed a `docs/*` grant and read `.env` without approval,
  and a move was checked only at its source, so it could put a file anywhere
  the workspace allowed.

- Starting a second MELRA process on the same home (any CLI command beside a
  running `serve`) no longer takes the first one's running task or workflow
  run for a crashed one. Recovery marked the live task `recovery_required`, or
  settled it from evidence and committed its idempotency key, so the process
  actually running it then lost its own result as a duplicate. Each running
  task now records the process that owns it, which holds a lock the operating
  system releases on exit, and recovery claims a task only once that lock is
  free. Workflow recovery takes the run's lease and skips runs with a task
  still running. A running runtime sweeps every 30 seconds for work a process
  left behind when it died, and an advance that finds an expired lease
  recovers the run before taking it over instead of planning its tasks again.
  Every process sharing a home must be upgraded together.
- The file runtime and the verifier refuse MELRA's own database files, its
  lock directory and `payload.key`, even when the workspace contains the data
  directory (as it does for `serve` started from the home directory, or in
  unsafe-local mode). A low-risk `file read` with no approval could read the
  payload key. Opening and closing the database in the server process also
  dropped its own SQLite locks on it.
- On Windows, a differently cased spelling of the workspace (`..\\WS` for
  `ws`) is recognised as the workspace root, which file operations never
  touch. The check compared strings while the containment check ignored
  case, so a recursive delete of that spelling removed the whole workspace.
- An `http_resource_matches` token whose value is `.` or `..` fails the
  predicate. Percent-encoding leaves dots alone and URL parsers collapse
  `..` (even `%2E%2E`), so a response with `{"id": ".."}` moved the probe up
  one level and verified some other resource.

- Browser actions take turns. One runtime serves every task, and actions
  that arrived together (a parallel workflow node, two `melra_execute` calls)
  shared one cancel signal, timeout and "input sent" flag: a click that
  landed was reported as a plain failure, and one task's cancel stopped
  another's action.
- A dialog or popup a page raises after the action that caused it has
  returned is reported by the next action, marked `betweenActions`, instead
  of being accepted and dropped.
- Typing that runs out of time after some keys reached the page is an
  unknown outcome rather than a failure that invites typing it again.
- A browser that relaunched after a crash or a failed start no longer leaves
  its previous pinning proxy listening.
- A computer `drag` to a named `target` requires its destination in pixels.
  A normalized destination was read as pixels, so the drop landed at the
  corner of the screen.

- With an attached CDP browser, a page or frame that a redirect took to an
  address the destination guard refuses is blanked and not read back, and
  WebSocket connections are checked. Chromium follows redirect hops without
  showing them to the guard, and there is no pinning proxy in that mode, so
  an allowed page redirecting to `169.254.169.254` or a LAN address returned
  its content. The request itself still reaches the address; the threat model
  says so.
- NAT64 addresses (`64:ff9b::/96`, and the local-use `64:ff9b:1::/48`) are
  checked as the IPv4 address they translate to, so `64:ff9b::a00:5` is
  10.0.0.5 and refused like it.

- A metered grant cannot be overdrawn by tasks running at once. Its draw was
  recorded only after the work verified, so two tasks re-checked against the
  same unspent grant: two operations against `maxOperations: 1`, a parallel
  workflow node over `dailyMax`. In-flight draws now count. An effect that is
  reconciled after its grant ran out is still charged; it went uncharged.

- Approving an OAuth client takes the operator's token. The consent page's
  form was the whole gate, and anything that could reach the port could post
  its own approval with no person involved: another OS user, a sandboxed
  process, or a web page that re-resolved its name to `127.0.0.1`. That
  client then held a token for every tool. The page now asks for the token
  `melra serve --http` printed and refuses an approval without it. It also
  refuses framing, and on loopback the server answers only to its loopback
  names, so a rebound page gets nothing.

- Secrets that reached SQLite or receipts in plaintext are redacted:
  - the userinfo of a URL (`https://deploy:pass@host`) in the stored request
    and the receipt target, kept even for a request policy refused;
  - the stdin answer a terminal `send` gives a password prompt;
  - `DB_PASSWORD=x`, `AWS_SECRET_ACCESS_KEY: x`, `"password": "x"` and
    `postgres://app:pw@db` in memory values, terminal output and other text;
  - `curl -ualice:pw`, `--proxy-user`/`-U`, `--secret-key`, `--passphrase`,
    `--header=Authorization: ...` and `redis://:pw@host` in arguments;
  - a memory entry's key, source and tags, not only its value.

  `find -print` and `gcc -pthread` are no longer redacted as if they were
  `mysql -pPASSWORD`: an attached `-p` value is a password only after a
  mysql-family program.

- `MelraClient.connect()` in the TypeScript SDK passes this process's
  `MELRA_*` settings (`MELRA_MODE`, `MELRA_POLICY`, `MELRA_HOME`, ...) to the
  stdio server it spawns, as the Python SDK does. The MCP SDK forwards only
  `HOME`, `PATH` and a few others, so the server ran configured differently.

- `MelraClient.connect()` in the TypeScript SDK passes `MELRA_HOME`,
  `MELRA_POLICY`, `MELRA_MODE` and `MELRA_PAYLOAD_KEY` to the stdio server it
  spawns, and `MELRA_WORKSPACE` when no `cwd` is given. The MCP SDK forwards
  only `HOME`, `PATH` and a few others, so the server ran configured
  differently. Settings that would move it off stdio or unconfine it are
  passed only when given in `env`.
- `melra conformance --url` takes the console URL that `serve --http` prints
  (`http://127.0.0.1:7457/?token=...`): it checks `/mcp` and uses the token in
  the query when `--token` is not given. It used to post to `/?token=.../mcp`.
- An empty `MELRA_POLICY`, `MELRA_WORKSPACE` or `MELRA_HOME` counts as unset,
  as an empty `MELRA_SOCKET` does, rather than naming the working directory;
  an empty `MELRA_HOME` put the database and payload key inside the
  workspace.
- `melra doctor` checks the policy file with the server's own parser, so a
  file the server refuses (`"mode": "enfroced"`, a malformed grant) fails
  `doctor` instead of passing as valid JSON. An unreadable
  `~/.melra/policy.json` fails too, rather than being skipped for the
  built-in defaults.

- A project's server is confined to that project. `melra setup` wrote the
  first project's workspace into the shared `~/.melra/policy.json`, and the
  file's `workspaceRoot` won over `MELRA_WORKSPACE`, so the server for every
  later project could read and write the first one. `MELRA_WORKSPACE` now
  wins, the shared file no longer decides the workspace, and `setup` writes
  no workspace into it. A file named by `MELRA_POLICY` may still pin the
  workspace when `MELRA_WORKSPACE` is unset.

- A policy file can no longer move a server's workspace. `melra setup` wrote
  the first project's workspace into the shared `~/.melra/policy.json`, and
  the file's `workspaceRoot` won over `MELRA_WORKSPACE`, so the server for
  every later project configured per project (Claude Code's `.mcp.json`, VS
  Code's `.vscode/mcp.json`) could read and write the first one. A policy file
  may now only narrow `MELRA_WORKSPACE` to a directory inside it. The shared
  file never decides the workspace, even when `MELRA_POLICY` names it, and
  `setup` writes no workspace into it. A file the operator names in
  `MELRA_POLICY` still pins the workspace when `MELRA_WORKSPACE` is unset, and
  a relative `workspaceRoot` is relative to that file, not to the directory
  the server started in (`/` under Claude Desktop). Clients with one user-wide
  config keep the workspace `setup` ran in.
- `melra setup --write` puts the operator's `MELRA_POLICY` into the client
  config, and refuses one that does not exist. It used to write the default
  `~/.melra/policy.json` instead, so a client ran the permissive default
  while `doctor` reported the operator's policy.
- A policy file with `"unhinged": true` is reported by the startup banner,
  `doctor` and `policy test`, as `MELRA_UNHINGED=1` is. The server already
  applied it, but the CLI said every guardrail was on. `--mode developer` no
  longer loosens `MELRA_MODE=enforced` or a policy file's enforced mode.
- An empty `MELRA_HTTP_TOKEN` (for example `MELRA_HTTP_TOKEN=${TOKEN}` with
  `TOKEN` unset) is treated as unset, so the server gets a random token. It
  used to become the token, and an empty `?token=` or `Bearer ` header then
  authenticated as the operator.
- `melra clients --revoke` takes effect on a running server. The server read
  `oauth.json` once at startup, kept honouring revoked tokens, and wrote them
  back on its next change; it now reloads the file whenever it changes.
- A flood of unauthenticated client registrations no longer evicts approved
  clients. The oldest client holding no token makes room instead, and
  registration is refused once every slot holds a client with a live token.
  Changes to `oauth.json` are locked across processes, so a registration
  timed against `melra clients --revoke` cannot write the revoked tokens back.

- A terminal command is classified as a read, which runs without approval,
  only when every argument keeps it one. The classifier looked at the program
  and subcommand alone, so these ran unapproved:
  - `git -c core.fsmonitor=<cmd> status` and `rg --pre <cmd>` ran programs;
  - `git log --output=<path>` wrote anywhere;
  - `git branch -D`, `git tag -f` and `git tag -s` changed refs or signed;
  - `npm config set` changed configuration, and `npm ls --logs-dir <path>`
    created that directory and wrote into it;
  - other package managers' "reads" ran code or wrote, through their own
    options or a file a cloned repository carries. Every `pnpm` command runs
    `.pnpmfile.cjs`, and every `yarn` command the `yarnPath` in `.yarnrc.yml`.
    `go version` and `cargo search` switch to the toolchain that `go.mod` or
    `rust-toolchain.toml` names, downloading and running it. `pip --python`
    runs that interpreter, `gem --config-file` loads plugins, `brew outdated`
    updates Homebrew, `apt -o` sets hooks that run shell commands, and
    `uv tree`/`cargo tree` write the lockfile. Only npm has reads now;
  - `tasklist /S <host>` queried another machine;
  - a UNC path (`\\host\share`, `//host/share`) given to `cat`, `findstr` or
    `rg` sent the Windows user's credentials to that host.

  Git's own option parsing is now followed for `branch` and `tag`, so
  `--color -D` is two options rather than an option and its value. Anything
  not proven harmless needs approval.
- A path-qualified command (`./tools/ls`, `C:\x\npm.cmd`) no longer passes the
  allowlist by its base name. It is allowed only when an allowlist entry names
  that exact path, and it is never a read.
- On Windows, an argument containing `"` is refused for a `.cmd`/`.bat`
  program rather than escaped. `cmd.exe` does not honour the escaping, so a
  quote could end the argument and start a second command (BatBadBut).

## [0.3.0-alpha.12] - 2026-10-14

### Added

- A hardened systemd unit, `examples/deploy/systemd/melra.service`: MELRA on
  a mode-`0600` socket in enforced mode with no capabilities, `no_new_privs`,
  a `@system-service` seccomp filter, and a read-only filesystem except the
  workspace and data directory. CI runs MELRA under the unit's own settings
  with `systemd-run`: `doctor` must report all four restrictions and
  conformance must still reach L3 inside them. (#52)

- `pnpm build:sea` builds `melra` as a single executable with Node inside
  (experimental), for machines without Node: the built CLI bundled with
  esbuild, wrapped by Node's own `--build-sea`. It passes `doctor` and
  conformance L3 with only the system directories on `PATH`, on Linux,
  macOS, and Windows in CI, and Hermes Agent connects to it. Configs written
  by `setup` from the binary name its absolute path. Not attached to releases
  yet; signing is still open. (#76)

- Evidence predicates are pluggable. Each type is checked by a
  `PredicateVerifier` from `@melra/verifier-core`, and all nine built-ins are
  now implemented that way; `Verifier.create(root, { verifiers })` registers
  more for types the kernel does not ship. The kernel keeps what decides
  success: `type` and `strength` are stamped from the predicate type over
  anything a verifier returns, so a new type reads as the weakest claim; a type
  with no verifier, or a `check` that throws, fails; a built-in type cannot be
  replaced; and file access is only through a confined
  `context.workspacePath()`. (#53)

- A task can require custom evidence:
  `{ "type": "custom", "verifier": "<name>", "params": { … } }` (flat scalars),
  checked by a verifier passed to `createMelraRuntime` as `evidenceVerifiers`.
  `melra_capabilities` lists the registered names under `customEvidence`, and
  planning refuses an unregistered one (`evidence_verifier_unavailable`)
  before anything is approved, so a mutation cannot run against evidence
  nothing can check. `custom` never reaches a built-in verifier, and its
  evidence (`custom:<name>`) is always the weakest strength. (#139)

- `melra doctor` has an `isolation` line: which OS restrictions the process is
  actually under, read from `/proc` on Linux: container, an empty capability
  set, `no_new_privs`, a seccomp filter, a read-only root. In enforced mode
  with none of them in effect, or on a platform where none can be seen, it
  warns, so `MELRA_MODE=enforced` is no longer an assertion nothing checks.
  The container smoke test now requires all five under the documented
  hardened `docker run` recipe. (#52)

- `pnpm benchmark:govbench` runs MELRA GovBench, a self-authored, LLM-free
  benchmark of 357 cases through the real runtime: containment (path
  traversal, symlinks, shells, argument injection, denied traits, SSRF
  encodings, URL schemes and credentials, oversized and malformed requests,
  constraints, missing evidence, forbidden effects), approval integrity,
  verification honesty, exactly-once, redaction (database bytes scanned), and
  utility on benign operations, plus governed-vs-raw latency. The corpus is
  data in `evals/src/govbench/corpus.ts`, hashed into every artifact. The first
  run scored safety 293/307 and found two real bugs (bracketed IPv6 literals
  skipped the private-address check; memory kept PEM private keys and AWS
  access key ids verbatim), both fixed under Security below. The published run
  now scores safety 307/307 and utility 50/50. See `docs/research/GOVBENCH.md`.

- `melra setup --client <name> [--write]` and `melra doctor` know eleven more
  agent harnesses: `openclaw` (`~/.openclaw/openclaw.json`, `mcp.servers`,
  honouring `OPENCLAW_CONFIG_PATH`/`OPENCLAW_STATE_DIR`), `hermes` (Nous
  Research Hermes Agent, `~/.hermes/config.yaml` `mcp_servers`, honouring
  `HERMES_HOME`), `copilot` (GitHub Copilot CLI), `qwen` (Qwen Code), `auggie`,
  `warp`, `junie` (JetBrains Junie), `droid` (Factory Droid), `kimi` (Kimi Code
  CLI), `kilo` (Kilo Code), and `lmstudio` (following LM Studio's home pointer
  file). Each writes that client's own format into its own file, keeping
  everything else there: JSON and JSONC by the same in-place edit as before,
  now able to reach a nested key such as OpenClaw's `mcp.servers`, and Hermes's
  YAML by the same line edit as Goose, with the same refusals. Paths and
  formats come from each client's documentation or source, linked in the code;
  docs/INSTALLATION.md lists every client, how to add MELRA to Claude Code's
  user scope with `claude mcp add-json`, and what to do for clients with no
  editable file (JetBrains AI Assistant, Jan, Trae, Crush, Mistral Vibe).
  `examples/frameworks/` shows MELRA connected from LangChain/LangGraph, the
  OpenAI Agents SDK, the Vercel AI SDK, and the official MCP SDKs.

- The MCP server now sends `instructions` on connect, which clients such as
  Claude Code put in the model's context: the plan, execute, verify loop in
  five steps, what each final status means (including never re-running a
  `recovery_required` mutation blindly), the evidence types a mutation must
  declare, and when to use workflows. Agents no longer have to piece this
  together from eleven tool descriptions after a failed first call. A test
  fails if the guide names a tool that does not exist or its evidence list
  drifts from the protocol schema.

- `melra doctor`, `setup`, `init`, and `version` print a readable report when
  stdout is a terminal: one line per check with ✓ ⚠ ✗ (`[ok]`/`[warn]`/`[fail]`
  on the legacy Windows console), one line per MCP client, a verdict, and the
  single command to run next when something warns or fails. `setup` and `init`
  say what was written where, including the `.bak`, and what to do next.
  Piped or captured output is byte-for-byte the JSON it was, and `--json`
  forces it in a terminal. Colour honours `NO_COLOR` and `FORCE_COLOR`.
  `melra setup` with no `--client` in a terminal now lists the clients it finds
  on the machine (config file, config folder, or executable on `PATH`), asks
  which one, and offers to write its config exactly as `--client <name>
  --write` would; Ctrl-C or Ctrl-D cancels with status 130 and writes nothing.

- The Python SDK can attach to a MELRA that is already running instead of
  only spawning one over stdio: `MelraClient.connect_http(url, token=...)` for
  `melra serve --http` and `MelraClient.connect_socket(path, token=...)` for
  `melra serve --socket` (not on Windows). The token is required, never read
  from the environment, and sent as a bearer header; a wrong one raises
  `PermissionError`. Plain `http://` to a non-loopback host is refused unless
  `allow_insecure_http=True`, so the token does not cross a network in clear
  text by accident. No new dependencies.

- `@melra/sdk` connects to a server that is already running, not only one it
  spawns: `MelraClient.connect({ url, token })` for `melra serve --http` and
  `MelraClient.connect({ socketPath, token })` for `melra serve --socket`, with
  every task and workflow method unchanged. The token is passed explicitly and
  never read from the environment; a plain `http:` URL to a non-loopback host
  is refused rather than sending the token in cleartext, unless the caller opts
  in with `allowInsecureHttp: true` for a network it trusts; a refused token fails
  with `melra_unauthorized`; sockets are refused on Windows, as the server
  refuses them. The stdio options are unchanged.

- The Python SDK is tested on CPython 3.12, 3.13, and 3.14 against a real
  stdio server, not just 3.11, and the wheel now ships a `py.typed` marker so
  mypy and pyright use its annotations; CI type-checks it with pyright to keep
  that promise. Its metadata lists the supported Python versions.

- `pnpm docs:check` now also checks `CHANGELOG.md`: Keep a Changelog section
  names only, one of each per release, no entry twice, no empty sections or
  leftover conflict markers, canonical order under `[Unreleased]`, releases dated newest first,
  a link reference for every release, and a section for the current
  `package.json` version so a bump cannot ship without notes. It found and
  merged a duplicate `Added` and `Fixed` in `0.3.0-alpha.6`. `CHANGELOG.md`
  now merges with `merge=union` locally, so parallel branches stop conflicting
  on it.

- The console (`melra serve --http --open`) shows tasks, not just workflows.
  Most governed work is a single task, so for most users the old console was
  an empty page. It now has an Overview (counts, posture, adapters, recent
  activity), a searchable, filterable Tasks view whose detail shows the
  policy decision, every evidence item with its strength, and the receipts,
  and the Workflows view with node-to-task links and the command that
  advances a run. Views are linkable, it works at phone width and in light
  and dark, it is keyboard navigable, and polling no longer steals focus. It
  stays read-only and never renders an approval phrase.

- `melra setup --client <name>` now emits each client's own configuration
  format and names the file it belongs in, instead of one `mcpServers` blob for
  every client — which VS Code, Zed, OpenCode, and Codex ignore or cannot
  parse. Supported: `claude-code` (`claude` still works), `claude-desktop`,
  `cursor`, `vscode`, `windsurf`, `codex` (TOML), `gemini`, `zed`, `cline`,
  `opencode`, `kiro`, and `generic`. An unknown name is now an error rather
  than a label.

- `melra doctor` reports a `clients` check: for every supported MCP client
  whose config file exists, whether MELRA is configured, unconfigured, or the
  file is unreadable; whether the configured command is on `PATH`; and whether
  an `npx` launch pins an older `@melra/cli`, with the exact
  `melra setup --client <name> --write` command that fixes it. JSON with
  comments is searched as text and says so. It warns at most, never fails, and
  only reads the files. The report also carries a structured `clients` array.

- `--write` merges that configuration into the client's file, keeping every
  other entry and saving the previous file as `<file>.bak`. JSON files are
  edited in place, writing only MELRA's own entry, so commented settings
  (JSONC, as Zed, VS Code, and Amp use) keep their comments, trailing commas,
  formatting, key order, and CRLF line endings byte for byte, with no new
  dependency (#74). The result is parsed back and checked before anything is
  written; a file that is not valid JSONC, or that names the target key twice,
  is refused and left untouched. A rerun replaces MELRA's own entry, so it
  doubles as the way to repoint a client after an upgrade.

- `melra setup --client` supports `goose`, `continue`, and `amp`. Goose and
  Continue read YAML, emitted without a YAML dependency. `--write` replaces
  only MELRA's own entry under Goose's `extensions:` and refuses a
  `config.yaml` it cannot edit line by line; Continue gets its own
  `.continue/mcpServers/melra.yaml` block file; Amp is merged into
  `amp.mcpServers` in its `settings.json`.

- **`pnpm docs:check` fails when a doc link stops resolving.** Renaming a
  heading silently broke every link to its anchor; one was found by hand during
  the unsafe-local rename, which is not a plan. `scripts/check-links.mjs` walks
  every `*.md` in the repo and checks that each relative link target exists and
  each `#anchor` — local or `other.md#anchor` — matches a heading under GitHub's
  slug rules, duplicate-heading suffixes and explicit `<a id>` anchors included.
  Code blocks and inline code are ignored, and external links are out of scope,
  since a check that fails when someone else's site is down is one people learn
  to ignore. Every failure is reported as `file:line`, and `pnpm check` runs it.

- **`pnpm docs:check` also fails when a `MELRA_*` variable is undocumented.**
  The environment table in `docs/INSTALLATION.md` was kept by hand and drifted.
  `scripts/check-env-docs.mjs` collects every `MELRA_*` name in
  `packages/*/src` and `apps/*/src`, test files excepted, and names each one
  missing from the table. The variables MELRA sets on its own Windows
  PowerShell children (`MELRA_KEYS`, `MELRA_X`, `MELRA_CLICK`, ...) are
  plumbing rather than knobs, so they sit in a literal allowlist with a reason
  each, and an allowlisted name the code no longer uses fails too. The check runs
  both ways: a table row for a variable nothing reads any more fails as well,
  naming the line to remove.

- `melra serve --socket <path>` (or `MELRA_SOCKET`) serves what `--http`
  serves — Streamable HTTP MCP, the read-only JSON API, the event stream, and
  the console — on a Unix-domain socket instead of a TCP port, through the same
  request handler (`serveHttp({ socketPath })`). It is allowed in enforced
  mode, serves no OAuth registration, and is refused on Windows and from a
  worker thread (where the umask that keeps it `0600` cannot be set), each
  with an error that says why. A socket left
  by a crashed run is replaced; a live server's socket, a regular file, or
  another user's socket at the path is refused and left alone, and a clean
  shutdown removes it. `melra doctor` reports, when `MELRA_SOCKET` is set,
  whether its parent directory exists and whether a socket there is
  owner-only. ([#52](https://github.com/XAGI-Lab/melra/issues/52))

- `melra tasks`, `melra watch`, and `melra status` show what MELRA is doing
  from a terminal, without starting a server. `tasks` lists recent tasks (a
  table in a terminal, JSON when piped or with `--json`; `--limit`,
  `--status`); `watch` prints a line, or an NDJSON event, whenever a task or
  workflow changes status, until Ctrl-C; `status` reports version, mode,
  paths, database size, task and workflow counts, how many tasks await
  approval, and whether a server is reachable. They open the database
  read-only, so they never create it or hold a lock a running server waits on,
  print only the stored (redacted) records, and never print an approval phrase
  or a token. `SqliteStore` gains a `readOnly` option, `taskStatusCounts()`,
  and a status filter on `listTasks`.

### Changed

- Terminal receipts and task records keep a command's arguments, so they show
  what ran: `terminal.run pnpm check` rather than
  `terminal.run pnpm [REDACTED_SENSITIVE_FIELD]`. Only credentials are taken
  out, by the new `redactArgv` in `@melra/receipt-schema`:
  - the value of a credential-named flag (`--token x`, `--api-key=x`);
  - `-pPASSWORD`, and the password half of `-u user:pass`;
  - credential-named `NAME=value` assignments;
  - `Authorization:` and other secret headers;
  - URL userinfo such as `postgres://user:pass@host`.

  Every argument still goes through the shared secret patterns. GovBench
  redaction stays 55/55. (#122)

- The container image and the release artifacts are built on Node 24, the
  current LTS line, instead of 22. `engines` still says `>=22` and CI still
  tests both, so the release job now installs the published package and drives
  it over MCP on Node 22 and 24 on every OS, rather than on 22 alone.

- `melra setup --client claude-code` says what Claude Code actually needs next:
  approve the project's `melra` server when `claude` asks. Until then
  `claude mcp list` shows it as *Pending approval*, which "restart Claude
  Code" did not explain.
- `setup --write` on a config that already holds exactly this entry leaves the
  file alone and says so ("already set up; nothing changed"). It used to
  rewrite the file and replace a useful `.bak` with a copy of the result.
- The setup wizard detects Claude Desktop, Cursor, Windsurf, Kiro, VS Code,
  Zed, Warp, and LM Studio from their macOS app bundles, so a freshly
  installed app is offered first even before it has a config file.
- `melra conformance` prints a readable report in a terminal: each check by
  level, the level reached, and what the suite does not prove. `--json`, or
  any pipe, still gives the JSON report.
- `melra tasks` and `melra watch` show a command as what ran (`pnpm check`,
  with its already-redacted arguments) rather than `command:pnpm`.
- Hints no longer point at repository paths an npm install does not have: the
  empty `melra tasks` suggests `melra demo durable-core`, and the doctor
  isolation hint links the Docker recipe on GitHub.

### Fixed

- `melra setup --client goose` and `melra doctor` look for Goose's config
  under `GOOSE_PATH_ROOT` when it is set, as Goose does: `<root>/config/config.yaml`,
  and only for an absolute root. Before, an operator who had moved Goose's tree
  got a config written where Goose never reads it. (#103)

- `melra serve` now says so on stderr when `MELRA_SOCKET` alone moved it off
  stdio. Exported in a shell profile, the variable also reaches every stdio MCP
  client launched from that shell, which then waited for a reply that never
  came, with nothing in its log to say why. The warning names the variable;
  `--socket <path>` given on purpose stays quiet. (#105)

- The published `@melra/*` packages no longer ship their compiled unit tests.
  Fourteen packages keep tests beside the code as `src/*.test.ts`, and the build
  emitted them into `dist/` and so into every tarball, as `*.test.js` files
  that import `vitest`, which is not a dependency. The build now leaves them
  out; `pnpm typecheck` still checks them, along with the `test/` directories
  it never covered before.

- Clicking GitHub's **Update branch** on a pull request no longer fails the DCO
  check. That button commits a merge as GitHub itself, with no sign-off and
  nothing the author wrote, and `scripts/check-dco.mjs` treated it like any
  other commit. Only that mechanical merge is exempt; a merge made by hand can
  carry conflict-resolution edits and still needs its author's sign-off.

- `MELRA_HARNESS_TOOLS` now has a row in the environment table in
  `docs/INSTALLATION.md`. It was described in prose and shown in a JSON
  snippet, but anyone scanning the table for what can be configured missed it.

- Three links in the README's contents table — *Where to use it*, *How
  execution works*, and *Repository map* — went nowhere. Their headings end in
  an emoji carrying a variation selector, which GitHub keeps in the anchor, so
  the links now include it.

- `melra doctor` no longer uses the word "enforced" for two different things. The
  `guardrails` check reported `enforced` — meaning they are applied — two lines
  above the new `mode` check reporting `developer`, and an operator reading both
  can conclude a developer-mode machine is locked down. Guardrails now read
  `all applied`, and `enforced` belongs to the deployment mode alone.

- The README no longer says the HTTP adapter is unshipped. It has been a real
  adapter since this release; the adapter table now lists it, and the capability
  comparison marks the hard capability boundary *partly shipped* — enforced mode
  ships, the OS isolation and socket transport around it do not — rather than
  *target*, which read as nothing having landed.

- An HTTP mutation no longer lands in `recovery_required` for a request no server
  ever received. The HTTP adapter drew sockets from Node's keep-alive pool, so a
  connection the server had already closed for idleness took the whole request
  and then reset — and a reset after the write is, correctly, an unknown outcome.
  Every governed call now opens its own connection, so a reset after the write
  means the far end really may have acted.

- A browser action that opens a window now reports it every time. Playwright
  announces a popup only once the popup's first response arrives, so when that
  was slower than the opener took to settle — a slow ad server, or simply a
  loaded Windows CI runner — the click returned with no `popups` field, and the
  report and the close landed in whichever action ran next, or nowhere. The
  runtime now hears about the window from Chromium the moment it is created and
  holds the action's result until it is reported, bounded by the action's
  `timeoutMs`. Actions that open nothing pay one round trip, not a delay.

- A browser page that stops answering now fails the action within its
  `timeoutMs` with `browser_call_timeout:<call>` (for example
  `browser_call_timeout:title`), instead of holding it until the task budget ran
  out — or forever, since the browser adapter never received the task's cancel
  signal. Every Playwright call that took no timeout of its own (`title()`,
  `evaluate()`, `count()`, `isVisible()`, tab and popup closes, CDP round trips)
  is now bounded by the action's `timeoutMs`; the post-action settle by its
  `settleTimeoutMs` plus one second; and all of them stop as soon as the task is
  cancelled or its budget runs out. A read that times out is an ordinary,
  retryable failure. A mutation that fails *after* its click, keystrokes,
  selection, upload, or tab close went out — a stalled settle or snapshot, a
  page that closed under it, or a click Playwright itself timed out after
  sending — now lands in `recovery_required` as an unknown outcome rather than
  `failed`, because the page may already have acted; one that fails before
  anything was sent, such as a timeout resolving its target, is still a plain
  failure.

- `melra demo durable-core` works from an npm install. It read its workflow
  from the repository's `examples/` directory, which the published package does
  not contain, so outside a checkout it failed with `ENOENT`. The workflow now
  ships inside the CLI, with a test holding it equal to the example file.
  `melra demo` with no name runs it, since it is the only one.

- Planning a workflow definition that is already stored starts a new run
  instead of failing with a raw SQLite `UNIQUE constraint` error. Running the
  demo twice, or `melra workflow plan --definition` on the same file twice as
  the README shows, hit it. The same id and version with *different* content
  is refused as `workflow_definition_conflict`, checked against the sealed
  exact definition, so a change only a redacted secret carried is caught too.

- A browser click that Playwright timed out *after* sending the input is
  reported as an unknown outcome whenever colour output is on (a TTY, or
  `FORCE_COLOR`). Playwright paints its call log with escape codes, so the
  `performing click action` line MELRA reads as proof the input left never
  matched, and a delivered click came back as a plain failure: the false
  "nothing happened" an unknown outcome exists to prevent. The codes are
  stripped before matching, and from the stored error message. Found as an
  intermittent Windows CI failure that #128 had put down to runner speed.

### Security

- Development and benchmark dependencies: `source-map-js` is held at 1.2.2 or
  later (GHSA-68fv-2mgg-jv7q, an event-loop denial of service reached through
  Vite's source maps), and the browser-agent benchmark overrides the
  `geopy==2.4.1` pin from `webarena-verified` to 2.5.0 (GHSA-mhvh-fq92-pfmr, a
  ReDoS in `geopy.Point`). Neither ships in a published package.

- An IPv6 literal in a browser or HTTP destination (`http://[::1]/`,
  `[fd00::1]`, the IPv4-mapped form of `169.254.169.254`) is now checked as the
  address it is. `URL.hostname` keeps the brackets and `isIP("[::1]")` is 0, so
  such a URL was treated as a hostname and the private-range check never ran;
  requests failed only because DNS cannot resolve a bracketed name, so nothing
  escaped, but the guard was not what stopped them. Public IPv6 literals, which
  could not be used at all for the same reason, now work. Found by GovBench.

- Memory values no longer store PEM private keys or AWS access key ids
  verbatim. Memory, terminal output, and receipts each kept a private copy of
  the secret patterns, and the copies had drifted; none knew either shape.
  There is now one list, exported from `@melra/receipt-schema` as
  `SECRET_PATTERNS` / `redactSecrets`, and it also recognises truncated PEM
  blocks, JWTs, and Slack tokens. Found by GovBench.

- The Unix-socket transport is created mode `0600` under a narrowed umask, so
  it never exists wider even for an instant, and its mode is read back before
  anything is served; a wider socket fails startup. That makes the kernel, not
  the bearer token, the first thing refusing other OS users — a loopback port
  admits every local process up to the token. The token is still required on
  every request over the socket.

- The console page is served with a Content-Security-Policy that admits only
  its own inline script and style, by SHA-256 hash, and only this server as a
  fetch target, plus `X-Frame-Options: DENY` and `nosniff`. The page carries
  a bearer token in its URL, so a script injected into it, or a site framing
  it, could otherwise act with that token.

- Cleared every advisory `pnpm audit --prod` and `pip-audit` reported, which had
  turned the scheduled Dependency Audit red on `main` and on every open pull
  request. `@modelcontextprotocol/sdk` moves to 1.32.1 (its OAuth client could
  send credentials to the wrong authorization server), and overrides pin the
  patched transitive versions of `hono` 4.13.13, `@hono/node-server` 2.1.5,
  `fast-uri` 3.1.8 (SSRF and host confusion), `ip-address` 10.7.4, `qs` 6.16.0,
  and `proxy-addr` 2.0.8 (IP spoofing through IPv4-mapped IPv6). `pyjwt` moves
  to 2.15.1 in the Python SDK and the browser benchmark.

- The release workflow no longer hands every job the publishing token. It
  granted `contents`, `packages`, and `id-token: write` workflow-wide while
  running actions by mutable tag (`anchore/sbom-action@v0` among them), and the
  `installed` job — which deliberately installs an unpinned MCP SDK — held the
  same token. Permissions are now read-only by default and granted per job,
  every action is pinned to a full commit SHA, no checkout persists its
  credentials, and the publishing job restores no cache another workflow could
  have written. A new Workflow Lint job runs `zizmor` so none of that drifts
  back; it went from 39 high-severity findings to none. The container base
  image is pinned by digest and Dependabot now tracks it.

- Tests run on Vitest 4. Vitest 3's worker pool, `tinypool` 1.x, falls entirely
  inside two critical advisories (GHSA-85c8-ppgw-ccpr, GHSA-5gmw-xhrv-c9v3);
  Vitest 4 does not use it. The `nanoid` it brings in through Vite is held at
  3.3.18 or later (GHSA-2v37-7h3g-55p8). Test-only; no published package
  changes. `scripts/run-recursive.mjs` now caps workers through
  `VITEST_MAX_WORKERS`, the one variable Vitest 4 reads.

## [0.3.0-alpha.11] - 2026-08-11

### Added

- **Two deployment modes, and enforced mode closes every door MELRA owns.** The
  honest gap in a default install was never a bug in the pipeline: MELRA governs
  the effects it is *asked for*, and a harness holding a native terminal as well
  makes the kernel optional. `MELRA_MODE` / `--mode` / `"mode"` in the policy
  JSON now says which situation you are in — `developer` (the default, and the
  reason MELRA can be tried in thirty seconds) or `enforced`, the operator
  asserting the alternative has been removed. MELRA cannot verify that from
  inside its own process, so it does the part it can: `--unsafe-local` is refused
  outright (`enforced_mode_refuses_unsafe_local`), a bind outside loopback is
  refused (`enforced_mode_refuses_public_bind`), the OAuth client-registration
  endpoints are not served at all so the operator's token is the only way in, and
  `mode` is stamped on every `ActionReceipt` and published as `policy.mode` in
  `melra_capabilities`. The strictest of flag, environment, and policy file wins,
  and a typo (`MELRA_MODE=enfroced`) fails loudly rather than leaving a machine
  permissive with a config claiming otherwise. Deliberately not refused: running
  as root — enforced mode exists for containers, which are usually root inside.
- **A conformance run says whose word the bypass caveat rests on.** The first
  `notProven` entry was fixed prose about a second ungoverned path. It now reads
  the endpoint's own `policy.mode`: against an enforced endpoint it narrows to
  *"that the operator's enforced-mode claim is true"*, and the run fails outright
  if an endpoint reports enforced mode while running with no guardrails. The
  level is unchanged either way — a mode earns no checks.

- **A mutation whose reply never arrived no longer claims it failed.** `failed`
  reads as *the effect did not happen*, and after a request that went out and
  was never answered, that is a claim nobody holds. The HTTP adapter now tells
  the two cases apart by whether the request reached the wire: a DNS failure or
  a refused connection really did not happen and still fails, while a request
  written to the socket and left unanswered is marked
  `effect_outcome_unknown:` and parks the task `recovery_required`, with
  `inconclusive: true` on the evidence item and `RECOVERY_REQUIRED` on the
  certificate. Reads are exempt — a read that may or may not have run changed
  nothing either way.
- **`reconciliation` predicates settle an outcome MELRA could not observe.** A
  new array on the task request, read against the facts that were true *before*
  the call — task id, URL, method, and the `idempotencyKey` MELRA sent — because
  a lost reply leaves no response to interpolate from. Calling `melra_execute`
  on a parked task reconciles instead of re-running, so a caller retrying the
  obvious way gets the safe thing: the provider confirming the effect resolves
  it `verified_success` (receipted as `recovered`), the provider denying it
  makes it `failed`, and a provider that cannot be reached leaves it parked
  rather than guessing. `recoverInterrupted` uses the same path after a crash.
  Declaring reconciliation publishes `reconciliation-required` on the plan
  instead of `at-most-once`, so a caller sees the stronger promise before it
  approves — it buys no retry; the effect still runs at most once.
- **Sagas unwind across providers, in order, and say so when they cannot.**
  Compensations now run one at a time, newest effect first, each verified before
  the next starts — cancel the shipment, then refund the charge that paid for
  it. A `Promise.all` was computing that reverse order and then discarding it by
  starting every compensation at once. Each compensation is an ordinary governed
  task, so undoing effects at two different hosts is the same code path as two
  at one host. An unwind that cannot finish stops rather than undoing further,
  the run becomes `recovery_required` with
  `workflow_compensation_incomplete:<node>` naming the missing inverse, and
  `advance` refuses to start new work on top of a half-undone saga.

### Fixed

- `TerminalRuntime.close()` now resolves once its supervised children have
  actually exited rather than once they have been signalled, escalating to
  SIGKILL after 2s. A still-running child holds its working directory open on
  Windows, so a caller that removed the workspace immediately after closing
  raced `rmdir` and could fail with `EBUSY`.

- A failed compensation is no longer reported as a clean workflow failure:
  `deriveStatus` excluded compensation nodes entirely, so a forward effect whose
  declared inverse did not run left the world in a state no node described and
  the run still read `failed`.
- A compensation that failed no longer triggers a second unwind of the
  remaining steps, which would undo further work while its own inverse was
  still outstanding.
- Recovering a verified interrupted task now draws down its capability grant.
  It committed the idempotency key but skipped the metering, so work recovered
  after a crash was free.

- **A capability grant can now have a size, not just an expiry.** `validUntil`
  bounds a window; `maxOperations` bounds how many times a grant may ever be
  spent inside it, and a `provider: { name, account, amountMax, dailyMax }` block
  bounds money — one call and a rolling 24 hours. The count is durable and is
  drawn down at exactly one point: where a verified task commits its idempotency
  key. An operation that was refused, failed verification, was cancelled, or
  collapsed into a duplicate costs the caller nothing, and a restart does not
  refill the budget. Money bounds need the caller to declare an operation's
  `spend`, because MELRA cannot read an amount out of an arbitrary provider's
  payload — and the direction of that check is what makes taking its word safe:
  a money-bounded grant covers declared spends only, so understating is a lie the
  grant does not cover and declaring nothing means no grant matches
  (`capability_spend_not_declared`). Provider names compare exactly, so a grant
  for `stripe-test` never quietly covers `stripe`. Several grants are several
  authorities: one that is spent out does not refuse work another still covers. A
  metered grant evaluated where nothing can count it is refused
  (`capability_usage_unmeterable`) rather than treated as full, on the same
  reasoning as an unavailable verification probe. `melra_capabilities` publishes
  how many issued grants are metered, and `melra policy test` now reads the same
  durable counts the server draws down, so a dry run cannot report a budget as
  full when it is spent.

- **An effect can now be confirmed by a channel that did not perform it.** The
  new `http_resource_matches` evidence predicate executes through one request
  and verifies through another: `POST /refunds` does the work, `GET
  /refunds/rf_1` decides whether it counts. A `201` is the client that made the
  call reporting on itself, so a provider that accepted the request without
  doing the work now lands `partial` instead of `verified_success`. The id is
  only known after the effect ran, so the verification URL is completed from the
  recorded result — `{{json.id}}` reads the parsed body, `{{status}}` the status
  — with each spliced value percent-encoded so a response field cannot rewrite
  the path. The read is an effect like any other: same adapter, same destination
  boundary, same allowlist, same credential scope, `GET` and `HEAD` only. A
  runtime with no HTTP channel fails the predicate rather than passing it. It is
  the only predicate carrying `strength: "independent"`.

- **Agents receive capabilities, not credentials.** A new `policy.credentials`
  map lets an operator hand the kernel a secret the agent never sees: the
  definition names where the secret lives (`env` or a mode-`0600` `file`), which
  header carries it, which hosts it may travel to, and which
  `<capability>:<target>` it may act under. The two scopes deliberately behave
  differently on a miss — a destination the `hosts` list does not cover is sent
  **unauthenticated**, so a caller-chosen URL cannot walk a bearer token to
  another origin, while an operation the `capability` does not cover is
  **refused before the secret is read**, so a rejected call never brings
  plaintext into the process. The result and the receipt record which credential
  authorised the effect by name; the value reaches the socket and nothing else.
  `melra_capabilities` publishes the configured names.

- **HTTP and API calls are now a governed effect.** A new `http` operation kind
  (`packages/http-runtime`) puts one bounded request through the same pipeline
  every other effect goes through: `GET`/`HEAD` classify as reads, every other
  method is a mutation that needs declared evidence and a typed approval, and
  the response status is what verification is checked against. A 2xx is the far
  end's own word, so a completed call whose declared evidence does not hold is
  `partial`, never success.

  The destination guard moved from `@melra/browser-runtime` to
  `@melra/policy-core` so an API call and a page load share one implementation
  rather than one package holding the boundary and the other reimplementing it.
  Its four refusal reasons are renamed `browser_* -> destination_*`, and
  `browser_domain_not_allowed` in policy decisions is now
  `destination_domain_not_allowed`; the old symbols are still re-exported from
  `@melra/browser-runtime`. Redirects are deliberately not followed — a
  `Location` header points somewhere the destination check never saw — and the
  socket connects to the address that was checked, not to the name.

- **The plan now says how many times an effect may run.** Every contract carries
  an `executionGuarantee` — `read-only` for reads, `at-most-once` for mutations
  and destructive operations — and every receipt repeats it. The rule was
  already enforced, but it lived inside the controller, so a caller setting
  `budget.maxRetries: 3` on a write had no way to learn the number would be
  ignored. It is derived from the classified effect and never accepted from the
  caller, and the executor now asks the guarantee instead of re-deriving the
  rule, so the published promise and the retry loop cannot drift apart.

- **Every evidence item on a certificate now says how it is known.** A new
  `strength` field ranks each item `execution` (the adapter's own report) <
  `state` (the kernel re-read the target) < `independent` < `semantic`, so a
  caller reading a receipt can tell the actor's word from the world's answer
  instead of seeing one undifferentiated boolean. The level is derived from the
  predicate type by `evidenceStrength()` in `@melra/receipt-schema` and stamped
  in one place in the verifier — a caller cannot declare it, and an unrecognised
  predicate type reads as the weakest claim rather than inheriting a stronger
  one.

### Changed

- **`--unhinged` is now `--unsafe-local`.** The old name described a mood; the
  flag is an opt-out of the entire safety model. `--unhinged` still works and
  prints a deprecation line, because a flag people have in scripts that silently
  stops disabling guardrails is worse than a deprecated one. `MELRA_UNHINGED` is
  unchanged.

- `melra_capabilities` now derives its operation map from the protocol schemas,
  removing the hand-maintained discovery surface that could silently drift from
  the operations clients validate.

- A mistyped command now says where the answer is
  (`unknown command: docter. Run 'melra --help' for the command list.`) instead
  of naming the mistake and stopping. `melra init`'s usage line also matches its
  behaviour: `--client` is optional and defaults to `generic`.

## [0.3.0-alpha.10] - 2026-08-09

### Added

- **The released tarball is now tested on a machine that never built it.** CI
  building on Linux, macOS and Windows proves the source tree works; an end user
  installs a package. Every tag now runs an `installed` job on all three that
  pulls the just-published `@melra/cli` from the registry onto a runner holding
  nothing but the smoke script, runs `melra doctor`, and drives a real MCP stdio
  session to a `VERIFIED_SUCCESS` certificate. It asserts the version it reached
  against the tag, so a cached older build cannot pass for the new one.
  `pnpm registry:smoke` runs the same check against any installed `melra` via
  `MELRA_COMMAND`.

- **Agent independence is now a test rather than a claim.**
  `packages/server/test/agent-independence.test.ts` drives one effect through
  three deliberately mismatched clients sharing one data directory: a child
  process over stdio speaking the ordinary harness vocabulary (`write_file`,
  `approve`), a loopback HTTP server on a *second* runtime object speaking the
  kernel vocabulary (`melra_plan`, `melra_execute`), and the CLI, which speaks
  no MCP at all. It asserts that the same operation asked for two ways derives
  the same stored contract, that a mutation planned under the first harness is
  still held after that harness's process exits, still refuses a wrong approval
  phrase, and is finished by the second harness on the first's terms — and that
  the third client reads back the same receipt id and `VERIFIED_SUCCESS`
  certificate. Policy, durable state, approvals and receipts belong to the
  kernel, not to whichever client opened the session.

- **`melra conformance`, and published conformance levels.** A runtime that
  speaks these tools is asking to be trusted with real effects, and having the
  right tool names is not that claim. The new command is a black-box client: it
  connects over stdio or loopback HTTP (`--url`, `--token`), drives one probe
  effect through the whole pipeline, and reports the highest level it earned —
  L1 typed effects, L2 governed effects, L3 verified effects, defined in
  [docs/CONFORMANCE.md](docs/CONFORMANCE.md). Fourteen checks, including that
  two refused executions leave no file behind and that an approved mutation is
  only `verified_success` with passing evidence. It never reads the endpoint's
  disk — the probe is read back through the kernel — so a remote endpoint is
  checked the same way as a local one. `--level` is how a runtime claims a
  level: the exit code is non-zero when the endpoint falls short. Every report
  carries a `notProven` list naming what the level does not establish, starting
  with the bypass problem the suite cannot see from outside. `pnpm conformance`
  runs it from source.

## [0.3.0-alpha.9] - 2026-08-09

### Added

- **`melra serve --http --open`.** Opens the console once the server is
  listening, so the URL that carries the token does not have to be copied out of
  a terminal. It fails silently if the machine has no way to open a link — the
  URL is already on screen, and a server that refused to start over a missing
  desktop helper would be worse than one you click into.

- **A client can let itself in, and then its name is on every receipt.**
  `melra serve --http` now speaks OAuth 2.1 — RFC 7591 dynamic registration,
  RFC 8414 and RFC 9728 discovery, authorization code with PKCE S256 — so an
  MCP client that was never handed the startup token can register, ask a person
  to approve it in a browser, and get a bearer token of its own. A `401` carries
  `WWW-Authenticate: Bearer resource_metadata="…"`, which is what makes a client
  find the flow instead of simply reporting that it was refused.

  The point is attribution rather than convenience. An approved client becomes a
  `harness` principal named for what it registered as plus the first bytes of
  the id MELRA minted, and that principal is prepended to the delegation chain
  of every task, workflow node and harness-tool call it dispatches — outermost,
  because anything the client declares about itself sits inside what the
  transport established. So a receipt reads
  `harness:Claude Code#a91f4c02/subagent:reader` instead of `agent:local`, and
  two clients calling themselves the same thing stay apart. A session id is
  bound to the caller that opened it, so a leaked one cannot be used to act
  under another client's name.

  Off unless the server is on loopback, since approving something in a browser
  is only a boundary on the machine the browser is on, and off entirely with
  `MELRA_HTTP_OAUTH=0`. Tokens are stored as sha256 hashes in a mode-`0600`
  `oauth.json`; a code is single-use and stays burned after a failed
  redemption; redirect URIs must be loopback or a private scheme, so an
  authorization code cannot be delivered off the machine. `melra clients` lists
  who has been approved and `melra clients --revoke <id|all>` takes it back.

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
  [unhinged mode](docs/INSTALLATION.md#unsafe-local-mode).
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

[Unreleased]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.15...HEAD
[0.3.0-alpha.15]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.14...v0.3.0-alpha.15
[0.3.0-alpha.14]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.13...v0.3.0-alpha.14
[0.3.0-alpha.13]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.12...v0.3.0-alpha.13
[0.3.0-alpha.12]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.11...v0.3.0-alpha.12
[0.3.0-alpha.11]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.10...v0.3.0-alpha.11
[0.3.0-alpha.10]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.9...v0.3.0-alpha.10
[0.3.0-alpha.9]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.8...v0.3.0-alpha.9
[0.3.0-alpha.8]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.7...v0.3.0-alpha.8
[0.3.0-alpha.7]: https://github.com/XAGI-Lab/melra/compare/v0.3.0-alpha.6...v0.3.0-alpha.7
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
