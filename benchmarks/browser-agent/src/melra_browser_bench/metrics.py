# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

TaskType = Literal["MUTATE", "NAVIGATE", "RETRIEVE"]


@dataclass(frozen=True)
class TaskSideRecord:
    implementation: Literal["baseline", "candidate"]
    success: bool
    duration_ms: float
    agent_steps: int
    mcp_calls: int
    input_tokens: int | None
    cached_input_tokens: int | None
    reasoning_tokens: int | None
    output_tokens: int | None
    failure_category: str | None
    infrastructure_failure: bool


@dataclass(frozen=True)
class TaskPairRecord:
    task_id: int
    task_type: TaskType
    site_family: str
    baseline: TaskSideRecord
    candidate: TaskSideRecord


@dataclass(frozen=True)
class PercentileSummary:
    p50: float
    p95: float


@dataclass(frozen=True)
class TokenTotals:
    input_tokens: int | None
    cached_input_tokens: int | None
    reasoning_tokens: int | None
    output_tokens: int | None


@dataclass(frozen=True)
class PairReport:
    fixed_denominator: int
    baseline_successes: int
    candidate_successes: int
    baseline_success_rate: float
    candidate_success_rate: float
    baseline_wilson_95: tuple[float, float]
    candidate_wilson_95: tuple[float, float]
    candidate_only: int
    baseline_only: int
    both_success: int
    both_failure: int
    mcnemar_exact_p: float
    baseline_duration_ms: PercentileSummary
    candidate_duration_ms: PercentileSummary
    baseline_tokens: TokenTotals
    candidate_tokens: TokenTotals


def percentile(values: Sequence[float], q: float) -> float:
    if not values:
        raise ValueError("percentile_values_required")
    if not 0 <= q <= 1:
        raise ValueError("percentile_quantile_invalid")
    ordered = sorted(values)
    rank = max(1, math.ceil(q * len(ordered)))
    return ordered[rank - 1]


def wilson_interval(successes: int, total: int) -> tuple[float, float]:
    if total <= 0 or not 0 <= successes <= total:
        raise ValueError("invalid_binomial_counts")
    z = 1.959963984540054
    proportion = successes / total
    denominator = 1 + z * z / total
    center = (proportion + z * z / (2 * total)) / denominator
    margin = (
        z * math.sqrt((proportion * (1 - proportion) + z * z / (4 * total)) / total) / denominator
    )
    return round(center - margin, 6), round(center + margin, 6)


def mcnemar_exact(baseline_only: int, candidate_only: int) -> float:
    if baseline_only < 0 or candidate_only < 0:
        raise ValueError("mcnemar_counts_invalid")
    discordant = baseline_only + candidate_only
    if discordant == 0:
        return 1.0
    tail = sum(
        math.comb(discordant, index) * (0.5**discordant)
        for index in range(min(baseline_only, candidate_only) + 1)
    )
    return min(1.0, 2 * tail)


def _tokens(records: Sequence[TaskSideRecord]) -> TokenTotals:
    def total(field: str) -> int | None:
        values = [getattr(record, field) for record in records]
        if any(value is None for value in values):
            return None
        return sum(value for value in values if isinstance(value, int))

    return TokenTotals(
        input_tokens=total("input_tokens"),
        cached_input_tokens=total("cached_input_tokens"),
        reasoning_tokens=total("reasoning_tokens"),
        output_tokens=total("output_tokens"),
    )


def aggregate_pair(
    records: Sequence[TaskPairRecord],
    *,
    registered_total: int,
) -> PairReport:
    if len(records) != registered_total:
        raise ValueError("registered_task_count_mismatch")
    task_ids = [record.task_id for record in records]
    if len(task_ids) != len(set(task_ids)):
        raise ValueError("registered_task_ids_duplicated")
    if any(
        record.baseline.infrastructure_failure or record.candidate.infrastructure_failure
        for record in records
    ):
        raise ValueError("infrastructure_invalid_pair")

    baseline = [record.baseline for record in records]
    candidate = [record.candidate for record in records]
    baseline_successes = sum(record.success for record in baseline)
    candidate_successes = sum(record.success for record in candidate)
    candidate_only = sum(
        not record.baseline.success and record.candidate.success for record in records
    )
    baseline_only = sum(
        record.baseline.success and not record.candidate.success for record in records
    )
    both_success = sum(record.baseline.success and record.candidate.success for record in records)
    both_failure = sum(
        not record.baseline.success and not record.candidate.success for record in records
    )
    return PairReport(
        fixed_denominator=registered_total,
        baseline_successes=baseline_successes,
        candidate_successes=candidate_successes,
        baseline_success_rate=baseline_successes / registered_total,
        candidate_success_rate=candidate_successes / registered_total,
        baseline_wilson_95=wilson_interval(baseline_successes, registered_total),
        candidate_wilson_95=wilson_interval(candidate_successes, registered_total),
        candidate_only=candidate_only,
        baseline_only=baseline_only,
        both_success=both_success,
        both_failure=both_failure,
        mcnemar_exact_p=mcnemar_exact(baseline_only, candidate_only),
        baseline_duration_ms=PercentileSummary(
            p50=percentile([record.duration_ms for record in baseline], 0.5),
            p95=percentile([record.duration_ms for record in baseline], 0.95),
        ),
        candidate_duration_ms=PercentileSummary(
            p50=percentile([record.duration_ms for record in candidate], 0.5),
            p95=percentile([record.duration_ms for record in candidate], 0.95),
        ),
        baseline_tokens=_tokens(baseline),
        candidate_tokens=_tokens(candidate),
    )
