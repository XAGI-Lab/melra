# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from melra_browser_bench.agent import AgentContext, BrowserActionDecision
from melra_browser_bench.mcp_driver import DriverObservation
from melra_browser_bench.miniwob import MiniWobStep
from melra_browser_bench.runner import (
    RunLimits,
    build_run_input_digest,
    failed_task_record,
    load_resumable_task_record,
    run_task,
    write_task_record,
)


class _Agent:
    async def decide(self, _context: AgentContext) -> BrowserActionDecision:
        return BrowserActionDecision(
            goal="Click the button",
            action="click",
            target={"role": "button", "name": "Submit"},
        )


class _Driver:
    async def perform(
        self,
        _decision: BrowserActionDecision,
        _expected_evidence: list[dict[str, object]],
    ) -> DriverObservation:
        return DriverObservation(
            task_id="mcp-task",
            plan_status="awaiting_approval",
            task_status="verified_success",
            output={"clicked": True},
            receipt={"taskId": "mcp-task"},
            certificate={"result": "VERIFIED_SUCCESS"},
            mcp_calls=3,
        )


class _Environment:
    def __init__(self) -> None:
        self.prepared = False

    def agent_context(self, _history: list[dict[str, object]]) -> AgentContext:
        return AgentContext(goal="Click the button", observation={"text": "Submit"})

    def evidence_for(self, _decision: BrowserActionDecision) -> list[dict[str, object]]:
        return [{"type": "result_equals", "path": "clicked", "value": True}]

    async def prepare_external_action(self) -> None:
        self.prepared = True

    async def observe_after_mcp_action(self) -> MiniWobStep:
        assert self.prepared
        return MiniWobStep(
            observation={"text": "Done"},
            reward=1,
            terminated=True,
            truncated=False,
            info={},
        )


@pytest.mark.asyncio
async def test_runner_records_a_verified_mcp_scored_step(tmp_path: Path) -> None:
    record = await run_task(
        task_id="browsergym/miniwob.click-test",
        run_input_digest="a" * 64,
        environment=_Environment(),
        agent=_Agent(),
        driver=_Driver(),
        limits=RunLimits(max_steps=3, task_timeout_seconds=30),
    )
    assert record.success is True
    assert record.reward == 1
    assert record.agent_steps == 1
    assert record.mcp_calls == 3
    path = write_task_record(tmp_path, record)
    assert path.name == "task-browsergym_miniwob.click-test.json"
    assert load_resumable_task_record(path, "a" * 64)["success"] is True
    with pytest.raises(FileExistsError):
        write_task_record(tmp_path, record)
    with pytest.raises(ValueError, match="run_input_digest_mismatch"):
        load_resumable_task_record(path, "b" * 64)
    assert json.loads(path.read_text(encoding="utf-8"))["schema_version"] == "1.0.0"


def test_run_input_digest_is_canonical_and_sensitive() -> None:
    first = build_run_input_digest(
        manifest={"suite": "miniwob-125-v1", "tasks": ["a", "b"]},
        implementation_commit="a" * 40,
        model_id="model-snapshot",
        prompt_sha256="b" * 64,
        tool_schema_sha256="c" * 64,
    )
    reordered = build_run_input_digest(
        manifest={"tasks": ["a", "b"], "suite": "miniwob-125-v1"},
        implementation_commit="a" * 40,
        model_id="model-snapshot",
        prompt_sha256="b" * 64,
        tool_schema_sha256="c" * 64,
    )
    changed = build_run_input_digest(
        manifest={"tasks": ["a", "b"], "suite": "miniwob-125-v1"},
        implementation_commit="d" * 40,
        model_id="model-snapshot",
        prompt_sha256="b" * 64,
        tool_schema_sha256="c" * 64,
    )
    assert first == reordered
    assert first != changed


def test_failed_task_record_keeps_the_task_in_the_denominator() -> None:
    record = failed_task_record(
        task_id="browsergym/miniwob.click-test",
        run_input_digest="a" * 64,
        error=TimeoutError("chrome_cdp_endpoint_timeout"),
        started=time.perf_counter(),
    )
    assert record.success is False
    assert record.reward == 0.0
    assert record.failure_category == "harness_TimeoutError"
    assert record.agent_steps == 0
    assert record.mcp_calls == 0
    assert record.history == ()
    # Categories must not carry the exception message: it can quote page text.
    assert "chrome_cdp_endpoint_timeout" not in record.failure_category
    with pytest.raises(ValueError, match="run_input_digest_invalid"):
        failed_task_record(
            task_id="browsergym/miniwob.click-test",
            run_input_digest="not-a-digest",
            error=RuntimeError("x"),
            started=time.perf_counter(),
        )


class _UnverifiableAgent:
    """Chooses an action the harness cannot derive evidence for."""

    async def decide(self, _context: AgentContext) -> BrowserActionDecision:
        return BrowserActionDecision(goal="Pick an option", action="select", target={})


class _RaisingEnvironment(_Environment):
    def evidence_for(self, _decision: BrowserActionDecision) -> list[dict[str, object]]:
        raise ValueError("select_action_requires_verifiable_target")


@pytest.mark.asyncio
async def test_unverifiable_model_action_is_a_task_failure_not_a_crash() -> None:
    """A bad model choice is the agent failing the task, not the harness breaking.

    Letting it propagate discards the task and hides the reason behind a generic
    harness category, so these cannot be grouped as invalid actions.
    """
    record = await run_task(
        task_id="browsergym/miniwob.choose-list",
        run_input_digest="a" * 64,
        environment=_RaisingEnvironment(),
        agent=_UnverifiableAgent(),
        driver=_Driver(),
        limits=RunLimits(max_steps=3, task_timeout_seconds=30),
    )
    assert record.success is False
    assert record.failure_category == "invalid_action"
    assert record.agent_steps == 1
