// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Vercel AI SDK: MELRA's tools passed straight to generateText.
// npm install ai @ai-sdk/mcp @ai-sdk/openai @modelcontextprotocol/sdk
// With --no-model it stops after the MCP part, needing no model or API key.
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { openai } from "@ai-sdk/openai";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generateText, stepCountIs } from "ai";

let melra: MCPClient | undefined;
try {
  melra = await createMCPClient({
    transport: new StdioClientTransport({
      command: "melra", // or "npx" with args ["-y", "@melra/cli@alpha", "serve"]
      args: ["serve"],
      env: { MELRA_WORKSPACE: process.cwd() },
    }),
  });
  const tools = await melra.tools();
  if (process.argv.includes("--no-model")) {
    console.log(Object.keys(tools));
    console.log((await melra.callTool({ name: "melra_capabilities", arguments: {} })).content);
  } else {
    const { text } = await generateText({
      model: openai("gpt-4.1"),
      tools,
      // Plan, approve, execute, and read the receipt are separate tool calls.
      stopWhen: stepCountIs(10),
      prompt: "What can you do on this machine?",
    });
    console.log(text);
  }
} finally {
  await melra?.close();
}
