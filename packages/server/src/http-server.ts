// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import { resolve } from "node:path";
import { isMainThread } from "node:worker_threads";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Principal } from "@melra/protocol";
import { principalRef } from "@melra/protocol";
import { capabilitiesPayload, createMcpServer } from "./mcp-server.js";
import type { MelraRuntime } from "./runtime.js";
import { approvalSummary, printable } from "./approval-screen.js";
import { consolePage, consoleSecurityHeaders } from "./console-page.js";
import { clientPrincipal, CONSENT_HEADERS, OAuthProvider, requestOf } from "./oauth.js";
import { hold } from "./session-hold.js";

export const DEFAULT_HTTP_PORT = 7457;

/**
 * MCP sessions kept before the least recently used idle one is ended. A client
 * that leaves without ending its session (a crash, a dropped network, an MCP
 * client that never sends DELETE) otherwise holds an MCP server and its
 * transport, some 50 KB, for the life of the process.
 */
const MAX_MCP_SESSIONS = 256;

export interface MelraHttpOptions {
  runtime: MelraRuntime;
  /** Loopback by default. Anything else exposes a machine-control API. */
  host?: string;
  port?: number;
  /**
   * Listen on this Unix-domain socket instead of a TCP port; `host` and `port`
   * are then ignored. The socket is created mode `0600`, so the kernel admits
   * only this OS user. Refused on Windows.
   */
  socketPath?: string;
  /** Falls back to `MELRA_HTTP_TOKEN`, then to a fresh random token. */
  token?: string;
  environment?: NodeJS.ProcessEnv;
  /**
   * Serve the operator's approval console instead of an agent endpoint, and
   * record its decisions as this approver. Only `melra console` sets it.
   *
   * An agent's harness holds every token its endpoint accepts, and reads what
   * a server it started prints, so an approval there is one the agent could
   * make. This server is never an agent endpoint: no `/mcp`, no OAuth, no
   * `MELRA_HTTP_TOKEN` or `token`, loopback TCP only. `url` carries a one-time
   * pairing code in its fragment; the one page that redeems it gets a session
   * held only in memory, here and in that page, until that page leaves, and
   * nothing else is accepted.
   */
  approver?: string;
  /** With `approver`: called once, when a tab redeems the pairing code. */
  onPaired?: (pairedAt: Date) => void;
  /** With `approver`: called for each task the paired tab approves. */
  onApproved?: (taskId: string) => void;
}

export interface MelraHttpServer {
  /**
   * Console URL, token included, ready to open. For an approval console, the
   * pairing code rides in the fragment instead, which no request line, log or
   * Referer carries.
   */
  url: string;
  /** MCP endpoint for a Streamable HTTP client. */
  mcpUrl: string;
  /** The bearer token; for an approval console, the one-time pairing code. */
  token: string;
  host: string;
  port: number;
  /**
   * The Unix socket being served, when there is one. `url`, `mcpUrl`, `host`
   * and `port` then only name the origin a client puts in its requests
   * (`http://localhost`); the connection itself goes to this path.
   */
  socketPath?: string;
  /**
   * Whether a client can authenticate itself instead of being handed the
   * token. Off when the server is bound somewhere a browser approval would not
   * mean anything, or when `MELRA_HTTP_OAUTH=0`.
   */
  oauth: boolean;
  close(): Promise<void>;
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

function html(
  response: ServerResponse,
  status: number,
  page: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(page),
    ...headers,
  });
  response.end(page);
}

/**
 * Length-independent comparison. The token guards a local API that can run
 * commands, so a timing oracle on it is worth closing even on loopback.
 */
function tokenMatches(expected: string, supplied: string | undefined): boolean {
  // Two empty strings compare equal, so an empty token would let `?token=` in.
  if (supplied === undefined || supplied === "" || expected === "") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function suppliedToken(
  request: IncomingMessage,
  url?: URL,
): string | undefined {
  const header = request.headers.authorization;
  if (header !== undefined && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  // `EventSource` cannot set headers, so the stream and the page it lives on
  // have to be reachable with the token in the query string.
  return url?.searchParams.get("token") ?? undefined;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const text = await readText(request);
  return text === "" ? undefined : JSON.parse(text);
}

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    // A local API still needs a ceiling: an unbounded POST is a way to run the
    // host out of memory without touching policy at all.
    if (size > 4_000_000) throw new Error("request_body_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** How a session records who opened it; the operator's token has no name. */
function callerRef(client: Principal | undefined): string {
  return client === undefined ? "operator" : principalRef(client);
}

/** Loopback is where "approve this in your browser" means anything. */
function isLoopback(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host.startsWith("127.")
  );
}

/** The `code` Node puts on a system error, if it is one. */
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/**
 * Makes `path` free for a new socket, or refuses.
 *
 * Only a socket this user owns that nobody answers on is removed — the leftover
 * of a run that crashed before it could clean up. Anything else at the path is
 * someone's data or someone's live server, and neither is ours to delete.
 */
async function clearStaleSocket(path: string): Promise<void> {
  let stats;
  try {
    // `lstat`, so a symlink planted at the path is judged as a symlink rather
    // than as whatever it points at.
    stats = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!stats.isSocket()) {
    throw new Error(
      `socket_path_exists: ${path} exists and is not a socket; refusing to remove it`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`socket_path_exists: ${path} belongs to another user`);
  }
  const refused = await new Promise<string | undefined>((resolveProbe) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolveProbe(undefined);
    });
    probe.once("error", (error) => resolveProbe(errorCode(error) ?? "error"));
  });
  // Only a refusal proves nobody is listening. A permission error or anything
  // else leaves that open, and taking over a live server's path strands it.
  if (refused === undefined) {
    throw new Error(`socket_in_use: another process is serving on ${path}`);
  }
  if (refused !== "ECONNREFUSED" && refused !== "ENOENT") {
    throw new Error(`socket_path_unusable: ${path}: ${refused}`);
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/**
 * Binds `server` to a Unix socket only this OS user can connect to.
 *
 * The file mode is the boundary on a socket — the token stays, but it is the
 * kernel refusing other users' `connect` that keeps them out — so the socket
 * must never exist wider than `0600`, not even between bind and a `chmod`. The
 * umask is narrowed around `listen` for that. Node binds a path synchronously
 * inside `listen`, so the umask is restored before any other code in this
 * process can create a file under it. The result is then checked rather than
 * trusted: a cluster worker, for one, has its socket bound by the primary
 * under the primary's umask, and an over-long path can be truncated.
 */
async function listenOnSocket(server: Server, path: string): Promise<void> {
  await clearStaleSocket(path);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    const previous = process.umask(0o177);
    try {
      server.listen(path, () => {
        server.removeListener("error", rejectListen);
        resolveListen();
      });
    } finally {
      process.umask(previous);
    }
  });
  let mode: number | undefined;
  try {
    const stats = lstatSync(path);
    const uid = process.getuid?.();
    if (stats.isSocket() && (uid === undefined || stats.uid === uid)) {
      mode = stats.mode & 0o777;
    }
  } catch {
    // Nothing at the path we asked for is the same failure as a wrong mode.
  }
  if (mode === undefined || (mode & 0o077) !== 0) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error(
      `socket_mode_too_wide: ${path} is ${mode === undefined ? "not a socket this user owns" : `mode 0${mode.toString(8)}`}; ` +
        "refusing to serve on a socket other users could open",
    );
  }
}

/**
 * The port `MELRA_HTTP_PORT` names, or undefined when it is unset, blank or not
 * a port. `0` is kept: it asks for any free port. Unset used to read as
 * `Number("")`, which is 0, so a plain `serve --http` took a random port
 * instead of the documented 7457 that `status` and every client probe.
 */
export function configuredHttpPort(environment: NodeJS.ProcessEnv): number | undefined {
  const raw = environment.MELRA_HTTP_PORT?.trim();
  if (raw === undefined || raw === "") return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : undefined;
}

export async function serveHttp(
  options: MelraHttpOptions,
): Promise<MelraHttpServer> {
  const environment = options.environment ?? process.env;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? configuredHttpPort(environment) ?? DEFAULT_HTTP_PORT;
  // An approval console has no standing token, only a code that one tab can
  // spend once for a session. Fixed or inherited, a token is one written down
  // somewhere, which a harness that started this process may have read.
  const pairing =
    options.approver === undefined
      ? undefined
      : {
          approver: options.approver,
          code: randomBytes(16).toString("hex"),
          // Not yet paired, then the paired page's session, then null once
          // that page has left: the code stays spent either way.
          session: undefined as string | null | undefined,
        };
  // An empty MELRA_HTTP_TOKEN (`MELRA_HTTP_TOKEN=${TOKEN}` with TOKEN unset) is
  // treated as unset, like an empty MELRA_SOCKET, so it gets a random token
  // rather than becoming one that matches an empty `?token=`.
  const token =
    pairing?.code ??
    options.token ??
    (environment.MELRA_HTTP_TOKEN?.trim() || randomUUID().replaceAll("-", ""));
  if (token.trim() === "") throw new Error("http_token_empty");
  // Least recently used first. `busy` counts requests in flight, an open event
  // stream included, so a session is never ended under a call it is serving.
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; client: string; busy: number }
  >();
  const runtime = options.runtime;
  const enforced = runtime.policy.mode === "enforced";
  const socketPath =
    options.socketPath === undefined ? undefined : resolve(options.socketPath);
  // An approval is a person at this machine's browser: no browser reaches a
  // socket, and anywhere wider than loopback is not this machine. First, so it
  // is the answer on every platform and in every mode.
  if (pairing !== undefined && (socketPath !== undefined || !isLoopback(host))) {
    throw new Error("approval_console_loopback_only");
  }
  // Windows has named pipes instead, and their default ACL is not a mode this
  // process can set or read back from Node. A transport sold as "only you can
  // connect" that cannot check that claim is worse than none, so refuse it.
  if (socketPath !== undefined && process.platform === "win32") {
    throw new Error(
      "socket_transport_unsupported_on_windows: use stdio or loopback HTTP",
    );
  }
  // The socket is kept at 0600 by narrowing the umask around `listen`, and
  // `process.umask(mask)` throws in a worker thread. Say so up front rather
  // than fail later with an error that names neither MELRA nor the socket.
  if (socketPath !== undefined && !isMainThread) {
    throw new Error(
      "socket_transport_requires_main_thread: serve a socket from the main thread, or use loopback HTTP",
    );
  }
  // A sandbox talks to its kernel over IPC. A listener on a routable interface
  // is not that, whatever the token guarding it, so enforced mode refuses to
  // start rather than start something it would have to describe as a second door.
  // A Unix socket is that IPC, and narrower than loopback, so it is allowed.
  if (enforced && socketPath === undefined && !isLoopback(host)) {
    throw new Error("enforced_mode_refuses_public_bind");
  }
  // A browser approval is only a boundary on the machine the browser is on. A
  // server deliberately bound to a wider interface keeps the shared token and
  // nothing else, rather than offering the internet a registration endpoint.
  //
  // Enforced mode drops it on loopback too: self-registration is a stranger
  // asking a human to let it in, and the whole claim of enforced mode is that
  // only identities the operator issued can reach the kernel at all.
  //
  // A socket drops it for the first reason: no browser can reach a Unix socket,
  // so there is nobody to show a consent page to.
  const oauthEnabled =
    pairing === undefined &&
    !enforced &&
    socketPath === undefined &&
    isLoopback(host) &&
    environment.MELRA_HTTP_OAUTH?.trim() !== "0";
  const oauth = oauthEnabled
    ? new OAuthProvider(runtime.dataDirectory)
    : undefined;
  // The bound port is only known after `listen`, and metadata that names the
  // wrong port sends a client to a door that is not there.
  // A socket has no host or port, so its requests name plain `localhost`.
  let origin =
    socketPath === undefined ? `http://${host}:${port}` : "http://localhost";
  /** `Host` values a loopback listener answers; unset until it is listening. */
  let loopbackHosts: Set<string> | undefined;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // An id that resolves to nothing is a 404, not a malformed request. The
      // controllers signal that the only way they can, by throwing.
      const status = message.endsWith("_not_found") ? 404 : 400;
      if (!response.headersSent) json(response, status, { error: message });
      else response.end();
    });
  });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", origin);
    if (pairing !== undefined) {
      await handleApprovals(request, response, url, pairing);
      return;
    }
    if (await handleOAuth(request, response, url)) return;
    const caller = authenticate(suppliedToken(request, url));
    if (caller === undefined) {
      json(
        response,
        401,
        {
          error: "unauthorized",
          detail:
            "Send the token printed at startup as `Authorization: Bearer <token>` or `?token=<token>`.",
          ...(oauth === undefined
            ? {}
            : {
                oauth: `${origin}/.well-known/oauth-protected-resource`,
              }),
        },
        // What lets an MCP client discover the authorization server instead of
        // simply reporting that it was refused.
        oauth === undefined
          ? {}
          : {
              "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
            },
      );
      return;
    }
    if (url.pathname === "/mcp") {
      await handleMcp(
        request,
        response,
        caller === "operator" ? undefined : caller,
      );
      return;
    }
    await handleApi(request, response, url);
  }

  /**
   * The operator's own token, or a client that completed the OAuth flow.
   *
   * The operator is `"operator"` rather than a principal because the token is
   * the machine's key, not a name: attributing an effect to it would put a
   * client name in a receipt that nobody registered.
   */
  function authenticate(
    supplied: string | undefined,
  ): Principal | "operator" | undefined {
    if (tokenMatches(token, supplied)) return "operator";
    if (supplied === undefined || oauth === undefined) return undefined;
    const client = oauth.clientFor(supplied);
    return client === undefined ? undefined : clientPrincipal(client);
  }

  /**
   * The unauthenticated half of the surface: discovery, registration, consent
   * and token exchange. Returns whether it took the request.
   */
  async function handleOAuth(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (oauth === undefined) return false;
    const path = url.pathname.replace(/\/mcp$/, "");
    const method = request.method ?? "GET";
    if (!path.startsWith("/.well-known/") && !path.startsWith("/oauth/")) return false;
    // Everything else needs the token, which a rebound page does not have;
    // these routes do not.
    if (!hostAllowed(request, response, "sign-in")) return true;
    try {
      if (path === "/.well-known/oauth-protected-resource") {
        json(response, 200, oauth.resourceMetadata(origin));
        return true;
      }
      if (
        path === "/.well-known/oauth-authorization-server" ||
        path === "/.well-known/openid-configuration"
      ) {
        json(response, 200, oauth.metadata(origin));
        return true;
      }
      if (url.pathname === "/oauth/register" && method === "POST") {
        const body = (await readBody(request)) ?? {};
        json(response, 201, oauth.register(body as Record<string, unknown>));
        return true;
      }
      if (url.pathname === "/oauth/authorize" && method === "GET") {
        html(response, 200, oauth.consentPage(url.searchParams), CONSENT_HEADERS);
        return true;
      }
      if (url.pathname === "/oauth/authorize" && method === "POST") {
        const form = new URLSearchParams(await readText(request));
        // The decision is the whole gate. Without this, any process that could
        // reach the port, or a page rebound to it, approved its own client.
        if (
          form.get("decision") === "approve" &&
          // Trimmed like every other place the token is read: a pasted token
          // often carries a stray space.
          !tokenMatches(token, form.get("operator_token")?.trim())
        ) {
          const page = oauth.consentPage(requestOf(form), "That is not this server's token.");
          html(response, 403, page, CONSENT_HEADERS);
          return true;
        }
        const target = oauth.decide(form);
        response.writeHead(302, { location: target, "cache-control": "no-store" });
        response.end();
        return true;
      }
      if (url.pathname === "/oauth/token" && method === "POST") {
        json(response, 200, oauth.token(new URLSearchParams(await readText(request))));
        return true;
      }
    } catch (error) {
      // OAuth names its own failures, and a client reads that name rather than
      // the prose: `invalid_grant` is what makes it re-run the flow.
      const message = error instanceof Error ? error.message : String(error);
      const [code, ...rest] = message.split(":");
      json(response, 400, {
        error: code ?? "invalid_request",
        ...(rest.length === 0 ? {} : { error_description: rest.join(":") }),
      });
      return true;
    }
    return false;
  }

  /**
   * A web page can rename itself to 127.0.0.1 (DNS rebinding) and talk to this
   * server as its own origin, from the operator's browser, so a route such a
   * page must not reach answers only to a loopback name. Any port: a rebound
   * page keeps its own name whatever the port, and an SSH tunnel arrives on a
   * different one.
   */
  function hostAllowed(request: IncomingMessage, response: ServerResponse, what = "this"): boolean {
    const hostname = (request.headers.host ?? "").toLowerCase().replace(/:\d*$/, "");
    if (loopbackHosts === undefined || loopbackHosts.has(hostname)) return true;
    json(response, 421, {
      error: "host_not_allowed",
      detail: `Use ${origin}; ${what} answers only to this machine's loopback names.`,
    });
    return false;
  }

  /**
   * Whether a POST came from the console page itself. A browser puts the
   * page's origin on every POST it sends and no page can change it, so this
   * refuses every other page, another port on this machine included: same
   * site, never the same origin. JSON on top, which no other origin can send
   * without a CORS preflight that this server never answers.
   */
  function fromConsole(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.headers.origin !== `http://${request.headers.host ?? ""}`) {
      json(response, 403, { error: "origin_not_allowed" });
      return false;
    }
    const type = (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") {
      json(response, 415, { error: "json_required" });
      return false;
    }
    return true;
  }

  /**
   * The approval console's whole surface: the page, pairing and unpairing,
   * the read-only API, and one read and two writes per pending task. Every route answers
   * only to a loopback name. The page is the same static text for anyone;
   * everything past it needs the session that pairing gave one tab, sent as a
   * header and never in a URL.
   */
  async function handleApprovals(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    console_: NonNullable<typeof pairing>,
  ): Promise<void> {
    if (!hostAllowed(request, response)) return;
    const method = request.method ?? "GET";
    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      sendConsole(response, true);
      return;
    }
    if (url.pathname === "/pair" && method === "POST") {
      if (!fromConsole(request, response)) return;
      const body = (await readBody(request)) as { code?: unknown } | undefined;
      // Spent is checked first, so a late tab learns only that it is late.
      if (console_.session !== undefined) {
        json(response, 409, {
          error: "console_already_paired",
          detail:
            "Another page paired with this console first. Stop it with Ctrl-C, cancel each task its terminal lists as approved (`melra approve <task-id> --deny`), and run `melra console` again.",
        });
        return;
      }
      const code = typeof body?.code === "string" ? body.code : undefined;
      if (!tokenMatches(console_.code, code)) {
        json(response, 403, { error: "pairing_code_invalid" });
        return;
      }
      console_.session = randomBytes(32).toString("hex");
      const pairedAt = new Date();
      options.onPaired?.(pairedAt);
      json(response, 200, { session: console_.session, pairedAt: pairedAt.toISOString() });
      return;
    }
    if (typeof console_.session !== "string" || !tokenMatches(console_.session, suppliedToken(request))) {
      json(response, 401, {
        error: "unauthorized",
        detail: "Only the page that paired with this console, while it stays open, can use it.",
      });
      return;
    }
    if (url.pathname === "/unpair") {
      if (method !== "POST") {
        json(response, 405, { error: "method_not_allowed" });
        return;
      }
      if (!fromConsole(request, response)) return;
      // The page sends this as it leaves, or when something else moves it, so
      // the session it held is worth nothing after, here as well as there.
      console_.session = null;
      json(response, 200, { unpaired: true });
      return;
    }
    const route = /^\/api\/tasks\/([^/]+)\/(approval|approve|deny)$/.exec(url.pathname);
    if (route?.[1] === undefined) {
      await handleApi(request, response, url);
      return;
    }
    const taskId = route[1];
    const read = route[2] === "approval";
    if (method !== (read ? "GET" : "POST")) {
      json(response, 405, { error: "method_not_allowed" });
      return;
    }
    if (!read && !fromConsole(request, response)) return;
    // The screen and the digest come from one view, and `decide` refuses any
    // other digest, so a decision covers exactly what the operator was shown.
    const view = runtime.controller.approvalView(taskId);
    if (read) {
      json(response, 200, {
        taskId,
        mode: runtime.policy.mode,
        expiresAt: view.task.approval?.expiresAt,
        renderDigest: view.renderDigest,
        // Apart, so a page can show the bounded summary right above its
        // buttons, where the terminal shows it, and the dump anywhere else.
        contract: printable(JSON.stringify(view.contract, null, 2), true),
        summary: approvalSummary(view),
        decision: runtime.controller.approvalDecision(view.task) ?? null,
      });
      return;
    }
    if (route[2] === "deny") {
      // Another process may have started it since the page drew it: then it
      // runs, and the page must not say it was denied.
      const task = runtime.controller.cancel(taskId);
      if (task.status !== "cancelled") throw new Error(`task_not_cancellable:${task.status}`);
      json(response, 200, { task });
      return;
    }
    const body = (await readBody(request)) as { taskId?: unknown; renderDigest?: unknown } | undefined;
    // The page names the task it drew as well as the digest it drew, both
    // taken when it drew them, so nothing that changed since redirects this.
    if (body?.taskId !== taskId) throw new Error("approval_task_mismatch");
    if (typeof body.renderDigest !== "string") throw new Error("render_digest_required");
    const decision = runtime.controller.decide(taskId, body.renderDigest, console_.approver);
    options.onApproved?.(taskId);
    json(response, 200, { decision });
  }

  function sendConsole(response: ServerResponse, approvals = false): void {
    const page = consolePage(approvals);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(page),
      ...consoleSecurityHeaders(),
    });
    response.end(page);
  }

  async function handleMcp(
    request: IncomingMessage,
    response: ServerResponse,
    client?: Principal,
  ): Promise<void> {
    const sessionId = request.headers["mcp-session-id"];
    if (sessionId !== undefined) {
      const existing =
        typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (typeof sessionId !== "string" || existing === undefined) {
        // Ended, crowded out, or from before a restart. A 404 is what tells
        // an MCP client to start a new session; a 400 reads as a hard error.
        json(response, 404, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "mcp_session_not_found" },
          id: null,
        });
        return;
      }
      // The session carries the identity it was opened with, so a second
      // authenticated client cannot pick up someone else's session id and have
      // its effects recorded under the first client's name.
      if (existing.client !== callerRef(client)) {
        json(response, 403, { error: "mcp_session_belongs_to_another_client" });
        return;
      }
      sessions.delete(sessionId);
      sessions.set(sessionId, existing);
      hold(existing, request, response);
      await existing.transport.handleRequest(request, response);
      return;
    }
    if (request.method !== "POST") {
      json(response, 400, { error: "mcp_session_not_found" });
      return;
    }
    const body = await readBody(request);
    if (!isInitializeRequest(body)) {
      json(response, 400, { error: "mcp_session_not_found" });
      return;
    }
    // One MCP server per session, one runtime underneath. Sessions are isolated
    // in protocol state; durable state is shared exactly as two stdio servers
    // over one data directory already share it, and the workflow leases are
    // what keep that safe.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        const session = { transport, client: callerRef(client), busy: 0 };
        hold(session, request, response);
        sessions.set(id, session);
        // Back down to the cap, not one at a time: after a burst of busy
        // sessions it would otherwise stay at its peak. A busy one is a client
        // still there, so while every session is busy the map stays over.
        for (const [idle, { transport: stale, busy }] of sessions) {
          if (sessions.size <= MAX_MCP_SESSIONS) return;
          if (busy > 0) continue;
          sessions.delete(idle);
          void stale.close().catch(() => undefined);
        }
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    const mcp = createMcpServer(runtime, client);
    transport.onclose = () => {
      if (transport.sessionId !== undefined) {
        sessions.delete(transport.sessionId);
      }
    };
    // The transport declares `onclose` as a getter returning
    // `(() => void) | undefined`, which `exactOptionalPropertyTypes` will not
    // accept against `Transport`'s `onclose?: () => void`. The runtime shape is
    // right; only the SDK's declaration disagrees.
    await mcp.connect(transport as unknown as Transport);
    await transport.handleRequest(request, response, body);
  }

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.method !== "GET") {
      json(response, 405, { error: "method_not_allowed" });
      return;
    }
    const path = url.pathname;
    if (path === "/" || path === "/index.html") {
      sendConsole(response);
      return;
    }
    if (path === "/api/capabilities") {
      json(response, 200, capabilitiesPayload(runtime));
      return;
    }
    if (path === "/api/workflows") {
      json(response, 200, { workflows: runtime.store.listWorkflowRuns() });
      return;
    }
    if (path === "/api/tasks") {
      const limit = Number(url.searchParams.get("limit") ?? "50");
      json(response, 200, {
        tasks: runtime.store.listTasks(
          Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 50,
        ),
      });
      return;
    }
    const workflowEvents = /^\/api\/workflows\/([^/]+)\/events$/.exec(path);
    if (workflowEvents?.[1] !== undefined) {
      const after = Number(url.searchParams.get("after") ?? "0");
      json(response, 200, {
        events: runtime.workflows.events(
          workflowEvents[1],
          Number.isFinite(after) ? after : 0,
        ),
      });
      return;
    }
    const workflowStream = /^\/api\/workflows\/([^/]+)\/stream$/.exec(path);
    if (workflowStream?.[1] !== undefined) {
      streamWorkflow(response, workflowStream[1], url);
      return;
    }
    const workflow = /^\/api\/workflows\/([^/]+)$/.exec(path);
    if (workflow?.[1] !== undefined) {
      json(response, 200, runtime.workflows.status(workflow[1]));
      return;
    }
    const receipts = /^\/api\/tasks\/([^/]+)\/receipts$/.exec(path);
    if (receipts?.[1] !== undefined) {
      json(response, 200, runtime.controller.receipts({ taskId: receipts[1] }));
      return;
    }
    const task = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (task?.[1] !== undefined) {
      json(response, 200, runtime.controller.status(task[1]));
      return;
    }
    json(response, 404, { error: "not_found", path });
  }

  /**
   * Append-only events replayed from `after` and then followed live.
   *
   * ponytail: polls the event table. The store has no change notification and a
   * local console watching one workflow is not worth building one for; swap in
   * a listener here if the console ever follows every workflow at once.
   */
  function streamWorkflow(
    response: ServerResponse,
    workflowId: string,
    url: URL,
  ): void {
    // Resolve the id before committing to a 200: a typo should be a 404, not an
    // open stream that never says anything.
    runtime.workflows.status(workflowId);
    const parsed = Number(url.searchParams.get("after") ?? "0");
    let cursor = Number.isFinite(parsed) ? parsed : 0;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const tick = () => {
      let events;
      try {
        events = runtime.workflows.events(workflowId, cursor);
      } catch {
        response.end();
        return;
      }
      for (const event of events) {
        cursor = event.sequence;
        // Deliberately unnamed frames. `WorkflowEvent.type` is an open string,
        // so naming the SSE event would make every consumer enumerate a set
        // that grows with each node type; the type rides inside the payload.
        response.write(
          `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      }
      // A comment frame keeps intermediaries and the client's own idle timer
      // from closing a workflow that is simply waiting on an approval.
      response.write(": keep-alive\n\n");
    };
    tick();
    const timer = setInterval(tick, 500);
    timer.unref();
    response.on("close", () => {
      clearInterval(timer);
    });
  }

  if (socketPath !== undefined) {
    await listenOnSocket(server, socketPath);
    return {
      url: `${origin}/?token=${token}`,
      mcpUrl: `${origin}/mcp`,
      token,
      host: "localhost",
      port: 0,
      socketPath,
      oauth: false,
      close,
    };
  }
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const boundPort =
    typeof address === "object" && address !== null ? address.port : port;
  const authority = host.includes(":") ? `[${host}]` : host;
  origin = `http://${authority}:${boundPort}`;
  if (isLoopback(host)) {
    loopbackHosts = new Set([authority, "127.0.0.1", "localhost", "[::1]"]);
  }

  return {
    // No `&` in it: Windows' `start` would read one as a second command.
    url: pairing === undefined ? `${origin}/?token=${token}` : `${origin}/#pair=${token}`,
    mcpUrl: `${origin}/mcp`,
    token,
    host,
    port: boundPort,
    oauth: oauthEnabled,
    close,
  };

  // Node unlinks a Unix socket's file when its server closes, so a clean
  // shutdown leaves nothing for the next start to have to judge stale.
  async function close(): Promise<void> {
    for (const session of sessions.values()) await session.transport.close();
    sessions.clear();
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
      // An open event stream is a live socket, and `close` waits on live
      // sockets. Without this a console left open holds the process forever.
      server.closeAllConnections();
    });
  }
}
