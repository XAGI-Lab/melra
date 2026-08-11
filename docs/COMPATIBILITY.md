# Compatibility policy

## Version status

`0.3.0-alpha.11` is pre-stable. Alpha minor releases may change MCP schemas,
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
| Node.js | 22 and 24 | CI matrix defined for Linux, macOS, and Windows |
| pnpm | 9.5 for repository builds | Local and CI commands |
| Python SDK | CPython 3.11+ | Local Python 3.11 tests |
| Container | Linux OCI, AMD64 and ARM64 build targets | Docker workflow; release-candidate smoke required |
| Browser | Installed Chrome, Chromium, or Edge | Installed Chrome verified locally on macOS arm64 |
| MCP transport | stdio; loopback Streamable HTTP | Real child-process MCP suite; HTTP suite drives the official SDK client against a live server |

A workflow definition in CI is not clean-machine certification. The current
host evidence and unverified claims are listed in [VALIDATION.md](VALIDATION.md).

## MCP and SDK compatibility

The server exposes eleven `melra_*` tools: six task/evidence tools and five
workflow tools. Unknown fields are rejected. The retired product prefix is not
an alias.

`MELRA_HARNESS_TOOLS=1` additionally exposes plain-vocabulary aliases
(`write_file`, `approve`, and so on) for harnesses that expect ordinary tool
names. They are a translation layer over the same pipeline, not a second path:
a client that only knows the kernel vocabulary sees the same eleven tools it
always did.

`melra conformance` checks a live endpoint rather than a build and reports the
level it earned; [CONFORMANCE.md](CONFORMANCE.md) defines the levels and their
limits. An implementation claiming compatibility should publish that report.

The normative automated clients are:

- Model Context Protocol TypeScript SDK `1.30.x`;
- Model Context Protocol Python SDK `1.28.x`;
- `@melra/sdk` `0.3.x` alpha;
- the repository Python `melra` client `0.3.x` alpha.

The TypeScript SDK validates workflow definitions and returned workflow
records with the shared Zod contracts. The Python SDK validates identifiers and
response shape, while the server remains the schema authority.

Claude Desktop, Cursor, VS Code, and other clients can use the documented
stdio configuration. A named graphical client is marked verified only after
the released artifact—not a source checkout—passes discovery, task planning,
approval, execution, workflow restart, cancellation, and receipt retrieval in
that client.

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
`workflow_lease_held` rather than duplicating an effect.

## Language interoperability

Implementations in any language must preserve strict JSON contracts,
canonical hashes, approval binding, policy rechecks, redaction, event order,
and verification semantics. Language-specific helpers may be idiomatic but
must not introduce a transport-specific execution path or bypass.

Rust, Go, Python, TypeScript, Swift, C#, or another language may be added when
measurement shows a concrete reliability, isolation, performance, or platform
benefit and the same conformance suite passes.
