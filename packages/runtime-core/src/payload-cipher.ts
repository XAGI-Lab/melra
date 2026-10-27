// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  EncryptedPayloadSchema,
  type EncryptedPayload,
} from "@melra/protocol";
import { canonicalJson } from "@melra/receipt-schema";

/** What a record digest is for. Each one is keyed apart from the others. */
export type DigestPurpose = "action" | "render" | "input" | "operation";

export class PayloadCipher {
  private readonly key: Buffer;
  /** Derived, so the encryption key itself is never used as an HMAC key. */
  private readonly digestKey: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("payload_key_must_be_32_bytes");
    this.key = Buffer.from(key);
    // `v1` names the derivation, so a later one can sit beside it.
    this.digestKey = Buffer.from(hkdfSync("sha256", this.key, Buffer.alloc(0), "melra:record-digest:v1", 32));
  }

  /**
   * A digest stored beside a redacted record: an HMAC under a key derived
   * from this home's payload key, so it is checkable only by a holder of
   * that key, who can open the sealed payload anyway. Labelled by purpose, so
   * the same value digested for two purposes gives two unrelated digests.
   * 64 lowercase hex, the shape a plain SHA-256 had.
   */
  digest(value: unknown, purpose: DigestPurpose): string {
    return createHmac("sha256", this.digestKey).update(`${purpose}\0${canonicalJson(value)}`).digest("hex");
  }

  /**
   * The key the record chain's links are HMACs under (`SqliteStore.sealRecords`),
   * derived under a label of its own, so a link is never a record digest and
   * the store is never handed the payload key.
   */
  chainKey(): Buffer {
    return Buffer.from(hkdfSync("sha256", this.key, Buffer.alloc(0), "melra:record-chain:v1", 32));
  }

  seal(value: unknown, context: string): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(canonicalJson(value), "utf8"),
      cipher.final(),
    ]);
    return {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
  }

  open<T = unknown>(payload: EncryptedPayload, context: string): T {
    const parsed = EncryptedPayloadSchema.parse(payload);
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(parsed.iv, "base64url"),
      );
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
        decipher.final(),
      ]);
    } catch {
      throw new Error("task_payload_authentication_failed");
    }
    return JSON.parse(plaintext.toString("utf8")) as T;
  }
}
