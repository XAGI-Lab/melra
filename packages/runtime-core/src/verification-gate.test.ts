// Copyright 2024-2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  createVerificationGateState,
  markVerificationPrompted,
  observeToolCall,
  requiresVerification,
} from "./verification-gate.js";

describe("verification gate", () => {
  it("does not gate read-only work", () => {
    const state = createVerificationGateState();
    observeToolCall(state, { name: "read", effect: "read" });
    expect(requiresVerification(state)).toBe(false);
  });

  it("requires structured verification after mutation", () => {
    const state = createVerificationGateState();
    observeToolCall(state, { name: "click", effect: "mutate" });
    expect(requiresVerification(state)).toBe(true);
    observeToolCall(state, {
      name: "verify-text",
      effect: "read",
      structuredVerification: true,
      expectationProvided: true,
    });
    expect(requiresVerification(state)).toBe(false);
  });

  it("resets proof after another mutation", () => {
    const state = createVerificationGateState();
    observeToolCall(state, { name: "click", effect: "mutate" });
    observeToolCall(state, {
      name: "verify-text",
      effect: "read",
      structuredVerification: true,
      expectationProvided: true,
    });
    observeToolCall(state, { name: "type", effect: "mutate" });
    expect(requiresVerification(state)).toBe(true);
  });

  it("prompts at most once per gate state", () => {
    const state = createVerificationGateState();
    observeToolCall(state, { name: "click", effect: "mutate" });
    markVerificationPrompted(state);
    expect(requiresVerification(state)).toBe(false);
  });
});
