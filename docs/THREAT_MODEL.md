# Threat model

Status: reviewed for `0.3.0-alpha.9`; independent review pending.

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

**Unhinged mode is outside this threat model.** `--unhinged` /
`MELRA_UNHINGED=1` removes the policy, approval, confinement, and
network-destination boundaries listed above, which means the "potentially
hostile MCP client" assumption no longer holds: a hostile client in that mode
has the full authority of the OS user. Nothing in this document applies to a
process running unhinged. See
[unhinged mode](INSTALLATION.md#unhinged-mode).

## Threats and controls

| Threat | Current control | Residual risk |
|---|---|---|
| Prompt-driven destructive action | effect classification, required evidence, exact scoped approval | user may approve a misleading but accurately displayed operation |
| Argument or schema smuggling | strict schemas reject unknown fields | semantic intent can still be ambiguous |
| Unbounded retries | read-only retry budget; one attempt for mutations | independent tasks can repeat the same request |
| Duplicate workflow advance | process-local per-workflow serialization, state-version compare-and-swap, idempotency commit | multiple server processes sharing one data directory are unsupported |
| Crash after an adapter effect | independent file re-observation or explicit `recovery_required` | non-filesystem mutations may require operator reconciliation |
| False completion | explicit predicates and `partial` status | a weak caller-chosen predicate may prove too little |
| Path traversal | lexical and realpath confinement; symlink tests | host race conditions outside the configured workspace model |
| Shell injection | direct process spawn; shell and privilege commands denied | an allowed executable can interpret dangerous arguments |
| Process escape | cwd confinement, environment allowlist, time/output bounds | processes are not OS-sandboxed outside the container profile |
| SSRF and metadata access | URL validation, DNS resolution, per-request interception | malicious public endpoints remain reachable when domains allow them |
| DNS rebinding | the checked answer is pinned: requests go through a loopback proxy that connects to the address validation accepted | an attached CDP browser and unhinged mode resolve names themselves, so the window stays open there |
| Malicious downloads/uploads | path confinement and artifact hashes | file content is not malware-scanned |
| Unintended computer input | typed actions, named-key allowlist, high-risk approval | focus can change between approval and action |
| Desktop observation leakage | local-only screenshot artifact with explicit invocation | screenshots may contain sensitive on-screen data |
| Secret persistence | executable payload encryption plus redacted projections, events, receipts, and logs | novel secret formats may not match redaction patterns; key loss is unrecoverable |
| Memory poisoning | explicit mutation approval, scopes, provenance | content-level poisoning classifier is not implemented |
| Receipt tampering | canonical digests and task-linked certificate | receipts and projections are not encrypted or externally signed |
| A local process taking the HTTP surface | bearer token compared in constant time, loopback binding, read-only JSON API | anything running as the same OS user can read the token from the process that holds it |
| A client granting itself HTTP access | registration grants nothing; a person approves in a browser, PKCE S256 binds the code, loopback-or-private redirect URIs keep the code on the machine, codes are single-use | approval is a human judgement about a name the client chose for itself |
| An approved client acting as another | the issued token names one client, and an MCP session id is bound to the caller that opened it | every principal a request declares beneath the authenticated one is still a claim |
| Payload substitution | AES-256-GCM with identity/purpose-bound additional data | host compromise can read the key and database |
| Dependency compromise | lockfiles, dependency review, CodeQL, SBOM | upstream compromise before detection remains possible |
| Release substitution | checksums and signed GitHub/Sigstore provenance | trust still depends on GitHub identity and workflow protection |

## Approval properties

An approval challenge contains:

- a random approval ID;
- the task ID;
- a digest of the exact operation;
- an exact phrase;
- an expiration time.

Approvals cannot be reused for a different task or operation. Policy is
re-evaluated after approval and immediately before execution.

## Network policy

Browser requests reject:

- loopback unless explicitly enabled;
- private, link-local, multicast, and unspecified addresses;
- cloud metadata endpoints;
- hostnames resolving to a disallowed address;
- redirects and subresources that cross the same checks.

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
- content-level memory-poisoning defenses;
- browser download scanning hooks;
- active-window, focus, secure-input, and multi-display verification;
- post-action desktop observation and task-specific evidence fixtures;
- automatic reconciliation for arbitrary non-filesystem mutations (cross-process
  workflow leases are implemented; reconciliation beyond filesystem effects is
  not);
- fuzzing for schemas, paths, receipts, and network policy;
- independent security review and public remediation record.
