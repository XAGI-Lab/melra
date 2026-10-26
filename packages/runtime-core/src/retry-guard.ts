// Copyright 2024-2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

export interface RetryGuardOptions {
  warnAt: number;
  stopAt: number;
  hardStopEnabled: boolean;
}

export interface RetryGuardState {
  failuresByKey: Map<string, number>;
  hintedKeys: Set<string>;
}

export interface RetryGuardVerdict {
  key: string;
  failureCount: number;
  shouldWarn: boolean;
  shouldStop: boolean;
}

const DEFAULT_OPTIONS: RetryGuardOptions = {
  warnAt: 2,
  stopAt: 5,
  hardStopEnabled: false,
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function toolCallKey(toolName: string, input: unknown): string {
  return createHash("sha256")
    .update(`${toolName}\0${canonicalJson(input)}`)
    .digest("hex")
    .slice(0, 16);
}

export function createRetryGuardState(): RetryGuardState {
  return {
    failuresByKey: new Map(),
    hintedKeys: new Set(),
  };
}

export function resetRetryGuard(state: RetryGuardState): void {
  state.failuresByKey.clear();
  state.hintedKeys.clear();
}

export function recordToolResult(
  state: RetryGuardState,
  toolName: string,
  input: unknown,
  failed: boolean,
  options: Partial<RetryGuardOptions> = {},
): RetryGuardVerdict {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const key = toolCallKey(toolName, input);

  if (!failed) {
    state.failuresByKey.set(key, 0);
    state.hintedKeys.delete(key);
    return { key, failureCount: 0, shouldWarn: false, shouldStop: false };
  }

  const failureCount = (state.failuresByKey.get(key) ?? 0) + 1;
  state.failuresByKey.set(key, failureCount);
  const shouldStop =
    resolved.hardStopEnabled && failureCount >= resolved.stopAt;
  const shouldWarn =
    failureCount >= resolved.warnAt &&
    !state.hintedKeys.has(key) &&
    !shouldStop;
  if (shouldWarn) state.hintedKeys.add(key);
  return { key, failureCount, shouldWarn, shouldStop };
}
