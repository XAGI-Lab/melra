# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: Apache-2.0

# The official MCP Python SDK, with no agent framework on top.
# pip install mcp
import asyncio
import os

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

MELRA = StdioServerParameters(
    command="melra",  # or "npx" with args ["-y", "@melra/cli@alpha", "serve"]
    args=["serve"],
    env={"MELRA_WORKSPACE": os.getcwd()},
)


async def main() -> None:
    async with stdio_client(MELRA) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        tools = await session.list_tools()
        print([tool.name for tool in tools.tools])
        result = await session.call_tool("melra_capabilities", {})
        print(result.content)


asyncio.run(main())
