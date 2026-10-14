# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: Apache-2.0

# OpenAI Agents SDK: MELRA as a stdio MCP server the agent's tools come from.
# pip install openai-agents   (and set OPENAI_API_KEY)
import asyncio
import os

from agents import Agent, Runner
from agents.mcp import MCPServerStdio


async def main() -> None:
    async with MCPServerStdio(
        name="melra",
        params={
            "command": "melra",  # or "npx" with args ["-y", "@melra/cli@alpha", "serve"]
            "args": ["serve"],
            "env": {"MELRA_WORKSPACE": os.getcwd()},
        },
        # MELRA's tool list is fixed for the life of the process.
        cache_tools_list=True,
    ) as melra:
        agent = Agent(
            name="operator",
            instructions="Change the world only through the melra tools.",
            mcp_servers=[melra],
        )
        result = await Runner.run(agent, "What can you do on this machine?")
        print(result.final_output)


asyncio.run(main())
