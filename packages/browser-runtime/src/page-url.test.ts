// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserOperationSchema } from "@melra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserRuntime, detectBrowserExecutable, pageAddress } from "./index.js";

const PAGE = `<!doctype html><html><head><title>untouched</title></head><body>
  <button id="pay" onclick="document.title = 'paid'">Pay</button>
</body></html>`;

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("a url on an action that does not navigate", () => {
  it("compares the way Chrome and every supported Node spell a path", () => {
    expect(pageAddress("http://h/a|b?q#f")).toBe(pageAddress("http://h/a%7Cb"));
    expect(pageAddress("http://h/a^b")).toBe(pageAddress("http://h/a%5Eb"));
    // Nothing decoded: paths a server tells apart stay apart.
    expect(pageAddress("http://h/p%25FF")).not.toBe(pageAddress("http://h/p%FF"));
  });

  it("is the page the action must be on, or it does not happen", { timeout: 120_000 }, async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE);
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture_server_address_unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const root = await mkdtemp(join(tmpdir(), "melra-page-url-"));
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
    const title = async () => ((await run({ action: "inspect" })) as { title?: string }).title;
    try {
      await run({ action: "navigate", url: `${origin}/shop` });
      // The url policy showed and matched grants against is not where the click lands.
      await expect(
        run({ action: "click", target: { selector: "#pay" }, url: `${origin}/bank/transfer` }),
      ).rejects.toThrow("browser_page_not_at_url");
      expect(await title()).toBe("untouched");
      // The page it names, as policy names it: query and fragment aside.
      await run({ action: "click", target: { selector: "#pay" }, url: `${origin}/shop?from=cart#top` });
      expect(await title()).toBe("paid");
      // Spelled as Node spells it, though Chrome reports these escaped (`^`
      // differs only on Node 22; the unit test below covers it everywhere).
      for (const path of ["/a|b", "/a^b"]) {
        await run({ action: "navigate", url: `${origin}${path}` });
        await run({ action: "click", target: { selector: "#pay" }, url: `${origin}${path}` });
      }
      // Two paths a server tells apart stay apart.
      await run({ action: "navigate", url: `${origin}/p%FF` });
      await expect(
        run({ action: "click", target: { selector: "#pay" }, url: `${origin}/p%25FF` }),
      ).rejects.toThrow("browser_page_not_at_url");
      // `close` and `tab_switch` act on the tab they name, so that is the page checked.
      await run({ action: "navigate", url: `${origin}/shop` });
      await run({ action: "tab_new", url: `${origin}/victim` });
      await run({ action: "tab_switch", tabIndex: 0, url: `${origin}/shop` });
      await expect(run({ action: "close", tabIndex: 1, url: `${origin}/shop` })).rejects.toThrow(
        "browser_page_not_at_url",
      );
      expect(((await run({ action: "tabs" })) as { tabs: unknown[] }).tabs).toHaveLength(2);
      await run({ action: "close", tabIndex: 1, url: `${origin}/victim` });
      expect(((await run({ action: "tabs" })) as { tabs: unknown[] }).tabs).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });
});
