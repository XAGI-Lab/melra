# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: Apache-2.0

import tomllib
from pathlib import Path

import melra


def test_version_matches_pyproject() -> None:
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    expected = tomllib.loads(pyproject.read_text())["project"]["version"]
    assert melra.__version__ == expected
