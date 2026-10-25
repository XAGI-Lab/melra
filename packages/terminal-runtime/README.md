# @melra/terminal-runtime

Bounded process execution for [MELRA](https://github.com/XAGI-Lab/melra):
one-shot `run`, plus `start`/`status`/`output`/`stop` for longer-lived processes
and `send` to answer a job started with `interactive: true` (stdin is a pipe,
not a pseudo-terminal).

```bash
npm install @melra/terminal-runtime
```

```ts
import { TerminalOperationSchema } from "@melra/protocol";
import { TerminalRuntime } from "@melra/terminal-runtime";

const terminal = await TerminalRuntime.create({ root: workspaceRoot });
const result = await terminal.execute(
  TerminalOperationSchema.parse({
    kind: "terminal",
    action: "run",
    command: "git",
    args: ["status", "--porcelain"],
  }),
);
```

Commands are spawned without a shell. Arguments are passed as an array, never
interpolated into a command line, so a value containing `;` or `$(...)` is an
argument rather than a second command. The working directory stays inside
`root`, and only environment variables you name in `allowedEnvironment` are
passed through.

Output is captured up to the operation's `maxOutputChars` and flagged
`truncated` past it, and every process runs under an `AbortSignal` so a duration
budget actually stops work rather than just reporting a timeout.

`redactTerminalOutput` strips credential-shaped values from captured output
before it is persisted — keys, tokens, and `Authorization` headers show up in
stdout more often than anyone expects. It applies the same `SECRET_PATTERNS`
list as receipts and memory, from
[`@melra/receipt-schema`](https://www.npmjs.com/package/@melra/receipt-schema).

Allowlisting decides which commands may run at all, and that lives in
[`@melra/policy-core`](https://www.npmjs.com/package/@melra/policy-core), not
here.

Requires Node.js 22 or newer. Full documentation:
[github.com/XAGI-Lab/melra](https://github.com/XAGI-Lab/melra)

AGPL-3.0-only, or a commercial license from XAGI Labs Private Limited. See
[licensing](https://github.com/XAGI-Lab/melra/blob/main/LICENSING.md).
