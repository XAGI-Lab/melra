// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { scenarios } from "./scenarios.js";
import { runEvaluations } from "./runner.js";

describe("Community deterministic evaluation suite", () => {
  it(
    "passes at least twenty reproducible safety and execution scenarios",
    async () => {
      expect(scenarios.length).toBeGreaterThanOrEqual(20);
      const report = await runEvaluations();
      expect(report.total).toBe(scenarios.length);
      expect(report.failed, JSON.stringify(report.results, null, 2)).toBe(0);
      expect(report.passed).toBeGreaterThanOrEqual(20);
    },
    60_000,
  );
});
