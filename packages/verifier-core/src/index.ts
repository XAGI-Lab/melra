// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { EvidencePredicate } from "@melra/protocol";
import { evidenceStrength, type EvidenceItem } from "@melra/receipt-schema";

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function readResultPath(
  result: Record<string, unknown>,
  path: string,
): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, result);
}

function wildcardMatches(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("\\*", ".*");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

export class Verifier {
  private constructor(readonly root: string) {}

  static async create(root: string): Promise<Verifier> {
    return new Verifier(await realpath(root));
  }

  private async filePath(input: string): Promise<string> {
    const candidate = resolve(this.root, input);
    if (!inside(this.root, candidate) || candidate === this.root) {
      throw new Error("verification_path_outside_workspace");
    }
    const actual = await realpath(candidate);
    if (!inside(this.root, actual)) {
      throw new Error("verification_path_outside_workspace");
    }
    return actual;
  }

  private async potentiallyAbsentFilePath(input: string): Promise<string> {
    const candidate = resolve(this.root, input);
    if (!inside(this.root, candidate) || candidate === this.root) {
      throw new Error("verification_path_outside_workspace");
    }
    let probe = candidate;
    while (true) {
      try {
        const actual = await realpath(probe);
        if (!inside(this.root, actual)) {
          throw new Error("verification_path_outside_workspace");
        }
        return candidate;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "verification_path_outside_workspace"
        ) {
          throw error;
        }
        const parent = dirname(probe);
        if (parent === probe) {
          throw new Error("verification_path_outside_workspace");
        }
        probe = parent;
      }
    }
  }

  async verify(
    predicates: EvidencePredicate[],
    result: Record<string, unknown>,
  ): Promise<{ verified: boolean; evidence: EvidenceItem[] }> {
    const evidence: EvidenceItem[] = [];
    for (const predicate of predicates) {
      try {
        switch (predicate.type) {
          case "result_equals": {
            const observed = readResultPath(result, predicate.path);
            const passed = Object.is(observed, predicate.value);
            evidence.push({
              type: predicate.type,
              passed,
              summary: `${predicate.path} ${passed ? "matched" : "did not match"} expected value`,
            });
            break;
          }
          case "result_contains": {
            const observed = readResultPath(result, predicate.path);
            const passed =
              typeof observed === "string" && observed.includes(predicate.value);
            evidence.push({
              type: predicate.type,
              passed,
              summary: `${predicate.path} ${passed ? "contained" : "did not contain"} expected text`,
            });
            break;
          }
          case "exit_code": {
            const passed = result.exitCode === predicate.value;
            evidence.push({
              type: predicate.type,
              passed,
              summary: `exit code ${passed ? "matched" : "did not match"} ${predicate.value}`,
            });
            break;
          }
          case "url_matches": {
            const observed = result.url;
            const passed =
              typeof observed === "string" &&
              wildcardMatches(observed, predicate.pattern);
            evidence.push({
              type: predicate.type,
              passed,
              summary: `final URL ${passed ? "matched" : "did not match"} expected pattern`,
            });
            break;
          }
          case "page_contains": {
            const observed = result.text;
            const passed =
              typeof observed === "string" && observed.includes(predicate.text);
            evidence.push({
              type: predicate.type,
              passed,
              summary: `page ${passed ? "contained" : "did not contain"} expected text`,
            });
            break;
          }
          case "file_exists": {
            const path = await this.filePath(predicate.path);
            const metadata = await stat(path);
            const passed = metadata.isFile() || metadata.isDirectory();
            evidence.push({
              type: predicate.type,
              passed,
              summary: `workspace path ${passed ? "exists" : "does not exist"}`,
              source: relative(this.root, path),
            });
            break;
          }
          case "file_absent": {
            const path = await this.potentiallyAbsentFilePath(predicate.path);
            let passed = false;
            try {
              await lstat(path);
            } catch (error) {
              passed =
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT";
              if (!passed) throw error;
            }
            evidence.push({
              type: predicate.type,
              passed,
              summary: `workspace path ${passed ? "is absent" : "still exists"}`,
              source: relative(this.root, path),
            });
            break;
          }
          case "file_hash": {
            const path = await this.filePath(predicate.path);
            const digest = createHash("sha256")
              .update(await readFile(path))
              .digest("hex");
            const passed = digest === predicate.sha256;
            evidence.push({
              type: predicate.type,
              passed,
              summary: `file hash ${passed ? "matched" : "did not match"}`,
              source: relative(this.root, path),
              digest,
            });
            break;
          }
        }
      } catch (error) {
        evidence.push({
          type: predicate.type,
          passed: false,
          summary: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      verified: evidence.every((item) => item.passed),
      // Stamped once here rather than at each branch above: strength is a
      // property of the predicate type, so deriving it in one place keeps a
      // new branch from quietly shipping without one.
      evidence: evidence.map((item) => ({
        ...item,
        strength: evidenceStrength(item.type),
      })),
    };
  }
}
