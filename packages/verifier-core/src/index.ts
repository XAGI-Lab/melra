// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createReadStream, type BigIntStats } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EvidencePredicate } from "@melra/protocol";
import { evidenceStrength, redactStructuredValue, type EvidenceItem } from "@melra/receipt-schema";

/**
 * A question the kernel itself refuses to ask: a path outside the workspace or
 * reserved, a URL token with nothing to fill it, a verifier or probe this
 * runtime does not have. Asked again of the same result it is refused again,
 * so `verify` marks the item `unanswerable`. Not exported, so a verifier
 * cannot make one of its own failures read as the kernel's.
 */
class Refusal extends Error {}

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
  signal?: AbortSignal | undefined;
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
 * `?` cannot rewrite the path the operator wrote. An unresolved or empty token
 * fails the predicate rather than producing a URL with a hole in it.
 */
function interpolate(template: string, result: Record<string, unknown>): string {
  const source = withParsedBody(result);
  return template.replace(TOKEN, (_match, path: string) => {
    const value = readResultPath(source, path);
    if (value === undefined || value === null || typeof value === "object") {
      throw new Refusal(`verification_token_unresolved:${path}`);
    }
    // `.` and `..` survive percent-encoding as path segments (a URL parser
    // reads `%2E%2E` as `..` too), so `{"id": ".."}` moved the probe up a
    // level onto some other resource and verified that.
    if (value === "." || value === "..") throw new Refusal(`verification_token_dot_segment:${path}`);
    // An empty value splices nothing, which points the read at a different
    // resource from the one the URL names.
    if (value === "") throw new Refusal(`verification_token_empty:${path}`);
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
  /** The signal bounding the verification pass, when one was supplied. */
  signal?: AbortSignal;
}

/**
 * One way to confirm an effect. Returns what it found; `type` and `strength`
 * are stamped by the kernel from the predicate type, so a verifier cannot
 * claim a stronger kind of knowing than its type is entitled to. Throwing
 * fails the predicate as `inconclusive`: no answer, rather than a no.
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

/**
 * A body cut at the size cap is longer than what arrived, so it is neither the
 * `content` that arrived nor the `bytes` counted, whatever those happen to
 * equal: an exact match on either is no match at all.
 */
function cutBody(result: Record<string, unknown>, path: string): boolean {
  // An http body: other results carry `truncated` about something else, such
  // as a terminal `send`, whose `bytes` are what it wrote and whose
  // `truncated` is about the job's output.
  return (
    result.truncated === true &&
    typeof result.content === "string" &&
    (path === "content" || path === "bytes")
  );
}

const resultEquals: Built<"result_equals"> = {
  type: "result_equals",
  async check(predicate, result) {
    const passed =
      !cutBody(result, predicate.path) &&
      Object.is(readResultPath(result, predicate.path), predicate.value);
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

/**
 * A path that is not there: the workspace's answer, not a failure to ask.
 * Thrown, it would read as no answer at all, and a reconciliation or a
 * condition waiting on that file would never decide.
 */
const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

/**
 * A path the OS will not take whole (ENAMETOOLONG) is no answer either way: a
 * name past NAME_MAX cannot exist, but a path past PATH_MAX can, built through
 * relative steps. Read as missing, a file that is there verified as gone. It is
 * the kernel's own refusal, so a check on it fails rather than waits.
 */
function refuseTooLong(error: unknown): void {
  if (error instanceof Error && "code" in error && error.code === "ENAMETOOLONG") {
    throw new Refusal("verification_path_too_long");
  }
}

const fileExists: Built<"file_exists"> = {
  type: "file_exists",
  async check(predicate, _result, context) {
    let path: string;
    let passed: boolean;
    try {
      path = await context.workspacePath(predicate.path);
      const metadata = await stat(path);
      passed = metadata.isFile() || metadata.isDirectory();
    } catch (error) {
      refuseTooLong(error);
      if (!missing(error)) throw error;
      return { passed: false, summary: "workspace path does not exist", source: predicate.path };
    }
    return {
      passed,
      summary: `workspace path ${passed ? "exists" : "does not exist"}`,
      source: context.relative(path),
    };
  },
};

/**
 * Whether `path`, which lstat reached as `found`, is the source of a move that
 * only changed its case: a case-insensitive disk folds the old spelling onto
 * the renamed file, and a correct rename verified as partial. It is absent
 * only when `path` is that move's own source, what it reached is the move's
 * destination entry and that entry's only name (a hard link is a second one),
 * and the directory no longer lists the old spelling. Anywhere else a path
 * lstat reaches is there, however spelled: a guard asking whether settings.json
 * is absent beside Settings.json must not be told yes.
 */
async function renamedByCase(
  path: string,
  found: BigIntStats,
  result: Record<string, unknown>,
  context: VerificationContext,
): Promise<boolean> {
  if (result.moved !== true || typeof result.path !== "string" || typeof result.destination !== "string") return false;
  // As the runtime reported it, relative to the root: an absolute path that
  // spells the root in another case (Windows allows it) is the same source.
  if (context.relative(path) !== result.path) return false;
  if (!found.isDirectory() && found.nlink !== 1n) return false;
  // The destination's own entry, not where a link there leads; gone, it is
  // not what the old spelling reached.
  const destination = await context
    .workspacePath(result.destination, { mayBeAbsent: true })
    .then((resolved) => lstat(resolved, { bigint: true }))
    .catch(() => undefined);
  if (destination === undefined || destination.dev !== found.dev || destination.ino !== found.ino) return false;
  // Compared as the OS sees names: UTF-8 (a lone surrogate becomes U+FFFD),
  // and normalization aside, which such disks ignore too.
  const spelled = (name: string) => Buffer.from(name).toString("utf8").normalize("NFC");
  const name = spelled(basename(path));
  return !(await readdir(dirname(path))).some((listed) => spelled(listed) === name);
}

const fileAbsent: Built<"file_absent"> = {
  type: "file_absent",
  async check(predicate, result, context) {
    const path = await context.workspacePath(predicate.path, { mayBeAbsent: true }).catch((error: unknown) => {
      refuseTooLong(error);
      throw error;
    });
    let passed = false;
    try {
      passed = await renamedByCase(path, await lstat(path, { bigint: true }), result, context);
    } catch (error) {
      refuseTooLong(error);
      passed = missing(error);
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
    let path: string;
    try {
      path = await context.workspacePath(predicate.path);
      // Streamed, so a large artifact is hashed in constant memory; a FIFO or
      // a device would never end, so only a regular file is read at all.
      if (!(await stat(path)).isFile()) {
        return { passed: false, summary: "workspace path is not a regular file", source: context.relative(path) };
      }
    } catch (error) {
      refuseTooLong(error);
      if (!missing(error)) throw error;
      return { passed: false, summary: "workspace path does not exist", source: predicate.path };
    }
    const hash = createHash("sha256");
    await pipeline(createReadStream(path), hash);
    const digest = hash.digest("hex");
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
      throw new Refusal("verification_probe_unavailable");
    }
    if (context.signal?.aborted) {
      const reason = context.signal.reason;
      const msg = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "task_cancelled";
      const refusal = msg === "task_budget_exhausted" || msg === "budget_exhausted" ? "budget_exhausted" : "task_cancelled";
      throw new Refusal(refusal);
    }
    const url = interpolate(predicate.url, result);
    // What the item names is stored in receipts, so without the query and
    // userinfo a stored request drops too: either can carry a token. The
    // request below still goes to `url` as declared.
    const source = (redactStructuredValue({ url }).value as { url: string }).url;
    // Caught here so the item names the URL it could not read. A transport
    // failure is not the provider saying no: it is `inconclusive`, and that is
    // what lets an unreachable provider leave a mutation `recovery_required`
    // instead of `failed`.
    let observed: Record<string, unknown>;
    try {
      observed = withParsedBody(
        await context.probe({
          url,
          method: predicate.method,
          timeoutMs: predicate.timeoutMs,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        }),
      );
    } catch (error) {
      if (context.signal?.aborted) {
        const reason = context.signal.reason;
        const msg = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "task_cancelled";
        const refusal = msg === "task_budget_exhausted" || msg === "budget_exhausted" ? "budget_exhausted" : "task_cancelled";
        throw new Refusal(refusal);
      }
      return {
        passed: false,
        inconclusive: true,
        summary: `independent read unavailable: ${error instanceof Error ? error.message : String(error)}`,
        source,
      };
    }
    const cut = observed.truncated === true;
    const passed =
      !cutBody(observed, predicate.path) &&
      Object.is(readResultPath(observed, predicate.path), predicate.value);
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
        source,
      };
    }
    // A body cut at the probe's size cap is not the provider saying no about
    // what is in it: the value may be past the cut, and a cut JSON body is not
    // parsed at all. Its status and headers arrived whole, and so did a 404.
    // The whole body is longer than what arrived, so a `content` or `bytes`
    // that fits within what arrived cannot be it, and that miss is the answer.
    const arrived = Number(observed.bytes ?? 0);
    const unknowable =
      predicate.path === "content"
        ? typeof predicate.value === "string" && Buffer.byteLength(predicate.value) > arrived
        : predicate.path === "bytes"
          ? typeof predicate.value === "number" && predicate.value > arrived
          : /^(json|content|bytes)(\.|$)/u.test(predicate.path);
    if (
      !passed &&
      cut &&
      typeof status === "number" &&
      status >= 200 &&
      status < 300 &&
      unknowable
    ) {
      return {
        passed: false,
        inconclusive: true,
        summary: "independent read unavailable: the response passed the size cap and was cut off",
        source,
      };
    }
    return {
      passed,
      summary: `independent read of ${predicate.path} ${passed ? "matched" : "did not match"} expected value`,
      source,
    };
  },
};

/**
 * A question about meaning. The kernel runs no model, so it never answers one:
 * the item fails as inconclusive, and the controller parks the task for a
 * verdict from outside (#54). Built in so planning supports the type and no
 * embedder can register a verifier that answers it.
 */
const semantic: Built<"semantic"> = {
  type: "semantic",
  async check() {
    return { passed: false, inconclusive: true, summary: "semantic_judgement_unanswered" };
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
  semantic,
];
const BUILT_IN_TYPES: ReadonlySet<string> = new Set(BUILT_IN.map((verifier) => verifier.type));
/** The predicates whose `path` is a workspace file. */
const FILE_TYPES: ReadonlySet<string> = new Set(["file_exists", "file_absent", "file_hash"]);


export interface VerifierOptions {
  /** Absent means `http_resource_matches` fails rather than passes. */
  probe?: EvidenceProbe;
  /**
   * Verifiers for predicate types the kernel does not ship. A built-in type
   * cannot be replaced: what `file_hash` means is not an embedder's to change.
   */
  verifiers?: ReadonlyArray<RegisteredVerifier>;
  /**
   * Whether a path is one no predicate may open, even inside the root: the
   * files MELRA itself holds locked, since closing a descriptor to one drops
   * this process's lock. The runtime passes the file runtime's own check.
   * `call` is one object for every check made for one predicate and a new
   * one for the next, so what the checks compare with may be looked up once
   * per predicate.
   */
  reserved?: (path: string, call?: object) => Promise<boolean>;
}

export class Verifier {
  private readonly verifiers = new Map<string, RegisteredVerifier>();

  private constructor(
    readonly root: string,
    private readonly lexicalRoot: string,
    private readonly probe: EvidenceProbe | undefined,
    extra: ReadonlyArray<RegisteredVerifier>,
    private readonly reserved?: (path: string, call?: object) => Promise<boolean>,
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
    return new Verifier(await realpath(root), resolve(root), options.probe, options.verifiers ?? [], options.reserved);
  }

  private inputPath(input: string): string {
    if (!isAbsolute(input)) return input;
    const candidate = resolve(input);
    return inside(this.lexicalRoot, candidate)
      ? resolve(this.root, relative(this.lexicalRoot, candidate))
      : input;
  }

  /**
   * Whether a file predicate names a path refused on its spelling alone,
   * outside the root or the root itself, so asking it can never get an
   * answer. For planning, before the file need exist: no link is followed,
   * and one that leads out is still refused when the predicate is asked.
   */
  outsideWorkspace(predicate: EvidencePredicate | { type: string; [field: string]: unknown }): boolean {
    const path = (predicate as { path?: unknown }).path;
    return FILE_TYPES.has(predicate.type) && typeof path === "string" && this.spelled(path) === undefined;
  }

  /**
   * The refusal an `http_resource_matches` URL gets when `facts` cannot fill
   * one of its `{{token}}`s, if any. For planning a reconciliation, which is
   * only ever read against facts known before the call: asked, it would be
   * refused every time.
   */
  unfilledToken(
    predicate: EvidencePredicate | { type: string; [field: string]: unknown },
    facts: Record<string, unknown>,
  ): string | undefined {
    const url = (predicate as { url?: unknown }).url;
    if (predicate.type !== "http_resource_matches" || typeof url !== "string") return undefined;
    try {
      interpolate(url, facts);
      return undefined;
    } catch (error) {
      return error instanceof Refusal ? error.message : undefined;
    }
  }

  /**
   * `input` under the root before any link is followed; undefined outside it
   * or at the root. Every file path a verifier, built-in or registered, or
   * planning asks about comes through here, so the root's configured spelling
   * is mapped once, for all of them.
   */
  private spelled(input: string): string | undefined {
    const candidate = resolve(this.root, this.inputPath(input));
    return inside(this.root, candidate) && relative(this.root, candidate) !== "" ? candidate : undefined;
  }

  private async filePath(input: string, call?: object): Promise<string> {
    // Where the path leads is decided before whether it is there, which is an
    // answer, so a refused path gets the same refusal present or absent.
    const actual = await realpath(await this.potentiallyAbsentFilePath(input, call));
    if (!inside(this.root, actual)) {
      throw new Refusal("verification_path_outside_workspace");
    }
    if ((await this.reserved?.(actual, call)) === true) {
      throw new Refusal("verification_path_reserved");
    }
    return actual;
  }

  private async potentiallyAbsentFilePath(input: string, call?: object): Promise<string> {
    const candidate = this.spelled(input);
    if (candidate === undefined) throw new Refusal("verification_path_outside_workspace");
    // Before following links, so every reserved name gets the same answer,
    // wherever a link inside it leads; the runtime's check follows them itself.
    if ((await this.reserved?.(candidate, call)) === true) throw new Refusal("verification_path_reserved");
    let probe = candidate;
    while (true) {
      try {
        const actual = await realpath(probe);
        if (!inside(this.root, actual)) {
          throw new Refusal("verification_path_outside_workspace");
        }
        // Whether a reserved name is absent is no more answered than whether it exists.
        if ((await this.reserved?.(join(actual, relative(probe, candidate)), call)) === true) {
          throw new Refusal("verification_path_reserved");
        }
        return candidate;
      } catch (error) {
        if (error instanceof Refusal) throw error;
        const parent = dirname(probe);
        if (parent === probe) {
          throw new Refusal("verification_path_outside_workspace");
        }
        probe = parent;
      }
    }
  }

  async verify(
    // A built-in predicate, or one a registered verifier understands.
    predicates: ReadonlyArray<EvidencePredicate | { type: string; [field: string]: unknown }>,
    result: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<{ verified: boolean; evidence: EvidenceItem[] }> {
    // One per predicate, so a slow one does not age what the next compares
    // with, and none once this returns: a verifier that keeps the context and
    // asks again later gets a check of its own.
    let call: object | undefined;
    const context: VerificationContext = {
      workspacePath: (input, options) =>
        options?.mayBeAbsent === true ? this.potentiallyAbsentFilePath(input, call) : this.filePath(input, call),
      relative: (path) => relative(this.root, path),
      ...(this.probe === undefined ? {} : { probe: this.probe }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    };
    const evidence: EvidenceItem[] = [];
    for (const predicate of predicates) {
      call = {};
      const { verifier, type, input } = this.resolve(predicate);
      try {
        // An unregistered type is a question nobody here can answer: it fails.
        if (verifier === undefined) throw new Refusal(`verification_unsupported:${type}`);
        // `unanswerable` is the kernel's to say, as `strength` is.
        const { unanswerable: _claimed, ...found } = await verifier.check(input as never, result, context);
        evidence.push({ ...found, type });
      } catch (error) {
        // A throw is no answer — an unresolved token, a missing verifier, a
        // backend that timed out — so it is not a provider's "no" either.
        // Reconciliation reads that difference to keep the task parked.
        evidence.push({
          type,
          passed: false,
          inconclusive: true,
          // Still inconclusive, since nothing was learned about the effect;
          // flagged so a caller deciding whether to ask again need not parse
          // the summary.
          ...(error instanceof Refusal ? { unanswerable: true } : {}),
          summary: error instanceof Error ? error.message : String(error),
        });
      }
    }
    call = undefined;
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
