// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserOperationSchema } from "@melra/protocol";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserRuntime, detectBrowserExecutable } from "./index.js";

/**
 * Two gaps, both invisible to the caller. A click that spawned a window
 * returned plain success while the window sat there holding focus and a
 * session, and every run started from an empty profile, so a site that had
 * been logged into had to be logged into again on the next task.
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
}

interface Popup {
  url: string;
  blocked: boolean;
}

/**
 * `/` opens a window on click; `/set` plants a cookie; `/read` reports whether
 * the cookie survived. One server covers both halves of this file. `/slow`
 * answers late, because Playwright only announces a popup once its first
 * response has arrived — long after the opener's DOM has gone quiet.
 */
async function serve(): Promise<string> {
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/set") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "melra=kept; Path=/; Max-Age=3600",
      });
      response.end("<!doctype html><title>set</title><body>set</body>");
      return;
    }
    if (path === "/slow") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>slow</title><body>slow</body>");
      }, 1_500);
      return;
    }
    if (path === "/read") {
      const seen = (request.headers.cookie ?? "").includes("melra=kept");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><title>read</title><body><div id="cookie">${seen ? "kept" : "gone"}</div></body>`,
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><title>opener</title><body>
<button id="pop">Open</button>
<button id="slow">Open slowly</button>
<script>
  document.getElementById('pop').addEventListener('click', () => {
    window.open('/read', '_blank');
  });
  document.getElementById('slow').addEventListener('click', () => {
    window.open('/slow', '_blank');
  });
</script>
</body>`,
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
  return `http://127.0.0.1:${address.port}`;
}

async function root(name: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), `melra-${name}-`));
  roots.push(created);
  return created;
}

const runtime = (
  workspaceRoot: string,
  executablePath: string,
  extra: Record<string, unknown> = {},
): BrowserRuntime =>
  new BrowserRuntime({
    workspaceRoot,
    artifactDirectory: join(workspaceRoot, "artifacts"),
    executablePath,
    allowedDomains: ["127.0.0.1"],
    allowLocalhost: true,
    ...extra,
  });

const op = (fields: Record<string, unknown>) =>
  BrowserOperationSchema.parse({ kind: "browser", ...fields });

describe("browser popups", () => {
  it("reports the window a page opened and closes it by default", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const url = await serve();
    const session = runtime(await root("popup-block"), executablePath);
    try {
      await session.execute(op({ action: "navigate", url }));
      const clicked = await session.execute(
        op({ action: "click", target: { selector: "#pop" } }),
      );

      // The point: the caller is told what the click opened behind it.
      expect(clicked.popups).toEqual([
        expect.objectContaining({ url: `${url}/read`, blocked: true }),
      ]);

      // And it is gone by the time the next action runs, not eventually.
      const tabs = await session.execute(op({ action: "tabs" }));
      expect((tabs.tabs as Tab[]).length).toBe(1);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("reports a window whose page answers after the opener has settled", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const url = await serve();
    const session = runtime(await root("popup-slow"), executablePath);
    try {
      await session.execute(op({ action: "navigate", url }));
      // The opener is quiet within its 180ms settle window; the popup's
      // response takes 1.5s. That gap is the Windows CI flake made certain.
      const clicked = await session.execute(
        op({ action: "click", target: { selector: "#slow" } }),
      );
      expect(clicked.popups).toEqual([
        expect.objectContaining({ url: `${url}/slow`, blocked: true }),
      ]);

      // Reported and closed by the click itself, so the next action neither
      // inherits the report nor sees the window.
      const tabs = await session.execute(op({ action: "tabs" }));
      expect(tabs.popups).toBeUndefined();
      expect((tabs.tabs as Tab[]).length).toBe(1);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("keeps the window as an addressable tab when popups are allowed", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const url = await serve();
    const session = runtime(await root("popup-allow"), executablePath, {
      popups: "allow",
    });
    try {
      await session.execute(op({ action: "navigate", url }));
      // The window left open is owed no longer once it is handed over (#234),
      // so the click does not wait out its timeoutMs for it.
      const started = Date.now();
      const clicked = await session.execute(
        op({ action: "click", target: { selector: "#pop" }, timeoutMs: 10_000 }),
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      expect((clicked.popups as Popup[])[0]?.blocked).toBe(false);
      const tabs = await session.execute(op({ action: "tabs" }));
      expect((tabs.tabs as Tab[]).length).toBe(2);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("does not mistake a tab the caller asked for for a popup", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const url = await serve();
    const session = runtime(await root("popup-tab-new"), executablePath);
    try {
      await session.execute(op({ action: "navigate", url }));
      // Both arrive as the same `page` event. If this were treated as a popup,
      // `tab_new` would close the tab it just opened.
      const opened = await session.execute(
        op({ action: "tab_new", url: `${url}/read` }),
      );
      expect(opened.popups).toBeUndefined();
      expect((await session.execute(op({ action: "tabs" }))).tabs).toHaveLength(2);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("closes and reports a popup handed over while tab_new is opening its tab", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const url = await serve();
    const session = runtime(await root("popup-tab-new-race"), executablePath);
    try {
      await session.execute(op({ action: "navigate", url }));
      const internals = session as unknown as { context: BrowserContext; activePage: Page };
      const context = internals.context;
      const realNewPage = context.newPage.bind(context);
      // The page opens a window, handed over (and so held) before `newPage`
      // goes on to open the tab.
      context.newPage = async () => {
        const handed = new Promise((done) => context.once("page", done));
        await internals.activePage.evaluate(() => window.open("/read", "_blank"));
        await handed;
        return await realNewPage();
      };

      // No url, so nothing after the tab opens gives the close time to land.
      // And the popup held is counted, so tab_new does not wait for it (#226).
      const started = Date.now();
      const opened = await session.execute(op({ action: "tab_new", timeoutMs: 10_000 }));
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(opened.popups).toEqual([
        expect.objectContaining({ url: `${url}/read`, blocked: true }),
      ]);
      // The same result's tab list no longer has the popup it reports closed.
      expect(opened.index).toBe(1);
      expect((opened.tabs as Tab[]).map((tab) => tab.url)).toEqual([`${url}/`, "about:blank"]);
      const tabs = await session.execute(op({ action: "tabs" }));
      expect((tabs.tabs as Tab[]).length).toBe(2);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("reports and closes the popups held while tab_new opened its tab, when that fails", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const url = await serve();
    const session = runtime(await root("popup-tab-new-fails"), executablePath);
    try {
      await session.execute(op({ action: "navigate", url }));
      const internals = session as unknown as { context: BrowserContext; activePage: Page };
      const context = internals.context;
      const realNewPage = context.newPage.bind(context);
      context.newPage = async () => {
        const handed = new Promise((done) => context.once("page", done));
        await internals.activePage.evaluate(() => window.open("/read", "_blank"));
        await handed;
        throw new Error("new_page_failed");
      };
      await expect(session.execute(op({ action: "tab_new" }))).rejects.toThrow("new_page_failed");
      context.newPage = realNewPage;

      // The failed action could not report it; the next one does.
      const next = await session.execute(op({ action: "tabs" }));
      expect(next.popups).toEqual([
        expect.objectContaining({ url: `${url}/read`, blocked: true }),
      ]);
      const tabs = await session.execute(op({ action: "tabs" }));
      expect((tabs.tabs as Tab[]).map((tab) => tab.url)).toEqual([`${url}/`]);

      // Nor is the tab it was opening reported when that tab dies while
      // Playwright sets it up: Playwright hands it over closed, then rejects.
      const targets = (session as unknown as { targets: CDPSession }).targets;
      const handed: Page[] = [];
      const collect = (page: Page) => void handed.push(page);
      const kill = ({ targetInfo }: { targetInfo: { targetId: string; type: string } }) => {
        if (targetInfo.type === "page") void targets.send("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => undefined);
      };
      context.on("page", collect);
      targets.on("Target.targetCreated", kill);
      await expect(session.execute(op({ action: "tab_new" }))).rejects.toThrow();
      targets.off("Target.targetCreated", kill);
      context.off("page", collect);
      expect(handed.map((page) => page.isClosed())).toEqual([true]);
      const quiet = await session.execute(op({ action: "tabs" }));
      expect(quiet.popups).toBeUndefined();
      expect((quiet.tabs as Tab[]).map((tab) => tab.url)).toEqual([`${url}/`]);
    } finally {
      await session.close();
    }
  }, 120_000);
});

describe("persistent browser profile", () => {
  it("keeps a cookie across two sessions, and drops it without a profile", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const url = await serve();
    const workspace = await root("profile");
    const userDataDir = join(workspace, "profile");

    const read = async (extra: Record<string, unknown>): Promise<string> => {
      const session = runtime(workspace, executablePath, extra);
      try {
        await session.execute(op({ action: "navigate", url: `${url}/read` }));
        const seen = await session.execute(
          op({ action: "inspect", target: { selector: "#cookie" } }),
        );
        return String(seen.text ?? "").trim();
      } finally {
        await session.close();
      }
    };

    const first = runtime(workspace, executablePath, { userDataDir });
    try {
      await first.execute(op({ action: "navigate", url: `${url}/set` }));
    } finally {
      await first.close();
    }

    expect(await read({ userDataDir })).toBe("kept");
    // The default is still a throwaway profile, so nothing leaked into it.
    expect(await read({})).toBe("gone");
  }, 180_000);
});
