// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

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

  it("refuses a value that would be a dot segment of the path", async () => {
    const verifier = await Verifier.create(root, {
      probe: probeReturning({ state: "succeeded" }),
    });
    for (const id of ["..", "."]) {
      const { verified, evidence } = await verifier.verify([predicate()], {
        status: 201,
        content: JSON.stringify({ id }),
      });
      expect(verified).toBe(false);
      expect(evidence[0]?.summary).toBe("verification_token_dot_segment:json.id");
    }
    // Nothing was fetched: `/refunds/..` is `/` to a URL parser.
    expect(asked).toEqual([]);
  });

  it("refuses an empty value, which would read the parent resource", async () => {
    const verifier = await Verifier.create(root, {
      probe: probeReturning({ state: "succeeded" }),
    });
    const result = { status: 201, content: JSON.stringify({ id: "" }) };
    const { verified, evidence } = await verifier.verify([predicate()], result);
    expect(verified).toBe(false);
    expect(evidence[0]).toMatchObject({
      summary: "verification_token_empty:json.id",
      unanswerable: true,
    });
    // Planning asks the same question and gets the same refusal.
    expect(verifier.unfilledToken(predicate(), result)).toBe("verification_token_empty:json.id");
    // Nothing was fetched: `/refunds/` is the collection, not the refund.
    expect(asked).toEqual([]);
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

  it("names the resource it read without the query or userinfo it read it with", async () => {
    const url = "https://reader:pw-in-url@api.example.com/refunds/{{json.id}}?access_token=query-held";
    const verifier = await Verifier.create(root, {
      probe: probeReturning({ state: "succeeded" }),
    });
    const { evidence } = await verifier.verify([predicate({ url })], created);
    // The request itself is the one the caller declared.
    expect(asked).toEqual([
      "https://reader:pw-in-url@api.example.com/refunds/rf_123?access_token=query-held",
    ]);
    expect(evidence[0]).toMatchObject({ passed: true, source: "https://api.example.com/refunds/rf_123" });
    // And when the provider could not be asked.
    const unreachable = await Verifier.create(root, {
      probe: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const missed = await unreachable.verify([predicate({ url })], created);
    expect(missed.evidence[0]).toMatchObject({ inconclusive: true, source: "https://api.example.com/refunds/rf_123" });
  });

  it("reads a provider error status as no answer, not as no", async () => {
    for (const status of [503, 429, 500, 401]) {
      const verifier = await Verifier.create(root, {
        probe: async () => ({ success: false, status, content: "<html>busy</html>" }),
      });
      const { verified, evidence } = await verifier.verify([predicate()], created);
      expect(verified).toBe(false);
      expect(evidence[0], String(status)).toMatchObject({ passed: false, inconclusive: true });
    }
    // "Not found" is the provider's word that it is not there.
    const gone = await Verifier.create(root, {
      probe: async () => ({ success: false, status: 404, content: "" }),
    });
    expect((await gone.verify([predicate()], created)).evidence[0]?.inconclusive).toBeUndefined();
  });

  it("reads a body cut at the size cap as no answer, not as no", async () => {
    // 200, but the JSON stops partway: the state may be past the cut, and a
    // cut body is not parsed at all.
    const verifier = await Verifier.create(root, {
      probe: async () => ({ success: true, status: 200, content: '{"padding":"xxxx', bytes: 16, truncated: true }),
    });
    const { verified, evidence } = await verifier.verify([predicate()], created);
    expect(verified).toBe(false);
    expect(evidence[0]).toMatchObject({ passed: false, inconclusive: true });
    // The status arrived whole, so a miss on it is still the provider's word.
    const byStatus = await verifier.verify([predicate({ path: "status", value: 404 })], created);
    expect(byStatus.evidence[0]?.inconclusive).toBeUndefined();
    const itemFor = async (path: string, value: unknown) =>
      (await verifier.verify([predicate({ path, value })], created)).evidence[0];
    // The body is longer than what arrived: it may be this size, or this text
    // (20 bytes in 10 characters), past the cut.
    expect(await itemFor("bytes", 5_242_880)).toMatchObject({ passed: false, inconclusive: true });
    expect(await itemFor("content", "é".repeat(10))).toMatchObject({ passed: false, inconclusive: true });
    // But it is not what arrived, nor anything that fits in it: those are
    // answers, even where they equal the cut-off part exactly.
    for (const [path, value] of [
      ["bytes", 16],
      ["bytes", 8],
      ["content", '{"padding":"xxxx'],
      ["content", "done"],
    ] as const) {
      const item = await itemFor(path, value);
      expect(item, `${path} ${value}`).toMatchObject({ passed: false });
      expect(item?.inconclusive, `${path} ${value}`).toBeUndefined();
    }
    // A cut 404 is still the provider saying it is not there.
    const gone = await Verifier.create(root, {
      probe: async () => ({ success: false, status: 404, content: '{"padding":"xxxx', bytes: 16, truncated: true }),
    });
    expect((await gone.verify([predicate()], created)).evidence[0]?.inconclusive).toBeUndefined();
  });

  it("does not call a value mismatch inconclusive", async () => {
    const verifier = await Verifier.create(root, {
      probe: probeReturning({ state: "pending" }),
    });
    const { evidence } = await verifier.verify([predicate()], created);
    expect(evidence[0]?.inconclusive).toBeUndefined();
  });

  it("marks verification inconclusive when cancelled by signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const verifier = await Verifier.create(root, {
      probe: probeReturning({ state: "succeeded" }),
    });
    const { verified, evidence } = await verifier.verify([predicate()], created, { signal: controller.signal });
    expect(verified).toBe(false);
    expect(evidence[0]).toMatchObject({
      passed: false,
      inconclusive: true,
    });
    expect(evidence[0]?.unanswerable).toBeUndefined();
    expect(evidence[0]?.summary).toContain("independent read unavailable");
  });

  it("marks verification inconclusive when budget is exhausted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("task_budget_exhausted"));
    const verifier = await Verifier.create(root, {
      probe: probeReturning({ state: "succeeded" }),
    });
    const { verified, evidence } = await verifier.verify([predicate()], created, { signal: controller.signal });
    expect(verified).toBe(false);
    expect(evidence[0]).toMatchObject({
      passed: false,
      inconclusive: true,
      summary: "independent read unavailable: task_budget_exhausted",
    });
    expect(evidence[0]?.unanswerable).toBeUndefined();
  });

  it("forwards signal to probe and handles abort in flight", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const verifier = await Verifier.create(root, {
      probe: async (request) => {
        receivedSignal = request.signal;
        controller.abort(new Error("task_budget_exhausted"));
        throw new Error("aborted");
      },
    });
    const { verified, evidence } = await verifier.verify([predicate()], created, { signal: controller.signal });
    expect(verified).toBe(false);
    expect(receivedSignal).toBe(controller.signal);
    expect(evidence[0]).toMatchObject({
      passed: false,
      inconclusive: true,
      summary: "independent read unavailable: task_budget_exhausted",
    });
    expect(evidence[0]?.unanswerable).toBeUndefined();
  });

  it("enforces signal on custom registered verifiers using context.probe", async () => {
    const controller = new AbortController();
    controller.abort(new Error("task_budget_exhausted"));
    let probeCalled = false;
    const verifier = await Verifier.create(root, {
      probe: async () => {
        probeCalled = true;
        return { success: true };
      },
      verifiers: [
        {
          type: "custom_check",
          async check(_input, _result, context) {
            await context.probe!({ url: "https://example.com", method: "GET", timeoutMs: 1000 });
            return { passed: true };
          },
        },
      ],
    });
    const { verified, evidence } = await verifier.verify([{ type: "custom_check" }], created, { signal: controller.signal });
    expect(verified).toBe(false);
    expect(probeCalled).toBe(false);
    expect(evidence[0]).toMatchObject({
      passed: false,
      inconclusive: true,
      summary: "task_budget_exhausted",
    });
  });
});
