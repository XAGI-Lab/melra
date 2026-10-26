// Copyright 2024-2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createRetryGuardState,
  recordToolResult,
  resetRetryGuard,
  toolCallKey,
} from "./retry-guard.js";

describe("retry guard", () => {
  it("canonicalizes nested object keys", () => {
    expect(canonicalJson({ b: { d: 2, c: 1 }, a: 0 })).toBe(
      canonicalJson({ a: 0, b: { c: 1, d: 2 } }),
    );
  });

  it("separates tools and inputs", () => {
    expect(toolCallKey("read", { path: "a" })).not.toBe(
      toolCallKey("write", { path: "a" }),
    );
  });

  it("warns once when an identical failure repeats", () => {
    const state = createRetryGuardState();
    expect(recordToolResult(state, "read", { path: "a" }, true).shouldWarn).toBe(false);
    expect(recordToolResult(state, "read", { path: "a" }, true).shouldWarn).toBe(true);
    expect(recordToolResult(state, "read", { path: "a" }, true).shouldWarn).toBe(false);
  });

  it("resets a failure streak after success", () => {
    const state = createRetryGuardState();
    recordToolResult(state, "read", {}, true);
    recordToolResult(state, "read", {}, true);
    recordToolResult(state, "read", {}, false);
    expect(recordToolResult(state, "read", {}, true).failureCount).toBe(1);
  });

  it("hard stops only when enabled", () => {
    const state = createRetryGuardState();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      recordToolResult(state, "read", {}, true, {
        hardStopEnabled: true,
        stopAt: 5,
      });
    }
    expect(
      recordToolResult(state, "read", {}, true, {
        hardStopEnabled: true,
        stopAt: 5,
      }).shouldStop,
    ).toBe(true);
  });

  it("clears state explicitly", () => {
    const state = createRetryGuardState();
    recordToolResult(state, "read", {}, true);
    resetRetryGuard(state);
    expect(state.failuresByKey.size).toBe(0);
  });
});
