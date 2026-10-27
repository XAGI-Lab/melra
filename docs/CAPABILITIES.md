# Capabilities and limits

This document describes `0.4.0-alpha.1`.

## MCP tools

| Tool | Side effect | Approval |
|---|---:|---|
| `melra_capabilities` | none | no |
| `melra_plan` | stores a plan | no |
| `melra_execute` | depends on planned operation | scoped for mutations |
| `melra_task_status` | none | no |
| `melra_task_cancel` | cancels task | no |
| `melra_receipt` | none | no |
| `melra_task_judge` | records a verdict on a waiting task | no; refused in enforced mode, where an operator uses `melra judge` |
| `melra_workflow_plan` | stores a validated workflow | no |
| `melra_workflow_advance` | depends on ready workflow nodes | scoped per mutation |
| `melra_workflow_status` | none | no |
| `melra_workflow_cancel` | cancels nonterminal workflow work | no |
| `melra_workflow_control` | pauses, resumes, or suspends a run | no; in enforced mode `resume` is refused on a halt an operator made with `melra workflow` |

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

Over loopback HTTP, every tool here that takes a task, receipt or workflow run
id answers only the client that planned it, or the operator: another
authenticated client is refused with `task_belongs_to_another_client` or
`workflow_belongs_to_another_client`. A task or run planned before callers were
recorded is open to anyone holding its id, and so are the steps such a run plans
later.

Two [flood limits](INSTALLATION.md#flood-limits) apply to every caller. A tool
call past `maxCallsPerMinute` (default 1200, a token bucket per caller in each
server process, shared by all its sessions there) fails with `rate_limited`
and how many milliseconds to wait, over stdio, loopback HTTP and the Unix
socket alike. A request needing approval
while its caller already has `maxPendingApprovals` challenges open (default 64)
fails with `too_many_pending_approvals` and writes nothing, until one is
approved, denied, cancelled or expires. `melra_capabilities` publishes both
limits under `policy`, and `pendingApprovals`, the caller's own open count.

## Durable workflows

Node types: `operation`, `approval`, `condition`, `parallel`, `bounded_loop`,
`checkpoint`, `compensation`, `human_input`, and `delegation`.

- Exact definitions and task payloads survive restart in encrypted envelopes,
  each task's written with its record in one transaction.
- Each advance executes one deterministic ready wave.
- A `human_input` answer is recorded on its node, and who gave it (`answeredBy`:
  `cli:<name>` for an operator, else the agent's principal), the `channel` and
  `answeredAt` on its `workflow.node_changed` event. Any answer within
  `maxLength` and `choices` completes the node; later nodes do not read it, so a
  "no" stops nothing. A node with `answeredBy: "operator"` takes its answer in
  enforced mode only from
  `melra workflow advance <workflow-id> --input <node-id>=<value>`; one sent
  with `melra_workflow_advance` is refused (`workflow_input_in_band_refused`)
  and the node keeps waiting.
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
- No action changes the settings files a coding agent's harness loads its
  permissions, hooks, tasks or MCP servers from when a session starts:
  `.mcp.json`, `.claude/settings.json` and `settings.local.json`,
  `.vscode/settings.json`, `tasks.json` and `mcp.json`, `.codex/config.toml`
  with the Codex directory's other config files, every file in `.codex/rules`
  and `.continue/mcpServers`, `.gemini/settings.json`, `.cursor/mcp.json`, and
  every file [`melra setup`](INSTALLATION.md#mcp-clients) writes for a client
  at its default location (a client home moved by its own variable is
  recognised only while it keeps the default folder name). A `write`, `mkdir`,
  `delete` or either end of a `move` naming one is refused with
  `path_harness_config`, which names the path: edit the file yourself, outside
  the agent. This holds in every mode, unsafe-local included.
- Those files are known by name: the last parts of the path, at any depth and
  in any case, so a file of the same name in an unrelated folder is refused
  too. A `delete` or `move` of a folder named like one that holds them, such
  as `.claude`, `.vscode`, `.codex`, `.gemini`, `.cursor`, `.continue` or a
  client's own folder (`~/.config/zed`, `~/.openclaw`), is refused even when it
  holds none of them; the folder holding `.mcp.json` is any project, so it is
  not. A path through a link to one is refused, and so is the place a link
  leads when the link, at the workspace root or in the home folder, is one of
  these names or a folder on the way to one.
- Only those files are refused. Reading them, the rest of `.claude` or
  `.vscode`, and other files a harness loads, such as agent, skill and command
  definitions, are unchanged, and an approved terminal command can still write
  any of them.
- Reads and writes are size-bounded by local policy.
- A `read` or `hash`, and `file_hash` evidence, opens the file once and
  judges what it opened: anything but a regular file is refused
  (`file_read_requires_regular_file`, `file_hash_requires_regular_file`, or a
  failed `file_hash`) without waiting on it, and a `read` or `hash` takes no
  more than the size limit, however the file grows meanwhile. On macOS the
  path is judged with its links resolved, so a link already in it is judged by
  where it leads (`path_outside_workspace` when that is outside), and then
  opened following no link, so one that appears in between fails
  `path_changed`; on Linux where the descriptor leads is judged again after the
  open. Windows has the single open only.
- Writes use a temporary sibling file followed by an atomic rename. On macOS
  the folder is judged with its links resolved and the file created there
  following no link, so a link that appears in between fails the write with
  `path_changed`.
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
- These are denied even if added to the allowlist by mistake, by basename and
  with any Windows executable suffix: the shells `sh`, `ash`, `bash`,
  `bash-static`, `rbash`, `dash`, `ksh`, `ksh93`, `rksh93`, `mksh`,
  `mksh-static`, `lksh`, `rlksh`, `rmksh`, `oksh`, `pdksh`, `zsh`,
  `zsh-static`, `rzsh`, `yash`, `csh`, `bsd-csh`, `tcsh`, `fish`, `elvish`,
  `nu` and `xonsh`; the multi-call binaries `busybox` and `toybox`; `cmd`,
  `powershell`, `powershell_ise`, `pwsh`, `pwsh-lts`, `pwsh-preview` and
  `wsl`; the programs that run another as a different user, `sudo`,
  `sudoedit`, `sudo-rs`, `su`, `su-rs`, `doas`, `pkexec`, `run0`,
  `systemd-run`, `runuser`, `ksu`, `pfexec`, `runas` and `gsudo`; and the
  script hosts `osascript`, `wscript`, `cscript` and `mshta`. The list goes by
  name: a copy of one of these under a name not listed here is not recognised,
  so keep such programs out of `allowedCommands`. A program that starts other
  programs can still start one of them or a shell of its own: `env`, `xargs`,
  an interpreter such as `node`, `sg` with `-c`, or a WSL distribution's
  launcher (`ubuntu.exe`). So allowlist one only if you would approve what it
  runs.
- A server [`melra launch`](INSTALLATION.md#launch-an-agent-with-melra-as-its-only-tool)
  starts leaves `node`, `npm`, `npx` and `pnpm` out of the default
  `allowedCommands`, since the agent there has no shell of its own; a policy
  file's own `allowedCommands` is kept as written. That narrows the list
  without making the rest harmless: any allowed command run as an approved
  change has your rights, less what the per-command sandbox below takes away
  where one works, and in developer mode the agent approves its own changes.
- Command, arguments, working directory, environment, duration, and output are
  bounded.
- In enforced mode, and in developer mode unless the policy file sets
  `"sandbox": {"use": "off"}`, each command runs in an OS sandbox of its own
  wherever one works, where it cannot read MELRA's data, the policy file, the
  secret files or the login files MELRA lists (the rest of home stays
  readable). Under Seatbelt and bubblewrap it also
  writes only in the workspace and temp (shared with your other processes),
  reaches no network without the `network` trait (Seatbelt: no socket, a
  loopback one included, except the host's loopback in developer mode;
  bubblewrap: an empty network namespace, Unix sockets on the filesystem
  still reachable), makes no symbolic link unless it
  installs packages, the policy file names it or, in developer mode, it is
  git, and gets npm and pnpm caches in a private folder in temp (npm's
  outranking a project `.npmrc` setting `cache`); under `uid` it only runs as
  an account that cannot read those
  ([per-command sandbox](INSTALLATION.md#per-command-sandbox)).
  Where none works, enforced mode does not start, and developer mode runs
  each command with your rights, every receipt saying `sandbox: none`.
  `melra_capabilities` reports which in `policy.sandbox`, and who may approve
  a change in `policy.approvals`: `in_band`, the caller itself, in developer
  mode, so there an approval records consent rather than bounding it.
- Only a read runs without approval. A read is a read-only program (`cat`,
  `head`, `rg`, `git status`/`log`/`diff`, listing `git branch`/`tag`, ...)
  called with arguments that all keep it one: no option that runs a program,
  writes, or names another host, and no path-qualified command. No package
  manager call is a read, `npm ls` included: each takes settings from files in
  the workspace that policy never sees, and they can make it write elsewhere.
  Everything else is a mutation and needs approval; `melra policy test` shows
  how a command is classified. In enforced mode `git branch`, `diff`, `log`,
  `rev-parse`, `show`, `status` and `tag`, with the subcommand first, approved
  or not, use only a repository inside the workspace (a global option before
  the subcommand makes the call a mutation that needs approval)
  ([deployment modes](INSTALLATION.md#deployment-modes)).
- A `run` is over when its program is: what it left in its process group gets
  SIGTERM, then SIGKILL a second later if it is still there (POSIX; Windows
  has no groups). MELRA does not exit before that second is out, a one-shot
  `melra run` included, and its shutdown stops a run still going as it stops a
  background job. A process that leaves its group, with `setsid` for one, is
  not reached.
- Background jobs are supervised only for the life of the server process.
  Under bubblewrap what a job's program leaves running ends when it does.

A job started with `interactive: true` keeps stdin open, and `send` writes a line
to it ([commands that ask a question](INSTALLATION.md#commands-that-ask-a-question)).
Stdin is a pipe, not a pseudo-terminal: interactive PTY sessions are not
implemented in `0.4`.

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
  or fragment. Without a `url`, the target is `element:` followed by the
  target's `selector` or `name`, or `active-page`, so a grant scoped to pages
  never matches it, however the element is spelled. An input action (`click`, `type`, `fill_form`, `select`,
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
  addresses, and any IPv6 address outside global unicast other than the
  IPv4-mapped or NAT64 form of a public IPv4 address. Localhost is open in
  developer mode and opt-in in enforced mode (`allowLocalhost`).
- In enforced mode, `navigate` and `tab_new` to a public host that
  `allowedDomains` admits only through `"*"` need an operator's approval
  (`network_read_unlisted_host`); a host the policy names needs none.
- The browser MELRA launches has WebRTC's UDP turned off
  (`--webrtc-ip-handling-policy=disable_non_proxied_udp`), in every mode, so
  page script cannot send UDP around these checks, STUN included, and its
  WebRTC over TCP, through a TURN server, goes through them; a page that needs
  WebRTC over UDP does not get it. A browser attached over CDP keeps its own
  setting.
- Confines uploaded files to the workspace, never MELRA's own data directory
  except its artifacts, nor the browser profile, an HTTP archive or a
  credential's file, and downloaded files to the artifact directory.

- `MELRA_BROWSER_PROFILE` names a directory to keep, so a site logged into once
  stays logged in across runs. Unset, every run gets a throwaway profile.
- `MELRA_BROWSER_HAR_PATH` records the session as an HTTP archive, response
  bodies included, and `MELRA_BROWSER_HAR_REPLAY` serves a later run entirely
  from that file. A request the archive does not contain is aborted rather
  than fetched — a rerun cannot quietly become a live one — and what never
  reaches a request route, a WebSocket or WebRTC over TCP, goes through the
  same destination checks as in a live run. The two cannot be combined, and
  neither works against a browser attached over CDP.

Captchas are detected and reported, never solved.

### Memory

Actions: `put`, `search`, `list`, `delete`, `clear`.

Scopes: `session`, `task`, `project`, `workspace`, `user`, `procedural`.

- Stored records include source, confidence, timestamps, and optional speaker,
  episode ID, and sequence metadata.
- PEM and PGP private keys, AWS access key IDs, JWTs, Slack, GitHub and npm
  tokens, common API keys, authorization headers, URL credentials, and password,
  secret, token and API-key assignments are redacted — the same
  `SECRET_PATTERNS` list receipts and terminal output use. An assignment may use
  `=`, `:`, `=>`, `:=` or `::=`, compare with `==`, or, for a password or secret
  name, declare a type of letters, digits, `_`, `.`, `[]`, `<>` or `|`, up to 64
  characters (`password: str = x`); a quoted value goes to its closing quote
  within 256 characters, and a YAML block scalar's indented lines go, with the
  blank lines between them (for a token or API-key name, when the token is all
  of the first line).
- Search is local and scoped with BM25-style lexical evidence, exact phrases,
  explicit speaker matching, bounded adjacent episode context, confidence,
  freshness, and bounded head diversity.
- Search ranks at most the 5,000 most recently updated in-scope candidates per
  query, fewer once their keys, values and tags pass 4,000,000 characters
  together, and returns at most 100 results.
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
- The helpers these actions start (`osascript`, `screencapture`, `ioreg`,
  `xdotool`, `gnome-screenshot` or `scrot`, PowerShell, and `tesseract` or the
  named OCR program) get the server's environment without `MELRA_PAYLOAD_KEY`,
  `MELRA_HTTP_TOKEN` or any variable a credential's `source.env` names, matched
  ignoring case. Everything else still reaches them, since they need display,
  D-Bus, tessdata and Windows settings; a library embedder names more with
  `ComputerRuntimeOptions.withheldEnvironment`, or, for an adapter it passes
  in, with `createSystemComputerAdapter`'s argument.

Focus verification, multi-display normalization, per-monitor DPI compensation,
and official task-benchmark evidence remain roadmap work.

### HTTP

Action: `request`. Fields: `method`, `url`, `headers`, `content`,
`idempotencyKey`, `spend`, `maxResponseBytes`, `timeoutMs`.

- `GET` and `HEAD` without `content` classify as reads. Every other method, and
  a `GET` or `HEAD` that carries `content`, is a mutation: it needs declared
  evidence and an exact scoped approval, and it runs at most once —
  `budget.maxRetries` does not apply to it.
- In enforced mode a read to a public host that `allowedDomains` admits only
  through `"*"` needs an operator's approval (`network_read_unlisted_host`); a
  host the policy names needs none.
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
  `redactions`; `bytes` still counts what arrived. So is one of 8 characters or
  more echoed in a fixed encoding: base64 (padded or not), base64url, hex in
  either case, or percent-encoded the way `encodeURIComponent`, RFC 3986 (Go,
  PHP) or Python's `quote` spell it, with upper- or lower-case escapes. Inside a
  longer base64 or base64url string, such as the encoding of the header it went
  out in or of an HTTP Basic pair, the characters it alone decides are replaced,
  leaving at most the one at either edge it shares with its neighbours. One sent
  under the `Basic` scheme, configured as the base64 of a printable
  `user:password`, is masked too as the decoded pair, as its password and as its
  user name, each when it is 8 characters or more, so a long user name is masked
  as well as the password. A shorter one is masked only as sent, since the
  encodings of so few bytes turn up in ordinary text. A body cut at the size cap
  on such a call always ends in the marker in place of its last few characters,
  as many as the longest of those forms, whatever they held, and lists it too.
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
| `file_hash` | exact SHA-256 of a regular file, read from the one descriptor it judged (see [Files](#files)) |
| `exit_code` | terminal process exit code |
| `url_matches` | anchored URL glob (`*` wildcard) |
| `page_contains` | inspected page text |
| `http_resource_matches` | a second `GET`/`HEAD` against the provider's own state |
| `custom` | a verifier the operator registered with the runtime, by name, with flat scalar `params`; strength is always `execution` |
| `semantic` | a yes/no `question` about meaning, with `artifacts` naming result paths, for a judge outside MELRA, who answers with `melra_task_judge` or `melra judge`; strength is always `semantic` |

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
expires: the approval TTL (`approvalTtlMs`). A principal other than the one
that planned the task answers each question with `melra_task_judge`
(`yes`, `no` or `cannot_tell`); a judge declaring the task's own principal, or
a non-human link it acts for, is refused (`semantic_judge_is_actor`), and so is
one whose declared `onBehalfOf` names the task's principal, such as a grader
that agent started. A judge sharing only a link above the task's principal,
another session of the same harness or another agent of the same person, may
answer. The `harness:` link an OAuth client's token puts above a judge's
chain is recorded in `judgedBy` but not compared. That check compares declared identities, so over MCP even a `human:` judge is the
harness's claim; only a `cli:` judge, from `melra judge`, came through an
operator surface. In enforced mode, and on a task that ran enforced, no verdict
sent over MCP is recorded as a verdict: one on a question still waiting is
refused (`judgement_in_band_refused`), the attempt is recorded where
`melra tasks` and `melra status` show it, and an operator answers with
`melra judge`. A
yes on every question makes the task `verified_success`.
The first `no` ends it `partial` (`semantic_judgement_no`); `cannot_tell` ends a
change `recovery_required` and a read `partial`
(`semantic_judgement_cannot_tell`). Unanswered at expiry, the task settles
closed the same way as `cannot_tell`, with the error
`semantic_judgement_expired`, keeping any yes already given. On the settled
certificate an answered item carries `judgedBy` and, beside it, `executedBy`,
the receipt's principal. A verdict writes only the task and its certificate,
never a receipt, and the certificate it replaces is kept in
`certificate_history`. A task with a failing
predicate beside it is `partial` without waiting. Outside unsafe-local mode, a
destructive effect whose evidence has a `semantic` predicate but nothing the
kernel re-reads (`file_exists`, `file_absent`, `file_hash`) or asks another
channel (`http_resource_matches`) is refused at planning
(`semantic_only_destructive`); under `--unsafe-local` it is not, so a yes can
certify a destructive effect on semantic evidence alone, though the effect ran
before anyone was asked. A task cannot declare `semantic`
beside `reconciliation` (`semantic_evidence_not_reconcilable`), and a workflow
cannot declare it in any node (`workflow_semantic_evidence_unsupported:<node>`). The
question is stored and shown as written, minus secret shapes.

`http_resource_matches` is the only predicate whose answer does not come from
the channel that acted. `POST /refunds` returning `201` is the client that made
the call reporting on itself; `GET /refunds/rf_1` is the provider. Because the
id is only known afterwards, the URL is completed from the recorded result —
`{{json.id}}` reads the parsed response body, `{{status}}` the status — and each
spliced value is percent-encoded, so a response field cannot rewrite the path.
A value of `.`, `..` or the empty string is refused rather than spliced
(`verification_token_dot_segment`, `verification_token_empty`), because each
would point the read at a different resource; the item is unanswerable, not
passed.
The verification request is an effect like any other: same adapter, same
destination boundary, same allowlist, same credential scope. In enforced mode a
read whose verification request goes to a host `allowedDomains` admits only
through `"*"`, or takes its host from the result, needs an operator's approval
(`network_read_unlisted_host`), as a read sent there does, and a workflow check
like that is refused at planning and when an advance reaches it
(`workflow_check_unlisted_host`). `GET` and `HEAD` only, and a runtime with no
HTTP channel fails the predicate rather than passing it. It is the only
predicate carrying `strength: "independent"`.

A task request carries a second predicate list, `reconciliation`, drawn from the
same schema but asked only when a mutation's outcome is unknown — the request
reached the wire and no reply came back. Nothing runs again: the predicates ask
the provider what its state is, `{{idempotencyKey}}` splices the request's own
key into the URL, and the answer settles the task as `verified_success` or
`failed`. A provider that cannot be reached leaves the task `recovery_required`
rather than guessing either way, and a request that declared no reconciliation
predicates stays parked for a human.

A miss is read as `failed` only once the effect has had time to show. An
`http_resource_matches` predicate takes `settleMs` (0 to 3,600,000, 30,000 when
left out; read by reconciliation only): until that long after the task first
parked (`parkedAt` on the task), a `404`, a `410` or a value that does not match
yet leaves it `recovery_required` with `reconciliation_settling` and no
receipt. MELRA's recovery sweep asks it again, as `melra_execute` on it does,
and the first miss asked after the window settles it. Other predicates have
no window: a file predicate reads a workspace that shows its own writes. Point
reconciliation at a read that shows the provider's latest writes, and set
`settleMs` to at least how far its reads can lag; `0` settles a miss at once.

`melra_execute` returns raw operation output directly to the connected client.
Durable task state, receipts and certificates keep only centrally redacted
input, output and evidence; file contents, browser text, terminal output, typed
values, environment values, URL queries and userinfo, and common secret formats
are not retained there. A task's goal is kept as declared with only those secret
formats taken out, so a certificate's `goal` says what the task was for; a
secret of no recognisable format written into a goal is kept with it. Once
a receipt, workflow event, approval decision or denial, refused answer, grant
draw or idempotency commit is written, the database refuses an `UPDATE` or
`DELETE` of it (`record_append_only`) and a write that would replace it leaves
it as it was, which guards against mistakes rather than against someone who
can write `melra.sqlite` (see
[durable storage](ARCHITECTURE.md#durable-storage)). An
`http_resource_matches` item names the URL it read without its query or
userinfo; the request itself goes out as declared.

Free-form task constraints fail closed because they cannot be enforced
deterministically. `forbiddenEffects` accepts only `read`, `mutate`, and
`destructive` and is enforced during planning and again during execution.
Forbidding `mutate` forbids `destructive` too, as `"mutations": "deny"` does;
forbidding `destructive` alone leaves every other mutation. `destructive` is
only a file `delete` and a memory `delete` or `clear`. Every other change is a
`mutate`, including a terminal command that deletes (`rm`, `git clean`,
`git reset --hard`) and an HTTP request other than `GET` or `HEAD`, `DELETE`
included, so a task that must delete nothing forbids `mutate`.

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

A memory target is `<scope>:<action>:<id>`, or `<key>` for a `put` or `delete`
that names no id. `list`, `search` and `clear` act on the whole scope, so their
target is `<scope>:<action>:*` whatever key or id the request carries, and only
a grant covering the whole scope covers them. A `put` with `supersedesId` hides
that record, so the grant has to cover `<scope>:put:<supersedesId>` as well: a
grant scoped to keys, such as `project:*:scratch-*`, cannot supersede.

`validUntil` bounds a window; two optional fields bound what happens inside it.

- `maxOperations` is how many times the grant may ever be spent. The count is
  durable, so a restart does not refill it.
- `provider: { name, account?, amountMax?, dailyMax? }` bounds money. `amountMax`
  caps one call, `dailyMax` the declared amounts committed in the last 24 hours.

A grant is drawn down whenever the adapter may have done the work, read or
change, whatever the evidence then says: it returned (`verified_success`,
`waiting_user`, `partial`, or a reported failure such as a non-2xx answer or a
non-zero exit), or it threw an error marked outcome-unknown
(`recovery_required` for a change; for a retried read, on any attempt).
`verified_success` is the evidence verdict, not the meter. Each task is drawn
once, however often recovery and reconciliation settle it, and a draw stands
even if reconciliation later finds the effect did not happen: counting an
effect that did not happen is preferred to exceeding a limit. An operation refused by policy, cancelled before the
adapter ran, stopped by an adapter error saying nothing went out, or stopped as
a duplicate before it ran costs nothing. A read cut off mid-flight is drawn when
recovery parks it to run again; run again, it is the same task and draws nothing
more, but its re-check counts that draw, so a read at its grant's limit is not
run again. Below the limit, that second run goes uncounted, so each such
interruption can let one read past the limit.

A workflow's compensations draw on the same grants as its forward steps, so a
forward step that ends `partial` has already spent what an unwind may need. A
compensation its grant can no longer fund is refused like any other effect, and
the unwind stops there (`workflow_compensation_incomplete:<node>`), leaving the
effect it was to undo in place. Size a grant for every forward step that may run
plus its compensations, or cover compensations with a grant of their own that
the forward steps do not match.

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

Every policy decision names the policy it was made under in two ways.
`policyVersion` is the `version` label the operator writes, `"1"` unless they
change it. `policyDigest` is `sha256:` and the SHA-256 of the policy file's
bytes, the value `sha256sum` prints for it, or `default:<version>` when no file
is loaded, so it changes with any edit whether or not the label moved. It covers
the file's bytes only. A key the file leaves out takes the running MELRA
version's default, so one digest can stand for other rules under another
version, and under `melra launch`, whose defaults leave out node, npm, npx and
pnpm. The workspace root comes from `MELRA_WORKSPACE`, else a `MELRA_POLICY`
file's `workspaceRoot` (relative to the file), else the current directory (a
policy file's `workspaceRoot` can also only narrow it to a folder inside), and
is in neither the digest nor any receipt. `--mode`, `MELRA_MODE` and
unsafe-local are recorded on their own: the receipt's `mode` records the first
two, and a decision unsafe-local allowed gives `unhinged_mode_no_guardrails` as
its reason. Receipts carry both under `policyDecision`, the certificate carries
both, and `melra_capabilities` publishes them as `policy.version` and
`policy.digest`. A grant pinned with `policyVersion` is refused
(`capability_policy_version_mismatch`) once the label differs, and so follows
the label rather than the content.

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
- Supported over loopback HTTP: OAuth 2.1 client registration from a client's
  own process (a request carrying an `Origin`, as every browser page's does, is
  refused), browser approval, and per-client identity — an approved client is
  named at the head of the delegation chain on every receipt.
  `MELRA_HTTP_OAUTH=0` turns it off.
- `melra console`: an operator's approval console, a separate loopback HTTP
  server with no MCP endpoint, paired with the first page to use its one-time
  code, normally the browser tab it opens. It
  needs a terminal (`console_needs_a_terminal`) and a browser opener
  (`console_needs_a_browser`), and is never served on a socket or off loopback
  (`approval_console_loopback_only`).
- Packaged: source, portable Node artifact, Python SDK artifact, Docker image.
- Not supported in `0.4`: transports bound to a non-loopback interface,
  multi-tenant hosting.
