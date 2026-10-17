# @melra/storage-sqlite

Transactional storage for [MELRA](https://github.com/XAGI-Lab/melra) on Node's
built-in SQLite: tasks, workflows, events, sealed payloads, memories, receipts,
certificates, idempotency commits, and leases.

```bash
npm install @melra/storage-sqlite
```

```ts
import { SqliteStore } from "@melra/storage-sqlite";

const store = new SqliteStore(`${dataDirectory}/melra.sqlite`);
```

Workflow transitions append events and update the projection inside one
`BEGIN IMMEDIATE` transaction, so a crash between the two is not a state a reader
can observe. Events are append-only and ordered; projections and snapshots are
derived from them, which is why state should be read through the controller's
`status()` rather than by querying tables.

`idempotency_commits` is what makes recovery safe: a committed effect is recorded
with its idempotency key, so replay after a restart recognises work that already
happened instead of running the adapter a second time. Leases let several
processes share one `MELRA_HOME` without two of them advancing the same workflow.

Persisted values are the redacted copies. Exact task requests and adapter results
are sealed with AES-256-GCM bound to record identity and purpose, so reading the
database file does not hand over the payloads.

Pass `{ readOnly: true }` to open an existing database without creating it or
taking a write lock — what `melra tasks`, `watch`, and `status` do beside a
running server.

Schema changes need a new migration rather than an edit to an existing one.

Uses `node:sqlite`, which emits an experimental warning on Node 22 and 24.
Requires Node.js 22.13 or newer. Full documentation:
[github.com/XAGI-Lab/melra](https://github.com/XAGI-Lab/melra)

Apache-2.0
