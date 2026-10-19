// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Prints the channel package.json's version releases under: the npm dist-tag
// it publishes with and the container tag it moves. alpha, beta or rc for that
// prerelease, latest for a version with none. Any other prerelease id fails
// rather than landing on latest. The release and its dry run both ask here.

import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const match = /^\d+\.\d+\.\d+(?:-(alpha|beta|rc)\.\d+)?$/.exec(version);
if (match === null) {
  process.stderr.write(`package.json is ${version}; a release is x.y.z or x.y.z-alpha.n, -beta.n or -rc.n\n`);
  process.exit(1);
}
process.stdout.write(`${match[1] ?? "latest"}\n`);
