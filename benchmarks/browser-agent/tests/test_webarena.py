# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

pytest.importorskip("webarena_verified")

from melra_browser_bench.manifest import load_manifest
from melra_browser_bench.webarena import (
    PairSideExecution,
    WebArenaEnvironment,
    build_pair_schedule,
    evaluate_official_task,
    run_paired_tasks,
    validate_registered_subset,
)

ROOT = Path(__file__).parents[1]
FIXTURES = Path(__file__).parent / "fixtures" / "webarena"
MANIFEST = ROOT / "manifests" / "webarena-verified-hard-30-v1.json"


def test_official_response_evaluator_passes_a_literal_fixture() -> None:
    result = evaluate_official_task(
        config_path=FIXTURES / "config.json",
        task_id=15,
        agent_response={
            "task_type": "RETRIEVE",
            "status": "SUCCESS",
            "retrieved_data": [2],
            "error_details": None,
        },
        network_trace=FIXTURES / "network.har",
    )
    assert result.status == "success"
    assert result.score == 1
    assert result.version == "1.2.3"
    assert len(result.evaluator_checksum) == 64
    assert len(result.data_checksum) == 64


def test_registered_subset_matches_official_task_metadata() -> None:
    verified = validate_registered_subset(MANIFEST)
    assert verified.task_count == 30
    assert verified.unique_templates == 30
    assert verified.task_types == {
        "MUTATE": 16,
        "NAVIGATE": 5,
        "RETRIEVE": 9,
    }


def test_pair_schedule_is_balanced_and_deterministic() -> None:
    task_ids = tuple(range(30))
    first = build_pair_schedule(task_ids, seed="hard-30-v1")
    second = build_pair_schedule(task_ids, seed="hard-30-v1")
    assert first == second
    assert {item.task_id for item in first} == set(task_ids)
    assert sum(item.first == "baseline" for item in first) == 15
    assert sum(item.first == "candidate" for item in first) == 15
    assert all(set(item.order) == {"baseline", "candidate"} for item in first)


class _EnvironmentControlHandler(BaseHTTPRequestHandler):
    init_calls = 0
    image_digest = "sha256:" + "d" * 64

    def do_GET(self) -> None:
        assert self.path == "/status"
        self._respond(
            {
                "success": True,
                "message": "ready",
                "details": {
                    "status": "ready",
                    "image_digest": self.image_digest,
                },
            }
        )

    def do_POST(self) -> None:
        assert self.path == "/init"
        type(self).init_calls += 1
        self._respond({"success": True, "message": "reset", "details": {}})

    def _respond(self, value: dict[str, object]) -> None:
        body = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def test_preflight_and_paired_order_reset_each_side(tmp_path: Path) -> None:
    _EnvironmentControlHandler.init_calls = 0
    server = ThreadingHTTPServer(("127.0.0.1", 0), _EnvironmentControlHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        control_url = f"http://{host}:{port}"
        config = tmp_path / "config.json"
        config.write_text(
            json.dumps(
                {
                    "environments": {
                        "shopping_admin": {
                            "urls": ["http://shopping-admin.test"],
                            "extra": {"env_ctrl_url": control_url},
                        },
                        "shopping": {
                            "urls": ["http://shopping.test"],
                            "extra": {"env_ctrl_url": control_url},
                        },
                    }
                }
            ),
            encoding="utf-8",
        )
        environment = WebArenaEnvironment.from_config(config)
        tasks = load_manifest(MANIFEST).tasks[:2]
        expected = {
            "shopping_admin": _EnvironmentControlHandler.image_digest,
            "shopping": _EnvironmentControlHandler.image_digest,
        }
        assert environment.preflight(tasks[0], expected).ready is True
        execution_order: list[tuple[int, str]] = []

        def execute(task_id: int, side: str) -> PairSideExecution:
            execution_order.append((task_id, side))
            return PairSideExecution(
                implementation=side,
                success=True,
                infrastructure_failure=False,
            )

        pairs = run_paired_tasks(
            tasks=tasks,
            environment=environment,
            expected_images=expected,
            execute=execute,
        )
        assert execution_order == [
            (15, "baseline"),
            (15, "candidate"),
            (21, "candidate"),
            (21, "baseline"),
        ]
        assert _EnvironmentControlHandler.init_calls == 4
        assert all(pair.valid for pair in pairs)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
