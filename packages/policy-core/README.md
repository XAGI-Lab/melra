# @melra/policy-core

Policy evaluation and scoped approval primitives for
[MELRA](https://github.com/XAGI-Lab/melra). Decides allow, deny, or confirm for
a typed operation before any adapter runs, and issues and validates the
task-scoped approval challenges that gate mutations.

```bash
npm install @melra/policy-core
```

```ts
import { createDefaultPolicy, evaluatePolicy } from "@melra/policy-core";

const policy = createDefaultPolicy(process.cwd());
const { decision, challenge } = evaluatePolicy(taskId, request, policy);
```

An `allow` runs. A `confirm` returns a `challenge` bound to the task and to a
digest of the operation — so a plan cannot be swapped for a different action
after approval. In developer mode its exact phrase must be echoed back before
execution; with `mode: "enforced"` it carries no phrase, and `validateApproval`
accepts nothing for it, because only an operator's out-of-band decision may
approve it. A `deny`
never reaches a runtime.

## Defaults worth knowing

- A non-empty `constraints` array is denied. Freeform prose is not enforceable,
  so the honest answer is to refuse rather than pretend it was applied.
- Any non-`read` effect with no `requiredEvidence` is denied. A mutation nobody
  can check is not a mutation worth running.
- A destructive effect whose evidence has a `semantic` predicate but nothing at
  the `state` or `independent` level is denied (`semantic_only_destructive`), and
  `semantic` beside `reconciliation` is denied (`semantic_evidence_not_reconcilable`).
  A judgement about meaning is never the deciding vote.
- Terminal commands must be allowlisted by basename. Shells, multi-call
  binaries, privilege-escalation programs and script hosts are denied
  unconditionally (the list is in `docs/CAPABILITIES.md`). `git` counts as a
  read only for a small read-only subcommand set. A package manager call is
  never a read, and it is a high-risk mutation carrying the `package-install`
  and `network` traits unless it only runs an npm package script (`npm run`,
  `npm test`, ...); a `git` call carries `network` unless its first argument
  is a local subcommand.
- Browser and HTTP destinations default to `allowedDomains: ["*"]` with localhost
  allowed, because the allowlist is a narrowing control, not the safety boundary
  — `assertSafeDestination`, exported from this package, is what blocks private
  and metadata destinations, and it holds even with `allowedDomains: ["*"]`. In
  enforced mode an HTTP `GET`/`HEAD` or a browser `navigate`/`tab_new` to a
  public host only `"*"` admits is a `confirm` (`network_read_unlisted_host`),
  as is a read whose `http_resource_matches` evidence is checked there
  (`unlistedProbe`), and in every mode a `GET` or `HEAD` that carries `content`
  is a mutation.
- `classifyOperation` is the single place effect and risk are decided. An action
  that is not classified there is mis-classified, not unclassified.

## The destination boundary

`assertSafeDestination` lives here rather than in a runtime so every adapter that
opens a socket shares one implementation. It rejects non-`http(s)` protocols and
URL credentials, resolves DNS first and checks **every** answer, and blocks
private, loopback, link-local, and cloud-metadata ranges in IPv4, IPv6, and
IPv4-mapped IPv6 form. An IPv6 address counts as public only inside global
unicast (`2000::/3`) and outside the special-purpose blocks there, or as the
IPv4-mapped or NAT64 form of a public IPv4 address. It returns the address it
checked so the caller can pin the socket to it instead of letting the name
resolve a second time.

## Capability grants

`policy.capabilities` is authority; everything above is rules. It is empty by
default and changes nothing when it is. A non-empty list is a closed world,
checked before any allowlist — because an allowlist describes what a grant
holder may do, not whether they hold one.

```ts
import { createDefaultPolicy, type LocalPolicy } from "@melra/policy-core";

const policy: LocalPolicy = {
  ...createDefaultPolicy(process.cwd()),
  capabilities: [
    {
      id: "build-writes",
      capability: "file.*",
      effects: ["read", "mutate"],
      target: "*/build/*",
      principal: "agent:ci-runner",
    },
  ],
};
```

`capability` and `target` are matched against what `classifyOperation` reported,
with `*` standing for any run of characters on one line (a pattern that is just
`*` matches every value). `principal` is matched against
`request.identity.principal` written `kind:id`; a request that declares no
identity is `agent:local`. An effect with no matching grant is denied
`capability_not_granted`, an expired one `capability_expired`, and one issued
against a superseded `policyVersion` is refused rather than reinterpreted under
rules it was not written for. That pin follows the label, not the content.
`loadPolicy` sets `digest` to `sha256:` and the SHA-256 of the file's bytes, or
`default:<version>` with no file, and every decision carries it as
`policyDigest`. It covers the bytes only: keys the file leaves out take this
version's defaults, and the workspace root depends on the caller and on where
the file is. A policy built in code has none; one changed after loading should
replace or drop it.

`unhinged: true` short-circuits evaluation to `allow` — but only after the
caller's own `forbiddenEffects` and `constraints` are honoured, because those are
the caller bounding its own task rather than a guardrail MELRA imposes.

`mode` is `developer` or `enforced` and is not about a request at all: it records
how this kernel is deployed, and therefore what it refuses about its own setup
rather than about a caller. `deploymentMode` parses it from the flag, the
environment, and the policy file through one function, so a typo fails loudly
instead of leaving a machine permissive with a config that claims otherwise.

Requires Node.js 22 or newer. Full documentation:
[github.com/XAGI-Lab/melra](https://github.com/XAGI-Lab/melra)

Apache-2.0
