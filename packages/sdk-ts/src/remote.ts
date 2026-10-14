// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Loopback is the only place a cleartext bearer token never crosses a wire. */
function isLoopbackHost(hostname: string): boolean {
  // `URL` has already normalised `127.1` to `127.0.0.1` and brackets IPv6.
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  );
}

function requireToken(token: string): string {
  // `token: process.env.MELRA_HTTP_TOKEN ?? ""` would otherwise connect with
  // `Bearer ` and fail later as a confusing 401.
  if (token.trim() === "") throw new Error("melra_token_required");
  return token.trim();
}

function bearer(token: string): RequestInit {
  return { headers: { authorization: `Bearer ${requireToken(token)}` } };
}

// ponytail: the SDK declares `sessionId?: string` on this transport, which
// `exactOptionalPropertyTypes` reads as incompatible with the `Transport` it
// implements. Cast once here, as `apps/cli/src/conformance.ts` does.
function asTransport(transport: StreamableHTTPClientTransport): Transport {
  return transport as unknown as Transport;
}

/**
 * The token is the key to a machine-control API. Over `https:` it is
 * encrypted wherever it goes; over `http:` it is readable by anything on the
 * path, which is nothing only when the path is loopback. A remote `http:`
 * URL means a proxy without TLS, and the SDK refuses to hand it the token
 * rather than leave that to every caller to notice. `allowInsecureHttp` is the
 * explicit opt-out for a network the caller trusts, matching the Python SDK.
 */
export function httpTransport(
  url: string | URL,
  token: string,
  allowInsecureHttp = false,
): Transport {
  const parsed = new URL(url);
  // `serve --http` prints both the console URL and the MCP URL; accept either,
  // as `melra conformance --url` does. The console URL carries `?token=`,
  // which has no business riding along on every MCP request.
  if (!parsed.pathname.endsWith("/mcp")) {
    parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/mcp`;
    parsed.search = "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`melra_unsupported_url: ${parsed.protocol} is not http(s)`);
  }
  if (parsed.protocol === "http:" && !allowInsecureHttp && !isLoopbackHost(parsed.hostname)) {
    throw new Error(
      `melra_insecure_url: refusing to send the token over plain http to ${parsed.hostname}; use https, a loopback address, or allowInsecureHttp`,
    );
  }
  return asTransport(
    new StreamableHTTPClientTransport(parsed, { requestInit: bearer(token) }),
  );
}

/**
 * Streamable HTTP over a Unix socket. The server names its socket requests
 * `http://localhost`, so that is the URL; the bytes go to `socketPath`.
 */
export function socketTransport(socketPath: string, token: string): Transport {
  // Mirrors the server, which refuses `--socket` on Windows: a named pipe's
  // ACL is not a mode it can check, so there is nothing to connect to.
  if (process.platform === "win32") {
    throw new Error(
      "socket_transport_unsupported_on_windows: use stdio or loopback HTTP",
    );
  }
  return asTransport(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: socketFetch(socketPath),
      requestInit: bearer(token),
    }),
  );
}

/**
 * `fetch` over a Unix socket, built on `http.request`, which is the one client
 * in Node that takes a `socketPath` without a dependency. The response body is
 * streamed rather than buffered because Streamable HTTP answers with SSE, and
 * a buffered stream would deliver nothing until the server closed it.
 */
function socketFetch(socketPath: string) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const outgoing = new Request(input, init);
    outgoing.signal.throwIfAborted();
    const url = new URL(outgoing.url);
    // Request bodies are small JSON-RPC messages, so buffering them is fine.
    const body =
      outgoing.body === null
        ? undefined
        : Buffer.from(await outgoing.arrayBuffer());
    return await new Promise<Response>((resolveResponse, rejectResponse) => {
      const request = httpRequest(
        {
          socketPath,
          path: `${url.pathname}${url.search}`,
          method: outgoing.method,
          headers: Object.fromEntries(outgoing.headers),
        },
        (incoming) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value !== undefined) {
              headers.set(name, Array.isArray(value) ? value.join(", ") : value);
            }
          }
          const status = incoming.statusCode ?? 500;
          resolveResponse(
            new Response(
              status === 204 || status === 304
                ? null
                : (Readable.toWeb(incoming) as ReadableStream),
              { status, headers },
            ),
          );
        },
      );
      // `close()` aborts the transport's long-lived SSE GET; destroying the
      // request is what actually releases the socket.
      outgoing.signal.addEventListener("abort", () =>
        request.destroy(new Error("aborted")),
      );
      request.on("error", rejectResponse);
      request.end(body);
    });
  };
}
