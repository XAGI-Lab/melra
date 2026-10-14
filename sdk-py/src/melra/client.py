# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import ipaddress
import json
import os
import sys
from contextlib import AsyncExitStack
from pathlib import Path
from types import TracebackType
from typing import Any, Self
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp import types as mcp_types
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client


class MelraClient:
    """Async client for the high-level MELRA task interface."""

    def __init__(
        self,
        *,
        command: str = "melra",
        args: list[str] | None = None,
        workspace: str | Path | None = None,
        data_directory: str | Path | None = None,
        environment: dict[str, str] | None = None,
    ) -> None:
        env = dict(os.environ)
        if workspace is not None:
            env["MELRA_WORKSPACE"] = str(Path(workspace).resolve())
        if data_directory is not None:
            env["MELRA_HOME"] = str(Path(data_directory).resolve())
        if environment is not None:
            env.update(environment)
        self._parameters = StdioServerParameters(
            command=command,
            args=args or ["serve"],
            env=env,
        )
        # (MCP URL, bearer token, Unix socket path) when connecting to a running
        # server instead of spawning one.
        self._remote: tuple[str, str, str | None] | None = None
        self._stack: AsyncExitStack | None = None
        self._session: ClientSession | None = None

    @classmethod
    def connect_http(
        cls,
        url: str,
        *,
        token: str | None = None,
        allow_insecure_http: bool = False,
    ) -> Self:
        """Connect to a server already running under `melra serve --http`.

        `url` is the MCP endpoint printed at startup (`http://127.0.0.1:7457/mcp`);
        a URL without the `/mcp` path gets it appended. `token` defaults to
        `MELRA_HTTP_TOKEN`. The token drives the machine, so plain `http://` is
        refused for anything but a loopback host unless `allow_insecure_http` is
        set; use `https://` to reach a server through a TLS proxy.
        """
        parts = urlsplit(url)
        host = parts.hostname
        if parts.scheme not in {"http", "https"} or not host:
            raise ValueError("url must be an http:// or https:// URL")
        if parts.scheme == "http" and not allow_insecure_http and not _is_loopback(host):
            raise ValueError(
                f"refusing to send the MELRA token over plain http to {host}; "
                "use https, a loopback address, or allow_insecure_http=True"
            )
        path = parts.path if parts.path.endswith("/mcp") else parts.path.rstrip("/") + "/mcp"
        client = cls()
        client._remote = (urlunsplit(parts._replace(path=path)), _token(token), None)
        return client

    @classmethod
    def connect_socket(cls, path: str | Path, *, token: str | None = None) -> Self:
        """Connect to a server already running under `melra serve --socket <path>`.

        The socket is mode 0600, so only this OS user gets in; the token is still
        required and defaults to `MELRA_HTTP_TOKEN`. Not available on Windows.
        """
        if sys.platform == "win32":
            raise OSError("socket_transport_unsupported_on_windows: use connect_http on loopback")
        client = cls()
        client._remote = ("http://localhost/mcp", _token(token), str(path))
        return client

    async def __aenter__(self) -> Self:
        try:
            async with AsyncExitStack() as stack:
                if self._remote is None:
                    read, write = await stack.enter_async_context(stdio_client(self._parameters))
                else:
                    url, token, socket_path = self._remote
                    http = await stack.enter_async_context(
                        httpx.AsyncClient(
                            headers={"Authorization": f"Bearer {token}"},
                            # The MCP SDK's own defaults: 30 s, 5 min for the event stream.
                            timeout=httpx.Timeout(30.0, read=300.0),
                            transport=(
                                None
                                if socket_path is None
                                else httpx.AsyncHTTPTransport(uds=socket_path)
                            ),
                        )
                    )
                    read, write, _ = await stack.enter_async_context(
                        streamable_http_client(url, http_client=http)
                    )
                session = await stack.enter_async_context(ClientSession(read, write))
                await session.initialize()
                self._stack = stack.pop_all()
        except BaseExceptionGroup as group:
            # The MCP transport reports a refused request from inside its task
            # group; name the one failure a caller can fix.
            if group.subgroup(_unauthorized) is not None:
                raise PermissionError(
                    "MELRA rejected the token (HTTP 401); check token or MELRA_HTTP_TOKEN"
                ) from group
            raise
        self._session = session
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if self._stack is not None:
            await self._stack.aclose()
        self._stack = None
        self._session = None

    @property
    def session(self) -> ClientSession:
        if self._session is None:
            raise RuntimeError("MelraClient must be used as an async context manager")
        return self._session

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Call one MELRA tool and parse its JSON text result."""
        result = await self.session.call_tool(name, arguments)
        text = next(
            (
                content.text
                for content in result.content
                if isinstance(content, mcp_types.TextContent)
            ),
            None,
        )
        if text is None:
            raise RuntimeError("MELRA returned no JSON text result")
        if result.isError:
            raise RuntimeError(text)
        parsed: dict[str, Any] = json.loads(text)
        return parsed

    async def capabilities(self) -> dict[str, Any]:
        """Read the server's capabilities, policy defaults, and runtime limits."""
        return await self.call_tool("melra_capabilities", {})

    async def plan(self, request: dict[str, Any]) -> dict[str, Any]:
        """Plan a task without running it.

        A mutation comes back with an approval challenge to echo to `execute`.
        A refusal is a normal result with `status` `policy_blocked` and a reason,
        not an exception. Leave `constraints` out — any value denies — and give
        `requiredEvidence` for anything that is not a read.
        """
        return await self.call_tool("melra_plan", request)

    async def execute(
        self,
        task_id: str,
        approval: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Run a planned task, verify it, and receipt it.

        Pass the challenge from `plan` as `{"approvalId": ..., "phrase": ...}`
        when there was one; the phrase is scoped to this task and expires.
        Policy is evaluated again here, so a plan made under a looser policy is
        still refused.
        """
        arguments: dict[str, Any] = {"taskId": task_id}
        if approval is not None:
            arguments["approval"] = approval
        return await self.call_tool("melra_execute", arguments)

    async def status(self, task_id: str) -> dict[str, Any]:
        """Read a task's durable state."""
        return await self.call_tool("melra_task_status", {"taskId": task_id})

    async def cancel(self, task_id: str) -> dict[str, Any]:
        """Cooperatively cancel a running or pending task."""
        return await self.call_tool("melra_task_cancel", {"taskId": task_id})

    async def receipt(
        self,
        *,
        task_id: str | None = None,
        receipt_id: str | None = None,
    ) -> dict[str, Any]:
        """Retrieve action receipts and the execution certificate."""
        if task_id is None and receipt_id is None:
            raise ValueError("task_id or receipt_id is required")
        arguments: dict[str, Any] = {}
        if task_id is not None:
            arguments["taskId"] = task_id
        if receipt_id is not None:
            arguments["receiptId"] = receipt_id
        return await self.call_tool("melra_receipt", arguments)

    async def plan_workflow(
        self,
        definition: dict[str, Any],
    ) -> dict[str, Any]:
        """Validate and persist a workflow without running any of it."""
        if not isinstance(definition, dict):
            raise TypeError("definition must be an object")
        return self._object(
            await self.call_tool(
                "melra_workflow_plan",
                {"definition": definition},
            ),
            "workflow plan",
        )

    async def advance_workflow(
        self,
        workflow_id: str,
        *,
        approvals: list[dict[str, str]] | None = None,
        inputs: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Run one scheduling wave.

        Call until the run reaches a terminal status; committed effects are not
        repeated. `approvals` answers approval nodes, `inputs` answers
        `human_input` nodes as `{"nodeId": ..., "value": ...}`.
        """
        workflow_id = self._workflow_id(workflow_id)
        parsed_approvals = approvals or []
        for approval in parsed_approvals:
            self._workflow_id(
                approval.get("approvalId", ""),
                name="approvalId",
            )
            if not approval.get("phrase"):
                raise ValueError("approval phrase is required")
        parsed_inputs = inputs or []
        for supplied in parsed_inputs:
            if not supplied.get("nodeId"):
                raise ValueError("input nodeId is required")
        return self._object(
            await self.call_tool(
                "melra_workflow_advance",
                {
                    "workflowId": workflow_id,
                    "approvals": parsed_approvals,
                    "inputs": parsed_inputs,
                },
            ),
            "workflow advance",
        )

    async def workflow_status(self, workflow_id: str) -> dict[str, Any]:
        """Read the current durable workflow projection."""
        return self._object(
            await self.call_tool(
                "melra_workflow_status",
                {"workflowId": self._workflow_id(workflow_id)},
            ),
            "workflow status",
        )

    async def cancel_workflow(self, workflow_id: str) -> dict[str, Any]:
        """Cooperatively cancel nonterminal workflow nodes and their tasks."""
        return self._object(
            await self.call_tool(
                "melra_workflow_cancel",
                {"workflowId": self._workflow_id(workflow_id)},
            ),
            "workflow cancellation",
        )

    async def control_workflow(
        self,
        workflow_id: str,
        action: str,
    ) -> dict[str, Any]:
        """Pause, resume, or suspend a run without losing its place."""
        if action not in {"pause", "resume", "suspend"}:
            raise ValueError("action must be pause, resume, or suspend")
        return self._object(
            await self.call_tool(
                "melra_workflow_control",
                {
                    "workflowId": self._workflow_id(workflow_id),
                    "action": action,
                },
            ),
            "workflow control",
        )

    @staticmethod
    def _workflow_id(value: str, *, name: str = "workflow_id") -> str:
        try:
            UUID(value)
        except (TypeError, ValueError, AttributeError) as error:
            raise ValueError(f"{name} must be a UUID") from error
        return value

    @staticmethod
    def _object(value: Any, operation: str) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise TypeError(f"MELRA {operation} returned a non-object")
        return value


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _token(token: str | None) -> str:
    resolved = (token if token is not None else os.environ.get("MELRA_HTTP_TOKEN", "")).strip()
    if not resolved:
        raise ValueError("token is required (or set MELRA_HTTP_TOKEN)")
    return resolved


def _unauthorized(error: BaseException) -> bool:
    return isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 401
