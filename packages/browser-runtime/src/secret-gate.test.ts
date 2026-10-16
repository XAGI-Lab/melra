// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { BrowserRuntime } from "./index.js";

/** A frame as the secret check sees it, answering from a script of outcomes. */
const frame = (outcomes: Array<boolean | Error | "hang">, detached = false, url = "https://page.example/") => ({
  isDetached: () => detached,
  url: () => url,
  evaluate: async () => {
    const next = outcomes.shift();
    if (next === "hang") return new Promise<never>(() => undefined);
    if (next instanceof Error) throw next;
    return next;
  },
  waitForLoadState: async () => undefined,
});

const runtime = () =>
  new BrowserRuntime({
      workspaceRoot: "/tmp",
      artifactDirectory: "/tmp/melra-secret-gate",
      allowedDomains: [],
      allowLocalhost: false,
  }) as unknown as {
    frameHoldsSecret(frame: unknown, ms?: number): Promise<"filled" | "clear" | "unknown">;
    secretFieldFilled(page: unknown): Promise<"filled" | "clear" | "unknown">;
  };
const check = (target: ReturnType<typeof frame>) => runtime().frameHoldsSecret(target);

describe("the secret-field check on a frame", () => {
  it("asks a frame mid-navigation again, once its next document has loaded", async () => {
    const navigating = new Error("frame.evaluate: Execution context was destroyed, most likely because of a navigation");
    expect(await check(frame([navigating, false]))).toBe("clear");
    expect(await check(frame([navigating, true]))).toBe("filled");
  });

  it("says it cannot tell, rather than clear, for a frame that keeps failing or fails otherwise", async () => {
    const navigating = new Error("Execution context was destroyed");
    expect(await check(frame([navigating, navigating, navigating]))).toBe("unknown");
    expect(await check(frame([new Error("Protocol error: Target crashed")]))).toBe("unknown");
  });

  it("finds nothing in a frame that has gone", async () => {
    expect(await check(frame([], true))).toBe("clear");
  });

  it("asks every frame of the page, not only the ones a snapshot reads", async () => {
    const frames = [...Array.from({ length: 30 }, () => frame([false])), frame([true])];
    expect(await runtime().secretFieldFilled({ frames: () => frames })).toBe("filled");
  });

  it("asks a frame that attached while the others were being asked", async () => {
    const frames = [frame([false])];
    const late = frame([true]);
    const page = { frames: () => [...frames] };
    // The first frame's answer comes with a new frame on the page.
    frames[0]!.evaluate = async () => {
      frames.push(late);
      return false;
    };
    expect(await runtime().secretFieldFilled(page)).toBe("filled");
  });

  it("finds nothing in a frame with no document yet, which a selector cannot search either", async () => {
    expect(await check(frame(["hang"], false, ""))).toBe("clear");
    // One with a page that does not answer is still unknown.
    expect(await runtime().frameHoldsSecret(frame(["hang"]), 300)).toBe("unknown");
  });
});
