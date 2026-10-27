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
process running unsafe-local, beyond the refusals below said to hold in every
mode. See
[unsafe-local mode](INSTALLATION.md#unsafe-local-mode).

**The bypass assumption, and how enforced mode changes it.** Everything below
assumes the harness reaches these systems *through* MELRA. In developer mode that
is an assumption, not a control: a harness holding a native terminal as well
makes the kernel optional. `MELRA_MODE=enforced` is the operator asserting the
alternative has been removed, and MELRA cannot verify that from inside its own
process — the isolation is the host's, brought as a container, a separate OS
user, or a sandbox profile. What enforced mode contributes is closing every door
MELRA itself owns: it refuses to start with `--unsafe-local`, refuses any bind
outside loopback, serves no client-registration endpoint, keeps HTTP and browser
effects off loopback unless the policy file opens it, runs every command it
starts in an OS sandbox of its own and refuses to start where none works unless
the policy file records the opt-out, and stamps `mode` and that sandbox on
every receipt so an auditor need not infer which deployment produced an effect.
Loopback still admits every process on the machine up to the token; a
[Unix socket](INSTALLATION.md#over-a-unix-socket) created mode `0600` narrows
that to the OS user running MELRA, which is the IPC a sandboxed harness should
be given.
The residual risk is the assertion itself. `melra probe`, run inside the box
before the agent starts, checks part of it from the agent's side: that a
workspace write, a read of MELRA's database and key in the `MELRA_HOME` it is
given, a public connection, a connection to another local port and starting
the shell are each refused, and that the MELRA outside the box answers. What
it could not try is reported open, not confined. It proves those five and
nothing else, and only for the targets it tried. See
[deployment modes](INSTALLATION.md#deployment-modes) and
[checking an agent's box](INSTALLATION.md#check-an-agents-box).

**The container pair.** One such box ships as a recipe,
[MELRA and the agent in two containers](INSTALLATION.md#melra-and-the-agent-in-two-containers):
the agent's container gets the workspace read-only, MELRA's mode-`0600` socket,
no MELRA data, no credentials, no network route out and no address on the host
to connect to. The agent's container has no capabilities, and MELRA's keeps
only `CAP_SETUID` and `CAP_SETGID`, which it uses to run each command as
`1000`, an account that cannot enter its data or read its policy file; both
run with `no-new-privileges`, a read-only root and caps on processes and
memory. CI checks it from the agent's side with `melra probe` and a write
through the socket that an operator approves from MELRA's side, and has MELRA
run a command that must find MELRA's data closed to it. It leaves open the agent's
channel to its model, which the recipe does not provide; the token the agent
holds, which is the operator's, so its calls are recorded as the operator's,
though in enforced mode it still cannot approve; the host kernel both containers
share; and any change to the file that mounts the Docker socket or runs a
container privileged, which hands that container the host.

**A session `melra launch` starts.** `melra launch claude-code` removes the
harness's own alternative for the one session it starts, in either mode:
Claude Code runs with read-only built-in tools, melra as its only MCP server,
its user, project and local settings files ignored, and any claude argument
beyond a short list refused, so MELRA's tools are the only ones that agent has
that change anything. Outside it are a `claude` started any other way;
desktop clients; plugin hooks, whose loading under `--restricted` is
unverified; and a program MELRA's policy lets the agent run, which has the OS
user's rights whichever allowed command starts it. In developer mode the agent
approves its own changes, so enforced mode is how a person decides each one.
The server such a session starts leaves `node`, `npm`, `npx` and `pnpm` out of
its default `allowedCommands` unless the policy file lists them, which narrows
that list without closing it. The claude `launch` runs is found by absolute
path, never from the workspace it starts in, where the agent can write. It is
not an operating-system boundary: the agent's process runs as the same OS user,
so what this document says about that user's access to the data directory and
the policy file still applies. See
[launching an agent](INSTALLATION.md#launch-an-agent-with-melra-as-its-only-tool).

**Claude Code's own settings.** `melra setup --client claude-code --exclusive`
removes Claude Code's built-in tools that change anything or reach the network
in Claude Code's own settings, for every session rather than one launched
session. Written to the project's `.claude/settings.local.json`, it is a
default, not a boundary: the agent's OS user owns that file, and only MELRA's
own file writer refuses to change it. With the files `--managed` stages
installed root-owned by an administrator, Claude Code ignores permission rules
and hooks from every other file and loads no MCP server from a user, project,
plugin or `--mcp-config` but melra, so a user outside the admin groups cannot
turn those tools back on; servers the hosting app registers in its own process
(an IDE extension's, the desktop app's connectors) and any `managedMcpServers`
your organization's policy provides still load. A local admin can undo it, and
policy from the claude.ai console or an MDM profile, which Claude Code ranks
above managed-settings.json, replaces it whole by default, so neither the deny
list nor the locks apply. `setup` never writes the system folder, refuses to
name an `npx` melra, or a melra or `node` inside the home folder of the user
running it, and refuses to replace a staged file that differs. Neither tier
reaches a program MELRA's policy lets the agent run, a tool a later Claude Code
adds, or another client; other clients are refused. `melra doctor`'s `harness`
line reports what it reads in those files (each tool removed or present, the
managed files' owner, mode and writability, the lock keys, the executable
managed-mcp.json's melra runs, admin-group membership and each file's SHA-256)
and whether a source ranked above them is there, and warns, never fails: it
reads files, not the running session. See [Claude Code's
settings](INSTALLATION.md#take-claude-codes-own-tools-away-in-its-settings).

## Threats and controls

| Threat | Current control | Residual risk |
|---|---|---|
| Prompt-driven destructive action | effect classification, required evidence, exact scoped approval | user may approve a misleading but accurately displayed operation |
| Argument or schema smuggling | strict schemas reject unknown fields | semantic intent can still be ambiguous |
| Unbounded retries | read-only retry budget; one attempt for mutations | independent tasks can repeat the same request |
| An agent flooding the approver or the server | `maxPendingApprovals` caps the challenges one caller has open, and the one past it is refused before any task is written (`too_many_pending_approvals`); `maxCallsPerMinute` rate limits MCP tool calls per caller over every transport, a new session included (`rate_limited`); `melra tasks` and the console group pending requests for the same operation, hiding none; challenges expire, and there is no bulk approve ([flood limits](INSTALLATION.md#flood-limits)) | a caller is whom the transport names, so every agent behind stdio or the operator's token shares one count; each server process gives them one shared bucket, so N server processes allow N times the rate; the cap is counted in one process, so two servers over one data directory can each go one over; each request inside the cap is still a person's judgement; nothing prunes settled tasks, so the task table still grows |
| A crafted value stalling the kernel | matching the `*` patterns of capability grants, credential hosts and delegations, and `url_matches`, and redacting secrets, in text and in command arguments, take time linear in the value; a test fails any secret pattern, argument redaction or match whose time grows faster than its input | other synchronous work has no deadline of its own, and while any of it runs every task, approval and session waits |
| Duplicate workflow advance | process-local per-workflow serialization, an expiring cross-process SQLite lease, state-version compare-and-swap, idempotency commit | a process that dies mid-advance holds its lease until it expires, so other processes wait rather than proceed |
| Crash after an adapter effect | independent file re-observation or explicit `recovery_required` | non-filesystem mutations may require operator reconciliation |
| A lost reply settled as never applied | a reconciliation miss inside the settle window since the task parked (`settleMs`, 30 s when an `http_resource_matches` predicate leaves it out) leaves the task `recovery_required` (`reconciliation_settling`) with no receipt; only a miss after it settles `failed` | a provider whose reads lag its writes by more than the window can still answer a miss for an effect that ran, so reconciliation should read a view that shows its latest writes |
| False completion | explicit predicates and `partial` status | a weak caller-chosen predicate may prove too little |
| Path traversal | lexical and realpath confinement; symlink tests; terminal arguments: every path an argument or option value names is followed through links and refused if it is, is inside, or holds MELRA's data (by identity, every mode; `ls`, `where` and `pwd` print names, so only naming the files refuses them), as is a file a plain reference names for the program to read (`@file`, `<file`, alone or as an option's value) that is or is inside it, and enforced mode refuses one spelled inside that leads out; in enforced mode a `git` `branch`, `diff`, `log`, `rev-parse`, `show`, `status` or `tag` with the subcommand first, approved or not, finds its repository only inside the workspace: git does not search above it, and a `.git` link or gitfile leading out, a directory shaped like a bare repository, an environment naming the repository or handing git config, or a directory above the workspace whose name holds the path delimiter is refused; the policy file, the browser profile, the HTTP archives and every credential's `source.file` are refused the same way wherever they lie, and enforced mode refuses to start in a workspace that holds one of the last three | host race conditions outside the configured workspace model; in developer mode, a recursive reader given no path when the workspace holds the data directory or one of those files (`melra doctor` warns of the data directory and the last three); a recursive reader given a directory that holds one of those files, which only naming refuses (enforced mode shows a person one outside the workspace first); a file a program names by means of its own rather than a plain path or reference (see Shell injection); an approved `rg -L`; in developer mode a `git` command, and in enforced mode an approved one with another subcommand (`commit`, `checkout`, ...) or with a global option before the subcommand, uses whatever repository git finds, one enclosing the workspace included |
| A file swapped between check and use | a file `read` or `hash` and `file_hash` evidence open the file once, without waiting on a FIFO, and judge the descriptor: a regular file, within the size limit for a read; on macOS no link is followed anywhere in the checked path, for these and for a write's temporary file; on Linux where the descriptor leads is judged again | moves, deletes, `mkdir` and a write's final rename look the name up again; on Linux the second judgement comes after the open, so the check before it stays the guard for MELRA's own files; Windows has the single open only; hard links are not seen by path confinement |
| An agent widening its own next session through MELRA's file writer | the file capability refuses to write, replace, move or remove the settings files a coding agent's harness loads its permissions, hooks, tasks and MCP servers from at session start (every file in the Codex rules and Continue MCP folders among them), or a folder named like one holding them (`path_harness_config`), at any depth, by a case-insensitive name and through links, and refuses the place a link at the workspace root or in the home folder leads when the link is one of those names; reads are unchanged. It holds in every mode, unsafe-local included, because it is a fixed check in the file runtime, not policy: in developer mode the agent can approve its own write, and no approval should let a session decide what the next one is allowed | it bounds the file writer, not the agent: an approved terminal command can still write these files, since terminal arguments are not checked for them (a read names the same path, and a program can write a file no argument names); other files a harness loads that can carry permissions, hooks or MCP servers are not on the list, such as Claude Code's agent, skill and command definitions and its `~/.claude.json`, and config folders other than those two; nor are files other tools run later; a client home moved by its own variable is recognised only under its default folder name; a link is followed back only from the workspace root and the home folder, and only while it resolves; a folder several clients share, such as `.config`, and a project folder holding `.mcp.json` are not refused as a whole |
| Shell injection | direct process spawn; shell and privilege commands denied; a bare program name is looked up only in `PATH` entries outside the workspace, never an empty or relative one, and the program is given that `PATH`; the file capability never writes into a git directory, so a program named in a repository's config, attributes or hooks is one a person approved; a `git` read is also spawned with system and global config nulled and fsmonitor, hooks, signature verifiers, fetching of missing objects, external diff and textconv off | an allowed executable can interpret dangerous arguments; interpreters and approved programs can read files their arguments do not name; developer mode reads outside the workspace without approval; external diff and textconv are consequently not applied to git reads MELRA runs |
| Process escape | cwd confinement, environment allowlist, time/output bounds; on POSIX what a finished or cancelled run left in its process group gets SIGTERM, then SIGKILL a second later, and MELRA's shutdown waits for that and stops a run still going as it stops a background job; computer-use helpers start without the payload key, the HTTP token or the variables credentials are read from; in enforced mode (and in developer mode where the policy file asks) every terminal command runs in a [per-command OS sandbox](INSTALLATION.md#per-command-sandbox): no reads of MELRA's own files or the logins under home (under `uid`, by the account's own permissions, which MELRA checks at startup); under Seatbelt and bubblewrap also writes only in the workspace and temp, no symbolic link created unless the command installs packages or the policy file names it, and no network without the `network` trait (Seatbelt: no socket at all, and with the trait only IP and DNS; bubblewrap: an empty network namespace with a loopback of its own); under bubblewrap a PID namespace ends what a command leaves running with it, and with MELRA; enforced mode refuses to start where no sandbox works unless the policy file records the opt-out, which every receipt then names | reads outside the deny list stay open, and a command with the `network` trait reaches any IP host, loopback included; under bubblewrap Unix sockets on the filesystem (an SSH agent's, a daemon's) stay reachable with or without the trait, and an existing symbolic link can still be renamed or hard-linked, since a seccomp filter cannot tell a link from another file; under Seatbelt the named POSIX semaphores and shared memory of MELRA's user stay open; outside bubblewrap's PID namespace a process that leaves its group (`setsid`) outlives the run, on macOS memory is unbounded, and on Windows the children of a program that has already exited are not found; the `uid` sandbox bounds only what its account may read, not where it writes, the network or links, and checks the deny list at startup only; on Windows, under the opt-out, and in developer mode by default, commands run with MELRA's own rights; MELRA's own process and the browser it starts are not in the per-command sandbox |
| SSRF and metadata access | URL validation, DNS resolution, per-request interception; loopback closed in enforced mode unless the policy opens it | malicious public endpoints remain reachable when domains allow them; loopback services are reachable in developer mode by default |
| Unapproved outbound data | in enforced mode an HTTP `GET`/`HEAD` or a browser `navigate`/`tab_new` to a public host the policy admits only through `"*"` waits for an operator (`network_read_unlisted_host`), and so does a read whose `http_resource_matches` evidence is checked there, while a workflow check there is refused (`workflow_check_unlisted_host`); a `GET` or `HEAD` that carries content is a mutation in every mode, and outside unsafe-local mode is approved like one | in developer mode, and to any host `allowedDomains` names, a read's URL reaches its host without approval, so name only hosts a task needs; a page already open can make requests of its own |
| A page sending data outside the destination checks | the browser MELRA launches has WebRTC's UDP turned off (`disable_non_proxied_udp`), in every mode, so page script sends no STUN or other UDP the route handler and the pinning proxy would not see; its WebRTC over TCP, and in a replayed session whatever the archive does not serve, WebSockets included, goes through the pinning proxy | a browser attached over CDP keeps its own setting, and unsafe-local mode starts no pinning proxy; the browser process itself runs with MELRA's rights |
| DNS rebinding | the checked answer is pinned: requests go through a loopback proxy that connects to the address validation accepted | an attached CDP browser and unsafe-local mode resolve names themselves, so the window stays open there |
| Redirects in an attached browser | with an attached CDP browser there is no pinning proxy and Chromium follows redirect hops unseen, so a page or frame whose final address the guard refuses is blanked and never read back, and WebSockets are checked | the redirected request itself still reaches that address; use an owned browser where that matters |
| Malicious downloads/uploads | path confinement and artifact hashes | file content is not malware-scanned |
| Unintended computer input | typed actions, named-key allowlist, high-risk approval | focus can change between approval and action |
| Desktop observation leakage | local-only screenshot artifact with explicit invocation | screenshots may contain sensitive on-screen data |
| Secret persistence | executable payload encryption plus redacted projections, events, receipts, certificates, and logs; digests stored beside redacted records keyed per home with a key derived from the payload key, and a file's content digest masked where its content is; a brokered credential the far end echoes back is replaced in the result itself, as sent or, from 8 characters up, in its base64, base64url, hex or percent-encoded form (as `encodeURIComponent`, RFC 3986 or Python's `quote` spells it, either case), inside a longer base64 string such as an encoded header or HTTP Basic pair, or, for the `Basic` scheme, as the pair it encodes, its password or its user name, each from 8 characters up; the files the browser keeps its session in and credentials are read from are reserved like MELRA's own data (see Path traversal) | novel secret formats may not match redaction patterns, and a goal keeps its words, so a secret of no recognisable format in one is stored; a credential echoed back altered or encoded some other way, or a shorter one echoed encoded, is not recognised, and inside a longer base64 string the character at either edge it shares with its neighbours stays; key loss is unrecoverable, though a start that finds sealed payloads and no key is refused (`payload_key_missing`) rather than given a new one, and so is a start whose key cannot open them (`payload_key_mismatch`), but two processes that both start before anything is sealed, one with `MELRA_PAYLOAD_KEY` and one without, pass that check and can seal under different keys, and the check opens one sampled payload, so a home already split between keys is caught only for a key that misses it; a workflow step's idempotency key stays a plain digest, because every version sharing a home must derive it alike, as do hashes a request asks for or declares (a file `hash`, artifact digests, `file_hash`), sizes, records written by `0.3.0-alpha.18` or earlier, and the render digest this version records in a decision row for a challenge one of those versions issued |
| Memory poisoning | explicit mutation approval, scopes, provenance | no content-level poisoning classifier; classifying text is left to the harness, and a poisoned memory still has to pass policy, approval, and evidence to become an effect |
| Receipt tampering | a certificate per task whose digest covers its own fields; database triggers (`record_append_only`, binding every process, an older MELRA included) refuse an update or removal of receipts, workflow events, approval decisions, approval denials, refused answers, grant draws, idempotency commits, `certificate_history` and `certified_tasks`, and a `REPLACE` that would take one's place on its rowid or key (a repeat under a key MELRA writes with `INSERT OR IGNORE` is ignored instead); a certificate is never removed, no write may take another certificate's place or insert a second one for a task, and it changes only in place on its own task, with the row replaced kept in `certificate_history` ([durable storage](ARCHITECTURE.md#durable-storage)) | this catches bugs, stray scripts and naive edits, and is not tamper-evidence: anyone who can write `melra.sqlite` can drop the triggers and then rewrite any record, a certificate and its digest included; with the triggers in place they can still add rows and update a certificate in place, though the one replaced is kept; receipts and projections are not encrypted, signed or chained to one another |
| A policy changed between effects | every decision, receipt and certificate records `policyDigest`, the SHA-256 of the policy file's bytes (`default:<version>` with none), beside the operator's `version` label, so effects governed by different files are told apart; in enforced mode `melra doctor` warns when the user MELRA runs as can write or owns the policy file or any folder above it, following links, or, with no file, the data directory a `policy.json` would be loaded from | the digest records which file governed an effect and does not stop the OS user MELRA runs as from changing it; it covers the file's bytes only, so keys the file leaves out follow the running MELRA version's defaults (narrowed under `melra launch` with the same digest), the workspace root comes from `MELRA_WORKSPACE`, else a `MELRA_POLICY` file's `workspaceRoot` (relative to the file), else the current directory (a policy file's `workspaceRoot` can also only narrow it to a folder inside), and is in neither the digest nor the receipt, and the mode and unsafe-local overrides are recorded separately; nothing signs it; the write check does not cover how MELRA is started, such as which `MELRA_POLICY` a client's configuration passes; in developer mode the write check passes, since a default setup keeps its policy where this user can change it; on Windows the write check is not made |
| A local process taking the HTTP surface | bearer token compared in constant time, loopback binding, read-only JSON API; MELRA never puts the token on a command line itself: `serve --http --open` hands the browser opener a code that opens the console once, within a minute of startup; or `--socket`, a mode-`0600` Unix socket the kernel closes to every other OS user, with the token still required | a loopback port is reachable by every local process, so there the token is the only barrier; on either transport, anything running as the same OS user (or root) can connect and read the token from the process that holds it; a reader of the opener's command line who uses that code before the browser does gets the console and its token, and with it can approve an OAuth client that outlasts a restart until revoked; the operator's tab then says the link was already used (`open_code_used`); a token the operator passes as an argument (`melra conformance --token`, or a console URL as `--url`; `curl -H`) is readable there the same way; no socket transport on Windows |
| A client granting itself HTTP access | registration grants nothing; approving takes the operator's token, entered on a consent page that cannot be framed; the sign-in routes answer only loopback names, so a rebound page cannot reach them; registration refuses a request carrying an `Origin` and a `Content-Type` other than JSON, so no other page in the operator's browser can register a client either; PKCE S256 binds the code, loopback-or-private redirect URIs keep the code on the machine, codes are single-use | approval is a human judgement about a name the client chose for itself; anything that can read the token can approve; any local process can still register, and past the client cap that pushes out a client still waiting for approval, never one holding a token |
| An approved client acting as another | the issued token names one client; an MCP session id is bound to the caller that opened it; each task and workflow run records the caller that planned it (a run's steps record the run's), and every tool taking a task, receipt or run id refuses another authenticated client (`task_belongs_to_another_client`, `workflow_belongs_to_another_client`) before anything is read, run or written; the read-only JSON API answers the operator's token only, so no client can list other callers' ids | every principal a request declares beneath the authenticated one is still a claim; the operator's token, stdio and the CLI are one caller, the operator, and are refused nothing; a task or run planned before callers were recorded names no one, nor do the steps such a run plans later, and any caller holding its id can still use it |
| An agent lifting an operator's halt | halt and resume events record who acted, whether an operator did, and through which channel; in enforced mode a run an operator paused or suspended with `melra workflow` is resumed only by an operator (`workflow_resume_needs_operator`), whatever halt follows it, whichever mode that command ran in, and also when the agent had already halted the run; a paused or suspended run's step tasks do not run in any mode until it is resumed (`workflow_halted:<status>`) | an agent may still pause, suspend and resume a halt only it made, and a kernel in developer mode lets it lift any halt; a step's task planned before steps recorded their run is not held by the halt; `melra approve <task-id> --deny` and `melra workflow cancel` remain the stops nothing on the agent's side undoes |
| An agent answering an operator's question | every `human_input` answer records who gave it, through which channel and when, on its `workflow.node_changed` event; in enforced mode a node declaring `answeredBy: "operator"` takes its answer only from `melra workflow advance --input`, and an answer sent through `melra_workflow_advance` is refused (`workflow_input_in_band_refused`) before anything in the run moves | a node that does not declare it can be answered by the agent in every mode, and is recorded as the agent's; any valid answer completes the node, since no later node reads it, so a question is a record, not a gate: put a step that must not run without a person's yes behind an approval; developer mode takes any answer from anyone |
| An agent certifying its own semantic question | `semantic_judge_is_actor` on the declared principal, and on a declared chain naming the actor; `identity` required and recorded beside `receipt.principal`, which the certificate repeats as `executedBy`; in-band verdicts refused when enforced; strength stays `semantic`, never deciding for a destructive effect outside unsafe-local mode | the check rests on claims: a harness can declare another principal, or a `human:` link it then judges as; only a `cli:` judge came through an operator surface |
| Injection through a semantic question or rationale | the kernel acts only on the verdict enum and never reads `rationale`, which is bounded and redacted | the actor writes the question a model judge reads ("answer yes"); a judge's rationale reaches the actor via `melra_task_status` |
| Secrets read from MELRA's own environment | no program MELRA starts inherits `MELRA_PAYLOAD_KEY` or `MELRA_HTTP_TOKEN`, the agent `melra launch` starts and the browser MELRA launches included, so `launch` wants the key in its file; in enforced mode startup and `melra doctor` warn while either is set, pointing at the mode-`0600` key file and a random token; the key file is decoded without becoming a string and cleared once read | a warning, not a refusal; any process running as the same OS user can read MELRA's environment while they are set; a token or key held as a string can stay in memory until it is collected |
| Payload substitution | AES-256-GCM with identity/purpose-bound additional data | host compromise can read the key and database |
| Dependency compromise | lockfiles, dependency review, CodeQL, SBOM | upstream compromise before detection remains possible |
| Release substitution | checksums and signed GitHub/Sigstore provenance | trust still depends on GitHub identity and workflow protection |

## Approval properties

An approval challenge contains a random approval ID, the task ID, a keyed
digest of the exact operation, and an expiration time. Whether it also carries a phrase,
and what lets the mutation run, depends on the
[deployment mode](INSTALLATION.md#deployment-modes):

| | Developer mode | Enforced mode |
|---|---|---|
| Phrase in the challenge | yes: `APPROVE` plus the first 12 hex digits of the action digest | none |
| What lets a mutation run | the phrase echoed to `melra_execute`, or a decision recorded with [`melra approve`](INSTALLATION.md#approving-from-the-command-line) or [`melra console`](INSTALLATION.md#approving-in-a-browser) | only an operator's decision recorded by a process in enforced mode (`melra approve`, `melra console`, or `melra run`'s prompt in a terminal) |
| An approval the agent sends | checked against the phrase; one that does not match is recorded | refused (`approval_in_band_refused`), even when an operator has already decided, and recorded |
| A verdict or operator-only answer the agent sends | recorded as given, as the agent's | refused (`judgement_in_band_refused`, `workflow_input_in_band_refused`) and recorded |
| An operator's no | cancels the task and records the reason, a redacted note, the approver and the channel `in_band`, once per challenge | the same, on channel `out_of_band` |
| No usable decision yet | `approval_required` | `approval_awaiting_operator`, or `approval_expired` once the challenge has expired |
| Channel on the receipt | `in_band` | `out_of_band` |
| Where a refused answer shows | `melra tasks`, `melra status` and `melra watch`, once per task or run and code, with the mode, the sender and the time, and nothing that was sent | the same, and `melra tasks` marks a task whose agent sent an approval or verdict only an operator gives; an approval sent with `melra workflow advance --approval` or a verdict sent with `melra judge` is not recorded, and a decision `melra approve` or the console records that does not match is recorded under the approver's name |
| Residual risk | anyone who can read the task can read the phrase, so an echo shows only that something echoed it | anyone with OS access to the data directory can run `melra approve` or `melra console`, or write `melra.sqlite` directly, which is an operator only if the agent has no such access; see [the approval console](#the-approval-console) for that path's own residuals |

Approvals cannot be reused for a different task or operation. Policy is
re-evaluated after approval and immediately before execution.

### The approval console

`melra console` is an operator path beside `melra approve`, with the same
authority. It is a separate process: a loopback server with no MCP endpoint and
no client registration, which refuses to start without a terminal and never
prints its pairing code. It pairs once, with the first page to use its one-time
code, normally the tab it opened (see the pairing race below), and that page
holds its session in memory only; a decision is a JSON POST from the console's
own origin, bound to the task and the digest of the screen shown. MELRA's
browser runtime refuses every action that sends the console page input
(`browser_refuses_approval_surface`), in every mode, and each action of its
own that could raise or move the page under the operator's pointer:
`tab_switch` onto its tab, `scroll` on it, and, in a browser it is attached
to, `close` of any tab and `tab_switch` to any while another console is open
there, since the browser then raises a neighbour or, in a split view, the
switched tab's partner; a tab that does not answer within a second counts as
one, since a console too busy to answer is still a console. Its
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
  check binds browsers only) to approve whatever is pending, and to read every
  task, receipt and workflow event the console serves, until the console
  stops. The operator's cue is their own tab saying another tab already
  paired; the terminal's pairing line alone looks like a normal start. Every
  approval is printed on the terminal as it is made, and if the browser opener
  reports failure after a tab paired, the console closes with an error naming
  them, so the operator can cancel each with `melra approve <task-id> --deny`
  before the agent runs it; one already run cannot be taken back. Who can read the code decides what that costs. A tab
  the agent's browser paired gets no input from that runtime. An
  unsandboxed process of the operator's own user could already run
  `melra approve --yes`. But another OS user, or a sandboxed process that can
  list processes without reaching the data directory, can read the opener's
  command line (`ps`, `/proc/<pid>/cmdline`) and race the pairing for an
  approval it could not make otherwise. A spent code is worthless.
  `melra serve --http --open` follows the same rule: its opener gets a code
  good once, within a minute, never the standing token, but whoever uses the
  code first is handed that token, which drives `/mcp` (see the HTTP surface
  row above).
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

- loopback, unless `allowLocalhost` enables it: left out of the policy file,
  it is enabled in developer mode and not in enforced mode;
- private, link-local, multicast, and unspecified addresses;
- IPv6 outside global unicast (`2000::/3`), other than the IPv4-mapped and
  NAT64 forms, which are judged by the IPv4 address they carry, and the
  special-purpose and transition blocks inside global unicast, whatever IPv4
  address they embed;
- cloud metadata endpoints;
- hostnames resolving to a disallowed address;
- redirects and subresources that cross the same checks.

The HTTP adapter applies the same destination checks, connects to the
address it checked, and does not follow redirects.

A domain allowlist controls intended public destinations. Wildcard domain
access is convenient for local experimentation but should be replaced with
specific domains in reviewed policies. In enforced mode a read sent to a host
only the wildcard admits, or whose evidence is checked there, needs an
operator's approval, so a reviewed policy that names its hosts is also the one
whose reads run unattended.

## Non-goals for `0.4`

- protecting against a compromised operating system or browser binary;
- deterministic proof from model judgment;
- arbitrary native extensions;
- malware scanning;
- encrypted credential storage;
- remote multi-tenant execution;
- protecting computer input from a malicious accessibility service or
  compromised desktop session.

## Required work before stable release

- an OS-level sandbox for MELRA's own process outside the deployment recipes,
  and a per-command sandbox on Windows;
- browser download scanning hooks;
- focus verification between approval and action, and multi-display
  verification (macOS secure-input refusal and frontmost-window and display
  observation ship);
- automatic reconciliation for arbitrary non-filesystem mutations (cross-process
  workflow leases are implemented; reconciliation beyond filesystem effects is
  not);
- fuzzing for schemas, paths, receipts, and network policy;
- independent security review and public remediation record.
