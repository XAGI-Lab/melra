# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, call

import pytest

from melra import MelraClient


@pytest.mark.asyncio
async def test_python_sdk_uses_the_real_stdio_server(tmp_path: Path) -> None:
    repository = Path(__file__).resolve().parents[2]
    cli = repository / "apps" / "cli" / "dist" / "index.js"
    assert cli.exists(), "run pnpm build before the Python SDK test"
    node = shutil.which("node")
    assert node is not None

    async with MelraClient(
        command=node,
        args=[str(cli), "serve"],
        workspace=tmp_path,
        data_directory=tmp_path / ".melra",
        environment={
            "PATH": os.environ["PATH"],
        },
    ) as melra:
        direct_capabilities = await melra.call_tool("melra_capabilities", {})
        assert direct_capabilities["tools"] == [
            "melra_capabilities",
            "melra_plan",
            "melra_execute",
            "melra_task_status",
            "melra_task_cancel",
            "melra_receipt",
            "melra_task_judge",
            "melra_workflow_plan",
            "melra_workflow_advance",
            "melra_workflow_status",
            "melra_workflow_cancel",
            "melra_workflow_control",
        ]
        capabilities = await melra.capabilities()
        assert capabilities["product"] == "MELRA"
        task = await melra.plan(
            {
                "goal": "Inspect the system through Python",
                "operation": {"kind": "system", "action": "info"},
            }
        )
        execution = await melra.execute(task["id"])
        assert execution["task"]["status"] == "verified_success"


@pytest.mark.asyncio
async def test_python_sdk_calls_workflow_tools_with_validated_inputs() -> None:
    workflow_id = "11111111-1111-4111-8111-111111111111"
    definition = {
        "schemaVersion": "1.0.0",
        "id": "22222222-2222-4222-8222-222222222222",
        "version": 1,
        "name": "Python SDK workflow",
        "nodes": [],
    }
    approval = {
        "approvalId": "33333333-3333-4333-8333-333333333333",
        "phrase": "APPROVE exact",
    }
    supplied = {"nodeId": "review", "value": "ship it"}
    client = MelraClient()
    tool = AsyncMock(
        side_effect=[
            {"id": workflow_id},
            {"run": {"id": workflow_id}, "tasks": [], "events": []},
            {"id": workflow_id},
            {"id": workflow_id},
            {"id": workflow_id},
        ]
    )
    client.call_tool = tool

    await client.plan_workflow(definition)
    await client.advance_workflow(
        workflow_id,
        approvals=[approval],
        inputs=[supplied],
    )
    await client.workflow_status(workflow_id)
    await client.control_workflow(workflow_id, "pause")
    await client.cancel_workflow(workflow_id)

    assert tool.await_args_list == [
        call("melra_workflow_plan", {"definition": definition}),
        call(
            "melra_workflow_advance",
            {
                "workflowId": workflow_id,
                "approvals": [approval],
                "inputs": [supplied],
            },
        ),
        call("melra_workflow_status", {"workflowId": workflow_id}),
        call(
            "melra_workflow_control",
            {"workflowId": workflow_id, "action": "pause"},
        ),
        call("melra_workflow_cancel", {"workflowId": workflow_id}),
    ]
    with pytest.raises(ValueError, match="workflow_id must be a UUID"):
        await client.workflow_status("not-a-uuid")
    with pytest.raises(ValueError, match="action must be"):
        await client.control_workflow(workflow_id, "destroy")


TOKEN = "python-sdk-test-token"


@contextmanager
def _served(tmp_path: Path, args: list[str], ready: Callable[[], bool]) -> Iterator[None]:
    """Run `melra serve <args>` until the block exits, however it exits."""
    repository = Path(__file__).resolve().parents[2]
    cli = repository / "apps" / "cli" / "dist" / "index.js"
    assert cli.exists(), "run pnpm build before the Python SDK test"
    node = shutil.which("node")
    assert node is not None
    log = tmp_path / "server.log"
    with log.open("wb") as stderr:
        server = subprocess.Popen(
            [node, str(cli), "serve", *args],
            # The caller's environment (Windows needs SYSTEMROOT and friends),
            # minus any MELRA_* setting that would change what is served.
            env={
                **{k: v for k, v in os.environ.items() if not k.startswith("MELRA_")},
                "MELRA_WORKSPACE": str(tmp_path),
                "MELRA_HOME": str(tmp_path / ".melra"),
                "MELRA_HTTP_TOKEN": TOKEN,
            },
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=stderr,
        )
        try:
            deadline = time.monotonic() + 30
            while not ready():
                assert server.poll() is None, f"server exited: {log.read_text()}"
                assert time.monotonic() < deadline, f"server not ready: {log.read_text()}"
                time.sleep(0.1)
            yield
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


async def _plan_execute_receipt(melra: MelraClient) -> None:
    capabilities = await melra.capabilities()
    assert capabilities["product"] == "MELRA"
    task = await melra.plan(
        {
            "goal": "Inspect the system over a remote transport",
            "operation": {"kind": "system", "action": "info"},
        }
    )
    execution = await melra.execute(task["id"])
    assert execution["task"]["status"] == "verified_success"
    evidence = await melra.receipt(task_id=task["id"])
    assert len(evidence["receipts"]) == 1


@pytest.mark.asyncio
async def test_python_sdk_connects_to_a_running_http_server(tmp_path: Path) -> None:
    # Port 0 lets the OS pick, so nothing can take the port between choosing it
    # and binding it; the startup banner on stderr names the one it picked.
    port = 0
    banner = re.compile(rb"listening on http://127\.0\.0\.1:(\d+)")

    def listening() -> bool:
        nonlocal port
        log = tmp_path / "server.log"
        found = banner.search(log.read_bytes()) if log.exists() else None
        if found is not None:
            port = int(found.group(1))
        return found is not None

    with _served(tmp_path, ["--http", "--port", "0"], listening):
        # The console URL's base is accepted too; `/mcp` is appended.
        async with MelraClient.connect_http(f"http://127.0.0.1:{port}", token=TOKEN) as melra:
            await _plan_execute_receipt(melra)
        with pytest.raises(PermissionError, match="401"):
            async with MelraClient.connect_http(
                f"http://127.0.0.1:{port}/mcp", token="wrong-token"
            ):
                pass
        # A proxy in the environment is not on the way to loopback: it would read
        # the token off the plain http request. This one refuses connections, so
        # a request routed through it fails.
        with socket.socket() as closed:
            closed.bind(("127.0.0.1", 0))
            proxy = f"http://127.0.0.1:{closed.getsockname()[1]}"
        with pytest.MonkeyPatch.context() as environment:
            for name in ("NO_PROXY", "no_proxy"):
                environment.delenv(name, raising=False)
            for name in ("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
                environment.setenv(name, proxy)
            async with MelraClient.connect_http(
                f"http://127.0.0.1:{port}/mcp", token=TOKEN
            ) as melra:
                assert (await melra.capabilities())["product"] == "MELRA"


@pytest.mark.skipif(sys.platform == "win32", reason="Unix sockets are POSIX-only")
@pytest.mark.asyncio
async def test_python_sdk_connects_to_a_running_socket_server(tmp_path: Path) -> None:
    # A short directory: macOS caps a socket path at 104 bytes and tmp_path is longer.
    with tempfile.TemporaryDirectory(dir="/tmp") as directory:
        path = Path(directory) / "melra.sock"
        with _served(tmp_path, ["--socket", str(path)], path.is_socket):
            async with MelraClient.connect_socket(path, token=TOKEN) as melra:
                await _plan_execute_receipt(melra)


def test_python_sdk_does_not_pass_on_an_inherited_unsafe_local_or_socket(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MELRA_UNHINGED", "1")
    monkeypatch.setenv("MELRA_SOCKET", "/tmp/melra.sock")
    monkeypatch.setenv("MELRA_MODE", "enforced")
    env = MelraClient()._parameters.env or {}
    assert "MELRA_UNHINGED" not in env
    assert "MELRA_SOCKET" not in env
    # A stricter mode, and everything else, still carry over.
    assert env["MELRA_MODE"] == "enforced"
    # Asked for in code, it is passed.
    explicit = MelraClient(environment={"MELRA_UNHINGED": "1"})._parameters.env or {}
    assert explicit["MELRA_UNHINGED"] == "1"


def test_python_sdk_refuses_to_send_the_token_where_it_should_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ValueError, match="plain http"):
        MelraClient.connect_http("http://melra.example.com:7457/mcp", token=TOKEN)
    MelraClient.connect_http("https://melra.example.com/mcp", token=TOKEN)
    MelraClient.connect_http("http://[::1]:7457/mcp", token=TOKEN)
    MelraClient.connect_http("http://melra.internal/mcp", token=TOKEN, allow_insecure_http=True)
    with pytest.raises(ValueError, match="http:// or https://"):
        MelraClient.connect_http("ftp://127.0.0.1/mcp", token=TOKEN)
    # Required, and never taken from the environment even when it is set there.
    monkeypatch.setenv("MELRA_HTTP_TOKEN", TOKEN)
    with pytest.raises(ValueError, match="token is required"):
        MelraClient.connect_http("http://127.0.0.1:7457/mcp", token="  ")
    monkeypatch.setattr(sys, "platform", "win32")
    with pytest.raises(OSError, match="unsupported_on_windows"):
        MelraClient.connect_socket("/tmp/melra.sock", token=TOKEN)
