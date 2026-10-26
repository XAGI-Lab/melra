// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

export interface PayloadKeyOptions {
  dataDirectory: string;
  environment: NodeJS.ProcessEnv;
  /** The home's database already holds payloads sealed under some key. */
  sealed?: boolean;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function decodeKey(value: string, error: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(error);
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value) {
    throw new Error(error);
  }
  return key;
}

/**
 * `decodeKey` for the key file's bytes, which never become a string: V8 keeps
 * a string until it is collected and never clears it, while these bytes are
 * zeroed once read. 43 base64url characters, the last with its two spare bits
 * clear, as `decodeKey` requires of the canonical spelling.
 */
function decodeKeyFile(raw: Buffer): Buffer {
  if (raw.length !== 43) throw new Error("payload_key_file_invalid");
  const key = Buffer.alloc(32);
  let pending = 0;
  let bits = 0;
  let at = 0;
  for (const code of raw) {
    const digit =
      code >= 65 && code <= 90 ? code - 65
      : code >= 97 && code <= 122 ? code - 71
      : code >= 48 && code <= 57 ? code + 4
      : code === 45 ? 62
      : code === 95 ? 63
      : -1;
    if (digit < 0) throw new Error("payload_key_file_invalid");
    pending = (pending << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      key[at++] = pending >> bits;
      pending &= (1 << bits) - 1;
    }
  }
  if (pending !== 0) throw new Error("payload_key_file_invalid");
  return key;
}

async function readKeyFile(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (before.isSymbolicLink()) {
    throw new Error("payload_key_path_must_not_be_symlink");
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
      throw new Error("payload_key_path_must_not_be_symlink");
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
      throw new Error("payload_key_path_not_regular_file");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("payload_key_permissions_too_open");
    }
    const raw = await handle.readFile();
    try {
      return decodeKeyFile(raw);
    } finally {
      raw.fill(0);
    }
  } finally {
    await handle.close();
  }
}

export async function loadPayloadKey(
  options: PayloadKeyOptions,
): Promise<Buffer> {
  const environmentKey = options.environment.MELRA_PAYLOAD_KEY;
  if (environmentKey !== undefined) {
    return decodeKey(environmentKey, "payload_key_environment_invalid");
  }

  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(options.dataDirectory, "payload.key");
  // Only a home with nothing sealed yet gets a new key. One minted beside
  // sealed payloads could open none of them, and every later process without
  // the variable would seal under it, splitting the home between two keys
  // (#417).
  if (options.sealed === true) {
    try {
      return await readKeyFile(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      throw new Error(
        `payload_key_missing: ${options.dataDirectory} holds sealed payloads but no payload.key; ` +
          "set MELRA_PAYLOAD_KEY to the key they were sealed under, or restore payload.key from its backup.",
      );
    }
  }
  const key = randomBytes(32);

  // Written in full under a private name first, then linked into place. The
  // key file used to appear empty and be filled afterwards: a second process
  // starting at the same moment read "" and refused to start, and a crash in
  // between left an empty key that blocked every later start.
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(key.toString("base64url"), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A hard link appears complete or not at all, and fails rather than
    // replace a key another process put there first.
    await link(temporary, path);
    return key;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    // Awaited here: returned bare, its rejection sat unhandled while the
    // `finally` below awaited.
    return await readKeyFile(path);
  } finally {
    await rm(temporary, { force: true });
  }
}
