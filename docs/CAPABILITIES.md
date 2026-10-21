# Capabilities and limits

This document describes `0.3.0-alpha.14`.

## MCP tools

| Tool | Side effect | Approval |
|---|---:|---|
| `melra_capabilities` | none | no |
| `melra_plan` | stores a plan | no |
| `melra_execute` | depends on planned operation | scoped for mutations |
| `melra_task_status` | none | no |
| `melra_task_cancel` | cancels task | no |
| `melra_receipt` | none | no |
| `melra_workflow_plan` | stores a validated workflow | no |
| `melra_workflow_advance` | depends on ready workflow nodes | scoped per mutation |
| `melra_workflow_status` | none | no |
| `melra_workflow_cancel` | cancels nonterminal workflow work | no |
| `melra_workflow_control` | pauses, resumes, or suspends a run | no |

With `MELRA_HARNESS_TOOLS=1`, thirteen more appear alongside these, carrying the
names a harness already knows. Each builds an ordinary task and runs the same
pipeline, so the approval column below says exactly what it says above:

| Tool | Side effect | Approval |
|---|---:|---|
| `read_file`, `list_files` | none | no |
| `write_file`, `move_file`, `delete_file` | writes the workspace | scoped |
| `run_command` | runs one allowlisted executable | scoped |
| `browse`, `browser_click`, `browser_type` | drives the browser | scoped |
| `browser_read` | none | no |
| `remember` | stores one operational fact | scoped |
| `recall` | none | no |
| `approve` | runs a task held for approval | is the approval (developer mode); runs on an operator's (enforced mode) |

A tool needing approval returns the phrase rather than failing; `approve` takes
that task id and phrase and runs the operation that was approved. In enforced
mode no phrase is issued: an operator approves with `melra approve <task-id>`
or in [`melra console`](INSTALLATION.md#approving-in-a-browser), and `approve`
then takes the task id alone. A policy
denial comes back as a result with `status: "blocked"` and a reason.

## Durable workflows

Node types: `operation`, `approval`, `condition`, `parallel`, `bounded_loop`,
`checkpoint`, `compensation`, `human_input`, and `delegation`.

- Exact definitions and task payloads survive restart in encrypted envelopes.
- Each advance executes one deterministic ready wave.
- Workflow events and the current projection commit atomically.
- Interrupted reads may retry. Mutations are never silently repeated: they
  reconcile from independent evidence — a file re-read, or a declared
  `reconciliation` predicate asking the provider — or enter `recovery_required`.
- Compensations unwind newest effect first, one at a time, across as many
  providers as the saga touched. An unwind that cannot finish stops and reports
  `workflow_compensation_incomplete:<node>`. A failed step, or one denied
  before it runs, starts the unwind, unless another step's outcome is unknown:
  then the run halts as `recovery_required` until that step is settled by its
  `reconciliation`, and `workflow cancel` is the way out for a step that
  declares none. A denied compensation stops the unwind.
- Definitions allow at most 500 nodes, 100 dependencies per node, 20 parallel
  branches, and 100 loop iterations.
- A `semantic` predicate is refused in any node
  (`workflow_semantic_evidence_unsupported:<node>`) until a workflow can wait on a
  verdict.
- Competing advances for the same workflow are serialized inside one process,
  and across processes by an expiring SQLite lease.

## Operations

### Files

Actions: `list`, `read`, `stat`, `hash`, `write`, `move`, `delete`, `mkdir`.

- Paths are resolved inside one workspace root. `list` takes the root however
  it is spelled (`.`, `./`, its absolute path as configured or with its links
  resolved); no other action takes the root itself.
- An absolute path spelled through the root as configured, with a symlink or
  junction in it left unresolved (macOS's `/tmp`, a symlinked project
  directory), is read as the same path under the root as resolved when the
  server started, and then checked like any other. The same holds for a
  move's `destination`, file evidence, a terminal `cwd` and a browser
  upload's `filePaths`. The root is resolved once: a link in it re-pointed
  while the server runs takes effect after a restart.
- Existing symlinks cannot escape that root. A `write` to a symlink inside it
  writes the file it points to, as `read` reads it; one whose target does not
  exist is refused (`file_write_dangling_symlink`).
- Reads and writes are size-bounded by local policy.
- Writes use a temporary sibling file followed by an atomic rename.
- `encoding: "base64"` content must be base64 (line breaks, missing padding and
  the URL-safe alphabet allowed), or the write is refused before anything lands
  (`file_content_invalid_base64`).
- Deletes are destructive and approval-gated.

### Terminal

Actions: `run`, `start`, `status`, `output`, `stop`, `send`.

- Commands are spawned directly, never through a shell.
- A bare program name is found only through `PATH` entries outside the
  workspace, as written and through links. Entries inside it, and empty or
  relative ones, which name the working directory, are left out of the search
  and of the `PATH` the program itself sees. `--unsafe-local` keeps `PATH` as
  given.
- Shell interpreters, privilege escalation, and platform scripting shells are
  denied even if accidentally added to the normal allowlist.
- Command, arguments, working directory, environment, duration, and output are
  bounded.
- Only a read runs without approval. A read is a read-only program (`cat`,
  `head`, `rg`, `git status`/`log`/`diff`, listing `git branch`/`tag`,
  `npm ls`, ...) called with arguments that all keep it one: no option that
  runs a program, writes, or names another host, and no path-qualified command.
  Everything else is a mutation and needs approval; `melra policy test` shows
  how a command is classified.
- Background jobs are supervised only for the life of the server process.

A job started with `interactive: true` keeps stdin open, and `send` writes a line
to it ([commands that ask a question](INSTALLATION.md#commands-that-ask-a-question)).
Stdin is a pipe, not a pseudo-terminal: interactive PTY sessions are not
implemented in `0.3`.

### Browser

Actions: `navigate`, `back`, `forward`, `reload`, `inspect`, `wait`, `click`,
`type`, `fill_form`, `select`, `press`, `scroll`, `screenshot`, `upload`,
`download`, `tabs`, `tab_new`, `tab_switch`, `close`.

- Uses an isolated headless browser context.
- Prefers semantic targets (`role`, `name`, `text`) with optional selectors.
  `inspect` reports a `selector` for every element it lists, so a caller can act
  on what it just read; passing a `target` to `inspect` scopes it to that
  element's `text` and `html` instead of the whole page.
- Targets resolve across the page's frames, main document first, so a consent
  banner, cookie wall, payment field, or login form embedded in an iframe can be
  clicked and typed into without naming the frame. `inspect` lists elements from
  every frame and reports the owning frame URL (`null` for the main document),
  which explains why an element it lists is absent from the page text. At most
  20 frames are searched and 400 elements reported.
- A human-verification widget (reCAPTCHA, hCaptcha, Turnstile, Arkose) is
  reported by `inspect` as `captcha.present` with the vendor names. MELRA does
  not solve or bypass captchas; the report exists so a caller stops retrying and
  escalates instead of failing on an opaque timeout.
- History, tab, and `wait` actions are classified `read`: they move where the
  session is looking, or block until the page reaches a state, rather than
  acting on a document — so stepping back, switching tabs, or waiting does not
  cost an approval. Actions that drive the page (`click`, `type`, `fill_form`,
  `select`, `press`, `upload`, `download`) still do.
- `back` and `forward` report `moved`, which is false only at the end of the
  history stack. A move to an entry with no HTTP response (`about:blank`, a hash
  change) reports `moved: true` with a null `status`.
- Reads never return what was typed into a secret field (a password input, or
  one masked with CSS), in the element list or in a target's markup. While any
  frame holds a secret field with something in it, live or still in its markup,
  a read aimed at part of the page is refused
  (`browser_secret_field_filled`), since whether its target exists could be
  made to depend on the secret; an untargeted `inspect` still works. The page
  is asked again once the read has looked, and a field filled meanwhile voids
  what it found. A
  targeted read is also refused when some frame cannot answer
  (`browser_secret_check_unavailable`). A `wait` asks on each poll and looks
  for nothing while a field is filled or some frame cannot answer; it is
  refused only if its last poll still found a field filled, or could not tell. A frame with no document yet does
  not hold a read up, and the read does not search it. Such a read uses an
  element only when its own document is one the check read, however its target
  is written.
- On any action but `navigate` and `tab_new`, a `url` names the page the action
  acts on: the active page, or the tab `close` and `tab_switch` name. Policy
  shows it as the action's target and matches grants against it, so the runtime
  refuses the action, before sending anything, when that page is elsewhere
  (`browser_page_not_at_url`). It is compared as policy shows it, without query
  or fragment. An input action (`click`, `type`, `fill_form`, `select`,
  `press`, `upload`, `download`) is then held to the document this check read,
  and its target to the document it was found in, a frame's for a target in a
  frame: the input goes through that element, and the target is found again
  only in the same document if the page re-renders it, so a page or frame that
  navigates itself while the action waits, even to the same address, gets
  nothing, and the action is refused with `browser_page_changed`. The page and
  its address are checked again after the target is waited for, as the action
  would wait for it (visible, enabled and stable for a click), sending
  nothing, just before the input. Once the action has sent input, only its
  document is checked, before each of a form's fields and, while it types,
  whenever the page reports a new document, at the next key: a page may
  rewrite its own path as it is typed into. What this does not cover: a
  navigation that commits in the instant Playwright dispatches can still
  receive that one click or key; the address is not checked again during
  Playwright's own waits after the check (for a target found again after a
  re-render, or its hit-target retries), so a same-document path change then
  is not caught; keys go wherever the page has put focus, a frame inside it
  included; and the check reads the top-level page, not the content of its
  frames. `close` and
  `tab_switch` are checked when they start. In enforced mode these actions,
  `close` and `tab_switch` must name a `url` (`browser_action_requires_url`);
  for those two it names the tab, so `about:blank` and pages off the
  allowlist are accepted.
- A page carrying `<meta name="melra-approval-surface">`, which is how
  [`melra console`](INSTALLATION.md#approving-in-a-browser) serves its approval
  page, is sent no input: `click`, `type`, `fill_form`, `select`, `press`,
  `upload` and `download` on it are refused with
  `browser_refuses_approval_surface`, in every mode and whatever approved the
  action, a `url` naming the page included. So are the actions that could
  raise or move it under the operator's pointer: `scroll` on it, `tab_switch`
  onto its tab, and, in a browser the runtime is attached to over CDP, `close`
  of any tab and `tab_switch` to any while another marked page is open there,
  whatever the tab acted on carries (any page can carry the marker), since the
  browser then raises a neighbour, or the switched tab's split-view partner. In an attached browser, Playwright's focus emulation makes every
  page report itself visible and focused, so the page cannot see being raised.
  Other reads on it still work; moving it ends the console's pairing. In an
  attached browser, a page that does not answer within a second holds `close`
  and `tab_switch` of the others the same way, refused with
  `browser_approval_surface_check_unavailable` naming its tab, which can be
  closed itself unless another tab does not answer either. This
  matters when the runtime is attached over CDP to a browser the operator also
  uses. An input action is held to the document checked, with the same limits
  as the `url` check above.
- `tab_new` accepts an optional `url` and runs the same destination checks
  `navigate` does, before it opens the tab, so a refused destination opens
  none; a tab whose page then fails to load is closed again, so a retried
  `tab_new` leaves no tabs behind. Every tab action returns the renumbered tab
  list, because opening, switching, and closing all shift the indices. A tab
  whose page does not answer within a second (or the action's `timeoutMs`, if
  shorter), as a page stuck in a script does, is listed with `title: null`, so
  the listing itself never fails an action on another tab (an attached browser
  still refuses `close` and `tab_switch` while a tab does not answer, as above).
- `wait` takes exactly one condition: a `target` reaching a `state`
  (`visible`, `hidden`, `attached`, `detached`), a `urlContains` substring, or a
  `value` substring of the page text. It is the supported way to handle a slow
  redirect or a late-rendering panel — raising `settleTimeoutMs` is not. A
  `target` wait re-resolves across every frame on each poll, so it also covers a
  frame that only attaches after the wait starts. `visible` and `attached` are
  met by any one frame; `hidden` and `detached` must hold in all of them.
- `type` presses keys rather than assigning the value, so widgets that listen
  for keystrokes (autocomplete, comboboxes, inputs that enable a submit on
  `keyup`) receive the typing. `delayMs` slows it for anything that debounces;
  `clearFirst` (default true) empties the field first, and `false` appends.
- `fill_form` fills a list of `fields` and, when the operation carries a
  `target`, clicks it to submit — one plan, one approval, one settle for a whole
  form instead of one per field.
- `scroll` takes `pixels` for `up`/`down` and returns the resulting `scrollY`,
  so a caller paging through a document can tell when it has reached the bottom.
- A `confirm()`, `alert()`, `prompt()`, or `beforeunload` dialog raised by an
  action is accepted and reported on the result as `dialogs[]`, each with its
  `type` and `message`. The action that raised the dialog was already approved,
  so answering it is part of that action; the report is what keeps it honest,
  because a caller is never told a page changed without also being told what it
  was asked. The field is absent when nothing was raised.
- Every call to the page is bounded: by the action's `timeoutMs`, the
  post-action settle by `settleTimeoutMs` plus one second, saving a download
  (which takes as long as the file does) by nothing else, and all of them by
  the task's cancel signal and budget. A page that stops answering fails the
  action with `browser_call_timeout:<call>` rather than hanging. A read that
  times out is a plain, retryable failure; a mutation that fails after its
  input was sent is reported as an unknown outcome (`recovery_required`),
  because the page may already have acted.
- Resolves and checks the destination and every intercepted request.
- Blocks private, link-local, multicast, unspecified, and cloud-metadata
  addresses. Localhost is open in developer mode and opt-in in enforced
  mode (`allowLocalhost`).
- Confines uploaded files to the workspace, never MELRA's own data directory
  except its artifacts, nor the browser profile, an HTTP archive or a
  credential's file, and downloaded files to the artifact directory.

- `MELRA_BROWSER_PROFILE` names a directory to keep, so a site logged into once
  stays logged in across runs. Unset, every run gets a throwaway profile.
- `MELRA_BROWSER_HAR_PATH` records the session as an HTTP archive, response
  bodies included, and `MELRA_BROWSER_HAR_REPLAY` serves a later run entirely
  from that file. A replayed run opens no sockets, so a request the archive does
  not contain is aborted rather than fetched — a rerun cannot quietly become a
  live one. The two cannot be combined, and neither works against a browser
  attached over CDP.

Captchas are detected and reported, never solved.

### Memory

Actions: `put`, `search`, `list`, `delete`, `clear`.

Scopes: `session`, `task`, `project`, `workspace`, `user`, `procedural`.

- Stored records include source, confidence, timestamps, and optional speaker,
  episode ID, and sequence metadata.
- PEM and PGP private keys, AWS access key IDs, JWTs, Slack, GitHub and npm
  tokens, common API keys, authorization headers, URL credentials, and
  password, secret, token and API-key assignments are redacted — the same
  `SECRET_PATTERNS` list receipts and terminal output use.
- Search is local and scoped with BM25-style lexical evidence, exact phrases,
  explicit speaker matching, bounded adjacent episode context, confidence,
  freshness, and bounded head diversity.
- Search ranks at most the 5,000 most recently updated in-scope candidates per
  query and returns at most 100 results.
- Records can expire or supersede older facts. Expired and superseded records
  are excluded by default.

Memory is not a password manager. Semantic embeddings, automatic
consolidation, and poisoning classifiers are deliberately left to the harness
above; the [roadmap](../ROADMAP.md#memory) says why.

### Computer

Actions: `capabilities`, `inspect`, `screenshot`, `click`, `move`, `drag`,
`type`, `key`, `scroll`.

- Capability discovery is read-only and reports the detected adapter and
  limitations.
- Screenshots return a bounded artifact path, byte size, and SHA-256.
  Artifacts sit in MELRA's data directory, so where a workspace reaches them
  the file adapter, file verification and the browser may read them, and
  nothing may change them.
- Input actions are high-risk mutations requiring evidence and exact scoped
  approval.
- Coordinates name normalized or pixel space; key input uses a fixed allowlist.
- `inspect` lists the frontmost window's addressable elements — role, name, and
  pixel geometry, at most 200 — where the platform exposes an accessibility
  tree, and `capabilities.elements` says whether it does. `click`, `move`, and
  `drag` accept `target: { role, name }` instead of coordinates and resolve it
  against that list, clicking the element's centre. A name that matches nothing
  fails `computer_target_not_found` and one that matches several fails
  `computer_target_ambiguous` with the candidates — neither guesses. The
  resolved element is returned on the result, so `result_equals` on
  `element.name` verifies what was hit rather than what was asked for.
  Supplying both `target` and coordinates is rejected.
- macOS reads the tree through System Events, four levels deep, and needs
  Accessibility permission; Windows reads it through UI Automation. X11 has no
  equivalent, so the Linux adapter reports `elements: false`.
- Where no tree came back, `inspect` reads the screen instead: it takes a
  screenshot through the adapter and runs `tesseract` over it, scaling each word
  from the captured image onto the display so a Retina capture does not double
  every coordinate. `capabilities.ocr` says whether the host has `tesseract` at
  its usual install paths (or, for a library embedder, whether a program was
  named with `ComputerRuntimeOptions.ocrProgram` and screenshots work), and the read only ever runs when the tree was empty — a tree states what
  a control *is*, a reading only what it looks like. The screenshot is deleted
  once it has been read. A read that fails (no screen-recording permission, a
  Wayland session) leaves `inspect` as it is without `tesseract`, with no
  `elements`; a `target`, which has nothing to fall back on, is refused with
  the reason the read failed.
- A word read this way carries a `confidence` between 0 and 1; an element the
  platform reported carries none, so an absent `confidence` means "stated", not
  "certain". Below `0.3` a word is not reported; below `0.7` it is reported but
  refused as a target with `computer_target_confidence_too_low`. Only text is
  found this way, so an unlabelled icon stays unreachable on a desktop with no
  tree.
- macOS requires Screen Recording or Accessibility permission. Linux input
  currently requires X11 and `xdotool`. Windows uses Windows PowerShell and
  .NET, which ship with the OS, so it needs no extra install; input goes to
  whichever window holds focus, and cannot reach an elevated window unless the
  server is elevated too. Normalized coordinates span the whole virtual desktop
  on Windows and the main display elsewhere.
- Every Windows action pays PowerShell startup, and pointer/scroll additionally
  compile a small P/Invoke shim, because .NET exposes no cursor or wheel API.
  That cost is per-process, so `timeoutMs` may need raising above its 10s
  default on a slow or loaded machine; `capabilities` reports this too.

Focus verification, multi-display normalization, per-monitor DPI compensation,
and official task-benchmark evidence remain roadmap work.

### HTTP

Action: `request`. Fields: `method`, `url`, `headers`, `content`,
`idempotencyKey`, `spend`, `maxResponseBytes`, `timeoutMs`.

- `GET` and `HEAD` classify as reads. Every other method is a mutation: it needs
  declared evidence and an exact scoped approval, and it runs at most once —
  `budget.maxRetries` does not apply to it.
- The destination goes through the same checks and the same `allowedDomains`
  allowlist a browser navigation does, and the socket then connects to the
  address that was checked rather than resolving the name a second time.
- Redirects are not followed. A `Location` header points somewhere the
  destination check never saw, so the status and headers come back and the
  caller can plan a second governed request.
- `success` on the result is true only for a 2xx. It is the far end's own word,
  which is why a mutation must still declare what would count: a completed call
  whose evidence does not hold is `partial`.
- `idempotencyKey` is sent as `Idempotency-Key` for providers that honour it.
  MELRA cannot check that they do, so it does not change the guarantee.
- Response bodies are capped by `maxResponseBytes` (1 MiB by default); a body
  past the cap stops being read: the result carries the body up to the cap,
  `bytes` counts what was delivered, and it reports `truncated: true`.
- The request payload travels as `content`, which redaction strips before
  anything is persisted. Raw bytes reach the live caller only.
- Credentials the operator configured under `policy.credentials` are injected at
  send time when both the destination and the operation are covered — see
  [INSTALLATION.md](INSTALLATION.md#credentials). The result reports which ones
  by name under `credentials`, never their values, and a caller-supplied header
  cannot shadow one. A value the far end echoes back in the reason phrase, a
  header or the body is replaced with `[REDACTED_CREDENTIAL]` and listed under
  `redactions`; `bytes` still counts what arrived. A body cut at the size cap
  on such a call always ends in the marker in place of its last few
  characters, whatever they held, and lists it too.
- `spend` declares what the call moves — `{ provider, account?, amount, currency }`,
  the amount in minor units. It is optional and means nothing until a grant with
  a `provider` block exists; from then on that grant covers declared spends only.
  See [Identity and capability grants](#identity-and-capability-grants).

Request signing, retries with backoff, and streaming responses are not
implemented.

### System

Action: `info`. Returns local runtime capability information without mutation.

## Verification predicates

| Predicate | Checks |
|---|---|
| `result_equals` | exact scalar at a result path |
| `result_contains` | string or serialized-result containment |
| `file_exists` | root-confined filesystem existence |
| `file_absent` | root-confined filesystem absence |
| `file_hash` | exact SHA-256 |
| `exit_code` | terminal process exit code |
| `url_matches` | anchored URL glob (`*` wildcard) |
| `page_contains` | inspected page text |
| `http_resource_matches` | a second `GET`/`HEAD` against the provider's own state |
| `custom` | a verifier the operator registered with the runtime, by name, with flat scalar `params`; strength is always `execution` |
| `semantic` | a yes/no `question` about meaning, with `artifacts` naming result paths, for a judge outside MELRA; strength is always `semantic`; nothing answers it in this release |

URL globs are anchored and schema-bounded. A completed action with unmet
required evidence returns `partial`, never `verified_success`; one whose only
unmet evidence is a `semantic` question waits in `waiting_user` instead (below).
A `file_*` path that can only land outside the workspace or on its root is
refused at planning (`evidence_path_outside_workspace`), since the verifier
would refuse it every time it was asked.

`custom` is for effects no built-in can confirm, such as a database row or a
ticket in some SaaS. The verifier is code passed to `createMelraRuntime` as
`evidenceVerifiers`, never configuration; `melra_capabilities` lists the
registered names under `customEvidence`, and planning refuses any other name
(`evidence_verifier_unavailable`) before anything can be approved. A `custom`
predicate cannot name a built-in, and its evidence is stamped
`custom:<name>` at the weakest strength, whatever the verifier returns.

`semantic` asks a question MELRA never answers, because the kernel runs no
model (#54). Once the effect has run and every other predicate has held, the
task waits in `waiting_user`, its `judgements` naming each question and when it
expires: the approval TTL (`approvalTtlMs`). Nothing can answer one yet, so at
expiry the task settles closed: `recovery_required` for a change, whose effect
did happen, and `partial` for a read, with the error
`semantic_judgement_expired`. A task with a failing predicate beside it is
`partial` without waiting. A destructive effect whose evidence has a `semantic`
predicate but nothing the kernel re-reads (`file_exists`, `file_absent`,
`file_hash`) or asks another channel (`http_resource_matches`) is refused at
planning (`semantic_only_destructive`). A task cannot declare `semantic`
beside `reconciliation` (`semantic_evidence_not_reconcilable`), and a workflow
cannot declare it in any node (`workflow_semantic_evidence_unsupported:<node>`). The
question is stored and shown as written, minus secret shapes.

`http_resource_matches` is the only predicate whose answer does not come from
the channel that acted. `POST /refunds` returning `201` is the client that made
the call reporting on itself; `GET /refunds/rf_1` is the provider. Because the
id is only known afterwards, the URL is completed from the recorded result —
`{{json.id}}` reads the parsed response body, `{{status}}` the status — and each
spliced value is percent-encoded, so a response field cannot rewrite the path.
The verification request is an effect like any other: same adapter, same
destination boundary, same allowlist, same credential scope. `GET` and `HEAD`
only, and a runtime with no HTTP channel fails the predicate rather than passing
it. It is the only predicate carrying `strength: "independent"`.

A task request carries a second predicate list, `reconciliation`, drawn from the
same schema but asked only when a mutation's outcome is unknown — the request
reached the wire and no reply came back. Nothing runs again: the predicates ask
the provider what its state is, `{{idempotencyKey}}` splices the request's own
key into the URL, and the answer settles the task as `verified_success` or
`failed`. A provider that cannot be reached leaves the task `recovery_required`
rather than guessing either way, and a request that declared no reconciliation
predicates stays parked for a human.

`melra_execute` returns raw operation output directly to the connected client.
Durable task state, receipts and certificates keep only centrally redacted
input, output and evidence; file contents, browser text, terminal output, typed
values, environment values, URL queries and userinfo, and common secret formats
are not retained there. An `http_resource_matches` item names the URL it read
without its query or userinfo; the request itself goes out as declared.

Free-form task constraints fail closed because they cannot be enforced
deterministically. `forbiddenEffects` accepts only `read`, `mutate`, and
`destructive` and is enforced during planning and again during execution.

## Identity and capability grants

A request may declare `identity: { principal, onBehalfOf }` — the immediate
caller plus the delegation chain behind it, outermost first. A request that
declares none is the local principal, `agent:local`. The chain is recorded on the
task and on every receipt, so a receipt answers who authorised an effect rather
than only what ran. MELRA does not authenticate any of it: each link is a claim
the layer above makes and is worth what that layer's own boundary is worth.

`policy.capabilities` issues bounded authority — a capability pattern, the
effects allowed under it, a target pattern, the holder, and optional `validUntil`
and `policyVersion`. The list is empty by default and changes nothing when it is.
A non-empty list is a closed world: an effect with no matching grant is denied
`capability_not_granted` before any allowlist is consulted. See
docs/INSTALLATION.md for the file format.

A file target is matched as the file runtime will resolve it, so `docs/../.env`
is `.env` and falls outside a `docs/*` grant, and a move needs its destination
granted as well as its source. Matching is on the path, not on what it resolves
to on disk: a symlink inside a granted directory reaches wherever it points.

`validUntil` bounds a window; two optional fields bound what happens inside it.

- `maxOperations` is how many times the grant may ever be spent. The count is
  durable, so a restart does not refill it.
- `provider: { name, account?, amountMax?, dailyMax? }` bounds money. `amountMax`
  caps one call, `dailyMax` the declared amounts committed in the last 24 hours.

A grant is drawn down at one point only: where a task whose every kernel check
held commits its idempotency key, either a verified task or one waiting on a
semantic judgement, whose effect ran. An operation that was refused, failed a
check, was cancelled, or collapsed into a duplicate costs nothing.

Money bounds need the caller to say what the call moves, because MELRA cannot
read an amount out of an arbitrary provider's payload. That direction is what
makes taking its word safe: a grant carrying a `provider` block covers *only*
operations that declare a matching `spend`, so understating is a lie the grant
does not cover and omitting it means no grant matches at all
(`capability_spend_not_declared`). `name` and `account` compare exactly, not as
patterns — `stripe` and `stripe-test` are different providers.

A grant list is a set of authorities rather than one budget: a grant that is
spent out does not refuse work another still covers. A metered grant evaluated
where nothing can count it is refused (`capability_usage_unmeterable`) — a bound
nobody can evaluate must not become the loosest one. `melra_capabilities`
publishes how many issued grants are metered, so a caller planning a batch knows
some of its authority is finite.

`melra_plan` returns the effect contract beside the task record — identity,
capability, operation, effect, risk, target, traits, postconditions, budget,
idempotency key, policy decision, and authorization in one object. It is derived
from the persisted task and cannot be supplied.

## Task budgets

Every request has:

- `maxSteps`: reserved for bounded composition and currently limited by schema;
- `maxDurationMs`: authoritative wall-clock execution budget;
- `maxRetries`: retry count for read-only operations.

Mutations and destructive operations have one execution attempt.

## Transport and deployment

- Supported: local stdio, and loopback Streamable HTTP (`melra serve --http`)
  guarded by a bearer token, alongside a read-only JSON API, an SSE workflow
  event stream, and the Community console. `melra serve --socket <path>` serves
  the same surface on a mode-`0600` Unix socket, token still required, OAuth
  off; not on Windows.
- Supported over loopback HTTP: OAuth 2.1 client registration, browser approval,
  and per-client identity — an approved client is named at the head of the
  delegation chain on every receipt. `MELRA_HTTP_OAUTH=0` turns it off.
- `melra console`: an operator's approval console, a separate loopback HTTP
  server with no MCP endpoint, paired with the first page to use its one-time
  code, normally the browser tab it opens. It
  needs a terminal (`console_needs_a_terminal`) and a browser opener
  (`console_needs_a_browser`), and is never served on a socket or off loopback
  (`approval_console_loopback_only`).
- Packaged: source, portable Node artifact, Python SDK artifact, Docker image.
- Not supported in `0.3`: transports bound to a non-loopback interface,
  multi-tenant hosting.
