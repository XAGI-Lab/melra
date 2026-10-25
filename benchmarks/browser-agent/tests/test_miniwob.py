# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import functools
import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

pytest.importorskip("browsergym.miniwob")

from melra_browser_bench.agent import BrowserActionDecision
from melra_browser_bench.miniwob import MiniWobEnvironment, discover_miniwob_tasks

MANIFEST = Path(__file__).parents[1] / "manifests" / "miniwob-125-v1.json"
ASSETS = Path.home() / "Library" / "Caches" / "melra-benchmarks" / "miniwob-plusplus-7fd85d71"


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


@contextmanager
def asset_server() -> Iterator[str]:
    handler = functools.partial(_QuietHandler, directory=str(ASSETS))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}/miniwob/html/miniwob/"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def browser_executable() -> Path | None:
    candidates = [
        Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
    ]
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def test_registered_manifest_matches_pinned_browsergym() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert manifest["upstream"]["version"] == "0.14.3"
    assert len(manifest["tasks"]) == 125
    assert len(set(manifest["tasks"])) == 125
    assert set(manifest["tasks"]) == set(discover_miniwob_tasks())


@pytest.mark.asyncio
async def test_melra_action_changes_the_page_browsergym_scores(tmp_path: Path) -> None:
    executable = browser_executable()
    if executable is None:
        pytest.skip("supported browser is not installed")
    if not (ASSETS / "miniwob" / "html" / "miniwob" / "click-test.html").is_file():
        pytest.skip("pinned MiniWoB++ assets are not installed")
    with asset_server() as base_url:
        async with MiniWobEnvironment.open(
            "browsergym/miniwob.click-test",
            base_url=base_url,
            browser_executable=executable,
            workspace=tmp_path,
            seed=0,
        ) as environment:
            assert environment.initial.reward == 0
            assert environment.initial.terminated is False
            async with environment.melra_driver() as driver:
                await environment.prepare_external_action()
                observation = await driver.perform(
                    BrowserActionDecision(
                        goal="Click the only button",
                        action="click",
                        target={"role": "button", "name": "Click Me!"},
                    ),
                    [{"type": "page_contains", "text": "Click Me!"}],
                )
                assert observation.task_status == "verified_success", (
                    observation.output,
                    observation.receipt.get("error"),
                    observation.receipt.get("evidence"),
                )
                after = await environment.observe_after_mcp_action()
            assert after.reward == 1
            assert after.terminated is True


@pytest.mark.asyncio
async def test_consecutive_tasks_reuse_one_playwright_thread(tmp_path: Path) -> None:
    """A suite runs many tasks in one process, so opening twice must work.

    BrowserGym's sync Playwright is a process-global bound to whichever thread
    first created it. Giving each task its own worker thread leaves that global
    pointing at a thread that has exited, and the second task dies with
    greenlet.error rather than running.
    """
    executable = browser_executable()
    if executable is None:
        pytest.skip("supported browser is not installed")
    if not (ASSETS / "miniwob" / "html" / "miniwob" / "click-test.html").is_file():
        pytest.skip("pinned MiniWoB++ assets are not installed")
    with asset_server() as base_url:
        for index, task in enumerate(
            ("browsergym/miniwob.click-test", "browsergym/miniwob.click-button")
        ):
            workspace = tmp_path / str(index)
            workspace.mkdir()
            async with MiniWobEnvironment.open(
                task,
                base_url=base_url,
                browser_executable=executable,
                workspace=workspace,
                seed=0,
            ) as environment:
                assert environment.initial.observation["goal"]
