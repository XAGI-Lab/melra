// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { createMelraRuntime } from "@melra/server";
import { renderVerify } from "../src/audit.js";

const execute = promisify(execFile);
const entry = resolve(import.meta.dirname, "../dist/bin.js");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    // Windows holds the SQLite handle open briefly after the CLI exits.
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe("melra audit", () => {
  it("verifies the record chain, names what changed, and shows a removed tail against a kept head", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "melra-audit-")));
    roots.push(root);
    const dataDirectory = join(root, ".melra");
    const melra = await createMelraRuntime({
      workspaceRoot: root,
      dataDirectory,
      environment: {},
      // A host with no OS sandbox still starts.
      detectSandbox: async () => ({ sandbox: { backend: "test", confine: async ({ file, args }) => ({ file, args }) } }),
    });
    try {
      // Each leaves a receipt and a certificate.
      for (const goal of ["Inspect", "Inspect again"]) {
        const task = await melra.controller.plan(TaskRequestSchema.parse({ goal, operation: { kind: "system", action: "info" } }));
        expect((await melra.controller.execute(task.id)).task.status).toBe("verified_success");
      }
    } finally {
      await melra.close();
    }
    const env: NodeJS.ProcessEnv = { ...process.env, MELRA_HOME: dataDirectory, MELRA_WORKSPACE: root };
    delete env.MELRA_PAYLOAD_KEY;
    const audit = (...args: string[]) =>
      execute(process.execPath, [entry, "audit", ...args], { cwd: root, env }).catch((error: unknown) => error) as Promise<{
        code?: number;
        stdout: string;
        stderr: string;
      }>;

    const kept = JSON.parse((await audit("head")).stdout) as { sequence: number; link: string };
    expect(kept.sequence).toBe(4);
    const whole = await audit("verify", "--head", `${kept.sequence}:${kept.link}`);
    expect(whole.code).toBeUndefined();
    expect(JSON.parse(whole.stdout)).toEqual({ ok: true, head: kept, unsealed: 0, swept: 0 });

    // The second task's records and their links taken out with the triggers
    // dropped: a whole chain, except against the head kept before.
    const database = new DatabaseSync(join(dataDirectory, "melra.sqlite"));
    try {
      database.exec(`
        DROP TRIGGER receipts_no_delete; DROP TRIGGER certificates_no_delete; DROP TRIGGER record_chain_no_delete;
        DELETE FROM receipts WHERE json_array(id) IN (SELECT record_key FROM record_chain WHERE sequence > 2);
        DELETE FROM certificates WHERE json_array(id) IN (SELECT record_key FROM record_chain WHERE sequence > 2);
        DELETE FROM record_chain WHERE sequence > 2;
      `);
    } finally {
      database.close();
    }
    expect((await audit("verify")).code).toBeUndefined();
    const truncated = await audit("verify", "--head", `${kept.sequence}:${kept.link}`);
    expect(truncated.code).toBe(1);
    expect(JSON.parse(truncated.stdout).break).toEqual({ reason: "head_truncated", sequence: 4 });

    const tampered = new DatabaseSync(join(dataDirectory, "melra.sqlite"));
    try {
      tampered.exec(`DROP TRIGGER receipts_no_update; UPDATE receipts SET data = '{}'`);
    } finally {
      tampered.close();
    }
    const changed = await audit("verify");
    expect(changed.code).toBe(1);
    expect(JSON.parse(changed.stdout)).toMatchObject({ ok: false, break: { reason: "record_changed", sequence: 1 } });

    const malformed = await audit("verify", "--head", "4");
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain("--head takes <sequence>:<link>");
  });

  it("tells a person how many records a start sealed, and where the first sealed late is", () => {
    const head = { sequence: 10, link: "a".repeat(64) };
    const human = renderVerify(
      { ok: true, head, unsealed: 0, swept: 9, late: { count: 8, sequence: 3, table: "receipts", key: '["r3"]' } },
      undefined,
    );
    expect(human).toContain("10 records sealed and intact");
    expect(human).toContain("9 sealed at a start, not when written");
    expect(human).toContain('8 sealed late, the first at 3, receipts ["r3"]: written by an older MELRA');
    expect(renderVerify({ ok: true, head, unsealed: 0, swept: 0 }, undefined)).not.toContain("sealed at a start");
  });
});
