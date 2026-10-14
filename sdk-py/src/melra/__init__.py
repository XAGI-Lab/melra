# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: Apache-2.0

from importlib.metadata import version

from .client import MelraClient

__all__ = ["MelraClient"]
# Read from the installed distribution, so it cannot drift from pyproject.toml
# the way a literal here did (it said 0.3.0a0 through alpha.11).
__version__ = version("melra")
