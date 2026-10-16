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

async function fixture(): Promise<{ runtime: BrowserRuntime; url: string } | undefined> {
  const executablePath = await detectBrowserExecutable();
  if (executablePath === undefined) return undefined;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
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

  it("never reads back what was typed into a password field", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }));
      await runtime.execute(
        BrowserOperationSchema.parse({
          kind: "browser",
          action: "type",
          target: { selector: 'input[name="password"]' },
          value: "s3cret-typed-by-someone",
        }),
      );
      const inspected = await runtime.execute(BrowserOperationSchema.parse({ kind: "browser", action: "inspect" }));
      expect(JSON.stringify(inspected)).not.toContain("s3cret-typed-by-someone");
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
