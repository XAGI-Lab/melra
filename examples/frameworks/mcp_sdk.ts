// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// The official MCP TypeScript SDK, with no agent framework on top: the
// smallest client there is, and the one MELRA's own conformance suite uses.
// npm install @modelcontextprotocol/sdk
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "my-harness", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "melra", // or "npx" with args ["-y", "@melra/cli@alpha", "serve"]
    args: ["serve"],
    // Merged over the SDK's default environment (PATH, HOME, ...).
    env: { MELRA_WORKSPACE: process.cwd() },
  }),
);
try {
  const { tools } = await client.listTools();
  console.log(tools.map((tool) => tool.name));
  const result = await client.callTool({ name: "melra_capabilities", arguments: {} });
  console.log(result.content);
} finally {
  await client.close();
}
