# Installation and client setup

## Everything in one command

If you want a working install without reading the rest of this page:

```bash
npx @melra/cli@alpha setup
```

`setup` writes a safe local policy, prints an MCP client configuration that
names a command your client can actually spawn, and runs every readiness check
— in one step, with nothing installed beforehand. It exits non-zero if any
readiness check fails, and it never overwrites an existing policy.

Run it from the directory the agent should work in. That directory becomes the
workspace, the boundary for the agent's file and command operations, which
the config carries as `MELRA_WORKSPACE` and `setup` shows as `Workspace`.
If it would be your home directory, a directory holding it (such as `/Users`
or `/home`), or a filesystem root (`/`, or a drive root on Windows), `setup`
and `init` say so and ask, defaulting to no; where nobody can answer (piped,
captured, or with `--json`) they refuse with `workspace_too_broad` and write
nothing. Set `MELRA_WORKSPACE` to choose the workspace yourself, home
included, without the question. When a `MELRA_POLICY` file's `workspaceRoot`
sets the workspace, the working directory does not count: change it there,
or set `MELRA_WORKSPACE`.

In a terminal it asks which client to set up, listing the ones it finds on
this machine first, then offers to write the config for you:

```text
Which MCP client should use MELRA?

  1)   Cursor            detected: config file found
  2)   Claude Code       detected: 'claude' on PATH
  ...
  26)  generic (just print the config)

Choose 1-26 [1]: 1
Write it into /home/you/.cursor/mcp.json? [Y/n]

  ✓  Workspace  /home/you/project
  ✓  Policy     /home/you/.melra/policy.json
  ✓  Cursor     /home/you/.cursor/mcp.json
                previous file saved as /home/you/.cursor/mcp.json.bak

Next: Restart Cursor, then ask it to use the melra tools.

✓ Ready
```

Ctrl-C or Ctrl-D at either question exits with status 130 and writes nothing;
anything but `y` at the workspace question exits with status 1, likewise.
Piped, captured, or run with `--json`, `setup`, `init`, and `doctor` ask
nothing and print the same JSON they always have, plus the `workspace` the
config names, so scripts and CI are unaffected unless the workspace would be
home, a directory holding it, or a filesystem root (see above); `NO_COLOR`
turns the colours off.

Name your client and MELRA writes itself into that client's own config file,
in that client's own format, keeping everything already there and saving the
previous file as `<file>.bak`:

```bash
npx @melra/cli@alpha setup --client cursor --write
```

Leave out `--write` to print the config and the path it belongs in instead; see
[MCP clients](#mcp-clients) for every supported client. With no `--client`
outside a terminal (or choosing `generic`), paste the printed `mcpServers.melra` object into your client's MCP
configuration and you are done. The rest of this page covers the other install
paths, every environment variable, and the hardened Docker invocation.

## Requirements

- Node.js 22.13 or newer, or 23.4 or newer.
- Chrome, Chromium, or Edge for browser tasks.
- pnpm 9.5 only when building from source.
- Python 3.11 or newer only when using the Python SDK.

Run the readiness check on its own at any time:

```bash
melra doctor
```

The command reports Node, guardrails, deployment mode, workspace,
data-directory (and whether it sits inside the workspace, which enforced mode
refuses), SQLite, browser, computer-use adapter, and policy readiness —
plus the `MELRA_SOCKET` path when one is set, the OS isolation in effect (see
[Docker](#docker)), and MCP clients — without exposing credentials. Unlike
`setup`, it changes no configuration: the only thing it may create is the data
directory, if it does not exist yet.

In a terminal it prints one line per check, one line per client under
`clients`, a verdict, and — when something warns or fails — the one command
to run next:

```text
  ✓  browser         /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  ✓  policy          /home/you/.melra/policy.json
  ⚠  clients
      ⚠  cursor  configured  pinned to @melra/cli@0.2.0, this is 0.3.0-alpha.12; fix: …

⚠ Ready, with 1 warning
Next: melra setup --client cursor --write
```

`melra doctor --json`, or any pipe, prints the JSON report instead.

It also reports, under `clients`, every MCP client whose config file exists
(the same files `setup --client <name> --write` targets): whether MELRA is
configured there, whether the configured command is on `PATH`, and whether an
`npx` launch is pinned to an older `@melra/cli` than the one running, with the
`melra setup --client <name> --write` command that repoints it. A file with
comments, such as Zed's, is searched as text and says so. Client findings are a
`warn` at most, never a `fail`: no client configured is a normal state when you
use MELRA through an SDK. The check reads those files and never edits them.

## Install

Pick one. npm is the shortest path if you already have Node; the container
needs no Node install; the release tarball is a prebuilt Node runtime; source
is for development.

### npm

```bash
npx @melra/cli@alpha setup
```

`@alpha` is the dist-tag for the current alpha. Drop it once a stable release
exists, or pin an exact version such as `@melra/cli@0.3.0-alpha.12`. To keep a
resolved copy on the machine instead of resolving on every run:

```bash
npm install -g @melra/cli@alpha
melra setup
```

Both forms produce a correct client configuration: run through `npx` and the
generated config launches the server through `npx` at the exact version that
wrote it, because an `npx` install leaves no `melra` on your `PATH`.

Packages are registry-signed, which `npm audit signatures` checks. Starting with
`0.3.0-alpha.13`, GitHub Actions trusted publishing attaches npm provenance
linking each tarball to the exact commit and workflow run that built it. Releases
through `0.3.0-alpha.12` used legacy publishing and lack npm provenance. The
GitHub release files and the container image also carry signed build attestations
(see [RELEASES](RELEASES.md)).

### Container

```bash
docker run --rm ghcr.io/xagi-lab/melra:alpha doctor
```

Images are published for `linux/amd64` and `linux/arm64` with build
provenance and an SBOM attested to the registry. `:alpha`, `:beta` and `:rc`
follow only their own channel, like the npm dist-tags of the same name, so
`:alpha` stays on the last alpha once betas begin. `:latest` follows every
release before 1.0, as npm's `latest` does, from `0.3.0-alpha.15`. Or pin an
exact tag such as `:v0.3.0-alpha.15`. See
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

### Single executable (experimental)

One file with Node inside, for machines that should not need Node installed.
Each GitHub release attaches one per platform: `melra-<version>-linux-x64`,
`-linux-arm64`, `-darwin-arm64` (Apple silicon; there is no Intel macOS
build), and `-win-x64.exe`. They are covered by the release's `SHA256SUMS` and
its signed provenance attestation, so check one before running it:

```bash
sha256sum --check --ignore-missing SHA256SUMS &&
  gh attestation verify melra-<version>-linux-x64 --repo XAGI-Lab/melra &&
  chmod +x melra-<version>-linux-x64 && ./melra-<version>-linux-x64 doctor
```

They are not code-signed. macOS quarantines a downloaded copy until you clear
it (`xattr -d com.apple.quarantine melra-<version>-darwin-arm64`, after
checking it as above), and Windows SmartScreen warns before the first run. To
build one yourself instead, for the platform you build on:

```bash
pnpm build:sea          # needs Node 25+ to build; the result needs no Node
./dist-sea/melra doctor
```

The binary is about 150 MB and carries the Node that built it. `melra setup`
run from it writes the binary's absolute path into client configs, since a
client may not launch with it on `PATH`. On macOS the build adds an ad-hoc
signature, the minimum Apple Silicon will run; Developer ID signing and
notarization would let a downloaded copy past Gatekeeper without the step
above. CI builds it for all four platforms on every change and checks `doctor`
and conformance L3 against it with only the system directories on `PATH`; a
release attaches exactly those builds.

## Local configuration

MELRA uses these environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `MELRA_WORKSPACE` | Hard boundary for file and process operations; a policy file's `workspaceRoot` can only narrow it to a directory inside. `setup` and `init` write it into the client config, and ask before making home, a directory holding it, or a filesystem root the workspace unless it is set | the `workspaceRoot` of a `MELRA_POLICY` file, else the current directory |
| `MELRA_HOME` | SQLite database and browser artifacts. It must not be the workspace or hold it: a workspace inside it, even through a link, is refused at startup with `workspace_inside_data_directory`. On a case-sensitive filesystem a sibling whose name differs from it only in case is reserved too | `~/.melra` |
| `MELRA_POLICY` | Optional local policy JSON. Every start reads it again, so wherever it lies it is reserved like `MELRA_HOME`: no file effect, verification or browser upload may name it, nor a terminal argument as a path or a plain `@`/`<` reference, and no file effect removes or moves a directory holding it. A workspace holding it is still an ordinary one | safe built-in policy |
| `MELRA_BROWSER` | Chrome, Chromium, or Edge executable | auto-detected |
| `MELRA_PAYLOAD_KEY` | Optional canonical base64url 256-bit payload key | private `<MELRA_HOME>/payload.key` |
| `MELRA_UNHINGED` | Set to `1` to remove every guardrail — see below | unset (all guardrails on) |
| `MELRA_MODE` | `developer` or `enforced` — see [deployment modes](#deployment-modes) | `developer` |
| `MELRA_APPROVER` | The name [`melra approve`](#approving-from-the-command-line) records as the approver, as `cli:<name>`, [`melra judge`](#judging-from-the-command-line) as the judge of a verdict, also as `cli:<name>`, and [`melra console`](#approving-in-a-browser) as `console:<name>`. Letters (any script), digits, `.`, `_`, `@` and `-`, at most 64; checked when `melra approve`, `melra judge` or `melra run` records a decision, and when `melra console` starts. Receipts and certificates carry it, and an agent can read both. | `operator` |
| `MELRA_HTTP_PORT` | Port for `melra serve --http` | `7457` |
| `MELRA_HTTP_TOKEN` | Bearer token for `melra serve --http` | a fresh random token, printed at startup |
| `MELRA_HTTP_OAUTH` | Set to `0` so that token is the only way in and no client can register itself | unset (clients may register, on loopback) |
| `MELRA_SOCKET` | Unix socket path that `melra doctor` checks and `melra status` probes. It does not move `melra serve` off stdio; pass `--socket <path>` for that — see [over a Unix socket](#over-a-unix-socket). Not on Windows | unset |
| `MELRA_HARNESS_TOOLS` | Set to `1` (or `true`, `yes`, `on`) to add thirteen plainly named tools such as `read_file` and `run_command` alongside the twelve `melra_*` tools — see [ordinary tool names](#ordinary-tool-names) | unset (only the `melra_*` tools) |

Back up `payload.key` with the SQLite files. Changing or losing it makes
persisted task and workflow payloads unreadable. Never place it in a client
configuration committed to source control.

These four variables exist for benchmark and diagnostic harnesses. Leave them
unset for normal use, which keeps the default isolated browser behavior:

| Variable | Purpose | Default |
|---|---|---|
| `MELRA_BROWSER_CDP_ENDPOINT` | Attach to an already-running browser over CDP instead of launching one. Must be an `http`/`https` URL with no credentials, query, or fragment. | unset (MELRA launches its own browser) |
| `MELRA_BROWSER_CDP_CONTEXT_INDEX` | Which existing browser context to use, or `-1` for the default context. Requires `MELRA_BROWSER_CDP_ENDPOINT`. | unset |
| `MELRA_BROWSER_HAR_PATH` | Absolute path for an HTTP archive recording of the session, response bodies included so the recording can later be replayed. Treat the file as the session itself, not a log about it: it is reserved like `MELRA_POLICY`, and its directory is made at startup | unset (no recording) |
| `MELRA_BROWSER_HAR_REPLAY` | Absolute path to a recorded archive to serve every request from. Nothing reaches the network, and a request the archive does not contain is aborted rather than fetched. Cannot be combined with recording or CDP. Reserved like `MELRA_POLICY` | unset (live network) |

A browser profile is separate, and useful outside benchmarks:

| Variable | Purpose | Default |
|---|---|---|
| `MELRA_BROWSER_PROFILE` | Absolute directory keeping cookies, storage, and profile state between runs, so a site logged into once stays logged in. Reserved like `MELRA_POLICY`; a workspace inside it is refused at startup with `workspace_inside_browser_profile` | unset (a fresh throwaway profile per run) |

Treat that directory as a credential store: it holds live session cookies for
every site the browser visited. So does MELRA: no file effect, verification
or browser upload may name it or anything in it, nor a terminal argument as a
path or a plain `@`/`<` reference, in any mode, and enforced mode refuses to
start in a workspace that holds it, or either HTTP archive
(`enforced_mode_refuses_secret_inside_workspace`). It cannot be combined with
`MELRA_BROWSER_CDP_ENDPOINT` — an attached browser already has the profile it
was started with, so a second one would silently do nothing.

A window the page opens by itself is governed by policy, not by the caller:

```json
{ "popups": "block" }
```

`"block"` is the default: the window is closed and reported on the action that
provoked it, as `popups: [{ "url": "...", "blocked": true }]` in the result.
An action that opened a window waits, up to its own `timeoutMs`, for that
window's first response, so a slow popup still lands on the right result.
`"allow"` keeps it as an addressable tab. Either way the caller is told — the
setting governs whether the window survives, not whether it is reported, and
`assertSafeUrl` still decides where it may load from. Unsafe-local mode allows
popups, because closing one is MELRA's judgement about what the caller should be
looking at. A reported popup's URL leaves out its fragment. In a browser the
runtime is attached to over CDP, a tab Chromium creates between its actions is
the operator's unless it is the runtime's: one it opened, a window one of those
opened (down any chain), or one opened by the tab it is driving, which a tab it
merely landed on becomes only once it navigates it or sends it input (an
action refused, or one whose target was never found, does not count). The
operator's is left open and not reported. While an action runs, a new window
is that action's popup, closed and reported like any, unless Chromium names one
of the operator's tabs as its opener, or it has no opener and Chromium creates
it blank or at one of its own pages: a tab another CDP client opens, or one you
open from the toolbar. No page can have the browser open one of those. A tab
that starts at a web address is the action's, because a page can have the
browser open one for it (a sign-in window, say), and so is one `melra console`
or another app hands the browser while an action runs: open the console while
the agent is idle, or use `melra approve`. A tab the runtime only landed on
stays yours while it reads it; what that tab opens while the runtime navigates
it or sends it input is the action's. A tab a link opens with a modifier or
middle click has no opener and starts out empty, whichever page it came from,
so it counts by when it is created: between actions as the operator's, left
open and not reported but listed by `tabs` with its loads still checked, and
while an action runs as that action's popup. A window that closes before the
runtime can tell whose it is, such as a tab that turns into a download, is
reported either way. What is the
runtime's lasts as long as it stays attached: after MELRA restarts, or
reconnects to the browser, the tabs it opened before count as the operator's
until it navigates one or sends it input again.

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

The policy file is read strictly. Every key is optional, but a key MELRA does
not know, at any depth, or a value of the wrong type stops the server from
starting rather than falling back to the default, with every problem named by
its path:

```text
melra: policy_invalid: /home/you/.melra/policy.json: allowedComands: unknown key
melra: policy_invalid: /home/you/.melra/policy.json: unhinged: Invalid input: expected boolean, received string
melra: policy_invalid: /home/you/.melra/policy.json: not valid JSON at line 3 column 1
```

A file that is not JSON is never quoted, so the message is safe to paste into
a bug report. Where Node reports the position it is named by line and column;
for some mistakes, such as a trailing comma in a list, a comment or a bare
word, Node gives none and the message says only `not valid JSON`.

The keys are `version`, `workspaceRoot`, `allowedCommands`, `allowedDomains`,
`allowLocalhost`, `popups`, `mutations`, `approvalTtlMs`, `maxFileBytes`,
`memoryRetention`, `deniedTraits`, `capabilities`, `credentials`,
`circuitBreaker`, `unhinged` and `mode`; there is no comment or `$schema`
key. `melra doctor` fails its `policy` check with the same message, `melra
policy test` prints it, and `melra status` and `melra tasks` report it
(`policyError` in their JSON).

The generated policy allows any public browser destination
(`allowedDomains: ["*"]`) and, in developer mode, localhost, so browsing works
without editing anything. That list is a *narrowing* control, not the safety boundary: the
browser runtime independently refuses non-`http(s)` protocols, URL credentials,
private and link-local ranges, and cloud metadata (`169.254/16`), and it resolves
DNS before allowing a navigation so a public name cannot be rebound to a private
address. To restrict which public sites are reachable, replace `"*"` with the
domains a task actually needs — `examples/04-browser-inspection/policy.json` is
a worked example that allows only `example.com`.

`allowLocalhost` decides whether HTTP and browser effects may reach this
machine's loopback names and addresses (`localhost`, `127.0.0.0/8`, `::1`).
Left out, it follows the mode: open in developer mode, closed in enforced mode.
A `policy.json` that `melra init` or `melra setup` wrote with an earlier
release sets `"allowLocalhost": true`, which keeps loopback open in enforced
mode too; delete that key unless a task needs a service on this machine.

Mutations default to `"confirm"`: every non-read operation returns a
task-scoped approval challenge and runs only once it is approved. In developer
mode the challenge carries a phrase to echo back; in enforced mode it carries
none, and an operator approves with
[`melra approve`](#approving-from-the-command-line). Set
`"mutations": "deny"` for a read-only install. A challenge stays open for
`approvalTtlMs`: 5 minutes by default in developer mode and 30 in enforced
mode, where an operator approves out of band; a value the policy file sets
(a whole number of milliseconds, at most 24 hours) applies in either mode. It
also bounds how long a task waits on a `semantic` question before it settles
closed. A
`policy.json` that `melra init` or `melra setup` wrote with an earlier release
pins `"approvalTtlMs": 300000`; delete that key to get the mode's default.

A bare name in `allowedCommands` runs the program `PATH` finds there, looked
up only in `PATH` entries outside the workspace: an entry inside it (a
project's `node_modules/.bin`, a `bin/` directory), or an empty or relative
one, is skipped, and left out of the program's own `PATH` too. A tool
installed only inside the workspace runs through `npx` or `pnpm exec`, or
through a path-qualified entry in `allowedCommands` that names it. If no
entry is left, as with a workspace at the filesystem root, or `PATH` is not
set at all, every command is refused with `terminal_path_empty_after_filter`,
a path-qualified one too, because a program given an empty `PATH`, or none,
may search the working directory; narrow the workspace. With `--unsafe-local`, `PATH` is used as
given.

`allowedCommands` matches on the program's basename, so it cannot tell `npm
test` from `npm install left-pad`. `deniedTraits` is the axis that can. MELRA
classifies what a command *reaches for* and refuses a request carrying a denied
trait before the allowlist is consulted:

| Trait | Meaning | Carried by |
|---|---|---|
| `package-install` | Resolves and installs third-party code — the one terminal action that adds executable content nobody reviewed. | Every call to `npm`, `npx`, `pnpm`, `pnpx`, `yarn`, `corepack`, `pip` with or without a version (`pip3`, `pip3.12`, `pip-3.12`), `pipx`, `uv`, `uvx`, `cargo`, `go` and its golang.org/dl wrappers (`go1.22.0`, `go1.23rc1`, `gotip`), `gem`, `brew`, `apt` or `apt-get`, except an `npm` call that only runs a package script: `npm run`, `npm run-script`, `npm test`, `npm start`, `npm stop` or `npm restart`, as its first argument |
| `network` | Contacts a host outside this machine. | Everything that carries `package-install`; `curl`, `wget`, `wget2`, `ssh`, `slogin`, `dbclient`, `scp`, `sftp`, `rsync`, `rsync-ssl`, `nc`, `ncat`, `netcat`, `nc.openbsd`, `nc.traditional`, `telnet`, `inetutils-telnet`, `telnet-ssl`, `ftp`, `inetutils-ftp`, `tnftp`, `tftp`, `plink`, `pscp` and `psftp`; every `git` call except one whose first argument is a local subcommand (`status`, `log`, `diff`, `add`, `commit`, `checkout`, `switch`, `merge`, `stash`, ...; not `config`, `rebase` or `grep`, each of which can be told to run another program); every command given a Windows network path (`\\host\share`, `//host/share`) as an argument or as an option's value; every browser navigation and HTTP call |

The rule is closed: a call to one of these programs carries the trait unless
it is positively known not to, so an alias, an abbreviation, a different
casing, or an option before the subcommand (`npm --silent run build`,
`git -C sub status`) carries it too. A trait describes what the call itself
asks for: what a package script, a git hook, or the repository's own git
configuration goes on to do is not classified (a partial clone fetches missing
objects when a local subcommand needs them, and a filter such as Git LFS's can
download content on checkout). Nor is a program the table does not name,
such as `socat` or an interpreter like `node`, beyond a network path argument.

```json
{ "deniedTraits": ["package-install"] }
```

That policy keeps `npm` usable for `npm test` and `npm run build` while refusing
`npm install`, with the reason `trait_denied:package-install`. Denying
`"network"` also stops browser navigation, because browsing is a network act.
The traits are reported on every plan, so an approver sees them before
approving, and `melra policy test` prints them for a request without
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
A memory target is `<scope>:<action>:<id or key>`, except that `list`,
`search` and `clear`, which act on the whole scope, are `<scope>:<action>:*`
whatever key or id they name, so a grant scoped to keys does not cover them (see
[CAPABILITIES.md](CAPABILITIES.md#identity-and-capability-grants)).

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
durable and are drawn down once per task whenever the adapter may have done the
work, whatever the evidence then says: a `partial` task or a change left
`recovery_required` pays as a verified one does. An operation refused by
policy, cancelled before the adapter ran, stopped by an adapter error saying
nothing went out, or stopped as a duplicate before it ran costs nothing, and a
restart does not refill the budget. A workflow's compensations draw on the same
grants, so size one for every forward step that may run plus the compensations
that would undo them. See
[CAPABILITIES.md](CAPABILITIES.md#identity-and-capability-grants) for the exact rule.

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
user can read is one the agent could have read for itself. Wherever it lies,
the file is reserved like `MELRA_POLICY`: no file effect, verification or
browser upload may name it, nor a terminal argument as a path or a plain
`@`/`<` reference, and enforced mode refuses to start in a workspace that
holds it (`enforced_mode_refuses_secret_inside_workspace`). A program that
reads files by means of its own is not covered, which is what approving that
program accepts. Keep it outside the workspace. The value (a file's with
surrounding whitespace trimmed) must be printable ASCII; one holding any other
character is refused with `credential_source_invalid:<name>`, so a copy echoed
back is matched byte for byte. A variable that is unset or empty is refused
with `credential_source_missing:<name>`; a file that is empty or holds only
whitespace with `credential_file_empty`, and one that is missing or unreadable
with its own error. Either way every call to a host in `hosts` fails before
anything is sent: a credential whose source is missing never falls back to an
unauthenticated call.

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
not the plan, not the result, not the receipt, not the database. A provider
that echoes the value back, in its reason phrase, a header or the body, has it
replaced with `[REDACTED_CREDENTIAL]` before the result reaches anyone; only a
copy as sent is recognised, not one the provider encoded or altered. `melra_capabilities`
publishes the names so a caller knows not to go looking for a key it will never
be given.

Host and capability scoping stay on in `--unsafe-local` mode. That flag lifts the
guardrails MELRA imposes on the caller; a credential's scope is the operator
bounding their own secret, which is a different thing.

Memories are reclaimed on the next `melra_execute` that writes to the same
scope. `memoryRetention.maxAgeDays` (default `30`) is how long an expired or
superseded record is kept after it stops being readable — no search or list can
return one, and removing it stops the database growing forever. A superseded
record survives while a live record still supersedes it. Deleting the record
that superseded another, or editing it to supersede something else or nothing,
makes the one it replaced live again; deleting one in the middle of a chain
links the records on either side, so the latest stays the only live one. So
undoing the latest correction always brings back the one before it, but going
back further, deleting a second correction too, finds an older record only
within `maxAgeDays` of its replacement: after that compaction may have reclaimed
it, and deleting both corrections leaves nothing for that key. A correction that expires, or that
`maxPerScope` evicts, does not revive anything: its removal says the correction
has lapsed or made room, not that the fact it replaced is true again, so that
fact stays unreadable and compaction later reclaims it.

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
melra serve --http            # or --http --port 8080, or MELRA_HTTP_PORT=8080
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
you to approve it in a browser, with the token above; approved clients
are named on every receipt. Set MELRA_HTTP_OAUTH=0 to allow only the token.
Loopback only. Anyone who can read this token can drive this machine.
```

`--open` does not hand the browser that URL. A program's command line can be
read by other users of the machine (`ps`), and the token is good for as long as
the server runs, so the opener gets `http://127.0.0.1:7457/open?code=<code>`
instead: a link that sends the browser on to the console URL once, and is
refused after that (`403 open_code_used`) or once a minute has passed since
startup (`403 open_code_invalid`). If the browser was slower than that, open
the printed Console URL yourself. If it says the link was already used and you
did not use it, someone else has the token: restart the server so the token
changes (set a new `MELRA_HTTP_TOKEN` if you fixed one), and revoke any client
in `melra clients` you did not approve (`melra clients --revoke <id>`, or
`all`), since an approved client keeps its access across restarts.

Every other route needs that token, as `Authorization: Bearer <token>` or
`?token=` (the query form exists because `EventSource` cannot set headers). Set
`MELRA_HTTP_TOKEN` to keep it stable across restarts; otherwise a fresh one is
generated each start. **Anyone who can read the token can drive this machine** —
the server binds loopback only, and putting it behind a proxy on a reachable
interface hands out that reach.

Each MCP client gets its own session, which lasts until the client ends it
(both SDKs do, on close) or the server stops. Past 256 sessions, a new one ends
the least recently used session with no request in flight and no event stream
open: a client that vanished without ending its own, or one that only posts and
has been quiet longest. A client that keeps the MCP event stream open, as both
SDKs do, is never ended while connected. A request
naming a session the server no longer has, such as one from before a restart,
gets 404, which tells an MCP client to start a new session.

The console this server serves is read-only, and the server has no approval
route. To approve in a browser, run [`melra console`](#approving-in-a-browser),
a separate process.

### Over a Unix socket

A loopback port is reachable by every process on the machine; the token is all
that stands between them and the kernel. A Unix-domain socket can be narrower
than that, and the operating system enforces it:

```bash
melra serve --socket "$XDG_RUNTIME_DIR/melra.sock"
curl --unix-socket "$XDG_RUNTIME_DIR/melra.sock" \
  -H "Authorization: Bearer $MELRA_HTTP_TOKEN" http://localhost/api/capabilities
```

It serves exactly what `--http` serves — Streamable HTTP MCP at `/mcp`, the
read-only JSON API, the event stream, and the console — through the same
request handler, so nothing reached over the socket skips a pipeline stage. A
client names `http://localhost` in its URLs and connects to the socket path.
Both SDKs do both for you —
`MelraClient.connect({ socketPath, token })`, or `{ url, token }` for
`--http`, in TypeScript, and `MelraClient.connect_socket(path, token=...)` or
`connect_http(url, token=...)` in Python — and refuse to send the token over
plain `http:` to anything but loopback; see [Connecting to a running server](../packages/sdk-ts/README.md#connecting-to-a-running-server)
and [sdk-py/README.md](../sdk-py/README.md).

- **The socket is created mode `0600`, and the kernel refuses `connect` from
  any other OS user.** The umask is narrowed around the bind, so the socket never
  exists with a wider mode, and the mode is read back afterwards; a socket that
  came out wider is closed and the server refuses to start.
- **The token is still required on every request.** The file mode is the
  primary boundary and the token is the second one — defence in depth, and the
  same thing every other route already asks for. Set `MELRA_HTTP_TOKEN` to know
  it in advance; otherwise a fresh one is printed at startup.
- **No client registers itself over OAuth.** No browser can reach a socket to
  show a consent page, so the registration endpoints are not served.
- **A leftover socket is replaced, nothing else is.** A socket this user owns
  that nobody answers on — what a crashed run leaves — is removed and recreated.
  A live server's socket fails with `socket_in_use`; a regular file, directory,
  symlink, or another user's socket at the path fails with `socket_path_exists`
  and is left alone. A clean shutdown removes the socket.
- **One transport per process.** `--socket` together with `--http`, `--port`,
  or `--open` is an error rather than a guess. Only the flag moves `melra
  serve` off stdio: an exported `MELRA_SOCKET` names the socket for `melra
  doctor` and `melra status`, and a stdio MCP client launched from the same
  shell still gets stdio.

Put the socket in a directory only you can write — `$XDG_RUNTIME_DIR` on Linux
is `0700` for exactly this. The socket's own mode keeps other users from
connecting; the directory's mode keeps them from replacing the socket with one
of their own before a client connects. Set `MELRA_SOCKET` to the same path and
`melra doctor` reports whether its parent directory exists and whether a socket
already there is owner-only.

**Not on Windows.** Node can listen on a named pipe (`\\.\pipe\name`) through
the same call, but a pipe has an ACL rather than a mode, Node can neither set
nor read it back, and the default ACL is not "this user only". A transport whose
whole claim is "only you can connect" that cannot check that claim would be
worse than none, so `--socket` fails with
`socket_transport_unsupported_on_windows`. Use stdio, or loopback HTTP.

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
the whole gate, and it takes the operator's token. The consent page asks for
the token `melra serve --http` printed (or your `MELRA_HTTP_TOKEN`), checks it
on the server, and never passes it to the client. Any process that can reach
the port can submit the form, so the token is what makes the approval yours.
The sign-in routes (`/.well-known/*` and `/oauth/*`) also answer only when
`Host` is a loopback name (`127.0.0.1`, `localhost`, `[::1]`, or the address
the server is bound to), on any port, so an SSH tunnel still works but a web
page that re-resolves its own name to `127.0.0.1` cannot drive the flow from
your browser. Registration also refuses a request that carries an `Origin`
header (`403 origin_not_allowed`), which a browser puts on every POST a page
makes and an MCP client registering from its own process does not, and a body
that is not `application/json` (`415 json_required`), so no web page you have
open can register clients either. `/open` (what `--open` opens) likewise
answers only to loopback names and needs no token. Every other route needs the
token, whatever the name.

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
| `/open?code=<code>` | `GET` | What `--open` opens: a redirect to the console, once, within a minute of startup; unauthenticated, loopback names only |
| `/mcp` | `POST`/`GET`/`DELETE` | MCP over Streamable HTTP — all twelve tools |
| `/.well-known/oauth-protected-resource` | `GET` | RFC 9728 metadata, unauthenticated |
| `/.well-known/oauth-authorization-server` | `GET` | RFC 8414 metadata, unauthenticated |
| `/oauth/register` | `POST` | RFC 7591 registration, JSON only and never with an `Origin` header; grants nothing on its own |
| `/oauth/authorize` | `GET`/`POST` | The consent page, and your decision |
| `/oauth/token` | `POST` | Authorization code exchange, PKCE S256 |
| `/api/capabilities` | `GET` | The same payload `melra_capabilities` returns |
| `/api/tasks?limit=<n>` | `GET` | Recent tasks, newest first; `approvalPendingIds`, those of them awaiting approval with no usable decision; `attentionCount`, every task needing attention |
| `/api/tasks/:id` | `GET` | One task's status |
| `/api/tasks/:id/approval-state` | `GET` | A pending task's usable decision, if any, whether its challenge is spent, and whether it is a workflow step, with its run, whether that run names this task, and whether it names it from a compensation |
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
requests, in three views:

- **Overview**: counts of tasks recorded, verified, needing attention, and
  blocked; the posture you are running under (mode, guardrails, allowed
  commands and domains, credentials, grants), with a red banner in unsafe-local
  mode; the effect adapters on offer; and recent activity.
- **Tasks**: every task, filterable by outcome and searchable by id, operation,
  target, or policy reason. A task opens to its policy decision, each evidence
  item with how it is known, its receipts, and the redacted stored record.
- **Workflows**: every run, each node's status with links to its tasks, the
  command that advances it, and a live event tail.

Views have their own URLs (`#/tasks/<id>`), so a task can be linked. The
console only reads: it never renders an approval phrase even though, in
developer mode, the task API carries one, because approvals belong to the
governed path. It is served
with a Content-Security-Policy that admits only its own script and style by
hash and only this server as a fetch target, and it refuses to be framed.

## See what MELRA is doing

Three commands read the local database directly, so they work with or without a
server running:

```bash
melra tasks                         # recent tasks, most recently active first
melra tasks --status awaiting_approval --limit 50
melra watch                         # a line per new task or status change; Ctrl-C stops
melra status                        # version, mode, paths, counts, server reachability
```

In a terminal `melra tasks` prints a table:

```
ID        STATUS             OPERATION     TARGET             EFFECT           UPDATED
64199678  awaiting_approval  file.write    melra-example.txt  mutate/medium    2m ago
ca4aec7a  policy_blocked     terminal.run  command:bash       mutate/critical  3m ago
a1285e0f  verified_success   system.info   local-system       read/low         3m ago

1 waiting for approval — approve with `melra approve <task-id>`
```

Piped, or with `--json`, `tasks` and `status` print JSON (the task records are
the ones `/api/tasks` returns) and `watch` prints one JSON event per line.
Colour follows [`NO_COLOR`](https://no-color.org).

They open the database read-only and never create it, and in WAL mode a reader
does not block a writer, so leaving `melra watch` open beside `melra serve`
costs the server nothing. What they print is the stored, already-redacted copy.
Like the console, they never print an approval phrase: in developer mode
approvals belong to the agent that planned the task, and in enforced mode to
an operator running [`melra approve`](#approving-from-the-command-line). `melra status` tells whether a server is up by
opening a TCP connection to `127.0.0.1:$MELRA_HTTP_PORT` (and to
`MELRA_SOCKET`, if set) and closing it without sending anything — no token, no
request.

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
ACLs; [examples/deploy](../examples/deploy/README.md) has a hardened Docker
run and systemd unit, each checked in CI, and `melra doctor` reports what took
effect on its `isolation` line. What MELRA does is stop being one of the ways the claim could be false, by
closing every door it owns:

- **`--unsafe-local` is refused outright.** A mode whose point is that the
  boundary cannot be bypassed cannot also ship a bypass flag. Either flag or
  variable, the process exits with `enforced_mode_refuses_unsafe_local` before
  anything runs.
- **No bind outside loopback.** The CLI has no `--host` flag at all, and an
  embedder calling `serveHttp({ host: "0.0.0.0" })` fails with
  `enforced_mode_refuses_public_bind`. A sandbox talks to its kernel over IPC; a
  listener on a routable interface is a machine-control API on a network.
  [`--socket`](#over-a-unix-socket) is allowed, and is the stricter choice: a
  mode-`0600` socket shuts out other OS users, which a loopback port cannot.
- **No client registers itself.** The OAuth registration endpoints are not
  served at all, on loopback or anywhere else. Enforced mode admits service
  identities the operator issued, and nothing that asks to be let in — so the
  bearer token is the only way in.
- **Loopback destinations stay closed unless the policy opens them.** An HTTP
  or browser effect aimed at this machine's loopback, by name, address, or a
  name that resolves there, is refused (`destination_domain_not_allowed` or
  `destination_private_blocked`): the services a machine runs for itself sit
  behind it. `"allowLocalhost": true` in the policy file opens it, and `melra
  doctor` then warns on its `loopback` line.
- **A read that leaves the workspace is shown to a person first.** A
  read-only terminal command whose argument or option value names a path
  outside the workspace plans as `confirm` with reason `read_outside_workspace`
  and runs only once an operator approves it; a `git` read still finds only a
  repository inside the workspace (see below). Developer mode lets those reads
  through, as before.
- **An argument that only looks inside the workspace is refused if it links
  out**, on its way, where it ends, or where a program that folds `..` as text
  lands, with `terminal_path_outside_workspace`, approved or not.
- **A git read stays in a repository inside the workspace.** git finds its
  repository from where it runs, not from an argument, so a `git` call whose
  first argument is the subcommand `branch`, `diff`, `log`, `rev-parse`, `show`,
  `status` or `tag`, approved or not, one that creates a branch or tag included,
  does not look for one above the workspace, nor take a directory shaped like a
  bare repository for one. It is refused with
  `terminal_git_repository_outside_workspace` where a `.git` between where it
  runs and the workspace root leads out, as a link or as a gitfile naming a git
  directory elsewhere (a linked worktree's, or a submodule's kept in an
  enclosing repository), or where a directory above the workspace has the path
  delimiter (`:`, `;` on Windows) in its name, and with
  `terminal_git_environment_not_allowed:<name>` where its environment says where
  the repository is or hands git config. A workspace that is only a directory
  inside a larger repository has no repository of its own, so git there reports
  `not a git repository`, even for a read an operator approved: point
  `MELRA_WORKSPACE` at the repository's top level. Developer mode, other `git`
  commands (`commit`, `checkout`, ...), and an approved call with a global
  option before the subcommand use whatever repository git finds.
- **A browser action that drives a page names it.** `click`, `type`,
  `fill_form`, `select`, `press`, `upload`, `download`, `close` and
  `tab_switch` without a `url` are refused at planning with
  `browser_action_requires_url`, so the person approving one sees which page
  it lands on, and the runtime refuses it on any other page. The harness
  tools `browser_click` and `browser_type` take that `url` as an argument.
- **`MELRA_HOME` must sit outside `MELRA_WORKSPACE`.** A workspace holding the
  data directory lets a recursive search of no path at all reach the database
  and the payload key, so the process exits with
  `enforced_mode_refuses_data_inside_workspace` instead, naming the fix that
  fits. The usual cause is a workspace that is your home directory (or holds
  it), which holds the default `~/.melra`: set `MELRA_WORKSPACE` to the
  project directory, or run the command from there, and keep `MELRA_HOME`
  where it is. Moved on its own, it starts an empty database, and the tasks
  and approvals in the old one are orphaned. Only a `MELRA_HOME` you put
  inside the project itself moves: out of the workspace, with everything in
  it, and `MELRA_HOME` set to its new place.
- **Secrets sit outside `MELRA_WORKSPACE` too.** A workspace holding the
  browser profile, an HTTP archive (`MELRA_BROWSER_HAR_PATH`,
  `MELRA_BROWSER_HAR_REPLAY`) or a credential's `source.file` is refused at
  startup with `enforced_mode_refuses_secret_inside_workspace`, naming which
  one, for the same reason. Move it out of the workspace.
- **Only an operator approves.** A challenge carries no phrase, so the agent
  is handed nothing to echo, and `melra_execute` refuses any approval it is
  sent with `approval_in_band_refused`. A mutation runs only on a decision an
  operator recorded from a process in enforced mode, with
  [`melra approve`](#approving-from-the-command-line),
  [`melra console`](#approving-in-a-browser) or `melra run`'s prompt in a
  terminal; until then the answer is `approval_awaiting_operator`, and
  `approval_expired` once the challenge has expired, which means plan the task
  again. A developer-mode `melra approve` on a task with no phrase records
  nothing and fails with `approval_needs_enforced_mode`. The same holds for an
  answer to a `semantic` question: none sent with `melra_task_judge` is
  recorded (one on a question still waiting is refused with
  `judgement_in_band_refused`), and an operator answers with
  [`melra judge`](#judging-from-the-command-line).
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

A client starts the server with the `env` in its config, not with the flags
`melra setup` or `melra init` ran with. So in enforced mode they write
`MELRA_MODE=enforced` into the entry they generate, and `"mode": "enforced"`
into the policy file when they create one. That file is the shared
`~/.melra/policy.json` unless `MELRA_POLICY` names another, so every server
that reads it runs enforced. A policy file that already exists is left as it
is. An entry they rewrite gets the mode they run in, so rerun them with the
same `--mode`. `melra conformance` passes `--mode` and `--unsafe-local` to the
server it starts the same way, as `MELRA_MODE` and `MELRA_UNHINGED`.

A `melra conformance` run against an enforced endpoint swaps checks rather than
earning any: one L2 check (`wrong-phrase-is-refused`) gives way to two
(`approval-credential-withheld`, `in-band-approval-refused`), and one L3 check
(`approval-provenance-recorded`) is added. Its L3 checks need an operator's yes,
which the suite gives with its own `melra approve` when it spawned the server;
against `--url` it has no approver and stops at L2. Its first `notProven` entry
narrows from "nothing observable rules out a second path" to naming whose word
the remaining claim rests on. See [CONFORMANCE.md](CONFORMANCE.md).

## Running one task from the command line

`melra run --request task.json`, or a request piped on stdin, plans one task
and runs it. In a terminal it asks y/N before an effect that needs approval, as
[`melra approve`](#approving-from-the-command-line) does. It prints the result
as JSON and exits:

| Exit | When |
| --- | --- |
| 0 | The task is `verified_success`. |
| 1 | An error, or a no at the prompt. |
| 2 | It ran and did not verify: `partial`, `failed`, `recovery_required` or another outcome. |
| 3 | It needs an approval and there is no terminal to ask in. Nothing ran; `next` says to rerun interactively. |
| 4 | Policy blocked it (`policy_blocked`). Nothing ran. |
| 5 | It ran and waits in `waiting_user` for a [semantic judgement](#judging-from-the-command-line). `next` holds the `melra judge` command that answers each of its judgements, one per line, with both ids whole. Replace its `<yes\|no\|cannot_tell>` with your verdict before you run it; as printed, a shell refuses it. |

## Approving from the command line

`melra approve <task-id>` shows an approver the effect a task is waiting on (the
operation, its target, the evidence it must leave, its budget, and the goal the
agent stated, marked as unverified) and asks y/N. A yes is recorded as a
decision bound to exactly what was shown; it does not run anything. The agent
that planned the task runs it with `melra_execute`, and the decision lets it.

```bash
melra approve 3f2a…        # shows the effect, asks y/N
melra approve 3f2a… --yes  # no question, for a script that already decided
melra approve 3f2a… --deny # cancel the task instead
```

Denying a step of a durable workflow fails its run, as a failed step does: the
next `melra workflow advance` offers the compensations declared for the steps
already done, newest first, each for its own approval. If another step's
outcome is unknown, the run is `recovery_required` instead and nothing is
undone until an operator settles it. Deny a compensation to stop there (the
run then reports `recovery_required` and names it), or end the run without
unwinding with `melra workflow cancel`.

Off a terminal and without `--yes` it prints the effect as JSON and exits 3
without deciding. The receipt for the run records who approved it
(`cli:` plus [`MELRA_APPROVER`](#local-configuration), `operator` by
default), when, and the digest of what they were shown. In enforced mode the
channel is `out_of_band`; in developer mode it is `in_band`, because there the
agent may hold the same access. `melra run` asks the same way in a terminal.

In enforced mode an operator's decision, recorded this way, in
[`melra console`](#approving-in-a-browser), or through `melra run`'s prompt,
is the only way a mutation gets approved: the agent is
given no phrase, and one it sends is refused. Run `melra approve` in enforced
mode too (`MELRA_MODE=enforced` or `--mode enforced`), with the `MELRA_HOME`
and `MELRA_WORKSPACE` the agent's server uses (see
[`melra console`](#approving-in-a-browser) for why the workspace matters). A developer-mode
`melra approve` on a task with no phrase is refused with
`approval_needs_enforced_mode` and records nothing, because the enforced kernel
would not run on its in-band decision and a task has only one.

Tasks planned before an upgrade to enforced refusal, or by a developer-mode
process, keep their phrase and their stored expiry. Echoing that phrase is
refused in enforced mode, and a developer-mode `melra approve` on such a task
still records an in-band decision the enforced kernel ignores: a workflow
plans the step again once the challenge expires, and a single task needs
`melra approve --deny` and planning again.

## Judging from the command line

A task whose evidence asks a `semantic` question waits in `waiting_user` once
its effect has run and every other check has held. Its `judgements` list one
`judgementId` per question. `melra tasks --status waiting_user --json` lists
those tasks, and `melra inspect <task-id>` prints the question
(`request.requiredEvidence[predicateIndex]`), the redacted result and the
judgements. `melra inspect` and `melra export` also take the first eight
characters the plain `melra tasks` table prints, as `melra approve` does; a
prefix two tasks share is refused with `task_id_ambiguous:<prefix>`. Answer one
with:

```bash
melra judge <task-id> --judgement <judgement-id> --verdict yes|no|cannot_tell \
  [--rationale "Reads as the summary asked for."]
```

`melra judge` takes both ids whole. A yes on every question makes the task
`verified_success`. The first `no` ends it `partial` (`semantic_judgement_no`):
a change stays in place, and fixing it takes a new plan. `cannot_tell` ends a
change `recovery_required` and a read `partial`
(`semantic_judgement_cannot_tell`). A yes while other questions are open is
recorded, and the task keeps waiting. Nothing runs again and no receipt is
added: the task records the verdict as `judgedBy`, and the certificate, once
the task settles, carries it on the question's item beside `executedBy`, the
receipt's declared principal, so the two can be compared without the receipt.
Both are recorded as declared, and neither marks the `harness:` link an OAuth
client's token adds. The `rationale` is for
people; MELRA stores it redacted and never reads it.

It prints `{ task, certificate? }` and exits 0 when the verdict is recorded,
and 1 when it is refused, which records no verdict:
`task_not_awaiting_judgement:<status>`, `judgement_not_found`,
`judgement_already_answered`, `judgement_expired`, or
`judgement_in_band_refused`, checked in that order. A question whose
`expiresAt` passed while its task still waited gets `judgement_expired`: the
task settles closed (`semantic_judgement_expired`) when a runtime next opens
the data directory, this command's own startup included, so it is normally
settled by the time the refusal prints. Until then `melra tasks` and
`melra status` count it apart from the tasks still waiting
(`expiredJudgements` beside `awaitingJudgement` in `melra status --json`),
though it is still listed as `waiting_user`.

The judge is recorded as `cli:` plus [`MELRA_APPROVER`](#local-configuration).
It is not checked against the task's principal, as `melra approve` checks no
approver. The verdict is `out_of_band` only when this command and the server
the task ran under are both in enforced mode; otherwise it is `in_band`, and
the command says so. A developer-mode `melra judge` on a task that ran enforced,
once the checks before it have held, is refused with
`judgement_in_band_refused` and asked to rerun with
`--mode enforced` or `MELRA_MODE=enforced`, with the same `MELRA_HOME` and
`MELRA_WORKSPACE` as the server.

An agent answers with `melra_task_judge` instead, declaring an `identity`. One
declaring the task's own principal, or a non-human link that principal acts
for, is refused with `semantic_judge_is_actor`, and so is one whose
`onBehalfOf` names the task's principal. Another session under the same
harness, or another agent of the same person, may answer, unless the task's
principal is that harness or person itself; the `harness:` link
an [OAuth client](#clients-that-let-themselves-in) gets above a judge's chain is
recorded in `judgedBy` but not compared. That compares declared
identities, so an agent can still claim to be someone else, `human:` links
included: only a `cli:` judge came through an operator surface. In enforced
mode every verdict sent over MCP is refused.

## Approving in a browser

`melra console` is [`melra approve`](#approving-from-the-command-line) on a
page instead of a y/N prompt. Run it yourself, in a terminal, with the same
`MELRA_HOME`, `MELRA_WORKSPACE` and mode as the server your agent uses. A stdio
client sets those in its own config, not in your shell, so set them here too:

```bash
MELRA_MODE=enforced MELRA_WORKSPACE=/path/to/agent/workspace melra console
```

If it stops with `enforced_mode_refuses_data_inside_workspace`, the workspace it
worked out holds the data directory: with `MELRA_WORKSPACE` unset, the
workspace is the current directory, and from your home directory that contains
the default `~/.melra`. Set `MELRA_WORKSPACE` to the agent's workspace, or run
the console from there. Do not move `MELRA_HOME` instead: the console would
then open an empty database, with no task waiting in it.

Once started, it opens the console in your default browser. A task waiting
for approval shows the screen `melra approve` shows, with Approve and Deny.
Approve records a decision bound to exactly that screen and runs nothing: the
agent that planned the task runs it, as after `melra approve`. Deny cancels the task, as `--deny`
does. The receipt names the approver as `console:` plus
[`MELRA_APPROVER`](#local-configuration). In enforced mode the decision is
`out_of_band`. In developer mode it is `in_band`, the terminal and the page say
so, and a task with no phrase is refused with `approval_needs_enforced_mode`,
as `melra approve` refuses it.

`melra console` approves with the same authority as `melra approve`. The
server your agent connects to has no approval route, and no MELRA operation
that runs without approval can produce a console approval. The console is a
server of its own: it listens on a fresh loopback port, serves no MCP endpoint
and no client registration, and ignores `MELRA_HTTP_TOKEN`.

**Pairing.** The console has no standing token. It pairs once, with the first
page to use its one-time code, normally the tab it opens:

1. It hands your browser `http://127.0.0.1:<port>/#pair=<code>`, a one-time
   code in the fragment, which no request line, log or `Referer` carries. It
   never prints the code.
2. The page spends the code, in a POST the console accepts only from its own
   origin, for a session it keeps in memory: not in browser storage, the DOM or
   a URL. A second pairing is refused with `console_already_paired`.
3. The terminal prints the console's address, then
   `Paired with a browser tab at HH:MM`, and the page shows `paired at HH:MM`.
   If the terminal says paired and no tab opened for you, press Ctrl-C. If your
   tab says another tab already paired, press Ctrl-C too: every approval that
   tab made is on the terminal as `Approved <task-id> at HH:MM`, and runs the
   next time the agent asks, so cancel each you did not make with
   `melra approve <task-id> --deny`, with the console's `MELRA_HOME`, then run
   `melra console` again. A task already approved shows there as approved, with
   no Deny button, which is why `--deny` is run from the terminal.

**Reloading or leaving the page ends the pairing**, and so does anything else
moving its URL, such as a link to another fragment, back or forward; run
`melra console` again for a new one. It ends at the console as well: the page
hands its session back as it goes, and the console refuses it after. The page
takes the task you approve from
your clicks in it, never from its URL, and changes its URL itself only to take
the pairing code out of it as it opens. Only
the page that spent the code is ever paired, so a page that sends a tab back to
the console does not arrive at a paired one.

The page shows MELRA's summary of the effect (the operation, `Effect:`, the
agent's goal, the digest) right above Approve and Deny, with the full contract
folded above it, and spells out every hidden character in what the agent sent
(bidi overrides, zero-width characters, combining marks stacked past two on
one character, which would draw over the lines around them) as `\uXXXX`, as
the terminal screen does. Approve and Deny show as not yet active, and ignore clicks, for a second
after they appear and after the page is raised, refocused or scrolled (in a
browser an agent's runtime is attached to, after it is scrolled or resized:
see below).

An approve or a deny is a POST from that page: its `Origin` must be the
console's own, it carries the session as `Authorization: Bearer`, its body is
JSON, and an approve names the task and the digest of the screen it showed,
both fixed when the page drew it. No other origin can send that without a CORS
preflight, which the console never answers, and a GET never decides.

| Deployment | `melra console` |
|---|---|
| A stdio client (Claude Code, Claude Desktop, Cursor, …), with you running `melra console` on the same machine | supported |
| `melra serve --http`, started by you or by a harness, with you running `melra console` beside it | supported |
| A macOS, Linux or Windows desktop with a default browser | supported |
| Started without a terminal: by a harness, systemd, launchd or compose, or with stdin or stderr piped | refused: `console_needs_a_terminal` |
| Nothing here opens a browser | refused: `console_needs_a_browser`, and the URL is not printed instead; if a tab paired while the opener ran, the error names every task it approved, to cancel with `melra approve <task-id> --deny` |
| Inside a Docker container | refused, as one of the two rows above: use `docker exec -it <container> node /opt/melra/dist/bin.js approve <task-id>`, with the container's id from `docker ps` |
| The console itself on a Unix socket or off loopback (`serveHttp` with `approver`); an agent server on a socket is fine | refused: `approval_console_loopback_only` |

**Same root of trust as `melra approve --yes`.** That command needs no
terminal, so anything running as your OS user against the data directory can
approve with it, and can write `melra.sqlite` directly. The console does not
change either. Enforced mode rests on the agent having no such process; a
harness that gives the agent a terminal removes that, whatever the console
does. See [the threat model](THREAT_MODEL.md#the-approval-console).

**An agent's browser attached to yours.** With `MELRA_BROWSER_CDP_ENDPOINT`
set, the agent's browser runtime drives tabs in a browser you may also use, and
`melra doctor` warns about it. The console page carries a marker, and MELRA's
browser runtime refuses every action that sends input to a page carrying it
(`browser_refuses_approval_surface`), in every mode, whatever approved the
action. It also refuses each action of its own that could raise or move the
console under your pointer: `tab_switch` onto the console's tab, `scroll` on
it, and, in a browser it is attached to, `close` of any tab and `tab_switch`
to any while another console is open there, because the browser then raises
a neighbouring tab, or a split view's other half; a
tab that does not answer within a second counts as one, so two such tabs hold
each other open until you close one. Other reads still work there: the agent
can see the page and move its tab (navigate it away or to another fragment,
back, forward), and an approved `close` can close the console itself while no
other is open; each of those ends the pairing. The page's own second's hold on Approve and Deny sees
less in such a browser: Playwright's focus emulation makes every page there
report itself visible and focused, so the console cannot tell it was raised,
and the hold restarts only when it is scrolled or resized. Attach the agent to
a browser you do not use yourself.

**A computer action lands wherever the screen is.** MELRA cannot tell which
page a `computer.click` or `computer.type` reaches, so approving one approves
whatever is on screen when it runs, the console included.

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
  Forbidding `mutate` forbids `destructive` too. `destructive` is only a file
  `delete` and a memory `delete` or `clear`: a terminal command that deletes
  (`rm`, `git clean`) and an HTTP `DELETE` are mutations, so forbid `mutate` to
  keep a task from deleting anything.
- Checks on the request's own shape. `semantic` evidence beside
  `reconciliation` (`semantic_evidence_not_reconcilable`), or in a workflow
  node (`workflow_semantic_evidence_unsupported`), is a contract nothing could
  keep, so it is still refused.
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

`melra setup --client <name>` (or `init`) prints the configuration in the
named client's own format together with the file it belongs in, and `--write`
merges it there for you:

| `--client` | Client | Where `--write` puts it | Format |
|---|---|---|---|
| `claude-code` (or `claude`) | Claude Code | `<workspace>/.mcp.json` | `mcpServers` |
| `claude-desktop` | Claude Desktop | `claude_desktop_config.json` in the OS app-config directory | `mcpServers` |
| `cursor` | Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| `vscode` | VS Code (Copilot agent mode) | `<workspace>/.vscode/mcp.json` | `servers`, `type: "stdio"` |
| `windsurf` | Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| `codex` | OpenAI Codex CLI | `$CODEX_HOME/config.toml` (default `~/.codex`) | TOML `[mcp_servers.melra]` |
| `gemini` | Gemini CLI | `~/.gemini/settings.json` | `mcpServers` |
| `zed` | Zed | Zed's `settings.json` | `context_servers` |
| `cline` | Cline (VS Code) | `cline_mcp_settings.json` in Cline's global storage | `mcpServers` |
| `opencode` | OpenCode | `~/.config/opencode/opencode.json` | `mcp`, `type: "local"` |
| `kiro` | Kiro | `~/.kiro/settings/mcp.json` | `mcpServers` |
| `goose` | Goose | `~/.config/goose/config.yaml` (Windows: `%APPDATA%\Block\goose\config\config.yaml`); `$GOOSE_PATH_ROOT/config/config.yaml` when that is set to an absolute path | YAML `extensions.melra`, `type: stdio` |
| `continue` | Continue | `<workspace>/.continue/mcpServers/melra.yaml` | YAML block file, `mcpServers` list |
| `amp` | Amp | `~/.config/amp/settings.json` (or an existing `settings.jsonc`); on Windows `%USERPROFILE%\.config\amp\settings.json` | `amp.mcpServers` |
| `openclaw` | OpenClaw | `$OPENCLAW_CONFIG_PATH`, else `openclaw.json` in `$OPENCLAW_STATE_DIR` (default `~/.openclaw`) | JSON5 `mcp.servers` |
| `hermes` | Hermes Agent (Nous Research) | `$HERMES_HOME/config.yaml` (default `~/.hermes`; Windows `%LOCALAPPDATA%\hermes`) | YAML `mcp_servers.melra` |
| `copilot` | GitHub Copilot CLI | `$COPILOT_HOME/mcp-config.json` (default `~/.copilot`) | `mcpServers`, `type: "local"`, `tools: ["*"]` |
| `qwen` | Qwen Code | `~/.qwen/settings.json` | `mcpServers` |
| `auggie` | Auggie (Augment CLI) | `~/.augment/settings.json` | `mcpServers` |
| `warp` | Warp | `~/.warp/.mcp.json` | `mcpServers` |
| `junie` | JetBrains Junie (CLI and IDE plugin) | `~/.junie/mcp/mcp.json` | `mcpServers` |
| `droid` | Factory Droid | `~/.factory/mcp.json` | `mcpServers`, `type: "stdio"` |
| `kimi` | Kimi Code CLI | `$KIMI_CODE_HOME/mcp.json` (default `~/.kimi-code`) | `mcpServers` |
| `kilo` | Kilo Code (CLI and extension) | `~/.config/kilo/kilo.jsonc` (or an existing `kilo.json`) | `mcp`, `type: "local"` |
| `lmstudio` | LM Studio | `mcp.json` in LM Studio's home: the path in `~/.lmstudio-home-pointer`, else `~/.cache/lm-studio` if it exists, else `~/.lmstudio` | `mcpServers` |
| `generic` | Anything else | — (printed only) | `mcpServers` |

For JSON files `--write` edits only MELRA's own entry in place, so everything
else stays byte for byte as it was: comments and trailing commas (Zed, VS Code,
and Amp settings are JSONC), formatting, key order, and CRLF line endings. A
new entry is indented to match its neighbours, with tabs if the file uses tabs.
It refuses, and leaves the file untouched, when the file is not valid JSON or
JSONC, its top level is not an object, the key MELRA goes under is something
other than an object, or that key appears twice in one object (which copy the
client reads is ambiguous); paste the printed block in by hand instead. An
existing OpenCode `$schema` is never replaced. For Goose it edits
only MELRA's own entry under `extensions:` and leaves every other line as it
was, and refuses a `config.yaml` it cannot edit that way (flow-style
`extensions`, tabs, uneven indentation); Hermes's `config.yaml` gets the same
line edit under `mcp_servers:`, with the same refusals. OpenClaw's
`openclaw.json` is JSON5: the comments and trailing commas OpenClaw writes are
kept, while JSON5-only syntax such as unquoted keys or single-quoted strings is
refused rather than rewritten. The OpenClaw gateway reloads the file on its own,
whereas `openclaw mcp add` refuses to run while the gateway is up. Continue's
file belongs to MELRA, so it is replaced whole. Rerunning it replaces MELRA's
own entry, so it is also how you repoint a client after an upgrade.

`--client claude-code` writes the project-scoped `.mcp.json` in the workspace.
To make MELRA available in every project instead, let Claude Code store it in
its user scope itself — MELRA does not edit `~/.claude.json`, which Claude
Code rewrites constantly:

```bash
claude mcp add-json --scope user melra '{"type":"stdio","command":"melra","args":["serve"],"env":{"MELRA_WORKSPACE":"/absolute/path/to/your/workspace"}}'
```

Codex, OpenClaw, and Hermes have equivalent commands (`codex mcp add melra
--env MELRA_WORKSPACE=… -- melra serve`, `openclaw mcp set melra '<json>'`, and
the interactive `hermes mcp add`); `--write` produces the same entry without
the client running.

Each path and format above is taken from that client's own documentation or
source; the entries added most recently link theirs beside them in
`apps/cli/src/clients.ts`. Warp may ask you
to approve a change to its MCP file the next time it starts.

Clients with no file `--write` can safely target — add MELRA in the app's own
MCP settings, pasting the `generic` configuration (`melra setup --client
generic`):

- **JetBrains AI Assistant**: Settings → Tools → AI Assistant → Model Context
  Protocol. (Junie, JetBrains' agent, has a file: use `--client junie`.)
- **Jan**: Settings → MCP Servers. Jan keeps them in an undocumented
  `mcp_config.json` in its data folder, which MELRA leaves alone.
- **Trae**: the MCP panel. The project file `.trae/mcp.json` takes the
  `mcpServers` shape once "Enable Project MCP" is on; the global file's
  location is not documented.
- **Crush**: `crushrc`'s `mcp add`, or the deprecated `crush.json`, under `mcp`
  with `"type": "stdio"` and `command`/`args`/`env`.
- **Mistral Vibe**: an `[[mcp_servers]]` table in `~/.vibe/config.toml` with
  `name = "melra"`, `transport = "stdio"`, `command`, `args`, and `env`.
- **Cursor CLI** (`agent`) reads the same `~/.cursor/mcp.json` as Cursor, so
  `--client cursor` covers both. **Amazon Q Developer CLI** has become Kiro
  CLI: use `--client kiro`. **Roo Code** has been discontinued; its successors
  Kilo Code and Cline are both supported above.

For any other client, use the common `mcpServers` configuration field:

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
common MCP server configuration format. Clients with their own format use the
same command, arguments, and environment values under a different key; the
table above lists them.

Agents built in code rather than run as an app — LangChain/LangGraph, the
OpenAI Agents SDK, the Vercel AI SDK, or the MCP SDKs directly — spawn the same
`melra serve`; [examples/frameworks](../examples/frameworks/README.md) has a
short snippet for each.

The repository’s automated compatibility claim is the official MCP SDK over
stdio, loopback HTTP, and the Unix socket. Named graphical clients remain release-gated until their current
versions have been manually exercised; see [VALIDATION.md](VALIDATION.md).

## Ordinary tool names

The twelve `melra_*` tools are the kernel’s own vocabulary. A model asked to
plan, read back an approval challenge, and execute for every small read spends
most of its turn on ceremony, so there is a second surface with the names a
harness already knows:

```json
{ "env": { "MELRA_HARNESS_TOOLS": "1" } }
```

That adds thirteen tools alongside the twelve: `read_file`, `list_files`,
`write_file`, `move_file`, `delete_file`, `run_command`, `browse`,
`browser_read`, `browser_click`, `browser_type`, `remember`, `recall`, and
`approve`. It is off by default — a client showing all twenty-five at once buys
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
approved. It cannot change anything about it — the phrase is a keyed hash of
the task id and the operation together, so approved arguments cannot be swapped for
others afterwards. A policy denial comes back the same way, as a result with
`status: "blocked"` and a reason, rather than an error.

In enforced mode there is no phrase. The reply names the operator command
instead, and `approve` takes the task id alone, once an operator has decided:

```json
{
  "status": "approval_required",
  "taskId": "0f0e…",
  "expiresAt": "2026-08-08T21:09:11.204Z",
  "next": "An operator approves this outside the conversation with `melra approve 0f0e…`; then call `approve` with this taskId and no phrase."
}
```

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
docker run --rm -i --init \
  --read-only \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --tmpfs /tmp:size=256m,mode=1777 \
  -v "$PWD:/workspace" \
  -v melra-data:/data \
  melra:local serve
```

For an MCP client, set `command` to `docker` and use the arguments above,
including `-i`. `--init` puts a minimal init in front of the server as PID 1,
so a process a terminal job leaves behind is reaped when it exits; Node
reaps only the processes it started itself. Do not use `-t`; stdio MCP requires clean JSON-RPC streams.

To see what those flags bought, run `doctor` with the same arguments in place
of `serve`. Its `isolation` line reads the restrictions from `/proc` inside
the container:

```text
  ✓  isolation       container, no capabilities, no_new_privs, seccomp filter, read-only root
```

`pnpm docker:smoke` requires all five, so the recipe above and what `doctor`
reports stay in step. Outside Linux, `doctor` cannot see a macOS sandbox
profile and says so; on native Windows, where MELRA has no isolation recipe of
its own, it points to Docker or WSL2 instead (see
[the deployment recipes](../examples/deploy/README.md)). With `MELRA_MODE=enforced`, it
warns when it finds no restriction at all, or when it cannot read any.

## Python SDK

To install it, see [the SDK's install section](../sdk-py/README.md#install):
the wheel attached to each GitHub release, or `pip install ./sdk-py` from a
checkout. It is not on PyPI, so `pip install melra` does not install it.

For repository development:

```bash
uv sync --project sdk-py
uv run --project sdk-py pytest sdk-py
```

Both SDKs expose task and durable workflow methods. They launch or connect to
the same server and do not implement a separate execution engine. The Python
`MelraClient()` spawns `melra serve` over stdio;
`MelraClient.connect_http(url, token=...)` and
`MelraClient.connect_socket(path, token=...)` attach to a server already
running under [`serve --http`](#http-server-and-console) or
[`serve --socket`](#over-a-unix-socket). See [sdk-py/README.md](../sdk-py/README.md).

## Uninstall and local-data deletion

Stop all clients using the server, remove the installed package or container,
then delete the directory configured by `MELRA_HOME`. That directory is the
complete local persistence boundary for tasks, workflows, events, encrypted
payloads, receipts, certificates, memory, keys, and browser artifacts.
Workspace files changed by approved tasks are not deleted automatically.
