// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, request as httpRequest } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

// `rebind.test` resolves nowhere in reality, which is what makes this a test of
// pinning rather than of DNS: only a proxy that connects to the address the
// policy check returned can reach the server below. One that resolved the name
// a second time — the rebinding window — would fail outright.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "127.0.0.1", family: 4 }],
}));

const { startPinningProxy } = await import("./pinning-proxy.js");

async function listen(): Promise<{ port: number; close: () => void }> {
  const server = createServer((_req, res) => res.end("pinned"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => server.close(),
  };
}

function throughProxy(
  proxyPort: number,
  target: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // Absolute-form request URI: how a browser addresses a proxy.
    const req = httpRequest(
      { host: "127.0.0.1", port: proxyPort, path: target },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += String(chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("pinning proxy", () => {
  it("connects to the address the policy check returned", async () => {
    const upstream = await listen();
    const proxy = await startPinningProxy({
      allowedDomains: ["*"],
      allowLocalhost: true,
    });
    try {
      const port = Number(new URL(proxy.server).port);
      const response = await throughProxy(
        port,
        `http://rebind.test:${upstream.port}/`,
      );
      expect(response).toEqual({ status: 200, body: "pinned" });
    } finally {
      await proxy.close();
      upstream.close();
    }
  });

  it("refuses a destination policy denies", async () => {
    const upstream = await listen();
    const proxy = await startPinningProxy({
      allowedDomains: ["*"],
      allowLocalhost: false,
    });
    try {
      const port = Number(new URL(proxy.server).port);
      const response = await throughProxy(
        port,
        `http://rebind.test:${upstream.port}/`,
      );
      expect(response.status).toBe(502);

      // CONNECT carries no path to check, so the authority has to be enough.
      const refusal = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(
            `CONNECT rebind.test:443 HTTP/1.1\r\nHost: rebind.test:443\r\n\r\n`,
          );
        });
        socket.on("data", (chunk) => {
          resolve(String(chunk));
          socket.destroy();
        });
        socket.on("error", reject);
      });
      expect(refusal).toContain("502");
    } finally {
      await proxy.close();
      upstream.close();
    }
  });
});
