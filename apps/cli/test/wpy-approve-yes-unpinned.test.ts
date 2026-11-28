// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// WPY claim [approve-yes-unpinned] ("Who Pressed Yes?" paper, approval integrity).
//
// Claim: `melra approve <id|prefix> --yes` recorded a decision bound to the
// render digest the CLI itself read at that moment (approvalView -> decide),
// without showing the render and with no way for the operator to pin the
// digest of the render they actually reviewed. A short prefix pasted from an
// agent's message therefore approved whatever awaiting task it named, blind.
//
// OLD behaviour (6ccff05): every pin spelling was an unknown flag; an 8-char
// prefix pasted from agent text approved a file delete with --yes, printing
// only {decision}; a 1-char prefix approved the only awaiting task.
//
// FIXED: --yes approves only with `--render <digest>`; bare --yes decides
// nothing and answers (exit 3) with the digest to pin beside the contract it
// covers; a pinned digest that is not the named task's contract is refused by
// decide (approval_render_mismatch); approve takes an id prefix of 8 or more
// characters only (task_id_too_short).

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { createMelraRuntime as createRuntime } from "@melra/server";

const execute = promisify(execFile);
const entry = resolve(import.meta.dirname, "../dist/bin.js");
const roots: string[] = [];
delete process.env.MELRA_MODE;

// Same stand-in sandbox and opt-out cli.test.ts / wpy-headless-approve use.
const createMelraRuntime = (options: Parameters<typeof createRuntime>[0]) =>
  createRuntime({
    detectSandbox: async () => ({ sandbox: { backend: "test", confine: async ({ file, args }) => ({ file, args }) } }),
    ...options,
  });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("wpy [approve-yes-unpinned]", () => {
  it("refuses a blind --yes, binds a yes to the reviewed digest, and refuses short prefixes", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-wpy-")));
    roots.push(base);
    const root = join(base, "workspace");
    await mkdir(root);
    await writeFile(join(root, "ledger.txt"), "precious\n");
    const dataDirectory = join(base, "data");
    const optOut = join(base, "sandbox-opt-out.json");
    await writeFile(optOut, JSON.stringify({ sandbox: { use: "if-available" } }));

    const server = await createMelraRuntime({ workspaceRoot: root, dataDirectory, environment: { MELRA_MODE: "enforced" } });
    try {
      const cli = (...args: string[]) =>
        execute(process.execPath, [entry, "approve", ...args], {
          cwd: root,
          env: { ...process.env, MELRA_HOME: dataDirectory, MELRA_WORKSPACE: root, MELRA_MODE: "enforced", MELRA_POLICY: optOut },
        });
      const failed = (promise: Promise<unknown>) =>
        promise.then(
          () => expect.unreachable("expected a non-zero exit"),
          (error: { code: number; stdout: string; stderr: string }) => error,
        );

      // ---- Part 1: a script reviews the benign write, off a terminal.
      const benign = await server.controller.plan(
        TaskRequestSchema.parse({
          goal: "Write the weekly report",
          operation: { kind: "file", action: "write", path: "report.txt", content: "weekly numbers" },
          requiredEvidence: [{ type: "file_exists", path: "report.txt" }],
        }),
      );
      const review = await failed(cli(benign.id));
      expect(review.code).toBe(3);
      const reviewed = JSON.parse(review.stdout) as { renderDigest: string };
      expect(reviewed.renderDigest).toMatch(/^[0-9a-f]{64}$/);
      await server.controller.cancel(benign.id); // the agent withdraws it

      // ---- Part 2: the agent plans a delete and asks for a blind --yes.
      const evil = await server.controller.plan(
        TaskRequestSchema.parse({
          goal: "Tidy up temp files",
          operation: { kind: "file", action: "delete", path: "ledger.txt" },
          requiredEvidence: [{ type: "file_absent", path: "ledger.txt" }],
        }),
      );
      const pasted = evil.id.slice(0, 8);
      // OLD: approved the delete, printing only {decision}.
      const blind = await failed(cli(pasted, "--yes"));
      expect(blind.code).toBe(3);
      const shown = JSON.parse(blind.stdout) as { renderDigest: string; contract: unknown; next: string };
      // It decides nothing, and what it shows names the effect and its digest.
      expect(JSON.stringify(shown.contract)).toContain("ledger.txt");
      expect(shown.next).toContain(`--render ${shown.renderDigest}`);
      expect(server.store.getApprovalDecision(evil.approval!.approvalId)).toBeUndefined();

      // The script pins the digest it reviewed (the report write's): refused.
      const mismatch = await failed(cli(pasted, "--yes", "--render", reviewed.renderDigest));
      expect(mismatch.stderr).toContain("approval_render_mismatch");
      expect(server.store.getApprovalDecision(evil.approval!.approvalId)).toBeUndefined();
      await expect(server.controller.execute(evil.id)).rejects.toThrow("approval_awaiting_operator");
      expect(existsSync(join(root, "ledger.txt"))).toBe(true);

      // ---- Part 3: a prefix under 8 characters names nothing. OLD: 1 char approved.
      const short = await failed(cli(evil.id.slice(0, 1), "--yes", "--render", shown.renderDigest));
      expect(short.stderr).toContain("task_id_too_short");
      expect(server.store.getApprovalDecision(evil.approval!.approvalId)).toBeUndefined();

      // An operator who did review this contract pins its digest, and it binds.
      const run = await cli(pasted, "--yes", "--render", shown.renderDigest);
      const decision = (JSON.parse(run.stdout) as { decision: { taskId: string; renderDigest: string; channel: string } }).decision;
      expect(decision).toMatchObject({ taskId: evil.id, renderDigest: shown.renderDigest, channel: "out_of_band" });
      expect(await readFile(join(root, "ledger.txt"), "utf8")).toBe("precious\n"); // decided, not yet run
    } finally {
      await server.close();
    }
  });
});
