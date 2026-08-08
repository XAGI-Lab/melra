# Roadmap

MELRA is an open-source **autonomy kernel**: the layer an agent asks to change
the world through. The LLM reasons, the harness manages the loop, MELRA owns the
effect lifecycle. Checked items are implemented on the current alpha branch;
they are not a promise of stable API compatibility.

Two kinds of work appear below, and the distinction is the point:

- **Kernel services** — type, classify, authorise, gate on approval, record
  durably, deduplicate, run under a budget, verify against evidence, receipt.
  Those nine are the guarantees, and they must hold no matter which agent is
  above or which adapter is below.
- **Reference effect adapters** — files, terminal, browser, computer, and later
  HTTP/API. Replaceable implementations that reach the world *through* the kernel
  services. An adapter that could skip them would not be an adapter.

Work that is not one of those nine jobs, or an adapter serving them, does not
belong on this roadmap — reasoning, planning, model selection, and semantic
memory stay with the model and the harness above.

## v0.1 — local execution alpha

### Runtime and protocol

- [x] Strict versioned task contracts, now exposed through an eleven-tool MCP surface.
- [x] Local stdio transport.
- [x] Persisted task state, budgets, cancellation, and bounded read retries.
- [x] Local allow/deny/confirm policy re-evaluated at execution.
- [x] Exact, expiring, task-scoped approvals.
- [x] Redacted action receipts and SHA-256 execution certificates.
- [x] Deterministic result, file, terminal, URL, and page verification.
- [x] Local SQLite task, receipt, certificate, and memory storage.
- [x] AES-256-GCM executable task payload persistence across restart.
- [x] Conservative recovery rules for interrupted reads and mutations.
- [x] Circuit breakers shared across related tasks.

### File, terminal, and browser

- [x] Root-confined file read, write, move, delete, stat, list, and hash.
- [x] Symlink escape protection and bounded file size.
- [x] Shell-free terminal commands with command and environment policy.
- [x] Foreground and supervised background process lifecycle.
- [x] Output limits, secret redaction, timeout, status, logs, and cancellation.
- [x] Isolated browser session and tab lifecycle.
- [x] Typed navigation, DOM inspection, forms, keyboard, scroll, and tabs.
- [x] Screenshots, uploads, downloads, and artifact hashing.
- [x] SSRF, cloud-metadata, redirect, and repeated DNS-address checks.
- [x] Resolver pinning or a browser proxy for complete DNS-rebinding defense.
- [x] Persistent opt-in browser profiles (`MELRA_BROWSER_PROFILE`).
- [x] Deterministic browser recording and replay. `MELRA_BROWSER_HAR_PATH`
  records the session with response bodies, and `MELRA_BROWSER_HAR_REPLAY`
  serves a later run from that archive with no socket opened; a request the
  archive lacks is aborted rather than fetched, so a replay cannot silently
  become a live run.
- [x] Opt-in Chrome DevTools Protocol attachment for shared benchmark sessions.

### Memory

- [x] Local account-free memory.
- [x] Session, task, project, workspace, user, and procedural scopes.
- [x] Provenance, confidence, search, listing, deletion, clear, and export.
- [x] Secret redaction before persistence.
- [x] Expiry and supersession chains.
- [x] Hybrid lexical ranking, freshness, confidence, and head diversity.
- [x] Explicit episode-order expansion and query-aware speaker matching.
- [x] Public LoCoMo objective-retrieval harness and result artifact.
- [x] Configurable retention policies and automatic compaction.

Three items sat here for a while that the feature test disqualifies, and leaving
them as promises was the wrong call:

- **Semantic embeddings and hybrid retrieval.** Embedding search exists to serve
  a model's fuzzy phrasing; deterministic software querying effect history asks
  exact and structured questions. The kernel ships the retrieval a caller can
  reason about without a model — lexical and phrase matching, freshness,
  provenance confidence, and head diversity — and a harness that wants vectors
  indexes what `memory search` and export already return.
- **Conflict resolution and consolidation.** Deciding which of two contradictory
  facts is true, or merging several into one, is judgement. The kernel gives the
  caller the mechanism instead: supersession chains record that one memory
  replaced another and every read path filters the superseded one out.
- **Prompt-injection and memory-poisoning classifiers.** A classifier is a model,
  and a probabilistic gate is the wrong shape for this boundary anyway. Poisoned
  memory in MELRA still has to become an effect request that passes policy,
  echoes an approval phrase, and satisfies declared evidence — none of which
  cares where the idea came from. Classifying text is the harness's job; refusing
  the effect is the kernel's.

### Developer experience and release

- [x] CLI doctor, init, serve, run, inspect, export, and policy test.
- [x] TypeScript and Python client SDKs.
- [x] Docker image and hardened Compose configuration.
- [x] Forty-two deterministic safety/execution scenarios plus eight durable
      crash, recovery, and concurrency scenarios.
- [x] Real MCP stdio, browser, container, and Python interoperability tests.
- [x] Linux, macOS, and Windows CI definitions.
- [x] CodeQL, dependency review, Dependabot, DCO, and secret protections.
- [x] Release workflow for checksums, SBOM, and signed provenance.
- [x] First tagged alpha release with multi-architecture container.
- [ ] Fresh-machine evidence on every supported platform.
- [ ] Independent security review.

## v0.2 — richer local agents

### Computer use

- [x] Computer-use capability contract inside the governed task surface.
- [x] Read-only platform and adapter capability discovery.
- [x] Governed screenshot, pointer, text, named-key, and scroll operations.
- [x] macOS native adapter with permission-aware capability reporting.
- [x] Linux/X11 adapter using detected screenshot tools and `xdotool`.
- [x] Accessibility-tree inspection and semantic element targeting. `inspect`
  lists the frontmost window's addressable elements with role, name, and pixel
  geometry on macOS and Windows, and an operation carrying
  `target: { role, name }` resolves against that list instead of a coordinate.
  X11 exposes no equivalent tree, so the Linux adapter reports
  `elements: false` rather than guessing.
- [x] Screenshot and OCR inspection fallback. Where the platform reports no
  accessibility tree, `inspect` takes a screenshot through the adapter and reads
  its words with `tesseract`, scaling each box from the captured image back onto
  the display so a Retina capture does not double every coordinate. It runs only
  when the tree came back empty — a tree states what a control *is*, a reading
  only what it looks like — and `capabilities.ocr` reports whether the host can
  do it at all.
- [x] Drag and window-management actions.
- [x] Active-window, display, focus, and secure-input safety checks. macOS
  refuses `type` and `key` while another process holds secure input, rather than
  reporting a success that typed into nothing.
- [x] Consequential-action approvals through the common policy gate.
- [x] Post-action desktop observation and task-specific verification. `inspect`
  returns observed fields a task can be held to with `result_equals`.
- [x] Windows input adapter.
- [x] Replayable computer-use safety evaluations. `ReplayComputerAdapter` runs
  the whole path — resolve, click, verify, receipt — against a desktop recorded
  to a file under `evals/scenarios/`, so the claims that a wrong-name target is
  refused, an ambiguous one is refused, and a successful click with failing
  evidence is `partial` are checkable on any machine instead of only on one with
  a mouse to take hold of.
- [ ] Official OSWorld-MCP subset with released traces and evaluator output.

### Browser and terminal expansion

- [x] Mutation-driven stable-DOM quiet-window with timeout evidence.
- [x] Visual targeting fallback with explicit confidence. An element read off
  a screenshot carries a `confidence`; one the platform reported carries none,
  so absent means "stated" rather than "certain". A reading below `0.3` is not
  reported, and one below `0.7` is reported by `inspect` but refused as a click
  target with `computer_target_confidence_too_low` — worth telling a caller
  about, not worth acting on.
- [x] Popup and multi-window policy (`policy.popups`).
- [x] Interactive terminal input (`interactive` + `send`). A real pseudo-TTY is
  still open: stdin is piped, so a program that checks `isatty` and refuses
  unless it owns a terminal is out of reach without a native PTY dependency.
- [x] Package-installation and network-effect classifiers.
- [x] Local fixed-wait versus condition-wait correctness/latency benchmark.
- [x] Pinned MiniWoB-125 development and WebArena-Verified Hard-30 harnesses.
- [ ] Completed representative BrowserGym reliability and token-cost result.

### Transport and identity

- [x] Local Streamable HTTP transport.
- [x] Local OAuth and client identity. A client that was never handed the
  startup token registers itself (RFC 7591), is approved by a person in a
  browser, and exchanges an authorization code for a bearer token under PKCE
  S256. What it buys is a name: the approved client is prepended to the
  delegation chain of every task it dispatches, so a receipt says which client
  asked rather than `agent:local`. Loopback only — a browser approval is a
  boundary on the machine the browser is on — and `MELRA_HTTP_OAUTH=0` turns it
  off, leaving the operator's token as the only way in.
- [x] Multi-client session isolation.
- [x] Optional desktop control surface — the console, and `melra serve --http
  --open` to land in it without copying a token out of a terminal. A packaged
  desktop binary was the shape originally imagined here and it buys almost
  nothing over that: the console is deliberately read-only, so a desktop app
  would be a viewer with an installer, a signing pipeline, and a per-platform
  release matrix behind it. The one thing it could add that a tab cannot is an
  operating-system notification when something is waiting on a person — which
  is worth building when approvals are answerable from an operator surface at
  all, and today they are answerable only where policy can see them, on the MCP
  and CLI paths.

## v0.3 — Durable Core Alpha

### Workflow runtime

- [x] Immutable versioned workflow definitions and bounded DAG validation.
- [x] Operation, approval, condition, parallel, bounded-loop, checkpoint,
      compensation, human-input, and delegation nodes.
- [x] Transactional workflow events, projections, snapshots, and monotonic
      aggregate sequences.
- [x] Encrypted exact workflow definitions with separately redacted status.
- [x] Restart-safe task and workflow continuation.
- [x] Read retry, independent file-mutation reconciliation, and explicit
      `recovery_required` uncertainty.
- [x] Workflow/node/request-bound idempotency keys and committed-attempt
      constraints.
- [x] In-process serialization of competing advances for one workflow.
- [x] Cross-process leases for multiple servers sharing one data directory.
- [x] Operator commands for pause, resume, and suspension.
- [x] Five workflow MCP tools and matching CLI, TypeScript, and Python methods.
- [x] Real child-process restart E2E with approval tamper and plaintext scans.
- [x] Immutable eight-scenario Durable Core evaluation manifest and raw JSONL
      evidence tooling.

### Remaining workflow work

- [ ] PostgreSQL event and projection provider — deliberately deferred to
      [P5](#p5--beyond-one-machine); SQLite is the local authority until there is
      a second machine to share state with.
- [x] HTTP API, event stream, and Community console.

## Kernel direction

The work below is ordered by what unblocks what, not by how interesting it is.
Nothing here adds reasoning to MELRA. One question decides whether a proposal
belongs at all: *would this feature still make sense if the effect request came
from ordinary deterministic software rather than an LLM?* If no, it belongs to
the harness above.

### The seventeen systems

Where each part of the kernel stands today. "Partial" means the guarantee holds
but not in the shape the protocol should eventually name.

| System | Status | Where it is |
|---|:--:|---|
| Effect protocol | ✓ | `EffectContract`, derived from the persisted task |
| Principal identity | partial | Declared and recorded, not authenticated ([P2](#p2--hard-capability-boundary)) |
| Delegation chain | ✓ | `identity.onBehalfOf`, stamped on every receipt |
| Capability engine | ✓ | Issued grants in `policy.capabilities`, checked before allowlists |
| Policy engine | ✓ | `@melra/policy-core`, re-evaluated at execution |
| Authorization | ✓ | Exact, expiring, task-scoped approval phrases |
| Credential broker | ✗ | Adapters use the ambient environment ([P4](#p4--credentials-and-api-effects)) |
| Durable effect runtime | ✓ | `@melra/runtime-core` over SQLite |
| Idempotency | ✓ | `idempotency_commits`, unique per committed attempt |
| Recovery engine | ✓ | Conservative rules plus explicit `recovery_required` |
| Verification framework | partial | Execution and state levels ship; independent and semantic do not ([P3](#p3--verification-framework)) |
| Evidence system | ✓ | Redacted receipts and SHA-256 certificates |
| Effect adapters | partial | Files, terminal, browser, computer; HTTP, database, cloud, SaaS pending ([P4](#p4--credentials-and-api-effects)) |
| Harness adapters | partial | Ordinary tool names over the same pipeline (`MELRA_HARNESS_TOOLS=1`); reference integrations pending ([P1](#p1--prove-agent-independence)) |
| Sandbox and boundary | ✗ | Developer mode only ([P2](#p2--hard-capability-boundary)) |
| Workflow engine | ✓ | Nine node types, events, projections, leases |
| Compatibility suite | ✗ | [P1](#p1--prove-agent-independence) |

### P0 — define the category

- [x] Position MELRA as an agent-independent autonomy kernel across README,
      architecture docs, and this roadmap.
- [x] State the responsibility boundary explicitly: the agent owns reasoning,
      MELRA owns effects.
- [x] Document the canonical effect lifecycle as one named sequence
      (`REQUEST → … → RECEIPT`) rather than prose scattered across docs.
- [x] **Effect Contract** as a first-class protocol concept: principal,
      capability, operation, target, effect, risk, traits, postconditions,
      idempotency identity, budget, policy decision, authorization, metadata.
      Derived from the persisted task and returned with every plan, so there is
      no second input path that could describe an effect differently from the
      one about to run.
- [x] **Principal identity** with an explicit delegation chain — organization →
      human → harness → agent → session → subagent. Optional on a request,
      defaulting to `agent:local`; every receipt carries the chain that asked.
      Declared, not authenticated — making a principal a fact rather than a
      claim is [P2](#p2--hard-capability-boundary).
- [x] **Capability model**: `policy.capabilities` grants naming capability and
      target patterns, allowed effects, holder, `validUntil`, and
      `policyVersion`. Empty means no narrowing; non-empty is a closed world
      checked before any allowlist.
- [ ] Usage-bounded and provider-shaped grants — `max_operations`, and
      (provider, effect, account, `amount_max`, `daily_max`) for effects that
      spend or commit something. Deferred to
      [P4](#p4--credentials-and-api-effects): metering a grant needs something
      to meter, and that arrives with the credential broker and API effects.

### P1 — prove agent independence

- [x] Harness adapters that make MELRA mostly invisible. A model should see
      `read_file`, `write_file`, `run_command`, `browser_click` — not
      `melra_plan`, `melra_execute`, and `melra_receipt` for every small
      operation. The adapter translates ordinary tool semantics into Effect
      Contracts and runs plan → approve → execute → verify → receipt
      underneath. The goal is boring infrastructure: install the adapter,
      configure policy, run the agent normally. Opt-in with
      `MELRA_HARNESS_TOOLS=1` so a client that only knows the kernel
      vocabulary sees the same eleven tools it always did.
- [ ] At least two reference integrations against different harnesses, with the
      same policy, durable state, and receipts surviving the swap. This is the
      claim that distinguishes a kernel from a server; it is not yet proven.
- [ ] Compatibility suite a harness can run to demonstrate it does not bypass
      the kernel, and a published conformance level a runtime can claim.

### P2 — hard capability boundary

The bypass problem is the honest gap in developer mode: a harness holding both
a MELRA terminal and an unrestricted native terminal makes MELRA optional, and
an optional boundary is not a trust boundary. Closing it means removing the
alternative, not asking the harness not to use it.

- [ ] Two deployment modes: developer mode (today's behaviour) and enforced
      mode, where the harness is sandboxed with no privileged secrets and no
      raw production shell, talking to MELRA over authenticated IPC.
- [ ] Use operating-system primitives rather than reinventing them: containers,
      separate OS users, filesystem ACLs, namespaces, network isolation,
      sandbox profiles, Unix sockets, service identities, capability tokens.
- [ ] Rename `--unhinged` to something boring and descriptive
      (`--unsafe-local`), keeping the current flag as a deprecated alias, and
      refuse it outright in enforced mode.

### P3 — verification framework

- [ ] Verification strength surfaced by name on every evidence item —
      **execution**, **state**, **independent**, **semantic** — so a caller can
      tell a re-read of the target from the adapter's own word.
- [ ] Independent-channel verification: confirm an effect through a different
      channel than the one that performed it (execute via `POST /refund`,
      verify via `GET /refund/:id`), rather than through the page or process
      that did the work.
- [ ] Pluggable verifiers — file, process, HTTP, database, browser, cloud,
      SaaS, webhook — behind one predicate interface.
- [ ] Semantic verification, labelled probabilistic everywhere it appears, and
      never the sole evidence for a destructive effect.

### P4 — credentials and API effects

- [ ] Credential broker: agents receive capabilities, not credentials. The
      kernel holds the secret and performs the effect, and refuses operations
      outside the delegated capability even when the credential could perform
      them. That is the difference between possessing credentials and
      possessing authority.
- [ ] HTTP/API effect adapter. A large share of serious autonomous work happens
      through APIs rather than mouse clicks, and an API effect needs the same
      nine guarantees as a file write.
- [ ] Declared per-effect execution guarantees — `at-most-once`,
      `at-least-once`, `provider-idempotent`, `reconciliation-required`,
      `compensatable`, `read-only` — stated rather than assumed.
- [ ] Reconciliation for effects whose provider cannot promise exactly-once.
- [ ] Compensation as a first-class saga across providers, not only within one
      workflow.

### P5 — beyond one machine

- [ ] PostgreSQL event and projection provider.
- [ ] Distributed workers without weakening local policy semantics.
- [ ] Fleet-level operator view across many kernels.

## v0.4 and later

- [ ] MELRA protocol published as an open specification: EffectRequest,
      Principal, Capability, PolicyDecision, Authorization, ExecutionState,
      VerificationContract, Evidence, Receipt, RecoveryState.
- [ ] Extension SDK and compatibility testkit.
- [ ] Sandboxed WASM or process-isolated third-party adapters.
- [ ] Additional SDKs selected by contributor and platform demand.
- [ ] Stable protocol, migration, and deprecation guarantees.

## Stable release gate

Before `1.0`, the project must have:

- clean installation evidence on supported Linux, macOS, and Windows versions;
- verified compatibility with documented MCP clients;
- passing conformance, safety, path-escape, terminal, browser, and memory suites;
- complete local deletion and export behavior;
- reproducible checksums, SBOMs, and signed provenance for every artifact;
- published limitations and upgrade guidance;
- independent security review with critical findings resolved.
