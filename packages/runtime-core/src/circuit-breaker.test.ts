// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "./circuit-breaker.js";

describe("CircuitBreaker", () => {
  const at = (start: number) => {
    let clock = start;
    return {
      advance: (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    };
  };

  it("opens on consecutive failures against one target and leaves others alone", () => {
    const clock = at(1_000);
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 500 }, clock.now);

    breaker.recordFailure("https://down.example");
    expect(breaker.check("https://down.example")).toBeUndefined();
    breaker.recordFailure("https://down.example");
    expect(breaker.check("https://down.example")).toBe(
      "circuit_open:https://down.example",
    );
    // Keyed on the target, so an unrelated task is not punished for it.
    expect(breaker.check("https://up.example")).toBeUndefined();

    breaker.recordSuccess("https://down.example");
    expect(breaker.check("https://down.example")).toBeUndefined();
  });

  it("lets one trial through after the cooldown and re-opens if it fails", () => {
    const clock = at(1_000);
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 500 }, clock.now);
    breaker.recordFailure("target");
    breaker.recordFailure("target");

    clock.advance(500);
    expect(breaker.check("target")).toBeUndefined();

    // The trial fails. Without keeping the count, this would hand out another
    // full `threshold` attempts every cooldown instead of re-opening at once.
    breaker.recordFailure("target");
    expect(breaker.check("target")).toBe("circuit_open:target");

    clock.advance(500);
    expect(breaker.check("target")).toBeUndefined();
    breaker.recordSuccess("target");
    breaker.recordFailure("target");
    expect(breaker.check("target")).toBeUndefined();
  });

  it("does nothing at all when switched off", () => {
    const breaker = new CircuitBreaker({ threshold: 0, cooldownMs: 500 });
    for (let index = 0; index < 10; index += 1) breaker.recordFailure("target");
    expect(breaker.check("target")).toBeUndefined();
  });
});
