# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import httpx

from .manifest import BenchmarkManifest, RegisteredTask, TaskType

QuotaKey = tuple[str, TaskType]


def selection_key(seed: str, task_id: int) -> str:
    return hashlib.sha256(f"{seed}:{task_id}".encode()).hexdigest()


def _site_family(sites: Sequence[str]) -> str:
    if len(sites) != 1:
        return "cross-site"
    site = sites[0]
    if site in {"gitlab", "reddit", "shopping", "shopping_admin"}:
        return site
    return "cross-site"


def _task_type(raw: Mapping[str, Any]) -> TaskType:
    evaluations = raw.get("eval")
    if not isinstance(evaluations, list):
        raise TypeError("selection_task_eval_required")
    for evaluation in evaluations:
        if not isinstance(evaluation, dict):
            continue
        if evaluation.get("evaluator") != "AgentResponseEvaluator":
            continue
        expected = evaluation.get("expected")
        if not isinstance(expected, dict):
            break
        task_type = expected.get("task_type")
        if task_type in {"MUTATE", "NAVIGATE", "RETRIEVE"}:
            return task_type
    raise ValueError("selection_task_type_missing")


def _parse_task(raw: Mapping[str, Any]) -> RegisteredTask:
    task_id = raw.get("task_id")
    intent_template_id = raw.get("intent_template_id")
    sites = raw.get("sites")
    if not isinstance(task_id, int) or isinstance(task_id, bool):
        raise TypeError("selection_task_id_required")
    if not isinstance(intent_template_id, int) or isinstance(intent_template_id, bool):
        raise TypeError("selection_intent_template_id_required")
    if not isinstance(sites, list) or not sites or not all(isinstance(site, str) for site in sites):
        raise TypeError("selection_sites_required")
    return RegisteredTask(
        task_id=task_id,
        sites=tuple(sites),
        site_family=_site_family(sites),
        task_type=_task_type(raw),
        intent_template_id=intent_template_id,
    )


def select_registered_tasks(
    raw_tasks: Sequence[Mapping[str, Any]],
    *,
    seed: str,
    quotas: Mapping[QuotaKey, int],
) -> tuple[RegisteredTask, ...]:
    parsed = tuple(_parse_task(task) for task in raw_tasks)
    used_templates: set[int] = set()
    selected: list[RegisteredTask] = []
    for stratum, required in quotas.items():
        if required <= 0:
            raise ValueError(f"selection_quota_invalid:{stratum}")
        candidates = sorted(
            (task for task in parsed if (task.site_family, task.task_type) == stratum),
            key=lambda task: selection_key(seed, task.task_id),
        )
        accepted: list[RegisteredTask] = []
        for task in candidates:
            if task.intent_template_id in used_templates:
                continue
            accepted.append(task)
            used_templates.add(task.intent_template_id)
            if len(accepted) == required:
                break
        if len(accepted) != required:
            raise ValueError(f"selection_quota_unsatisfied:{stratum}")
        selected.extend(accepted)
    return tuple(sorted(selected, key=lambda task: task.task_id))


@dataclass(frozen=True)
class VerificationResult:
    suite: str
    tasks: int
    unique_templates: int
    task_data_sha256: str
    subset_manifest_sha256: str


def _read_source(source: str | Path) -> bytes:
    if isinstance(source, Path):
        return source.read_bytes()
    if source.startswith(("https://", "http://")):
        response = httpx.get(source, follow_redirects=True, timeout=30)
        response.raise_for_status()
        return response.content
    return Path(source).read_bytes()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verify_upstream(
    manifest: BenchmarkManifest,
    *,
    task_data_source: str | Path | None = None,
    subset_manifest_source: str | Path | None = None,
) -> VerificationResult:
    task_data = _read_source(task_data_source or manifest.upstream.task_data_url)
    subset_data = _read_source(subset_manifest_source or manifest.upstream.subset_manifest_url)
    task_hash = _sha256(task_data)
    subset_hash = _sha256(subset_data)
    if task_hash != manifest.upstream.task_data_sha256:
        raise ValueError("upstream_task_data_hash_mismatch")
    if subset_hash != manifest.upstream.subset_manifest_sha256:
        raise ValueError("upstream_subset_manifest_hash_mismatch")

    raw_tasks = json.loads(task_data)
    raw_subset = json.loads(subset_data)
    if not isinstance(raw_tasks, list) or not all(isinstance(task, dict) for task in raw_tasks):
        raise TypeError("upstream_task_data_invalid")
    if not isinstance(raw_subset, dict) or not isinstance(raw_subset.get("task_ids"), list):
        raise TypeError("upstream_subset_manifest_invalid")
    hard_ids = raw_subset["task_ids"]
    if not all(isinstance(task_id, int) for task_id in hard_ids):
        raise TypeError("upstream_subset_task_ids_invalid")

    quotas: dict[QuotaKey, int] = {
        (quota.site_family, quota.task_type): quota.count for quota in manifest.selection.quotas
    }
    regenerated = select_registered_tasks(
        raw_tasks,
        seed=manifest.selection.seed,
        quotas=quotas,
    )
    if [asdict(task) for task in regenerated] != [asdict(task) for task in manifest.tasks]:
        raise ValueError("registered_selection_drift")
    if any(task.task_id not in hard_ids for task in regenerated):
        raise ValueError("registered_task_not_in_hard_subset")
    return VerificationResult(
        suite=manifest.suite,
        tasks=len(regenerated),
        unique_templates=len({task.intent_template_id for task in regenerated}),
        task_data_sha256=task_hash,
        subset_manifest_sha256=subset_hash,
    )
