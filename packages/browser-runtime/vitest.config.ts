// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";

// One retry on CI only. Every browser-runtime failure on hosted runners so far
// has been Chrome itself slow to launch or answer (a CDP connect or a
// `page.goto` past 30 s, a cold launch past 15 s), never a wrong result (#145,
// #107). A retried test still prints its first failure, a test that fails
// twice still fails the job, and local runs stay strict.
export default defineConfig({
  test: { retry: process.env.CI ? 1 : 0 },
});
