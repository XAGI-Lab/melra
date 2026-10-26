// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Operation } from "@melra/protocol";
import { digestOperation } from "@melra/policy-core";
import { canonicalJson } from "@melra/receipt-schema";
import { PayloadCipher } from "./payload-cipher.js";

describe("PayloadCipher", () => {
  it("round-trips canonical payloads without embedding plaintext", () => {
    const cipher = new PayloadCipher(Buffer.alloc(32, 7));
    const context = "task:11111111-1111-4111-8111-111111111111:request";
    const sealed = cipher.seal(
      { value: "one-time-secret", count: 2 },
      context,
    );

    expect(JSON.stringify(sealed)).not.toContain("one-time-secret");
    expect(cipher.open(sealed, context)).toEqual({
      count: 2,
      value: "one-time-secret",
    });
  });

  it("rejects modified authentication tags", () => {
    const cipher = new PayloadCipher(Buffer.alloc(32, 9));
    const context = "task:22222222-2222-4222-8222-222222222222:request";
    const sealed = cipher.seal({ value: "protected" }, context);
    const tag = Buffer.from(sealed.tag, "base64url");
    tag[0] = tag[0]! ^ 1;

    expect(() =>
      cipher.open(
        { ...sealed, tag: tag.toString("base64url") },
        context,
      ),
    ).toThrow("task_payload_authentication_failed");
  });

  it("binds an envelope to its task and payload context", () => {
    const cipher = new PayloadCipher(Buffer.alloc(32, 11));
    const sealed = cipher.seal(
      { value: "protected" },
      "task:33333333-3333-4333-8333-333333333333:request",
    );

    expect(() =>
      cipher.open(
        sealed,
        "task:44444444-4444-4444-8444-444444444444:request",
      ),
    ).toThrow("task_payload_authentication_failed");
  });

  it("requires exactly 32 bytes of key material", () => {
    expect(() => new PayloadCipher(Buffer.alloc(31))).toThrow(
      "payload_key_must_be_32_bytes",
    );
  });

  it("keys record digests per home and per purpose (known answer)", () => {
    const cipher = new PayloadCipher(Buffer.alloc(32, 7));
    const value = { taskId: "11111111-1111-4111-8111-111111111111", operation: { kind: "memory", action: "put", key: "door", value: "4821" } };
    // HMAC-SHA256 under HKDF-SHA256(payload key, no salt, "melra:record-digest:v1"),
    // over the purpose, a NUL and the canonical JSON. Changing any of it
    // leaves every digest already stored unmatchable.
    expect(cipher.digest(value, "input")).toBe("809937944c29d955fe761723c6f7011220fe79e5287268b1f58ff517ee9e193d");
    expect(cipher.digest("ab".repeat(32), "action")).toBe("bad05e244e51fa1402567bee2dc640096b0cc1fb40fcb8bfc7dae098f973f538");
    expect(new PayloadCipher(Buffer.alloc(32, 7)).digest(value, "input")).toBe(cipher.digest(value, "input"));
    expect(cipher.digest(value, "render")).not.toBe(cipher.digest(value, "input"));
    expect(new PayloadCipher(Buffer.alloc(32, 8)).digest(value, "input")).not.toBe(cipher.digest(value, "input"));
    // Not an HMAC under the encryption key itself.
    expect(cipher.digest(value, "input")).not.toBe(
      createHmac("sha256", Buffer.alloc(32, 7)).update(`input\0${canonicalJson(value)}`).digest("hex"),
    );
  });

  it("leaves the plain action digest 0.3.0-alpha.17 and alpha.18 issued as it was (known answer)", () => {
    // A challenge those versions planned is accepted, and its render shown
    // plain, only while this matches what they stored byte for byte.
    const operation = { kind: "memory", action: "put", key: "door", value: "4821" } as Operation;
    expect(digestOperation("11111111-1111-4111-8111-111111111111", operation)).toBe(
      "259c011c83ede6a0192a89a98c37ae9f9cdcca347a89596c3bdb2549b2d0fda1",
    );
  });
});
