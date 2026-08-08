# Capabilities and limits

This document describes `0.3.0-alpha.8`.

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
| `approve` | runs the task a phrase was issued for | is the approval |

A tool needing approval returns the phrase rather than failing; `approve` takes
that task id and phrase and runs the operation that was approved. A policy
denial comes back as a result with `status: "blocked"` and a reason.

## Durable workflows

Node types: `operation`, `approval`, `condition`, `parallel`, `bounded_loop`,
`checkpoint`, `compensation`, `human_input`, and `delegation`.

- Exact definitions and task payloads survive restart in encrypted envelopes.
- Each advance executes one deterministic ready wave.
- Workflow events and the current projection commit atomically.
- Interrupted reads may retry. Mutations reconcile only from independent file
  evidence or enter `recovery_required`.
- Definitions allow at most 500 nodes, 100 dependencies per node, 20 parallel
  branches, and 100 loop iterations.
- Competing advances for the same workflow are serialized inside one process.

Human-input, delegation, pause/resume commands, and cross-process leases are
not implemented.

## Operations

### Files

Actions: `list`, `read`, `stat`, `hash`, `write`, `move`, `delete`, `mkdir`.

- Paths are resolved inside one workspace root.
- Existing symlinks cannot escape that root.
- Reads and writes are size-bounded by local policy.
- Writes use a temporary sibling file followed by an atomic rename.
- Deletes are destructive and approval-gated.

### Terminal

Actions: `run`, `start`, `status`, `output`, `stop`.

- Commands are spawned directly, never through a shell.
- Shell interpreters, privilege escalation, and platform scripting shells are
  denied even if accidentally added to the normal allowlist.
- Command, arguments, working directory, environment, duration, and output are
  bounded.
- Background jobs are supervised only for the life of the server process.

Interactive pseudo-terminal sessions are not implemented in `0.3`.

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
- `tab_new` accepts an optional `url` and runs the same destination checks
  `navigate` does. Every tab action returns the renumbered tab list, because
  opening, switching, and closing all shift the indices.
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
- Resolves and checks the destination and every intercepted request.
- Blocks private, link-local, multicast, unspecified, and cloud-metadata
  addresses. Localhost is opt-in.
- Confines uploaded files to the workspace and downloaded files to the artifact
  directory.

Persistent login profiles, visual/OCR targeting, and deterministic replay are
not implemented in `0.3`. Captchas are detected and reported, never solved.

### Memory

Actions: `put`, `search`, `list`, `delete`, `clear`.

Scopes: `session`, `task`, `project`, `workspace`, `user`, `procedural`.

- Stored records include source, confidence, timestamps, and optional speaker,
  episode ID, and sequence metadata.
- Common API keys, bearer tokens, passwords, and GitHub tokens are redacted.
- Search is local and scoped with BM25-style lexical evidence, exact phrases,
  explicit speaker matching, bounded adjacent episode context, confidence,
  freshness, and bounded head diversity.
- Search ranks at most the 5,000 most recently updated in-scope candidates per
  query and returns at most 100 results.
- Records can expire or supersede older facts. Expired and superseded records
  are excluded by default.

Memory is not a password manager. Semantic embeddings, automatic
consolidation, and poisoning detection remain roadmap work.

### Computer

Actions: `capabilities`, `inspect`, `screenshot`, `click`, `move`, `drag`,
`type`, `key`, `scroll`.

- Capability discovery is read-only and reports the detected adapter and
  limitations.
- Screenshots return a bounded artifact path, byte size, and SHA-256.
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
  equivalent, so the Linux adapter reports `elements: false` and only
  coordinates work there.
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

OCR/vision fallback, focus verification, multi-display normalization,
per-monitor DPI compensation, and official task-benchmark evidence remain
roadmap work. Element targeting is unavailable on Linux/X11.

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

URL globs are anchored and schema-bounded. A completed action with unmet
required evidence returns `partial`, never `verified_success`.

`melra_execute` returns raw operation output directly to the connected client.
Durable task state and receipts keep only centrally redacted input and output;
file contents, browser text, terminal output, typed values, environment values,
URL queries, and common secret formats are not retained there.

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
  event stream, and the Community console.
- Packaged: source, portable Node artifact, Python SDK artifact, Docker image.
- Not supported in `0.3`: transports bound to a non-loopback interface, OAuth,
  per-client identity, multi-tenant hosting.
