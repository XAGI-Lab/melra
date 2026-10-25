// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { sqliteShipsWith, sqliteUnavailable } from "../src/node-support.js";

describe("node:sqlite at load", () => {
  it("knows the releases it loads on without a flag", () => {
    for (const version of ["22.13.0", "22.20.1", "23.4.0", "23.11.1", "24.0.0", "26.8.2"]) {
      expect(sqliteShipsWith(version), version).toBe(true);
    }
    for (const version of ["20.19.0", "22.3.0", "22.12.0", "23.0.0", "23.3.0"]) {
      expect(sqliteShipsWith(version), version).toBe(false);
    }
  });

  it("names the versions that work on an older release, and the switch on a supported one", () => {
    expect(sqliteUnavailable("23.3.0")).toBe(
      "melra: Node.js 23.3.0 cannot load node:sqlite; use Node.js 22.13 or newer, or 23.4 or newer",
    );
    expect(sqliteUnavailable("24.1.0")).toBe(
      "melra: Node.js 24.1.0 has node:sqlite turned off or built without it; check NODE_OPTIONS for --no-experimental-sqlite",
    );
  });
});
