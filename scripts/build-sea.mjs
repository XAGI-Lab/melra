// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

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

// The CLI links node:sqlite statically, and esbuild hoists every external
// import of the single file above all of its code, so in the binary that
// import would link before bin.ts's own checks run, and a node:sqlite that is
// turned off would crash it at load instead of getting bin.ts's hint. Served
// from process.getBuiltinModule instead, the module is read inside the lazily
// initialised graph that bin.ts imports, after those checks.
const lazySqlite = {
  name: "lazy-node-sqlite",
  setup(context) {
    context.onResolve({ filter: /^node:sqlite$/ }, () => ({ path: "node:sqlite", namespace: "melra-lazy-sqlite" }));
    context.onLoad({ filter: /.*/, namespace: "melra-lazy-sqlite" }, () => ({
      contents: 'export const { DatabaseSync } = process.getBuiltinModule("node:sqlite");',
      loader: "js",
    }));
  },
};

// The binary is a single file, so it carries its license inside: LICENSE
// (AGPL-3.0-only), NOTICE, and the Apache-2.0 text NOTICE points to for the
// parts contributed under it, as one comment at the top of the script it runs.
const legal = await Promise.all(["LICENSE", "NOTICE", "LICENSES/Apache-2.0.txt"].map((file) => readFile(join(root, file), "utf8")));
if (legal.some((text) => text.includes("*/"))) throw new Error("a license text would end the comment that carries it");

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
  plugins: [inlinePlaywrightJson, lazySqlite],
  // The license comment, then what bundled CommonJS dependencies still reach for.
  banner: {
    js: `/*!\n${legal.join("\n")}*/\n` + [
      "import { createRequire as __melraRequire } from 'node:module';",
      "import { fileURLToPath as __melraPath } from 'node:url';",
      "import { dirname as __melraDir } from 'node:path';",
      "const require = __melraRequire(import.meta.url);",
      "const __filename = __melraPath(import.meta.url);",
      "const __dirname = __melraDir(__filename);",
    ].join(" "),
  },
});

// Fail the build rather than ship a binary that links node:sqlite at load.
if (/from\s*["']node:sqlite["']/.test(await readFile(bundle, "utf8"))) {
  throw new Error("node:sqlite is still imported at the top of the bundle");
}

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
