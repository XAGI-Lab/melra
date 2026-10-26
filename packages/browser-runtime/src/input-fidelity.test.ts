// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserOperationSchema } from "@melra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserRuntime, detectBrowserExecutable } from "./index.js";

/**
 * Typing went through `.fill()`, which assigns the value and fires one `input`
 * event. Every widget that listens for keystrokes — autocomplete, comboboxes,
 * submit buttons enabled on `keyup` — saw nothing. There was also no way to wait
 * for the page to reach a state, so callers padded `settleTimeoutMs` and hoped.
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

/**
 * A form that records the keystrokes it receives, a panel that appears late,
 * and enough height to scroll. `/done` is where submitting lands.
 */
const PAGE = `<!doctype html><html><head><title>form</title></head><body>
<form action="/done" method="get">
  <input id="email" name="email">
  <input id="password" name="password">
  <button id="sign-in" type="submit">Sign in</button>
</form>
<div id="keys">keys: 0</div>
<div style="height: 4000px"></div>
<script>
  let keys = 0;
  for (const field of document.querySelectorAll('input')) {
    field.addEventListener('keydown', () => {
      keys += 1;
      document.getElementById('keys').textContent = 'keys: ' + keys;
    });
  }
  setTimeout(() => {
    const panel = document.createElement('div');
    panel.id = 'late';
    panel.textContent = 'ready at last';
    document.body.append(panel);
  }, 400);
</script>
</body></html>`;

async function fixture(): Promise<{ runtime: BrowserRuntime; url: string } | undefined> {
  const executablePath = await detectBrowserExecutable();
  if (executablePath === undefined) return undefined;
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      (request.url ?? "/").startsWith("/done")
        ? "<!doctype html><html><head><title>done</title></head><body><h1>done</h1></body></html>"
        : PAGE,
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
  const root = await mkdtemp(join(tmpdir(), "melra-input-fidelity-"));
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

interface Element {
  id: string | null;
  value: string | null;
}

const valueOf = (result: Record<string, unknown>, id: string): string | null =>
  (result.elements as Element[]).find((element) => element.id === id)?.value ?? null;

describe("browser typing", () => {
  it("dispatches one key event per character", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      const typed = await runtime.execute(
        op({
          action: "type",
          target: { selector: "#email" },
          value: "hello",
          // Clearing an empty field costs a `Delete` keystroke of its own, so
          // skip it here to make the count exactly the text.
          clearFirst: false,
        }),
      );
      expect(valueOf(typed, "email")).toBe("hello");
      // `.fill()` would leave this at 0: the page would have the text but no
      // idea anyone had typed it.
      expect(typed.text).toContain("keys: 5");
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("replaces the field by default and appends when told not to clear", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      await runtime.execute(
        op({ action: "type", target: { selector: "#email" }, value: "first" }),
      );

      const replaced = await runtime.execute(
        op({ action: "type", target: { selector: "#email" }, value: "second" }),
      );
      expect(valueOf(replaced, "email")).toBe("second");

      const appended = await runtime.execute(
        op({
          action: "type",
          target: { selector: "#email" },
          value: "-more",
          clearFirst: false,
        }),
      );
      expect(valueOf(appended, "email")).toBe("second-more");
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("fills a whole form and submits it as one action", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      const filled = await runtime.execute(
        op({
          action: "fill_form",
          fields: [
            { target: { selector: "#email" }, value: "user@example.com" },
            { target: { selector: "#password" }, value: "hunter2" },
          ],
          target: { selector: "#sign-in" },
        }),
      );
      expect(filled.filled).toBe(2);
      expect(filled.submitted).toBe(true);
      expect(filled.title).toBe("done");
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("fills without submitting when no submit target is given", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      const filled = await runtime.execute(
        op({
          action: "fill_form",
          fields: [{ target: { selector: "#password" }, value: "hunter2" }],
        }),
      );
      expect(filled.submitted).toBe(false);
      expect(valueOf(filled, "password")).toBe("hunter2");
    } finally {
      await runtime.close();
    }
  }, 120_000);
});

describe("browser wait", () => {
  it("waits for an element that has not rendered yet", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      // The panel is added 400ms in, which is past the DOM-settle window, so
      // acting on it without waiting is a race.
      const waited = await runtime.execute(
        op({ action: "wait", target: { selector: "#late" }, state: "visible" }),
      );
      expect(waited.waited).toBe(true);
      expect(waited.text).toContain("ready at last");
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("waits for a URL substring and for page text", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      await runtime.execute(
        op({ action: "click", target: { selector: "#sign-in" } }),
      );
      const arrived = await runtime.execute(
        op({ action: "wait", urlContains: "/done" }),
      );
      expect(arrived.url).toContain("/done");

      const text = await runtime.execute(op({ action: "wait", value: "done" }));
      expect(text.waited).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("refuses a wait with no condition", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      await expect(runtime.execute(op({ action: "wait" }))).rejects.toThrow(
        "browser_wait_requires_target_url_contains_or_value",
      );
    } finally {
      await runtime.close();
    }
  }, 120_000);
});

describe("browser scroll", () => {
  it("scrolls by the requested distance and reports where it landed", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      const scrolled = await runtime.execute(
        op({ action: "scroll", direction: "down", pixels: 1_200 }),
      );
      expect(scrolled.scrollY).toBe(1_200);

      const back = await runtime.execute(op({ action: "scroll", direction: "top" }));
      expect(back.scrollY).toBe(0);
    } finally {
      await runtime.close();
    }
  }, 120_000);
});

describe("browser results", () => {
  it("reports success, which is what derived evidence checks", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      // Policy derives `result_equals success true` for a browser mutation the
      // caller declared no evidence for. Without the flag every such task
      // verified as `partial` however well it went.
      expect((await runtime.execute(op({ action: "navigate", url }))).success).toBe(true);
      expect(
        (await runtime.execute(op({ action: "click", target: { selector: "#sign-in" } })))
          .success,
      ).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 120_000);
});
