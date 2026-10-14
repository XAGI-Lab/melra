# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: Apache-2.0

# LangChain / LangGraph through langchain-mcp-adapters: MELRA's tools become
# ordinary LangChain tools.
# pip install langchain langchain-mcp-adapters langchain-openai
import asyncio
import os

from langchain.agents import create_agent
from langchain_mcp_adapters.client import MultiServerMCPClient


async def main() -> None:
    client = MultiServerMCPClient(
        {
            "melra": {
                "transport": "stdio",
                "command": "melra",  # or "npx" with args ["-y", "@melra/cli@alpha", "serve"]
                "args": ["serve"],
                "env": {"MELRA_WORKSPACE": os.getcwd()},
            }
        }
    )
    tools = await client.get_tools()
    agent = create_agent("openai:gpt-4.1", tools)
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "What can you do on this machine?"}]}
    )
    print(result["messages"][-1].content)


asyncio.run(main())
