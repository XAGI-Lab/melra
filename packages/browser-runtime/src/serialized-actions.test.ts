// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserOperationSchema } from "@melra/protocol";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserRuntime, detectBrowserExecutable } from "./index.js";

/**
 * One BrowserRuntime serves every task, so actions that arrive together have
 * to take turns; and what a page does between two actions, or after a
 * redirect an attached browser followed unseen, still has to be reported or
 * refused.
 */
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PAGE = `<!doctype html><html><head><title>queue</title></head><body>
<button id="late">Schedule</button>
<input id="field" />
<main id="status">waiting</main>
<script>
  setTimeout(() => { document.getElementById('status').textContent = 'ready'; }, 600);
  document.getElementById('late').addEventListener('click', () => {
    setTimeout(() => confirm('Transfer $5,000?'), 2500);
  });
</script></body></html>`;

async function serve(): Promise<number> {
  const server = createServer((request, response) => {
    if (request.url === "/start") {
      // Allowed origin, redirecting to one the policy refuses.
      response.writeHead(302, { location: `http://127.0.0.1:${port}/secret` });
      response.end();
      return;
    }
    if (request.url === "/secret") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><main>internal metadata</main>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(PAGE);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no_address");
  const port = address.port;
  return port;
}

const op = (fields: Record<string, unknown>) => BrowserOperationSchema.parse({ kind: "browser", ...fields });

describe("browser actions that arrive together, and what happens between them", () => {
  it("does not let one task's cancel stop another task's action", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const root = await mkdtemp(join(tmpdir(), "melra-browser-queue-"));
    roots.push(root);
    const port = await serve();
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      allowedDomains: ["*"],
      allowLocalhost: true,
      executablePath,
    });
    try {
      await runtime.execute(op({ action: "navigate", url: `http://127.0.0.1:${port}/` }));
      const cancel = new AbortController();
      const waiting = runtime.execute(op({ action: "wait", value: "ready", timeoutMs: 10_000 }));
      const other = runtime.execute(op({ action: "inspect" }), cancel.signal);
      setTimeout(() => cancel.abort(new Error("task_cancelled")), 100);
      // The second action used to take over the shared cancel signal, so its
      // cancel failed the first one's snapshot.
      await expect(waiting).resolves.toMatchObject({ success: true });
      await expect(other).rejects.toThrow("task_cancelled");
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("reports a dialog the page raised after the action that caused it had returned", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const root = await mkdtemp(join(tmpdir(), "melra-browser-between-"));
    roots.push(root);
    const port = await serve();
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      allowedDomains: ["*"],
      allowLocalhost: true,
      executablePath,
    });
    try {
      await runtime.execute(op({ action: "navigate", url: `http://127.0.0.1:${port}/` }));
      await runtime.execute(op({ action: "click", target: { selector: "#late" } }));
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      const next = await runtime.execute(op({ action: "inspect" }));
      expect(next.dialogs).toEqual([
        expect.objectContaining({ type: "confirm", message: "Transfer $5,000?", betweenActions: true }),
      ]);
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("calls typing that ran out of time after some keys landed an unknown outcome", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const root = await mkdtemp(join(tmpdir(), "melra-browser-typing-"));
    roots.push(root);
    const port = await serve();
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      allowedDomains: ["*"],
      allowLocalhost: true,
      executablePath,
    });
    try {
      await runtime.execute(op({ action: "navigate", url: `http://127.0.0.1:${port}/` }));
      // Ten keys at 200 ms each cannot finish in 500 ms; some reach the page.
      const typing = runtime.execute(
        op({ action: "type", target: { selector: "#field" }, value: "abcdefghij", delayMs: 200, timeoutMs: 500, clearFirst: false }),
      );
      await expect(typing).rejects.toThrow(/effect_outcome_unknown/);
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("does not read back a page an attached browser was redirected to that policy refuses", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const root = await mkdtemp(join(tmpdir(), "melra-browser-cdp-redirect-"));
    roots.push(root);
    const port = await serve();
    const debugging = await serve();
    servers.pop()!.close();
    const owner = await chromium.launch({ executablePath, headless: true, args: [`--remote-debugging-port=${debugging}`] });
    const context = await owner.newContext();
    await context.newPage();
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      // `localhost` is allowed; 127.0.0.1, where the redirect goes, is not.
      allowedDomains: ["localhost"],
      allowLocalhost: true,
      cdpEndpoint: `http://127.0.0.1:${debugging}`,
      cdpContextIndex: -1,
    });
    try {
      const attempt = runtime.execute(op({ action: "navigate", url: `http://localhost:${port}/start` }));
      await expect(attempt).rejects.toThrow(/destination_/);
      const after = await runtime.execute(op({ action: "inspect" }));
      expect(String(after.text)).not.toContain("internal metadata");
    } finally {
      await runtime.close();
      await owner.close();
    }
  }, 120_000);
});
