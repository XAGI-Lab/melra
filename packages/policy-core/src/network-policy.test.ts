// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { assertSafeUrl, isPrivateAddress } from "./network-policy.js";

describe("browser network policy", () => {
  it("classifies private IPv4 and IPv6 destinations", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::ffff:ac10:1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("blocks credentials and localhost by default", async () => {
    const policy = { allowedDomains: ["*"], allowLocalhost: false };
    await expect(assertSafeUrl("http://127.0.0.1", policy)).rejects.toThrow(
      "destination_private_blocked",
    );
    await expect(
      assertSafeUrl("https://user:pass@example.com", policy),
    ).rejects.toThrow("destination_credentials_not_allowed");
  });

  it("asserts nothing about the destination when unhinged", async () => {
    // Every check this file exists to make is off in this mode, including the
    // SSRF block on cloud metadata. Only URL syntax still has to hold.
    const policy = {
      allowedDomains: [],
      allowLocalhost: false,
      unhinged: true,
    };
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:9000",
      "https://user:pass@example.com",
      "file:///etc/passwd",
    ]) {
      await expect(assertSafeUrl(url, policy)).resolves.toBeInstanceOf(URL);
    }
    await expect(assertSafeUrl("not a url", policy)).rejects.toThrow();
  });
});
