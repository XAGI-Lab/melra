// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { BrowserOperationSchema, isOutcomeUnknown } from "@melra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserRuntime, detectBrowserExecutable } from "./index.js";

/**
 * `title()`, `evaluate()` and `count()` take no timeout of their own, so a
 * renderer that stopped answering held the action until the task budget ran
 * out — or forever, with no budget armed. A renderer running a long
 * synchronous script is the deterministic stand-in: every call that needs the
 * page's main thread queues behind it, exactly as with a wedged page, but it
 * ends, so the same runtime can be shown to work again afterwards.
 */
const STALL_MS = 3_000;

/** The bound each test action runs under; far below `STALL_MS`. */
const BOUND_MS = 500;

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
 * The click handler records itself, then stalls the renderer from a later
 * task — `?delay=` after the click, for `?ms=` — so what stalls is whatever
 * runs after the click rather than the click itself.
 */
const PAGE = `<!doctype html><html><head><title>stall</title></head><body>
<button id="go">Go</button>
<div id="status">idle</div>
<script>
  const params = new URLSearchParams(location.search);
  document.getElementById('go').addEventListener('click', () => {
    document.getElementById('status').textContent = 'clicked';
    setTimeout(() => {
      const end = Date.now() + Number(params.get('ms') ?? ${STALL_MS});
      while (Date.now() < end) {}
    }, Number(params.get('delay') ?? 0));
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
  const root = await mkdtemp(join(tmpdir(), "melra-stall-"));
  roots.push(root);
  return {
    runtime: new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      executablePath,
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
    }),
    url: `http://127.0.0.1:${address.port}/`,
  };
}

const op = (fields: Record<string, unknown>) =>
  BrowserOperationSchema.parse({ kind: "browser", ...fields });

/** Occupy the renderer's main thread from outside, as a wedged page would. */
function stall(runtime: BrowserRuntime): Promise<void> {
  const page = (runtime as unknown as { activePage: Page }).activePage;
  return page.evaluate((ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Spin: nothing else on this page runs until it ends.
    }
  }, STALL_MS);
}

async function failure(action: Promise<unknown>): Promise<{ message: string; ms: number }> {
  const started = Date.now();
  try {
    await action;
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    };
  }
  throw new Error("expected the action to fail");
}

/** Read the status text, waiting out any stall still in progress. */
const status = async (runtime: BrowserRuntime): Promise<string> => {
  const inspected = await runtime.execute(
    op({ action: "inspect", target: { selector: "#status" }, timeoutMs: 10_000 }),
  );
  return String(inspected.text ?? "").trim();
};

describe("stalled browser calls", () => {
  it("fails a read within its bound, and the runtime answers again after", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      const stalled = stall(runtime);
      const { message, ms } = await failure(
        runtime.execute(op({ action: "inspect", timeoutMs: BOUND_MS })),
      );
      // A read that timed out is an ordinary failure the controller may retry,
      // never an unknown outcome.
      expect(message).toBe("browser_call_timeout:evaluate");
      expect(ms).toBeLessThan(STALL_MS - 500);
      await stalled;
      const inspected = await runtime.execute(op({ action: "inspect" }));
      expect(inspected.title).toBe("stall");
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it("gives up on a stalled call as soon as the task is cancelled", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      const stalled = stall(runtime);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("task_cancelled")), 200);
      const { message, ms } = await failure(
        runtime.execute(op({ action: "inspect", timeoutMs: 60_000 }), controller.signal),
      );
      expect(message).toBe("task_cancelled");
      expect(ms).toBeLessThan(STALL_MS - 500);
      await stalled;
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it("fails a click cleanly when the page stalls before the click is sent", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      await runtime.execute(op({ action: "navigate", url }));
      const stalled = stall(runtime);
      const { message, ms } = await failure(
        runtime.execute(
          op({ action: "click", target: { selector: "#go" }, timeoutMs: BOUND_MS }),
        ),
      );
      // Resolving the target timed out, so nothing was clicked: a plain
      // failure, which the page confirms once it answers again.
      expect(message).toBe("browser_call_timeout:count");
      expect(ms).toBeLessThan(STALL_MS - 500);
      await stalled;
      expect(await status(runtime)).toBe("idle");
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it("reports a click that stalled the page as an unknown outcome", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      // A longer stall and a roomier bound than the other cases: the bound
      // also covers resolving and reaching the button, which a slow Windows
      // runner has taken over 500 ms to do, failing the click before it was
      // sent. That is the right answer for an unsent click, but not this case.
      await runtime.execute(op({ action: "navigate", url: `${url}?ms=6000` }));
      const { message, ms } = await failure(
        runtime.execute(
          op({
            action: "click",
            target: { selector: "#go" },
            timeoutMs: 2_000,
            settleQuietMs: 25,
            settleTimeoutMs: 25,
          }),
        ),
      );
      // The page stalls the moment the click lands. Whether Playwright's own
      // post-click check or the settle after it is what runs out first, the
      // click was delivered, so `failed` would be the false claim.
      expect(isOutcomeUnknown(message), message).toBe(true);
      expect(ms).toBeLessThan(5_000);
      expect(await status(runtime)).toBe("clicked");
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it("reports a stall in the settle after a click as an unknown outcome", async () => {
    const context = await fixture();
    if (context === undefined) return;
    const { runtime, url } = context;
    try {
      // The stall starts a second into a two-second quiet window, so the
      // click itself has long returned and only the settle is caught in it.
      // Its bound is that window plus the grace, three seconds in all.
      await runtime.execute(op({ action: "navigate", url: `${url}?delay=1000&ms=4000` }));
      const { message, ms } = await failure(
        runtime.execute(
          op({
            action: "click",
            target: { selector: "#go" },
            settleQuietMs: 2_000,
            settleTimeoutMs: 2_000,
          }),
        ),
      );
      expect(message).toBe("effect_outcome_unknown:browser_call_timeout:settle");
      expect(ms).toBeLessThan(4_500);
      expect(await status(runtime)).toBe("clicked");
    } finally {
      await runtime.close();
    }
  }, 60_000);
});
