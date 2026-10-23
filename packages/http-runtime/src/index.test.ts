// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpOperationSchema } from "@melra/protocol";
import type { CredentialBroker } from "@melra/policy-core";
import { HttpRuntime } from "./index.js";

let server: Server;
let origin: string;
/** Last request the fixture saw, so header and body handling is assertable. */
let seen: { method: string; url: string; headers: Record<string, unknown>; body: string };
/** What `/customers/<id>` answers before the id; padded past the smallest cap. */
const NOT_FOUND = `${"x".repeat(1_000)} no such customer: '`;

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
      // An API that reflects the id it was asked for, as a "not found" error might.
      if (req.url?.startsWith("/customers/") === true) {
        res.writeHead(404).end(`${NOT_FOUND}${decodeURIComponent(req.url.slice("/customers/".length))}'`);
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

  it("preserves task_budget_exhausted when signal aborts with budget error", async () => {
    const controller = new AbortController();
    const pending = runtime().execute(
      operation({ url: `${origin}/orders` }),
      controller.signal,
    );
    controller.abort(new Error("task_budget_exhausted"));
    await expect(pending).rejects.toThrow("task_budget_exhausted");
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
    // The end goes the full length of the secret's longest form, its hex, twice
    // as long as the secret and more than arrived of it here.
    expect(cut.content).toBe(`${body.slice(0, body.indexOf(secret) - secret.length - 1)}[REDACTED_CREDENTIAL]`);
  });

  it("takes a credential of eight characters or more out in its fixed encodings too", async () => {
    // What the far end says back, reflected from the path, with `secret` brokered.
    const echoed = async (secret: string, text: string, scheme = "Bearer") => {
      const credentials = {
        headersFor: async () => ({ headers: { authorization: `${scheme} ${secret}` }, used: ["key"], secrets: [secret] }),
      } as unknown as CredentialBroker;
      const result = await new HttpRuntime({ allowedDomains: ["*"], allowLocalhost: true, credentials }).execute(
        operation({ url: `${origin}/customers/${encodeURIComponent(text)}` }),
      );
      return String(result.content).slice(NOT_FOUND.length, -1);
    };
    // Eight characters, whose base64 is padded and differs from base64url, and
    // which percent-encoding changes.
    const secret = "k?y~~~/+";
    const base64 = (text: string) => Buffer.from(text).toString("base64");
    const hex = Buffer.from(secret).toString("hex");
    const encodings = {
      base64: base64(secret),
      unpadded: base64(secret).replace(/=+$/, ""),
      base64url: Buffer.from(secret).toString("base64url"),
      hex,
      upperHex: hex.toUpperCase(),
      percent: encodeURIComponent(secret),
      basicUser: base64(`${secret}:`),
      basicPassword: base64(`:${secret}`),
    };
    for (const [name, encoded] of Object.entries(encodings)) {
      // Padding stays, which says nothing about the secret.
      expect(await echoed(secret, `id ${encoded} end`), name).toMatch(/^id \[REDACTED_CREDENTIAL\]=* end$/);
    }
    // Inside a longer base64 string, the encoding of the header it went out in
    // or of a pair, its bytes can start partway into a group. What stays is at
    // most the character at either edge it shares with its neighbours, at
    // every length modulo three.
    for (const long of [secret, `${secret}a`, `${secret}ab`]) {
      for (const wrapped of [`Bearer ${long}`, JSON.stringify({ token: long }), `${long}:pw`, `user:${long}`]) {
        const encoded = base64(wrapped);
        const at = wrapped.indexOf(long);
        const [before = "", after = "", ...rest] = (await echoed(long, encoded)).split("[REDACTED_CREDENTIAL]");
        expect(rest, wrapped).toEqual([]);
        expect(encoded.startsWith(before) && encoded.endsWith(after), wrapped).toBe(true);
        expect(before.length, wrapped).toBeLessThanOrEqual(Math.ceil((4 * at) / 3));
        expect(after.length, wrapped).toBeLessThanOrEqual(encoded.length - Math.floor((4 * (at + long.length)) / 3));
      }
    }
    // Other encoders spell it differently: lower-case escapes, `!` escaped
    // too (RFC 3986, Go, PHP), or `/` left as it is (Python's quote).
    const other = "k?y~~~/+!abc";
    for (const spelled of ["k%3fy~~~%2f%2b!abc", "k%3Fy~~~%2F%2B%21abc", "k%3Fy~~~/%2B%21abc", "k%3fy~~~/%2b%21abc"]) {
      expect(await echoed(other, `id ${spelled} end`), spelled).toBe("id [REDACTED_CREDENTIAL] end");
    }
    // A `Basic` credential is configured already encoded; a far end may echo
    // the pair it decoded, or either half long enough to mask.
    const basic = base64("acct_12345678:correct-horse-battery");
    for (const text of ["acct_12345678:correct-horse-battery", "correct-horse-battery", "acct_12345678"]) {
      expect(await echoed(basic, `id ${text} end`, "Basic"), text).toBe("id [REDACTED_CREDENTIAL] end");
    }
    expect(await echoed(base64("ab:correct-horse-battery"), "id ab end", "Basic")).toBe("id ab end");
    // One character shorter, only the value itself goes: the encodings of so
    // few bytes are ordinary text, and masking them would mask that.
    const short = secret.slice(0, -1);
    expect(await echoed(short, `id ${short} end`)).toBe("id [REDACTED_CREDENTIAL] end");
    for (const encoded of [base64(short), Buffer.from(short).toString("hex"), encodeURIComponent(short)]) {
      expect(await echoed(short, encoded)).toBe(encoded);
    }
  });

  it("ends a body cut at the size cap the same way whatever it held", async () => {
    const secret = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
    const credentials = {
      headersFor: async () => ({ headers: { authorization: `Bearer ${secret}` }, used: ["key"], secrets: [secret] }),
    } as unknown as CredentialBroker;
    const brokered = new HttpRuntime({ allowedDomains: ["*"], allowLocalhost: true, credentials });
    // The far end reflects the caller's text and the cap falls right after it,
    // so the end of the body is whatever the caller chose.
    const reflected = async (text: string) => {
      const result = await brokered.execute(
        operation({
          url: `${origin}/customers/${encodeURIComponent(text)}`,
          maxResponseBytes: NOT_FOUND.length + Buffer.byteLength(text),
        }),
      );
      return { content: result.content, redactions: result.redactions };
    };
    // Text that begins the credential and text that does not, a character
    // apart, come back alike, down to a single character.
    for (let length = 1; length < secret.length; length += 1) {
      const begins = secret.slice(0, length);
      const differs = `${begins.slice(0, -1)}${begins.endsWith("x") ? "y" : "x"}`;
      expect(await reflected(begins), begins).toEqual(await reflected(differs));
    }
    // The secret's longest form, its hex, is twice its length.
    expect(await reflected("A")).toEqual({
      content: `${`${NOT_FOUND}A`.slice(0, -2 * secret.length)}[REDACTED_CREDENTIAL]`,
      redactions: ["[REDACTED_CREDENTIAL]"],
    });
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

  describe("against a far end that answers 101 Switching Protocols", () => {
    let switching: ReturnType<typeof createTcpServer>;
    let switchingOrigin: string;
    const sockets = new Set<Socket>();
    beforeAll(async () => {
      // Answers any request with an upgrade and holds the socket open.
      switching = createTcpServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => undefined);
        socket.on("data", () =>
          socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n"),
        );
      });
      await new Promise<void>((resolve) => switching.listen(0, "127.0.0.1", resolve));
      switchingOrigin = `http://127.0.0.1:${(switching.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => switching.close(() => resolve()));
    });

    it("settles a GET and a POST instead of hanging", async () => {
      // Node took the reply for a protocol switch and ended the request with
      // only 'close', so neither timeoutMs nor anything above it ever fired.
      for (const fields of [{ method: "GET" }, { method: "POST", content: "charge" }]) {
        const started = Date.now();
        await expect(
          runtime().execute(operation({ ...fields, url: `${switchingOrigin}/x`, timeoutMs: 500 })),
        ).rejects.toThrow("effect_outcome_unknown:http_upgrade_refused");
        expect(Date.now() - started).toBeLessThan(500);
      }
    });
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
