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
      // Whether a target exists can be made to depend on the secret, through
      // its mirrored value or an accessible name built from the field, however
      // the selector is spelled. So no read aims at part of the page now.
      for (const target of [
        { selector: "#login" },
        { selector: 'input[\\76 alue^="s3"]' },
        { selector: "xpath=//input[starts-with(attribute::value,'s3')]" },
        { role: "cell", name: "s3cret" },
      ]) {
        await expect(run({ action: "inspect", target })).rejects.toThrow("browser_secret_field_filled");
        await expect(run({ action: "wait", target, state: "attached" })).rejects.toThrow("browser_secret_field_filled");
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

  it("stops a targeted wait once a secret field is filled under it", async () => {
    const context = await fixture(`<!doctype html><html><body><input name="password" type="password"><script>
      setTimeout(() => { document.querySelector("input").value = "s3cret-late"; }, 400);
    </script></body></html>`);
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }));
      await expect(
        runtime.execute(
          BrowserOperationSchema.parse({
            kind: "browser",
            action: "wait",
            target: { selector: "#never" },
            state: "attached",
            timeoutMs: 5_000,
          }),
        ),
      ).rejects.toThrow("browser_secret_field_filled");
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
      (runtime as unknown as { secretFieldFilled: () => Promise<string> }).secretFieldFilled = async () => "unknown";
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
