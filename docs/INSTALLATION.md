# Installation and client setup

## Everything in one command

If you want a working install without reading the rest of this page:

```bash
npx @melra/cli@alpha setup
```

`setup` writes a safe local policy, prints an MCP client configuration that
names a command your client can actually spawn, and runs every readiness check
— in one step, with nothing installed beforehand. Add
`--client claude|cursor|vscode|codex|generic` to label the configuration for a
specific client. It exits non-zero if any readiness check fails, and it never
overwrites an existing policy.

Paste the printed `mcpServers.melra` object into your client's MCP
configuration and you are done. The rest of this page covers the other install
paths, every environment variable, and the hardened Docker invocation.

## Requirements

- Node.js 22 or newer.
- Chrome, Chromium, or Edge for browser tasks.
- pnpm 9.5 only when building from source.
- Python 3.11 or newer only when using the Python SDK.

Run the readiness check on its own at any time:

```bash
melra doctor
```

The command reports Node, workspace, data-directory, SQLite, browser,
computer-use adapter, and policy readiness without exposing credentials. Unlike
`setup`, it writes nothing.

## Install

Pick one. npm is the shortest path if you already have Node; the container
needs no Node install; the release tarball is a prebuilt Node runtime; source
is for development.

### npm

```bash
npx @melra/cli@alpha setup
```

`@alpha` is the dist-tag for the current alpha. Drop it once a stable release
exists, or pin an exact version such as `@melra/cli@0.3.0-alpha.10`. To keep a
resolved copy on the machine instead of resolving on every run:

```bash
npm install -g @melra/cli@alpha
melra setup
```

Both forms produce a correct client configuration: run through `npx` and the
generated config launches the server through `npx` at the exact version that
wrote it, because an `npx` install leaves no `melra` on your `PATH`.

Packages are published with npm provenance attestation, so the registry links
each tarball to the exact commit and workflow run that produced it.

### Container

```bash
docker run --rm ghcr.io/xagi-lab/melra:alpha doctor
```

Images are published for `linux/amd64` and `linux/arm64` with build
provenance and an SBOM attested to the registry. Use `:alpha` for the latest
alpha or pin an exact tag such as `:v0.3.0-alpha.10`. See
[Docker](#docker) below for the hardened `serve` invocation an MCP client
should use.

### Release tarball

Every tagged release attaches a prebuilt Node runtime. Download it from the
[releases page](https://github.com/XAGI-Lab/melra/releases), verify it against
the published `SHA256SUMS`, then run it:

```bash
tar -xzf melra-node-<version>.tar.gz -C melra
node melra/dist/bin.js doctor
```

Add `melra/dist/bin.js` to your `PATH` as `melra`, or use the full path in
the client configurations below.

### From source

```bash
git clone https://github.com/XAGI-Lab/melra.git
cd melra
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm melra doctor
```

Use `pnpm melra` in place of `melra` in the configurations below.

## Local configuration

MELRA uses these environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `MELRA_WORKSPACE` | Hard boundary for file and process operations | current directory |
| `MELRA_HOME` | SQLite database and browser artifacts | `~/.melra` |
| `MELRA_POLICY` | Optional local policy JSON | safe built-in policy |
| `MELRA_BROWSER` | Chrome, Chromium, or Edge executable | auto-detected |
| `MELRA_PAYLOAD_KEY` | Optional canonical base64url 256-bit payload key | private `<MELRA_HOME>/payload.key` |
| `MELRA_UNHINGED` | Set to `1` to remove every guardrail — see below | unset (all guardrails on) |
| `MELRA_MODE` | `developer` or `enforced` — see [deployment modes](#deployment-modes) | `developer` |
| `MELRA_HTTP_PORT` | Port for `melra serve --http` | `7457` |
| `MELRA_HTTP_TOKEN` | Bearer token for `melra serve --http` | a fresh random token, printed at startup |
| `MELRA_HTTP_OAUTH` | Set to `0` so that token is the only way in and no client can register itself | unset (clients may register, on loopback) |

Back up `payload.key` with the SQLite files. Changing or losing it makes
persisted task and workflow payloads unreadable. Never place it in a client
configuration committed to source control.

These three variables exist for benchmark and diagnostic harnesses. Leave them
unset for normal use, which keeps the default isolated browser behavior:

| Variable | Purpose | Default |
|---|---|---|
| `MELRA_BROWSER_CDP_ENDPOINT` | Attach to an already-running browser over CDP instead of launching one. Must be an `http`/`https` URL with no credentials, query, or fragment. | unset (MELRA launches its own browser) |
| `MELRA_BROWSER_CDP_CONTEXT_INDEX` | Which existing browser context to use, or `-1` for the default context. Requires `MELRA_BROWSER_CDP_ENDPOINT`. | unset |
| `MELRA_BROWSER_HAR_PATH` | Absolute path for an HTTP archive recording of the session, response bodies included so the recording can later be replayed. Treat the file as the session itself, not a log about it. | unset (no recording) |
| `MELRA_BROWSER_HAR_REPLAY` | Absolute path to a recorded archive to serve every request from. Nothing reaches the network, and a request the archive does not contain is aborted rather than fetched. Cannot be combined with recording or CDP. | unset (live network) |

A browser profile is separate, and useful outside benchmarks:

| Variable | Purpose | Default |
|---|---|---|
| `MELRA_BROWSER_PROFILE` | Absolute directory keeping cookies, storage, and profile state between runs, so a site logged into once stays logged in. | unset (a fresh throwaway profile per run) |

Treat that directory as a credential store: it holds live session cookies for
every site the browser visited. It cannot be combined with
`MELRA_BROWSER_CDP_ENDPOINT` — an attached browser already has the profile it
was started with, so a second one would silently do nothing.

A window the page opens by itself is governed by policy, not by the caller:

```json
{ "popups": "block" }
```

`"block"` is the default: the window is closed and reported on the action that
provoked it, as `popups: [{ "url": "...", "blocked": true }]` in the result.
`"allow"` keeps it as an addressable tab. Either way the caller is told — the
setting governs whether the window survives, not whether it is reported, and
`assertSafeUrl` still decides where it may load from. Unsafe-local mode allows
popups, because closing one is MELRA's judgement about what the caller should be
looking at.

Attaching over CDP and recording a HAR are mutually exclusive; setting both
fails at startup. A HAR captures full request and response data, including
cookies, headers, and form bodies — treat the file as a secret and never commit
it.

Generate a safe starter policy and a client configuration without running the
readiness checks:

```bash
melra init --client generic
```

Neither `init` nor `setup` overwrites an existing policy.

The generated policy allows any public browser destination
(`allowedDomains: ["*"]`) and localhost, so browsing works without editing
anything. That list is a *narrowing* control, not the safety boundary: the
browser runtime independently refuses non-`http(s)` protocols, URL credentials,
private and link-local ranges, and cloud metadata (`169.254/16`), and it resolves
DNS before allowing a navigation so a public name cannot be rebound to a private
address. To restrict which public sites are reachable, replace `"*"` with the
domains a task actually needs — `examples/04-browser-inspection/policy.json` is
a worked example that allows only `example.com`.

Mutations default to `"confirm"`: every non-read operation returns a
task-scoped approval phrase that must be echoed back before it runs. Set
`"mutations": "deny"` for a read-only install.

`allowedCommands` matches on the program's basename, so it cannot tell `npm
test` from `npm install left-pad`. `deniedTraits` is the axis that can. MELRA
classifies what a command *reaches for* and refuses a request carrying a denied
trait before the allowlist is consulted:

| Trait | Meaning | Examples |
|---|---|---|
| `package-install` | Resolves and installs third-party code — the one terminal action that adds executable content nobody reviewed. | `npm i`, `pnpm add`, `pip install`, `cargo add`, `npx`, `uvx` |
| `network` | Contacts a host outside this machine. | `curl`, `wget`, `ssh`, `git push`, `git clone`, every browser navigation |

```json
{ "deniedTraits": ["package-install"] }
```

That policy keeps `npm` usable for `npm test` and `npm run build` while refusing
`npm install`, with the reason `trait_denied:package-install`. Denying
`"network"` also stops browser navigation, because browsing is a network act.
The traits are reported on every plan, so an approver sees them before echoing
the phrase back, and `melra policy test` prints them for a request without
running it:

```bash
echo '{"goal":"install","operation":{"kind":"terminal","action":"run","command":"npm","args":["install","left-pad"]},"requiredEvidence":[{"type":"exit_code","value":0}]}' \
  | melra policy test
```

### Capability grants

`deniedTraits` and the allowlists describe what a caller may do. `capabilities`
describes whether it holds any authority at all, and is checked first. It is
empty by default, which means no narrowing — policy behaves exactly as above. A
non-empty list is a closed world: any effect with no matching grant is denied
with `capability_not_granted`, before any allowlist is consulted.

```json
{
  "capabilities": [
    {
      "id": "build-writes",
      "capability": "file.*",
      "effects": ["read", "mutate"],
      "target": "*/build/*",
      "principal": "agent:ci-runner",
      "validUntil": "2026-12-31T00:00:00.000Z"
    }
  ]
}
```

`capability` and `target` are matched against what MELRA classified the
operation as — `file.write`, `terminal.run`, `browser.click` — with `*` standing
for any run of characters. `principal` is matched against the immediate caller
in the request's `identity`, written `kind:id`; a request that declares no
identity is the local principal, `agent:local`. Add `policyVersion` to a grant
to have it refused rather than reinterpreted after the policy changes under it.

A grant may also carry a size. `validUntil` bounds a window; `maxOperations`
bounds how many times the grant may ever be spent inside it, and a `provider`
block bounds money:

```json
{
  "capabilities": [
    {
      "id": "refunds",
      "capability": "http.post",
      "effects": ["mutate"],
      "target": "https://api.acme-pay.com/*",
      "principal": "agent:support",
      "maxOperations": 20,
      "provider": { "name": "acme-pay", "amountMax": 5000, "dailyMax": 25000 }
    }
  ]
}
```

Amounts are minor units — `5000` is $50.00. `amountMax` caps a single call and
`dailyMax` the declared amounts committed in the last 24 hours. The counts are
durable and are drawn down at one point only: where a verified task commits. An
operation that was refused, failed verification, was cancelled, or collapsed
into a duplicate costs nothing, and a restart does not refill the budget.

A `provider` block makes the grant cover *only* operations that declare a
matching `spend` (see [CAPABILITIES.md](CAPABILITIES.md#http)):

```json
{ "kind": "http", "action": "request", "method": "POST",
  "url": "https://api.acme-pay.com/v1/refunds",
  "spend": { "provider": "acme-pay", "amount": 2500, "currency": "USD" } }
```

MELRA cannot read an amount out of an arbitrary provider's payload, so a money
bound needs the caller to state one — and that direction is what makes taking
its word safe. Understating is a lie the grant does not cover, and declaring
nothing means no grant matches at all (`capability_spend_not_declared`).
`name` and `account` compare exactly: `stripe` and `stripe-test` are different
providers. Several grants are several authorities, so one that is spent out does
not refuse work another still covers.

Identity is a claim the layer above makes, not something MELRA authenticates.
Grants are worth what the boundary around your harness is worth, which is why
[the threat model](THREAT_MODEL.md) treats developer mode as convenience rather
than containment. What they buy today is that a receipt records who asked and on
whose behalf, and that one agent's authority can be narrower than the policy
as a whole.

### Credentials

`capabilities` narrow what a caller may do with its own hands. `credentials`
give the kernel a hand the caller does not have: the secret lives here, the
agent never receives it, and the effect still goes out.

```json
{
  "credentials": {
    "billing": {
      "source": { "env": "STRIPE_API_KEY" },
      "inject": { "header": "Authorization", "scheme": "Bearer" },
      "hosts": ["api.stripe.com"],
      "capability": "http.post:https://api.stripe.com/v1/refunds*"
    }
  }
}
```

`source` is either `{ "env": "NAME" }` or `{ "file": "/path" }`. A file must be
a regular file, not a symlink, and mode `0600` or tighter — a secret any other
user can read is one the agent could have read for itself.

The two lists are scoped differently on purpose, and the difference is the
whole feature:

- **`hosts`** — where the secret may travel. A request to a host outside the
  list is sent **unauthenticated**, not refused. A credential that follows
  whatever URL the caller chose is scoped to nothing.
- **`capability`** — what may be done while holding it, matched against
  `<capability>:<target>` as MELRA classified the operation
  (`http.post:https://api.stripe.com/v1/refunds/re_1`). An operation inside
  `hosts` that the capability does not cover is **refused before the secret is
  read**, so a rejected call never brings plaintext into the process.

Nothing else changes: the call is still classified, still policy-checked, still
approval-gated, still verified. The caller's receipt records which credential
authorised the effect by name; the value reaches the socket and nowhere else —
not the plan, not the result, not the receipt, not the database. `melra_capabilities`
publishes the names so a caller knows not to go looking for a key it will never
be given.

Host and capability scoping stay on in `--unsafe-local` mode. That flag lifts the
guardrails MELRA imposes on the caller; a credential's scope is the operator
bounding their own secret, which is a different thing.

Memories are reclaimed on the next `melra_execute` that writes to the same
scope. `memoryRetention.maxAgeDays` (default `30`) is how long an expired or
superseded record is kept after it stops being readable — no search or list can
return one, so removing it changes nothing you can observe, it only stops the
database growing forever. A superseded record survives while a live record still
supersedes it, so `supersedesId` never dangles.

`memoryRetention.maxPerScope` is a hard ceiling on *live* memories per scope and
defaults to `0`, meaning none. It is different in kind: it deletes records you
stored and can still read, oldest first, so it is opt-in.

```json
{ "memoryRetention": { "maxAgeDays": 30, "maxPerScope": 5000 } }
```

`budget.maxRetries` covers a blip inside one task and stops there, so a workflow
whose node keeps failing against the same host would spend every step
rediscovering that. After `circuitBreaker.threshold` consecutive failures
against one target — a path, a host, a command — the next task touching it fails
immediately with `circuit_open:<target>` instead of running, until
`circuitBreaker.cooldownMs` has passed. The first task after the cooldown is the
trial: one success clears the count, another failure re-opens at once. Other
targets are unaffected, a `partial` counts as reaching the target, and a
cancellation counts neither way. `threshold: 0` switches it off, which is also
what unsafe-local mode does.

```json
{ "circuitBreaker": { "threshold": 3, "cooldownMs": 60000 } }
```

The state is per process, so restarting the server starts every target closed.

## Commands that ask a question

A command that stops to prompt would otherwise sit there until its timeout, with
no way to answer. Start it with `interactive: true` so its stdin stays open, read
the prompt back with `output`, then answer it with `send`:

```json
{ "kind": "terminal", "action": "start", "command": "npm", "args": ["init"], "interactive": true }
{ "kind": "terminal", "action": "output", "jobId": "<from start>" }
{ "kind": "terminal", "action": "send", "jobId": "<from start>", "input": "y" }
```

`send` appends a newline unless you pass `appendNewline: false`. It carries no
command of its own, so policy authorises it on the job id it targets — the
allowlist was already checked when that job started, and a `send` with no job id
is refused. Sending to a job that was not started interactively is refused as
`terminal_job_not_interactive` rather than breaking later as a dead pipe.

Stdin is piped, not a terminal. A program that checks whether it owns a TTY and
refuses otherwise — `sudo`'s password prompt, a full-screen TUI — will not work
this way, and `sudo` is denied by policy regardless.

## HTTP server and console

`melra serve` speaks stdio, which is what MCP clients spawn. `melra serve --http`
opens the same runtime — same policy, same database, same receipts — on
`127.0.0.1:7457` instead, for clients that speak Streamable HTTP and for the
browser console:

```bash
melra serve --http            # or --port 8080, or MELRA_HTTP_PORT=8080
melra serve --http --open     # and open the console once it is listening
```

Startup prints, to stderr, the console URL with the token already in it, the MCP
endpoint, and the token on its own line:

```
MELRA HTTP server listening on http://127.0.0.1:7457
  Console:  http://127.0.0.1:7457/?token=<token>
  MCP:      http://127.0.0.1:7457/mcp
  Token:    <token>
A client that cannot be given the token can register itself and ask
you to approve it in a browser; approved clients are named on every
receipt. Set MELRA_HTTP_OAUTH=0 to allow only the token above.
Loopback only. Anyone who can read this token can drive this machine.
```

Every route needs that token, as `Authorization: Bearer <token>` or `?token=`
(the query form exists because `EventSource` cannot set headers). Set
`MELRA_HTTP_TOKEN` to keep it stable across restarts; otherwise a fresh one is
generated each start. **Anyone who can read the token can drive this machine** —
the server binds loopback only, and putting it behind a proxy on a reachable
interface hands out that reach.

### Clients that let themselves in

Pasting a token into a client's configuration is fine for one client you
installed yourself. It stops being fine when several want in, because they all
end up holding the operator's key and every effect any of them dispatches is
recorded under the same anonymous `agent:local`.

So the HTTP server also speaks OAuth 2.1, and what a client gets out of it is a
name. It discovers the flow from the `WWW-Authenticate` header on a `401`,
registers itself (RFC 7591), sends you to a consent page in your browser, and —
once you approve — exchanges an authorization code for a bearer token of its
own, under PKCE S256. Nothing about registration grants anything; approval is
the whole gate, and it is a person.

After that the client is a principal. It becomes `harness:<name>#<id prefix>` —
the name it registered under, plus part of the id MELRA minted, so two clients
calling themselves the same thing stay apart — and that principal is prepended
to the delegation chain of every task it dispatches, ahead of anything the
client declares about itself. A receipt then reads:

```
harness:Claude Code#a91f4c02/subagent:reader
```

rather than `agent:local`. That is the reason to bother: an effect history that
says which client asked.

```bash
melra clients                     # who has registered, and who you approved
melra clients --revoke <id>       # drop that client's tokens
melra clients --revoke all        # drop every issued token
```

Revoking drops tokens, not the registration, so the same client can ask again
and you get to decide again.

The flow is only offered on loopback — approving something in a browser is a
boundary on the machine the browser is on, and a server bound to a wider
interface would otherwise be offering the network a registration endpoint. Set
`MELRA_HTTP_OAUTH=0` to turn it off entirely and keep the operator's token as
the only door.

Details worth knowing if you are reviewing this: issued tokens are stored as
sha256 hashes in a mode-`0600` `oauth.json` under `MELRA_HOME`, an authorization
code is single-use and stays spent even after a failed redemption, redirect URIs
must be loopback or a private scheme so a code cannot be delivered off the
machine, and an MCP session id is bound to the caller that opened it so a leaked
one cannot be used to act under another client's name.

| Route | Method | What it returns |
|---|---|---|
| `/` | `GET` | The console |
| `/mcp` | `POST`/`GET`/`DELETE` | MCP over Streamable HTTP — all eleven tools |
| `/.well-known/oauth-protected-resource` | `GET` | RFC 9728 metadata, unauthenticated |
| `/.well-known/oauth-authorization-server` | `GET` | RFC 8414 metadata, unauthenticated |
| `/oauth/register` | `POST` | RFC 7591 registration; grants nothing on its own |
| `/oauth/authorize` | `GET`/`POST` | The consent page, and your decision |
| `/oauth/token` | `POST` | Authorization code exchange, PKCE S256 |
| `/api/capabilities` | `GET` | The same payload `melra_capabilities` returns |
| `/api/tasks?limit=<n>` | `GET` | Recent tasks, newest first |
| `/api/tasks/:id` | `GET` | One task's status |
| `/api/tasks/:id/receipts` | `GET` | That task's receipts |
| `/api/workflows` | `GET` | Every workflow run |
| `/api/workflows/:id` | `GET` | One run's projection, node by node |
| `/api/workflows/:id/events?after=<sequence>` | `GET` | Append-only events after a cursor |
| `/api/workflows/:id/stream?after=<sequence>` | `GET` | The same events as SSE, replayed from the cursor and then followed live |

The JSON API is read-only and answers `405` to anything but `GET`. Planning and
advancing stay on the MCP and CLI paths, so nothing reachable from a browser tab
can start work policy has not seen. Each SSE frame carries the event's
`sequence`, so a client that reconnects with `after=<last sequence>` resumes
without gaps.

The console is one self-contained page with no build step and no external
requests: the posture you are running under (including a red banner in unsafe-local
mode), every workflow run, each node's status, and a live event tail.

## Deployment modes

MELRA governs the effects it is asked for. It cannot see whether the harness
above it also holds a native terminal — and a harness holding both makes MELRA
optional, which is not a trust boundary. `MELRA_MODE` is where you say which of
those two situations you are in.

| Mode | What it means |
|---|---|
| `developer` (default) | MELRA governs what it is asked for. The harness may have another path to the same systems, and you accept that. This is the reason MELRA can be tried in thirty seconds. |
| `enforced` | You are asserting the alternative has been removed: the harness is sandboxed, holds no privileged secrets, and reaches these systems only through here. |

MELRA cannot verify that assertion from inside its own process — the isolation
is the operating system's job, and enforced mode deliberately does not reinvent
it. Bring a container, a separate OS user, a sandbox profile, or filesystem
ACLs. What MELRA does is stop being one of the ways the claim could be false, by
closing every door it owns:

- **`--unsafe-local` is refused outright.** A mode whose point is that the
  boundary cannot be bypassed cannot also ship a bypass flag. Either flag or
  variable, the process exits with `enforced_mode_refuses_unsafe_local` before
  anything runs.
- **No bind outside loopback.** `serve --http --host 0.0.0.0` fails with
  `enforced_mode_refuses_public_bind`. A sandbox talks to its kernel over IPC; a
  listener on a routable interface is a machine-control API on a network.
- **No client registers itself.** The OAuth registration endpoints are not
  served at all, on loopback or anywhere else. Enforced mode admits service
  identities the operator issued, and nothing that asks to be let in — so the
  bearer token is the only way in.
- **Every receipt says `enforced`.** `ActionReceipt.mode` records it, and
  `melra_capabilities` publishes `policy.mode`, so an auditor never has to infer
  whether an effect was governed by the only door or by one of several.

Deliberately not refused: running as root. Enforced mode exists for containers,
and a container process is usually root inside it.

Set it whichever way suits the deployment — `MELRA_MODE=enforced`, `--mode
enforced`, or `"mode": "enforced"` in the policy JSON. The strictest of the three
wins, so a policy file that pinned it is not loosened by an unset variable, and a
typo (`MELRA_MODE=enfroced`) fails loudly rather than leaving a machine in
developer mode with a config that claims otherwise.

A `melra conformance` run against an enforced endpoint keeps the same level — the
mode does not earn checks — but its first `notProven` entry narrows from "nothing
observable rules out a second path" to naming whose word the remaining claim
rests on. See [CONFORMANCE.md](CONFORMANCE.md).

## Unsafe-local mode

`melra serve --unsafe-local` (or `MELRA_UNHINGED=1`) runs MELRA with no
guardrails at
all. Use it when you want the agent to have exactly the reach your own shell has
and you accept the consequences. It applies to every command in the process, not
just `serve`.

The flag was originally called `--unhinged`, which still works and prints a
deprecation line: it named a mood rather than what it does, which is opt out of
the entire safety model.

What is off, precisely:

- **Policy.** Every operation is allowed. Command allowlists, the unconditional
  shell and `sudo` deny, and the mutation risk rules do not apply.
- **Approvals.** No challenge is issued, so nothing has to be echoed back before
  a destructive operation runs.
- **Evidence.** A mutation with no `requiredEvidence` is allowed instead of
  denied. Nothing is verified that you did not ask to be verified.
- **Workspace confinement.** File and terminal operations are rooted at the
  filesystem root instead of `MELRA_WORKSPACE`, so any path the OS user can
  reach is reachable. The verifier is rooted there too.
- **Browser destinations.** `assertSafeUrl` asserts nothing: localhost, private
  ranges, cloud metadata endpoints, URL credentials, and non-`http(s)` schemes
  all pass.

What stays on, and why:

- Limits you declare on your own request. `forbiddenEffects` and `constraints`
  are your bound on your own task, not MELRA's guardrail, so they still deny.
- `maxFileBytes` and the duration budget. An unbounded read is a way to crash
  the host, not a restriction on what you are allowed to touch.
- Receipts and certificates. A destructive operation is still recorded as
  destructive; allowing everything is not the same as reporting nothing.
- Secret redaction before persistence. Raw output still reaches the caller; the
  database still gets the redacted copy.

The mode cannot run invisibly. Every CLI invocation prints a banner to stderr
(stdout is the MCP transport, so prose there would corrupt the protocol — MCP
clients surface stderr in their server logs), `melra doctor` reports
`"unhinged": true` with a `guardrails` check of `warn`, and `melra_capabilities`
returns `policy.unhinged: true` with `defaultPosture: "unhinged"` so a connected
agent can see there is nothing stopping it.

Only `1`, `true`, `yes`, and `on` enable it. A stray `MELRA_UNHINGED=0` left in a
shell profile will not silently disarm the machine.

Do not use it against a workspace you did not create, with a model or prompt you
do not control, or on a machine holding credentials you cannot rotate.

## MCP clients

Use the client’s `mcpServers` configuration field:

```json
{
  "mcpServers": {
    "melra": {
      "command": "melra",
      "args": ["serve"],
      "env": {
        "MELRA_WORKSPACE": "/absolute/path/to/your/workspace",
        "MELRA_HOME": "/absolute/path/to/local/melra-data",
        "MELRA_POLICY": "/absolute/path/to/local/melra-data/policy.json"
      }
    }
  }
}
```

If you have not installed anything, `npx` needs no install step at all — the
client resolves the package itself:

```json
{
  "mcpServers": {
    "melra": {
      "command": "npx",
      "args": ["-y", "@melra/cli@alpha", "serve"],
      "env": {
        "MELRA_WORKSPACE": "/absolute/path/to/your/workspace",
        "MELRA_HOME": "/absolute/path/to/local/melra-data",
        "MELRA_POLICY": "/absolute/path/to/local/melra-data/policy.json"
      }
    }
  }
}
```

Pin an exact version instead of `@alpha` if you want the server to stay fixed
until you change it; `@alpha` picks up each new alpha on first launch.

Otherwise replace `melra` with the absolute path to `dist/bin.js` from the
release tarball, or use `docker` with the arguments in [Docker](#docker) below.

This structure is accepted by Claude Desktop and clients that implement the
common MCP server configuration format. Cursor and VS Code use the same command,
arguments, and environment values but may place them under their own MCP
settings UI or file. Always follow the current client documentation for the
configuration-file location.

The repository’s automated compatibility claim is the official MCP SDK over
stdio. Named graphical clients remain release-gated until their current
versions have been manually exercised; see [VALIDATION.md](VALIDATION.md).

## Ordinary tool names

The eleven `melra_*` tools are the kernel’s own vocabulary. A model asked to
plan, read back an approval challenge, and execute for every small read spends
most of its turn on ceremony, so there is a second surface with the names a
harness already knows:

```json
{ "env": { "MELRA_HARNESS_TOOLS": "1" } }
```

That adds thirteen tools alongside the eleven: `read_file`, `list_files`,
`write_file`, `move_file`, `delete_file`, `run_command`, `browse`,
`browser_read`, `browser_click`, `browser_type`, `remember`, `recall`, and
`approve`. It is off by default — a client showing all twenty-four at once buys
confusion rather than convenience.

Nothing here is a shortcut past a stage. Each call builds an ordinary task and
hands it to the same controller, so policy, evidence, verification, and receipts
apply exactly as they do to `melra_plan`. What changes is how a mutation is
reported: instead of failing, the tool comes back with the phrase.

```json
{
  "status": "approval_required",
  "taskId": "0f0e…",
  "phrase": "APPROVE 3d81c0a2f4b7",
  "expiresAt": "2026-08-08T20:44:11.204Z",
  "next": "Show the phrase to the person who has to authorise this, then call `approve` with this taskId and the phrase they confirm."
}
```

`approve` takes that task id and that phrase and runs the operation that was
approved. It cannot change anything about it — the phrase is a hash of the task
id and the operation together, so approved arguments cannot be swapped for
others afterwards. A policy denial comes back the same way, as a result with
`status: "blocked"` and a reason, rather than an error.

Everything else stays reachable: the task id in every response is what
`melra_receipt` takes, so the evidence and the certificate are one call away.

## Docker

Build and check the image:

```bash
docker build -t melra:local .
docker run --rm melra:local doctor
```

Run the stdio server with explicit writable boundaries:

```bash
docker run --rm -i \
  --read-only \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --tmpfs /tmp:size=256m,mode=1777 \
  -v "$PWD:/workspace" \
  -v melra-data:/data \
  melra:local serve
```

For an MCP client, set `command` to `docker` and use the arguments above,
including `-i`. Do not use `-t`; stdio MCP requires clean JSON-RPC streams.

## Python SDK

For repository development:

```bash
uv sync --project sdk-py
uv run --project sdk-py pytest sdk-py
```

Both SDKs expose task and durable workflow methods. They launch or connect to
the same stdio server and do not implement a separate execution engine.

## Uninstall and local-data deletion

Stop all clients using the server, remove the installed package or container,
then delete the directory configured by `MELRA_HOME`. That directory is the
complete local persistence boundary for tasks, workflows, events, encrypted
payloads, receipts, certificates, memory, keys, and browser artifacts.
Workspace files changed by approved tasks are not deleted automatically.
