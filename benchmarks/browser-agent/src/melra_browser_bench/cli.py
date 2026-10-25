# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
from collections.abc import Sequence
from pathlib import Path

from .manifest import (
    ImplementationIdentity,
    load_manifest,
    parse_agent_identity,
    parse_environment_identity,
    write_manifest,
)
from .runner import BrowserTaskRecord, RunLimits, run_miniwob_suite
from .sanitize import publish_run, verify_public_artifact
from .selection import verify_upstream
from .webarena import (
    PairSideExecution,
    WebArenaEnvironment,
    run_paired_tasks,
    validate_registered_subset,
)

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_REGISTERED_HARD30 = _PROJECT_ROOT / "manifests" / "webarena-verified-hard-30-v1.json"
_REGISTERED_MINIWOB = _PROJECT_ROOT / "manifests" / "miniwob-125-v1.json"


def _json_object(path: Path) -> dict[str, object]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise TypeError(f"json_object_required:{path}")
    return raw


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="melra-browser-bench")
    commands = parser.add_subparsers(dest="command", required=True)

    validate = commands.add_parser("validate-manifest")
    validate.add_argument("manifest", type=Path)

    verify = commands.add_parser("verify-upstream")
    verify.add_argument("--manifest", type=Path, default=_REGISTERED_HARD30)
    verify.add_argument("--task-data", type=Path)
    verify.add_argument("--subset-manifest", type=Path)

    verify_public = commands.add_parser("verify-public")
    verify_public.add_argument("artifact", type=Path)

    publish = commands.add_parser("publish")
    publish.add_argument("--run-dir", type=Path, required=True)
    publish.add_argument("--output", type=Path, required=True)

    miniwob = commands.add_parser("run-miniwob")
    miniwob.add_argument("--manifest", type=Path, default=_REGISTERED_MINIWOB)
    miniwob.add_argument("--run-dir", type=Path, required=True)
    miniwob.add_argument("--workspace", type=Path, required=True)
    miniwob.add_argument("--base-url", required=True)
    miniwob.add_argument("--browser-executable", type=Path, required=True)
    miniwob.add_argument("--implementation-commit", required=True)
    miniwob.add_argument("--agent-config", type=Path, required=True)
    miniwob.add_argument("--max-steps", type=int, default=15)
    miniwob.add_argument("--task-timeout-seconds", type=float, default=180)
    miniwob.add_argument("--seed", type=int, default=0)
    miniwob.add_argument("--task-limit", type=int)
    miniwob.add_argument("--requests-per-minute", type=int)

    preflight_hard30 = commands.add_parser("preflight-hard30")
    preflight_hard30.add_argument("--manifest", type=Path, default=_REGISTERED_HARD30)
    preflight_hard30.add_argument("--config", type=Path, required=True)
    preflight_hard30.add_argument("--image-config", type=Path, required=True)

    hard30 = commands.add_parser("run-hard30")
    hard30.add_argument("--manifest", type=Path, default=_REGISTERED_HARD30)
    hard30.add_argument("--config", type=Path, required=True)
    hard30.add_argument("--image-config", type=Path, required=True)
    hard30.add_argument("--run-dir", type=Path, required=True)
    hard30.add_argument("--baseline-runner", type=Path, required=True)
    hard30.add_argument("--candidate-runner", type=Path, required=True)

    freeze = commands.add_parser("freeze-run")
    freeze.add_argument("--registered", type=Path, required=True)
    freeze.add_argument("--baseline-source", required=True)
    freeze.add_argument("--instrumentation", required=True)
    freeze.add_argument("--candidate", required=True)
    freeze.add_argument("--agent-config", type=Path, required=True)
    freeze.add_argument("--environment-config", type=Path, required=True)
    freeze.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "validate-manifest":
        manifest = load_manifest(args.manifest)
        publishable = True
        try:
            manifest.validate_publishable()
        except ValueError:
            publishable = False
        print(
            json.dumps(
                {
                    "suite": manifest.suite,
                    "state": manifest.publication_state,
                    "tasks": len(manifest.tasks),
                    "publishable": publishable,
                },
                sort_keys=True,
            )
        )
        return 0

    if args.command == "verify-upstream":
        result = verify_upstream(
            load_manifest(args.manifest),
            task_data_source=args.task_data,
            subset_manifest_source=args.subset_manifest,
        )
        print(
            "verified "
            f"suite={result.suite} "
            f"tasks={result.tasks} "
            f"unique_templates={result.unique_templates}"
        )
        return 0

    if args.command == "verify-public":
        artifact = verify_public_artifact(args.artifact)
        print(
            json.dumps(
                {
                    "artifact": str(args.artifact),
                    "records": len(artifact["records"]),
                    "publishable": True,
                },
                sort_keys=True,
            )
        )
        return 0

    if args.command == "publish":
        publish_run(args.run_dir, args.output)
        print(
            json.dumps(
                {
                    "output": str(args.output),
                    "publishable": True,
                },
                sort_keys=True,
            )
        )
        return 0

    if args.command == "run-miniwob":
        agent_config = _json_object(args.agent_config)
        required = {"base_url", "api_key_env", "model_id"}
        if set(agent_config) != required:
            raise ValueError("agent_config_fields_invalid")
        if not all(isinstance(agent_config[field], str) for field in required):
            raise TypeError("agent_config_values_invalid")
        api_key_environment = str(agent_config["api_key_env"])
        api_key = os.environ.get(api_key_environment)
        if api_key is None:
            raise RuntimeError(f"agent_api_key_environment_missing:{api_key_environment}")

        def progress(task_id: str, record: BrowserTaskRecord | dict[str, object]) -> None:
            success = (
                record.success
                if isinstance(record, BrowserTaskRecord)
                else bool(record.get("success"))
            )
            print(
                json.dumps(
                    {"task": task_id, "success": success},
                    sort_keys=True,
                ),
                flush=True,
            )

        records = asyncio.run(
            run_miniwob_suite(
                manifest_path=args.manifest,
                run_directory=args.run_dir,
                workspace_root=args.workspace,
                base_url=args.base_url,
                browser_executable=args.browser_executable,
                implementation_commit=args.implementation_commit,
                agent_base_url=str(agent_config["base_url"]),
                api_key=api_key,
                model_id=str(agent_config["model_id"]),
                limits=RunLimits(
                    max_steps=args.max_steps,
                    task_timeout_seconds=args.task_timeout_seconds,
                ),
                seed=args.seed,
                task_limit=args.task_limit,
                requests_per_minute=args.requests_per_minute,
                progress=progress,
            )
        )
        successes = sum(
            record.success if isinstance(record, BrowserTaskRecord) else bool(record.get("success"))
            for record in records
        )
        def category(record: BrowserTaskRecord | dict[str, object]) -> str:
            value = (
                record.failure_category
                if isinstance(record, BrowserTaskRecord)
                else record.get("failure_category")
            )
            return value if isinstance(value, str) else ""

        # A task the harness could not attempt is not evidence about the agent.
        # Surface the count so a run that needs repeating is obvious.
        infrastructure_failures = sum(
            1 for record in records if category(record).startswith("harness_")
        )
        print(
            json.dumps(
                {
                    "suite": "miniwob-125-v1",
                    "tasks": len(records),
                    "successes": successes,
                    "infrastructure_failures": infrastructure_failures,
                    "complete": len(records) == 125,
                    "valid": len(records) == 125 and infrastructure_failures == 0,
                },
                sort_keys=True,
            )
        )
        return 0

    if args.command in {"preflight-hard30", "run-hard30"}:
        verified = validate_registered_subset(args.manifest)
        registered = load_manifest(args.manifest)
        image_config = _json_object(args.image_config)
        if not image_config or not all(
            isinstance(site, str)
            and isinstance(digest, str)
            and re.fullmatch(r"sha256:[a-f0-9]{64}", digest)
            for site, digest in image_config.items()
        ):
            raise ValueError("image_config_invalid")
        expected_images = {site: str(digest) for site, digest in image_config.items()}
        environment = WebArenaEnvironment.from_config(args.config)
        preflights = [environment.preflight(task, expected_images) for task in registered.tasks]
        ready = all(preflight.ready for preflight in preflights)
        if args.command == "preflight-hard30":
            print(
                json.dumps(
                    {
                        "suite": registered.suite,
                        "tasks": verified.task_count,
                        "ready": ready,
                    },
                    sort_keys=True,
                )
            )
            return 0 if ready else 1
        if not ready:
            raise RuntimeError("hard30_preflight_failed")
        runners = {
            "baseline": args.baseline_runner.resolve(),
            "candidate": args.candidate_runner.resolve(),
        }
        if any(not runner.is_file() for runner in runners.values()):
            raise FileNotFoundError("hard30_runner_not_found")

        def execute(task_id: int, side: str) -> PairSideExecution:
            side_directory = args.run_dir / str(task_id) / side
            side_directory.mkdir(parents=True, exist_ok=False)
            completed = subprocess.run(
                [
                    str(runners[side]),
                    "--task-id",
                    str(task_id),
                    "--config",
                    str(args.config.resolve()),
                    "--output-dir",
                    str(side_directory.resolve()),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            if completed.returncode != 0:
                return PairSideExecution(
                    implementation=side,
                    success=False,
                    infrastructure_failure=True,
                )
            try:
                result = json.loads(completed.stdout.strip().splitlines()[-1])
            except (IndexError, json.JSONDecodeError):
                return PairSideExecution(
                    implementation=side,
                    success=False,
                    infrastructure_failure=True,
                )
            valid_official_result = (
                isinstance(result, dict)
                and result.get("infrastructure_failure") is False
                and result.get("official_status") in {"success", "failure", "partial_match"}
                and isinstance(result.get("official_score"), (int, float))
                and re.fullmatch(
                    r"[a-f0-9]{64}",
                    str(result.get("evaluator_checksum", "")),
                )
                and re.fullmatch(
                    r"[a-f0-9]{64}",
                    str(result.get("data_checksum", "")),
                )
            )
            if not valid_official_result:
                return PairSideExecution(
                    implementation=side,
                    success=False,
                    infrastructure_failure=True,
                )
            return PairSideExecution(
                implementation=side,
                success=float(result["official_score"]) == 1,
                infrastructure_failure=False,
            )

        pairs = run_paired_tasks(
            tasks=registered.tasks,
            environment=environment,
            expected_images=expected_images,
            execute=execute,
        )
        print(
            json.dumps(
                {
                    "suite": registered.suite,
                    "pairs": len(pairs),
                    "valid_pairs": sum(pair.valid for pair in pairs),
                    "baseline_successes": sum(
                        side.success
                        for pair in pairs
                        for side in pair.sides
                        if side.implementation == "baseline"
                    ),
                    "candidate_successes": sum(
                        side.success
                        for pair in pairs
                        for side in pair.sides
                        if side.implementation == "candidate"
                    ),
                },
                sort_keys=True,
            )
        )
        return 0 if all(pair.valid for pair in pairs) else 1

    registered = load_manifest(args.registered)
    if registered.baseline.commit != args.baseline_source:
        raise ValueError("baseline_source_mismatch")
    frozen = registered.freeze_run(
        candidate=ImplementationIdentity(commit=args.candidate),
        agent=parse_agent_identity(_json_object(args.agent_config)),
        environment=parse_environment_identity(_json_object(args.environment_config)),
        instrumentation_commit=args.instrumentation,
    )
    frozen.validate_publishable()
    write_manifest(args.output, frozen)
    print(
        json.dumps(
            {
                "output": str(args.output),
                "suite": frozen.suite,
                "tasks": len(frozen.tasks),
                "publishable": True,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
