// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserOperationSchema } from "@melra/protocol";
import type { BrowserContext } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserRuntime, detectBrowserExecutable } from "./index.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const listen = async (server: Server) => {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

describe("a window whose first response never comes (#226)", () => {
  it("holds up only the action that opened it", { timeout: 60_000 }, async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    // Never answers until the test ends, as a dead link's server can.
    const hung: Array<() => void> = [];
    const stuck = await listen(createServer((_request, response) => void hung.push(() => response.end())));
    // Answers after a while, as a slow site does: after 1.5 s, or as long as
    // the path says.
    const slow = await listen(
      createServer((request, response) => {
        const ms = Number(new URL(request.url ?? "/", "http://x").searchParams.get("ms") ?? 1_500);
        setTimeout(() => response.end("<!doctype html><title>slow</title>"), ms);
      }),
    );
    const origin = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>opener</title>
          <button id="stuck" onclick="window.open('${stuck}/?stuck')">stuck</button>
          <button id="slow" onclick="window.open('${slow}/?slow')">slow</button>
          <button id="late" onclick="window.open('${slow}/?late&ms=2500')">late</button>`);
      }),
    );
    const root = await mkdtemp(join(tmpdir(), "melra-stuck-window-"));
    roots.push(root);
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      executablePath,
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
    });
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url: origin });
      // The click waits for its window as long as it may: the window is part
      // of what it did.
      await run({ action: "click", target: { selector: "#stuck" }, timeoutMs: 2_000 });
      expect(hung).toHaveLength(1);
      // The next action does not wait for it again.
      const started = Date.now();
      await run({ action: "inspect", timeoutMs: 5_000 });
      expect(Date.now() - started).toBeLessThan(2_500);
      // And a slow window is still waited for, and reported, by the action
      // that opened it.
      const clicked = await run({ action: "click", target: { selector: "#slow" }, timeoutMs: 10_000 });
      expect(clicked.popups).toEqual([expect.objectContaining({ url: expect.stringContaining("?slow"), blocked: true })]);

      // A window given up on and handed over later, between actions, takes
      // nothing from the next action's own window.
      const context = (runtime as unknown as { context: BrowserContext }).context;
      const late = context.waitForEvent("page", { predicate: (page) => page.url().includes("?late") });
      await run({ action: "click", target: { selector: "#late" }, timeoutMs: 1_000 });
      await late;
      const after = await run({ action: "click", target: { selector: "#slow" }, timeoutMs: 10_000 });
      expect(JSON.stringify(after.popups)).toContain("?slow");

      // Nor does an action that fails after opening one pass its wait on.
      const cancel = new AbortController();
      const failing = runtime.execute(
        BrowserOperationSchema.parse({ kind: "browser", action: "click", target: { selector: "#stuck" }, settleQuietMs: 2_000 }),
        cancel.signal,
      );
      failing.catch(() => undefined);
      while (hung.length < 2) await new Promise((done) => setTimeout(done, 25));
      cancel.abort(new Error("task_cancelled"));
      await expect(failing).rejects.toThrow();
      const next = Date.now();
      await run({ action: "inspect", timeoutMs: 5_000 });
      expect(Date.now() - next).toBeLessThan(2_500);
    } finally {
      hung.splice(0).forEach((answer) => answer());
      await runtime.close();
    }
  });
});
