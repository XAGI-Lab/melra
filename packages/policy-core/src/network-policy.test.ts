// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { describe, expect, it } from "vitest";
import { assertSafeDestination, assertSafeUrl, isPrivateAddress } from "./network-policy.js";

/** What a socket's happy-eyeballs connect would be offered. */
function answers(lookup: LookupFunction, family?: 4 | 6): Promise<string[]> {
  return new Promise((resolve, reject) => {
    lookup("ignored", { all: true, ...(family === undefined ? {} : { family }) }, (error, found) => {
      if (error) reject(error);
      else resolve((found as LookupAddress[]).map((entry) => entry.address));
    });
  });
}

describe("browser network policy", () => {
  it("classifies private IPv4 and IPv6 destinations", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    // NAT64: the IPv4 address inside is what the connection reaches.
    expect(isPrivateAddress("64:ff9b::a00:5")).toBe(true);
    expect(isPrivateAddress("64:ff9b::a9fe:a9fe")).toBe(true);
    expect(isPrivateAddress("64:ff9b::10.0.0.5")).toBe(true);
    expect(isPrivateAddress("64:ff9b:1::a9fe:a9fe")).toBe(true);
    expect(isPrivateAddress("64:ff9b::808:808")).toBe(false);
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

  it("checks an IPv6 literal as an address, not a hostname", async () => {
    // `URL.hostname` keeps the brackets; these used to skip the private-range
    // check entirely and fail only at DNS.
    const policy = { allowedDomains: ["*"], allowLocalhost: false };
    for (const url of [
      "http://[::1]:8080/",
      "http://[::]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
    ]) {
      await expect(assertSafeDestination(url, policy), url).rejects.toThrow(
        "destination_private_blocked",
      );
    }
    // Loopback stays reachable when the policy allows localhost, as for IPv4.
    const loopback = await assertSafeDestination("http://[::1]:8080/", {
      ...policy,
      allowLocalhost: true,
    });
    expect(loopback.host).toBe("::1");
    expect(await answers(loopback.lookup)).toEqual(["::1"]);
    // A public IPv6 literal is allowed, and pinned without brackets so a socket
    // can open it. No DNS lookup is involved.
    const remote = await assertSafeDestination("https://[2606:4700:4700::1111]/", policy);
    expect(remote.host).toBe("2606:4700:4700::1111");
    expect(await answers(remote.lookup)).toEqual(["2606:4700:4700::1111"]);
  });

  it("pins every checked answer for a name, and only those", async () => {
    const { host, lookup } = await assertSafeDestination("http://localhost:8080/", {
      allowedDomains: ["*"],
      allowLocalhost: true,
    });
    expect(host).toBe("localhost");
    const pinned = await answers(lookup);
    expect(pinned.length).toBeGreaterThan(0);
    expect(pinned.every((address) => address === "::1" || address.startsWith("127."))).toBe(true);
    // A socket asking for one family gets only that family's answers.
    expect((await answers(lookup, 4)).every((address) => address.startsWith("127."))).toBe(true);
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
