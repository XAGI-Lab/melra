# @melra/receipt-schema

Action receipts, execution certificates, canonical JSON, and redaction for
[MELRA](https://github.com/XAGI-Lab/melra). This is the evidence layer: what
happened, what was checked, and what it hashes to.

```bash
npm install @melra/receipt-schema
```

```ts
import { createCertificate, redactSecrets, redactStructuredValue, sha256 } from "@melra/receipt-schema";
```

A receipt records one action: the operation, the policy decision, the evidence
items and their outcomes, and timing. A certificate summarises a task's receipts
and carries a digest over their canonical form, so a transcript can be checked
rather than trusted.

`canonicalJson` sorts keys and normalises formatting before hashing, so the same
logical value always produces the same digest across processes and platforms.

`redactStructuredValue` strips credential-shaped values from anything before
it is persisted: fields named like secrets (`authorization`, `headers`,
`cookie`, `token`, `password`, `env`, `content`, `stdout`, …) are replaced
whole, URL query strings and fragments are dropped, and every other string goes
through `redactSecrets`. `SECRET_PATTERNS` — PEM private keys, AWS key IDs,
JWTs, Slack and GitHub tokens, common API keys, bearer tokens, and
password/secret assignments — is the one list memory and terminal output use
too, so a new secret format is added here once. Raw output
goes to the live caller only; the durable copy is the redacted one. A new field
that can carry a secret must pass through this, or through the memory package's
equivalent, before it reaches storage.

`wildcardMatch(value, pattern)` is the `*` pattern match policy grants,
credential delegations and `url_matches` share: `*` stands for any run of
characters on one line, and the answer comes in time linear in the input.

Requires Node.js 22 or newer. Full documentation:
[github.com/XAGI-Lab/melra](https://github.com/XAGI-Lab/melra)

Apache-2.0
