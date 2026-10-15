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

/**
 * What a verifier may use besides the predicate and the recorded result.
 *
 * Files are reachable only through `workspacePath`, which resolves through
 * `realpath` and refuses anything outside the workspace root, the root
 * included. The confinement lives here, in the kernel, so a verifier cannot
 * opt out of it by doing its own path handling.
 */
export interface VerificationContext {
  /** A confined, real path; `mayBeAbsent` for a file that should not exist. */
  workspacePath(input: string, options?: { mayBeAbsent?: boolean }): Promise<string>;
  /** `path` relative to the workspace root, for an item's `source`. */
  relative(path: string): string;
  /** Absent when the runtime has no independent channel. */
  probe?: EvidenceProbe;
}

/**
 * One way to confirm an effect. Returns what it found; `type` and `strength`
 * are stamped by the kernel from the predicate type, so a verifier cannot
 * claim a stronger kind of knowing than its type is entitled to. Throwing
 * fails the predicate.
 */
export interface PredicateVerifier<P extends { type: string } = { type: string }> {
  type: P["type"];
  check(
    predicate: P,
    result: Record<string, unknown>,
    context: VerificationContext,
  ): Promise<Omit<EvidenceItem, "type" | "strength">>;
}

/** Any verifier, whatever predicate it takes: the shape the registry holds. */
export interface RegisteredVerifier {
  readonly type: string;
  check(
    predicate: never,
    result: Record<string, unknown>,
    context: VerificationContext,
  ): Promise<Omit<EvidenceItem, "type" | "strength">>;
}

type Built<T extends EvidencePredicate["type"]> = PredicateVerifier<Extract<EvidencePredicate, { type: T }>>;

const resultEquals: Built<"result_equals"> = {
  type: "result_equals",
  async check(predicate, result) {
    const passed = Object.is(readResultPath(result, predicate.path), predicate.value);
    return { passed, summary: `${predicate.path} ${passed ? "matched" : "did not match"} expected value` };
  },
};

const resultContains: Built<"result_contains"> = {
  type: "result_contains",
  async check(predicate, result) {
    const observed = readResultPath(result, predicate.path);
    const passed = typeof observed === "string" && observed.includes(predicate.value);
    return { passed, summary: `${predicate.path} ${passed ? "contained" : "did not contain"} expected text` };
  },
};

const exitCode: Built<"exit_code"> = {
  type: "exit_code",
  async check(predicate, result) {
    const passed = result.exitCode === predicate.value;
    return { passed, summary: `exit code ${passed ? "matched" : "did not match"} ${predicate.value}` };
  },
};

const urlMatches: Built<"url_matches"> = {
  type: "url_matches",
  async check(predicate, result) {
    const observed = result.url;
    const passed = typeof observed === "string" && wildcardMatches(observed, predicate.pattern);
    return { passed, summary: `final URL ${passed ? "matched" : "did not match"} expected pattern` };
  },
};

const pageContains: Built<"page_contains"> = {
  type: "page_contains",
  async check(predicate, result) {
    const observed = result.text;
    const passed = typeof observed === "string" && observed.includes(predicate.text);
    return { passed, summary: `page ${passed ? "contained" : "did not contain"} expected text` };
  },
};

const fileExists: Built<"file_exists"> = {
  type: "file_exists",
  async check(predicate, _result, context) {
    const path = await context.workspacePath(predicate.path);
    const metadata = await stat(path);
    const passed = metadata.isFile() || metadata.isDirectory();
    return {
      passed,
      summary: `workspace path ${passed ? "exists" : "does not exist"}`,
      source: context.relative(path),
    };
  },
};

const fileAbsent: Built<"file_absent"> = {
  type: "file_absent",
  async check(predicate, _result, context) {
    const path = await context.workspacePath(predicate.path, { mayBeAbsent: true });
    let passed = false;
    try {
      await lstat(path);
    } catch (error) {
      passed = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!passed) throw error;
    }
    return {
      passed,
      summary: `workspace path ${passed ? "is absent" : "still exists"}`,
      source: context.relative(path),
    };
  },
};

const fileHash: Built<"file_hash"> = {
  type: "file_hash",
  async check(predicate, _result, context) {
    const path = await context.workspacePath(predicate.path);
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    const passed = digest === predicate.sha256;
    return {
      passed,
      summary: `file hash ${passed ? "matched" : "did not match"}`,
      source: context.relative(path),
      digest,
    };
  },
};

const httpResourceMatches: Built<"http_resource_matches"> = {
  type: "http_resource_matches",
  async check(predicate, result, context) {
    if (context.probe === undefined) {
      // Fails, never passes. A predicate the runtime cannot evaluate is an
      // unanswered question, and treating it as satisfied would make the
      // strongest evidence type the easiest one to claim.
      throw new Error("verification_probe_unavailable");
    }
    const url = interpolate(predicate.url, result);
    // Caught here rather than by the caller so a transport failure is not
    // filed as the provider saying no. Both are `passed: false`; only this one
    // is `inconclusive`, and that is what lets an unreachable provider leave a
    // mutation `recovery_required` instead of `failed`. The interpolate above
    // stays outside: an unresolved token is a caller error, and the provider
    // is not implicated in it.
    let observed: Record<string, unknown>;
    try {
      observed = withParsedBody(
        await context.probe({ url, method: predicate.method, timeoutMs: predicate.timeoutMs }),
      );
    } catch (error) {
      return {
        passed: false,
        inconclusive: true,
        summary: `independent read unavailable: ${error instanceof Error ? error.message : String(error)}`,
        source: url,
      };
    }
    const passed = Object.is(readResultPath(observed, predicate.path), predicate.value);
    // A provider that answered 503 or 429 did not say no; it did not answer.
    // Only a success or "not found" is its word on the resource, so a miss on
    // any other status is as inconclusive as a dropped connection. Read as a
    // denial, a degraded provider turned a charge that went through into
    // `failed`, and the caller charged again.
    const status = observed.status;
    if (!passed && typeof status === "number" && !(status >= 200 && status < 300) && status !== 404 && status !== 410) {
      return {
        passed: false,
        inconclusive: true,
        summary: `independent read unavailable: the provider answered ${status}`,
        source: url,
      };
    }
    return {
      passed,
      summary: `independent read of ${predicate.path} ${passed ? "matched" : "did not match"} expected value`,
      source: url,
    };
  },
};

const BUILT_IN: ReadonlyArray<RegisteredVerifier> = [
  resultEquals,
  resultContains,
  exitCode,
  urlMatches,
  pageContains,
  fileExists,
  fileAbsent,
  fileHash,
  httpResourceMatches,
];
const BUILT_IN_TYPES: ReadonlySet<string> = new Set(BUILT_IN.map((verifier) => verifier.type));


export interface VerifierOptions {
  /** Absent means `http_resource_matches` fails rather than passes. */
  probe?: EvidenceProbe;
  /**
   * Verifiers for predicate types the kernel does not ship. A built-in type
   * cannot be replaced: what `file_hash` means is not an embedder's to change.
   */
  verifiers?: ReadonlyArray<RegisteredVerifier>;
}

export class Verifier {
  private readonly verifiers = new Map<string, RegisteredVerifier>();

  private constructor(
    readonly root: string,
    private readonly probe: EvidenceProbe | undefined,
    extra: ReadonlyArray<RegisteredVerifier>,
  ) {
    for (const verifier of BUILT_IN) this.verifiers.set(verifier.type, verifier);
    for (const verifier of extra) {
      // `custom` is the request-side wrapper, not a type a verifier can own.
      if (this.verifiers.has(verifier.type) || verifier.type === "custom") {
        throw new Error(`verifier_type_taken:${verifier.type}`);
      }
      // The name a `custom` predicate in a request must be able to carry.
      if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(verifier.type)) {
        throw new Error(`verifier_name_invalid:${verifier.type}`);
      }
      this.verifiers.set(verifier.type, verifier);
    }
  }

  /** Names of the registered verifiers the kernel does not ship. */
  customVerifiers(): string[] {
    return [...this.verifiers.keys()].filter((type) => !BUILT_IN_TYPES.has(type));
  }

  /** Whether a verifier is registered for this predicate; planning asks first. */
  supports(predicate: EvidencePredicate | { type: string; [field: string]: unknown }): boolean {
    return this.resolve(predicate).verifier !== undefined;
  }

  /**
   * The verifier for a predicate, the evidence type to stamp, and what `check`
   * receives. A request's `{ type: "custom", verifier, params }` reaches only a
   * registered custom verifier, never a built-in: a built-in's fields are
   * validated by its own schema arm, and `custom` must not be a way round it.
   */
  private resolve(predicate: EvidencePredicate | { type: string; [field: string]: unknown }): {
    verifier: RegisteredVerifier | undefined;
    type: string;
    input: unknown;
  } {
    if (predicate.type !== "custom") {
      return { verifier: this.verifiers.get(predicate.type), type: predicate.type, input: predicate };
    }
    const name = String((predicate as { verifier?: unknown }).verifier);
    const params = (predicate as { params?: Record<string, unknown> }).params ?? {};
    return {
      verifier: BUILT_IN_TYPES.has(name) ? undefined : this.verifiers.get(name),
      type: `custom:${name}`,
      input: { ...params, type: name },
    };
  }

  static async create(
    root: string,
    options: VerifierOptions = {},
  ): Promise<Verifier> {
    return new Verifier(await realpath(root), options.probe, options.verifiers ?? []);
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
    // A built-in predicate, or one a registered verifier understands.
    predicates: ReadonlyArray<EvidencePredicate | { type: string; [field: string]: unknown }>,
    result: Record<string, unknown>,
  ): Promise<{ verified: boolean; evidence: EvidenceItem[] }> {
    const context: VerificationContext = {
      workspacePath: (input, options) =>
        options?.mayBeAbsent === true ? this.potentiallyAbsentFilePath(input) : this.filePath(input),
      relative: (path) => relative(this.root, path),
      ...(this.probe === undefined ? {} : { probe: this.probe }),
    };
    const evidence: EvidenceItem[] = [];
    for (const predicate of predicates) {
      const { verifier, type, input } = this.resolve(predicate);
      try {
        // An unregistered type is a question nobody here can answer: it fails.
        if (verifier === undefined) throw new Error(`verification_unsupported:${type}`);
        const found = await verifier.check(input as never, result, context);
        evidence.push({ ...found, type });
      } catch (error) {
        evidence.push({
          type,
          passed: false,
          summary: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      verified: evidence.every((item) => item.passed),
      // Stamped once here, after every verifier has run, and over whatever a
      // verifier returned: strength is a property of the predicate type, so an
      // unrecognised type reads as the weakest claim and no verifier can raise
      // its own.
      evidence: evidence.map((item) => ({
        ...item,
        strength: evidenceStrength(item.type),
      })),
    };
  }
}
