#!/usr/bin/env node
// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// The `melra` executable. Its only job is to silence one Node warning before
// the rest of the CLI loads, then hand over to `index.ts`.
//
// `node:sqlite` emits an ExperimentalWarning the first time it is linked, which
// meant two lines of Node noise on every invocation — `melra help` and
// `melra version` included — about a dependency the user did not choose and
// cannot change. Under an MCP client the same lines land in the server log,
// where they read like a fault.
//
// It has to happen here rather than as the first import of `index.ts`: static
// imports are linked before any module body runs, so a patch applied in a
// sibling module is already too late. Loading the CLI with a dynamic import is
// what puts the whole graph, `node:sqlite` included, after this file's body.
//
// Only that one warning is dropped. Deprecations and everything else still
// print, because those are warnings a user can act on.

const SQLITE_EXPERIMENTAL = /SQLite is an experimental feature/;
const emitWarning = process.emitWarning.bind(process);

// Node's overloads disagree on the tail arguments, so accept and forward them.
process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (SQLITE_EXPERIMENTAL.test(text)) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

// The CLI links `node:sqlite` statically, and a release where it needs a flag
// (before 22.13, or 23.0 to 23.3), or a supported one where it was turned off
// or left out of the build, would otherwise end every command, `doctor`
// included, at load with a bare ERR_UNKNOWN_BUILTIN_MODULE. `getBuiltinModule`
// asks without linking anything; it is itself missing before 20.16 and, on
// the 22 line, before 22.3, where `node:sqlite` is too.
if (process.getBuiltinModule?.("node:sqlite") === undefined) {
  const { sqliteUnavailable } = await import("./node-support.js");
  process.stderr.write(`${sqliteUnavailable(process.versions.node)}\n`);
  process.exit(1);
}

await import("./index.js");
