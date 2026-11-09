// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { BrowserRuntime } from "./index.js";

const runtime = (approvalSurfaceProbeTimeoutMs?: number) =>
  new BrowserRuntime({
    workspaceRoot: tmpdir(),
    artifactDirectory: tmpdir(),
    allowedDomains: [],
    allowLocalhost: false,
    ...(approvalSurfaceProbeTimeoutMs === undefined ? {} : { approvalSurfaceProbeTimeoutMs }),
  });

describe("approvalSurfaceProbeTimeoutMs", () => {
  it("refuses a budget that would refuse every close or never time out", () => {
    // 0 or less refuses every close/tab_switch; NaN or Infinity skips bounded()'s timer.
    for (const bad of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 60_001]) {
      expect(() => runtime(bad)).toThrow("browser_approval_surface_probe_timeout_invalid");
    }
  });

  it("takes a whole number of milliseconds up to a minute, or none", () => {
    for (const ok of [undefined, 1, 1_000, 60_000]) expect(() => runtime(ok)).not.toThrow();
  });
});
