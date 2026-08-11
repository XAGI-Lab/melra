// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import type { CredentialDefinition } from "@melra/protocol";

export interface BrokeredHeaders {
  /** Headers to merge into the outgoing request, lowercased. */
  headers: Record<string, string>;
  /** Names of the credentials that were injected — never their values. */
  used: string[];
}

function patternMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("\\*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

/**
 * Read a secret out of a file the same way the payload key is read: refuse a
 * symlink, refuse anything but a regular file, and refuse a mode any other user
 * can read. A secret in a world-readable file is one the agent could have read
 * for itself, which would make the whole broker decorative.
 */
async function readSecretFile(path: string): Promise<string> {
  const before = await lstat(path);
  if (before.isSymbolicLink()) {
    throw new Error("credential_file_must_not_be_symlink");
  }
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      throw new Error("credential_file_must_not_be_symlink");
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.dev !== before.dev ||
      metadata.ino !== before.ino
    ) {
      throw new Error("credential_file_not_regular_file");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("credential_file_permissions_too_open");
    }
    const secret = (await handle.readFile("utf8")).trim();
    if (secret === "") throw new Error("credential_file_empty");
    return secret;
  } finally {
    await handle.close();
  }
}

/**
 * Holds the secrets so the agent does not have to.
 *
 * An adapter asks for the headers one operation may carry and gets back either
 * a header it can send or nothing at all. It never receives the secret as a
 * value it could log, return, or persist, and the broker never writes one down:
 * every call re-reads the source, so rotating a key takes effect on the next
 * request rather than on the next restart.
 */
export class CredentialBroker {
  constructor(
    private readonly definitions: Record<string, CredentialDefinition> = {},
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  /** True when nothing is configured, so a caller can skip the await. */
  get empty(): boolean {
    return Object.keys(this.definitions).length === 0;
  }

  async headersFor(request: {
    host: string;
    capability: string;
    target: string;
  }): Promise<BrokeredHeaders> {
    const headers: Record<string, string> = {};
    const used: string[] = [];
    const operation = `${request.capability}:${request.target}`;
    const host = request.host.toLowerCase();

    for (const [name, definition] of Object.entries(this.definitions)) {
      if (!definition.hosts.some((pattern) => patternMatches(pattern.toLowerCase(), host))) {
        // Not this credential's host. The request still goes out, just
        // unauthenticated — which is what stops a URL the caller chose from
        // walking somebody's bearer token to an origin it was never issued for.
        continue;
      }
      if (!patternMatches(definition.capability, operation)) {
        // Refused before the source is touched. The credential could perform
        // this call; the delegation did not say it may, and that gap is the
        // entire difference between holding a credential and holding authority.
        throw new Error(`credential_capability_not_covered:${name}`);
      }
      const secret =
        "env" in definition.source
          ? this.environment[definition.source.env]
          : await readSecretFile(definition.source.file);
      if (secret === undefined || secret === "") {
        throw new Error(`credential_source_missing:${name}`);
      }
      headers[definition.inject.header.toLowerCase()] =
        definition.inject.scheme === undefined
          ? secret
          : `${definition.inject.scheme} ${secret}`;
      used.push(name);
    }
    return { headers, used };
  }
}
