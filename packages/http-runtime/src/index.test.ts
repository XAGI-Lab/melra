// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpOperationSchema } from "@melra/protocol";
import { HttpRuntime } from "./index.js";

let server: Server;
let origin: string;
/** Last request the fixture saw, so header and body handling is assertable. */
let seen: { method: string; url: string; headers: Record<string, unknown>; body: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, unknown>,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      if (req.url === "/teapot") {
        res.writeHead(418).end("no coffee");
        return;
      }
      if (req.url === "/big") {
        res.writeHead(200).end("x".repeat(50_000));
        return;
      }
      // Accepts the request and never answers, which is the case MELRA must not
      // report as "the effect did not happen".
      if (req.url === "/silent") return;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ created: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const runtime = (): HttpRuntime =>
  new HttpRuntime({ allowedDomains: ["*"], allowLocalhost: true });

const operation = (fields: Record<string, unknown>) =>
  HttpOperationSchema.parse({ kind: "http", action: "request", ...fields });

describe("http runtime", () => {
  it("posts a body and reports the response status", async () => {
    const result = await runtime().execute(
      operation({
        method: "POST",
        url: `${origin}/orders`,
        content: JSON.stringify({ item: "widget" }),
        headers: { "content-type": "application/json" },
        idempotencyKey: "order-42",
      }),
    );
    expect(seen.method).toBe("POST");
    expect(seen.body).toBe('{"item":"widget"}');
    expect(seen.headers["idempotency-key"]).toBe("order-42");
    expect(result.status).toBe(201);
    expect(result.success).toBe(true);
    expect(result.content).toBe('{"created":true}');
  });

  it("reports a failing status as an unsuccessful effect", async () => {
    const result = await runtime().execute(
      operation({ url: `${origin}/teapot` }),
    );
    expect(result.status).toBe(418);
    // The adapter never asserts its own success: a 418 is a completed call and
    // a failed effect, and verification is what turns that into `partial`.
    expect(result.success).toBe(false);
  });

  it("stops reading a body past the cap instead of buffering it", async () => {
    const result = await runtime().execute(
      operation({ url: `${origin}/big`, maxResponseBytes: 1_000 }),
    );
    expect(result.truncated).toBe(true);
    expect(String(result.content).length).toBeLessThan(50_000);
  });

  it("refuses a private destination before any socket opens", async () => {
    const guarded = new HttpRuntime({
      allowedDomains: ["*"],
      allowLocalhost: false,
    });
    await expect(
      guarded.execute(operation({ url: "http://169.254.169.254/latest/meta-data/" })),
    ).rejects.toThrow("destination_private_blocked");
  });

  it("refuses a host outside the allowlist", async () => {
    const guarded = new HttpRuntime({
      allowedDomains: ["example.com"],
      allowLocalhost: false,
    });
    await expect(
      guarded.execute(operation({ url: "http://attacker.test/" })),
    ).rejects.toThrow("destination_domain_not_allowed");
  });

  it("rejects an unknown field", () => {
    expect(() =>
      operation({ url: `${origin}/`, followRedirects: true }),
    ).toThrow();
  });

  it("cancels in flight when the task signal aborts", async () => {
    const controller = new AbortController();
    const pending = runtime().execute(
      operation({ url: `${origin}/orders` }),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("task_cancelled");
  });

  it("marks the outcome unknown when a sent request goes unanswered", async () => {
    // The far end has the request and may already have acted on it. Claiming
    // failure here would be the kernel asserting something it cannot know.
    await expect(
      runtime().execute(
        operation({
          method: "POST",
          url: `${origin}/silent`,
          content: "charge",
          timeoutMs: 300,
        }),
      ),
    ).rejects.toThrow("effect_outcome_unknown:http_timeout");
  });

  it("reports a plain failure when the request never left the machine", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", resolve),
    );
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const attempt = runtime().execute(
      operation({ method: "POST", url: `http://127.0.0.1:${port}/charges` }),
    );

    // Nothing reached a server, so this one really did not happen — and must
    // not be parked for reconciliation.
    await expect(attempt).rejects.toThrow(/ECONNREFUSED/);
    await expect(attempt).rejects.not.toThrow(/effect_outcome_unknown/);
  });
});
