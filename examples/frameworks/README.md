# Connecting MELRA from agent frameworks

These are documentation snippets, not task requests: each file shows how an
agent built in code reaches MELRA, the same way a desktop client does — by
spawning `melra serve` and speaking MCP over stdio. MELRA then owns the effect
lifecycle (policy, approval, execution, verification, receipt) whatever the
framework above it decides.

| File | Framework | Install | Tested |
|---|---|---|---|
| [`mcp_sdk.ts`](mcp_sdk.ts) | Official MCP TypeScript SDK | `npm install @modelcontextprotocol/sdk` | run in CI |
| [`mcp_sdk.py`](mcp_sdk.py) | Official MCP Python SDK | `pip install mcp` | run in CI |
| [`langchain_agent.py`](langchain_agent.py) | LangChain / LangGraph via `langchain-mcp-adapters` | `pip install langchain langchain-mcp-adapters langchain-openai` | run in CI, `--no-model` |
| [`openai_agents.py`](openai_agents.py) | OpenAI Agents SDK (`MCPServerStdio`) | `pip install openai-agents` | run in CI, `--no-model` |
| [`vercel_ai_sdk.ts`](vercel_ai_sdk.ts) | Vercel AI SDK (`@ai-sdk/mcp`) | `npm install ai @ai-sdk/mcp @ai-sdk/openai @modelcontextprotocol/sdk` | run in CI, `--no-model` |

Each one does the MCP part with no model and no API key: start MELRA over
stdio, list its tools and call `melra_capabilities`. The two MCP SDK snippets
do nothing else; the other three do it and stop when given `--no-model`
(`python langchain_agent.py --no-model`, `node vercel_ai_sdk.ts --no-model`),
and otherwise go on to a model.

CI's `framework-examples` job runs all five against the built CLI, from a
`melra` on `PATH`, the other three with `--no-model`, and fails unless each
prints MELRA's capabilities, at exact versions: the JavaScript libraries from
this folder's [`package.json`](package.json) and `package-lock.json` (with
`npm ci`, never the workspace's own dependencies), the MCP Python SDK from
[`requirements.txt`](requirements.txt), hashes and all, with
`--require-hashes`, which is the tree `sdk-py/uv.lock` pins, and LangChain and
the OpenAI Agents SDK, in a virtual environment of their own, from
[`requirements-frameworks.txt`](requirements-frameworks.txt), which
`uv pip compile --generate-hashes --universal` builds from
[`requirements-frameworks.in`](requirements-frameworks.in). No model is called
anywhere: the part after `--no-model` was written against each library's
documentation and source as of October 2026, and none of these libraries is a
dependency of this repository. The snippets are not type-checked by
`pnpm check` either
(`pnpm readme:check` covers only the `ts` blocks in `apps/*` and `packages/*`
READMEs). If an import has moved, the library's own MCP page is the
authority. LangChain is also folding MCP
support into a `langchain.mcp` namespace (`MCPAdapter`, beta in
`langchain[mcp]>=1.4`) that takes the same `mcpServers` object `melra setup`
prints.

Each snippet launches `melra` from `PATH`. Without an install, use
`command: "npx"` with `args: ["-y", "@melra/cli@alpha", "serve"]`. Set
`MELRA_WORKSPACE` (and, if you keep them elsewhere, `MELRA_HOME` and
`MELRA_POLICY`) the same way the client configs in
[docs/INSTALLATION.md](../../docs/INSTALLATION.md#mcp-clients) do.

## Approvals

A mutation planned through `melra_plan` comes back `awaiting_approval`. In
developer mode it carries an exact phrase that `melra_execute` must echo. Who
echoes it is the harness's decision: route it to a person (the OpenAI Agents
SDK's `require_approval`, a LangGraph interrupt, your own UI) rather than
letting the model approve its own plan. In enforced mode there is no phrase:
an operator approves with `melra approve <task-id>`, `melra_execute` then runs
the task with no approval passed, and any approval the harness sends is
refused. Read-only operations run without one.

## Over HTTP or a Unix socket instead of stdio

To share one running MELRA between several agents, start it once and connect
to it rather than spawning it per agent:

```bash
MELRA_HTTP_TOKEN=<token> melra serve --http   # http://127.0.0.1:7457/mcp
```

Then point the framework's Streamable HTTP transport at
`http://127.0.0.1:7457/mcp` with the header `Authorization: Bearer <token>`:
`{"transport": "streamable_http", "url": ..., "headers": {...}}` in
`MultiServerMCPClient`, `MCPServerStreamableHttp(params={"url": ..., "headers": {...}})`
in the OpenAI Agents SDK, `transport: { type: "http", url, headers }` in
`createMCPClient`, or `StreamableHTTPClientTransport` with `requestInit.headers`
in the MCP SDK. `melra serve --socket <path>` serves the same thing on a
mode-`0600` Unix socket; MELRA's own SDKs (`@melra/sdk`, the Python `melra`
package, [installed from a release or a checkout](../../sdk-py/README.md#install),
not from PyPI) connect to it directly. See
[docs/INSTALLATION.md](../../docs/INSTALLATION.md#http-server-and-console).
