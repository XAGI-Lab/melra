// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// The record chain (migration 9): each tamper an outsider can make to the
// file is found, and two processes writing one home keep one chain.

import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCertificate, sha256, type ActionReceipt } from "@melra/receipt-schema";
import { SqliteStore } from "./index.js";

const stores: SqliteStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const KEY = randomBytes(32);
const taskId = "00000000-0000-4000-8000-000000000001";
const at = "2026-10-01T00:00:00.000Z";

function newHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "melra-record-chain-"));
  directories.push(directory);
  return join(directory, "melra.sqlite");
}

function open(path: string, options: { readOnly?: boolean } = {}): SqliteStore {
  const store = new SqliteStore(path, options);
  stores.push(store);
  return store;
}

const receipt = (id: string) => ({ receiptId: id, taskId, endedAt: at }) as ActionReceipt;
const receiptId = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

/** A sealing store holding three receipts, a certificate, its replacement and each other kind of record. */
function sealedHome(): { path: string; store: SqliteStore } {
  const path = newHome();
  const store = open(path);
  store.sealRecords(KEY);
  for (const n of [1, 2, 3]) store.saveReceipt(receipt(receiptId(n)));
  const issue = (result: "PARTIAL" | "VERIFIED_SUCCESS") =>
    createCertificate({ taskId, goal: "Inspect", result, policyVersion: "1", receiptIds: [], evidence: [], createdAt: at });
  store.saveCertificate(issue("PARTIAL"));
  store.saveCertificate(issue("VERIFIED_SUCCESS"));
  store.commitIdempotency("k".repeat(64), taskId, 1, at);
  store.recordCapabilityUse("grant", taskId, 1, at);
  store.recordApprovalDecision({
    approvalId: "a",
    taskId,
    renderDigest: "b".repeat(64),
    channel: "out_of_band",
    approver: "cli:operator",
    decidedAt: at,
  });
  store.recordApprovalDenial({
    approvalId: "d",
    taskId,
    renderDigest: "b".repeat(64),
    operationDigest: "c".repeat(64),
    channel: "out_of_band",
    approver: "cli:operator",
    reason: "never",
    decidedAt: at,
  });
  store.recordRefusal({ kind: "task", subjectId: taskId, code: "approval_in_band_refused", mode: "enforced", refusedAt: at });
  return { path, store };
}

const RECORDS = 10;
const link = (key: Buffer, previous: string, digest: string, swept: number) =>
  createHmac("sha256", key).update(`${previous}\0${digest}\0${swept}`).digest("hex");
const chainRow = (store: SqliteStore, sequence: number) =>
  store.database.prepare("SELECT * FROM record_chain WHERE sequence = ?").get(sequence) as {
    record_table: string;
    previous_link: string;
    link: string;
  };

describe("the record chain", () => {
  it("seals every record in the transaction that writes it, a replaced certificate included", () => {
    const { store } = sealedHome();
    const report = store.verifyChain(KEY);
    expect(report).toEqual({ ok: true, head: store.chainHead(), unsealed: 0, swept: 0 });
    // Both certificates: the one replaced is sealed where it now lives.
    expect(report.head.sequence).toBe(RECORDS);
    expect(store.database.prepare("SELECT count(*) AS n FROM certificate_history").get()).toEqual({ n: 1 });
    // A write that rolls back leaves no link behind.
    expect(() => store.transaction(() => {
      store.saveReceipt(receipt(receiptId(4)));
      throw new Error("rolled_back");
    })).toThrow("rolled_back");
    expect(store.chainHead()).toEqual(report.head);
    // A repeat under a key it holds is ignored, and seals nothing new.
    store.commitIdempotency("k".repeat(64), taskId, 2, at);
    expect(store.chainHead()).toEqual(report.head);
  });

  it("is append-only itself", () => {
    const { store } = sealedHome();
    for (const write of [
      "UPDATE record_chain SET link = 'x'",
      "DELETE FROM record_chain",
      "INSERT OR REPLACE INTO record_chain SELECT * FROM record_chain WHERE sequence = 1",
      "INSERT OR REPLACE INTO record_chain SELECT 99, record_table, record_key, record_digest, previous_link, link, swept FROM record_chain WHERE sequence = 1",
    ]) {
      expect(() => store.database.exec(write), write).toThrow("record_append_only");
    }
  });

  it("finds a record changed with the triggers dropped", () => {
    const { store } = sealedHome();
    store.database.exec(`DROP TRIGGER receipts_no_update; UPDATE receipts SET data = '{"x":1}' WHERE id = '${receiptId(2)}'`);
    expect(store.verifyChain(KEY)).toMatchObject({
      ok: false,
      break: { reason: "record_changed", sequence: 2, table: "receipts", key: JSON.stringify([receiptId(2)]) },
    });
  });

  it("finds a certificate updated in place under its own id, which the triggers allow", () => {
    const { store } = sealedHome();
    store.database.exec(`UPDATE certificates SET data = '{"result":"VERIFIED_SUCCESS"}' WHERE task_id = '${taskId}'`);
    expect(store.verifyChain(KEY).break).toMatchObject({ reason: "record_changed", table: "certificates" });
  });

  it("finds a record removed, and a link removed with it", () => {
    const removed = sealedHome().store;
    removed.database.exec(`DROP TRIGGER receipts_no_delete; DELETE FROM receipts WHERE id = '${receiptId(2)}'`);
    expect(removed.verifyChain(KEY).break).toEqual({
      reason: "record_removed",
      sequence: 2,
      table: "receipts",
      key: JSON.stringify([receiptId(2)]),
    });
    const both = sealedHome().store;
    both.database.exec(`
      DROP TRIGGER receipts_no_delete; DROP TRIGGER record_chain_no_delete;
      DELETE FROM receipts WHERE id = '${receiptId(2)}'; DELETE FROM record_chain WHERE sequence = 2;
    `);
    expect(both.verifyChain(KEY).break).toEqual({ reason: "sequence_gap", sequence: 2 });
  });

  it("finds a row inserted beside the chain, and one inserted with a link made without the key", () => {
    const { store } = sealedHome();
    // The triggers allow an insert; it is not sealed.
    store.database.exec(`INSERT INTO receipts VALUES ('forged', '${taskId}', '{}', 'at')`);
    expect(store.verifyChain(KEY)).toMatchObject({
      ok: false,
      unsealed: 1,
      break: { reason: "unsealed_rows", table: "receipts", key: '["forged"]' },
    });
    // Given a link too, under a key that is not this home's.
    const head = store.chainHead();
    const digest = sha256(["receipts", { id: "forged", task_id: taskId, data: "{}", created_at: "at" }]);
    store.database
      .prepare("INSERT INTO record_chain VALUES (?, 'receipts', '[\"forged\"]', ?, ?, ?, 0)")
      .run(head.sequence + 1, digest, head.link, link(randomBytes(32), head.link, digest, 0));
    expect(store.verifyChain(KEY).break).toMatchObject({ reason: "link_forged", sequence: RECORDS + 1 });
  });

  it("finds a record rewritten with its digest and its link remade without the key", () => {
    const { store } = sealedHome();
    const row = chainRow(store, 2);
    const digest = sha256(["receipts", { id: receiptId(2), task_id: taskId, data: '{"x":1}', created_at: at }]);
    store.database.exec("DROP TRIGGER receipts_no_update; DROP TRIGGER record_chain_no_update");
    store.database.prepare("UPDATE receipts SET data = '{\"x\":1}' WHERE id = ?").run(receiptId(2));
    store.database
      .prepare("UPDATE record_chain SET record_digest = ?, link = ? WHERE sequence = 2")
      .run(digest, link(randomBytes(32), row.previous_link, digest, 0));
    expect(store.verifyChain(KEY).break).toMatchObject({ reason: "link_forged", sequence: 2 });
  });

  it("shows a removed tail only against a head kept from before", () => {
    const { store } = sealedHome();
    const kept = store.chainHead();
    const earlier = { sequence: 3, link: chainRow(store, 3).link };
    // The last record written, and its link.
    expect(chainRow(store, RECORDS).record_table).toBe("refusals");
    store.database.exec(`
      DROP TRIGGER refusals_no_delete; DROP TRIGGER record_chain_no_delete;
      DELETE FROM refusals; DELETE FROM record_chain WHERE sequence = ${RECORDS};
    `);
    // Without the head the shorter chain is whole.
    expect(store.verifyChain(KEY)).toMatchObject({ ok: true, head: { sequence: RECORDS - 1 } });
    expect(store.verifyChain(KEY, earlier).ok).toBe(true);
    expect(store.verifyChain(KEY, kept)).toMatchObject({ ok: false, break: { reason: "head_truncated", sequence: RECORDS } });
  });

  it("marks records sealed again after their links were removed, and shows it against a head kept from before", () => {
    const { path, store } = sealedHome();
    const kept = store.chainHead();
    // Anyone who can write the file, with no key, rewrites a receipt and
    // removes its link and every later one. The next start seals what is
    // left again, as it now is, as it seals what an older MELRA wrote.
    store.database.exec(`
      DROP TRIGGER receipts_no_update; DROP TRIGGER record_chain_no_delete;
      UPDATE receipts SET data = '{"x":1}' WHERE id = '${receiptId(2)}';
      DELETE FROM record_chain WHERE sequence >= 2;
    `);
    expect(store.verifyChain(KEY).break).toMatchObject({ reason: "unsealed_rows" });
    expect(open(path).sealRecords(KEY)).toBe(RECORDS - 1);
    expect(store.verifyChain(KEY)).toEqual({
      ok: true,
      head: store.chainHead(),
      unsealed: 0,
      swept: RECORDS - 1,
      // Swept after a link made at write time, which a home first sealed when
      // migrated never leaves.
      late: { count: RECORDS - 1, sequence: 2, table: "receipts", key: JSON.stringify([receiptId(2)]) },
    });
    expect(store.verifyChain(KEY, kept).break).toEqual({ reason: "head_mismatch", sequence: RECORDS });
    // Nor can the mark be taken off without the key.
    store.database.exec("DROP TRIGGER record_chain_no_update; UPDATE record_chain SET swept = 0 WHERE sequence = 2");
    expect(store.verifyChain(KEY).break).toMatchObject({ reason: "link_forged", sequence: 2 });
  });

  it("leaves a row planted under a key MELRA writes later for the sweep, which marks it", () => {
    const path = newHome();
    const store = open(path);
    store.sealRecords(KEY);
    store.saveReceipt(receipt(receiptId(1)));
    // The triggers allow an insert, so no key is needed to plant one.
    store.database.exec(
      `INSERT INTO approval_decisions VALUES ('ap', '${taskId}', '${"b".repeat(64)}', 'out_of_band', 'cli:attacker', '${at}')`,
    );
    expect(
      store.recordApprovalDecision({
        approvalId: "ap",
        taskId,
        renderDigest: "b".repeat(64),
        channel: "out_of_band",
        approver: "cli:operator",
        decidedAt: at,
      }),
    ).toBe(false);
    expect(store.verifyChain(KEY).break).toMatchObject({ reason: "unsealed_rows", table: "approval_decisions" });
    open(path).sealRecords(KEY);
    expect(store.verifyChain(KEY)).toMatchObject({
      ok: true,
      swept: 1,
      late: { count: 1, sequence: 2, table: "approval_decisions" },
    });
  });

  it("leaves a row a planted trigger stores in place of MELRA's for the sweep, which marks it", () => {
    const path = newHome();
    const store = open(path);
    store.sealRecords(KEY);
    store.saveReceipt(receipt(receiptId(1)));
    // No key needed, and no trigger of MELRA's dropped: the planted one stores
    // its own row under the key, so MELRA's insert is ignored.
    store.database.exec(`
      CREATE TRIGGER planted BEFORE INSERT ON approval_decisions BEGIN
        INSERT INTO approval_decisions VALUES (NEW.approval_id, NEW.task_id, NEW.render_digest, NEW.channel, 'cli:attacker', NEW.decided_at);
      END;
    `);
    store.recordApprovalDecision({
      approvalId: "ap",
      taskId,
      renderDigest: "b".repeat(64),
      channel: "out_of_band",
      approver: "cli:operator",
      decidedAt: at,
    });
    expect(store.verifyChain(KEY).break).toMatchObject({ reason: "unsealed_rows", table: "approval_decisions" });
    open(path).sealRecords(KEY);
    expect(store.verifyChain(KEY)).toMatchObject({ ok: true, swept: 1, late: { count: 1, table: "approval_decisions" } });
  });

  it("counts a whole chain sealed again after it was removed, and shows it against a head kept from before", () => {
    const { path, store } = sealedHome();
    const kept = store.chainHead();
    store.database.exec(`
      DROP TRIGGER receipts_no_update; DROP TRIGGER record_chain_no_delete;
      UPDATE receipts SET data = '{"x":1}' WHERE id = '${receiptId(1)}';
      DELETE FROM record_chain;
    `);
    open(path).sealRecords(KEY);
    // No link made at write time is left to come before them, so none is
    // late, as on a home first sealed when migrated; the count shows it.
    expect(store.verifyChain(KEY)).toEqual({ ok: true, head: store.chainHead(), unsealed: 0, swept: RECORDS });
    expect(store.verifyChain(KEY, kept).break).toEqual({ reason: "head_mismatch", sequence: RECORDS });
  });

  it("verifies from a read-only store, and refuses a key it was not made under", () => {
    const { path } = sealedHome();
    const observer = open(path, { readOnly: true });
    expect(observer.verifyChain(KEY, observer.chainHead()).ok).toBe(true);
    expect(observer.verifyChain(randomBytes(32)).break).toMatchObject({ reason: "link_forged", sequence: 1 });
  });

  it("seals what is already there when a version-8 home is migrated", () => {
    const path = newHome();
    const before = new SqliteStore(path);
    before.saveReceipt(receipt(receiptId(1)));
    before.recordRefusal({ kind: "task", subjectId: taskId, code: "approval_in_band_refused", mode: "enforced", refusedAt: at });
    // As migration 8 left it.
    before.database.exec(`
      DROP TABLE record_chain;
      DROP INDEX certificate_history_certificate;
      DELETE FROM schema_migrations WHERE version = 9;
    `);
    before.close();
    const observer = open(path, { readOnly: true });
    expect(observer.verifyChain(KEY)).toMatchObject({ ok: false, unsealed: 2, head: { sequence: 0 } });

    const store = open(path);
    expect(store.sealRecords(KEY)).toBe(2);
    // Swept, but before any link made at write time, so none is late.
    expect(store.verifyChain(KEY)).toEqual({ ok: true, head: store.chainHead(), unsealed: 0, swept: 2 });
    expect(store.chainHead().sequence).toBe(2);
  });

  it("stays one chain when two processes append to one home at once", async () => {
    const path = newHome();
    open(path).sealRecords(KEY);
    const writes = 150;
    await inTwoProcesses(
      path,
      `store.sealRecords(key);
       for (let n = 0; n < ${writes}; n += 1) {
         // A pause between writes, so the other process's wait for the lock
         // ends in one and the two take turns.
         await new Promise((resolve) => setTimeout(resolve, 1));
         store.saveReceipt({ receiptId: name + "-" + n, taskId: "t", endedAt: "at" });
       }`,
    );
    const store = open(path, { readOnly: true });
    expect(store.verifyChain(KEY)).toEqual({
      ok: true,
      head: { sequence: 2 * writes, link: store.chainHead().link },
      unsealed: 0,
      swept: 0,
    });
    // They did take turns: one writer's links sit between the other's.
    const writers = (store.database.prepare("SELECT record_key AS key FROM record_chain ORDER BY sequence").all() as Array<{ key: string }>)
      .map(({ key }) => key[2])
      .join("");
    expect(writers).toMatch(/ab+a|ba+b/);
  });

  it("stays one chain when two processes sweep one backlog at once", async () => {
    const path = newHome();
    // Written unsealed, as an older MELRA writes them, and enough that each
    // sweep takes several batches.
    const older = open(path);
    const backlog = 3000;
    older.transaction(() => {
      for (let n = 0; n < backlog; n += 1) older.saveReceipt(receipt(`backlog-${n}`));
    });
    await inTwoProcesses(path, "store.sealRecords(key);");
    const store = open(path, { readOnly: true });
    expect(store.verifyChain(KEY)).toEqual({
      ok: true,
      head: { sequence: backlog, link: store.chainHead().link },
      unsealed: 0,
      swept: backlog,
    });
  });
});

/**
 * Runs `script` in two processes at once, each with a `store` of its own on
 * `path`, this file's `key` and its `name`, once both have opened the store,
 * and expects both to exit 0.
 */
async function inTwoProcesses(path: string, script: string): Promise<void> {
  const module = new URL("../dist/index.js", import.meta.url).href;
  const children = ["a", "b"].map((name) =>
    spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { SqliteStore } = await import(${JSON.stringify(module)});
         const [path, hex, name] = process.argv.slice(1);
         const key = Buffer.from(hex, "hex");
         const store = new SqliteStore(path);
         process.stdout.write("ready\\n");
         process.stdin.once("data", async () => {
           ${script}
           store.close();
           process.stdin.destroy();
         });`,
        path,
        KEY.toString("hex"),
        name,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    ),
  );
  try {
    // Both ready before either starts, so what they do overlaps.
    await Promise.all(children.map((child) => once(child.stdout!, "data")));
    const exited = children.map((child) => once(child, "exit"));
    for (const child of children) child.stdin!.write("go\n");
    expect((await Promise.all(exited)).map(([code]) => code)).toEqual([0, 0]);
  } finally {
    for (const child of children) child.kill("SIGKILL");
  }
}
