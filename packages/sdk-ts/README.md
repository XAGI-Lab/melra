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
challenge. In developer mode you echo its exact phrase to run it; in enforced
mode it has no phrase, an operator approves with `melra approve <task-id>`, and
you then execute with no approval at all (one you send is refused).

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
  | { approvalId: string; phrase?: string }
  | undefined;
// In enforced mode this waits on the operator: until `melra approve` records a
// decision it fails with approval_awaiting_operator, so call it again then.
const result = await melra.execute(
  task.id as string,
  approval?.phrase === undefined
    ? undefined
    : { approvalId: approval.approvalId, phrase: approval.phrase },
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

The server gets this process's environment except `MELRA_UNHINGED` and
`MELRA_SOCKET`, and except `MELRA_WORKSPACE` when you pass `cwd`, which then
decides the workspace. So a credential a policy reads from the environment,
`MELRA_BROWSER*`, `LANG` and `CI` reach it, as they do from the Python SDK.
`env` goes on top of all of it: pass any of the three left out there to mean
it.

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
`https:`, or, on a network you trust end to end such as a private container
network, pass `allowInsecureHttp: true`. A wrong token fails `connect()` with
`melra_unauthorized`.

`execute()` and `advanceWorkflow()` wait up to 36 minutes for the server: a
task's 15-minute budget cap, then up to 20 built-in evidence reads of a minute
each (for tasks without an execution budget). So the SDK does not give up on an
effect the server is still running. Set `runTimeoutMs` in `connect()`, in whole
milliseconds up to 2147483647, for what that does not cover:

- custom verifiers and `file_hash` on a very large file, which have no time limit;
- an `advanceWorkflow()` call that runs several tasks in turn: a loop's or a
  branch's steps, or, when a step fails, every compensation.

The wait is per call, not per task. After a timeout, read the task or the run
(`status()`, `workflowStatus()`) before acting on it: the server may still be at
work.

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
