# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import json
from pathlib import Path

import pytest

from melra_browser_bench.manifest import (
    AgentIdentity,
    EnvironmentIdentity,
    ImplementationIdentity,
    load_manifest,
)
from melra_browser_bench.sanitize import (
    assert_publishable_run,
    sanitize_evidence,
    verify_public_artifact,
)

PROJECT = Path(__file__).resolve().parents[1]
FIXTURE = PROJECT / "tests" / "fixtures" / "unsafe-evidence.json"
MANIFEST = PROJECT / "manifests" / "webarena-verified-hard-30-v1.json"


def complete_manifest():
    return load_manifest(MANIFEST).freeze_run(
        candidate=ImplementationIdentity(commit="c" * 40),
        agent=AgentIdentity(
            provider="openai-compatible",
            model_id="provider-model-snapshot-2026-07-28",
            model_revision="revision-2026-07-28",
            temperature=0,
            prompt_sha256="a" * 64,
            tool_schema_sha256="b" * 64,
        ),
        environment=EnvironmentIdentity(
            browser="Chrome 150.0.0.0",
            images=("shopping@sha256:" + "d" * 64,),
        ),
        instrumentation_commit="e" * 40,
    )


def test_sanitizer_removes_sensitive_evidence() -> None:
    unsafe = json.loads(FIXTURE.read_text(encoding="utf-8"))
    clean = sanitize_evidence(
        unsafe,
        roots=[Path("/Users/example/project")],
    )
    serialized = json.dumps(clean, sort_keys=True)
    for forbidden in [
        "Bearer secret-token",
        "session_cookie",
        "password=example",
        "/Users/example/project",
        "typed private text",
        "safe=value",
    ]:
        assert forbidden not in serialized
    assert clean["trace"]["sha256"] == "c" * 64
    assert clean["url"] == "https://example.test/form?password=%5BREDACTED%5D&safe=%5BREDACTED%5D"


def test_publication_gate_rejects_raw_har(tmp_path: Path) -> None:
    (tmp_path / "network.har").write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError, match="raw_har_not_publishable"):
        assert_publishable_run(tmp_path, complete_manifest())


def test_public_artifact_rejects_secret_or_local_path(tmp_path: Path) -> None:
    artifact = tmp_path / "public.json"
    artifact.write_text(
        json.dumps(
            {
                "manifest": complete_manifest().to_dict(),
                "records": [{"authorization": "Bearer secret-token"}],
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="public_artifact_sensitive_content"):
        verify_public_artifact(artifact)
