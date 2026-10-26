# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

from dataclasses import dataclass

from melra import MelraClient

from .agent import BrowserActionDecision

# A browser action must be able to fail with its own, specific error before the
# task budget aborts it. Playwright waits ACTION_TIMEOUT_MS for a target it
# cannot resolve; if that matched TASK_BUDGET_MS the abort would fire at the same
# moment and win, reporting every unresolvable target as `budget_exhausted`.
ACTION_TIMEOUT_MS = 10_000
TASK_BUDGET_MS = 30_000


@dataclass(frozen=True)
class DriverObservation:
    task_id: str
    plan_status: str
    task_status: str
    output: dict[str, object]
    receipt: dict[str, object]
    certificate: dict[str, object] | None
    mcp_calls: int


class MelraBrowserDriver:
    def __init__(self, client: MelraClient) -> None:
        self._client = client

    async def perform(
        self,
        decision: BrowserActionDecision,
        expected_evidence: list[dict[str, object]],
    ) -> DriverObservation:
        operation = decision.operation()
        if operation.get("kind") != "browser":
            raise ValueError("benchmark_driver_browser_operation_required")
        request = {
            "goal": decision.goal,
            "operation": {**operation, "timeoutMs": ACTION_TIMEOUT_MS},
            "requiredEvidence": expected_evidence,
            "budget": {
                "maxSteps": 1,
                "maxDurationMs": TASK_BUDGET_MS,
                "maxRetries": 0,
            },
        }
        plan = await self._client.plan(request)
        planned_request = plan.get("request")
        planned_operation = (
            planned_request.get("operation") if isinstance(planned_request, dict) else None
        )
        if not isinstance(planned_operation, dict) or any(
            planned_operation.get(key) != value for key, value in operation.items()
        ):
            raise ValueError("benchmark_driver_plan_operation_mismatch")
        if plan.get("status") == "policy_blocked":
            raise RuntimeError("benchmark_driver_policy_blocked")
        approval = None
        if plan.get("status") == "awaiting_approval":
            challenge = plan.get("approval")
            if not isinstance(challenge, dict):
                raise ValueError("benchmark_driver_approval_missing")
            approval_id = challenge.get("approvalId")
            phrase = challenge.get("phrase")
            if not isinstance(approval_id, str) or not isinstance(phrase, str):
                raise ValueError("benchmark_driver_approval_invalid")
            approval = {"approvalId": approval_id, "phrase": phrase}
        task_id = plan.get("id")
        if not isinstance(task_id, str):
            raise TypeError("benchmark_driver_task_id_missing")
        execution = await self._client.execute(task_id, approval)
        task = execution.get("task")
        if not isinstance(task, dict) or not isinstance(task.get("status"), str):
            raise TypeError("benchmark_driver_execution_invalid")
        evidence = await self._client.receipt(task_id=task_id)
        receipts = evidence.get("receipts")
        if (
            not isinstance(receipts, list)
            or len(receipts) != 1
            or not isinstance(receipts[0], dict)
        ):
            raise ValueError("benchmark_driver_receipt_invalid")
        output = execution.get("output")
        if output is None:
            output = {}
        if not isinstance(output, dict):
            raise TypeError("benchmark_driver_output_invalid")
        certificate = evidence.get("certificate")
        if certificate is not None and not isinstance(certificate, dict):
            raise ValueError("benchmark_driver_certificate_invalid")
        return DriverObservation(
            task_id=task_id,
            plan_status=str(plan["status"]),
            task_status=str(task["status"]),
            output=output,
            receipt=receipts[0],
            certificate=certificate,
            mcp_calls=3,
        )
