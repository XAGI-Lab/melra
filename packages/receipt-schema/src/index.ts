// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomUUID } from "node:crypto";

// The exact names, then any name that ends in a credential word:
// `access_token`, `clientSecret`, `x-api-key`. Not `max_tokens` or
// `token_type`, and not `credentials`, which lists names, never values.
// Not `goal` either: it is the record's statement of why a task ran, so like
// `args` it keeps its words and loses only secret shapes (#385).
const SENSITIVE_KEY =
  /^(?:arg|authorization|constraints|content|cookie|env|headers?|input|pass(?:word|wd)?|secret|std(?:out|err)|text|token|api[_-]?key|values?)$|(?:token|secret|pass(?:word|wd|phrase)|api[_-]?key|private[_-]?key)$/i;
/**
 * Secret shapes redacted wherever MELRA persists free text: receipts and task
 * records here, memory values, and terminal output. One list, exported, because
 * three private copies had drifted apart and none of them knew a PEM private
 * key or an AWS access key id; GovBench found memory storing both verbatim.
 *
 * Only high-confidence shapes belong here. A pattern that fires on ordinary
 * text corrupts the record it was meant to protect, so a secret without a
 * recognisable shape is left to the field-name rule in redactStructuredValue.
 */
export const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // A whole PEM private key block, or a truncated one (output cut mid-key) to
  // the end of the text. PGP's armour says `PRIVATE KEY BLOCK`. One pattern
  // for both, so the text after a header is read once.
  [
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*)/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY_ID]"],
  // Tried only from the first `eyJ` in a run of token characters, so the run
  // is read once: a later `eyJ` in the same run matches only where the first
  // one does.
  [
    /\b(?=eyJ)(?<!\beyJ[A-Za-z0-9_-]*?)eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    "[REDACTED_JWT]",
  ],
  [/\b(?:xox[abposre]|xapp)-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\b(?:gh[opurs]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(?:sk|pk|rk|api|whsec)[-_][a-z0-9_-]{16,}\b/gi, "[REDACTED_API_KEY]"],
  // npm, and Google API keys.
  [/\b(?:npm_[A-Za-z0-9]{36,}\b|AIza[A-Za-z0-9_-]{35})/g, "[REDACTED_API_KEY]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, "Bearer [REDACTED_TOKEN]"],
  // An authorization header value. `Digest` and `AWS4-HMAC-SHA256` carry a
  // parameter list, which goes to the end of the line once an `=` shows near
  // its start. Under another known scheme (`Basic`, `token`, `Negotiate`) a
  // value with a digit, an `=` or sixteen characters goes; bare, sixteen
  // characters with a digit that are not a dotted name. So
  // `Authorization: required`, `Basic credentials` and
  // `{ authorization: process.env.API_TOKEN_V2 }` stay.
  [
    /\b((?:proxy-)?authorization["']?\s*:\s*["']?)(?:(?:digest|aws4-hmac-sha256)[ \t]+(?=[^\r\n=]{0,64}=)[^\r\n]+|(?:basic|bearer|negotiate|ntlm|token)[ \t]+(?=[A-Za-z0-9._~+/=-]{0,63}[\d=]|[A-Za-z0-9._~+/=-]{16})[A-Za-z0-9._~+/=-]{8,}|(?![A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+(?![\w.~+/=-]))(?=[A-Za-z0-9._~+/=-]{0,63}\d)[A-Za-z0-9._~+/=-]{16,})/gi,
    "$1[REDACTED_TOKEN]",
  ],
  // `password=x`, and the spellings that hide the word inside a longer name or
  // behind a quote: `DB_PASSWORD=x`, `AWS_SECRET_ACCESS_KEY: x`, `"password": "x"`.
  // A match starts at the word, so text without one is skipped, and the part of
  // the name before the word stays as it was. Only a name's last such word is
  // read on to the end of the name, so a long run of `password_` costs one
  // pass, not a minute. The name may be bound with `=>`, `:=` or Make's `::=`,
  // compared with `==`, or declared with a type of letters, digits, `_`, `.`,
  // `[]`, `<>` or `|`, up to 64 characters (`password: str = x`). The operator is read whole, and
  // neither what is left of it before a space, a quote or the end nor a YAML
  // block-scalar indicator (`|`, `>-`) counts as the value, so `password===""`
  // has none: under an indicator the indented lines below go, each line that
  // starts with the first one's indent, with the blank lines between them. A
  // quoted value goes to its closing quote, spaces and escaped quotes included,
  // looked for within 256 characters of one line, so a quote that never closes
  // costs one bounded look and only its first word goes, as before.
  [
    /(?<![A-Za-z0-9])((?:password|passwd|passphrase|secret)(?![A-Za-z0-9])(?:_(?!(?:password|passwd|passphrase|secret)(?![A-Za-z0-9]))[A-Za-z0-9]*)*)(["']?)\s*(?::[ \t]*[A-Za-z_][\w.\[\]<>|]{0,63}[ \t]*=(?![=>])|=>|:{1,3}=|={1,3}|:)\s*(?:(["'])(?:\\.|(?!\3)[^\\\r\n]){1,256}(?=\3)|[|>][-+1-9]{0,2}[ \t]*\r?\n([ \t]+)\S[^\r\n]*(?:(?:\r?\n[ \t]*)*\r?\n\4[^\r\n]*)*|["']?(?!(?:[:=]{1,3}|[|>][-+1-9]{0,2})(?:\s|$|["']))[^\s"',;}]+)/gi,
    "$1$2=[REDACTED]",
  ],
  // A name ending in a token or key word: `access_token=x`, `x-api-key: x`,
  // `"apiKey": "x"`. Only a value of token characters, eight or more with a
  // digit, the shape an issued token has, so `max_tokens: 4096`,
  // `token: string`, `tokens[0]`, a CSS `#00ff00ab` and the host after
  // `x-access-token:<token>@` stay. Read from the word, which ends the name,
  // and the digit looked for only so far, so a long run of text costs one pass.
  // Bound and compared as a password is. A value that opens with a quote goes
  // to its closing quote; one that does not ends with its characters, so an
  // escape after it (`\n` in JSON text) stays. Under a block-scalar indicator
  // the lines below that start with the first one's indent go too, with the
  // blank lines between them, when the token is all of the first line; with no
  // indicator that indent is empty and the space looked for after it is not
  // there, so the line after the value stays.
  [
    /(token|api[_-]?key|access[_-]?key)(["']?\s*(?:=>|:{1,3}=|={1,3}|:)\s*(?:[|>][-+1-9]{0,2}[ \t]*\r?\n([ \t]+))?(["']?))(?=[A-Za-z0-9._~+/=%-]{0,63}\d)[A-Za-z0-9._~+/=%-]{8,}(?:(?:(?!\4)(?:\\.|[^\\\r\n])){0,256}(?=\4))?(?:(?:\r?\n[ \t]*)*\r?\n\3(?<=[ \t])[^\r\n]*)*/gi,
    "$1$2[REDACTED]",
  ],
  // Userinfo in a URL or connection string anywhere in text: `postgres://app:pw@db`,
  // a password holding `/`, brackets or braces, of any length (an RDS IAM
  // token is the URL-encoded signed request), but not `host:8080/path@x` or
  // `host:3000?next=a@b`, which are ports. The user stops at a comma, quote,
  // bracket or brace, so a CSV row or JSON array of a URL and an address and an
  // IPv6 host are kept, unless it is a whole `{user}`, `{{ user }}` or
  // `${USER}` template. The password stops at a quote or a `${` template, so
  // it never runs on into the next JSON string or reads a port such as
  // `localhost:${port}/@vite` as one, and a `{password}` template is kept.
  // A match starts at a `://` after a scheme character, and the password stops
  // at the next `://`, so no character is scanned from two starts and a long
  // run of text costs one pass.
  [
    /(?<=[a-z0-9+.-])(:\/\/)(?:[^\s/?#@:"'<>{}\[\],]*|\$?\{\{?\s*[\w.]+\s*\}\}?):(?!\d+(?:[/?]|$))(?!\{\{?\s*[\w.]+\s*\}\}?@)(?:(?!\$\{|:\/\/)[^\s@"'])+@/gi,
    "$1[REDACTED_URL_CREDENTIALS]@",
  ],
  // A token standing alone as the user over http(s): `https://<token>@host`.
  // Only a user with a digit and twenty URL-safe characters, the shape an issued
  // token has, so `https://alice@host` and `git+https://git@host` stay.
  [/\b(https?:\/\/)(?=[A-Za-z0-9._~%+-]*\d)[A-Za-z0-9._~%+-]{20,}@/gi, "$1[REDACTED_URL_CREDENTIALS]@"],
];

/** Every SECRET_PATTERNS match in `text` replaced, and which kinds were found. */
export function redactSecrets(text: string): { value: string; redactions: string[] } {
  let value = text;
  const redactions: string[] = [];
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    const before = value;
    value = value.replace(pattern, replacement);
    if (value !== before && !redactions.includes(replacement)) redactions.push(replacement);
  }
  return { value, redactions };
}

// A flag whose value is a credential, `--token x` or `--token=x`, matched on
// the flag's name because the value itself may have no recognisable shape.
// The credential word may lead a longer name too: `--secret-key`,
// `--s3-secret-access-key`, `--passphrase`. The lookahead finds the first
// credential word and is not tried again, and the name is then read as plain
// segments, so a long name is read once.
const SECRET_FLAG =
  /^(--?(?=(?:[a-z0-9]+[-_])*?(?:token|password|passwd|passphrase|pass|secret|api[-_]?key|apikey|auth|authorization|credentials?|cookie|private[-_]?key)(?:[-_]|=|$))[a-z0-9]+(?:[-_][a-z0-9]+)*)(?:=([\s\S]*))?$/i;
// `-u user:pass` / `--user user:pass` (curl, wget), and curl's proxy forms:
// only the part after the colon is a secret, and `sort -u`, `git add -u` take
// no value at all.
const USER_FLAG = /^(?:-u|--user|-U|--proxy-user)$/;
// The same, attached: `-ualice:pw`.
const ATTACHED_USER = /^(-u[^:\s]+):[\s\S]+$/;
// `-pPASSWORD` (mysql and friends). Never the next argument: `mkdir -p dir`,
// `ssh -p 22`. Only after a mysql-family program, because `find -print` and
// `gcc -pthread` have the same shape. A remainder under three characters is
// read as bundled short flags (`-pv`, `-pr`), not a password.
const ATTACHED_PASSWORD = /^-p(.{3,})$/s;
const MYSQL_FAMILY = /^(?:mysql[a-z]*|mariadb[a-z-]*)(?:\.exe)?$/i;
// `NAME=value` with a credential-like name, as `env FOO_TOKEN=x cmd` passes it.
const SECRET_ASSIGNMENT =
  /^([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|AUTH|CREDENTIALS?))=[\s\S]*$/i;
// A header given as one argument, as `curl -H 'Authorization: Bearer x'` does.
const SECRET_HEADER =
  /^((?:--header=|-H)?(?:(?:proxy-)?authorization|cookie|[a-z0-9-]*(?:token|api-?key|secret)))\s*:[\s\S]*$/i;
// Credentials inside a URL or connection string: `postgres://user:pass@host`,
// and `redis://:pass@host`, whose username is usually empty.
const URL_CREDENTIALS = /(\/\/)[^\s/@:]*:[^\s/@]+@/g;
const REDACTED_ARG = "[REDACTED_SENSITIVE_ARG]";

function redactOneArg(arg: string, previous: string | undefined, mysql: boolean): string {
  if (previous !== undefined) {
    const flag = SECRET_FLAG.exec(previous);
    if (flag !== null && flag[2] === undefined) return REDACTED_ARG;
    if (USER_FLAG.test(previous) && arg.includes(":")) {
      return `${arg.slice(0, arg.indexOf(":"))}:${REDACTED_ARG}`;
    }
  }
  const flag = SECRET_FLAG.exec(arg);
  if (flag?.[2] !== undefined) return `${flag[1]}=${REDACTED_ARG}`;
  if (mysql && ATTACHED_PASSWORD.test(arg)) return `-p${REDACTED_ARG}`;
  if (ATTACHED_USER.test(arg)) return arg.replace(ATTACHED_USER, `$1:${REDACTED_ARG}`);
  if (SECRET_ASSIGNMENT.test(arg)) return arg.replace(SECRET_ASSIGNMENT, `$1=${REDACTED_ARG}`);
  if (SECRET_HEADER.test(arg)) return arg.replace(SECRET_HEADER, `$1: ${REDACTED_ARG}`);
  return arg.replace(URL_CREDENTIALS, `$1${REDACTED_ARG}@`);
}

/**
 * A command's arguments with the credentials taken out and everything else
 * kept, so a receipt still says what ran (#122). A credential-named flag loses
 * its value, attached or as the next argument; so do `-pPASSWORD`, the password
 * half of `-u user:pass`, credential-named `NAME=value` assignments, auth
 * headers, and URL userinfo. Every argument then goes through SECRET_PATTERNS.
 */
export function redactArgv(
  argv: readonly string[],
  command?: string,
): { value: string[]; redactions: string[] } {
  const redactions = new Set<string>();
  // Unknown program: read `-pXXXX` as a password, the cautious side.
  const program = (name: string): boolean => MYSQL_FAMILY.test(name.split(/[\\/]/).pop() ?? "");
  let mysql = command === undefined || program(command);
  const value = argv.map((arg, index) => {
    // `env`, `sudo` and friends put the program among the arguments.
    if (program(arg)) mysql = true;
    const out = redactOneArg(arg, index === 0 ? undefined : argv[index - 1], mysql);
    if (out !== arg) redactions.add(REDACTED_ARG);
    const redacted = redactSecrets(out);
    for (const kind of redacted.redactions) redactions.add(kind);
    return redacted.value;
  });
  return { value, redactions: [...redactions] };
}

export type CertificateResult =
  | "VERIFIED_SUCCESS"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED"
  | "WAITING_APPROVAL"
  | "WAITING_USER"
  | "POLICY_BLOCKED"
  | "BUDGET_EXHAUSTED"
  /**
   * The effect may or may not have happened, or it happened and its semantic
   * question went unanswered. Neither success nor failure can be claimed yet.
   */
  | "RECOVERY_REQUIRED";

/**
 * How the kernel knows an evidence item is true, weakest first.
 *
 * A caller reading a receipt has to be able to tell the actor's own word apart
 * from the world's answer, because that difference is the whole value of
 * verification. Derived from the item type by `evidenceStrength`, never
 * declared by the caller — evidence a caller could label `independent` itself
 * would prove nothing.
 */
export type EvidenceStrength =
  /** The adapter reported it. The actor grading its own homework. */
  | "execution"
  /** The kernel re-read the target after the fact. */
  | "state"
  /** Confirmed through a different channel than the one that acted. */
  | "independent"
  /** A judgement about meaning. Probabilistic; never sole evidence for a destructive effect. */
  | "semantic";

/**
 * Only the types that outrank `execution` are listed. An unrecognised type —
 * an older receipt, a predicate added without a decision here — reads as the
 * weakest claim rather than silently borrowing a stronger one.
 */
const STRONGER_THAN_EXECUTION: Record<string, EvidenceStrength> = {
  file_exists: "state",
  file_absent: "state",
  file_hash: "state",
  // Not the adapter's word: the kernel read a durable commit that outlives the
  // process that wrote it.
  idempotency: "state",
  // The only item here the acting channel did not produce: a separate request
  // whose answer comes from the provider's state rather than from the call that
  // changed it.
  http_resource_matches: "independent",
};

export function evidenceStrength(type: string): EvidenceStrength {
  // Its own label, not a rank: a judgement about meaning never borrows state or independent.
  if (type === "semantic") return "semantic";
  return STRONGER_THAN_EXECUTION[type] ?? "execution";
}

export interface EvidenceItem {
  type: string;
  passed: boolean;
  summary: string;
  /**
   * How the item is known. Optional only because receipts written before
   * strengths existed do not carry one; every item written now does, and
   * `evidenceStrength(item.type)` recovers it for the ones that do not.
   */
  strength?: EvidenceStrength;
  /**
   * The question could not be asked — an unreachable provider, a probe the
   * runtime does not have — as opposed to being asked and answered no.
   *
   * `passed` stays false either way, because unproven is not proven. The flag
   * exists so a caller can tell the two apart: a provider that answered "no
   * such refund" is evidence the effect did not happen, and a provider that
   * did not answer is evidence of nothing at all.
   */
  inconclusive?: boolean;
  /**
   * Beside `inconclusive`: the kernel itself refused the question — a path
   * outside the workspace or reserved, a URL token with nothing to fill it, a
   * verifier or probe this runtime does not have — so asking again of the
   * same result is refused again. A caller deciding whether to wait reads this
   * rather than the summary. Only the kernel sets it; a verifier's is dropped.
   */
  unanswerable?: boolean;
  /**
   * On a semantic item whose question was answered (#54): the verdict, who
   * gave it, through which channel, when, and why, redacted. Strings, as in
   * `policyDecision.approval`, for the same reason as `executionGuarantee`.
   */
  judgedBy?: {
    verdict: string;
    judge: string;
    channel: string;
    judgedAt: string;
    rationale?: string;
  };
  /**
   * Beside `judgedBy`: the action receipt's `principal`, the delegation chain
   * the planner declared, redacted with the certificate, so the two declared
   * chains can be compared without the receipt. Both are claims, and neither
   * marks the `harness:` link an OAuth client's token adds. Absent on
   * certificates written before it existed.
   */
  executedBy?: string;
  source?: string;
  digest?: string;
}

export interface ActionReceipt {
  schemaVersion: "1.0.0";
  receiptId: string;
  taskId: string;
  capability: string;
  /**
   * The delegation chain that asked for this effect, outermost first. Optional
   * only because receipts written before principals existed do not carry one;
   * every receipt written now does.
   */
  principal?: string;
  effect: "read" | "mutate" | "destructive";
  /**
   * What was promised about how many times this could run — the same value the
   * plan showed, so an auditor reads the promise beside the outcome instead of
   * inferring it from the effect. A string rather than the protocol's union
   * because this package deliberately has no dependencies; `protocol` owns the
   * vocabulary and derives every value written here.
   */
  executionGuarantee?: string;
  /**
   * The deployment the operator declared for the kernel that ran this effect —
   * `developer` or `enforced`: a declaration, not evidence that no other path
   * existed. A string for the same reason as `executionGuarantee`: `protocol`
   * owns the vocabulary.
   */
  mode?: string;
  /**
   * The OS sandbox that kernel ran terminal commands in (`seatbelt`,
   * `bubblewrap`, `uid`), or `none` when the policy file let it start without
   * one. Absent when the sandbox was off, as it is by default in developer
   * mode, and on receipts written before it existed.
   */
  sandbox?: string;
  policyDecision: {
    outcome: "allow" | "deny" | "confirm";
    policyVersion: string;
    /**
     * The policy file the effect ran under: `sha256:` and the SHA-256 of its
     * bytes, or `default:<version>` with none. Absent on receipts written
     * before it existed, or under a policy built in code.
     */
    policyDigest?: string;
    approvalId?: string;
    /** Who approved, through which channel, having been shown what. */
    approval?: {
      channel: string;
      renderDigest: string;
      approver: string;
      decidedAt: string;
    };
  };
  target: string;
  inputDigest: string;
  startedAt: string;
  endedAt: string;
  success: boolean;
  observedEffect: Record<string, unknown>;
  evidence: EvidenceItem[];
  redactions: string[];
  error?: string;
}

export interface ExecutionCertificate {
  schemaVersion: "1.0.0";
  certificateId: string;
  taskId: string;
  goal: string;
  result: CertificateResult;
  policyVersion: string;
  /** As on the task's receipts. Covered by `digest`, like every other field. */
  policyDigest?: string;
  receiptIds: string[];
  evidence: EvidenceItem[];
  createdAt: string;
  /** The deployment mode the task ran under, as on its receipts. */
  mode?: string;
  /**
   * How the task's effect was authorised: `not_required` (a read),
   * `bypassed` (a mutation allowed with no challenge, which only
   * developer-mode unsafe-local permits), `in_band`, or `out_of_band`. One
   * certificate covers one task, so this is that task's channel. Absent when
   * nothing was authorised. Covered by `digest`, like every other field.
   */
  approvalChannel?: string;
  digest: string;
}

export function redactStructuredValue(value: unknown): {
  value: unknown;
  redactions: string[];
} {
  const redactions = new Set<string>();
  const redactWholeValue = (current: unknown): unknown => {
    redactions.add("[REDACTED_SENSITIVE_FIELD]");
    if (Array.isArray(current)) {
      return current.map(() => "[REDACTED_SENSITIVE_FIELD]");
    }
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        Object.keys(current).map((entryKey) => [
          entryKey,
          "[REDACTED_SENSITIVE_FIELD]",
        ]),
      );
    }
    return "[REDACTED_SENSITIVE_FIELD]";
  };
  const visit = (current: unknown, key?: string, parent?: Record<string, unknown>): unknown => {
    if (key !== undefined && SENSITIVE_KEY.test(key)) {
      // No secret fits in a boolean or null, and a string in its place would
      // change the record's shape: `isSecret: false`, `hasPassword: true`. A
      // number may be a PIN, so it still goes.
      if (typeof current === "boolean" || current === null) return current;
      // An exit status is a whole number no secret can hide in, so the stored
      // copy of a predicate keeps saying which status it expects.
      if (key === "value" && parent?.type === "exit_code" && Number.isInteger(current)) {
        return current;
      }
      return redactWholeValue(current);
    }
    if (key === "args") {
      // Arguments are what a receipt most needs to show, so only their
      // credentials go; anything that is not a list of strings goes whole.
      if (!Array.isArray(current) || !current.every((item) => typeof item === "string")) {
        return redactWholeValue(current);
      }
      // The program sits beside its arguments, as `command`.
      const command = typeof parent?.command === "string" ? parent.command : undefined;
      const redacted = redactArgv(current, command);
      for (const kind of redacted.redactions) redactions.add(kind);
      return redacted.value;
    }
    if (key === "url" && typeof current === "string") {
      try {
        const url = new URL(current);
        if (url.search !== "" || url.hash !== "") {
          redactions.add("[REDACTED_URL_QUERY]");
          url.search = "";
          url.hash = "";
        }
        if (url.username !== "" || url.password !== "") {
          redactions.add("[REDACTED_URL_CREDENTIALS]");
          url.username = "";
          url.password = "";
        }
        // Then the shapes any string gets: a token in the path is still a token.
        const redacted = redactSecrets(url.toString());
        for (const kind of redacted.redactions) redactions.add(kind);
        return redacted.value;
      } catch {
        // Non-URL strings continue through normal pattern redaction.
      }
    }
    if (typeof current === "string") {
      const redacted = redactSecrets(current);
      for (const kind of redacted.redactions) redactions.add(kind);
      return redacted.value;
    }
    if (Array.isArray(current)) {
      return current.map((item) => visit(item));
    }
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current).map(([entryKey, entryValue]) => [
          entryKey,
          visit(entryValue, entryKey, current as Record<string, unknown>),
        ]),
      );
    }
    return current;
  };
  return { value: visit(value), redactions: [...redactions] };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createReceiptId(): string {
  return randomUUID();
}

export function createCertificate(
  input: Omit<ExecutionCertificate, "schemaVersion" | "certificateId" | "digest">,
): ExecutionCertificate {
  const certificateId = randomUUID();
  const base = {
    schemaVersion: "1.0.0" as const,
    certificateId,
    ...input,
  };
  return { ...base, digest: sha256(base) };
}

const LINE_TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);

/**
 * Whether `value` is `pattern` with each `*` standing for any run of
 * characters on one line. The same answers as the `^…$` regex with `.*` for
 * each `*` that grants, credential hosts and `url_matches` were matched with
 * before, in time linear in the two lengths.
 *
 * Strings compare by UTF-16 unit, as a regex without the `u` flag does. Pass
 * `[...value]` and `[...pattern]` to compare by code point, as a `u` regex
 * does, so a `*` never takes half of a surrogate pair.
 */
export function wildcardMatch(value: ArrayLike<string>, pattern: ArrayLike<string>): boolean {
  // The literal runs between the stars.
  const parts: string[][] = [[]];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*") parts.push([]);
    else parts.at(-1)!.push(pattern[i]!);
  }
  const head = parts[0]!;
  const tail = parts.at(-1)!;
  if (parts.length === 1) return value.length === head.length && find(value, head, 0, head.length) === 0;
  const end = value.length - tail.length;
  if (end < head.length || find(value, head, 0, head.length) !== 0 || find(value, tail, end, value.length) !== end) {
    return false;
  }
  // Every run between goes where it first fits. A star covers no line
  // terminator, so the run starts by the first one after the run before it.
  let at = head.length;
  let stop = at;
  const lineEnd = () => {
    stop = Math.max(stop, at);
    while (stop < value.length && !LINE_TERMINATORS.has(value[stop]!)) stop += 1;
    return stop;
  };
  for (const part of parts.slice(1, -1)) {
    const found = find(value, part, at, Math.min(end, lineEnd() + part.length));
    if (found === -1) return false;
    at = found + part.length;
  }
  return lineEnd() >= end;
}

/**
 * Where `part` first starts in `value` at or after `from`, ending by `to`, or
 * -1. Knuth-Morris-Pratt, so the search never steps back over `value`.
 */
function find(value: ArrayLike<string>, part: readonly string[], from: number, to: number): number {
  if (part.length === 0) return from <= to ? from : -1;
  // The longest proper prefix of `part` that also ends each of its prefixes.
  const border = [0];
  for (let i = 1, k = 0; i < part.length; i++) {
    while (k > 0 && part[i] !== part[k]) k = border[k - 1]!;
    if (part[i] === part[k]) k += 1;
    border.push(k);
  }
  for (let i = from, k = 0; i < to; i++) {
    while (k > 0 && value[i] !== part[k]) k = border[k - 1]!;
    if (value[i] === part[k]) k += 1;
    if (k === part.length) return i + 1 - k;
  }
  return -1;
}
