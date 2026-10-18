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
    // Answers after a while, as a slow site does: after 1.5 s, or 5 s for
    // the window the test means to give up on.
    const slow = await listen(
      createServer((request, response) => {
        setTimeout(() => response.end("<!doctype html><title>slow</title>"), request.url?.includes("late") ? 5_000 : 1_500);
      }),
    );
    const origin = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>opener</title>
          <button id="stuck" onclick="window.open('${stuck}/?stuck')">stuck</button>
          <button id="slow" onclick="window.open('${slow}/?slow')">slow</button>
          <button id="late" onclick="window.open('${slow}/?late')">late</button>`);
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
      // Still waited on below; this only keeps a failure before then from
      // surfacing as an unhandled rejection once the browser closes.
      late.catch(() => undefined);
      await run({ action: "click", target: { selector: "#late" }, timeoutMs: 2_000 });
      await late;
      const after = await run({ action: "click", target: { selector: "#slow" }, timeoutMs: 10_000 });
      expect(JSON.stringify(after.popups)).toContain("?slow");

      // A cancel during the wait for it ends the wait at once, and the action
      // queued behind it is not held either.
      const waiting = new AbortController();
      const asked = hung.length;
      const cancelled = runtime.execute(
        BrowserOperationSchema.parse({ kind: "browser", action: "click", target: { selector: "#stuck" }, timeoutMs: 8_000 }),
        waiting.signal,
      );
      cancelled.catch(() => undefined);
      while (hung.length <= asked) await new Promise((done) => setTimeout(done, 25));
      // Past the click's settle, so the cancel lands in the wait.
      await new Promise((done) => setTimeout(done, 1_000));
      const at = Date.now();
      waiting.abort(new Error("task_cancelled"));
      const queued = run({ action: "inspect", timeoutMs: 5_000 });
      await expect(cancelled).rejects.toThrow();
      await queued;
      expect(Date.now() - at).toBeLessThan(2_000);

      // Nor does an action that fails after opening one pass its wait on.
      const cancel = new AbortController();
      const opened = hung.length;
      const failing = runtime.execute(
        BrowserOperationSchema.parse({ kind: "browser", action: "click", target: { selector: "#stuck" }, settleQuietMs: 2_000 }),
        cancel.signal,
      );
      failing.catch(() => undefined);
      // Once its window exists, so the cancel lands in the settle after it.
      while (hung.length <= opened) await new Promise((done) => setTimeout(done, 25));
      cancel.abort(new Error("task_cancelled"));
      await expect(failing).rejects.toThrow("task_cancelled");
      const next = Date.now();
      await run({ action: "inspect", timeoutMs: 5_000 });
      expect(Date.now() - next).toBeLessThan(2_500);

      // Nor does one whose wait could not ask the browser, as when that call
      // runs out of its bound.
      type Send = (method: string, ...rest: unknown[]) => Promise<unknown>;
      const targets = (runtime as unknown as { targets: { send: Send } }).targets;
      const send = targets.send.bind(targets);
      let refused = false;
      targets.send = async (method, ...rest) => {
        if (method === "Browser.getVersion" && !refused) {
          refused = true;
          throw new Error("browser_call_timeout:cdp:Browser.getVersion");
        }
        return await send(method, ...rest);
      };
      const before = hung.length;
      const unasked = await run({ action: "click", target: { selector: "#stuck" }, timeoutMs: 10_000 });
      expect(refused).toBe(true);
      expect(unasked.success).toBe(true);
      expect(hung.length).toBeGreaterThan(before);
      const then = Date.now();
      await run({ action: "inspect", timeoutMs: 5_000 });
      expect(Date.now() - then).toBeLessThan(2_500);
    } finally {
      hung.splice(0).forEach((answer) => answer());
      await runtime.close();
    }
  });

  it("gives up what a context's first action opened when that action fails", { timeout: 60_000 }, async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const hung: Array<() => void> = [];
    const stuck = await listen(createServer((_request, response) => void hung.push(() => response.end())));
    // A page that opens a window that never loads as soon as it loads.
    const origin = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>opens</title><script>window.open("${stuck}/?onload")</script>`);
      }),
    );
    const root = await mkdtemp(join(tmpdir(), "melra-stuck-first-"));
    roots.push(root);
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      executablePath,
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
    });
    try {
      // The fresh context's first action is cancelled after the window is
      // created, before any wait has run.
      const cancel = new AbortController();
      const first = runtime.execute(
        BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url: origin, settleQuietMs: 2_000 }),
        cancel.signal,
      );
      first.catch(() => undefined);
      while (hung.length < 1) await new Promise((done) => setTimeout(done, 25));
      cancel.abort(new Error("task_cancelled"));
      await expect(first).rejects.toThrow();
      const next = Date.now();
      await runtime.execute(BrowserOperationSchema.parse({ kind: "browser", action: "inspect", timeoutMs: 5_000 }));
      expect(Date.now() - next).toBeLessThan(2_500);
    } finally {
      hung.splice(0).forEach((answer) => answer());
      await runtime.close();
    }
  });

  it("drops a late window after a context's failed first action, so it takes nothing from the next", { timeout: 60_000 }, async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const asked: string[] = [];
    const slow = await listen(
      createServer((request, response) => {
        asked.push(request.url ?? "");
        setTimeout(() => response.end("<!doctype html><title>slow</title>"), request.url?.includes("first") ? 2_000 : 1_500);
      }),
    );
    // A page that opens a slow window as soon as it loads, and can open another.
    const origin = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>opens</title><script>window.open("${slow}/?first")</script>
          <button id="slow" onclick="window.open('${slow}/?slow')">slow</button>`);
      }),
    );
    const root = await mkdtemp(join(tmpdir(), "melra-late-first-"));
    roots.push(root);
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      executablePath,
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
    });
    const run = (operation: Record<string, unknown>, signal?: AbortSignal) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }), signal);
    try {
      // The fresh context's first action is cancelled once its window exists,
      // before any wait ran, and the window is handed over afterwards.
      const cancel = new AbortController();
      const first = run({ action: "navigate", url: origin, settleQuietMs: 2_000 }, cancel.signal);
      first.catch(() => undefined);
      while (!asked.some((url) => url.includes("first"))) await new Promise((done) => setTimeout(done, 25));
      const context = (runtime as unknown as { context: BrowserContext }).context;
      const late = context.waitForEvent("page", { predicate: (page) => page.url().includes("?first") });
      cancel.abort(new Error("task_cancelled"));
      await expect(first).rejects.toThrow();
      await late;
      // The next click still waits for its own window and reports it.
      const clicked = await run({ action: "click", target: { selector: "#slow" }, timeoutMs: 10_000 });
      expect(JSON.stringify(clicked.popups)).toContain("?slow");
    } finally {
      await runtime.close();
    }
  });
});
