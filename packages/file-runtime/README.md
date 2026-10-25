# @melra/file-runtime

Confined filesystem operations for [MELRA](https://github.com/XAGI-Lab/melra):
list, read, stat, hash, write, move, delete, and mkdir, all rooted inside one
workspace.

```bash
npm install @melra/file-runtime
```

```ts
import { FileRuntime } from "@melra/file-runtime";

const files = await FileRuntime.create({ root: workspaceRoot, maxFileBytes });
```

Every path is resolved and checked against the root before the operation runs,
following symlinks first — so a link pointing outside the workspace is refused
rather than followed. Relative paths resolve against the root; absolute paths
outside it are an error, not a fallback.

Nothing that changes a file may land in a git directory (`path_git_metadata`)
or change a coding agent's own configuration, such as `.mcp.json`,
`.claude/settings.json` or `.vscode/settings.json` (`path_harness_config`),
whatever the root. Reading them is unchanged.

`maxFileBytes` bounds how much a single read pulls into memory. It is a
resource limit rather than a permission check: an unbounded read of a huge file
takes the host down regardless of who was allowed to read it.

Requires Node.js 22 or newer. Full documentation:
[github.com/XAGI-Lab/melra](https://github.com/XAGI-Lab/melra)

Apache-2.0
