// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// The independent-channel predicate, with the probe stubbed.
//
// What is worth pinning here is not that a match passes — it is what the URL
// is allowed to be built out of, and what happens when the channel is missing.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvidencePredicateSchema } from "@melra/protocol";
import { Verifier, type EvidenceProbe } from "./index.js";

let root: string;
/** Every URL the probe was asked for, in order. */
let asked: string[];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "melra-probe-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const probeReturning = (body: unknown, status = 200): EvidenceProbe => {
  asked = [];
  return async (request) => {
    asked.push(request.url);
    return { success: status < 300, status, content: JSON.stringify(body) };
  };
};

const predicate = (over: Record<string, unknown> = {}) =>
  EvidencePredicateSchema.parse({
    type: "http_resource_matches",
    url: "https://api.example.com/refunds/{{json.id}}",
    path: "json.state",
    value: "succeeded",
    ...over,
  });

/** What the operation being verified returned: a refund was created. */
const created = { status: 201, content: JSON.stringify({ id: "rf_123" }) };

describe("verification through a channel that did not act", () => {
  it("re-reads the resource the effect named and compares provider state", async () => {
    const verifier = await Verifier.create(root, {
      probe: probeReturning({ state: "succeeded" }),
    });
    const { verified, evidence } = await verifier.verify([predicate()], created);
    expect(verified).toBe(true);
    expect(asked).toEqual(["https://api.example.com/refunds/rf_123"]);
    // The point of the whole predicate: this is the one item a caller can rank
    // above the acting channel's own word.
    expect(evidence[0]?.strength).toBe("independent");
  });

  it("fails when the provider never got there, even though the call succeeded", async () => {
    const verifier = await Verifier.create(root, {
      probe: probeReturning({ state: "pending" }),
    });
    const { verified } = await verifier.verify([predicate()], created);
    expect(verified).toBe(false);
  });

  it("fails rather than passes when there is no channel to ask", async () => {
    const verifier = await Verifier.create(root);
    const { verified, evidence } = await verifier.verify([predicate()], created);
    expect(verified).toBe(false);
    expect(evidence[0]?.summary).toBe("verification_probe_unavailable");
  });

  it("percent-encodes what it splices, so a response cannot rewrite the path", async () => {
    const verifier = await Verifier.create(root, {
      probe: probeReturning({ state: "succeeded" }),
    });
    await verifier.verify([predicate()], {
      status: 201,
      content: JSON.stringify({ id: "../../admin?all=1" }),
    });
    expect(asked).toEqual([
      "https://api.example.com/refunds/..%2F..%2Fadmin%3Fall%3D1",
    ]);
  });

  it("fails when the token names nothing in the result", async () => {
    const verifier = await Verifier.create(root, {
      probe: probeReturning({ state: "succeeded" }),
    });
    const { verified, evidence } = await verifier.verify([predicate()], {
      status: 201,
      content: JSON.stringify({ reference: "rf_123" }),
    });
    expect(verified).toBe(false);
    expect(evidence[0]?.summary).toBe("verification_token_unresolved:json.id");
    // Nothing was fetched: a URL with a hole in it is not a destination.
    expect(asked).toEqual([]);
  });

  it("only reads — the schema has no verb that could change anything", () => {
    expect(() => predicate({ method: "DELETE" })).toThrow();
  });

  it("separates a provider that answered no from one that did not answer", async () => {
    const verifier = await Verifier.create(root, {
      probe: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const { verified, evidence } = await verifier.verify([predicate()], created);
    // Unproven is not proven, so the task still does not verify — but "no such
    // refund" and "could not ask" are different facts, and only the first is
    // grounds to call the effect failed.
    expect(verified).toBe(false);
    expect(evidence[0]).toMatchObject({
      passed: false,
      inconclusive: true,
      source: "https://api.example.com/refunds/rf_123",
    });
  });

  it("does not call a value mismatch inconclusive", async () => {
    const verifier = await Verifier.create(root, {
      probe: probeReturning({ state: "pending" }),
    });
    const { evidence } = await verifier.verify([predicate()], created);
    expect(evidence[0]?.inconclusive).toBeUndefined();
  });
});
