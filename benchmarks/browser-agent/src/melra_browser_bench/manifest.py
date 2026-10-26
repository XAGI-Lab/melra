# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Literal

TaskType = Literal["MUTATE", "NAVIGATE", "RETRIEVE"]
PublicationState = Literal["registered", "frozen"]

_HEX_40 = re.compile(r"^[a-f0-9]{40}$")
_HEX_64 = re.compile(r"^[a-f0-9]{64}$")
_MUTABLE_MODEL_IDENTIFIERS = {"default", "latest", "mutable"}


def _strict_keys(value: Mapping[str, Any], expected: set[str], name: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        raise ValueError(f"{name}_fields_invalid:missing={missing}:unknown={unknown}")


def _require_string(value: object, name: str) -> str:
    if not isinstance(value, str) or value == "":
        raise ValueError(f"{name}_required")
    return value


def _require_sha256(value: object, name: str) -> str:
    parsed = _require_string(value, name)
    if _HEX_64.fullmatch(parsed) is None:
        raise ValueError(f"{name}_invalid")
    return parsed


def _require_commit(value: object, name: str) -> str:
    parsed = _require_string(value, name)
    if _HEX_40.fullmatch(parsed) is None:
        raise ValueError(f"{name}_invalid")
    return parsed


@dataclass(frozen=True)
class UpstreamIdentity:
    name: str
    version: str
    source_revision: str
    task_data_url: str
    task_data_sha256: str
    subset_manifest_url: str
    subset_manifest_sha256: str


@dataclass(frozen=True)
class SelectionQuota:
    site_family: str
    task_type: TaskType
    count: int


@dataclass(frozen=True)
class SelectionIdentity:
    seed: str
    quotas: tuple[SelectionQuota, ...]


@dataclass(frozen=True)
class ImplementationIdentity:
    commit: str
    source_commit: str | None = None
    instrumentation_commit: str | None = None

    def validate(self, name: str) -> None:
        _require_commit(self.commit, f"{name}_commit")
        if self.source_commit is not None:
            _require_commit(self.source_commit, f"{name}_source_commit")
        if self.instrumentation_commit is not None:
            _require_commit(
                self.instrumentation_commit,
                f"{name}_instrumentation_commit",
            )


@dataclass(frozen=True)
class AgentIdentity:
    provider: str
    model_id: str
    model_revision: str
    temperature: float
    prompt_sha256: str
    tool_schema_sha256: str


@dataclass(frozen=True)
class EnvironmentIdentity:
    browser: str
    images: tuple[str, ...]


@dataclass(frozen=True)
class RegisteredTask:
    task_id: int
    sites: tuple[str, ...]
    site_family: str
    task_type: TaskType
    intent_template_id: int


@dataclass(frozen=True)
class BenchmarkManifest:
    schema_version: Literal["1.0.0"]
    suite: str
    publication_state: PublicationState
    upstream: UpstreamIdentity
    selection: SelectionIdentity
    baseline: ImplementationIdentity
    candidate: ImplementationIdentity | None
    agent: AgentIdentity | None
    environment: EnvironmentIdentity | None
    tasks: tuple[RegisteredTask, ...]

    def freeze_run(
        self,
        *,
        candidate: ImplementationIdentity,
        agent: AgentIdentity,
        environment: EnvironmentIdentity,
        instrumentation_commit: str,
    ) -> BenchmarkManifest:
        if self.publication_state != "registered":
            raise ValueError("manifest_already_frozen")
        _require_commit(instrumentation_commit, "instrumentation_commit")
        return replace(
            self,
            publication_state="frozen",
            baseline=replace(
                self.baseline,
                instrumentation_commit=instrumentation_commit,
            ),
            candidate=candidate,
            agent=agent,
            environment=environment,
        )

    def validate_registered(self) -> None:
        if self.schema_version != "1.0.0":
            raise ValueError("manifest_schema_version_unsupported")
        if not self.tasks:
            raise ValueError("registered_tasks_required")
        ids = [task.task_id for task in self.tasks]
        if ids != sorted(ids) or len(ids) != len(set(ids)):
            raise ValueError("registered_task_ids_invalid")
        templates = [task.intent_template_id for task in self.tasks]
        if len(templates) != len(set(templates)):
            raise ValueError("registered_intent_templates_not_unique")
        self.baseline.validate("baseline")
        _require_commit(self.upstream.source_revision, "upstream_source_revision")
        _require_sha256(self.upstream.task_data_sha256, "task_data_sha256")
        _require_sha256(
            self.upstream.subset_manifest_sha256,
            "subset_manifest_sha256",
        )

    def validate_publishable(self) -> None:
        self.validate_registered()
        if self.publication_state != "frozen":
            raise ValueError("manifest_not_frozen")
        if self.baseline.instrumentation_commit is None:
            raise ValueError("instrumentation_identity_required")
        if self.candidate is None:
            raise ValueError("candidate_identity_required")
        self.candidate.validate("candidate")
        if self.agent is None:
            raise ValueError("agent_identity_required")
        if (
            self.agent.model_id.lower() in _MUTABLE_MODEL_IDENTIFIERS
            or self.agent.model_revision.lower() in _MUTABLE_MODEL_IDENTIFIERS
        ):
            raise ValueError("immutable_model_id_required")
        _require_sha256(self.agent.prompt_sha256, "prompt_sha256")
        _require_sha256(self.agent.tool_schema_sha256, "tool_schema_sha256")
        if self.environment is None or not self.environment.images:
            raise ValueError("immutable_environment_required")
        if any(
            re.fullmatch(r"[^@\s]+@sha256:[a-f0-9]{64}", image) is None
            for image in self.environment.images
        ):
            raise ValueError("immutable_environment_required")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _parse_upstream(raw: object) -> UpstreamIdentity:
    if not isinstance(raw, dict):
        raise TypeError("upstream_required")
    expected = {
        "name",
        "version",
        "source_revision",
        "task_data_url",
        "task_data_sha256",
        "subset_manifest_url",
        "subset_manifest_sha256",
    }
    _strict_keys(raw, expected, "upstream")
    return UpstreamIdentity(
        name=_require_string(raw["name"], "upstream_name"),
        version=_require_string(raw["version"], "upstream_version"),
        source_revision=_require_commit(
            raw["source_revision"],
            "upstream_source_revision",
        ),
        task_data_url=_require_string(raw["task_data_url"], "task_data_url"),
        task_data_sha256=_require_sha256(
            raw["task_data_sha256"],
            "task_data_sha256",
        ),
        subset_manifest_url=_require_string(
            raw["subset_manifest_url"],
            "subset_manifest_url",
        ),
        subset_manifest_sha256=_require_sha256(
            raw["subset_manifest_sha256"],
            "subset_manifest_sha256",
        ),
    )


def _parse_quota(raw: object) -> SelectionQuota:
    if not isinstance(raw, dict):
        raise TypeError("selection_quota_required")
    _strict_keys(raw, {"site_family", "task_type", "count"}, "selection_quota")
    task_type = raw["task_type"]
    if task_type not in {"MUTATE", "NAVIGATE", "RETRIEVE"}:
        raise ValueError("selection_task_type_invalid")
    count = raw["count"]
    if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
        raise ValueError("selection_quota_count_invalid")
    return SelectionQuota(
        site_family=_require_string(raw["site_family"], "site_family"),
        task_type=task_type,
        count=count,
    )


def _parse_selection(raw: object) -> SelectionIdentity:
    if not isinstance(raw, dict):
        raise TypeError("selection_required")
    _strict_keys(raw, {"seed", "quotas"}, "selection")
    quotas = raw["quotas"]
    if not isinstance(quotas, list) or not quotas:
        raise ValueError("selection_quotas_required")
    return SelectionIdentity(
        seed=_require_string(raw["seed"], "selection_seed"),
        quotas=tuple(_parse_quota(quota) for quota in quotas),
    )


def _parse_implementation(raw: object, name: str) -> ImplementationIdentity:
    if not isinstance(raw, dict):
        raise TypeError(f"{name}_identity_required")
    _strict_keys(
        raw,
        {"commit", "source_commit", "instrumentation_commit"},
        name,
    )
    identity = ImplementationIdentity(
        commit=_require_commit(raw["commit"], f"{name}_commit"),
        source_commit=(
            None
            if raw["source_commit"] is None
            else _require_commit(raw["source_commit"], f"{name}_source_commit")
        ),
        instrumentation_commit=(
            None
            if raw["instrumentation_commit"] is None
            else _require_commit(
                raw["instrumentation_commit"],
                f"{name}_instrumentation_commit",
            )
        ),
    )
    identity.validate(name)
    return identity


def parse_agent_identity(raw: object) -> AgentIdentity:
    if not isinstance(raw, dict):
        raise TypeError("agent_identity_required")
    expected = {
        "provider",
        "model_id",
        "model_revision",
        "temperature",
        "prompt_sha256",
        "tool_schema_sha256",
    }
    _strict_keys(raw, expected, "agent")
    temperature = raw["temperature"]
    if not isinstance(temperature, (int, float)) or isinstance(temperature, bool):
        raise TypeError("agent_temperature_invalid")
    return AgentIdentity(
        provider=_require_string(raw["provider"], "agent_provider"),
        model_id=_require_string(raw["model_id"], "agent_model_id"),
        model_revision=_require_string(raw["model_revision"], "agent_model_revision"),
        temperature=float(temperature),
        prompt_sha256=_require_sha256(raw["prompt_sha256"], "prompt_sha256"),
        tool_schema_sha256=_require_sha256(
            raw["tool_schema_sha256"],
            "tool_schema_sha256",
        ),
    )


def parse_environment_identity(raw: object) -> EnvironmentIdentity:
    if not isinstance(raw, dict):
        raise TypeError("environment_identity_required")
    _strict_keys(raw, {"browser", "images"}, "environment")
    images = raw["images"]
    if not isinstance(images, list) or not all(isinstance(image, str) for image in images):
        raise ValueError("environment_images_invalid")
    return EnvironmentIdentity(
        browser=_require_string(raw["browser"], "environment_browser"),
        images=tuple(images),
    )


def _parse_task(raw: object) -> RegisteredTask:
    if not isinstance(raw, dict):
        raise TypeError("registered_task_required")
    expected = {
        "task_id",
        "sites",
        "site_family",
        "task_type",
        "intent_template_id",
    }
    _strict_keys(raw, expected, "registered_task")
    task_id = raw["task_id"]
    template_id = raw["intent_template_id"]
    sites = raw["sites"]
    task_type = raw["task_type"]
    if not isinstance(task_id, int) or isinstance(task_id, bool) or task_id < 0:
        raise ValueError("registered_task_id_invalid")
    if not isinstance(template_id, int) or isinstance(template_id, bool) or template_id < 0:
        raise ValueError("intent_template_id_invalid")
    if not isinstance(sites, list) or not sites or not all(isinstance(site, str) for site in sites):
        raise ValueError("registered_task_sites_invalid")
    if task_type not in {"MUTATE", "NAVIGATE", "RETRIEVE"}:
        raise ValueError("registered_task_type_invalid")
    return RegisteredTask(
        task_id=task_id,
        sites=tuple(sites),
        site_family=_require_string(raw["site_family"], "site_family"),
        task_type=task_type,
        intent_template_id=template_id,
    )


def manifest_from_dict(raw: Mapping[str, Any]) -> BenchmarkManifest:
    expected = {
        "schema_version",
        "suite",
        "publication_state",
        "upstream",
        "selection",
        "baseline",
        "candidate",
        "agent",
        "environment",
        "tasks",
    }
    _strict_keys(raw, expected, "manifest")
    state = raw["publication_state"]
    if state not in {"registered", "frozen"}:
        raise ValueError("publication_state_invalid")
    tasks = raw["tasks"]
    if not isinstance(tasks, list):
        raise TypeError("registered_tasks_required")
    manifest = BenchmarkManifest(
        schema_version=raw["schema_version"],
        suite=_require_string(raw["suite"], "suite"),
        publication_state=state,
        upstream=_parse_upstream(raw["upstream"]),
        selection=_parse_selection(raw["selection"]),
        baseline=_parse_implementation(raw["baseline"], "baseline"),
        candidate=(
            None
            if raw["candidate"] is None
            else _parse_implementation(raw["candidate"], "candidate")
        ),
        agent=None if raw["agent"] is None else parse_agent_identity(raw["agent"]),
        environment=(
            None if raw["environment"] is None else parse_environment_identity(raw["environment"])
        ),
        tasks=tuple(_parse_task(task) for task in tasks),
    )
    manifest.validate_registered()
    return manifest


def load_manifest(path: Path) -> BenchmarkManifest:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise TypeError("manifest_object_required")
    return manifest_from_dict(raw)


def write_manifest(path: Path, manifest: BenchmarkManifest) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as output:
        json.dump(manifest.to_dict(), output, indent=2, sort_keys=True)
        output.write("\n")
