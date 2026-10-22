# Compatibility policy

## Version status

`0.3.0-alpha.19` is pre-stable. Alpha minor releases may change MCP schemas,
CLI JSON, SDK methods, package exports, and SQLite data. Patch releases should
remain backward compatible unless a documented security correction requires a
break.

The workflow contract uses schema version `1.0.0`; this is the record-schema
version, not a promise that every surrounding alpha API is stable. The MCP SDK
protocol version remains unchanged.

`1.0` will add semantic-version guarantees, a deprecation window, durable
migration commitments, and stable receipt verification behavior.

## Supported runtimes

| Component | Compatibility target | Current evidence |
|---|---|---|
| Node.js | 22 (22.13 or newer) and 24 | CI matrix defined for Linux, macOS, and Windows; the packed `0.3.0-alpha.12` tarballs also installed and run on Node 26.8.2 (macOS arm64), see [MCP and SDK compatibility](#mcp-and-sdk-compatibility) |
| pnpm | 9.5 for repository builds | Local and CI commands |
| Python SDK | CPython 3.11+ | CI against live stdio, loopback HTTP, and Unix-socket servers (socket skipped on Windows): 3.11 on Linux, macOS, and Windows; 3.12, 3.13, and 3.14 on Linux; type-checked with pyright |
| Container | Linux OCI, AMD64 and ARM64 build targets, on a Node 24 LTS base | Docker workflow; release-candidate smoke required |
| Browser | Installed Chrome, Chromium, or Edge | Installed Chrome verified locally on macOS arm64 |
| MCP transport | stdio; loopback Streamable HTTP; Streamable HTTP on a mode-`0600` Unix socket (not on Windows) | Real child-process MCP suite; HTTP and socket suites drive the official SDK client and both MELRA SDKs against a live server |

A workflow definition in CI is not clean-machine certification. The current
host evidence and unverified claims are listed in [VALIDATION.md](VALIDATION.md).

## MCP and SDK compatibility

The server exposes twelve `melra_*` tools: seven task/evidence tools and five
workflow tools. Unknown fields are rejected. The retired product prefix is not
an alias.

`MELRA_HARNESS_TOOLS=1` additionally exposes plain-vocabulary aliases
(`write_file`, `approve`, and so on) for harnesses that expect ordinary tool
names. They are a translation layer over the same pipeline, not a second path:
a client that only knows the kernel vocabulary sees the same twelve tools it
always did.

`melra conformance` checks a live endpoint rather than a build and reports the
level it earned; [CONFORMANCE.md](CONFORMANCE.md) defines the levels and their
limits. An implementation claiming compatibility should publish that report.

The normative automated clients are:

- Model Context Protocol TypeScript SDK `1.32.x`;
- Model Context Protocol Python SDK `1.30.x`;
- `@melra/sdk` `0.3.x` alpha;
- the repository Python `melra` client `0.3.x` alpha.

The TypeScript SDK validates workflow definitions and returned workflow
records with the shared Zod contracts, and connects over stdio, loopback (or
`https:`) Streamable HTTP, or a Unix socket; its tests drive the same calls
over HTTP and the socket against a live in-process server. The Python SDK validates identifiers and
response shape, while the server remains the schema authority.

Claude Desktop, Cursor, VS Code, and other clients can use the documented
stdio configuration. A named graphical client is marked verified only after
the released artifact—not a source checkout—passes discovery, task planning,
approval, execution, workflow restart, cancellation, and receipt retrieval in
that client.

`melra setup --client <name>` knows the config file and format of 25 named
clients and agent harnesses, among them Claude Code, Codex, OpenClaw, and
Hermes Agent ([the full list](INSTALLATION.md#mcp-clients)). Each entry is
**checked against that client's documentation or source** — the entries added
most recently link theirs beside them in `apps/cli/src/clients.ts` — and the
CLI tests write, rewrite, and read back every format. That is a claim about the file, not about the client:
none of these clients is driven by the automated suites, and none is
**exercised in the app** in the sense above until someone runs that checklist
against it. Client formats change; if one stops loading MELRA, the generic
`mcpServers` configuration and the client's own MCP settings remain the
fallback.

One step further, for four harnesses: on 2026-10-14 the packed
`0.3.0-alpha.12` tarballs were installed into a clean project on macOS arm64
(Node 26.8.2), `melra setup --client <name> --write` wrote each config under a
throwaway `HOME`, and each harness's **own CLI** was asked about it:

| Harness | Version | Command | Result |
|---|---|---|---|
| Claude Code | 2.1.296 | `claude mcp list` | `✔ Connected` over stdio, and over loopback HTTP with the bearer token. A project `.mcp.json` entry shows *Pending approval* until approved, as Claude Code intends |
| OpenCode | 1.18.34 | `opencode mcp list` | `melra connected` |
| Hermes Agent | 0.21.2 | `hermes mcp test melra` | connected in about 1 s, 11 tools discovered |
| Codex | 0.154.0 | `codex mcp get melra` | entry parsed: enabled, stdio, `melra serve`, env passed. Codex has no connection test that does not call a model, so none was run |

That is a real handshake and tool discovery by the client, which the file
check above is not, but it is still short of the in-app checklist: no task was
planned, approved, or executed from inside these harnesses, so none of them is
marked verified. Agent frameworks used from code (LangChain/LangGraph, the OpenAI
Agents SDK, the Vercel AI SDK) are covered only by documentation snippets in
[examples/frameworks](../examples/frameworks/README.md), which are not run in
CI.

### Recording an in-client run

To mark a client verified, run the checklist above in it against a released
package (`npx -y @melra/cli@<version>`, or a release binary), never a source
checkout, in a throwaway workspace, and add one record here in a documentation
pull request ([#184](https://github.com/XAGI-Lab/melra/issues/184) asks for the
first). Name only what you ran: a step the client offers no way to run is
"not available", which is neither a pass nor a failure. Evidence is a short,
sanitized note (what the client showed, a task id, a receipt's
`verificationStatus`), never a credential, a private path or a raw log.

```markdown
#### <Client> <version> — <YYYY-MM-DD>

- OS: <name and version>; MELRA: `@melra/cli@<version>` via <npx | global | binary>
- Configured with: `melra setup --client <name> --write` (or by hand: <how>)

| Step | Result | Evidence |
|---|---|---|
| The client loads MELRA and lists its tools | pass / fail / not available | <tool count shown> |
| A read task planned and run from the client | | <task id, status> |
| A mutation planned, approved, and executed | | <approval path used: phrase, `melra approve`, or `melra console`> |
| Its receipt retrieved from the client | | <verificationStatus> |
| A workflow resumed after the server restarted | | |
| A running task cancelled from the client | | |
```

A record with every step passing marks that client and version verified; any
failure keeps it unverified until a maintainer has looked at the record.

#### Hermes Agent v0.21.5+8877.g865ba90 — 2026-10-17

- OS: Debian GNU/Linux 13.7 (Trixie), Linux aarch64 on Raspberry Pi; MELRA:
  `@melra/cli@0.3.0-alpha.14` via `npx`; Node.js `22.15.0`
- Configured with `npx --yes @melra/cli@0.3.0-alpha.14 setup --client hermes
  --write` under a temporary `HOME`/`HERMES_HOME` and a throwaway workspace.
  The generated `mcp_servers.melra` entry was inspected before use; it pins
  `@melra/cli@0.3.0-alpha.14` and points MELRA workspace and data paths into
  that throwaway environment. All 12 MELRA setup readiness checks passed.

| Step | Result | Evidence |
|---|---|---|
| The client loads MELRA and lists its tools | blocked | `hermes mcp test melra` did not return within 45 seconds. Hermes printed that it was completing source-update dependencies and installing Python dependencies; no MCP result or tool list was returned. |
| A read task planned and run from the client | not run | MCP discovery did not complete. |
| A mutation planned, approved, and executed | not run | MCP discovery did not complete. |
| Its receipt retrieved from the client | not run | No client task was created. |
| A workflow resumed after the server restarted | not run | No client workflow was created. |
| A running task cancelled from the client | not run | No client task was created. |

Hermes reported its version successfully, but its first MCP command entered its
own dependency-recovery path and timed out. The configuration/setup result is
not evidence of an in-client connection. Hermes Agent on this environment is
therefore **not verified**; retry after its dependency recovery completes and
repeat the full client checklist.

## Data compatibility

SQLite migration version `1` adds encrypted task payloads, workflow
definitions and payloads, workflow runs, ordered events, snapshots, and
idempotency commits. It is applied transactionally and covered by migration
tests from the previously released schema.

Forward use of the current database is supported by this release candidate.
Downgrades, key rotation, exporting encrypted workflow payloads, and migration
from future alpha versions are not guaranteed. Back up both `melra.sqlite*`
and `payload.key` before upgrading.

Changing or losing `MELRA_PAYLOAD_KEY` or `payload.key` makes existing
executable payloads unreadable. The key is installation state, not a
reproducible package artifact.

Releases after `0.3.0-alpha.18` key the digests stored beside redacted
records with a key derived from the payload key: an approval challenge's
`actionDigest` and the phrase taken from it, the `renderDigest` a decision is
bound to, and a receipt's `inputDigest`, which now also binds the task id.
They can be checked only with that key, and are lost with it. A file read's
or write's `sha256`, and a failed `file_hash` item's `digest`, are stored as
`[REDACTED_SENSITIVE_FIELD]`. The caller of `melra_execute` still receives the
`sha256` in `output`. A failed `file_hash` item's `digest` is masked in the
receipt and certificate and is no longer returned anywhere; run a file `hash`
operation to read the actual hash. Nothing stored is rewritten: older receipts
keep their plain digests, and older certificates verify unchanged.

In a home shared with `0.3.0-alpha.17` or `0.3.0-alpha.18`, a newer process
still runs a challenge an older one issued, and accepts a decision an older
`melra approve` or `melra console` recorded, until the challenge expires; it
shows such a challenge the digest the older executor checks. A decision it
records for that challenge keeps that plain render digest, so an older
executor accepts it; the task's `approvedBy` and its receipt hold the keyed
one. The reverse fails closed: an
older process refuses a challenge a newer one issued with
`approval_action_digest_mismatch` before anything runs, and the task stays
`awaiting_approval` for a newer process to run. There that error means the
versions differ, not that the request changed. Upgrade every process sharing
a `MELRA_HOME` together, and re-run `melra setup` so pinned clients move.

## Workflow compatibility and limits

The implemented node types are operation, approval, condition, parallel,
bounded loop, checkpoint, compensation, human input, and delegation. The last
two block on a person or an outside worker; a delegation node's declared
evidence still decides its outcome, so a delegate reporting "done" is not
evidence.

Current limits include 500 nodes per definition, 100 dependencies per node,
100 loop iterations, 20 parallel branches, 50 requests per branch/body, and
50 submitted approvals per advance.

One server process may host multiple workflows. Within one process, advances
for the same workflow are serialized while declared parallel branches execute
concurrently. Across processes the same job is done by an expiring SQLite
lease taken before any adapter runs, so a second holder is refused with
`workflow_lease_held` rather than duplicating an effect, and so are an
operator's pause, suspend, resume and cancel, so none lands under an advance.
An advance whose lease another process or an operator's halt took over while it
stalled fails with `workflow_lease_lost` before its next step and commits
nothing; advance the run again later.

Recovery leaves a task alone while the process that started it is alive, which
it learns from a lock the process holds on a file in `melra.sqlite-owners/`.
That needs working file locks between every process sharing the database, the
same thing SQLite's WAL mode already needs: a network filesystem, or one volume
mounted into two kernels (a macOS host and a Docker Desktop VM), is not
supported. Upgrade every process sharing a `MELRA_HOME` together; an older
binary does not record owners, so its running tasks look abandoned to a newer
one. Do not delete `melra.sqlite-owners/` while MELRA is running.

## Language interoperability

Implementations in any language must preserve strict JSON contracts,
canonical hashes, approval binding, policy rechecks, redaction, event order,
and verification semantics. Language-specific helpers may be idiomatic but
must not introduce a transport-specific execution path or bypass.

Rust, Go, Python, TypeScript, Swift, C#, or another language may be added when
measurement shows a concrete reliability, isolation, performance, or platform
benefit and the same conformance suite passes.
