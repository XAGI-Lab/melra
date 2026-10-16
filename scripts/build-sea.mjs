// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Builds `melra` as a single executable with Node inside (#76): one file that
// runs where Node is not installed. Bundles the built CLI with esbuild, then
// wraps it with Node's own `--build-sea`, so the binary carries the Node that
// runs this script. Experimental: unsigned beyond an ad-hoc macOS signature.
// Releases attach the build for each platform (single-executable.yml).
//
//   pnpm build:sea            -> dist-sea/melra (melra.exe on Windows)

import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-sea");
const bundle = join(out, "melra.mjs");
const binary = join(out, process.platform === "win32" ? "melra.exe" : "melra");

const [major] = process.versions.node.split(".").map(Number);
if (major < 25) {
  throw new Error(`build-sea needs Node 25+ for --build-sea with an ES module main; this is ${process.version}`);
}

// playwright-core reads two JSON files from its own folder when it loads. A
// single executable has no folder around it, so they are inlined at bundle
// time; nothing else it ships is read from disk on MELRA's paths.
const inlinePlaywrightJson = {
  name: "inline-playwright-json",
  setup(context) {
    context.onLoad({ filter: /playwright-core[\\/]lib[\\/]coreBundle\.js$/ }, async (args) => {
      const packageRoot = join(dirname(args.path), "..");
      let text = await readFile(args.path, "utf8");
      for (const file of ["package.json", "browsers.json"]) {
        const pattern = new RegExp(
          `require\\(([\\w$]+)\\.default\\.join\\(packageRoot, "${file.replace(".", "\\.")}"\\)\\)`,
        );
        // Fail the build rather than ship a binary that crashes on start.
        if (!pattern.test(text)) throw new Error(`playwright-core no longer reads ${file} this way`);
        text = text.replace(pattern, `(${(await readFile(join(packageRoot, file), "utf8")).trim()})`);
      }
      return { contents: text, loader: "js" };
    });
  },
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [join(root, "apps/cli/dist/bin.js")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "error",
  // WebDriver BiDi, which MELRA does not use: it drives Chrome over CDP.
  external: ["chromium-bidi", "chromium-bidi/*", "electron"],
  plugins: [inlinePlaywrightJson],
  // Bundled CommonJS dependencies still reach for these.
  banner: {
    js: [
      "import { createRequire as __melraRequire } from 'node:module';",
      "import { fileURLToPath as __melraPath } from 'node:url';",
      "import { dirname as __melraDir } from 'node:path';",
      "const require = __melraRequire(import.meta.url);",
      "const __filename = __melraPath(import.meta.url);",
      "const __dirname = __melraDir(__filename);",
    ].join(" "),
  },
});

const config = join(out, "sea.json");
await writeFile(
  config,
  JSON.stringify({
    main: bundle,
    mainFormat: "module",
    output: binary,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
  }),
);
execFileSync(process.execPath, ["--build-sea", config], { stdio: "inherit" });
// Apple Silicon kills an unsigned binary on launch; an ad-hoc signature is the
// least that runs. Distribution still needs a real identity and notarization.
if (process.platform === "darwin") {
  execFileSync("codesign", ["--sign", "-", "--force", binary], { stdio: "inherit" });
}
await rm(config);
process.stdout.write(`${binary}\n`);
