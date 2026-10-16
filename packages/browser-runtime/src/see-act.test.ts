// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserOperationSchema } from "@melra/protocol";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
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
    const operatorConsole = await (await owner.newContext()).newPage();
    await operatorConsole.goto(context.url);
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
      cdpEndpoint: `http://127.0.0.1:${port}`,
    });
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      // A tab of its own, the active one: closing it could bring the console forward.
      expect(await run({ action: "tab_new" })).toMatchObject({ opened: true, index: 1 });
      await expect(run({ action: "close" })).rejects.toThrow("browser_refuses_approval_surface");
      await expect(run({ action: "close", tabIndex: 1 })).rejects.toThrow("browser_refuses_approval_surface");
      // A tab that is not there is just not there.
      await expect(run({ action: "close", tabIndex: 9 })).rejects.toThrow("browser_tab_not_found");
      // Two marked pages do not hold each other open: a console can always be closed.
      await run({ action: "navigate", url: context.url });
      expect(await run({ action: "close" })).toMatchObject({ closed: true });
      // Once the operator has closed the console, an unmarked tab closes too.
      expect(await run({ action: "tab_new" })).toMatchObject({ opened: true });
      await expect(run({ action: "close" })).rejects.toThrow("browser_refuses_approval_surface");
      await operatorConsole.close();
      expect(await run({ action: "close" })).toMatchObject({ closed: true, url: "about:blank" });
    } finally {
      await runtime.close();
      await owner.close();
    }
  }, 120_000);

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
    const context = await fixture(`<!doctype html><title>hung</title><script>setTimeout(() => { for (;;) {} }, 300)</script>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url });
      await new Promise((done) => setTimeout(done, 800));
      // Closing is how an agent gets rid of a wedged tab, so it asks the page nothing.
      expect(await run({ action: "close", timeoutMs: 3_000 })).toMatchObject({ closed: true });
    } finally {
      await runtime.close();
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
