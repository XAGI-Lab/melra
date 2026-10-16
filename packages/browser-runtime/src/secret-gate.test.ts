// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { BrowserRuntime } from "./index.js";

/** A frame as the secret check sees it, answering from a script of outcomes. */
const frame = (outcomes: Array<boolean | Error>, detached = false) => ({
  isDetached: () => detached,
  evaluate: async () => {
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return next;
  },
  waitForLoadState: async () => undefined,
});

const check = (target: ReturnType<typeof frame>) =>
  (
    new BrowserRuntime({
      workspaceRoot: "/tmp",
      artifactDirectory: "/tmp/melra-secret-gate",
      allowedDomains: [],
      allowLocalhost: false,
    }) as unknown as {
      frameHoldsSecret(frame: unknown): Promise<boolean>;
    }
  ).frameHoldsSecret(target);

describe("the secret-field check on a frame", () => {
  it("asks a frame mid-navigation again, once its next document has loaded", async () => {
    const navigating = new Error("frame.evaluate: Execution context was destroyed, most likely because of a navigation");
    expect(await check(frame([navigating, false]))).toBe(false);
    expect(await check(frame([navigating, true]))).toBe(true);
  });

  it("counts a frame that keeps failing, or fails otherwise, as holding a secret", async () => {
    const navigating = new Error("Execution context was destroyed");
    expect(await check(frame([navigating, navigating, navigating]))).toBe(true);
    expect(await check(frame([new Error("Protocol error: Target crashed")]))).toBe(true);
  });

  it("finds nothing in a frame that has gone", async () => {
    expect(await check(frame([], true))).toBe(false);
  });
});
