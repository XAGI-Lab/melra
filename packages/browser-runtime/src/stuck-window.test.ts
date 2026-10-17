// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserOperationSchema } from "@melra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserRuntime, detectBrowserExecutable } from "./index.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const listen = async (server: Server) => {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

describe("a window whose first response never comes (#226)", () => {
  it("holds up only the action that opened it", { timeout: 60_000 }, async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    // Never answers until the test ends, as a dead link's server can.
    const hung: Array<() => void> = [];
    const stuck = await listen(createServer((_request, response) => void hung.push(() => response.end())));
    // Answers after a while, as a slow site does.
    const slow = await listen(
      createServer((_request, response) => {
        setTimeout(() => response.end("<!doctype html><title>slow</title>"), 1_500);
      }),
    );
    const origin = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>opener</title>
          <button id="stuck" onclick="window.open('${stuck}/?stuck')">stuck</button>
          <button id="slow" onclick="window.open('${slow}/?slow')">slow</button>`);
      }),
    );
    const root = await mkdtemp(join(tmpdir(), "melra-stuck-window-"));
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
    try {
      await run({ action: "navigate", url: origin });
      // The click waits for its window as long as it may: the window is part
      // of what it did.
      await run({ action: "click", target: { selector: "#stuck" }, timeoutMs: 2_000 });
      expect(hung).toHaveLength(1);
      // The next action does not wait for it again.
      const started = Date.now();
      await run({ action: "inspect", timeoutMs: 5_000 });
      expect(Date.now() - started).toBeLessThan(2_500);
      // And a slow window is still waited for, and reported, by the action
      // that opened it.
      const clicked = await run({ action: "click", target: { selector: "#slow" }, timeoutMs: 10_000 });
      expect(clicked.popups).toEqual([expect.objectContaining({ url: expect.stringContaining("?slow"), blocked: true })]);
    } finally {
      hung.splice(0).forEach((answer) => answer());
      await runtime.close();
    }
  });
});
