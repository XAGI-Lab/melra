// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { BrowserOperationSchema } from "@melra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserRuntime, detectBrowserExecutable } from "./index.js";

/**
 * A session could only ever move forward, in one tab. There was no `back`, so a
 * wrong click was unrecoverable without re-navigating from scratch, and `tabs`
 * reported which page was `active` while nothing could change it — the
 * `tabIndex` schema field existed but was read only by `close`.
 */
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

interface Tab {
  index: number;
  url: string;
  title: string | null;
  active: boolean;
}

/** Serves /one, /two, /three, each naming itself in the title and body. */
async function fixture(): Promise<{ runtime: BrowserRuntime; url: string } | undefined> {
  const executablePath = await detectBrowserExecutable();
  if (executablePath === undefined) return undefined;
  const pages = ["one", "two", "three"];
  const server = createServer((request, response) => {
    // Chosen from a fixed set rather than echoed back. The fixture only ever
    // needs these three, and reflecting the request path would make the
    // fixture itself the XSS sink a scanner reasonably flags.
    const requested = (request.url ?? "/").slice(1);
    const name = pages.includes(requested) ? requested : "one";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`,
    );
  });
  servers.push(server);
  await new Promise<void>((done) => {
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture_server_address_unavailable");
  }
  const root = await mkdtemp(join(tmpdir(), "melra-history-tabs-"));
  roots.push(root);
  return {
    runtime: new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      executablePath,
      allowedDomains: ["127.0.0.1", "localhost"],
      allowLocalhost: true,
    }),
    url: `http://127.0.0.1:${address.port}`,
  };
}

const op = (fields: Record<string, unknown>) =>
  BrowserOperationSchema.parse({ kind: "browser", ...fields });

describe("browser history", () => {
  it("moves back and forward through the history stack", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url: `${url}/one` }));
      await runtime.execute(op({ action: "navigate", url: `${url}/two` }));

      const back = await runtime.execute(op({ action: "back" }));
      expect(back.moved).toBe(true);
      expect(back.title).toBe("one");

      const forward = await runtime.execute(op({ action: "forward" }));
      expect(forward.moved).toBe(true);
      expect(forward.title).toBe("two");
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("reports a move with no HTTP response, and the end of the stack, differently", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url: `${url}/one` }));

      // A page starts on `about:blank`, which is a real history entry but
      // produces no HTTP response, so Playwright reports the same `null` it
      // reports for "nowhere to go". This moved.
      const blank = await runtime.execute(op({ action: "back" }));
      expect(blank.moved).toBe(true);
      expect(blank.status).toBe(null);
      expect(blank.url).toBe("about:blank");

      // Now there genuinely is nothing before it. "Go back unless already at
      // the start" is a normal thing to want, so this reports rather than
      // throws, and it must not look like the case above.
      const end = await runtime.execute(op({ action: "back" }));
      expect(end.moved).toBe(false);
      expect(end.url).toBe("about:blank");
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("reloads the current page in place", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url: `${url}/three` }));
      const reloaded = await runtime.execute(op({ action: "reload" }));
      expect(reloaded.status).toBe(200);
      expect(reloaded.url).toBe(`${url}/three`);
    } finally {
      await runtime.close();
    }
  }, 120_000);
});

describe("browser tabs", () => {
  it("opens a tab, switches between tabs, and closes one", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url: `${url}/one` }));

      const opened = await runtime.execute(
        op({ action: "tab_new", url: `${url}/two` }),
      );
      expect(opened.opened).toBe(true);
      expect(opened.index).toBe(1);
      // A new tab becomes the active one, so the next action lands on it.
      expect((await runtime.execute(op({ action: "inspect" }))).title).toBe("two");

      const switched = await runtime.execute(op({ action: "tab_switch", tabIndex: 0 }));
      expect(switched.switched).toBe(true);
      expect((switched.tabs as Tab[]).find((tab) => tab.active)?.index).toBe(0);
      expect((await runtime.execute(op({ action: "inspect" }))).title).toBe("one");

      const closed = await runtime.execute(op({ action: "close", tabIndex: 1 }));
      expect((closed.tabs as Tab[]).length).toBe(1);
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("reports tab_new and close as done while another tab cannot say its title", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      // Another site than the tab opened below, so its own renderer: the
      // stall holds this tab and nothing else, as a wedged page would.
      await runtime.execute(op({ action: "navigate", url: `${url.replace("127.0.0.1", "localhost")}/one` }));
      const stalled = (runtime as unknown as { activePage: Page }).activePage
        .evaluate(() => {
          const end = Date.now() + 10_000;
          while (Date.now() < end) {
            // Spin: the page answers nothing until it ends.
          }
        })
        .catch(() => undefined);
      // The listing after each effect named that tab's title, and waiting for
      // it failed an action that had already happened: `tab_new` was retried
      // as a read, opening another tab each time, and `close` was parked as
      // an unknown outcome.
      const opened = await runtime.execute(op({ action: "tab_new", url: `${url}/two`, timeoutMs: 3_000 }));
      expect(opened.index).toBe(1);
      expect(opened.index).toBe((opened.tabs as Tab[]).find((tab) => tab.active)?.index);
      expect((opened.tabs as Tab[]).map((tab) => tab.title)).toEqual([null, "two"]);
      const closed = await runtime.execute(op({ action: "close", tabIndex: 1, timeoutMs: 3_000 }));
      expect(closed.closed).toBe(true);
      expect(closed.tabs).toMatchObject([{ index: 0, title: null, active: true }]);
      await stalled;
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("reports the index its tab has in the list it returns when a tab closes during the listing", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    // The tab closes while the listing waits for its title, as one closed by
    // its page or by the operator can.
    const closeWhenListed = (page: Page) => {
      page.title = async () => {
        await page.close();
        return "";
      };
    };
    try {
      await runtime.execute(op({ action: "navigate", url: `${url}/one` }));
      await runtime.execute(op({ action: "tab_new", url: `${url}/two` }));
      await runtime.execute(op({ action: "tab_new", url: `${url}/three` }));
      const [one, two] = (runtime as unknown as { context: BrowserContext }).context.pages();
      // The index was taken before the listing and the list after it, so they
      // disagreed, and a `close` by that index closed the tab after this one.
      closeWhenListed(one!);
      const switched = await runtime.execute(op({ action: "tab_switch", tabIndex: 1 }));
      expect((switched.tabs as Tab[])[switched.index as number]).toMatchObject({ url: `${url}/two`, active: true });
      closeWhenListed(two!);
      const opened = await runtime.execute(op({ action: "tab_new", url: `${url}/one` }));
      expect((opened.tabs as Tab[])[opened.index as number]).toMatchObject({ url: `${url}/one`, active: true });
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("refuses a tab index that does not exist", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url: `${url}/one` }));
      await expect(
        runtime.execute(op({ action: "tab_switch", tabIndex: 7 })),
      ).rejects.toThrow("browser_tab_not_found");
      await expect(runtime.execute(op({ action: "tab_switch" }))).rejects.toThrow(
        "browser_tab_switch_requires_tab_index",
      );
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("blocks a disallowed domain when opening a tab", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url: `${url}/one` }));
      // `tab_new` takes a url, so it has to run the same guard `navigate` does
      // rather than becoming a way around the allowlist.
      await expect(
        runtime.execute(op({ action: "tab_new", url: "http://169.254.169.254/latest" })),
      ).rejects.toThrow();
    } finally {
      await runtime.close();
    }
  }, 120_000);
});
