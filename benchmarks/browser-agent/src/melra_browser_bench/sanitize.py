# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .manifest import BenchmarkManifest, manifest_from_dict

_SENSITIVE_KEYS = re.compile(
    r"(authorization|cookie|set-cookie|password|token|secret|"
    r"form|postdata|typed|request_body|response_body)",
    re.IGNORECASE,
)
_BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_GITHUB_TOKEN = re.compile(r"\bgh[pousr]_[A-Za-z0-9_]+\b")
_ASSIGNED_SECRET = re.compile(r"(?i)\b(password|token|secret|api[_-]?key)=([^&\s]+)")
_PUBLIC_FORBIDDEN = re.compile(
    r"(Bearer\s+[A-Za-z0-9._~+/=-]+|gh[pousr]_[A-Za-z0-9_]+|"
    r"/Users/[^\"\s]+|/home/[^\"\s]+|"
    r"[A-Za-z]:\\\\Users\\\\[^\"\s]+|"
    r"\"(?:authorization|cookie|set-cookie|postData|typed)\"\s*:)",
    re.IGNORECASE,
)
_RAW_SUFFIX_ERRORS = {
    ".har": "raw_har_not_publishable",
    ".png": "raw_binary_evidence_not_publishable",
    ".webm": "raw_binary_evidence_not_publishable",
}


def _strip_query_values(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or not parsed.query:
        return value
    redacted_query = urlencode(
        [(name, "[REDACTED]") for name, _ in parse_qsl(parsed.query, keep_blank_values=True)]
    )
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            redacted_query,
            parsed.fragment,
        )
    )


def _redact_string(value: str, roots: Sequence[Path]) -> str:
    cleaned = _BEARER.sub("Bearer [REDACTED]", value)
    cleaned = _GITHUB_TOKEN.sub("[REDACTED_GITHUB_TOKEN]", cleaned)
    parsed = urlsplit(cleaned)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        cleaned = _strip_query_values(cleaned)
    else:
        cleaned = _ASSIGNED_SECRET.sub(r"\1=[REDACTED]", cleaned)
    for root in roots:
        cleaned = cleaned.replace(str(root), "[LOCAL_PATH]")
    return cleaned


def sanitize_evidence(value: object, roots: Sequence[Path]) -> Any:
    if isinstance(value, dict):
        return {
            str(key): (
                "[REDACTED]" if _SENSITIVE_KEYS.search(str(key)) else sanitize_evidence(item, roots)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize_evidence(item, roots) for item in value]
    if isinstance(value, tuple):
        return [sanitize_evidence(item, roots) for item in value]
    if isinstance(value, str):
        return _redact_string(value, roots)
    return value


def assert_publishable_run(
    run_dir: Path,
    manifest: BenchmarkManifest,
) -> None:
    manifest.validate_publishable()
    for path in run_dir.rglob("*"):
        if not path.is_file():
            continue
        error = _RAW_SUFFIX_ERRORS.get(path.suffix.lower())
        if error is not None:
            raise ValueError(f"{error}:{path.name}")
        if "transcript" in path.name.lower():
            raise ValueError(f"provider_transcript_not_publishable:{path.name}")
        if path.suffix.lower() == ".json":
            serialized = path.read_text(encoding="utf-8")
            if _PUBLIC_FORBIDDEN.search(serialized):
                raise ValueError(f"public_artifact_sensitive_content:{path.name}")


def verify_public_artifact(path: Path) -> dict[str, Any]:
    serialized = path.read_text(encoding="utf-8")
    if _PUBLIC_FORBIDDEN.search(serialized):
        raise ValueError("public_artifact_sensitive_content")
    raw = json.loads(serialized)
    if not isinstance(raw, dict):
        raise TypeError("public_artifact_object_required")
    manifest_raw = raw.get("manifest")
    if not isinstance(manifest_raw, dict):
        raise TypeError("public_artifact_manifest_required")
    manifest = manifest_from_dict(manifest_raw)
    manifest.validate_publishable()
    records = raw.get("records")
    if not isinstance(records, list):
        raise TypeError("public_artifact_records_required")
    if len(records) != len(manifest.tasks) * 2:
        raise ValueError("public_artifact_record_count_mismatch")
    return raw


def publish_run(run_dir: Path, output: Path) -> None:
    manifest = manifest_from_dict(
        json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
    )
    manifest.validate_publishable()
    records_dir = run_dir / "records"
    record_paths = sorted(records_dir.glob("*.json"))
    if len(record_paths) != len(manifest.tasks) * 2:
        raise ValueError("public_artifact_record_count_mismatch")
    roots = (Path.cwd(), Path.home(), run_dir)
    records = [
        sanitize_evidence(
            json.loads(path.read_text(encoding="utf-8")),
            roots,
        )
        for path in record_paths
    ]
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as public:
        json.dump(
            {
                "schema_version": "1.0.0",
                "manifest": manifest.to_dict(),
                "records": records,
            },
            public,
            indent=2,
            sort_keys=True,
        )
        public.write("\n")
    verify_public_artifact(output)
