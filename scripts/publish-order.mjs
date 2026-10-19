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

// ponytail: a dependency cycle recurses until the stack overflows, which fails
// the release step; pnpm already warns about one long before a release.
const listed = new Set();
const visit = (name) => {
  if (listed.has(name)) return;
  const { dir, manifest } = workspace.get(name);
  const { dependencies, optionalDependencies, peerDependencies } = manifest;
  for (const dependency of Object.keys({ ...dependencies, ...optionalDependencies, ...peerDependencies }).sort()) {
    if (workspace.has(dependency)) visit(dependency);
  }
  listed.add(name);
  if (!manifest.private) console.log(`${dir} ${name}`);
};
for (const name of workspace.keys()) visit(name);
