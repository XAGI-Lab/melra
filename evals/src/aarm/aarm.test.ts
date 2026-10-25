// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, sign } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createMelraRuntime } from "@melra/server";
import { describe, expect, it } from "vitest";
import { file } from "../govbench/corpus.js";
import { OUTSIDE_CANARY, canonicalJson, sandbox } from "../govbench/harness.js";
import { cases, type AarmCase } from "./corpus.js";
import { AARM_MANIFEST_SHA256, corpusSha256, independentVerify, loadManifest, runAarm, tamper } from "./harness.js";

// Cases that pass today and run the same on ubuntu, macos and windows: no
// symlinks, no POSIX file modes, no POSIX-only programs. A case joins when a
// fix flips it. The full corpus is `pnpm benchmark:aarm`.
const PINNED = [
  "r1t3.closed-store",
  "r1t3.corrupt-policy",
  "r1t3.enforced-unsafe-local",
  "r1t3.approved-then-closed",
  ...["developer", "prior-approval", "grant", "enforced"].flatMap((context) => [
    `r3t1.${context}.contain.cmd.sudo`,
    `r3t1.${context}.contain.path.read.dotdot`,
    `r3t1.${context}.contain.path.write.absolute`,
    `r3t1.${context}.contain.forbidden.delete-destructive`,
    `r3t1.${context}.contain.trait.package-install.npm-install`,
  ]),
  "r3t1.allowlist.contain.cmd.sudo",
  "r3t1.allowlist.contain.cmd.bash",
  "r3t2.control",
  "r4t1.allow",
  "r4t1.deny",
  "r4t1.step-up-held",
  "r4t1.step-up-approved",
  "r6t1.revoked",
  "r6t2.step-up",
  "r9t1.ambient-terminal",
];
// Partial today: the record falls short, but nothing they guard against happens.
// Each names the decisions that hold today too, so a case that stops reaching
// the guard it measures (a runtime that cannot open, say) cannot pass on its
// effects alone.
const EFFECTS_HOLD: Record<string, string[]> = {
  "r1t1.sudo": ["denied"],
  "r1t1.forbidden-delete": ["denied"],
  "r1t1.trait-install": ["denied"],
  "r1t1.outside-write": ["denied"],
  "r4t2.task": ["fails_closed"],
  "r4t2.workflow": ["fails_closed"],
  "r9t1.scoped-credential": ["post_refused", "put_refused", "delete_refused", "credential_named"],
};

/** Runs changed copies of corpus cases under new ids, each standing in for a regression. */
async function runChanged(changes: Record<string, (copy: AarmCase) => void>) {
  const copies = Object.entries(changes).map(([id, change]) => {
    const copy = structuredClone(cases.find((item) => item.id === id)!);
    copy.id = `${id}.changed`;
    change(copy);
    return copy;
  });
  cases.push(...copies);
  try {
    const report = await runAarm({ only: copies.map((item) => item.id) });
    return report.tests.flatMap((test) => test.cases);
  } finally {
    cases.splice(-copies.length);
  }
}

describe("AARM self-check", () => {
  it("matches its pre-registered manifest", async () => {
    const { manifest, sha256 } = await loadManifest();
    expect(sha256).toBe(AARM_MANIFEST_SHA256);
    // Held here too, so changing the manifest takes a deliberate test edit.
    expect(AARM_MANIFEST_SHA256).toBe("ae52f3144e868acb9b3fd147d7a2719a1204df756065e89e422728d551db810f");
    const page = await readFile(new URL("../../../docs/research/AARM_SELFCHECK.md", import.meta.url), "utf8");
    expect(page.split("\n").find((line) => line.startsWith("> "))?.slice(2)).toBe(manifest.claimBoundary);
    expect(corpusSha256()).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    expect(manifest.tests.filter((test) => test.level === "MUST")).toHaveLength(17);
    expect(manifest.tests.filter((test) => test.level === "SHOULD")).toHaveLength(4);
    // n/a only for a SHOULD, and only with a reason.
    for (const test of manifest.tests.filter((item) => item.na !== undefined)) {
      expect(test.level, test.id).toBe("SHOULD");
      expect(test.na?.length, test.id).toBeGreaterThan(0);
    }
    for (const testCase of cases) {
      const test = manifest.tests.find((item) => item.id === testCase.test);
      const listed = testCase.informational === true ? (test?.informational ?? []) : (test?.caseIds ?? []);
      expect(
        listed.some((id) => id === testCase.id || (id.endsWith("*") && testCase.id.startsWith(id.slice(0, -1)))),
        testCase.id,
      ).toBe(true);
      if (testCase.informational !== true) {
        for (const assertion of testCase.asserts) expect(test?.assertions, testCase.id).toContain(assertion.name);
      }
    }
    for (const id of [...PINNED, ...Object.keys(EFFECTS_HOLD)]) expect(cases.some((item) => item.id === id), id).toBe(true);
  });

  it("checks a signature with the public key alone (track C)", () => {
    for (const type of ["ed25519", "ec"] as const) {
      const { publicKey, privateKey } =
        type === "ed25519" ? generateKeyPairSync("ed25519") : generateKeyPairSync("ec", { namedCurve: "P-256" });
      const receipt: Record<string, unknown> = { receiptId: "r", principal: "agent:a", policyDecision: { outcome: "allow" } };
      const value = sign(type === "ed25519" ? null : "sha256", Buffer.from(canonicalJson(receipt)), privateKey);
      const signed = { ...receipt, signature: { value: value.toString("base64") } };
      const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
      expect(independentVerify(signed, pem), type).toBe(true);
      expect(independentVerify({ ...signed, principal: "agent:b" }, pem), type).toBe(false);
    }
  });

  it("writes through the append-only triggers as a full writer (track B)", async () => {
    const box = await sandbox();
    try {
      const open = () => createMelraRuntime({ workspaceRoot: box.workspace, dataDirectory: box.data, environment: {} });
      let runtime = await open();
      const task = runtime.controller.plan({
        goal: "tamper track",
        operation: { kind: "system", action: "info" },
        constraints: [],
        forbiddenEffects: [],
        budget: { maxSteps: 1, maxDurationMs: 5_000, maxRetries: 0 },
        requiredEvidence: [],
        reconciliation: [],
      });
      await runtime.controller.execute(task.id);
      await runtime.close();
      tamper(box.data, "UPDATE receipts SET data = json_set(data, '$.principal', 'agent:aarm-rewritten')");
      runtime = await open();
      expect(runtime.store.getReceiptsForTask(task.id)[0]?.principal).toBe("agent:aarm-rewritten");
      await runtime.close();
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  });

  it(
    "keeps the cases that pass today passing, and the effects of partial ones held",
    async () => {
      const ids = [...PINNED, ...Object.keys(EFFECTS_HOLD)];
      const report = await runAarm({ only: ids });
      const results = [...report.tests.flatMap((test) => test.cases)];
      expect(results.map((item) => item.id).sort()).toEqual(ids.sort());
      for (const item of results) {
        const detail = JSON.stringify(item, null, 2);
        if (PINNED.includes(item.id)) expect(item.status, detail).toBe("pass");
        expect(item.assertions.filter((assertion) => assertion.kind === "effect" && !assertion.passed), detail).toEqual([]);
        expect(item.assertions.length, detail).toBeGreaterThan(0);
        const holding = item.assertions.filter((assertion) => assertion.passed).map((assertion) => assertion.name);
        expect(holding, detail).toEqual(expect.arrayContaining(EFFECTS_HOLD[item.id] ?? []));
      }
      // The artifact may be published: no machine-local sandbox path in it.
      expect(JSON.stringify(results)).not.toContain("melra-govbench-");
    },
    60_000,
  );

  it("counts outside content a read hands back as an escape", async () => {
    const [result] = await runChanged({
      "r3t1.developer.contain.path.read.dotdot": (copy) => {
        copy.fixtures = [{ path: "x.txt", content: OUTSIDE_CANARY }];
        for (const step of copy.steps) if (step.do === "plan") step.request = { ...step.request, operation: file("read", "x.txt") };
      },
    });
    expect(result?.status).toBe("fail");
    expect(result?.assertions.find((assertion) => assertion.name === "no_effect")?.observed).toBe("outside_content_returned");
  });

  it("does not pass a fail-closed case whose plan was refused before the boundary it measures", async () => {
    const results = await runChanged(
      Object.fromEntries(
        ["r1t3.closed-store", "r1t3.approved-then-closed", "r6t1.revoked"].map((id) => [
          id,
          (copy: AarmCase) => {
            for (const step of copy.steps) if (step.do === "plan") step.request = { ...step.request, goal: "" };
          },
        ]),
      ),
    );
    expect(results).toHaveLength(3);
    for (const item of results) expect(item.status, JSON.stringify(item, null, 2)).not.toBe("pass");
  });

  it("leaves a case with no steps unrun, whatever the interface probes report", async () => {
    const [result] = await runChanged({ "r1t2.defer": (copy) => delete copy.needs });
    expect(result?.status).toBe("not_implemented");
  });
});
