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
 * Playwright dismisses every dialog automatically unless a handler is
 * registered, and nothing registered one. A `confirm()` guarding a destructive
 * button was therefore answered "cancel" on the page's behalf: the click
 * reported success, the guarded work never ran, and the caller had no way to
 * tell — the one shape of failure this codebase exists to prevent.
 *
 * `beforeunload` is the same defect pointed at navigation, and `prompt()` the
 * same pointed at input.
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
 * `#delete` is the shape that matters: real work sits behind a `confirm()`, and
 * the page records the answer it was given. `#status` is the independent
 * evidence — it changes only if the dialog was accepted.
 */
const PAGE = `<!doctype html><html><head><title>dialogs</title></head><body>
<button id="delete">Delete</button>
<button id="notice">Notice</button>
<button id="ask">Ask</button>
<div id="status">untouched</div>
<div id="answer">none</div>
<script>
  document.getElementById('delete').addEventListener('click', () => {
    if (confirm('Delete this record?')) {
      document.getElementById('status').textContent = 'deleted';
    } else {
      document.getElementById('status').textContent = 'cancelled';
    }
  });
  document.getElementById('notice').addEventListener('click', () => {
    alert('Saved.');
    document.getElementById('status').textContent = 'acknowledged';
  });
  document.getElementById('ask').addEventListener('click', () => {
    const name = prompt('Your name?');
    document.getElementById('answer').textContent = name === null ? 'null' : name;
  });
</script>
</body></html>`;

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
  const root = await mkdtemp(join(tmpdir(), "melra-dialogs-"));
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

const textOf = async (runtime: BrowserRuntime, selector: string): Promise<string> => {
  const inspected = await runtime.execute(
    op({ action: "inspect", target: { selector } }),
  );
  return String(inspected.text ?? "").trim();
};

describe("browser dialogs", () => {
  it("reports the confirm it answered instead of silently cancelling", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      const clicked = await runtime.execute(
        op({ action: "click", target: { selector: "#delete" } }),
      );

      // The click must say a dialog happened. Without this the caller cannot
      // distinguish "the button did its work" from "a dialog ate it".
      expect(clicked.dialogs).toEqual([
        expect.objectContaining({
          type: "confirm",
          message: "Delete this record?",
        }),
      ]);

      // And the page must agree with whatever answer was reported.
      const answered = (clicked.dialogs as Array<{ accepted: boolean }>)[0]
        ?.accepted;
      expect(await textOf(runtime, "#status")).toBe(
        answered === true ? "deleted" : "cancelled",
      );
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it("lets an alert through so the handler after it still runs", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      const clicked = await runtime.execute(
        op({ action: "click", target: { selector: "#notice" } }),
      );
      expect(clicked.dialogs).toEqual([
        expect.objectContaining({ type: "alert", message: "Saved." }),
      ]);
      expect(await textOf(runtime, "#status")).toBe("acknowledged");
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it("records a prompt rather than pretending the page asked nothing", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      const clicked = await runtime.execute(
        op({ action: "click", target: { selector: "#ask" } }),
      );
      expect(clicked.dialogs).toEqual([
        expect.objectContaining({ type: "prompt", message: "Your name?" }),
      ]);
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it("leaves actions that raise no dialog unchanged", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      const inspected = await runtime.execute(op({ action: "inspect" }));
      expect(inspected.dialogs).toBeUndefined();
    } finally {
      await runtime.close();
    }
  }, 60_000);
});
