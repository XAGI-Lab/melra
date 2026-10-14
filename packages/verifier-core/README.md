# @melra/verifier-core

Evidence verification for [MELRA](https://github.com/XAGI-Lab/melra). Checks
declared predicates against the real filesystem and the real adapter output
after an operation runs, so success is something observed rather than something
an adapter claimed.

```bash
npm install @melra/verifier-core
```

```ts
import { Verifier } from "@melra/verifier-core";

const verifier = await Verifier.create(workspaceRoot);
const items = await verifier.verify(request.requiredEvidence, output);
```

Supported predicates cover file existence, absence, and content hashes, exit
codes, result values and substrings, URL globs, page text, and
`http_resource_matches`, a second `GET`/`HEAD` that asks the provider rather
than the call that acted. Read-only operations with no declared
evidence get a synthetic `operation_completed` item, so a receipt never has an
empty evidence list.

Every path is resolved through `realpath` and rejected if it lands outside the
workspace root, including the root itself — a symlink cannot be used to verify a
file the task was never allowed to touch. Keep that confinement when adding
predicates.

Requires Node.js 22 or newer. Full documentation:
[github.com/XAGI-Lab/melra](https://github.com/XAGI-Lab/melra)

Apache-2.0
