// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// The HTTP effect through the whole kernel, not just the adapter.
//
// `packages/http-runtime` proves the socket does what it says. What it cannot
// prove is that an API call is governed like every other effect: that a POST
// stops at an approval, that the approval phrase is what releases it, that
// verification and not the adapter decides success, and that the receipt keeps
// the response status. Nothing here leaves loopback.

import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { createMelraRuntime } from "../src/index.js";
import type { MelraRuntime } from "../src/runtime.js";

let fixture: Server;
let origin: string;
let runtime: MelraRuntime;
let root: string;
/** Orders the fixture has accepted, so a duplicate submission is visible. */
const orders: string[] = [];

beforeAll(async () => {
  fixture = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/orders") {
        orders.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: orders.length }));
        return;
      }
      if (req.method === "POST" && req.url === "/broken") {
        // Reaches the server, does nothing, says so. The adapter completes; the
        // effect fails. Nothing but verification can tell those apart.
        res.writeHead(500).end("nope");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ orders: orders.length }));
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;

  root = await mkdtemp(join(tmpdir(), "melra-http-"));
  const policyPath = join(root, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      version: "http-effect",
      workspaceRoot: root,
      allowedCommands: [],
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
      mutations: "confirm",
      approvalTtlMs: 300_000,
      maxFileBytes: 1_000_000,
    }),
  );
  runtime = await createMelraRuntime({
    workspaceRoot: root,
    dataDirectory: join(root, ".data"),
    policyPath,
  });
});

afterAll(async () => {
  await runtime.close();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const post = (url: string, content: string) =>
  TaskRequestSchema.parse({
    goal: "Submit an order to the API",
    operation: {
      kind: "http",
      action: "request",
      method: "POST",
      url,
      content,
      headers: { "content-type": "application/json" },
    },
    requiredEvidence: [{ type: "result_equals", path: "status", value: 201 }],
  });

describe("a governed API call", () => {
  it("plans, waits for the exact phrase, executes, and verifies", async () => {
    const planned = runtime.controller.plan(post(`${origin}/orders`, '{"item":"widget"}'));
    expect(planned.status).toBe("awaiting_approval");
    expect(planned.policyDecision.effect).toBe("mutate");
    // Stated before the caller approves anything: HTTP is at-least-once at the
    // provider, so MELRA runs it at most once and never retries it.
    expect(planned.approval).toBeDefined();
    expect(orders).toHaveLength(0);

    const { task, receipt } = await runtime.controller.execute(planned.id, {
      approvalId: planned.approval!.approvalId,
      phrase: planned.approval!.phrase,
    });
    expect(task.status).toBe("verified_success");
    expect(orders).toEqual(['{"item":"widget"}']);
    expect(receipt?.observedEffect.status).toBe(201);
    expect(receipt?.evidence[0]?.passed).toBe(true);
    // The guarantee the plan published is the one the receipt records: an API
    // mutation runs once, and a retry loop never gets to turn that into two.
    expect(receipt?.executionGuarantee).toBe("at-most-once");
  });

  it("refuses the wrong approval phrase without opening a socket", async () => {
    const before = orders.length;
    const planned = runtime.controller.plan(post(`${origin}/orders`, '{"item":"forged"}'));
    await expect(
      runtime.controller.execute(planned.id, {
        approvalId: planned.approval!.approvalId,
        phrase: "APPROVE 000000000000",
      }),
    ).rejects.toThrow("approval_phrase_mismatch");
    expect(orders).toHaveLength(before);
  });

  it("records a call the server refused as failed, and does not retry it", async () => {
    const planned = runtime.controller.plan(post(`${origin}/broken`, "{}"));
    const { task, receipt } = await runtime.controller.execute(planned.id, {
      approvalId: planned.approval!.approvalId,
      phrase: planned.approval!.phrase,
    });
    // The call went out and came back. The effect did not happen, and the
    // adapter's own 500 is not allowed to read as a success.
    expect(task.status).toBe("failed");
    expect(receipt?.observedEffect.status).toBe(500);
    // One attempt even though the request budget allows retries: a POST whose
    // outcome MELRA cannot see is exactly the request it must not send twice.
    expect(task.attempts).toBe(1);
  });

  it("calls a 2xx whose evidence does not hold partial, never success", async () => {
    const request = TaskRequestSchema.parse({
      goal: "Submit an order and expect a 202",
      operation: {
        kind: "http",
        action: "request",
        method: "POST",
        url: `${origin}/orders`,
        content: '{"item":"queued"}',
      },
      // The server answers 201. The caller declared it needed 202, so the call
      // succeeded and the effect it was asked for did not — the one gap only
      // verification can see.
      requiredEvidence: [{ type: "result_equals", path: "status", value: 202 }],
    });
    const planned = runtime.controller.plan(request);
    const { task, receipt } = await runtime.controller.execute(planned.id, {
      approvalId: planned.approval!.approvalId,
      phrase: planned.approval!.phrase,
    });
    expect(task.status).toBe("partial");
    expect(receipt?.success).toBe(true);
    expect(receipt?.evidence[0]?.passed).toBe(false);
  });

  it("denies a host outside the allowlist at plan time", () => {
    const planned = runtime.controller.plan(post("https://attacker.test/orders", "{}"));
    expect(planned.status).toBe("policy_blocked");
    expect(planned.policyDecision.reason).toBe("destination_domain_not_allowed");
  });

  it("rejects an unknown field rather than ignoring it", () => {
    expect(() =>
      runtime.controller.plan(
        TaskRequestSchema.parse({
          goal: "Follow redirects",
          operation: {
            kind: "http",
            action: "request",
            url: `${origin}/orders`,
            followRedirects: true,
          },
        }),
      ),
    ).toThrow();
  });

  it("puts the response status in the receipt and keeps the body out of it", async () => {
    const planned = runtime.controller.plan(post(`${origin}/orders`, '{"item":"receipted"}'));
    const { task } = await runtime.controller.execute(planned.id, {
      approvalId: planned.approval!.approvalId,
      phrase: planned.approval!.phrase,
    });
    const stored = runtime.controller.receipts({ taskId: task.id });
    expect(stored.receipts).not.toHaveLength(0);
    const serialized = JSON.stringify(stored);
    expect(serialized).toContain("201");
    // `content` is a redacted key, so the request payload — the field most
    // likely to carry a token — never reaches storage in the clear.
    expect(serialized).not.toContain("receipted");
  });

  it("reads a GET without an approval at all", async () => {
    const planned = runtime.controller.plan(
      TaskRequestSchema.parse({
        goal: "Count the orders",
        operation: { kind: "http", action: "request", url: `${origin}/orders` },
      }),
    );
    expect(planned.status).toBe("planned");
    expect(planned.approval).toBeUndefined();
    const { task, receipt } = await runtime.controller.execute(planned.id);
    expect(task.status).toBe("verified_success");
    expect(receipt?.executionGuarantee).toBe("read-only");
  });
});
