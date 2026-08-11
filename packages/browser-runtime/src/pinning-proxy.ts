// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Loopback proxy that closes the DNS-rebinding window.
//
// `assertSafeDestination` resolves a hostname and checks every answer, but the
// browser then resolves the same name again through its own stack. A hostile
// resolver only has to answer public the first time and private the second, and
// the check that passed has nothing to do with the socket that opens. Chromium
// cannot be told to reuse our answer, so the fix is to stop it from connecting
// at all: it talks to this proxy, and the proxy connects to the address it just
// checked.
//
// Loopback destinations bypass the proxy — Chromium does that by default and
// there is nothing to rebind about a literal `127.0.0.1`, which the route layer
// already checks against policy.

import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { assertSafeDestination, type NetworkPolicy } from "@melra/policy-core";

export interface PinningProxy {
  /** `http://127.0.0.1:<port>`, ready for Playwright's `proxy.server`. */
  server: string;
  close(): Promise<void>;
}

/** Enough for a refusal to be legible in a network log; the page sees a failure. */
function refuse(socket: Socket, reason: string): void {
  socket.end(`HTTP/1.1 502 ${reason}\r\nConnection: close\r\n\r\n`);
}

function pipeBothWays(client: Socket, upstream: Socket, head: Buffer): void {
  // Either half closing has to take the other down, or a stalled tunnel keeps a
  // socket pair alive for the life of the browser.
  const end = (): void => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", end);
  upstream.on("error", end);
  if (head.length > 0) upstream.write(head);
  client.pipe(upstream);
  upstream.pipe(client);
}

export async function startPinningProxy(policy: NetworkPolicy): Promise<PinningProxy> {
  const sockets = new Set<Socket>();

  /**
   * Track a socket for shutdown and take responsibility for its errors. A proxy
   * socket resetting is normal — the browser drops keep-alive connections, and
   * `close()` destroys whatever is still open — and an untracked `error` on a raw
   * socket is an uncaught exception that takes the host process down with it.
   */
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const { url, address } = await assertSafeDestination(req.url ?? "", policy);
        const upstream = httpRequest(
          {
            host: address,
            port: url.port === "" ? 80 : Number(url.port),
            method: req.method ?? "GET",
            path: `${url.pathname}${url.search}`,
            // The original headers carry `Host`, so a name-based virtual host
            // still resolves correctly at the far end even though the socket
            // was opened to a literal address.
            headers: req.headers,
          },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
          },
        );
        upstream.on("error", () => res.destroy());
        req.pipe(upstream);
      } catch {
        res.writeHead(502).end();
      }
    })();
  });

  server.on("connect", (req, clientSocket: Socket, head: Buffer) => {
    void (async () => {
      try {
        // CONNECT carries `host:port`, not a URL. Only the authority is checked
        // because a tunnel has no path to check — the request inside it is TLS.
        const { address, url } = await assertSafeDestination(
          `https://${req.url ?? ""}`,
          policy,
        );
        const upstream = connect(
          { host: address, port: url.port === "" ? 443 : Number(url.port) },
          () => {
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            pipeBothWays(clientSocket, upstream, head);
          },
        );
        track(upstream);
        upstream.on("error", () => refuse(clientSocket, "Bad Gateway"));
      } catch {
        refuse(clientSocket, "Blocked");
      }
    })();
  });

  server.on("connection", track);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const listening = server.address();
  if (listening === null || typeof listening === "string") {
    server.close();
    throw new Error("browser_proxy_unavailable");
  }

  return {
    server: `http://127.0.0.1:${listening.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // A tunnel keeps its socket open by design, so `close()` alone waits
        // forever. Destroying first is what makes shutdown bounded.
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}
