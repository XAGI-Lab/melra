// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Prints "<dir> <name>" for every public workspace package, each after the
// @melra/* packages it depends on, packages/* before apps/*, each directory
// visited in name order. The release publishes in this order, so a run that
// stops partway leaves nothing on the registry whose dependencies are not
// there. npm publishes whatever it is handed, and the glob this replaces
// listed apps/cli first.

import { existsSync, readdirSync, readFileSync } from "node:fs";

const workspace = new Map();
for (const root of ["packages", "apps"]) {
  for (const entry of readdirSync(root).sort()) {
    const dir = `${root}/${entry}`;
    if (!existsSync(`${dir}/package.json`)) continue;
    const manifest = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
    workspace.set(manifest.name, { dir, manifest });
  }
}

// The whole order is worked out before any of it is printed, so a cycle (pnpm
// does not warn about one through peerDependencies) stops the release with
// nothing listed, and so nothing published, rather than partway through.
const order = [];
const done = new Set();
const visiting = [];
const visit = (name) => {
  if (done.has(name)) return;
  if (visiting.includes(name)) {
    process.stderr.write(`dependency cycle: ${[...visiting.slice(visiting.indexOf(name)), name].join(" -> ")}\n`);
    process.exit(1);
  }
  visiting.push(name);
  const { dir, manifest } = workspace.get(name);
  const { dependencies, optionalDependencies, peerDependencies } = manifest;
  for (const dependency of Object.keys({ ...dependencies, ...optionalDependencies, ...peerDependencies }).sort()) {
    if (workspace.has(dependency)) visit(dependency);
  }
  visiting.pop();
  done.add(name);
  if (!manifest.private) order.push(`${dir} ${name}\n`);
};
for (const name of workspace.keys()) visit(name);
process.stdout.write(order.join(""));
