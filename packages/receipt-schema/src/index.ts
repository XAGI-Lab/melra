// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";

const SENSITIVE_KEY =
  /^(?:args?|authorization|constraints|content|cookie|env|goal|headers?|pass(?:word|wd)?|secret|std(?:out|err)|text|token|api[_-]?key|values?)$/i;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bgh[opurs]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(?:sk|pk|api)[-_][a-z0-9_-]{16,}\b/gi, "[REDACTED_API_KEY]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, "Bearer [REDACTED_TOKEN]"],
  [/\b(password|passwd|secret)\s*[:=]\s*\S+/gi, "$1=[REDACTED]"],
];

export type CertificateResult =
  | "VERIFIED_SUCCESS"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED"
  | "WAITING_APPROVAL"
  | "WAITING_USER"
  | "POLICY_BLOCKED"
  | "BUDGET_EXHAUSTED"
  /** The effect may or may not have happened. Neither claim is available yet. */
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
  policyDecision: {
    outcome: "allow" | "deny" | "confirm";
    policyVersion: string;
    approvalId?: string;
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
  receiptIds: string[];
  evidence: EvidenceItem[];
  createdAt: string;
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
  const visit = (current: unknown, key?: string): unknown => {
    if (key !== undefined && SENSITIVE_KEY.test(key)) {
      return redactWholeValue(current);
    }
    if (key === "url" && typeof current === "string") {
      try {
        const url = new URL(current);
        if (url.search !== "" || url.hash !== "") {
          redactions.add("[REDACTED_URL_QUERY]");
          url.search = "";
          url.hash = "";
        }
        return url.toString();
      } catch {
        // Non-URL strings continue through normal pattern redaction.
      }
    }
    if (typeof current === "string") {
      let redacted = current;
      for (const [pattern, replacement] of SECRET_PATTERNS) {
        const before = redacted;
        redacted = redacted.replace(pattern, replacement);
        if (redacted !== before) redactions.add(replacement);
      }
      return redacted;
    }
    if (Array.isArray(current)) {
      return current.map((item) => visit(item));
    }
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current).map(([entryKey, entryValue]) => [
          entryKey,
          visit(entryValue, entryKey),
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
