// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Typechecks every ```ts block in every package README against the built
// `dist`, so a published example cannot claim an API that does not exist.
//
// Each block becomes one ES module: `import` lines stay at the top, the rest is
// wrapped in an async function so `await` in a snippet compiles. Names a
// snippet leaves to the reader (`workspaceRoot`, `store`, a client built in an
// earlier block) are declared `any` unless the block declares them itself.

import { execFileSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const READER_SUPPLIED = [
  "workspaceRoot",
  "dataDirectory",
  "maxFileBytes",
  "taskId",
  "request",
  "store",
  "definition",
  "approvals",
  "melra",
  "MelraClient",
  "output",
  "artifactDirectory",
];

const readmes = globSync("{apps,packages}/*/README.md", { cwd: root }).sort();
const snippets = [];

for (const readme of readmes) {
  // `.gitattributes` normalizes checkouts to LF, but a clone made before it
  // existed still has CRLF, and a fence there would silently go unchecked.
  const text = readFileSync(join(root, readme), "utf8").replaceAll("\r\n", "\n");
  let index = 0;
  for (const [, body] of text.matchAll(/```ts\n([\s\S]*?)```/g)) {
    snippets.push({ readme, index: index++, body });
  }
}

if (snippets.length === 0) {
  // Which half failed matters: zero READMEs is a glob problem, READMEs with no
  // fences is a parsing problem. The old message guessed, and guessed wrong.
  console.error(`no \`\`\`ts blocks found in ${readmes.length} README files`);
  process.exit(1);
}

const directory = mkdtempSync(join(tmpdir(), "melra-readme-"));
try {
  writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));

  const files = snippets.map(({ readme, index, body }) => {
    const lines = body.split("\n");
    const imports = lines.filter((line) => line.startsWith("import "));
    const rest = lines.filter((line) => !line.startsWith("import "));
    const ambient = READER_SUPPLIED.filter(
      (name) =>
        new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(body) === false &&
        imports.some((line) => new RegExp(`\\b${name}\\b`).test(line)) === false,
    ).map((name) => `declare const ${name}: any;`);

    const name = `${readme.replace(/[^a-z0-9]+/gi, "-")}-${index}.ts`;
    writeFileSync(
      join(directory, name),
      [
        ...imports,
        ...ambient,
        "export async function readmeExample(): Promise<void> {",
        ...rest,
        "}",
      ].join("\n"),
    );
    return name;
  });

  const paths = Object.fromEntries(
    readmes.map((readme) => {
      const packageDirectory = dirname(readme);
      const manifest = JSON.parse(
        readFileSync(join(root, packageDirectory, "package.json"), "utf8"),
      );
      return [manifest.name, [join(root, packageDirectory, "dist", "index.d.ts")]];
    }),
  );

  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2023",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node"],
        // Compilation happens from a temp directory, so both `@types` and the
        // workspace packages have to be pointed at explicitly rather than
        // found by walking upwards.
        typeRoots: [join(root, "node_modules", "@types")],
        paths,
      },
      files,
    }),
  );

  execFileSync(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", directory],
    { stdio: "inherit", cwd: root },
  );
  console.log(`README examples typecheck (${snippets.length} blocks)`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
