# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import json
from pathlib import Path

import pytest

from melra_browser_bench.selection import select_registered_tasks

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "hard-selection-sample.json"


def test_selection_hashes_within_strata_and_skips_duplicate_templates() -> None:
    tasks = json.loads(FIXTURE.read_text(encoding="utf-8"))
    selected = select_registered_tasks(
        tasks,
        seed="fixed-seed",
        quotas={
            ("reddit", "RETRIEVE"): 1,
            ("gitlab", "MUTATE"): 2,
        },
    )
    assert [task.task_id for task in selected] == [7, 11, 19]
    assert [task.intent_template_id for task in selected] == [101, 103, 201]


def test_selection_fails_when_a_quota_cannot_be_filled() -> None:
    with pytest.raises(ValueError, match="selection_quota_unsatisfied"):
        select_registered_tasks(
            [],
            seed="fixed-seed",
            quotas={("gitlab", "MUTATE"): 1},
        )
