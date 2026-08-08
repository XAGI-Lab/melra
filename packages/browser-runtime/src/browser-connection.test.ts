// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserOperationSchema } from "@melra/protocol";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserRuntime, detectBrowserExecutable } from "./index.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        }),
    ),
  );
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><html><head><title>HAR fixture</title></head>" +
        "<body><main>verified page</main></body></html>",
    );
  });
  servers.push(server);
  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture_server_address_unavailable");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("reserved_port_unavailable");
  }
  await new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
  });
  return address.port;
}

describe("browser connection evidence", () => {
  it("records and flushes HAR for an owned browser context", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const root = await mkdtemp(join(tmpdir(), "melra-browser-har-"));
    roots.push(root);
    const { url } = await fixtureServer();
    const harPath = join(root, "network.har");
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      executablePath,
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
      recordHarPath: harPath,
    });
    try {
      await runtime.execute(
        BrowserOperationSchema.parse({
          kind: "browser",
          action: "navigate",
          url,
        }),
      );
    } finally {
      await runtime.close();
    }
    const har = JSON.parse(await readFile(harPath, "utf8")) as {
      log: { entries: Array<{ request: { url: string } }> };
    };
    expect(
      har.log.entries.some((entry) => entry.request.url.startsWith(url)),
    ).toBe(true);
  }, 120_000);

  it("replays a recorded HAR after the origin is gone", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const root = await mkdtemp(join(tmpdir(), "melra-browser-replay-"));
    roots.push(root);
    const { server, url } = await fixtureServer();
    const harPath = join(root, "network.har");
    const options = {
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      executablePath,
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
    };
    const recorder = new BrowserRuntime({
      ...options,
      recordHarPath: harPath,
    });
    try {
      await recorder.execute(
        BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }),
      );
    } finally {
      await recorder.close();
    }
    // The origin is taken down before replay, so a passing assertion below can
    // only have been served from the archive.
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
    });
    const replayer = new BrowserRuntime({ ...options, replayHarPath: harPath });
    try {
      const observation = await replayer.execute(
        BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }),
      );
      expect(observation.text).toContain("verified page");
      await expect(
        replayer.execute(
          BrowserOperationSchema.parse({
            kind: "browser",
            action: "navigate",
            url: `${url}/absent`,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await replayer.close();
    }
  }, 180_000);

  it("refuses to record and replay the same session", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-browser-conflict-"));
    roots.push(root);
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
      recordHarPath: join(root, "network.har"),
      replayHarPath: join(root, "network.har"),
    });
    try {
      await expect(
        runtime.execute(
          BrowserOperationSchema.parse({
            kind: "browser",
            action: "navigate",
            url: "http://127.0.0.1:1/",
          }),
        ),
      ).rejects.toThrow("browser_har_replay_cannot_record");
    } finally {
      await runtime.close();
    }
  });

  it("refuses a replay archive it cannot read", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-browser-missing-"));
    roots.push(root);
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
      replayHarPath: join(root, "absent.har"),
    });
    try {
      await expect(
        runtime.execute(
          BrowserOperationSchema.parse({
            kind: "browser",
            action: "navigate",
            url: "http://127.0.0.1:1/",
          }),
        ),
      ).rejects.toThrow("browser_har_replay_not_readable");
    } finally {
      await runtime.close();
    }
  });

  it("attaches to the selected CDP context without closing its owner", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const root = await mkdtemp(join(tmpdir(), "melra-browser-cdp-"));
    roots.push(root);
    const port = await reservePort();
    const owner = await chromium.launch({
      executablePath,
      headless: true,
      args: [`--remote-debugging-port=${port}`],
    });
    const context = await owner.newContext();
    const page = await context.newPage();
    await page.setContent(
      "<!doctype html><html><body><main>shared CDP page</main></body></html>",
    );
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      allowedDomains: [],
      allowLocalhost: false,
      cdpEndpoint: `http://127.0.0.1:${port}`,
      cdpContextIndex: -1,
    });
    try {
      const observation = await runtime.execute(
        BrowserOperationSchema.parse({
          kind: "browser",
          action: "inspect",
        }),
      );
      expect(observation.text).toContain("shared CDP page");
      await runtime.close();
      expect(owner.isConnected()).toBe(true);
      expect(await page.textContent("main")).toBe("shared CDP page");
      const { url } = await fixtureServer();
      await page.goto(url);
      expect(await page.textContent("main")).toBe("verified page");
    } finally {
      await runtime.close();
      await owner.close();
    }
  }, 120_000);
});
