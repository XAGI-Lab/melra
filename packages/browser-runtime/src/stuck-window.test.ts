// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserOperationSchema } from "@melra/protocol";
import { chromium, type Browser, type BrowserContext, type CDPSession } from "playwright-core";
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
    // Answers after 1.5 s, as a slow site does, except the window the test
    // means to give up on, which answers only when the test lets it.
    const held: Array<() => void> = [];
    const slow = await listen(
      createServer((request, response) => {
        const answer = () => response.end("<!doctype html><title>slow</title>");
        if (request.url?.includes("late")) held.push(answer);
        else setTimeout(answer, 1_500);
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

      // A window given up on and handed over later, between actions, takes
      // nothing from the next action's own window. First, before any window
      // hangs: on Linux and Windows a click made while one does can take
      // seconds to find its button stable.
      const context = (runtime as unknown as { context: BrowserContext }).context;
      const late = context.waitForEvent("page", { predicate: (page) => page.url().includes("?late") });
      // Still waited on below; this only keeps a failure before then from
      // surfacing as an unhandled rejection once the browser closes.
      late.catch(() => undefined);
      await run({ action: "click", target: { selector: "#late" }, timeoutMs: 2_000 });
      // Answered only now, after the click gave its window up.
      while (held.length === 0) await new Promise((done) => setTimeout(done, 25));
      held.splice(0).forEach((answer) => answer());
      await late;
      const after = await run({ action: "click", target: { selector: "#slow" }, timeoutMs: 10_000 });
      expect(JSON.stringify(after.popups)).toContain("?slow");

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
      // The #stuck window, closed once its time runs out, may be reported here
      // too, with no address (#240).
      const addressed = (clicked.popups as Array<{ url: string }>).filter((popup) => popup.url !== "");
      expect(addressed).toEqual([expect.objectContaining({ url: expect.stringContaining("?slow"), blocked: true })]);

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
      held.splice(0).forEach((answer) => answer());
      await runtime.close();
    }
  });

  it("does not let a window given up on stand in for a later action's own (#234)", { timeout: 60_000 }, async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    // Each window answers only when the test lets it, from a server of its
    // own: with one server, the second request did not always arrive while
    // the first was held.
    const held = new Map<string, () => void>();
    const holding = (name: string) =>
      listen(createServer((_request, response) => void held.set(name, () => response.end("<!doctype html><title>slow</title>"))));
    const lateUrl = await holding("late");
    const laterUrl = await holding("later");
    const origin = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>opener</title>
          <button id="late" onclick="window.open('${lateUrl}/?late')">late</button>
          <button id="later" onclick="window.open('${laterUrl}/?later')">later</button>`);
      }),
    );
    const root = await mkdtemp(join(tmpdir(), "melra-stand-in-"));
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
    const release = (name: string) => {
      held.get(name)?.();
      held.delete(name);
    };
    try {
      await run({ action: "navigate", url: origin });
      // Given up on: its click's wait runs out before it answers. (As long
      // again before it is closed (#240), so it is still there to hand over.)
      await run({ action: "click", target: { selector: "#late" }, timeoutMs: 4_000 });
      const context = (runtime as unknown as { context: BrowserContext }).context;
      const late = context.waitForEvent("page", { predicate: (page) => page.url().includes("?late") });
      late.catch(() => undefined);
      // The next click opens a window of its own, and while it waits for that
      // one (past its settle), the window given up on is handed over.
      const clicking = run({ action: "click", target: { selector: "#later" }, timeoutMs: 15_000 });
      clicking.catch(() => undefined);
      while (!held.has("later")) await new Promise((done) => setTimeout(done, 25));
      await new Promise((done) => setTimeout(done, 600));
      release("late");
      await late;
      // It stands in for nothing: the click still waits for its own window.
      const pending = Symbol("pending");
      const first = await Promise.race([clicking, new Promise((done) => setTimeout(() => done(pending), 1_000))]);
      expect(first).toBe(pending);
      const at = Date.now();
      release("later");
      const clicked = await clicking;
      expect(Date.now() - at).toBeLessThan(2_500);
      expect(JSON.stringify(clicked.popups)).toContain("?later");
    } finally {
      for (const answer of held.values()) answer();
      await runtime.close();
    }
  });

  /**
   * A window to a server that never answers (#240), opened by a click or by a
   * context's first action, which is cancelled before its wait could learn
   * the context. Its action's `timeoutMs` is also how much longer it has.
   */
  const lapsing = async ({ popups, first, attached }: { popups: "block" | "allow"; first: boolean; attached: boolean }) => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const hung: Array<() => void> = [];
    const stuck = await listen(createServer((_request, response) => void hung.push(() => response.end())));
    const origin = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>opener</title>
          <button id="stuck" onclick="window.open('${stuck}/?stuck'); setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p id=done>done</p>'), 4000)">stuck</button>
          ${first ? `<script>window.open("${stuck}/?onload")</script>` : ""}`);
      }),
    );
    const root = await mkdtemp(join(tmpdir(), "melra-lapsed-"));
    roots.push(root);
    let owner: Browser | undefined;
    let cdpEndpoint: string | undefined;
    if (attached) {
      const debugging = await listen(createServer());
      const port = new URL(debugging).port;
      await new Promise<void>((done) => servers.pop()!.close(() => done()));
      owner = await chromium.launch({ executablePath, headless: true, args: [`--remote-debugging-port=${port}`] });
      await (await owner.newContext()).newPage();
      cdpEndpoint = `http://127.0.0.1:${port}`;
    }
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      executablePath,
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
      popups,
      ...(cdpEndpoint === undefined ? {} : { cdpEndpoint, cdpContextIndex: -1 }),
    });
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    // The windows a page opened that the browser still has, asked of it.
    const popupsOpen = async () => {
      const targets = (runtime as unknown as { targets: CDPSession }).targets;
      const { targetInfos } = await targets.send("Target.getTargets");
      return targetInfos.filter((target) => target.type === "page" && target.openerId !== undefined).length;
    };
    const grace = first ? 3_000 : 1_000;
    try {
      if (first) {
        const cancel = new AbortController();
        const navigating = runtime.execute(
          BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url: origin, timeoutMs: grace, settleQuietMs: 2_000 }),
          cancel.signal,
        );
        navigating.catch(() => undefined);
        const asked = Date.now() + 20_000;
        while (hung.length < 1 && Date.now() < asked) await new Promise((done) => setTimeout(done, 25));
        expect(hung).toHaveLength(1);
        cancel.abort(new Error("task_cancelled"));
        await expect(navigating).rejects.toThrow();
      } else {
        await run({ action: "navigate", url: origin });
        await run({ action: "click", target: { selector: "#stuck" }, timeoutMs: grace });
      }
      expect(hung).toHaveLength(1);
      expect(await popupsOpen()).toBe(1);
      if (popups === "allow") {
        await new Promise((done) => setTimeout(done, grace + 2_000));
        expect(await popupsOpen()).toBe(1);
      } else if (first) {
        const until = Date.now() + grace + 4_000;
        while ((await popupsOpen()) > 0 && Date.now() < until) await new Promise((done) => setTimeout(done, 50));
        expect(await popupsOpen()).toBe(0);
        // Handed over closed, it is reported by the next action.
        const next = await run({ action: "inspect" });
        expect(next.popups).toEqual([{ url: "", blocked: true, betweenActions: true }]);
      } else {
        // An action running when it is closed reports it, as one that came
        // after the action that opened it.
        const waited = await run({ action: "wait", target: { selector: "#done" }, state: "visible", timeoutMs: 8_000 });
        expect(waited.popups).toEqual([{ url: "", blocked: true, betweenActions: true }]);
        expect(await popupsOpen()).toBe(0);
      }
    } finally {
      hung.splice(0).forEach((answer) => answer());
      await runtime.close();
      await owner?.close();
    }
  };

  it("closes a popup that never loads once it has had as long again (#240)", { timeout: 60_000 }, () =>
    lapsing({ popups: "block", first: false, attached: false }));

  it("leaves a popup that never loads open when popups are allowed (#240)", { timeout: 60_000 }, () =>
    lapsing({ popups: "allow", first: false, attached: false }));

  it("closes one that a context's failed first action opened (#240)", { timeout: 60_000 }, () =>
    lapsing({ popups: "block", first: true, attached: false }));

  it("closes one that a context's failed first action opened in a browser it is attached to (#240)", { timeout: 60_000 }, () =>
    lapsing({ popups: "block", first: true, attached: true }));

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
