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
      const clicked = await session.execute(
        op({ action: "click", target: { selector: "#pop" } }),
      );
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
      const context = (session as unknown as { context: { newPage: () => Promise<unknown> } }).context;
      const realNewPage = context.newPage.bind(context);
      context.newPage = async () => {
        const existingPage = (session as unknown as { activePage: { evaluate: (fn: () => void) => Promise<void> } }).activePage;
        await existingPage.evaluate(() => window.open("/read", "_blank"));
        await new Promise((done) => setTimeout(done, 150));
        return await realNewPage();
      };

      const opened = await session.execute(
        op({ action: "tab_new", url: `${url}/set` }),
      );
      expect(opened.popups).toEqual([
        expect.objectContaining({ url: `${url}/read`, blocked: true }),
      ]);
      const tabs = await session.execute(op({ action: "tabs" }));
      expect((tabs.tabs as Tab[]).length).toBe(2);
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
