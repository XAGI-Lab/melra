// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  allowsRetry,
  delegationChain,
  effectContract,
  LOCAL_IDENTITY,
  MelraReceiptInputSchema,
  PROTOCOL_VERSION,
  TaskRequestSchema,
  TOOL_NAMES,
  type TaskRecord,
} from "./index.js";

describe("public protocol schemas", () => {
  it("applies bounded task defaults", () => {
    const request = TaskRequestSchema.parse({
      goal: "Inspect the runtime",
      operation: { kind: "system", action: "info" },
    });
    expect(request.budget).toEqual({
      maxSteps: 10,
      maxDurationMs: 120_000,
      maxRetries: 2,
    });
    expect(request.constraints).toEqual([]);
    expect(request.requiredEvidence).toEqual([]);
  });

  it("rejects unknown fields and unknown effect names", () => {
    expect(() =>
      TaskRequestSchema.parse({
        goal: "Reject schema smuggling",
        operation: {
          kind: "file",
          action: "read",
          path: "README.md",
          executeAnyway: true,
        },
      }),
    ).toThrow();
    expect(() =>
      TaskRequestSchema.parse({
        goal: "Reject an unknown effect",
        operation: { kind: "system", action: "info" },
        forbiddenEffects: ["network"],
      }),
    ).toThrow();
  });

  it("keeps the compact tool and receipt lookup contracts strict", () => {
    expect(TOOL_NAMES).toEqual([
      "melra_capabilities",
      "melra_plan",
      "melra_execute",
      "melra_task_status",
      "melra_task_cancel",
      "melra_receipt",
      "melra_workflow_plan",
      "melra_workflow_advance",
      "melra_workflow_status",
      "melra_workflow_cancel",
      "melra_workflow_control",
    ]);
    expect(() => MelraReceiptInputSchema.parse({})).toThrow();
    expect(
      MelraReceiptInputSchema.parse({
        taskId: "8c73f2ad-f503-47c6-83d5-7a866a70bdf0",
      }).taskId,
    ).toBe("8c73f2ad-f503-47c6-83d5-7a866a70bdf0");
  });
});

describe("effect contract", () => {
  const record = (
    request: Record<string, unknown>,
    extra: Partial<TaskRecord> = {},
  ): TaskRecord => ({
    id: "4c5a0130-71a5-4c48-b22d-c7901f12688f",
    request: TaskRequestSchema.parse(request),
    status: "planned",
    policyDecision: {
      outcome: "allow",
      effect: "read",
      risk: "low",
      reason: "read_only_operation",
      policyVersion: "1",
      traits: [],
    },
    receiptIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  });

  it("names the fields that already governed the task", () => {
    const contract = effectContract(
      record({
        goal: "Read the changelog",
        operation: { kind: "file", action: "read", path: "CHANGELOG.md" },
      }),
      { capability: "file.read", target: "CHANGELOG.md" },
    );
    expect(contract).toMatchObject({
      contractVersion: PROTOCOL_VERSION,
      capability: "file.read",
      effect: "read",
      risk: "low",
      target: "CHANGELOG.md",
      identity: LOCAL_IDENTITY,
      metadata: { goal: "Read the changelog" },
    });
    // Absent rather than undefined: a contract with no approval attached has
    // nothing to authorize, and `exactOptionalPropertyTypes` keeps that visible.
    expect("authorization" in contract).toBe(false);
    expect("idempotencyKey" in contract).toBe(false);
  });

  it("carries the delegation chain the caller declared", () => {
    const identity = {
      principal: { kind: "agent" as const, id: "claude-code" },
      onBehalfOf: [
        { kind: "organization" as const, id: "acme" },
        { kind: "human" as const, id: "dheeraj" },
      ],
    };
    const contract = effectContract(
      record({
        goal: "Read the changelog",
        operation: { kind: "file", action: "read", path: "CHANGELOG.md" },
        identity,
      }),
      { capability: "file.read", target: "CHANGELOG.md" },
    );
    expect(contract.identity).toEqual(identity);
    expect(delegationChain(contract.identity)).toBe(
      "organization:acme/human:dheeraj/agent:claude-code",
    );
  });

  it("publishes how many times the effect may run", () => {
    // The rule was already true; a caller setting budget.maxRetries on a write
    // just had no way to learn the number would be ignored.
    const read = effectContract(
      record({
        goal: "Read the changelog",
        operation: { kind: "file", action: "read", path: "CHANGELOG.md" },
      }),
      { capability: "file.read", target: "CHANGELOG.md" },
    );
    expect(read.executionGuarantee).toBe("read-only");
    expect(allowsRetry(read.executionGuarantee)).toBe(true);

    const write = effectContract(
      record(
        {
          goal: "Write the changelog",
          operation: {
            kind: "file",
            action: "write",
            path: "CHANGELOG.md",
            content: "x",
          },
          requiredEvidence: [{ type: "file_exists", path: "CHANGELOG.md" }],
        },
        {
          policyDecision: {
            outcome: "confirm",
            effect: "mutate",
            risk: "medium",
            reason: "mutation_requires_approval",
            policyVersion: "1",
            traits: [],
          },
        },
      ),
      { capability: "file.write", target: "CHANGELOG.md" },
    );
    expect(write.executionGuarantee).toBe("at-most-once");
    expect(allowsRetry(write.executionGuarantee)).toBe(false);
  });
});
