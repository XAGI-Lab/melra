// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createSocket } from "node:dgram";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserOperationSchema } from "@melra/protocol";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectBrowser } from "./browser-connection.js";
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

async function fixtureServer(
  page = "<!doctype html><html><head><title>HAR fixture</title></head>" +
    "<body><main>verified page</main></body></html>",
): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
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

  it("lets no page send WebRTC's UDP, to a STUN server it names or anywhere", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const root = await mkdtemp(join(tmpdir(), "melra-browser-webrtc-"));
    roots.push(root);
    // A STUN server on this machine, so the test needs no network and any
    // binding request a page sends is counted here.
    const stun = createSocket("udp4");
    let requests = 0;
    stun.on("message", () => {
      requests += 1;
    });
    await new Promise<void>((resolvePromise) => {
      stun.bind(0, "127.0.0.1", resolvePromise);
    });
    const page =
      "<!doctype html><html><body><main>gathering</main><script>" +
      `const connection = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${stun.address().port}" }] });` +
      'connection.createDataChannel("probe");' +
      "connection.createOffer().then((offer) => connection.setLocalDescription(offer));" +
      "</script></body></html>";
    // Without the switch a request came within a second; a slow runner gets five.
    const listen = async (): Promise<void> => {
      for (let waited = 0; requests === 0 && waited < 5_000; waited += 50) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    };
    try {
      // A Chrome launched without the switch sends one, so silence below is
      // the switch's doing, not a machine with no address to send from.
      const control = await chromium.launch({ executablePath, headless: true });
      try {
        await (await control.newPage()).setContent(page);
        await listen();
      } finally {
        await control.close();
      }
      if (requests === 0) return;
      requests = 0;
      const { url } = await fixtureServer(page);
      const runtime = new BrowserRuntime({
        workspaceRoot: root,
        artifactDirectory: join(root, "artifacts"),
        executablePath,
        allowedDomains: ["127.0.0.1"],
        allowLocalhost: true,
      });
      try {
        const opened = await runtime.execute(BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }));
        expect(opened.text).toContain("gathering");
        await listen();
      } finally {
        await runtime.close();
      }
      expect(requests).toBe(0);
    } finally {
      stun.close();
    }
  }, 120_000);

  it("sends a replayed page's WebRTC over TCP through the destination checks", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const root = await mkdtemp(join(tmpdir(), "melra-browser-turn-"));
    roots.push(root);
    // A TURN server on this machine that only counts who connects to it.
    let connections = 0;
    const turn = createNetServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolvePromise) => {
      turn.listen(0, "127.0.0.1", resolvePromise);
    });
    const page =
      "<!doctype html><html><body><main>gathering</main><script>" +
      "const connection = new RTCPeerConnection({ iceServers: [{ " +
      `urls: "turn:127.0.0.1:${(turn.address() as AddressInfo).port}?transport=tcp", username: "u", credential: "p" }] });` +
      'connection.createDataChannel("probe");' +
      "connection.createOffer().then((offer) => connection.setLocalDescription(offer));" +
      "</script></body></html>";
    const listen = async (): Promise<void> => {
      for (let waited = 0; connections === 0 && waited < 5_000; waited += 50) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    };
    try {
      // Launched as MELRA launches it but with no proxy, the page connects
      // straight to it, so silence below is the proxy's doing.
      const control = await chromium.launch({
        executablePath,
        headless: true,
        args: ["--webrtc-ip-handling-policy=disable_non_proxied_udp"],
      });
      try {
        await (await control.newPage()).setContent(page);
        await listen();
      } finally {
        await control.close();
      }
      if (connections === 0) return;
      connections = 0;
      // Served from an archive at a name the policy lists; the TURN server's
      // address is not listed, so the pinning proxy refuses it.
      const url = "http://localhost:9/";
      const harPath = join(root, "replay.har");
      await writeFile(
        harPath,
        JSON.stringify({
          log: {
            version: "1.2",
            creator: { name: "melra-test", version: "1" },
            entries: [
              {
                request: { method: "GET", url, headers: [] },
                response: {
                  status: 200,
                  headers: [{ name: "content-type", value: "text/html; charset=utf-8" }],
                  content: { mimeType: "text/html", text: page },
                },
              },
            ],
          },
        }),
      );
      const runtime = new BrowserRuntime({
        workspaceRoot: root,
        artifactDirectory: join(root, "artifacts"),
        executablePath,
        allowedDomains: ["localhost"],
        allowLocalhost: true,
        replayHarPath: harPath,
      });
      try {
        const opened = await runtime.execute(BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url }));
        expect(opened.text).toContain("gathering");
        await listen();
      } finally {
        await runtime.close();
      }
      expect(connections).toBe(0);
    } finally {
      turn.close();
    }
  }, 120_000);

  // POSIX only: a shell script stands in for Chrome.
  it.skipIf(process.platform === "win32")("starts its own browser without the payload key or the HTTP token", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-browser-env-"));
    roots.push(root);
    // Writes down its environment beside itself and exits, which fails the
    // launch.
    const chrome = join(root, "chrome");
    const seen = `${chrome}.env`;
    await writeFile(chrome, `#!/bin/sh\nenv > "$0.env"\nexit 1\n`);
    await chmod(chrome, 0o755);
    vi.stubEnv("MELRA_PAYLOAD_KEY", "probe-key");
    vi.stubEnv("MELRA_HTTP_TOKEN", "probe-token");
    try {
      for (const profile of [{}, { userDataDir: join(root, "profile") }]) {
        await rm(seen, { force: true });
        await expect(connectBrowser({ executablePath: chrome, headless: true, ...profile })).rejects.toThrow();
        const environment = await readFile(seen, "utf8");
        expect(environment).toContain("PATH=");
        expect(environment).not.toMatch(/MELRA_PAYLOAD_KEY|MELRA_HTTP_TOKEN/);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

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
