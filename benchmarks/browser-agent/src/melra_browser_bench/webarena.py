# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .manifest import RegisteredTask, load_manifest

ImplementationSide = Literal["baseline", "candidate"]


@dataclass(frozen=True)
class OfficialEvaluation:
    task_id: int
    status: str
    score: float
    version: str
    evaluator_checksum: str
    data_checksum: str
    result: dict[str, object]


@dataclass(frozen=True)
class RegisteredSubsetVerification:
    task_count: int
    unique_templates: int
    task_types: dict[str, int]


@dataclass(frozen=True)
class PairScheduleItem:
    task_id: int
    first: ImplementationSide

    @property
    def order(self) -> tuple[ImplementationSide, ImplementationSide]:
        return (self.first, "candidate") if self.first == "baseline" else (self.first, "baseline")


@dataclass(frozen=True)
class SitePreflight:
    site: str
    ready: bool
    image_digest: str | None
    reason: str | None


@dataclass(frozen=True)
class PreflightResult:
    ready: bool
    sites: tuple[SitePreflight, ...]


@dataclass(frozen=True)
class PairSideExecution:
    implementation: ImplementationSide
    success: bool
    infrastructure_failure: bool


@dataclass(frozen=True)
class PairedTaskExecution:
    task_id: int
    sides: tuple[PairSideExecution, PairSideExecution]

    @property
    def valid(self) -> bool:
        return not any(side.infrastructure_failure for side in self.sides)


class WebArenaEnvironment:
    def __init__(self, api: object) -> None:
        self._api = api

    @classmethod
    def from_config(cls, config_path: Path) -> WebArenaEnvironment:
        try:
            from webarena_verified.api import WebArenaVerified
        except ImportError as error:
            raise RuntimeError("webarena_extra_required: install with --extra webarena") from error
        return cls(WebArenaVerified(config=config_path))

    def evaluate(
        self,
        *,
        task_id: int,
        agent_response: dict[str, object] | str | Path | None,
        network_trace: Path,
    ) -> OfficialEvaluation:
        evaluated = self._api.evaluate_task(
            task_id=task_id,
            agent_response=agent_response,
            network_trace=network_trace,
        )
        raw = evaluated.model_dump(mode="json")
        return OfficialEvaluation(
            task_id=task_id,
            status=str(raw["status"]),
            score=float(raw["score"]),
            version=str(raw["webarena_verified_version"]),
            evaluator_checksum=str(raw["webarena_verified_evaluator_checksum"]),
            data_checksum=str(raw["webarena_verified_data_checksum"]),
            result=raw,
        )

    def _control_client(self, site: str) -> object:
        from webarena_verified.environments.env_ctrl_client.http_client import (
            HttpClient,
        )
        from webarena_verified.types.task import WebArenaSite

        environment = self._api.config.get_environment(WebArenaSite(site))
        if environment is None:
            raise ValueError(f"webarena_environment_missing:{site}")
        control_url = environment.extra.get("env_ctrl_url")
        if not isinstance(control_url, str):
            raise TypeError(f"webarena_env_ctrl_url_missing:{site}")
        return HttpClient(base_url=control_url, timeout=30)

    def preflight(
        self,
        task: RegisteredTask,
        expected_images: dict[str, str],
    ) -> PreflightResult:
        official = self._api.get_task(task.task_id)
        if official.intent_template_id != task.intent_template_id:
            raise ValueError(f"webarena_template_mismatch:{task.task_id}")
        sites: list[SitePreflight] = []
        for site in task.sites:
            expected_digest = expected_images.get(site)
            if expected_digest is None:
                sites.append(
                    SitePreflight(
                        site=site,
                        ready=False,
                        image_digest=None,
                        reason="expected_image_digest_missing",
                    )
                )
                continue
            client = self._control_client(site)
            status = client.status()
            details = status.get("details")
            digest = details.get("image_digest") if isinstance(details, dict) else None
            ready = (
                status.get("success") is True
                and isinstance(details, dict)
                and details.get("status") == "ready"
                and digest == expected_digest
            )
            sites.append(
                SitePreflight(
                    site=site,
                    ready=ready,
                    image_digest=digest if isinstance(digest, str) else None,
                    reason=None if ready else "environment_identity_mismatch",
                )
            )
        return PreflightResult(
            ready=all(site.ready for site in sites),
            sites=tuple(sites),
        )

    def reset(self, task: RegisteredTask) -> None:
        for site in task.sites:
            result = self._control_client(site).init()
            if result.get("success") is not True:
                raise RuntimeError(f"webarena_reset_failed:{site}")


def evaluate_official_task(
    *,
    config_path: Path,
    task_id: int,
    agent_response: dict[str, object] | str | Path | None,
    network_trace: Path,
) -> OfficialEvaluation:
    try:
        from webarena_verified.api import WebArenaVerified
    except ImportError as error:
        raise RuntimeError("webarena_extra_required: install with --extra webarena") from error
    environment = WebArenaEnvironment(WebArenaVerified(config=config_path))
    return environment.evaluate(
        task_id=task_id,
        agent_response=agent_response,
        network_trace=network_trace,
    )


def validate_registered_subset(
    manifest_path: Path,
) -> RegisteredSubsetVerification:
    try:
        from webarena_verified.api import WebArenaVerified
    except ImportError as error:
        raise RuntimeError("webarena_extra_required: install with --extra webarena") from error
    manifest = load_manifest(manifest_path)
    manifest.validate_registered()
    if manifest.upstream.version != "1.2.3":
        raise ValueError("webarena_version_mismatch")
    official = WebArenaVerified()
    task_types: Counter[str] = Counter()
    for registered in manifest.tasks:
        task = official.get_task(registered.task_id)
        sites = tuple(site.value for site in task.sites)
        if sites != registered.sites:
            raise ValueError(f"webarena_sites_mismatch:{registered.task_id}")
        if task.intent_template_id != registered.intent_template_id:
            raise ValueError(f"webarena_template_mismatch:{registered.task_id}")
        evaluation = task.eval[0].model_dump(mode="json")
        expected = evaluation.get("expected")
        task_type = expected.get("task_type") if isinstance(expected, dict) else None
        if task_type not in {"MUTATE", "NAVIGATE", "RETRIEVE"}:
            raise ValueError(f"webarena_task_type_missing:{registered.task_id}")
        if task_type != registered.task_type:
            raise ValueError(f"webarena_task_type_mismatch:{registered.task_id}")
        task_types[task_type] += 1
    return RegisteredSubsetVerification(
        task_count=len(manifest.tasks),
        unique_templates=len({task.intent_template_id for task in manifest.tasks}),
        task_types=dict(sorted(task_types.items())),
    )


def build_pair_schedule(
    task_ids: tuple[int, ...],
    *,
    seed: str,
) -> tuple[PairScheduleItem, ...]:
    if len(task_ids) != len(set(task_ids)):
        raise ValueError("pair_schedule_task_ids_duplicated")
    if len(task_ids) % 2 != 0:
        raise ValueError("pair_schedule_requires_even_task_count")
    if not seed:
        raise ValueError("pair_schedule_seed_required")
    ranked = sorted(task_ids)
    return tuple(
        PairScheduleItem(
            task_id=task_id,
            first="baseline" if index % 2 == 0 else "candidate",
        )
        for index, task_id in enumerate(ranked)
    )


def run_paired_tasks(
    *,
    tasks: tuple[RegisteredTask, ...],
    environment: WebArenaEnvironment,
    expected_images: dict[str, str],
    execute: Callable[
        [int, ImplementationSide],
        PairSideExecution,
    ],
) -> tuple[PairedTaskExecution, ...]:
    task_by_id = {task.task_id: task for task in tasks}
    schedule = build_pair_schedule(
        tuple(task_by_id),
        seed="registered-even-odd-v1",
    )
    pairs: list[PairedTaskExecution] = []
    for scheduled in schedule:
        task = task_by_id[scheduled.task_id]
        sides: list[PairSideExecution] = []
        for side in scheduled.order:
            preflight = environment.preflight(task, expected_images)
            if not preflight.ready:
                sides.append(
                    PairSideExecution(
                        implementation=side,
                        success=False,
                        infrastructure_failure=True,
                    )
                )
                continue
            try:
                environment.reset(task)
            except RuntimeError:
                sides.append(
                    PairSideExecution(
                        implementation=side,
                        success=False,
                        infrastructure_failure=True,
                    )
                )
                continue
            execution = execute(task.task_id, side)
            if execution.implementation != side:
                raise ValueError("paired_execution_side_mismatch")
            sides.append(execution)
        if len(sides) != 2:
            raise RuntimeError("paired_execution_incomplete")
        pairs.append(
            PairedTaskExecution(
                task_id=task.task_id,
                sides=(sides[0], sides[1]),
            )
        )
    return tuple(pairs)
