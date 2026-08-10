// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createCertificate,
  evidenceStrength,
  redactStructuredValue,
  sha256,
} from "./index.js";

describe("receipt and certificate primitives", () => {
  it("canonicalizes object keys before hashing", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}',
    );
    expect(sha256({ b: 2, a: 1 })).toBe(sha256({ a: 1, b: 2 }));
  });

  it("binds the certificate digest to every public field", () => {
    const certificate = createCertificate({
      taskId: "cff6c496-88b9-442b-b6ef-6f63f57364a3",
      goal: "Verify a deterministic outcome",
      result: "VERIFIED_SUCCESS",
      policyVersion: "1",
      receiptIds: ["3f5676d5-1c17-4670-8fa1-ddd55170d5a0"],
      evidence: [
        { type: "result_equals", passed: true, summary: "matched" },
      ],
      createdAt: "2026-07-28T00:00:00.000Z",
    });
    const { digest, ...unsigned } = certificate;
    expect(digest).toBe(sha256(unsigned));
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("redacts secret-shaped strings and sensitive fields recursively", () => {
    const redacted = redactStructuredValue({
      page: "password=hunter2",
      nested: { authorization: "Bearer should-never-persist" },
      values: ["ghp_123456789012345678901234"],
    }) as {
      value: {
        page: string;
        nested: { authorization: string };
        values: string[];
      };
      redactions: string[];
    };
    expect(redacted.value.page).not.toContain("hunter2");
    expect(redacted.value.nested.authorization).toBe(
      "[REDACTED_SENSITIVE_FIELD]",
    );
    expect(redacted.value.values[0]).not.toContain("ghp_");
    expect(redacted.redactions.length).toBeGreaterThanOrEqual(2);
  });

  it("ranks re-read state above the adapter's own report", () => {
    // The distinction the field exists for: a file the kernel went back and
    // looked at outranks the adapter saying the call returned.
    expect(evidenceStrength("file_hash")).toBe("state");
    expect(evidenceStrength("operation_completed")).toBe("execution");
  });

  it("reads an unknown evidence type as the weakest claim", () => {
    // A predicate added without a decision in the table, or a type from a
    // future version, must not inherit a strength it never earned.
    expect(evidenceStrength("predicate_from_a_later_version")).toBe("execution");
  });
});
