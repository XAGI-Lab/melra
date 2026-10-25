# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import json
import os
import shutil
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from melra import MelraClient

from melra_browser_bench.agent import BrowserActionDecision
from melra_browser_bench.mcp_driver import MelraBrowserDriver


class _FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        body = (
            b"<!doctype html><html><body>"
            b'<label>Search <input aria-label="Search"></label>'
            b"<main>ready</main>"
            b"</body></html>"
        )
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


@contextmanager
def fixture_server() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FixtureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def browser_executable() -> str | None:
    candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    return next((candidate for candidate in candidates if Path(candidate).is_file()), None)


@pytest.mark.asyncio
async def test_mutation_uses_plan_execute_and_receipt(tmp_path: Path) -> None:
    executable = browser_executable()
    if executable is None:
        pytest.skip("supported browser is not installed")
    repository = Path(__file__).resolve().parents[3]
    cli = repository / "apps" / "cli" / "dist" / "index.js"
    node = shutil.which("node")
    assert cli.exists(), "run pnpm build before the benchmark driver test"
    assert node is not None
    policy = tmp_path / "policy.json"
    policy.write_text(
        json.dumps(
            {
                "version": "benchmark-test",
                "workspaceRoot": str(tmp_path),
                "allowedCommands": [],
                "allowedDomains": ["127.0.0.1"],
                "allowLocalhost": True,
                "mutations": "confirm",
                "approvalTtlMs": 300_000,
                "maxFileBytes": 1_000_000,
            }
        ),
        encoding="utf-8",
    )
    with fixture_server() as url:
        async with MelraClient(
            command=node,
            args=[str(cli), "serve"],
            workspace=tmp_path,
            data_directory=tmp_path / ".melra",
            environment={
                "PATH": os.environ["PATH"],
                "MELRA_POLICY": str(policy),
                "MELRA_BROWSER": executable,
            },
        ) as client:
            driver = MelraBrowserDriver(client)
            await driver.perform(
                BrowserActionDecision(goal="Open fixture", action="navigate", url=url),
                [{"type": "page_contains", "text": "ready"}],
            )
            observation = await driver.perform(
                BrowserActionDecision(
                    goal="Type the registered value",
                    action="type",
                    target={"role": "textbox", "name": "Search"},
                    value="verified",
                ),
                [{"type": "page_contains", "text": "ready"}],
            )
    assert observation.plan_status == "awaiting_approval"
    assert observation.task_status == "verified_success"
    assert observation.receipt["taskId"] == observation.task_id
    assert observation.mcp_calls == 3


class _RecordingClient:
    """Captures the plan request so budget/timeout headroom is assertable."""

    def __init__(self) -> None:
        self.request: dict[str, object] | None = None

    async def plan(self, request: dict[str, object]) -> dict[str, object]:
        self.request = request
        return {"id": "task-1", "status": "planned", "request": request}

    async def execute(
        self, _task_id: str, _approval: dict[str, str] | None
    ) -> dict[str, object]:
        return {"task": {"status": "verified_success"}, "output": {"clicked": True}}

    async def receipt(self, *, task_id: str) -> dict[str, object]:
        return {"receipts": [{"taskId": task_id}], "certificate": None}


@pytest.mark.asyncio
async def test_action_timeout_leaves_headroom_under_the_task_budget() -> None:
    """An action must be able to report its own error before the budget aborts.

    Playwright waits `timeoutMs` for a target it cannot resolve. When that equals
    the task's `maxDurationMs`, the budget abort fires at the same moment and
    wins, so a missing target is reported as `budget_exhausted` instead of the
    actual target error — the single largest failure group in the first MiniWoB
    run, and useless for diagnosis.
    """
    client = _RecordingClient()
    driver = MelraBrowserDriver(client)  # type: ignore[arg-type]
    await driver.perform(
        BrowserActionDecision(
            goal="Click Search",
            action="click",
            target={"role": "textbox", "name": "Search"},
        ),
        [{"type": "result_equals", "path": "clicked", "value": True}],
    )
    request = client.request
    assert request is not None
    operation = request["operation"]
    budget = request["budget"]
    assert isinstance(operation, dict) and isinstance(budget, dict)
    action_timeout = operation["timeoutMs"]
    max_duration = budget["maxDurationMs"]
    assert isinstance(action_timeout, int) and isinstance(max_duration, int)
    assert action_timeout < max_duration, (
        "action timeout must expire before the budget so the specific error wins"
    )
