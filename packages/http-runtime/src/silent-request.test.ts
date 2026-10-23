// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import type { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { HttpOperationSchema } from "@melra/protocol";

// A request Node has already destroyed: sent, and silent from then on, so
// `destroy()` emits nothing. Only what the runtime does itself can settle it.
const calls = vi.hoisted(() => [] as EventEmitter[]);
vi.mock("node:http", async (actual) => {
  const { EventEmitter } = await import("node:events");
  return {
    ...(await actual<typeof import("node:http")>()),
    request: () => {
      const call = Object.assign(new EventEmitter(), {
        writableFinished: true,
        write: () => true,
        end: () => undefined,
        destroy: () => undefined,
      });
      calls.push(call);
      return call;
    },
  };
});

const { HttpRuntime } = await import("./index.js");

/** A POST to nowhere real, and the request it opened once it has. */
async function charge(timeoutMs: number, signal?: AbortSignal) {
  const before = calls.length;
  const settled = new HttpRuntime({ allowedDomains: ["*"], allowLocalhost: true })
    .execute(
      HttpOperationSchema.parse({
        kind: "http",
        action: "request",
        method: "POST",
        url: "http://127.0.0.1:9/orders",
        content: "charge",
        timeoutMs,
      }),
      signal,
    )
    .catch((error: Error) => error.message);
  await vi.waitFor(() => expect(calls).toHaveLength(before + 1));
  return { settled, call: calls[before]! };
}

describe("a request that goes silent once sent", () => {
  it("settles at the deadline", async () => {
    const { settled } = await charge(200);
    expect(await settled).toBe("effect_outcome_unknown:http_timeout");
  });

  it("settles on a cancel", async () => {
    const controller = new AbortController();
    const { settled } = await charge(60_000, controller.signal);
    controller.abort();
    expect(await settled).toBe("effect_outcome_unknown:task_cancelled");
  });

  it("settles when it closes with no answer and no error", async () => {
    const { settled, call } = await charge(60_000);
    call.emit("close");
    expect(await settled).toBe("effect_outcome_unknown:http_closed_without_response");
  });
});
