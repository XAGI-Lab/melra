// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { bounded, BrowserCallTimeoutError } from "./bounded.js";

afterEach(() => {
  vi.useRealTimers();
});

/** A promise the test settles by hand, standing in for a Playwright call. */
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("bounded", () => {
  it("passes the call's value through and leaves no timer behind", async () => {
    vi.useFakeTimers();
    await expect(bounded(Promise.resolve(7), 1_000, "title")).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      bounded(Promise.reject(new Error("page_closed")), 1_000, "title"),
    ).rejects.toThrow("page_closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails with a typed error naming the call when the bound runs out", async () => {
    vi.useFakeTimers();
    const call = pending<string>();
    const result = bounded(call.promise, 500, "title");
    const settled = expect(result).rejects.toThrow("browser_call_timeout:title");
    await vi.advanceTimersByTimeAsync(500);
    await settled;
    await expect(result).rejects.toBeInstanceOf(BrowserCallTimeoutError);
    // The call losing the race and then failing must not become an unhandled
    // rejection; vitest fails the run if it does.
    call.reject(new Error("target_closed"));
    await Promise.resolve();
  });

  it("fails with the signal's reason on abort, and releases the listener", async () => {
    const call = pending<string>();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = bounded(call.promise, 60_000, "evaluate", controller.signal);
    controller.abort(new Error("task_budget_exhausted"));
    await expect(result).rejects.toThrow("task_budget_exhausted");
    expect(remove).toHaveBeenCalled();
    call.resolve("late");
  });

  it("fails at once on a signal that already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("task_cancelled"));
    await expect(
      bounded(new Promise<never>(() => undefined), Infinity, "save_download", controller.signal),
    ).rejects.toThrow("task_cancelled");
  });
});
