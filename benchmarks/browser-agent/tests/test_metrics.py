# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import pytest

from melra_browser_bench.metrics import (
    TaskPairRecord,
    TaskSideRecord,
    aggregate_pair,
    mcnemar_exact,
    percentile,
    wilson_interval,
)


def side(implementation: str, success: bool, duration_ms: float) -> TaskSideRecord:
    return TaskSideRecord(
        implementation=implementation,
        success=success,
        duration_ms=duration_ms,
        agent_steps=2,
        mcp_calls=6,
        input_tokens=120,
        cached_input_tokens=20,
        reasoning_tokens=None,
        output_tokens=18,
        failure_category=None if success else "verification",
        infrastructure_failure=False,
    )


def pair(task_id: int, *, baseline: bool, candidate: bool) -> TaskPairRecord:
    return TaskPairRecord(
        task_id=task_id,
        task_type="MUTATE",
        site_family="gitlab",
        baseline=side("baseline", baseline, 100 + task_id),
        candidate=side("candidate", candidate, 90 + task_id),
    )


def test_wilson_interval_for_15_of_30() -> None:
    low, high = wilson_interval(15, 30)
    assert low == pytest.approx(0.3315, abs=0.0001)
    assert high == pytest.approx(0.6685, abs=0.0001)


def test_percentile_uses_a_bounded_nearest_rank() -> None:
    assert percentile([10, 20, 30, 40], 0.5) == 20
    assert percentile([10, 20, 30, 40], 0.95) == 40
    with pytest.raises(ValueError, match="percentile_values_required"):
        percentile([], 0.5)


def test_mcnemar_exact_is_symmetric_and_bounded() -> None:
    assert mcnemar_exact(1, 5) == pytest.approx(mcnemar_exact(5, 1))
    assert mcnemar_exact(0, 0) == 1
    assert 0 <= mcnemar_exact(1, 5) <= 1


def test_pair_report_counts_wins_losses_ties_and_failures() -> None:
    report = aggregate_pair(
        [
            pair(15, baseline=False, candidate=True),
            pair(21, baseline=True, candidate=False),
            pair(67, baseline=True, candidate=True),
            pair(105, baseline=False, candidate=False),
        ],
        registered_total=4,
    )
    assert report.candidate_successes == 2
    assert report.baseline_successes == 2
    assert report.candidate_only == 1
    assert report.baseline_only == 1
    assert report.both_success == 1
    assert report.both_failure == 1
    assert report.fixed_denominator == 4
    assert report.candidate_success_rate == 0.5
    assert report.baseline_success_rate == 0.5
    assert report.candidate_duration_ms.p50 == 111
    assert report.candidate_duration_ms.p95 == 195


def test_pair_report_rejects_missing_or_infrastructure_invalid_records() -> None:
    records = [pair(15, baseline=True, candidate=True)]
    with pytest.raises(ValueError, match="registered_task_count_mismatch"):
        aggregate_pair(records, registered_total=2)

    invalid = pair(15, baseline=True, candidate=True)
    invalid = TaskPairRecord(
        task_id=invalid.task_id,
        task_type=invalid.task_type,
        site_family=invalid.site_family,
        baseline=TaskSideRecord(
            **{
                **invalid.baseline.__dict__,
                "infrastructure_failure": True,
            }
        ),
        candidate=invalid.candidate,
    )
    with pytest.raises(ValueError, match="infrastructure_invalid_pair"):
        aggregate_pair([invalid], registered_total=1)
