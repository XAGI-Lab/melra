// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserOperationSchema } from "@melra/protocol";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserRuntime, captchaReport, detectBrowserExecutable } from "./index.js";

/**
 * Consent banners, cookie walls, and captcha widgets live in iframes, and every
 * locator used to be built from the page — which only searches the main
 * document. An agent could see the banner in a screenshot and had no way to
 * click it. These tests drive real frames, so they fail if that regresses.
 */
const BANNER = `<!doctype html><html><body>
  <button id="accept">Accept all cookies</button>
</body></html>`;

/** Attaches itself after a delay, so a wait started before it exists must find it. */
const LATE = `<!doctype html><html><body><p>loading</p><script>
  setTimeout(() => {
    document.body.innerHTML = '<button id="late">Continue</button>';
  }, 400);
</script></body></html>`;

const PAGE = `<!doctype html><html><head><title>Framed</title></head><body>
  <h1>Article</h1>
  <iframe src="/banner" title="consent"></iframe>
  <iframe src="/late" title="late"></iframe>
</body></html>`;

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.close(() => done());
        }),
    ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface Element {
  index: number;
  name: string | null;
  selector: string;
  frame: string | null;
}

async function fixture(): Promise<{ runtime: BrowserRuntime; url: string } | undefined> {
  const executablePath = await detectBrowserExecutable();
  if (executablePath === undefined) return undefined;
  const server = createServer((request, response) => {
    const body =
      request.url === "/banner" ? BANNER : request.url === "/late" ? LATE : PAGE;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((done) => {
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture_server_address_unavailable");
  }
  const root = await mkdtemp(join(tmpdir(), "melra-frames-"));
  roots.push(root);
  return {
    runtime: new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      executablePath,
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
    }),
    url: `http://127.0.0.1:${address.port}`,
  };
}

describe("frame-aware targeting", () => {
  it("lists and clicks an element inside an iframe", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      const observed = await runtime.execute(
        BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }),
      );
      const elements = observed.elements as Element[];
      const accept = elements.find((item) => item.name === "Accept all cookies");
      // The banner is in a child document, so it is absent from the page text
      // but must still be listed, addressable, and attributed to its frame.
      expect(String(observed.text)).not.toContain("Accept all cookies");
      expect(accept).toBeDefined();
      expect(accept?.frame).toContain("/banner");
      expect(elements.every((item) => typeof item.index === "number")).toBe(true);
      expect(new Set(elements.map((item) => item.index)).size).toBe(elements.length);

      // The whole point: a target resolved without naming the frame.
      const clicked = await runtime.execute(
        BrowserOperationSchema.parse({
          kind: "browser",
          action: "click",
          target: { text: "Accept all cookies" },
        }),
      );
      expect(clicked.success).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("waits for a target that appears in a frame after the wait starts", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(
        BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }),
      );
      const waited = await runtime.execute(
        BrowserOperationSchema.parse({
          kind: "browser",
          action: "wait",
          target: { text: "Continue" },
          state: "visible",
          timeoutMs: 5_000,
        }),
      );
      expect(waited.waited).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("does not report a target as hidden merely because other frames lack it", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(
        BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }),
      );
      // About frames, not the secret-field check, which see-act covers: on a
      // slow renderer that check cannot answer in time and the wait refuses
      // as it should, which is not what this test is asking (#295). The
      // budget is also every call's limit, so it leaves the search room.
      (runtime as unknown as { secretFieldFilled: (page: Page) => Promise<unknown> }).secretFieldFilled = async (
        page,
      ) => ({ state: "clear", read: new Set(page.frames()) });
      // The banner is visible in exactly one of three frames. A per-candidate
      // "some frame is missing it" test would call that hidden immediately.
      await expect(
        runtime.execute(
          BrowserOperationSchema.parse({
            kind: "browser",
            action: "wait",
            target: { text: "Accept all cookies" },
            state: "hidden",
            timeoutMs: 3_000,
          }),
        ),
      ).rejects.toThrow(/browser_wait_timeout:hidden/);
    } finally {
      await runtime.close();
    }
  });
});

describe("captchaReport", () => {
  it("names the vendor of a human-verification widget", () => {
    const report = captchaReport([
      "http://127.0.0.1:8080/",
      "https://www.google.com/recaptcha/api2/anchor?k=abc",
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile",
    ]);
    const captcha = report.captcha as { present: boolean; vendors: string[] };
    expect(captcha.present).toBe(true);
    expect(captcha.vendors).toEqual(["recaptcha", "turnstile"]);
  });

  it("stays silent on a page with no challenge", () => {
    expect(captchaReport(["https://example.com/", "https://cdn.example.com/ad"])).toEqual(
      {},
    );
  });

  it("does not match a lookalike host outside the vendor domain", () => {
    expect(captchaReport(["https://hcaptcha.com.evil.test/x"])).toEqual({});
  });
});
