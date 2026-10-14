// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import type { Page } from "playwright-core";
import { bounded, BrowserCallTimeoutError } from "./bounded.js";

/**
 * Slack past `timeoutMs` before the settle wait counts as stalled. The wait
 * resolves itself from a timer inside the page at `timeoutMs`, so it only runs
 * past that when the renderer is not running timers at all; the grace covers
 * the round trip, not a slow page.
 */
export const SETTLE_GRACE_MS = 1_000;

export interface DomStabilityOptions {
  quietWindowMs?: number;
  timeoutMs?: number;
}

export interface DomStabilityResult {
  waitedMs: number;
  mutationCount: number;
  timedOut: boolean;
  reason: "quiet_window" | "timeout" | "page_unavailable";
}

export function normalizeDomStabilityOptions(
  options: DomStabilityOptions = {},
): Required<DomStabilityOptions> {
  const quietWindowMs = Math.max(
    25,
    Math.min(2_000, Math.round(options.quietWindowMs ?? 180)),
  );
  const timeoutMs = Math.max(
    quietWindowMs,
    Math.min(10_000, Math.round(options.timeoutMs ?? 1_500)),
  );
  return { quietWindowMs, timeoutMs };
}

/**
 * Wait until DOM mutations have been quiet for a bounded window.
 *
 * This is intentionally condition-based instead of a fixed sleep. It returns
 * its own measurement so callers can distinguish a stable observation from a
 * timeout and preserve that distinction in execution evidence.
 *
 * A page that is not running its timers at all never reports either, so the
 * wait itself is bounded at `timeoutMs + SETTLE_GRACE_MS` and by `signal`, and
 * throws `browser_call_timeout:settle` rather than reporting a page that is
 * still there as `page_unavailable`.
 */
export async function waitForStableDom(
  page: Page,
  options: DomStabilityOptions = {},
  signal?: AbortSignal,
): Promise<DomStabilityResult> {
  if (page.isClosed()) {
    return {
      waitedMs: 0,
      mutationCount: 0,
      timedOut: false,
      reason: "page_unavailable",
    };
  }
  const normalized = normalizeDomStabilityOptions(options);
  try {
    const settled = page.evaluate(
      ({ quietWindowMs, timeoutMs }) =>
        new Promise<DomStabilityResult>((resolve) => {
          const startedAt = performance.now();
          let mutations = 0;
          let quietTimer: ReturnType<typeof setTimeout> | undefined;
          let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
          let settled = false;

          const finish = (
            reason: DomStabilityResult["reason"],
            timedOut: boolean,
          ) => {
            if (settled) return;
            settled = true;
            observer.disconnect();
            if (quietTimer !== undefined) clearTimeout(quietTimer);
            if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
            resolve({
              waitedMs: Math.round(performance.now() - startedAt),
              mutationCount: mutations,
              timedOut,
              reason,
            });
          };
          const armQuietWindow = () => {
            if (quietTimer !== undefined) clearTimeout(quietTimer);
            quietTimer = setTimeout(
              () => finish("quiet_window", false),
              quietWindowMs,
            );
          };
          const observer = new MutationObserver((records) => {
            mutations += records.length;
            armQuietWindow();
          });
          observer.observe(document.documentElement, {
            attributes: true,
            characterData: true,
            childList: true,
            subtree: true,
          });
          timeoutTimer = setTimeout(
            () => finish("timeout", true),
            timeoutMs,
          );
          armQuietWindow();
        }),
      normalized,
    );
    return await bounded(
      settled,
      normalized.timeoutMs + SETTLE_GRACE_MS,
      "settle",
      signal,
    );
  } catch (error) {
    // A page that stopped answering has not gone away, and saying it had would
    // let the snapshot that follows wait out the same stall a second time.
    if (error instanceof BrowserCallTimeoutError || signal?.aborted === true) {
      throw error;
    }
    return {
      waitedMs: 0,
      mutationCount: 0,
      timedOut: false,
      reason: "page_unavailable",
    };
  }
}
