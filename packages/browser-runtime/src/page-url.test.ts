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

// A page's first load holds its targets hidden and reloads itself, after the
// navigation to it has settled; every later load shows them, and records
// anything that reaches them.
const FIRST = `<!doctype html><html><head><title>first</title></head><body>
  <button id="go" hidden>Go</button><input id="field" hidden>
  <script>fetch("/release").then(() => location.reload())</script>
</body></html>`;
const LATER = `<!doctype html><html><head><title>later</title></head><body>
  <button id="go" onclick="document.title = 'clicked'">Go</button>
  <input id="field" oninput="document.title = 'typed'">
</body></html>`;

// The same target, replaced in the same document by one that shows.
const RERENDER = `<!doctype html><html><head><title>rerender</title></head><body>
  <button id="go" hidden>Go</button>
  <script>fetch("/release").then(() => {
    const shown = Object.assign(document.createElement("button"), { id: "go", textContent: "Go" });
    shown.onclick = () => (document.title = "clicked");
    document.getElementById("go").replaceWith(shown);
  })</script>
</body></html>`;

// A frame whose first document holds its target hidden and reloads itself,
// and whose later ones show it, recording a click in the page around it.
const FRAMED = `<!doctype html><html><head><title>framed</title></head><body>
  <iframe id="f" src="/framed-inner"></iframe>
</body></html>`;
const FRAMED_FIRST = `<!doctype html><button id="inframe" hidden>Go</button>
  <script>fetch("/release").then(() => location.reload())</script>`;
const FRAMED_LATER = `<!doctype html><button id="inframe" onclick="parent.document.title = 'clicked'">Go</button>`;
// A page that rewrites its own path as it is typed into, and one that does
// so while a click waits for its button.
const PUSHED = `<!doctype html><html><head><title>push</title></head><body>
  <input id="field" oninput="history.pushState(null, '', '/pushed/' + this.value); document.title = this.value">
</body></html>`;
const PUSH_CLICK = `<!doctype html><html><head><title>push-click</title></head><body>
  <button id="go" disabled onclick="document.title = 'clicked'">Go</button>
  <script>fetch("/release").then(() => {
    history.pushState(null, "", "/elsewhere");
    document.getElementById("go").disabled = false;
  })</script>
</body></html>`;

// A field whose page navigates away at the first character typed, to a
// page whose own field takes focus and records what reaches it.
const NAV_TYPE = `<!doctype html><html><head><title>nav-type</title></head><body>
  <input id="field" oninput="if (this.value.length === 1) location.href = '/nav-typed'">
</body></html>`;
const NAV_TYPED = `<!doctype html><html><head><title>landed</title></head><body>
  <input id="next" autofocus oninput="document.title = 'got:' + this.value">
</body></html>`;
// A form whose first field rewrites the page's path as it is typed into.
const PUSH_FORM = `<!doctype html><html><head><title>push-form</title></head><body>
  <input id="a" oninput="history.replaceState(null, '', '/push-form/' + this.value)"><input id="b">
  <button id="s" onclick="document.title = document.getElementById('a').value + '+' + document.getElementById('b').value">Send</button>
</body></html>`;
// A search field that, once cleared, rewrites the path and mounts a fresh
// field in its place, then rewrites the path again as it is typed into.
const REMOUNT = `<!doctype html><html><head><title>remount</title></head><body><div id="box"></div>
  <script>
    const mount = (value) => {
      const field = Object.assign(document.createElement("input"), { id: "q", value });
      field.oninput = () => {
        document.title = field.value;
        if (field.value === "") {
          history.pushState(null, "", "/search");
          mount("").focus();
        } else history.replaceState(null, "", "/search/" + field.value);
      };
      document.getElementById("box").replaceChildren(field);
      return field;
    };
    mount("old");
  </script>
</body></html>`;
// One click, counted as the page's earliest listener sees it.
const COUNTED = `<!doctype html><html><head><title>0</title></head><body>
  <script>addEventListener("click", (event) => { if (event.isTrusted) document.title = String(Number(document.title) + 1); }, true)</script>
  <button id="go">Go</button>
</body></html>`;
// A button re-rendered every 50 ms, as some frameworks do.
const CHURN = `<!doctype html><html><head><title>churn</title></head><body><div id="box"></div>
  <script>setInterval(() => { document.getElementById("box").innerHTML = '<button id="go" onclick="document.title = \\'clicked\\'">Go</button>'; }, 50)</script>
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

  it("lands on the document it was checked on, or nowhere", { timeout: 120_000 }, async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const loads = new Map<string, number>();
    // The pages change only once the test says so, after its action started.
    const held: Array<() => void> = [];
    const release = () => held.splice(0).forEach((answer) => answer());
    const server = createServer((request, response) => {
      if (request.url === "/release") {
        held.push(() => response.end("ok"));
        return;
      }
      const load = (loads.get(request.url ?? "") ?? 0) + 1;
      loads.set(request.url ?? "", load);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const fixed: Record<string, string> = {
        "/rerender": RERENDER,
        "/framed": FRAMED,
        "/pushed": PUSHED,
        "/push-click": PUSH_CLICK,
        "/nav-type": NAV_TYPE,
        "/nav-typed": NAV_TYPED,
        "/push-form": PUSH_FORM,
        "/counted": COUNTED,
        "/remount": REMOUNT,
        "/churn": CHURN,
      };
      const inner = load === 1 ? FRAMED_FIRST : FRAMED_LATER;
      response.end(request.url === "/framed-inner" ? inner : (fixed[request.url ?? ""] ?? (load === 1 ? FIRST : LATER)));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture_server_address_unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const root = await mkdtemp(join(tmpdir(), "melra-page-pin-"));
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
    // Starts the action, lets the page change while it waits, and hands back
    // its outcome.
    const meanwhile = async (operation: Record<string, unknown>) => {
      const acting = run(operation);
      acting.catch(() => undefined);
      await new Promise((done) => setTimeout(done, 500));
      release();
      return acting;
    };
    try {
      // Each action waits for its hidden target while the page reloads itself
      // at the same address into a document where the target shows: the
      // action is refused, and the new document gets nothing.
      const actions: Array<[string, Record<string, unknown>]> = [
        ["/click", { action: "click", target: { selector: "#go" } }],
        ["/named", { action: "click", target: { selector: "#go" }, url: `${origin}/named` }],
        ["/type", { action: "type", target: { selector: "#field" }, value: "x" }],
        ["/fill", { action: "fill_form", fields: [{ target: { selector: "#field" }, value: "x" }] }],
      ];
      for (const [path, operation] of actions) {
        await run({ action: "navigate", url: `${origin}${path}` });
        await expect(meanwhile(operation), path).rejects.toThrow("browser_page_changed");
        expect(await title(), path).toBe("later");
      }
      // On a document that stays, the same actions land, on a target the
      // page re-renders while the action waits too.
      await run({ action: "navigate", url: `${origin}/named` });
      await run({ action: "click", target: { selector: "#go" }, url: `${origin}/named` });
      expect(await title()).toBe("clicked");
      await run({ action: "navigate", url: `${origin}/rerender` });
      await meanwhile({ action: "click", target: { selector: "#go" }, url: `${origin}/rerender` });
      expect(await title()).toBe("clicked");
      await run({ action: "navigate", url: `${origin}/churn` });
      await run({ action: "click", target: { selector: "#go" }, url: `${origin}/churn` });
      expect(await title()).toBe("clicked");
      // One click reaches the page once: waiting for the target sends nothing.
      await run({ action: "navigate", url: `${origin}/counted` });
      await run({ action: "click", target: { selector: "#go" }, url: `${origin}/counted` });
      expect(await title()).toBe("1");
      // A target in a frame is held to the frame's document it was found in:
      // the frame reloading into one where it shows gets nothing either.
      await run({ action: "navigate", url: `${origin}/framed` });
      await expect(meanwhile({ action: "click", target: { selector: "#inframe" }, url: `${origin}/framed` })).rejects.toThrow(
        "browser_page_changed",
      );
      expect(await title()).toBe("framed");
      // The address is checked after the click's own wait, right before the
      // click; once typing starts, a page may rewrite its own path.
      await run({ action: "navigate", url: `${origin}/push-click` });
      await expect(meanwhile({ action: "click", target: { selector: "#go" }, url: `${origin}/push-click` })).rejects.toThrow(
        "browser_page_changed",
      );
      expect(await title()).toBe("push-click");
      await run({ action: "navigate", url: `${origin}/pushed` });
      await run({ action: "type", target: { selector: "#field" }, value: "abc", url: `${origin}/pushed` });
      expect(await title()).toBe("abc");
      // So may a form's field, before the next field and the submit.
      await run({ action: "navigate", url: `${origin}/push-form` });
      await run({
        action: "fill_form",
        fields: [
          { target: { selector: "#a" }, value: "x" },
          { target: { selector: "#b" }, value: "y" },
        ],
        target: { selector: "#s" },
        url: `${origin}/push-form`,
      });
      expect(await title()).toBe("x+y");
      // Clearing the field may re-mount it at a new path: once the action has
      // sent input, only the document is held, so the rest goes in.
      await run({ action: "navigate", url: `${origin}/remount` });
      await run({ action: "type", target: { selector: "#q" }, value: "new", url: `${origin}/remount` });
      expect(await title()).toBe("new");
      // Typing stops at the key after the page leaves: the next document,
      // whose own field takes focus, gets none of the rest.
      await run({ action: "navigate", url: `${origin}/nav-type` });
      await expect(
        run({ action: "type", target: { selector: "#field" }, value: "abcdefgh", delayMs: 100, url: `${origin}/nav-type` }),
      ).rejects.toThrow("browser_page_changed");
      expect(await title()).toBe("landed");
    } finally {
      await runtime.close();
    }
  });
});
