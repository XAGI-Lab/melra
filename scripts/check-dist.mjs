// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Every package publishes `dist/`, so whatever the build leaves there ships to
// npm. Test files did, for 0.3.0-alpha.11: 164 of them, importing `vitest`,
// which none of those packages depends on. Run after a build.

import { glob } from "node:fs/promises";

const shipped = [];
for await (const path of glob("{apps,packages}/*/dist/**/*.test.*")) {
  shipped.push(path.replaceAll("\\", "/"));
}

if (shipped.length > 0) {
  process.stderr.write(
    `test files in build output, which would be published:\n${shipped.map((path) => `- ${path}`).join("\n")}\n` +
      "exclude them in that package's tsconfig.json (tests are checked by tsconfig.test.json),\n" +
      "or, if they are left over from an older build (tsc never deletes old output), run\n" +
      "`pnpm clean && pnpm build`\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write("No test files in any package's dist/.\n");
}
