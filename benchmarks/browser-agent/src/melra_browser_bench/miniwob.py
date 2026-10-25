# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import asyncio
import json
import os
import shutil
import threading
from collections.abc import AsyncIterator, Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar
from unittest.mock import patch
from urllib.parse import urlparse

from melra import MelraClient

from .agent import AgentContext, BrowserActionDecision
from .chrome import ChromeCdpProcess
from .mcp_driver import MelraBrowserDriver

T = TypeVar("T")


@dataclass(frozen=True)
class MiniWobStep:
    observation: dict[str, object]
    reward: float
    terminated: bool
    truncated: bool
    info: dict[str, object]


def discover_miniwob_tasks() -> tuple[str, ...]:
    try:
        import browsergym.miniwob  # noqa: F401
        import gymnasium as gym
    except ImportError as error:
        raise RuntimeError("miniwob_extra_required: install with --extra miniwob") from error
    return tuple(
        sorted(
            task_id for task_id in gym.envs.registry if task_id.startswith("browsergym/miniwob.")
        )
    )


_PLAYWRIGHT_EXECUTOR: ThreadPoolExecutor | None = None
_PLAYWRIGHT_EXECUTOR_LOCK = threading.Lock()


def playwright_executor() -> ThreadPoolExecutor:
    """The one thread every Playwright call in this process must use.

    BrowserGym keeps a process-global sync Playwright bound to whichever thread
    first created it, and Playwright's sync API cannot be driven from another
    thread. Giving each task its own worker leaves that global pointing at a
    thread that has since exited, so every task after the first dies with
    greenlet.error. One process-wide worker avoids that, and it is deliberately
    never shut down: a later task would rebind to a dead thread again.
    """
    global _PLAYWRIGHT_EXECUTOR
    with _PLAYWRIGHT_EXECUTOR_LOCK:
        if _PLAYWRIGHT_EXECUTOR is None:
            _PLAYWRIGHT_EXECUTOR = ThreadPoolExecutor(
                max_workers=1, thread_name_prefix="melra-miniwob"
            )
        return _PLAYWRIGHT_EXECUTOR


def _serializable_observation(unwrapped: Any, observation: dict[str, Any]) -> dict[str, object]:
    page = unwrapped.page
    return {
        "goal": str(observation.get("goal", "")),
        "url": str(page.url),
        "text": page.locator("body").inner_text()[:20_000],
        "elements": page.locator("a,button,input,select,textarea,[role],[tabindex]").evaluate_all(
            """elements => elements.slice(0, 250).map(element => ({
                tag: element.tagName.toLowerCase(),
                role: element.getAttribute('role'),
                name: element.getAttribute('aria-label')
                    || element.getAttribute('alt')
                    || element.getAttribute('title')
                    || element.innerText?.trim().slice(0, 200)
                    || null,
                type: element.getAttribute('type')
            }))"""
        ),
    }


class MiniWobEnvironment:
    def __init__(
        self,
        *,
        gym_environment: Any,
        executor: ThreadPoolExecutor,
        chrome: ChromeCdpProcess,
        context_index: int,
        initial: MiniWobStep,
        base_url: str,
        workspace: Path,
        repository: Path,
    ) -> None:
        self._gym_environment = gym_environment
        self._executor = executor
        self._chrome = chrome
        self._context_index = context_index
        self._base_url = base_url
        self._workspace = workspace.resolve()
        self._repository = repository.resolve()
        self.initial = initial
        self._latest = initial

    async def _worker(self, function: Callable[[], T]) -> T:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, function)

    @classmethod
    @asynccontextmanager
    async def open(
        cls,
        task_name: str,
        *,
        base_url: str,
        browser_executable: Path,
        workspace: Path,
        seed: int = 0,
        repository: Path | None = None,
    ) -> AsyncIterator[MiniWobEnvironment]:
        repository_root = (
            repository.resolve() if repository is not None else Path(__file__).resolve().parents[4]
        )
        executor = playwright_executor()
        environment: MiniWobEnvironment | None = None
        async with ChromeCdpProcess.start(browser_executable) as chrome:
            loop = asyncio.get_running_loop()

            def create() -> tuple[Any, int, MiniWobStep]:
                import browsergym.core
                import browsergym.miniwob
                import gymnasium as gym

                playwright = browsergym.core._get_global_playwright()
                browser_type = type(playwright.chromium)
                external_browser = playwright.chromium.connect_over_cdp(chrome.endpoint)
                for startup_page in external_browser.contexts[0].pages:
                    startup_page.close()
                browser_class = type(external_browser)
                original_launch = browser_type.launch
                original_new_context = browser_class.new_context
                launch_count = 0

                def launch(browser: Any, **kwargs: object) -> Any:
                    nonlocal launch_count
                    launch_count += 1
                    if launch_count == 1:
                        return external_browser
                    return original_launch(
                        browser,
                        executable_path=str(browser_executable),
                        **kwargs,
                    )

                def new_context(browser: Any, **kwargs: object) -> Any:
                    if browser is external_browser:
                        contexts = list(browser.contexts)
                        if len(contexts) != 1:
                            raise RuntimeError("miniwob_default_cdp_context_missing")
                        return contexts[0]
                    return original_new_context(browser, **kwargs)

                with (
                    patch.object(browser_type, "launch", launch),
                    patch.object(browser_class, "new_context", new_context),
                ):
                    gym_environment = gym.make(
                        task_name,
                        headless=True,
                        task_kwargs={"base_url": base_url},
                        use_raw_page_output=True,
                        pre_observation_delay=0,
                    )
                    observation, info = gym_environment.reset(seed=seed)
                unwrapped = gym_environment.unwrapped
                contexts = list(unwrapped.browser.contexts)
                context_index = contexts.index(unwrapped.context)
                initial = MiniWobStep(
                    observation=_serializable_observation(unwrapped, observation),
                    reward=0,
                    terminated=False,
                    truncated=False,
                    info={"task_info": info.get("task_info", {})},
                )
                return gym_environment, context_index, initial

            try:
                gym_environment, context_index, initial = await loop.run_in_executor(
                    executor, create
                )
                environment = cls(
                    gym_environment=gym_environment,
                    executor=executor,
                    chrome=chrome,
                    context_index=context_index,
                    initial=initial,
                    base_url=base_url,
                    workspace=workspace,
                    repository=repository_root,
                )
                yield environment
            finally:
                if environment is not None:

                    def close() -> None:
                        environment._gym_environment.close()

                    await loop.run_in_executor(executor, close)

    async def prepare_external_action(self) -> None:
        def prepare() -> None:
            unwrapped = self._gym_environment.unwrapped
            unwrapped.last_action = "melra_external_action"
            info, _, _ = unwrapped.pre_step()
            unwrapped._melra_external_step_info = info

        await self._worker(prepare)

    async def observe_after_mcp_action(self) -> MiniWobStep:
        def observe() -> MiniWobStep:
            unwrapped = self._gym_environment.unwrapped
            info = getattr(unwrapped, "_melra_external_step_info", None)
            if not isinstance(info, dict):
                raise TypeError("miniwob_external_action_not_prepared")
            del unwrapped._melra_external_step_info
            observation, reward, terminated, truncated, result_info = unwrapped.post_step(info)
            return MiniWobStep(
                observation=_serializable_observation(unwrapped, observation),
                reward=float(reward),
                terminated=bool(terminated),
                truncated=bool(truncated),
                info={"task_info": result_info.get("task_info", {})},
            )

        self._latest = await self._worker(observe)
        return self._latest

    def agent_context(self, history: list[dict[str, object]]) -> AgentContext:
        return AgentContext(
            goal=str(self.initial.observation["goal"]),
            observation=self._latest.observation,
            history=tuple(history),
        )

    def evidence_for(self, decision: BrowserActionDecision) -> list[dict[str, object]]:
        match decision.action:
            case "click":
                return [{"type": "result_equals", "path": "clicked", "value": True}]
            case "type":
                return [{"type": "result_equals", "path": "typed", "value": True}]
            case "press":
                return [
                    {
                        "type": "result_equals",
                        "path": "pressed",
                        "value": decision.key or "",
                    }
                ]
            case "upload":
                return [
                    {
                        "type": "result_equals",
                        "path": "uploaded",
                        "value": len(decision.file_paths or ()),
                    }
                ]
            case "download":
                return [
                    {
                        "type": "result_equals",
                        "path": "downloaded",
                        "value": True,
                    }
                ]
            case "close":
                return [{"type": "result_equals", "path": "closed", "value": True}]
            case "select":
                target = decision.target or {}
                visible_name = target.get("name") or target.get("text")
                if isinstance(visible_name, str) and visible_name:
                    return [{"type": "page_contains", "text": visible_name}]
                raise ValueError("select_action_requires_verifiable_target")
            case _:
                return []

    @asynccontextmanager
    async def melra_driver(self) -> AsyncIterator[MelraBrowserDriver]:
        node = shutil.which("node")
        cli = self._repository / "apps" / "cli" / "dist" / "index.js"
        if node is None or not cli.is_file():
            raise RuntimeError("built_melra_cli_required")
        parsed_url = urlparse(self._base_url)
        if parsed_url.hostname is None:
            raise ValueError("miniwob_base_url_hostname_required")
        data_directory = self._workspace / ".melra-miniwob"
        data_directory.mkdir(parents=True, exist_ok=True)
        policy_path = data_directory / "policy.json"
        policy_path.write_text(
            json.dumps(
                {
                    "version": "miniwob-benchmark-v1",
                    "workspaceRoot": str(self._workspace),
                    "allowedCommands": [],
                    "allowedDomains": [parsed_url.hostname],
                    "allowLocalhost": parsed_url.hostname in {"127.0.0.1", "localhost"},
                    "mutations": "confirm",
                    "approvalTtlMs": 300_000,
                    "maxFileBytes": 1_000_000,
                },
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        async with MelraClient(
            command=node,
            args=[str(cli), "serve"],
            workspace=self._workspace,
            data_directory=data_directory,
            environment={
                "PATH": os.environ["PATH"],
                "MELRA_POLICY": str(policy_path),
                "MELRA_BROWSER_CDP_ENDPOINT": self._chrome.endpoint,
                "MELRA_BROWSER_CDP_CONTEXT_INDEX": str(self._context_index),
            },
        ) as client:
            yield MelraBrowserDriver(client)
