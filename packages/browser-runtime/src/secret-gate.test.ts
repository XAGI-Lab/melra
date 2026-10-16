// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { BrowserRuntime } from "./index.js";

/** A frame as the secret check sees it, answering from a script of outcomes. */
const frame = (outcomes: Array<boolean | Error | "hang">, detached = false, url = "https://page.example/", slowLoads = false) => ({
  isDetached: () => detached,
  url: () => url,
  evaluate: async () => {
    const next = outcomes.shift();
    if (next === "hang") return new Promise<never>(() => undefined);
    if (next instanceof Error) throw next;
    return next;
  },
  // A slow frame's next document takes all the time it is given.
  waitForLoadState: async (_state: string, options: { timeout: number }) =>
    new Promise((resolve) => setTimeout(resolve, slowLoads ? options.timeout : 0)),
});

const runtime = () =>
  new BrowserRuntime({
      workspaceRoot: "/tmp",
      artifactDirectory: "/tmp/melra-secret-gate",
      allowedDomains: [],
      allowLocalhost: false,
  }) as unknown as {
    frameHoldsSecret(frame: unknown, ms?: number): Promise<"filled" | "clear" | "unknown" | "unread">;
    secretFieldFilled(page: unknown, ms?: number): Promise<{ state: string; read: ReadonlySet<unknown> }>;
    candidates(page: unknown, target: { selector: string }, within?: ReadonlySet<unknown>): unknown[];
    readFirst(candidate: unknown, within: ReadonlySet<unknown>): Promise<unknown>;
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
    expect((await runtime().secretFieldFilled({ frames: () => frames })).state).toBe("filled");
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
    expect((await runtime().secretFieldFilled(page)).state).toBe("filled");
  });

  it("leaves a frame with no document yet out of what a targeted read searches", async () => {
    expect(await check(frame(["hang"], false, ""))).toBe("unread");
    // One with a page that does not answer is unknown.
    expect(await runtime().frameHoldsSecret(frame(["hang"]), 300)).toBe("unknown");
    const [answering, blank] = [frame([false]), frame(["hang"], false, "")];
    const result = await runtime().secretFieldFilled({ frames: () => [answering, blank] });
    expect(result.state).toBe("clear");
    expect([...result.read]).toEqual([answering]);
  });

  it("resolves a target only in the frames the check read", () => {
    const searched: string[] = [];
    const stub = (name: string) => ({ locator: () => searched.push(name) });
    const [read, unread] = [stub("read"), stub("unread")];
    runtime().candidates({ frames: () => [read, unread] }, { selector: "#target" }, new Set([read]));
    expect(searched).toEqual(["read"]);
  });

  it("asks a frame that gets its document while being asked again, with the time left", async () => {
    let url = "";
    const committing = {
      ...frame([]),
      url: () => url,
      evaluate: async () => {
        if (url !== "") return false;
        setTimeout(() => (url = "https://page.example/"), 100);
        return new Promise<never>(() => undefined);
      },
    };
    expect(await runtime().frameHoldsSecret(committing, 2_000)).toBe("clear");
  });

  it("uses a match only when its own document is one the check read", async () => {
    const [read, unread] = [{}, {}];
    let disposed = 0;
    const matching = (owner: object) => ({
      first: () => ({
        elementHandles: async () => [{ ownerFrame: async () => owner, dispose: async () => void (disposed += 1) }],
      }),
    });
    const within = new Set([read]);
    expect(await runtime().readFirst(matching(read), within)).toBeDefined();
    expect(await runtime().readFirst(matching(unread), within)).toBeUndefined();
    expect(disposed).toBe(1);
  });

  it("keeps a frame that keeps navigating to one budget, not one per attempt", async () => {
    const navigating = new Error("Execution context was destroyed");
    const started = Date.now();
    const slow = frame([navigating, navigating, navigating], false, undefined, true);
    expect(await runtime().frameHoldsSecret(slow, 300)).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(600);
  });

  it("keeps the whole check to one budget while frames keep attaching", async () => {
    const frames: Array<ReturnType<typeof frame>> = [];
    const page = { frames: () => (frames.push(frame(["hang"])), [...frames]) };
    const started = Date.now();
    expect((await runtime().secretFieldFilled(page, 300)).state).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(600);
  });
});
