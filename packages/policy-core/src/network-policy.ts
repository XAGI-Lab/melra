// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { isIP, type LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { lookup } from "node:dns/promises";

function ipv4Number(address: string): number {
  return address
    .split(".")
    .map(Number)
    .reduce((value, octet) => (value << 8) + octet, 0) >>> 0;
}

function inIpv4Range(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

function mappedIpv4Address(address: string): string | undefined {
  const normalized = address.toLowerCase();
  if (!normalized.startsWith("::ffff:")) return undefined;
  const suffix = normalized.slice("::ffff:".length);
  if (isIP(suffix) === 4) return suffix;
  const groups = suffix.split(":");
  if (groups.length !== 2 || groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))) {
    return undefined;
  }
  const high = Number.parseInt(groups[0]!, 16);
  const low = Number.parseInt(groups[1]!, 16);
  return [
    high >>> 8,
    high & 0xff,
    low >>> 8,
    low & 0xff,
  ].join(".");
}

/** The eight 16-bit groups of an IPv6 address, an embedded IPv4 tail included. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase();
  // The dotted tail, if any, found without a regular expression: one that
  // backtracks on long digit runs is a way to stall the destination check.
  const tail = text.slice(text.lastIndexOf(":") + 1);
  if (isIP(tail) === 4) {
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (rest === undefined && missing !== 0)) return undefined;
  return [...left, ...Array<string>(missing).fill("0"), ...right].map((group) => Number.parseInt(group, 16));
}

/**
 * The IPv4 address a NAT64 address stands for, or whether it is a local-use
 * translation (RFC 8215 `64:ff9b:1::/48`), which only ever reaches a private
 * network. `64:ff9b::a00:5` is 10.0.0.5 on a host behind NAT64.
 */
function nat64(address: string): { ipv4?: string; localUse: boolean } | undefined {
  const groups = ipv6Groups(address);
  if (groups === undefined || groups[0] !== 0x64 || groups[1] !== 0xff9b) return undefined;
  if (groups[2] === 1) return { localUse: true };
  if (groups.slice(2, 6).some((group) => group !== 0)) return undefined;
  const [high, low] = [groups[6]!, groups[7]!];
  return { ipv4: [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join("."), localUse: false };
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, bits]) => inIpv4Range(address, base as string, bits as number));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    const mapped = mappedIpv4Address(normalized);
    if (mapped !== undefined) return isPrivateAddress(mapped);
    const translated = nat64(normalized);
    if (translated !== undefined) {
      return translated.localUse || isPrivateAddress(translated.ipv4!);
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff")
    );
  }
  return false;
}

function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return inIpv4Range(address, "127.0.0.0", 8);
  const normalized = address.toLowerCase();
  const mapped = mappedIpv4Address(normalized);
  return normalized === "::1" || (mapped !== undefined && isLoopbackAddress(mapped));
}

export interface NetworkPolicy {
  allowedDomains: string[];
  allowLocalhost: boolean;
  /**
   * Lifts every destination check below, including the SSRF block on private
   * ranges and cloud metadata. Set only when the operator has asked for
   * unhinged mode; see `LocalPolicy.unhinged` in `@melra/policy-core`.
   */
  unhinged?: boolean;
}

function domainAllowed(host: string, allowed: string[]): boolean {
  return allowed.some(
    (entry) =>
      entry === "*" ||
      host === entry.toLowerCase() ||
      host.endsWith(`.${entry.toLowerCase()}`),
  );
}

/**
 * A destination that passed policy, together with the address it resolved to.
 *
 * The address matters because checking a name and then letting something else
 * resolve it again is not a check: between the two lookups a hostile DNS server
 * can answer public once and private the second time. Whatever connects has to
 * connect to `address`, not to `url.hostname`.
 */
export interface SafeDestination {
  url: URL;
  /** The host to connect to: the name, or an IP literal without brackets. */
  host: string;
  /**
   * A `lookup` for `net`/`http`/`https` that answers only with the addresses
   * this check accepted, so the socket never resolves the name again. Every
   * answer is offered, not just the first, so Node can fall back between them:
   * `localhost` answering `::1` first must still reach a server that listens
   * only on 127.0.0.1.
   */
  lookup: LookupFunction;
}

function pinnedLookup(addresses: readonly string[]): LookupFunction {
  const answers = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_hostname, options, callback) => {
    const family = { IPv4: 4, IPv6: 6 }[String(options.family)] ?? options.family;
    const wanted = answers.filter((answer) => !family || answer.family === family);
    if (wanted.length === 0) {
      callback(Object.assign(new Error("destination_no_address"), { code: "ENOTFOUND" }), "", 0);
    } else if (options.all) callback(null, wanted);
    else callback(null, wanted[0]!.address, wanted[0]!.family);
  };
}

/** The URL's host, lowercased, with an IPv6 literal's brackets removed. */
export function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

export async function assertSafeDestination(
  rawUrl: string,
  policy: NetworkPolicy,
): Promise<SafeDestination> {
  const url = new URL(rawUrl);
  // Unhinged mode still parses the URL — a value the browser cannot navigate to
  // is a bug either way — but asserts nothing about where it points.
  if (policy.unhinged) return { url, host: hostOf(url), lookup: dnsLookup };
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("destination_protocol_not_allowed");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("destination_credentials_not_allowed");
  }
  // WHATWG URL keeps an IPv6 literal's brackets in `hostname` ("[::1]"), and
  // `isIP("[::1]")` is 0, so without this an IPv6 address was treated as a name:
  // the private-range check below never ran, and the request only failed because
  // DNS cannot resolve a bracketed string. Strip them so it is checked as the
  // address it is.
  const host = hostOf(url);
  const localName = host === "localhost" || host.endsWith(".localhost");
  if (localName && !policy.allowLocalhost) {
    throw new Error("destination_private_blocked");
  }
  if (!domainAllowed(host, policy.allowedDomains)) {
    throw new Error("destination_domain_not_allowed");
  }
  if (isIP(host)) {
    if (
      isPrivateAddress(host) &&
      !(policy.allowLocalhost && isLoopbackAddress(host))
    ) {
      throw new Error("destination_private_blocked");
    }
    return { url, host, lookup: pinnedLookup([host]) };
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(
      (item) =>
        isPrivateAddress(item.address) &&
        !(policy.allowLocalhost && isLoopbackAddress(item.address)),
    )
  ) {
    throw new Error("destination_private_blocked");
  }
  // Every answer passed, so all of them are safe to pin, in the resolver's order.
  return { url, host, lookup: pinnedLookup(addresses.map((item) => item.address)) };
}

export async function assertSafeUrl(
  rawUrl: string,
  policy: NetworkPolicy,
): Promise<URL> {
  return (await assertSafeDestination(rawUrl, policy)).url;
}
