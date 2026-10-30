# @melra/memory

Scoped, redacted local memory for [MELRA](https://github.com/XAGI-Lab/melra):
put, search, list, delete, and clear, backed by the same SQLite database as
tasks and workflows.

```bash
npm install @melra/memory
```

```ts
import { MemoryOperationSchema } from "@melra/protocol";
import { LocalMemory, rankMemories } from "@melra/memory";

const memory = new LocalMemory(store);
await memory.execute(
  MemoryOperationSchema.parse({
    kind: "memory",
    action: "put",
    key: "deploy-owner",
    value: "platform team",
  }),
);
```

`MemoryOperation` is the post-defaults shape, so parse the operation through the
schema rather than hand-filling `scope`, `confidence`, `tags`, `limit`, and
`includeSuperseded`.

Search is lexical, not embedded — tokenised, ranked by term overlap with exact
phrase matches promoted. That is a deliberate ceiling: it is deterministic,
needs no model call, and never sends anything anywhere. `rankMemories` and
`tokenize` are exported if you want the ranking without the store.

Every value passes through `redactMemoryValue` before it is written, so a token
pasted into a memory entry is not preserved in the database. It applies the same
`SECRET_PATTERNS` list receipts and terminal output use, from
[`@melra/receipt-schema`](https://www.npmjs.com/package/@melra/receipt-schema).

Reads and deletes are scope-aware: a scope only sees its own entries, so one
task cannot read what another stored by guessing a key.

Expired and superseded records are already invisible to every read path;
`LocalMemory` reclaims them on the next write to that scope, after
`MemoryRetention.maxAgeDays` (default 30). The record a live one replaced is
kept, so deleting a correction always brings back what it corrected; an older
record in the chain is kept only that long. Pass `maxPerScope` to also cap live
memories — that one deletes records you can still read, so it defaults to `0`
(no ceiling).

```ts
import { LocalMemory } from "@melra/memory";

const bounded = new LocalMemory(store, { maxAgeDays: 7, maxPerScope: 5_000 });
```

Requires Node.js 22.13 or newer, or 23.4 or newer. Full documentation:
[github.com/XAGI-Lab/melra](https://github.com/XAGI-Lab/melra)

AGPL-3.0-only, or a commercial license from XAGI Labs Private Limited. See
[licensing](https://github.com/XAGI-Lab/melra/blob/main/LICENSING.md).
