// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  title: string;
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
      allowedDomains: ["127.0.0.1"],
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
