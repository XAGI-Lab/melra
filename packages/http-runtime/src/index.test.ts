// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpOperationSchema } from "@melra/protocol";
import type { CredentialBroker } from "@melra/policy-core";
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
      // An API that reflects the credential it was sent, as an error might.
      if (req.url === "/echo") {
        const key = String(req.headers.authorization);
        res.writeHead(401, `rejected ${key}`, { "x-debug-key": key, "set-cookie": [`seen=${key}`] });
        // Padded so a cap, which is at least 1,000 bytes, can fall inside it.
        res.end(JSON.stringify({ padding: "x".repeat(1_000), error: `invalid credential ${key}` }));
        return;
      }
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
      // Did the work, started answering, and the connection closed mid-body.
      if (req.url === "/cutoff") {
        res.writeHead(200, { "content-length": "100" });
        res.write("partial");
        setTimeout(() => res.socket?.end(), 20);
        return;
      }
      // Never goes quiet long enough for an idle timer, and never finishes.
      if (req.url === "/drip") {
        res.writeHead(200, { "content-length": "100000" });
        const timer = setInterval(() => res.write("x"), 50);
        res.on("close", () => clearInterval(timer));
        return;
      }
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

  it("reaches an IPv4-only server by name whichever family the resolver lists first", async () => {
    // macOS answers `localhost` with ::1 before 127.0.0.1. Pinning only the
    // first answer refused the connection; every checked answer is tried now.
    const port = new URL(origin).port;
    const result = await runtime().execute(
      operation({ method: "GET", url: `http://localhost:${port}/hello` }),
    );
    expect(result.status).toBe(201);
    expect(seen.headers.host).toBe(`localhost:${port}`);
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
    // Sent in one write: the chunk crossing the cap is cut at it, not dropped,
    // which used to leave the content empty.
    expect(result.content).toBe("x".repeat(1_000));
    expect(result.bytes).toBe(1_000);
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

  it("marks the outcome unknown when the answer is cut off mid-body", async () => {
    // A 200 started arriving, so the charge may well have happened: reporting a
    // plain failure would invite the caller to send it again.
    await expect(
      runtime().execute(operation({ method: "POST", url: `${origin}/cutoff`, content: "x" })),
    ).rejects.toThrow(/effect_outcome_unknown/);
  });

  it("bounds the whole exchange by timeoutMs, not only the quiet gaps", async () => {
    const started = Date.now();
    await expect(
      runtime().execute(operation({ method: "GET", url: `${origin}/drip`, timeoutMs: 300 })),
    ).rejects.toThrow(/http_timeout|aborted/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does not send a request cancelled while its credential was being read", async () => {
    const controller = new AbortController();
    const before = seen;
    const credentials = {
      headersFor: async () => {
        controller.abort();
        return { headers: { authorization: "Bearer x" }, used: ["key"] };
      },
    } as unknown as CredentialBroker;
    await expect(
      new HttpRuntime({ allowedDomains: ["*"], allowLocalhost: true, credentials }).execute(
        operation({ method: "POST", url: `${origin}/charges`, content: "x" }),
        controller.signal,
      ),
    ).rejects.toThrow("task_cancelled");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toBe(before);
  });

  it("takes a brokered credential the far end echoes back out of the result", async () => {
    const secret = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
    const credentials = {
      headersFor: async () => ({ headers: { authorization: `Bearer ${secret}` }, used: ["key"], secrets: [secret] }),
    } as unknown as CredentialBroker;
    const brokered = new HttpRuntime({ allowedDomains: ["*"], allowLocalhost: true, credentials });
    const result = await brokered.execute(operation({ url: `${origin}/echo` }));
    // It went out, and the name of what went out comes back.
    expect(seen.headers.authorization).toBe(`Bearer ${secret}`);
    expect(result.credentials).toEqual(["key"]);
    expect(result.status).toBe(401);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.statusText).toBe("rejected [REDACTED_CREDENTIAL]");
    expect((result.headers as Record<string, unknown>)["x-debug-key"]).toBe("[REDACTED_CREDENTIAL]");
    expect(result.content).toContain("invalid credential [REDACTED_CREDENTIAL]");
    expect(result.redactions).toEqual(["[REDACTED_CREDENTIAL]"]);

    // Cut at the size cap partway through the value: what arrived of it goes too.
    const body = JSON.stringify({ padding: "x".repeat(1_000), error: `invalid credential Bearer ${secret}` });
    const cut = await brokered.execute(
      operation({ url: `${origin}/echo`, maxResponseBytes: body.indexOf(secret) + secret.length - 1 }),
    );
    expect(cut.truncated).toBe(true);
    expect(cut.content).toBe(`${body.slice(0, body.indexOf(secret))}[REDACTED_CREDENTIAL]`);
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
    // By name, where every resolved address is tried and each one refuses.
    await expect(
      runtime().execute(operation({ method: "GET", url: `http://localhost:${port}/` })),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("does not send a mutation down an idle connection the server has closed", async () => {
    const charge = operation({ method: "POST", url: `${origin}/orders`, content: "first" });
    await runtime().execute(charge);
    // The server times out its idle keep-alive connections, and the client has
    // not yet read the FIN. A pooled socket would take the next request and
    // reset, reported as an unknown outcome for a request no server ever saw.
    server.closeIdleConnections();
    const result = await runtime().execute({ ...charge, content: "second" });
    expect(result.status).toBe(201);
    expect(seen.body).toBe("second");
  });
});
