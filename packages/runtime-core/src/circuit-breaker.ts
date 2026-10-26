// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

export interface CircuitBreakerOptions {
  threshold: number;
  cooldownMs: number;
}

/**
 * Consecutive-failure breaker keyed on the target an operation names.
 *
 * `budget.maxRetries` covers a blip inside one task and nothing carried further:
 * a workflow whose node keeps failing against the same host, file, or command
 * would spend every remaining step rediscovering that. One breaker instance is
 * shared by the whole controller, so tasks that are unrelated except for their
 * target still trip it together, and a workflow's nodes inherit it because they
 * run through that same controller.
 *
 * `check` reports without recording; `recordFailure` and `recordSuccess` are the
 * writes. Only a failure to reach the target counts. A `partial` clears the
 * count like a success does — the adapter reached the target and the evidence
 * disagreed, which is a verification problem, not an unreachable target — and a
 * cancellation counts neither way, being the operator's doing.
 *
 * ponytail: in-memory, per process. A breaker is a live health signal, so a
 * restart starting closed is the honest default; persist it if operators start
 * asking why a fresh process retries a target they know is down.
 */
export class CircuitBreaker {
  private readonly failures = new Map<string, { count: number; openedAt: number }>();

  constructor(
    private readonly options: CircuitBreakerOptions,
    private readonly clock: () => number = Date.now,
  ) {}

  /** `undefined` when the target may be attempted, else the reason it may not. */
  check(target: string): string | undefined {
    if (this.options.threshold <= 0) return undefined;
    const state = this.failures.get(target);
    if (state === undefined || state.count < this.options.threshold) {
      return undefined;
    }
    // Past the cooldown the next attempt is allowed through as the trial. The
    // count is deliberately left alone: if the trial fails, `recordFailure`
    // re-opens immediately rather than granting another `threshold` attempts.
    if (this.clock() - state.openedAt >= this.options.cooldownMs) return undefined;
    return `circuit_open:${target}`;
  }

  recordFailure(target: string): void {
    if (this.options.threshold <= 0) return;
    const count = (this.failures.get(target)?.count ?? 0) + 1;
    this.failures.set(target, { count, openedAt: this.clock() });
  }

  recordSuccess(target: string): void {
    this.failures.delete(target);
  }
}
