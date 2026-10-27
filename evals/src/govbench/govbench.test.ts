// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { cases } from "./corpus.js";
import { corpusSha256, runGovBench } from "./harness.js";

// One case per guarantee, chosen to run identically on ubuntu/macos/windows:
// no symlinks, no POSIX-only programs, no browser. The full corpus is
// `pnpm benchmark:govbench`. It stays out of CI because it launches Chrome per
// browser case (~30 s locally, times six CI jobs), uses POSIX programs (`ls`,
// `cat`) that Windows runners lack, and its published failures are findings to
// fix, not regressions to gate on.
const SMOKE = [
  "contain.path.read.dotdot",
  "contain.path.write.absolute",
  // Refused by the file runtime itself, not by planning's evidence check.
  "contain.path.write.root",
  "contain.path.mkdir.dotdot",
  "contain.path.mkdir.absolute",
  "contain.path.move.dest-outside",
  "contain.path.move.source-outside",
  "contain.cmd.bash",
  "contain.constraints.file-write",
  "contain.no-evidence.echo",
  "contain.ssrf.http.get.loopback-decimal",
  "approval.wrong_phrase",
  "approval.tightened_policy.mutations-deny",
  "approval.flood",
  "verify.write.hash-mismatch",
  "verify.http.post-dropped",
  "once.http.same-key-twice",
  "redact.github-pat.goal",
  "redact.openai-key.http-header",
  "utility.file.write-new",
  "utility.http.get",
];

describe("GovBench", () => {
  it("has unique case ids and a stable hash", () => {
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    expect(corpusSha256()).toMatch(/^[a-f0-9]{64}$/);
    for (const id of SMOKE) expect(cases.some((item) => item.id === id), id).toBe(true);
  });

  it(
    "holds a portable cross-section of the corpus",
    async () => {
      const report = await runGovBench({ only: SMOKE, overhead: false });
      expect(report.casesRun).toBe(SMOKE.length);
      expect(report.failures, JSON.stringify(report.failures, null, 2)).toEqual([]);
    },
    60_000,
  );
});
