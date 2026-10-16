# Threat model

Status: reviewed for `0.3.0-alpha.12`; independent review pending.

## Assets

- user files and approved workspace changes;
- process environment and local credentials;
- browser sessions and downloaded artifacts;
- local memory, tasks, workflows, encrypted payloads, events, receipts, and
  certificates;
- release artifacts and the update channel.

## Trust boundaries

- MCP client to strict request schemas;
- planned operation to local policy;
- scoped approval to execution;
- runtime adapter to operating system or network;
- observed result to deterministic verifier;
- redacted structured evidence to SQLite;
- source commit to released artifact.

The MCP client and task content are potentially hostile. The host operating
system and the configured local policy are trusted. MELRA is not a security
boundary against a fully compromised host.

**Unsafe-local mode is outside this threat model.** `--unsafe-local` /
`MELRA_UNHINGED=1` removes the policy, approval, confinement, and
network-destination boundaries listed above, which means the "potentially
hostile MCP client" assumption no longer holds: a hostile client in that mode
has the full authority of the OS user. Nothing in this document applies to a
process running unsafe-local. See
[unsafe-local mode](INSTALLATION.md#unsafe-local-mode).

**The bypass assumption, and how enforced mode changes it.** Everything below
assumes the harness reaches these systems *through* MELRA. In developer mode that
is an assumption, not a control: a harness holding a native terminal as well
makes the kernel optional. `MELRA_MODE=enforced` is the operator asserting the
alternative has been removed, and MELRA cannot verify that from inside its own
process — the isolation is the host's, brought as a container, a separate OS
user, or a sandbox profile. What enforced mode contributes is closing every door
MELRA itself owns: it refuses to start with `--unsafe-local`, refuses any bind
outside loopback, serves no client-registration endpoint, and stamps `mode` on
every receipt so an auditor need not infer which deployment produced an effect.
Loopback still admits every process on the machine up to the token; a
[Unix socket](INSTALLATION.md#over-a-unix-socket) created mode `0600` narrows
that to the OS user running MELRA, which is the IPC a sandboxed harness should
be given.
The residual risk is the assertion itself. See
[deployment modes](INSTALLATION.md#deployment-modes).

## Threats and controls

| Threat | Current control | Residual risk |
|---|---|---|
| Prompt-driven destructive action | effect classification, required evidence, exact scoped approval | user may approve a misleading but accurately displayed operation |
| Argument or schema smuggling | strict schemas reject unknown fields | semantic intent can still be ambiguous |
| Unbounded retries | read-only retry budget; one attempt for mutations | independent tasks can repeat the same request |
| Duplicate workflow advance | process-local per-workflow serialization, an expiring cross-process SQLite lease, state-version compare-and-swap, idempotency commit | a process that dies mid-advance holds its lease until it expires, so other processes wait rather than proceed |
| Crash after an adapter effect | independent file re-observation or explicit `recovery_required` | non-filesystem mutations may require operator reconciliation |
| False completion | explicit predicates and `partial` status | a weak caller-chosen predicate may prove too little |
| Path traversal | lexical and realpath confinement; symlink tests; terminal arguments: every path an argument or option value names is followed through links and refused if it is, is inside, or holds MELRA's data (by identity, every mode; `ls`, `where` and `pwd` print names, so only naming the files refuses them), and enforced mode refuses one spelled inside that leads out | host race conditions outside the configured workspace model; in developer mode, a recursive reader given no path when the workspace holds the data directory (`melra doctor` warns of that layout); an approved `rg -L` |
| Shell injection | direct process spawn; shell and privilege commands denied; the file capability never writes into a git directory, so a program named in a repository's config, attributes or hooks is one a person approved; a `git` read is also spawned with system and global config nulled and fsmonitor, hooks, signature verifiers, fetching of missing objects, external diff and textconv off | an allowed executable can interpret dangerous arguments; interpreters and approved programs can read files their arguments do not name; developer mode reads outside the workspace without approval; external diff and textconv are consequently not applied to git reads MELRA runs |
| Process escape | cwd confinement, environment allowlist, time/output bounds | processes are not OS-sandboxed outside the container profile |
| SSRF and metadata access | URL validation, DNS resolution, per-request interception | malicious public endpoints remain reachable when domains allow them |
| DNS rebinding | the checked answer is pinned: requests go through a loopback proxy that connects to the address validation accepted | an attached CDP browser and unsafe-local mode resolve names themselves, so the window stays open there |
| Redirects in an attached browser | with an attached CDP browser there is no pinning proxy and Chromium follows redirect hops unseen, so a page or frame whose final address the guard refuses is blanked and never read back, and WebSockets are checked | the redirected request itself still reaches that address; use an owned browser where that matters |
| Malicious downloads/uploads | path confinement and artifact hashes | file content is not malware-scanned |
| Unintended computer input | typed actions, named-key allowlist, high-risk approval | focus can change between approval and action |
| Desktop observation leakage | local-only screenshot artifact with explicit invocation | screenshots may contain sensitive on-screen data |
| Secret persistence | executable payload encryption plus redacted projections, events, receipts, and logs | novel secret formats may not match redaction patterns; key loss is unrecoverable |
| Memory poisoning | explicit mutation approval, scopes, provenance | no content-level poisoning classifier; classifying text is left to the harness, and a poisoned memory still has to pass policy, approval, and evidence to become an effect |
| Receipt tampering | canonical digests and task-linked certificate | receipts and projections are not encrypted or externally signed |
| A local process taking the HTTP surface | bearer token compared in constant time, loopback binding, read-only JSON API; or `--socket`, a mode-`0600` Unix socket the kernel closes to every other OS user, with the token still required | a loopback port is reachable by every local process, so there the token is the only barrier; on either transport, anything running as the same OS user (or root) can connect and read the token from the process that holds it; no socket transport on Windows |
| A client granting itself HTTP access | registration grants nothing; approving takes the operator's token, entered on a consent page that cannot be framed; the sign-in routes answer only loopback names, so a rebound page cannot reach them; PKCE S256 binds the code, loopback-or-private redirect URIs keep the code on the machine, codes are single-use | approval is a human judgement about a name the client chose for itself; anything that can read the token can approve |
| An approved client acting as another | the issued token names one client, and an MCP session id is bound to the caller that opened it | every principal a request declares beneath the authenticated one is still a claim |
| Payload substitution | AES-256-GCM with identity/purpose-bound additional data | host compromise can read the key and database |
| Dependency compromise | lockfiles, dependency review, CodeQL, SBOM | upstream compromise before detection remains possible |
| Release substitution | checksums and signed GitHub/Sigstore provenance | trust still depends on GitHub identity and workflow protection |

## Approval properties

An approval challenge contains a random approval ID, the task ID, a digest of
the exact operation, and an expiration time. Whether it also carries a phrase,
and what lets the mutation run, depends on the
[deployment mode](INSTALLATION.md#deployment-modes):

| | Developer mode | Enforced mode |
|---|---|---|
| Phrase in the challenge | yes: `APPROVE` plus the first 12 hex digits of the action digest | none |
| What lets a mutation run | the phrase echoed to `melra_execute`, or a decision recorded with [`melra approve`](INSTALLATION.md#approving-from-the-command-line) or [`melra console`](INSTALLATION.md#approving-in-a-browser) | only an operator's decision recorded by a process in enforced mode (`melra approve`, `melra console`, or `melra run`'s prompt in a terminal) |
| An approval the agent sends | checked against the phrase | refused (`approval_in_band_refused`), even when an operator has already decided |
| No usable decision yet | `approval_required` | `approval_awaiting_operator`, or `approval_expired` once the challenge has expired |
| Channel on the receipt | `in_band` | `out_of_band` |
| Residual risk | anyone who knows the task can compute the phrase, so an echo shows only that something echoed it | anyone with OS access to the data directory can run `melra approve` or `melra console`, or write `melra.sqlite` directly, which is an operator only if the agent has no such access; see [the approval console](#the-approval-console) for that path's own residuals |

Approvals cannot be reused for a different task or operation. Policy is
re-evaluated after approval and immediately before execution.

### The approval console

`melra console` is an operator path beside `melra approve`, with the same
authority. It is a separate process: a loopback server with no MCP endpoint and
no client registration, which refuses to start without a terminal and never
prints its pairing code. It pairs once, with the tab it opened, and that page
holds its session in memory only; a decision is a JSON POST from the console's
own origin, bound to the task and the digest of the screen shown. MELRA's
browser runtime refuses every action that sends the console page input
(`browser_refuses_approval_surface`), in every mode, and each action of its
own that could raise or move the page under the operator's pointer:
`tab_switch` onto its tab, `scroll` on it, and, in a browser it is attached
to, `close` of any other tab while a console is open there, since the browser
then raises a neighbour. Its
other reads can still move the page (navigate, back, forward), but the page
takes the task it approves from the operator's clicks, never from its URL, and
any move of its URL, or leaving it, ends the pairing on both sides: the page
hands its session back and the console refuses it after. On its own side,
Approve and Deny ignore clicks until the page has been visible, focused and
unscrolled for a second, as a browser holds back a permission prompt's
buttons. In a browser MELRA's runtime is attached to, that hold sees less:
Playwright's focus emulation makes every page there report itself visible and
focused, so the console cannot see being raised, and its hold restarts only
on scrolling and resizing. There the runtime's refusals above are what keep
it from raising the console. The server an agent
connects to has no approval route, and no MELRA operation that runs without
approval can produce a console approval. That is the claim; it is not a claim
that the agent cannot approve. What remains:

- **Same-user writes.** Anything running as the operator's OS user against the
  data directory can approve with `melra approve --yes`, which needs no
  terminal, or write `melra.sqlite` directly. Both were true before the console
  and still are.
- **Computer actions as a confused deputy.** MELRA cannot tell which page a
  `computer.click` or `computer.type` lands on. Approving one approves whatever
  is on screen when it runs, the console's Approve button included.
- **A pairing race.** Until the page spends it, the code is on the browser
  opener's command line, in browser history, and, in a browser the agent's
  runtime is attached to over CDP, in a `tabs` read. Whatever reads it there
  can pair first, and use that session from any HTTP client (the `Origin`
  check binds browsers only) to approve whatever is pending until the console
  stops. The operator sees that: their tab says another tab already paired,
  and the terminal prints a pairing time they did not cause, which is the cue
  to stop the console. Who can read the code decides what that costs. A tab
  the agent's browser paired gets no input from that runtime. An
  unsandboxed process of the operator's own user could already run
  `melra approve --yes`. But another OS user, or a sandboxed process that can
  list processes without reaching the data directory, can read the opener's
  command line (`ps`, `/proc/<pid>/cmdline`) and race the pairing for an
  approval it could not make otherwise. A spent code is worthless.
- **A click after the console comes forward.** The second's hold stops a click
  already on its way when the page is raised, refocused or scrolled, but in a
  browser MELRA's runtime is attached to it sees only scrolling and resizing.
  Something other than MELRA's runtime that raises the console there (the
  operator, the OS, another CDP client) is not held, and anywhere, a click
  made later than the hold lands on whatever is under the pointer then, the
  console's buttons included, if the operator did not notice it come
  forward.
- **Same-user memory reads.** A process that can read the console's memory or
  the browser's (a debugger, `ptrace`) can take the session.
- **Social engineering.** An agent can ask the operator to approve something in
  the console. The console shows what the effect is, and a misleading but
  accurately displayed operation can still be approved.
- **A harness that gives the agent a terminal** breaks enforced mode's premise,
  whatever the console does: that terminal can run `melra approve --yes`.

## Network policy

Browser requests reject:

- loopback unless explicitly enabled;
- private, link-local, multicast, and unspecified addresses;
- cloud metadata endpoints;
- hostnames resolving to a disallowed address;
- redirects and subresources that cross the same checks.

The HTTP adapter applies the same destination checks, connects to the
address it checked, and does not follow redirects.

A domain allowlist controls intended public destinations. Wildcard domain
access is convenient for local experimentation but should be replaced with
specific domains in reviewed policies.

## Non-goals for `0.3`

- protecting against a compromised operating system or browser binary;
- deterministic proof from model judgment;
- arbitrary native extensions;
- malware scanning;
- encrypted credential storage;
- remote multi-tenant execution;
- protecting computer input from a malicious accessibility service or
  compromised desktop session.

## Required work before stable release

- OS-level sandbox profiles outside Docker;
- browser download scanning hooks;
- focus verification between approval and action, and multi-display
  verification (macOS secure-input refusal and frontmost-window and display
  observation ship);
- automatic reconciliation for arbitrary non-filesystem mutations (cross-process
  workflow leases are implemented; reconciliation beyond filesystem effects is
  not);
- fuzzing for schemas, paths, receipts, and network policy;
- independent security review and public remediation record.
