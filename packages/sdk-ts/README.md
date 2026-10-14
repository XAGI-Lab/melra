# @melra/sdk

TypeScript client for [MELRA](https://github.com/XAGI-Lab/melra), a local-only
MCP server that turns one tool call into a governed, verified, receipted task.

The client spawns a MELRA server over stdio, or connects to one already running
over HTTP or a Unix socket, and speaks the task and workflow tools for you, so
you work with typed requests instead of raw MCP plumbing.

```bash
npm install @melra/sdk
```

## Plan, approve, execute

Planning never executes. A mutation comes back with a task-scoped approval
challenge whose exact phrase you must echo to run it.

```ts
import { MelraClient } from "@melra/sdk";

const melra = await MelraClient.connect();

const task = await melra.plan({
  goal: "Record the release note",
  operation: {
    kind: "file",
    action: "write",
    path: "NOTES.md",
    content: "0.3 is out.\n",
  },
  constraints: [],
  forbiddenEffects: [],
  requiredEvidence: [{ type: "file_exists", path: "NOTES.md" }],
  budget: { maxDurationMs: 10_000, maxRetries: 0 },
});

const approval = task.approval as
  | { approvalId: string; phrase: string }
  | undefined;
const result = await melra.execute(
  task.id as string,
  approval && { approvalId: approval.approvalId, phrase: approval.phrase },
);

console.log(result.task);
await melra.close();
```

`requiredEvidence` is what decides success. A write that reported success but
left no file is `partial`, never `verified_success` — the verifier checks the
world, not the adapter's own claim. Leave `constraints` empty: freeform prose is
not enforceable, so a non-empty array is denied outright.

## Connecting to a specific server

`connect()` runs `melra serve` from your `PATH` by default. Point it anywhere:

```ts
const melra = await MelraClient.connect({
  command: "npx",
  args: ["-y", "@melra/cli@alpha", "serve"],
  env: { MELRA_WORKSPACE: "/path/to/project" },
});
```

## Connecting to a running server

`melra serve --http` and `melra serve --socket <path>` serve the same MCP tools
to any number of clients. Pass `url` or `socketPath` instead of a command, plus
the bearer token the server printed (or was given as `MELRA_HTTP_TOKEN`). Every
method below works the same on all three transports.

```ts
import { MelraClient } from "@melra/sdk";

const token = process.env.MELRA_HTTP_TOKEN;
if (token === undefined) throw new Error("set MELRA_HTTP_TOKEN");

// The MCP URL `serve --http` prints; the bare origin works too.
const overHttp = await MelraClient.connect({
  url: "http://127.0.0.1:7457/mcp",
  token,
});

// Not on Windows, where the server refuses sockets as well.
const overSocket = await MelraClient.connect({
  socketPath: `${process.env.XDG_RUNTIME_DIR}/melra.sock`,
  token,
});

await overHttp.close();
await overSocket.close();
```

The token is never read from the environment for you: a library that picks up
a credential on its own and sends it to whatever URL it was handed is how
tokens leak. A plain `http:` URL is refused unless its host is loopback
(`localhost`, `127.0.0.0/8`, `[::1]`) — the token drives the machine, and over
cleartext it is readable by anything on the path. Put TLS in front and use
`https:`. A wrong token fails `connect()` with `melra_unauthorized`.

## Workflows

`planWorkflow`, `advanceWorkflow`, `workflowStatus`, `cancelWorkflow`, and
`controlWorkflow` drive the durable graph. Every node that does work goes through
the same policy, approval, verification, and receipt path as a single task, so
nothing is bypassed by composing.

```ts
const run = await melra.planWorkflow(definition);
await melra.advanceWorkflow(run.id, approvals, [
  { nodeId: "ask-owner", value: "ship it" },
]);
await melra.controlWorkflow(run.id, "pause");
```

Advancing is resumable: call it until the run reaches a terminal status. Effects
are deduplicated by idempotency key across restarts, so a crashed advance does
not repeat work it already committed.

## Other exports

`parseMelraToolResult` unwraps a raw MCP tool result into the parsed JSON payload
and throws the server's error text when the call failed — useful if you talk to
the tools through your own MCP client.

Requires Node.js 22 or newer. Full documentation:
[github.com/XAGI-Lab/melra](https://github.com/XAGI-Lab/melra)

Apache-2.0
