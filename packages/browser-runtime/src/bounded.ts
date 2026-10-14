// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * A browser call that did not answer within its bound.
 *
 * Its own type so the code that swallows a detached frame or a closed page can
 * tell "this went away" from "this stopped answering" — the second is never an
 * answer, and treating it as one would hide a wedged renderer behind a
 * plausible empty result.
 */
export class BrowserCallTimeoutError extends Error {
  constructor(what: string) {
    super(`browser_call_timeout:${what}`);
    this.name = "BrowserCallTimeoutError";
  }
}

/**
 * Settle with `call`, or fail once `ms` passes or `signal` aborts.
 *
 * Several Playwright calls — `title()`, `evaluate()`, `count()`, `close()`, a
 * CDP `send` — take no timeout of their own, so a renderer that stopped
 * answering held the action until the task budget ran out, or forever where no
 * budget was armed. The call itself cannot be cancelled; it is left to finish
 * or not, and its eventual rejection is consumed here rather than surfacing as
 * an unhandled one. The timer and the abort listener are both released the
 * moment either side wins, so nothing is left holding the process open.
 *
 * `ms` may be `Infinity` for a call whose only legitimate bound is the task's
 * own budget.
 */
export function bounded<T>(
  call: Promise<T>,
  ms: number,
  what: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      settle();
    };
    const aborted = () => {
      finish(() => reject(signal?.reason ?? new Error("task_cancelled")));
    };
    const timer = Number.isFinite(ms)
      ? setTimeout(() => finish(() => reject(new BrowserCallTimeoutError(what))), ms)
      : undefined;
    signal?.addEventListener("abort", aborted, { once: true });
    call.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal?.aborted === true) aborted();
  });
}
