# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol

from .agent import (
    AgentContext,
    AgentProtocol,
    BrowserActionDecision,
    FinalDecision,
    InfeasibleDecision,
    OpenAICompatibleAgent,
)
from .mcp_driver import DriverObservation, MelraBrowserDriver
from .miniwob import (
    MiniWobEnvironment,
    MiniWobStep,
    discover_miniwob_tasks,
)


@dataclass(frozen=True)
class RunLimits:
    max_steps: int
    task_timeout_seconds: float

    def __post_init__(self) -> None:
        if self.max_steps < 1:
            raise ValueError("max_steps_must_be_positive")
        if self.task_timeout_seconds <= 0:
            raise ValueError("task_timeout_must_be_positive")


@dataclass(frozen=True)
class BrowserTaskRecord:
    schema_version: str
    task_id: str
    run_input_digest: str
    success: bool
    reward: float
    failure_category: str | None
    duration_ms: float
    agent_steps: int
    mcp_calls: int
    input_tokens: int | None
    cached_input_tokens: int | None
    output_tokens: int | None
    history: tuple[dict[str, object], ...]


class TaskEnvironment(Protocol):
    def agent_context(self, history: list[dict[str, object]]) -> AgentContext: ...

    def evidence_for(self, decision: BrowserActionDecision) -> list[dict[str, object]]: ...

    async def prepare_external_action(self) -> None: ...

    async def observe_after_mcp_action(self) -> MiniWobStep: ...


class BrowserDriver(Protocol):
    async def perform(
        self,
        decision: BrowserActionDecision,
        expected_evidence: list[dict[str, object]],
    ) -> DriverObservation: ...


def _token_total(values: Sequence[int | None]) -> int | None:
    if any(value is None for value in values):
        return None
    return sum(value for value in values if value is not None)


def build_run_input_digest(
    *,
    manifest: dict[str, object],
    implementation_commit: str,
    model_id: str,
    prompt_sha256: str,
    tool_schema_sha256: str,
) -> str:
    encoded = json.dumps(
        {
            "manifest": manifest,
            "implementation_commit": implementation_commit,
            "model_id": model_id,
            "prompt_sha256": prompt_sha256,
            "tool_schema_sha256": tool_schema_sha256,
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _record(
    *,
    task_id: str,
    run_input_digest: str,
    success: bool,
    reward: float,
    failure_category: str | None,
    started: float,
    history: list[dict[str, object]],
) -> BrowserTaskRecord:
    usages = [item["usage"] for item in history if isinstance(item.get("usage"), dict)]
    return BrowserTaskRecord(
        schema_version="1.0.0",
        task_id=task_id,
        run_input_digest=run_input_digest,
        success=success,
        reward=reward,
        failure_category=failure_category,
        duration_ms=round((time.perf_counter() - started) * 1000, 3),
        agent_steps=len(history),
        mcp_calls=sum(
            item.get("mcp_calls", 0) for item in history if isinstance(item.get("mcp_calls"), int)
        ),
        input_tokens=_token_total(
            [
                usage.get("input_tokens") if isinstance(usage.get("input_tokens"), int) else None
                for usage in usages
            ]
        ),
        cached_input_tokens=_token_total(
            [
                usage.get("cached_input_tokens")
                if isinstance(usage.get("cached_input_tokens"), int)
                else None
                for usage in usages
            ]
        ),
        output_tokens=_token_total(
            [
                usage.get("output_tokens") if isinstance(usage.get("output_tokens"), int) else None
                for usage in usages
            ]
        ),
        history=tuple(history),
    )


async def run_task(
    *,
    task_id: str,
    run_input_digest: str,
    environment: TaskEnvironment,
    agent: AgentProtocol,
    driver: BrowserDriver | MelraBrowserDriver,
    limits: RunLimits,
) -> BrowserTaskRecord:
    if not re.fullmatch(r"[a-f0-9]{64}", run_input_digest):
        raise ValueError("run_input_digest_invalid")
    started = time.perf_counter()
    history: list[dict[str, object]] = []
    latest_reward = 0.0
    try:
        async with asyncio.timeout(limits.task_timeout_seconds):
            for step in range(limits.max_steps):
                decision = await agent.decide(environment.agent_context(history))
                if isinstance(decision, FinalDecision):
                    history.append(
                        {
                            "step": step,
                            "decision": "finish",
                            "model_id": decision.model_id,
                            "usage": asdict(decision.usage),
                        }
                    )
                    return _record(
                        task_id=task_id,
                        run_input_digest=run_input_digest,
                        success=False,
                        reward=latest_reward,
                        failure_category="unverified_finish",
                        started=started,
                        history=history,
                    )
                if isinstance(decision, InfeasibleDecision):
                    history.append(
                        {
                            "step": step,
                            "decision": "infeasible",
                            "model_id": decision.model_id,
                            "usage": asdict(decision.usage),
                        }
                    )
                    return _record(
                        task_id=task_id,
                        run_input_digest=run_input_digest,
                        success=False,
                        reward=latest_reward,
                        failure_category="infeasible",
                        started=started,
                        history=history,
                    )
                try:
                    expected_evidence = environment.evidence_for(decision)
                except ValueError:
                    # The model picked an action the harness cannot verify. That
                    # is the agent failing this task, not the harness breaking,
                    # so record it as such instead of discarding the task.
                    history.append(
                        {
                            "step": step,
                            "decision": "invalid_action",
                            "action": decision.action,
                            "model_id": decision.model_id,
                            "usage": asdict(decision.usage),
                        }
                    )
                    return _record(
                        task_id=task_id,
                        run_input_digest=run_input_digest,
                        success=False,
                        reward=latest_reward,
                        failure_category="invalid_action",
                        started=started,
                        history=history,
                    )
                await environment.prepare_external_action()
                observation = await driver.perform(decision, expected_evidence)
                scored = await environment.observe_after_mcp_action()
                latest_reward = scored.reward
                history.append(
                    {
                        "step": step,
                        "decision": "browser_action",
                        "action": decision.action,
                        "model_id": decision.model_id,
                        "usage": asdict(decision.usage),
                        "mcp_task_id": observation.task_id,
                        "mcp_status": observation.task_status,
                        "mcp_calls": observation.mcp_calls,
                        "reward": scored.reward,
                        "terminated": scored.terminated,
                        "truncated": scored.truncated,
                    }
                )
                if observation.task_status != "verified_success":
                    return _record(
                        task_id=task_id,
                        run_input_digest=run_input_digest,
                        success=False,
                        reward=latest_reward,
                        failure_category=f"mcp_{observation.task_status}",
                        started=started,
                        history=history,
                    )
                if scored.terminated or scored.truncated:
                    success = scored.terminated and scored.reward > 0
                    return _record(
                        task_id=task_id,
                        run_input_digest=run_input_digest,
                        success=success,
                        reward=latest_reward,
                        failure_category=None if success else "official_evaluator_failure",
                        started=started,
                        history=history,
                    )
            return _record(
                task_id=task_id,
                run_input_digest=run_input_digest,
                success=False,
                reward=latest_reward,
                failure_category="step_limit",
                started=started,
                history=history,
            )
    except TimeoutError:
        return _record(
            task_id=task_id,
            run_input_digest=run_input_digest,
            success=False,
            reward=latest_reward,
            failure_category="task_timeout",
            started=started,
            history=history,
        )


def failed_task_record(
    *,
    task_id: str,
    run_input_digest: str,
    error: BaseException,
    started: float,
) -> BrowserTaskRecord:
    """Record for a task the harness itself could not complete.

    The suite reports a fixed denominator, so a task whose environment, driver,
    or agent raises must still produce a record. Aborting the run instead would
    silently shrink the denominator and make the remaining tasks look absent
    rather than failed. The exception type is kept as the failure category so
    these are groupable without exposing a message that may quote page text.
    """
    if not re.fullmatch(r"[a-f0-9]{64}", run_input_digest):
        raise ValueError("run_input_digest_invalid")
    return _record(
        task_id=task_id,
        run_input_digest=run_input_digest,
        success=False,
        reward=0.0,
        failure_category=f"harness_{type(error).__name__}",
        started=started,
        history=[],
    )


def write_task_record(run_directory: Path, record: BrowserTaskRecord) -> Path:
    run_directory.mkdir(parents=True, exist_ok=True)
    safe_task_id = re.sub(r"[^A-Za-z0-9._-]", "_", record.task_id)
    path = run_directory / f"task-{safe_task_id}.json"
    with path.open("x", encoding="utf-8") as output:
        json.dump(asdict(record), output, sort_keys=True, separators=(",", ":"))
        output.write("\n")
    return path


def load_resumable_task_record(path: Path, run_input_digest: str) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError("task_record_object_required")
    if value.get("run_input_digest") != run_input_digest:
        raise ValueError("run_input_digest_mismatch")
    return value


async def run_miniwob_suite(
    *,
    manifest_path: Path,
    run_directory: Path,
    workspace_root: Path,
    base_url: str,
    browser_executable: Path,
    implementation_commit: str,
    agent_base_url: str,
    api_key: str,
    model_id: str,
    limits: RunLimits,
    seed: int = 0,
    task_limit: int | None = None,
    requests_per_minute: int | None = None,
    progress: Callable[[str, BrowserTaskRecord | dict[str, object]], None] | None = None,
) -> tuple[BrowserTaskRecord | dict[str, object], ...]:
    raw_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(raw_manifest, dict):
        raise TypeError("miniwob_manifest_object_required")
    raw_tasks = raw_manifest.get("tasks")
    if not isinstance(raw_tasks, list) or not all(isinstance(task, str) for task in raw_tasks):
        raise TypeError("miniwob_manifest_tasks_invalid")
    tasks = tuple(raw_tasks)
    if len(tasks) != 125 or len(set(tasks)) != 125:
        raise ValueError("miniwob_manifest_task_count_invalid")
    if set(tasks) != set(discover_miniwob_tasks()):
        raise ValueError("miniwob_manifest_upstream_drift")
    if not re.fullmatch(r"[a-f0-9]{40}", implementation_commit):
        raise ValueError("implementation_commit_invalid")
    if model_id in {"latest", "default"}:
        raise ValueError("immutable_model_id_required")
    if task_limit is not None:
        if task_limit < 1:
            raise ValueError("task_limit_must_be_positive")
        tasks = tasks[:task_limit]
    if requests_per_minute is not None and requests_per_minute < 1:
        raise ValueError("requests_per_minute_must_be_positive")
    agent = OpenAICompatibleAgent(
        base_url=agent_base_url,
        api_key=api_key,
        model_id=model_id,
        min_request_interval_seconds=(
            0 if requests_per_minute is None else 60 / requests_per_minute
        ),
    )
    run_input_digest = build_run_input_digest(
        manifest=raw_manifest,
        implementation_commit=implementation_commit,
        model_id=model_id,
        prompt_sha256=agent.prompt_sha256,
        tool_schema_sha256=agent.tool_schema_sha256,
    )
    results: list[BrowserTaskRecord | dict[str, object]] = []
    for task_id in tasks:
        safe_task_id = re.sub(r"[^A-Za-z0-9._-]", "_", task_id)
        record_path = run_directory / f"task-{safe_task_id}.json"
        if record_path.exists():
            resumed = load_resumable_task_record(record_path, run_input_digest)
            results.append(resumed)
            if progress is not None:
                progress(task_id, resumed)
            continue
        task_workspace = workspace_root / safe_task_id
        task_workspace.mkdir(parents=True, exist_ok=True)
        started = time.perf_counter()
        try:
            async with (
                MiniWobEnvironment.open(
                    task_id,
                    base_url=base_url,
                    browser_executable=browser_executable,
                    workspace=task_workspace,
                    seed=seed,
                ) as environment,
                environment.melra_driver() as driver,
            ):
                record = await run_task(
                    task_id=task_id,
                    run_input_digest=run_input_digest,
                    environment=environment,
                    agent=agent,
                    driver=driver,
                    limits=limits,
                )
        except Exception as error:  # noqa: BLE001
            # Deliberately broad: this is the per-task harness boundary. Any
            # environment, driver, or agent failure must become a recorded
            # failure so the denominator stays fixed at the manifest size.
            # BaseException (cancellation, KeyboardInterrupt) still propagates.
            record = failed_task_record(
                task_id=task_id,
                run_input_digest=run_input_digest,
                error=error,
                started=started,
            )
        write_task_record(run_directory, record)
        results.append(record)
        if progress is not None:
            progress(task_id, record)
    return tuple(results)
