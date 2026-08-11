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

/**
 * A read the verifier can make through a channel it does not own.
 *
 * Injected rather than imported so this package keeps no adapter dependency:
 * whoever supplies the probe decides what a read costs and what it is allowed
 * to reach, and the verifier only decides whether the answer matches.
 */
export type EvidenceProbe = (request: {
  url: string;
  method: "GET" | "HEAD";
  timeoutMs: number;
}) => Promise<Record<string, unknown>>;

/**
 * A result with its JSON body parsed alongside the transport fields, so
 * `json.id` reads the payload and `status` reads the response. A body that is
 * not JSON simply has no `json`, and a path into it goes unresolved rather
 * than throwing here.
 */
function withParsedBody(
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof result.content !== "string") return result;
  try {
    return { ...result, json: JSON.parse(result.content) };
  } catch {
    return result;
  }
}

const TOKEN = /\{\{([A-Za-z0-9_.]{1,64})\}\}/gu;

/**
 * Splices values from the recorded result into a verification URL.
 *
 * The id of the thing to re-read is only known after the effect ran, so the
 * URL has to be completed from the result. Tokens are bounded to a dotted path
 * and each value is percent-encoded, so a response field carrying `../` or a
 * `?` cannot rewrite the path the operator wrote. An unresolved token fails the
 * predicate rather than producing a URL with a hole in it.
 */
function interpolate(template: string, result: Record<string, unknown>): string {
  const source = withParsedBody(result);
  return template.replace(TOKEN, (_match, path: string) => {
    const value = readResultPath(source, path);
    if (value === undefined || value === null || typeof value === "object") {
      throw new Error(`verification_token_unresolved:${path}`);
    }
    return encodeURIComponent(String(value));
  });
}

export interface VerifierOptions {
  /** Absent means `http_resource_matches` fails rather than passes. */
  probe?: EvidenceProbe;
}

export class Verifier {
  private constructor(
    readonly root: string,
    private readonly probe: EvidenceProbe | undefined,
  ) {}

  static async create(
    root: string,
    options: VerifierOptions = {},
  ): Promise<Verifier> {
    return new Verifier(await realpath(root), options.probe);
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
          case "http_resource_matches": {
            if (this.probe === undefined) {
              // Fails, never passes. A predicate the runtime cannot evaluate is
              // an unanswered question, and treating it as satisfied would make
              // the strongest evidence type the easiest one to claim.
              throw new Error("verification_probe_unavailable");
            }
            const url = interpolate(predicate.url, result);
            const observed = withParsedBody(
              await this.probe({
                url,
                method: predicate.method,
                timeoutMs: predicate.timeoutMs,
              }),
            );
            const value = readResultPath(observed, predicate.path);
            const passed = Object.is(value, predicate.value);
            evidence.push({
              type: predicate.type,
              passed,
              summary: `independent read of ${predicate.path} ${passed ? "matched" : "did not match"} expected value`,
              source: url,
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
