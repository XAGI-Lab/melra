// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserOperationSchema } from "@melra/protocol";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_SURFACE, BrowserRuntime, detectBrowserExecutable } from "./index.js";

/**
 * The see/act loop is the thing that was broken: a caller could read a snapshot
 * but had no way to turn what it saw into a target it could act on. These tests
 * drive a real page, so they fail if the emitted selector does not address the
 * element it was reported for.
 */
const PAGE = `<!doctype html><html><head><title>See act</title></head><body>
  <form id="login">
    <input name="email" placeholder="Email">
    <input name="password" type="password">
    <button type="submit" data-testid="submit"> Sign in </button>
  </form>
  <div><span>Total</span><section id="cart"><p>2 items</p></section></div>
  <button disabled>Locked</button>
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
  tag: string;
  name: string | null;
  selector: string;
  attributeName: string | null;
  placeholder: string | null;
  disabled: boolean | null;
  testId: string | null;
}

async function fixture(page = PAGE): Promise<{ runtime: BrowserRuntime; url: string } | undefined> {
  const executablePath = await detectBrowserExecutable();
  if (executablePath === undefined) return undefined;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
  });
  servers.push(server);
  await new Promise<void>((done) => {
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture_server_address_unavailable");
  }
  const root = await mkdtemp(join(tmpdir(), "melra-see-act-"));
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

describe("browser see/act loop", () => {
  it("emits a selector that addresses the element it was reported for", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      const observed = await runtime.execute(
        BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }),
      );
      const elements = observed.elements as Element[];
      const submit = elements.find((item) => item.testId === "submit");
      expect(submit?.selector).toBe('[data-testid="submit"]');
      const email = elements.find((item) => item.attributeName === "email");
      // Anchored on the form's id rather than a path from <html>.
      expect(email?.selector).toBe("#login > input:nth-child(1)");
      expect(email?.placeholder).toBe("Email");
      expect(elements.find((item) => item.name === "Locked")?.disabled).toBe(true);
      expect(elements.every((item) => typeof item.index === "number")).toBe(true);

      // The loop closes only if the selector can be acted on.
      const typed = await runtime.execute(
        BrowserOperationSchema.parse({
          kind: "browser",
          action: "type",
          target: { selector: email!.selector },
          value: "user@example.com",
        }),
      );
      expect(typed.typed).toBe(true);
      const after = (
        (
          await runtime.execute(
            BrowserOperationSchema.parse({ kind: "browser", action: "inspect" }),
          )
        ).elements as Element[]
      ).find((item) => item.attributeName === "email") as
        | (Element & { value: string })
        | undefined;
      expect(after?.value).toBe("user@example.com");
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("looks at a page marked as an approval surface and acts on nothing in it", async () => {
    const context = await fixture(`<!doctype html><html><head><meta name="${APPROVAL_SURFACE}" content="operator-only">
      <title>untouched</title></head><body><input name="note"><button onclick="document.title = 'clicked'">Approve</button></body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url });
      for (const operation of [
        { action: "click", target: { role: "button", name: "Approve" } },
        // A url naming the page changes nothing: it is the page that is refused.
        { action: "click", url, target: { role: "button", name: "Approve" } },
        { action: "press", key: "Enter" },
        { action: "type", target: { selector: 'input[name="note"]' }, value: "x" },
        // Reads, but ones that move Approve under a pointer aimed elsewhere.
        { action: "scroll", direction: "down" },
        { action: "scroll", direction: "into_view", target: { role: "button", name: "Approve" } },
      ]) {
        await expect(run(operation), operation.action).rejects.toThrow("browser_refuses_approval_surface");
      }
      // Reads still work, and show nothing was done.
      const seen = await run({ action: "inspect" });
      expect(seen.title).toBe("untouched");
      // Raising the marked tab from another one is refused the same way.
      await run({ action: "tab_new" });
      await expect(run({ action: "tab_switch", tabIndex: 0 })).rejects.toThrow("browser_refuses_approval_surface");
      expect(await run({ action: "tab_switch", tabIndex: 1 })).toMatchObject({ switched: true });
      // Closing is not driving: it ends a console's pairing, as navigating away does.
      expect(await run({ action: "close", tabIndex: 0 })).toMatchObject({ closed: true, url: `${url}/` });
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("closes none of its tabs while a console is open in another, which the browser would raise", async () => {
    const context = await fixture(`<!doctype html><html><head><meta name="${APPROVAL_SURFACE}" content="operator-only">
      <title>console</title></head><body><button>Approve</button></body></html>`);
    if (context === undefined) return;
    const executablePath = (await detectBrowserExecutable())!;
    const root = await mkdtemp(join(tmpdir(), "melra-see-act-cdp-"));
    roots.push(root);
    const port = await new Promise<number>((done) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address() as { port: number };
        probe.close(() => done(free));
      });
    });
    // The operator's browser, with the console open in it, and the runtime
    // attached to it: there every page reports itself visible and focused, so
    // the console cannot tell it was raised.
    const owner = await chromium.launch({ executablePath, headless: true, args: [`--remote-debugging-port=${port}`] });
    const operatorContext = await owner.newContext();
    const operatorConsole = await operatorContext.newPage();
    await operatorConsole.goto(context.url);
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
      cdpEndpoint: `http://127.0.0.1:${port}`,
      // Keeps the tab the test opens beside its own below.
      popups: "allow",
    });
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      // A tab of its own, the active one: closing it could bring the console forward.
      expect(await run({ action: "tab_new" })).toMatchObject({ opened: true, index: 1 });
      await expect(run({ action: "close" })).rejects.toThrow("browser_refuses_approval_surface");
      await expect(run({ action: "close", tabIndex: 1 })).rejects.toThrow("browser_refuses_approval_surface");
      // Nor switch tabs, onto its own either: a split view raises the switched
      // tab's partner with it, and CDP does not say which tab that is.
      await expect(run({ action: "tab_switch", tabIndex: 1 })).rejects.toThrow("browser_refuses_approval_surface");
      // A tab that is not there is just not there.
      await expect(run({ action: "close", tabIndex: 9 })).rejects.toThrow("browser_tab_not_found");
      // Carrying the marker itself buys a tab nothing: any page can carry it.
      await run({ action: "navigate", url: context.url });
      await expect(run({ action: "close" })).rejects.toThrow("browser_refuses_approval_surface");
      // Once the operator has closed the console, nothing else is marked, and it closes.
      await operatorConsole.close();
      expect(await run({ action: "close" })).toMatchObject({ closed: true });
      // A page that cannot say whether it is a console holds the others open,
      // within a second or so, but can be closed itself.
      const own = (await run({ action: "tab_new" })) as { opened: boolean; index: number };
      expect(own.opened).toBe(true);
      // With no console left, tabs switch again.
      expect(await run({ action: "tab_switch", tabIndex: own.index })).toMatchObject({ index: own.index });
      const silent = await operatorContext.newPage();
      await silent.setContent(`<script>setTimeout(() => { for (;;) {} }, 300)</script>`);
      await new Promise((done) => setTimeout(done, 800));
      const started = Date.now();
      const refusal = await run({ action: "close" }).then(() => "", (error: Error) => error.message);
      expect(Date.now() - started).toBeLessThan(5_000);
      const named = /^browser_approval_surface_check_unavailable: tab (\d+) did not answer$/.exec(refusal);
      expect(named, refusal).not.toBeNull();
      await expect(run({ action: "tab_switch", tabIndex: own.index })).rejects.toThrow(
        "browser_approval_surface_check_unavailable",
      );
      expect(await run({ action: "close", tabIndex: Number(named![1]) })).toMatchObject({ closed: true });
      expect(await run({ action: "close" })).toMatchObject({ closed: true });
    } finally {
      await runtime.close();
      await owner.close();
    }
  }, 120_000);

  it("switches to the tab it checked, even if a tab before it closes meanwhile", async () => {
    // ?busy stops answering for a while, so its check is slow; ?console is marked.
    const context = await fixture(`<!doctype html><html><head><script>
      if (location.search === "?console") document.head.insertAdjacentHTML("beforeend", '<meta name="${APPROVAL_SURFACE}" content="operator-only">');
      if (location.search === "?busy") setTimeout(() => { const until = Date.now() + 3_000; while (Date.now() < until); }, 1_500);
    </script></head><body>tab</body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url });
      const opened = Date.now();
      await run({ action: "tab_new", url: `${url}/?busy` });
      await run({ action: "tab_new", url: `${url}/?console` });
      await new Promise((done) => setTimeout(done, Math.max(0, opened + 1_800 - Date.now())));
      // Tab 1's check waits on its page; tab 0 goes away while it does.
      const pages = (runtime as unknown as { context: { pages: () => Page[] } }).context.pages();
      setTimeout(() => void pages[0]!.close(), 300);
      const switched = await run({ action: "tab_switch", tabIndex: 1 });
      expect(switched.url).toContain("?busy");
      // And says where that tab sits now.
      expect(switched.index).toBe(0);
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("leaves the operator's own new tabs alone in a browser it is attached to", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    // The site the runtime's pages and the operator's tabs load. Each page
    // that opens windows of its own opens them only when the test releases
    // it, so they come between actions however loaded the machine is, and
    // the server notes every page asked for, so the test can wait for one.
    const PAGE = `<!doctype html><html><body><p>page</p>
      <a id="link" href="/?linked">link</a><button id="mod">mod</button>
      <button id="busy" onclick="window.open(new URLSearchParams(location.search).get('busy'))">busy</button>
      <button id="pop" onclick="window.open(location.origin + '/?clickpop')">pop</button><script>
      const released = () => fetch("/release");
      const later = (path, features) => released().then(() => window.open(location.origin + path, "_blank", features));
      if (location.search === "?opens") later("/?popup#pair=secret");
      if (location.search === "?chain") later("/?p1");
      if (location.search === "?p1") window.open(location.origin + "/?p2");
      if (location.search === "?pre1") window.open(location.origin + "/?pre2");
      if (location.search === "?noopener") later("/?np", "noopener");
      if (location.search === "?inaction") later("/?agentpop");
      if (location.search === "?busy") { later("/?busypop"); setInterval(() => document.body.append("."), 50); }
      // Windows that close themselves as soon as they load.
      if (location.search === "?selfclose") released().then(() => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].forEach((i) => window.open(location.origin + "/?closes" + i)));
      if (location.search.startsWith("?closes")) setTimeout(() => window.close(), Number(location.search.slice(7)));
      // A link opened with a modifier click: Chromium gives that tab no opener.
      document.getElementById("mod").onclick = () => released().then(() => document.getElementById("link")
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true })));
    </script></body></html>`;
    const asked: string[] = [];
    const held: Array<() => void> = [];
    const answerAll = () => held.splice(0).forEach((answer) => answer());
    // A page that loads only once the test lets it, so an action navigating
    // to it is still running meanwhile.
    const loading: Array<() => void> = [];
    const site = createServer((request, response) => {
      if (request.url === "/release") {
        held.push(() => response.end("ok"));
        return;
      }
      asked.push(request.url ?? "");
      if (request.url === "/?held") {
        loading.push(() => {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(PAGE);
        });
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE);
    });
    servers.push(site);
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    // A site that answers slowly, as one an operator's popup goes to can.
    const slow = createServer((request, response) => {
      asked.push(request.url ?? "");
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>slow</title>");
      }, 2_000);
    });
    servers.push(slow);
    await new Promise<void>((done) => slow.listen(0, "127.0.0.1", done));
    const slowUrl = `http://127.0.0.1:${(slow.address() as { port: number }).port}/?slow`;
    // And one on another site, whose page keeps its process busy as it loads.
    const heavy = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><script>const end = Date.now() + 4000; while (Date.now() < end) {}</script>");
    });
    servers.push(heavy);
    await new Promise<void>((done) => heavy.listen(0, done));
    const heavyUrl = `http://localhost:${(heavy.address() as { port: number }).port}/?busyload`;
    // And one that never answers until the test ends, as a dead link's can.
    const hung: Array<() => void> = [];
    let hungClosed = false;
    const hanging = createServer((_request, response) => {
      hung.push(() => response.end());
      response.on("close", () => (hungClosed = true));
    });
    servers.push(hanging);
    await new Promise<void>((done) => hanging.listen(0, "127.0.0.1", done));
    const hungUrl = `http://127.0.0.1:${(hanging.address() as { port: number }).port}/?hung`;
    const root = await mkdtemp(join(tmpdir(), "melra-see-act-cdp-"));
    roots.push(root);
    const port = await new Promise<number>((done) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address() as { port: number };
        probe.close(() => done(free));
      });
    });
    // The operator's own browser: one profile, whose tabs and the runtime's
    // share a single context, as in a Chrome the runtime is attached to.
    const profile = await mkdtemp(join(tmpdir(), "melra-see-act-operator-"));
    roots.push(profile);
    const operator = await chromium.launchPersistentContext(profile, {
      executablePath,
      headless: true,
      args: [`--remote-debugging-port=${port}`],
    });
    const first = operator.pages()[0] ?? (await operator.newPage());
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      allowedDomains: ["127.0.0.1", "localhost"],
      allowLocalhost: true,
      cdpEndpoint: `http://127.0.0.1:${port}`,
    });
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    const until = async (what: string, met: () => Promise<boolean> | boolean) => {
      const deadline = Date.now() + 15_000;
      while (!(await met())) {
        if (Date.now() > deadline) throw new Error(`never: ${what}`);
        await new Promise((done) => setTimeout(done, 100));
      }
    };
    // What the runtime itself sees open, which the operator's own connection
    // does not list.
    const open = async () =>
      ((await run({ action: "tabs" })) as { tabs: Array<{ url: string }> }).tabs.map((tab) => new URL(tab.url).search);
    const requested = (search: string) => until(`${search} requested`, () => asked.some((url) => url.includes(search)));
    // Lets the page that is waiting open its windows, once it is waiting.
    const release = async () => {
      await until("a page waiting to be released", () => held.length > 0);
      answerAll();
    };
    // Left open and unreported: listed by the runtime, in no action's popups.
    // Its page is asked for first, so it exists before any action runs to
    // look: a window created while one runs is that action's popup.
    const leftAlone = async (search: string, seen: unknown[] = []) => {
      await requested(search);
      await until(`${search} listed`, async () => (await open()).includes(search));
      seen.push(...(((await run({ action: "inspect" })).popups as unknown[] | undefined) ?? []));
      expect(JSON.stringify(seen), search).not.toContain(search);
    };
    // Playwright can hand a window over after the next action has returned,
    // and the action running then reports it, so gather a few actions' worth.
    const gather = async (searches: string[]) => {
      const popups: unknown[] = [];
      const missing = () => searches.some((search) => !JSON.stringify(popups).includes(search));
      for (let attempt = 0; attempt < 10 && missing(); attempt += 1) {
        popups.push(...(((await run({ action: "inspect" })).popups as unknown[] | undefined) ?? []));
        if (missing()) await new Promise((done) => setTimeout(done, 300));
      }
      return popups;
    };
    // Reported as opened between actions, and closed.
    const reported = async (searches: string[]) => {
      const popups = await gather(searches);
      expect(popups).toEqual(
        expect.arrayContaining(
          searches.map((search) =>
            expect.objectContaining({ url: expect.stringContaining(search), blocked: true, betweenActions: true }),
          ),
        ),
      );
      const listed = await open();
      for (const search of searches) expect(listed, search).not.toContain(search);
      return popups;
    };
    try {
      // Tabs the operator opened before the runtime attached, one from
      // another, stay theirs, and so does what they open afterwards.
      await first.evaluate((url) => window.open(url), `${origin}/?pre1`);
      await requested("?pre2");
      // A read lands on one of the operator's tabs, which does not make it the
      // runtime's: what the operator opens from it stays theirs. Which tab it
      // lands on follows the order Chromium announced them in, so each tab
      // that was there opens one, and the one landed on is used below.
      const read = (await run({ action: "tabs" })) as { tabs: Array<{ url: string; active: boolean }> };
      const at = read.tabs.find((tab) => tab.active)!.url;
      await until("?pre1 and ?pre2 open", () =>
        ["?pre1", "?pre2"].every((search) => operator.pages().some((page) => page.url().includes(search))),
      );
      const there = [...operator.pages()];
      const landed = there.find((page) => page.url() === at)!;
      for (const [index, page] of there.entries()) await page.evaluate((url) => window.open(url), `${origin}/?prechild${index}`);
      for (const index of there.keys()) await leftAlone(`?prechild${index}`);
      await landed.evaluate((url) => window.open(url), `${origin}/?fromread`);
      await leftAlone("?fromread");
      // So does what it opens while a read on it runs, as between actions.
      type Run = (operation: unknown) => Promise<Record<string, unknown>>;
      const prototype = BrowserRuntime.prototype as unknown as { run: Run };
      const runOne = prototype.run;
      let reading = () => {};
      const readStarted = new Promise<void>((done) => (reading = done));
      const spy = vi.spyOn(prototype, "run").mockImplementation((operation) => {
        reading();
        return runOne.call(runtime, operation);
      });
      const waiting = run({ action: "wait", value: "readnow", timeoutMs: 15_000 });
      await readStarted;
      spy.mockRestore();
      await landed.evaluate((url) => window.open(url), `${origin}/?duringread`);
      await requested("?duringread");
      await landed.evaluate(() => document.body.append("readnow"));
      await leftAlone("?duringread", [...(((await waiting).popups as unknown[] | undefined) ?? [])]);
      // Nor does an action on it that is refused, or whose target is never
      // found: nothing reached the tab.
      await expect(run({ action: "navigate", url: "http://example.com/" })).rejects.toThrow();
      await expect(run({ action: "click", target: { selector: "#nothing" }, timeoutMs: 500 })).rejects.toThrow();
      await landed.evaluate((url) => window.open(url), `${origin}/?afterrefusal`);
      await leftAlone("?afterrefusal");
      // So does a step back refused before it was sent.
      await expect(run({ action: "back", url: `${origin}/elsewhere` })).rejects.toThrow("browser_page_not_at_url");
      await landed.evaluate((url) => window.open(url), `${origin}/?afterback`);
      await leftAlone("?afterback");
      await run({ action: "tab_new", url: origin });
      // A tab the operator opens between the runtime's actions is theirs.
      const mine = await operator.newPage();
      await mine.goto(`${origin}/?mine`);
      await leftAlone("?mine");
      expect(mine.isClosed()).toBe(false);
      // One of theirs whose first response never comes holds up none of the
      // actions after it.
      await mine.evaluate((url) => {
        (window as unknown as { stuck: Window | null }).stuck = window.open(url);
      }, hungUrl);
      await until("the hung window requested", () => hung.length > 0);
      const unheld = Date.now();
      await run({ action: "inspect", timeoutMs: 5_000 });
      expect(Date.now() - unheld).toBeLessThan(2_500);
      // Nor once they close it: a slow popup of the runtime's own is still
      // waited for, and reported by the action that opened it.
      await mine.evaluate(() => (window as unknown as { stuck: Window }).stuck.close());
      await until("the hung window closed", () => hungClosed);
      const slowPopup = slowUrl.replace("?slow", "?slowpop");
      await run({ action: "navigate", url: `${origin}/?after&busy=${encodeURIComponent(slowPopup)}` });
      const waited = await run({ action: "click", target: { selector: "#busy" }, timeoutMs: 10_000 });
      expect(JSON.stringify(waited.popups ?? [])).toContain("?slowpop");
      // So is one they open just before the runtime's next action, though
      // Playwright only hands it over during that action, once it loads.
      await mine.evaluate((url) => window.open(url), slowUrl);
      await new Promise((done) => setTimeout(done, 300));
      const during = await run({ action: "navigate", url: slowUrl.replace("?slow", "?self") });
      await leftAlone("?slow", [...((during.popups as unknown[] | undefined) ?? [])]);
      // While an action runs, a tab the operator opens blank and a window
      // their tab opens stay theirs. What the agent's page opens meanwhile is
      // the action's popup, and so is a tab with no opener created at a web
      // address, as a sign-in window the browser opens for a page is. The
      // action is a navigation held until all four exist.
      await run({ action: "navigate", url: `${origin}/?inaction` });
      const navigating = run({ action: "navigate", url: `${origin}/?held` });
      navigating.catch(() => undefined);
      await requested("?held");
      const opened = await operator.newPage();
      await mine.evaluate((url) => window.open(url), `${origin}/?opchild`);
      await requested("?opchild");
      await fetch(`http://127.0.0.1:${port}/json/new?${origin}/?webtab`, { method: "PUT" });
      await requested("?webtab");
      await release();
      await requested("?agentpop");
      loading.splice(0).forEach((answer) => answer());
      const inAction = ((await navigating).popups as unknown[] | undefined) ?? [];
      expect(inAction).toHaveLength(2);
      expect(inAction).toEqual(
        expect.arrayContaining(
          ["?agentpop", "?webtab"].map((search) =>
            expect.objectContaining({ url: expect.stringContaining(search), blocked: true }),
          ),
        ),
      );
      expect(JSON.stringify(inAction)).not.toContain("betweenActions");
      expect(opened.isClosed()).toBe(false);
      await opened.goto(`${origin}/?optab`);
      await leftAlone("?optab", [...inAction]);
      await leftAlone("?opchild", [...inAction]);
      // Windows the runtime's own page opens between actions are its own,
      // down a chain of them, whose opener has closed by the time Playwright
      // hands over the next, and whatever the page cut it off from; reported
      // without the fragment, where a console keeps its pairing code.
      for (const [path, ...windows] of [["?opens", "?popup"], ["?chain", "?p1", "?p2"], ["?noopener", "?np"]]) {
        await run({ action: "navigate", url: `${origin}/${path}` });
        await release();
        await requested(windows.at(-1)!);
        const popups = await reported(windows);
        expect(JSON.stringify(popups)).not.toContain("#");
      }
      // Windows that close themselves as soon as they load are still reported,
      // all ten: one that closed before its first page committed has no
      // address to report, so they are counted rather than named.
      await run({ action: "navigate", url: `${origin}/?selfclose` });
      await release();
      await requested("?closes9");
      const closing: unknown[] = [];
      await until("ten self-closing windows reported", async () => {
        closing.push(...(((await run({ action: "inspect" })).popups as unknown[] | undefined) ?? []));
        return closing.length >= 10;
      });
      expect(closing).toHaveLength(10);
      expect(closing).toEqual(Array.from({ length: 10 }, () => expect.objectContaining({ blocked: true })));
      // A window whose page is busy as it loads holds up nothing.
      await run({ action: "navigate", url: `${origin}/?busy=${encodeURIComponent(heavyUrl)}` });
      const busy = await run({ action: "click", target: { selector: "#busy" }, timeoutMs: 2_500 });
      expect(JSON.stringify(busy.popups ?? [])).toContain("?busyload");
      // A tab a link opens with a modifier click has no opener to judge it by,
      // so between actions it is taken for the operator's, whoever clicked:
      // left open and not reported, but still listed.
      await run({ action: "navigate", url: origin });
      await run({ action: "click", target: { selector: "#mod" } });
      await release();
      await leftAlone("?linked");
      // An action cancelled midway leaves nothing stale behind for the
      // windows that come after it.
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(), 600);
      await expect(
        runtime.execute(BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url: `${origin}/?busy` }), cancel.signal),
      ).rejects.toThrow();
      await release();
      await requested("?busypop");
      await reported(["?busypop"]);
      // A tab of the operator's the runtime switches to is its own only once
      // it drives the tab, and only while that tab stays active.
      const tabs = ((await run({ action: "tabs" })) as { tabs: Array<{ url: string }> }).tabs;
      await run({ action: "tab_switch", tabIndex: tabs.findIndex((tab) => tab.url.includes("?mine")) });
      await mine.evaluate((url) => window.open(url), `${origin}/?undriven`);
      await leftAlone("?undriven");
      // What it opens while an action on it runs is that action's, though the
      // runtime had not driven it before.
      const clicked = ((await run({ action: "click", target: { selector: "#pop" } })).popups as unknown[] | undefined) ?? [];
      expect(clicked).toEqual([expect.objectContaining({ url: expect.stringContaining("?clickpop"), blocked: true })]);
      asked.length = 0;
      await run({ action: "navigate", url: `${origin}/?opens` });
      await release();
      await requested("?popup");
      await reported(["?popup"]);
      // Switching to it again leaves it driven: it is still the active tab.
      const again = ((await run({ action: "tabs" })) as { tabs: Array<{ url: string }> }).tabs;
      await run({ action: "tab_switch", tabIndex: again.findIndex((tab) => tab.url.includes("?opens")) });
      await mine.evaluate((url) => window.open(url), `${origin}/?again`);
      await requested("?again");
      await reported(["?again"]);
      await run({ action: "tab_new", url: origin });
      await mine.evaluate(() => window.open(`${location.origin}/?later`));
      await leftAlone("?later");
      // A window handed over while the runtime opens a tab of its own is
      // judged like any other: one at a web address is that action's popup,
      // and so is each window the agent's page opens then, closed or not.
      const context = (runtime as unknown as { context: BrowserContext }).context;
      const agent = (runtime as unknown as { activePage: Page }).activePage;
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        context.newPage = newPage;
        let seen = 0;
        const handed = new Promise<void>((done) => {
          const counted = () => {
            seen += 1;
            if (seen < 6) return;
            context.off("page", counted);
            done();
          };
          context.on("page", counted);
        });
        await fetch(`http://127.0.0.1:${port}/json/new?${origin}/?duringnew`, { method: "PUT" });
        await agent.evaluate((url) => [0, 1, 2, 3, 4].forEach((i) => window.open(url + i)), `${origin}/?closes`);
        await handed;
        return await newPage();
      };
      const opening = ((await run({ action: "tab_new" })).popups as unknown[] | undefined) ?? [];
      expect(opening).toHaveLength(6);
      expect(opening).toEqual(expect.arrayContaining([expect.objectContaining({ url: expect.stringContaining("?duringnew") })]));
      expect(opening).toEqual(Array.from({ length: 6 }, () => expect.objectContaining({ blocked: true })));
    } finally {
      answerAll();
      loading.splice(0).forEach((answer) => answer());
      hung.splice(0).forEach((answer) => answer());
      await runtime.close();
      await operator.close();
    }
  }, 180_000);

  it("closes its tabs freely in a browser it launched, where no operator's console can be", async () => {
    const context = await fixture(`<!doctype html><html><head><meta name="${APPROVAL_SURFACE}" content="operator-only">
      <title>marked</title></head><body></body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url });
      await run({ action: "tab_new", url });
      await run({ action: "tab_new" });
      // Two marked tabs beside it hold nothing open.
      expect(await run({ action: "close" })).toMatchObject({ closed: true });
      expect(await run({ action: "close", tabIndex: 1 })).toMatchObject({ closed: true });
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("closes a tab whose page no longer answers", async () => {
    // It hangs well after navigate has read it, so only the close meets it hung.
    const context = await fixture(`<!doctype html><title>hung</title><script>setTimeout(() => { for (;;) {} }, 1_500)</script>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url });
      await new Promise((done) => setTimeout(done, 2_000));
      // Closing is how an agent gets rid of a wedged tab, so it asks the page nothing.
      expect(await run({ action: "close", timeoutMs: 3_000 })).toMatchObject({ closed: true });
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("never reads back what was typed into a secret field", async () => {
    // Fields that hold secrets, on a page that mirrors each keystroke into the
    // markup the way React's controlled inputs do, laid out so that a cell's
    // accessible name is built from the password field inside it.
    const context = await fixture(`<!doctype html><html><body><form id="login"><table><tr>
      <td>Password</td><td><input name="password" type="password"></td></tr></table>
      <input name="pin" type="text" style="-webkit-text-security: disc">
      <input name="country" type="text" autocomplete="new-password">
      <textarea name="phrase" style="-webkit-text-security: disc"></textarea>
      <input name="user"><input type="submit" value="Go">
    </form><script>
      for (const field of document.querySelectorAll("input, textarea")) {
        field.addEventListener("input", () => { field.defaultValue = field.value; });
      }
    </script></body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url });
      // Nothing secret entered yet: an ordinary value selector reads.
      await run({ action: "inspect", target: { selector: "input[type=submit][value=Go]" } });
      // A field that shows what is typed, whatever its autocomplete says to
      // keep autofill away, is not hiding anything.
      await run({ action: "type", target: { selector: 'input[name="country"]' }, value: "India" });
      await run({ action: "wait", target: { selector: 'input[name="country"]' }, state: "attached" });
      const fields = [["password", "input"], ["pin", "input"], ["phrase", "textarea"], ["user", "input"]];
      for (const [name, tag] of fields) {
        await run({ action: "type", target: { selector: `${tag}[name="${name}"]` }, value: name === "user" ? "alice" : `s3cret-${name}` });
      }
      const whole = JSON.stringify(await run({ action: "inspect" }));
      expect(whole).not.toMatch(/s3cret/);
      expect(whole).toContain("alice");
      // Whether a target exists could be made to depend on the secret, so no
      // read aims at part of the page now, whatever it names.
      for (const target of [{ selector: "#login" }, { role: "cell" }]) {
        await expect(run({ action: "inspect", target })).rejects.toThrow("browser_secret_field_filled");
        await expect(run({ action: "wait", target, state: "attached", timeoutMs: 1_000 })).rejects.toThrow(
          "browser_secret_field_filled",
        );
        await expect(run({ action: "scroll", direction: "into_view", target })).rejects.toThrow(
          "browser_secret_field_filled",
        );
        await expect(run({ action: "screenshot", target })).rejects.toThrow("browser_secret_field_filled");
      }
      // Every secret field emptied again, targeted reads come back.
      for (const [name, tag] of fields.slice(0, 2)) {
        await run({ action: "type", target: { selector: `${tag}[name="${name}"]` }, value: "" });
      }
      await expect(run({ action: "inspect", target: { selector: "#login" } })).rejects.toThrow("browser_secret_field_filled");
      await run({ action: "type", target: { selector: 'textarea[name="phrase"]' }, value: "" });
      expect(JSON.stringify(await run({ action: "inspect", target: { selector: "#login" } }))).toContain("alice");
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("counts a secret still in the markup after the field was cleared", async () => {
    // Values rendered by the server, then cleared through the property only:
    // the live value is empty, but a target can still match the attribute or
    // the textarea's text, so its existence would still guess the secret.
    const context = await fixture(`<!doctype html><html><body><form id="login">
      <input name="password" type="password" value="s3cret-rendered">
      <textarea name="phrase" style="-webkit-text-security: disc">s3cret-text</textarea>
    </form><script>
      for (const field of document.querySelectorAll("input, textarea")) field.value = "";
    </script></body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url });
      expect(JSON.stringify(await run({ action: "inspect" }))).not.toMatch(/s3cret/);
      for (const selector of ['input[type=password][value^="s3"]', 'textarea:has-text("s3cret")', "#login"]) {
        await expect(run({ action: "inspect", target: { selector } })).rejects.toThrow("browser_secret_field_filled");
      }
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("waits through a page that keeps navigating itself, where no secret is filled", async () => {
    // Each hop destroys the document a secret check may be reading; a check
    // that counted that as a secret refused this wait on a page with none.
    const context = await fixture(`<!doctype html><html><body><script>
      const hop = Number(new URLSearchParams(location.search).get("hop") ?? 0);
      if (hop < 80) setTimeout(() => { location.search = "?hop=" + (hop + 1); }, 20);
      else document.body.insertAdjacentHTML("beforeend", '<p id="done">here</p>');
    </script></body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }));
      const waited = await runtime.execute(
        BrowserOperationSchema.parse({
          kind: "browser",
          action: "wait",
          target: { selector: "#done" },
          state: "attached",
          timeoutMs: 60_000,
        }),
      );
      expect(waited.success).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("looks for nothing while a secret field is filled, and refuses a wait still facing one at its end", async () => {
    const context = await fixture(`<!doctype html><html><body><input name="password" type="password"><script>
      setTimeout(() => { document.querySelector("input").value = "s3cret-late"; }, 400);
    </script></body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }));
      const started = Date.now();
      await expect(
        runtime.execute(
          BrowserOperationSchema.parse({
            kind: "browser",
            action: "wait",
            target: { selector: "#never" },
            state: "attached",
            timeoutMs: 1_500,
          }),
        ),
      ).rejects.toThrow("browser_secret_field_filled");
      // At its end, not on the first poll that met the field.
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("waits out a filled sign-in form until the page replaces it", async () => {
    const context = await fixture(`<!doctype html><html><body><form><input type="password" value="s3cret"></form><script>
      setTimeout(() => { document.body.innerHTML = '<p id="welcome">signed in</p>'; }, 800);
    </script></body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }));
      const waited = await runtime.execute(
        BrowserOperationSchema.parse({
          kind: "browser",
          action: "wait",
          target: { selector: "#welcome" },
          state: "visible",
          timeoutMs: 10_000,
        }),
      );
      expect(waited.success).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("waits through a target whose document reloads under it", async () => {
    // Forty quick reloads, the target on every one: a poll that lands on one
    // decides nothing, and each wait ends once a poll gets through.
    const context = await fixture(`<!doctype html><html><body><p id="here">here</p><script>
      const n = Number(sessionStorage.getItem("n") ?? 0);
      if (n < 40) { sessionStorage.setItem("n", String(n + 1)); setTimeout(() => location.reload(), 30); }
    </script></body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }));
      // While it reloads: a poll that lands on a reload says nothing about
      // hidden, so a target on every document never reads as hidden. Which
      // refusal ends the wait depends on where its last poll lands: on a
      // reload, the secret check after it could not answer either (#236).
      await expect(
        runtime.execute(
          BrowserOperationSchema.parse({
            kind: "browser",
            action: "wait",
            target: { selector: "#here" },
            state: "hidden",
            timeoutMs: 1_200,
          }),
        ),
      ).rejects.toThrow(/^browser_(wait_timeout|secret_check_unavailable)/);
      for (let round = 0; round < 15; round += 1) {
        const waited = await runtime.execute(
          BrowserOperationSchema.parse({
            kind: "browser",
            action: "wait",
            target: { selector: "#here" },
            state: "visible",
            timeoutMs: 20_000,
          }),
        );
        expect(waited.success).toBe(true);
      }
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("drops what a read found if a secret field was filled while it looked", async () => {
    const context = await fixture(`<!doctype html><html><body><p id="here">here</p></body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url });
      // As if a field were filled just after each read's first check.
      const answers = (page: Page) => [{ state: "clear", read: new Set(page.frames()) }, { state: "filled", read: new Set() }];
      let queue: Array<{ state: string; read: ReadonlySet<unknown> }> = [];
      (runtime as unknown as { secretFieldFilled: (page: Page) => Promise<unknown> }).secretFieldFilled = async (page) =>
        (queue.length > 0 ? queue : (queue = answers(page))).shift();
      // Found or not: the answer must not depend on what the search met.
      for (const selector of ["#here", "#absent"]) {
        queue = [];
        await expect(run({ action: "inspect", target: { selector } })).rejects.toThrow("browser_secret_field_filled");
        queue = [];
        await expect(run({ action: "scroll", direction: "into_view", target: { selector } })).rejects.toThrow(
          "browser_secret_field_filled",
        );
        queue = [];
        await expect(run({ action: "wait", target: { selector }, state: "attached", timeoutMs: 600 })).rejects.toThrow(
          "browser_secret_field_filled",
        );
      }
      // Nor on a search that fails outright.
      queue = [];
      await expect(
        run({ action: "wait", target: { selector: "xpath=//*[" }, state: "attached", timeoutMs: 600 }),
      ).rejects.toThrow("browser_secret_field_filled");
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("fails a wait on a selector that cannot parse at once, whatever its text says", async () => {
    const context = await fixture(`<!doctype html><html><body><p>page</p></body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }));
      for (const selector of ["#navigation-detached[", "[data-x='frame was detached'", "xpath=//*[@x='frame was detached'"]) {
        const started = Date.now();
        const failed = await runtime
          .execute(
            BrowserOperationSchema.parse({ kind: "browser", action: "wait", target: { selector }, state: "attached", timeoutMs: 20_000 }),
          )
          .then(() => "", (error: Error) => error.message);
        expect(failed).not.toContain("browser_wait_timeout");
        expect(Date.now() - started).toBeLessThan(10_000);
      }
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("refuses a targeted read aimed at another page before looking at the page it is on", async () => {
    const context = await fixture(`<!doctype html><html><body><input type="password" value="s3cret"><p id="here">here</p></body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url });
      for (const action of [{ action: "inspect" }, { action: "scroll", direction: "into_view" }, { action: "screenshot" }]) {
        await expect(run({ ...action, target: { selector: "#here" }, url: "http://127.0.0.1:1/elsewhere" })).rejects.toThrow(
          "browser_page_not_at_url",
        );
      }
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("refuses, and does not wait out, a read whose secret-field check gets no answer", async () => {
    const context = await fixture(`<!doctype html><html><body><p id="here">here</p></body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url });
      // As if some frame never answered: "unknown" is not "clear".
      (runtime as unknown as { secretFieldFilled: () => Promise<unknown> }).secretFieldFilled = async () => ({
        state: "unknown",
        read: new Set(),
      });
      await expect(run({ action: "inspect", target: { selector: "#here" } })).rejects.toThrow(
        "browser_secret_check_unavailable",
      );
      // Nothing resolves on a poll that could not look, not even absence.
      const started = Date.now();
      await expect(
        run({ action: "wait", target: { selector: "#gone" }, state: "hidden", timeoutMs: 800 }),
      ).rejects.toThrow("browser_secret_check_unavailable");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("looks for a checked read's target only in the frames its check read", async () => {
    const context = await fixture(
      `<!doctype html><html><body><iframe srcdoc="<p id='inner'>inner</p>"></iframe></body></html>`,
    );
    if (context === undefined) return;
    const { runtime, url } = context;
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url });
      for (const target of [{ selector: "#inner" }, { role: "paragraph" }]) {
        await expect(run({ action: "inspect", target })).resolves.toMatchObject({ text: "inner" });
      }
      // As if the check had read the main document only.
      (runtime as unknown as { secretFieldFilled: (page: Page) => Promise<unknown> }).secretFieldFilled = async (
        page,
      ) => ({ state: "clear", read: new Set([page.mainFrame()]) });
      for (const target of [{ selector: "#inner" }, { role: "paragraph" }]) {
        await expect(run({ action: "inspect", target })).rejects.toThrow("browser_target_not_found");
      }
      await expect(
        run({ action: "scroll", direction: "into_view", target: { selector: "#inner" } }),
      ).rejects.toThrow("browser_target_not_found");
      await expect(
        run({ action: "wait", target: { selector: "#inner" }, state: "attached", timeoutMs: 800 }),
      ).rejects.toThrow("browser_wait_timeout");
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("stops a targeted wait as soon as its task is cancelled", async () => {
    const context = await fixture(`<!doctype html><html><body><p>nothing to find</p></body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }));
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("task_cancelled")), 300);
      const started = Date.now();
      await expect(
        runtime.execute(
          BrowserOperationSchema.parse({
            kind: "browser",
            action: "wait",
            target: { selector: "#never" },
            state: "attached",
            timeoutMs: 20_000,
          }),
          controller.signal,
        ),
      ).rejects.toThrow("task_cancelled");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("reads past iframes that have no page yet, and refuses only when a page cannot answer", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    // "/" embeds an iframe whose source never answers and a lazy one far below
    // the fold; "/busy" embeds, from another site, a page that never yields.
    const server = createServer((request, response) => {
      if (request.url === "/never") return;
      const body =
        request.url === "/spin"
          ? "<script>for (;;) {}</script>"
          : request.url === "/busy"
            ? `<p id="here">here</p><iframe src="http://localhost:${(server.address() as { port: number }).port}/spin"></iframe>`
            : `<p id="here">here</p><iframe src="/never"></iframe><div style="height: 9000px"></div><iframe loading="lazy" src="/x"></iframe>`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><body>${body}</body></html>`);
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const root = await mkdtemp(join(tmpdir(), "melra-see-act-"));
    roots.push(root);
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      executablePath,
      allowedDomains: ["127.0.0.1", "localhost"],
      allowLocalhost: true,
    });
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url: origin, timeoutMs: 5_000 });
      // The check passes those frames by at once; what follows a successful
      // wait (its snapshot) still waits them out, as it always has.
      let started = Date.now();
      await run({ action: "inspect", target: { selector: "#here" }, timeoutMs: 4_000 });
      expect(Date.now() - started).toBeLessThan(3_000);
      await run({ action: "wait", target: { selector: "#here" }, state: "visible", timeoutMs: 4_000 });
      await run({ action: "navigate", url: `${origin}/busy`, timeoutMs: 5_000 }).catch(() => undefined);
      started = Date.now();
      await expect(run({ action: "inspect", target: { selector: "#here" }, timeoutMs: 2_000 })).rejects.toThrow(
        "browser_secret_check_unavailable",
      );
      await expect(
        run({ action: "wait", target: { selector: "#here" }, state: "visible", timeoutMs: 2_000 }),
      ).rejects.toThrow("browser_secret_check_unavailable");
      // Each within about its own timeout, not twice it.
      expect(Date.now() - started).toBeLessThan(9_000);
    } finally {
      await runtime.close();
      server.closeAllConnections();
    }
  }, 120_000);

  it("matches text through surrounding whitespace instead of failing exact", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(
        BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }),
      );
      // `<button> Sign in </button>` never matched `getByText("Sign in", {exact:true})`.
      const clicked = await runtime.execute(
        BrowserOperationSchema.parse({
          kind: "browser",
          action: "click",
          target: { text: "Sign in" },
        }),
      );
      expect(clicked.clicked).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("reports a target that matches nothing instead of timing out opaquely", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(
        BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }),
      );
      await expect(
        runtime.execute(
          BrowserOperationSchema.parse({
            kind: "browser",
            action: "click",
            target: { selector: "#nothing-here" },
            timeoutMs: 120_000,
          }),
        ),
      ).rejects.toThrow("browser_target_not_found");
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("scopes extraction to a target rather than returning the whole page", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(
        BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }),
      );
      const extracted = await runtime.execute(
        BrowserOperationSchema.parse({
          kind: "browser",
          action: "inspect",
          target: { selector: "#cart" },
        }),
      );
      expect(extracted.text).toBe("2 items");
      expect(extracted.html).toBe("<p>2 items</p>");
      expect(extracted.text).not.toContain("Total");
    } finally {
      await runtime.close();
    }
  }, 120_000);
});
