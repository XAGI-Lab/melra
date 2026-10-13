// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Every relative link in every Markdown file must point at something that
// exists, and every #anchor at a heading GitHub would generate. External
// http(s)/mailto links are out of scope: they need the network, and a check
// that fails because someone else's site is down is a check people ignore.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(".");

// Directories that are never documentation: dependencies, build output, and the
// gitignored run output (mirrors .gitignore). `.claude` holds agent worktrees,
// each a full copy of the repo.
const SKIP_NAMES = new Set([
  "node_modules", "dist", "coverage", ".git", ".venv", "__pycache__",
  ".pnpm-store", "tmp", ".melra", "artifacts", ".worktrees", ".claude",
]);
const SKIP_PATHS = new Set(["benchmarks/browser-agent/runs", "evals/results"]);

const toPosix = (path) => path.split(sep).join("/");

function* markdownFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_NAMES.has(entry.name) || SKIP_PATHS.has(toPosix(relative(root, full)))) continue;
      yield* markdownFiles(full);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield full;
    }
  }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const EXPLICIT_ANCHOR = /<a\s[^>]*?\b(?:id|name)\s*=\s*["']([^"']+)["']/gi;
const INLINE_LINK = /\]\(\s*(<[^>]*>|[^)\s]+)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;
const HTML_LINK = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;

/** Lines outside fenced code blocks, with inline code blanked out. */
function proseLines(text) {
  const lines = [];
  let fence = null;
  text.split(/\r?\n/).forEach((line, index) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length &&
          line.trim() === marker) fence = null;
      return;
    }
    if (marker) {
      fence = marker;
      return;
    }
    // `raw` keeps inline code, which still counts towards a heading's slug.
    const text = line.replace(/(`+)[^`][\s\S]*?\1/g, (m) => " ".repeat(m.length));
    lines.push({ number: index + 1, raw: line, text });
  });
  return lines;
}

/**
 * github-slugger: lowercase, drop everything but letters, marks, numbers,
 * connector punctuation (underscore), hyphens and spaces, then each space
 * becomes a hyphen. Applied to the heading's rendered text, so link targets,
 * HTML tags and backticks go first.
 */
function slug(heading) {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

const anchorCache = new Map();
function anchorsOf(file) {
  let anchors = anchorCache.get(file);
  if (anchors) return anchors;
  anchors = new Set();
  const occurrences = new Map();
  for (const { raw, text } of proseLines(readFileSync(file, "utf8"))) {
    for (const match of text.matchAll(EXPLICIT_ANCHOR)) anchors.add(match[1]);
    const heading = HEADING.exec(raw)?.[1];
    if (heading === undefined) continue;
    // Duplicates get -1, -2, ... and a suffixed slug can itself collide with a
    // later heading, counted exactly as github-slugger counts them.
    const base = slug(heading);
    let candidate = base;
    while (occurrences.has(candidate)) {
      occurrences.set(base, occurrences.get(base) + 1);
      candidate = `${base}-${occurrences.get(base)}`;
    }
    occurrences.set(candidate, 0);
    anchors.add(candidate);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

function targetsOf(line) {
  const targets = [];
  for (const match of line.matchAll(INLINE_LINK)) targets.push(match[1]);
  for (const match of line.matchAll(HTML_LINK)) targets.push(match[1]);
  const definition = REFERENCE_DEFINITION.exec(line);
  if (definition) targets.push(definition[1]);
  return targets.map((target) => target.replace(/^<|>$/g, ""));
}

const failures = [];
let checked = 0;

for (const file of markdownFiles(root)) {
  const name = toPosix(relative(root, file));
  for (const { number, text } of proseLines(readFileSync(file, "utf8"))) {
    for (const target of targetsOf(text)) {
      // Any scheme (http:, https:, mailto:, ...) or protocol-relative URL is external.
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      checked += 1;
      const hashAt = target.indexOf("#");
      const rawPath = (hashAt === -1 ? target : target.slice(0, hashAt)).split("?")[0];
      const fragment = hashAt === -1 ? "" : target.slice(hashAt + 1);
      let path;
      let anchor;
      try {
        path = decodeURIComponent(rawPath);
        anchor = decodeURIComponent(fragment);
      } catch {
        failures.push(`${name}:${number}: malformed link ${target}`);
        continue;
      }
      // GitHub resolves a leading slash against the repository root.
      const resolved = path === ""
        ? file
        : path.startsWith("/") ? join(root, path) : join(dirname(file), path);
      if (!existsSync(resolved)) {
        failures.push(`${name}:${number}: ${target} -> ${toPosix(relative(root, resolved))} does not exist`);
        continue;
      }
      // Fragments on non-Markdown targets (source line anchors like #L10) are GitHub's, not ours.
      if (anchor === "" || !statSync(resolved).isFile() || !resolved.endsWith(".md")) continue;
      if (!anchorsOf(resolved).has(anchor)) {
        failures.push(`${name}:${number}: ${target} -> no heading #${anchor} in ${toPosix(relative(root, resolved))}`);
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`All ${checked} relative links and anchors resolve.\n`);
}
