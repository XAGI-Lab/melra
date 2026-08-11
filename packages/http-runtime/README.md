# @melra/http-runtime

Governed HTTP and API calls for [MELRA](https://github.com/XAGI-Lab/melra) —
one bounded request, checked against the same destination boundary the browser
uses.

```bash
npm install @melra/http-runtime
```

```ts
import { HttpRuntime } from "@melra/http-runtime";

const http = new HttpRuntime({ allowedDomains: ["api.example.com"], allowLocalhost: false });
```

One action, `http.request`, with a method, a URL, optional headers and body, a
response-size cap, and a timeout. `GET` and `HEAD` classify as reads; every
other method is a mutation and needs declared evidence and an approval like any
other mutation.

## The destination boundary

`assertSafeDestination` from [`@melra/policy-core`](../policy-core) runs before
any socket opens: non-`http(s)` protocols, URL credentials, and private,
loopback, link-local, and cloud-metadata addresses are refused, and DNS is
resolved first so a public name cannot be rebound to a private address.

The socket then connects to the **address that was checked**, not to the name —
the same pinning the browser's proxy does, and for the same reason.

Redirects are not followed. A `Location` header points somewhere the destination
check never saw, so the status and the header come back and the caller can plan
a second governed request.

## What it cannot promise

Exactly-once. HTTP is at-least-once at the provider, so a mutation here runs at
most once from MELRA and is never retried. `idempotencyKey` is sent as
`Idempotency-Key` for providers that honour it, but MELRA cannot verify that
they do — it does not upgrade the execution guarantee.

The request body travels under the `content` field, which redaction strips
before anything is persisted. Raw bytes reach the live caller only.

Requires Node.js 22 or newer. Full documentation:
[github.com/XAGI-Lab/melra](https://github.com/XAGI-Lab/melra)

Apache-2.0
