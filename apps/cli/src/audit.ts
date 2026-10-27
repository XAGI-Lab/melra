// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// `melra audit verify` and `melra audit head`: the record chain. Both open the
// store read-only, as `melra tasks` does, so neither can stall a server or
// change what it checks, and neither creates a database or a key.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homeCipher, printable } from "@melra/server/kernel";
import { SqliteStore, type ChainBreak, type ChainHead, type ChainReport } from "@melra/storage-sqlite";
import type { CliEnvironment } from "./environment.js";
import { mark, paint, printJsonOrHuman } from "./output.js";

const MEANING: Record<ChainBreak, string> = {
  sequence_gap: "links are missing from the chain",
  link_forged: "a link was not made with this home's key",
  record_removed: "a sealed record is gone",
  record_changed: "a record no longer matches what was sealed",
  head_mismatch: "the chain no longer passes through the head you kept: it was rebuilt",
  head_truncated: "the chain ends before the head you kept: its tail was removed",
  unsealed_rows:
    "rows no link seals: an older MELRA's, or rows inserted or links removed outside MELRA; " +
    "check them before MELRA starts on this home, since a start seals them as they now are",
};

/** `<sequence>:<link>`, as `melra audit head` prints it in a terminal. */
export function parseHead(given: string): ChainHead {
  const match = /^(\d+):([0-9a-f]{64})$/.exec(given);
  if (match === null) throw new Error("--head takes <sequence>:<link>, as 'melra audit head' prints it");
  return { sequence: Number(match[1]), link: match[2]! };
}

// The table and key are read from the file, which whoever changed it wrote.
function where({ sequence, table, key }: { sequence?: number; table?: string; key?: string }): string {
  return [
    ...(sequence === undefined ? [] : [`at ${sequence}`]),
    ...(table === undefined ? [] : [printable(`${table} ${key ?? ""}`)]),
  ].join(", ");
}

export function renderVerify(report: ChainReport, kept: ChainHead | undefined): string {
  const head = `head ${report.head.sequence}:${report.head.link}`;
  const swept = [
    ...(report.swept === 0 ? [] : [paint.dim(`${report.swept} sealed at a start, not when written`)]),
    ...(report.late === undefined
      ? []
      : [
          `${mark("warn")} ${report.late.count} sealed late, the first ${where(report.late)}: written by an older ` +
            "MELRA beside this one or outside MELRA, or their links were removed and the records sealed again as " +
            "they then were; check them against a head kept from before",
        ]),
  ];
  if (report.break === undefined) {
    const through = kept === undefined ? "" : `, through the head kept at ${kept.sequence}`;
    return [`${mark("pass")} ${report.head.sequence} records sealed and intact${through}; ${head}`, ...swept].join("\n");
  }
  const at = where(report.break);
  return [
    `${mark("fail")} ${report.break.reason}${at === "" ? "" : ` (${at})`}: ${MEANING[report.break.reason]}`,
    ...swept,
    paint.dim(`${report.unsealed} unsealed; ${head}`),
  ].join("\n");
}

export async function auditCommand(
  env: CliEnvironment,
  options: { action: "verify" | "head"; args: readonly string[]; head?: ChainHead },
): Promise<number> {
  const path = join(env.dataDirectory, "melra.sqlite");
  if (!existsSync(path)) throw new Error(`audit_no_database: ${path} does not exist`);
  const store = new SqliteStore(path, { readOnly: true });
  try {
    if (options.action === "head") {
      printJsonOrHuman(store.chainHead(), (head) => `${head.sequence}:${head.link}`, options.args);
      return 0;
    }
    // The key every command loads, refused if it cannot open what is sealed
    // here, so a wrong key reads as that and not as a forged chain.
    const cipher = await homeCipher(store, env.dataDirectory, process.env, { mint: false });
    const report = store.verifyChain(cipher.chainKey(), options.head);
    printJsonOrHuman(report, (value) => renderVerify(value, options.head), options.args);
    return report.ok ? 0 : 1;
  } finally {
    store.close();
  }
}
