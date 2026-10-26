// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMelraRuntime, serveHttp } from "../src/index.js";
import type { MelraHttpServer } from "../src/http-server.js";
import type { MelraRuntime } from "../src/runtime.js";

/**
 * `fetch` over a Unix socket, built on `http.request`, which is the one client
 * in Node that takes a `socketPath` without a dependency. Streams the body so
 * the MCP client's SSE responses arrive as they are written.
 */
function socketFetch(socketPath: string) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const outgoing = new Request(input, init);
    const url = new URL(outgoing.url);
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
      outgoing.signal.addEventListener("abort", () =>
        request.destroy(new Error("aborted")),
      );
      request.on("error", rejectResponse);
      request.end(body);
    });
  };
}

/** A socket file nobody is listening on: what a crashed run leaves behind. */
function staleSocket(path: string): void {
  // SIGKILL, so the child cannot run the cleanup a clean close would.
  spawnSync(process.execPath, [
    "-e",
    `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`,
  ]);
}

describe.skipIf(process.platform === "win32")("melra over a Unix socket", () => {
  let workspace: string;
  let home: string;
  let socketDirectory: string;
  let socketPath: string;
  let runtime: MelraRuntime;
  let served: MelraHttpServer | undefined;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), "melra-sock-ws-"));
    home = mkdtempSync(join(tmpdir(), "melra-sock-home-"));
    // Short on purpose: a socket path has a ~104-byte ceiling on macOS.
    socketDirectory = mkdtempSync(join(tmpdir(), "ms-"));
    socketPath = join(socketDirectory, "melra.sock");
    writeFileSync(join(workspace, "note.txt"), "hello\n", "utf8");
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: home,
    });
  });

  afterEach(async () => {
    await served?.close();
    served = undefined;
    await runtime.close();
    for (const directory of [workspace, home, socketDirectory]) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const serve = async () => {
    served = await serveHttp({
      runtime,
      socketPath,
      token: "test-token",
      environment: {},
    });
    return served;
  };

  it("creates the socket owner-only and removes it on close", async () => {
    const endpoint = await serve();
    expect(endpoint.socketPath).toBe(socketPath);
    const stats = lstatSync(socketPath);
    expect(stats.isSocket()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o600);
    // Nobody can reach a consent page on a socket, so there is none.
    expect(endpoint.oauth).toBe(false);

    await endpoint.close();
    served = undefined;
    expect(existsSync(socketPath)).toBe(false);
  });

  it("still requires the token on every request", async () => {
    await serve();
    const status = await new Promise<number | undefined>((resolveStatus, rejectStatus) => {
      httpRequest({ socketPath, path: "/api/capabilities" }, (response) => {
        response.resume();
        resolveStatus(response.statusCode);
      })
        .on("error", rejectStatus)
        .end();
    });
    expect(status).toBe(401);
    // And no OAuth discovery hint, since nothing on a socket can follow it.
    const metadata = await socketFetch(socketPath)(
      "http://localhost/.well-known/oauth-protected-resource",
    );
    expect(metadata.status).toBe(401);
  });

  it("plans, executes and reads a receipt through a real MCP client", async () => {
    const endpoint = await serve();
    const fetchOverSocket = socketFetch(socketPath);
    const client = new Client({ name: "socket-test", version: "0.0.0" });
    await client.connect(
      // The SDK types `sessionId` as `string | undefined`, which
      // `exactOptionalPropertyTypes` rejects against `Transport`'s optional
      // `sessionId?: string`. Same cast as src/http-server.ts.
      new StreamableHTTPClientTransport(new URL(endpoint.mcpUrl), {
        fetch: fetchOverSocket,
        requestInit: { headers: { authorization: "Bearer test-token" } },
      }) as unknown as Transport,
    );
    try {
      const planned = await client.callTool({
        name: "melra_plan",
        arguments: {
          goal: "Read one file over a Unix socket",
          operation: { kind: "file", action: "read", path: "note.txt" },
        },
      });
      const plan = JSON.parse(
        (planned.content as { type: string; text: string }[])[0]!.text,
      ) as { id: string; status: string };
      expect(plan.status).toBe("planned");

      const executed = await client.callTool({
        name: "melra_execute",
        arguments: { taskId: plan.id },
      });
      const executedText = (
        executed.content as { type: string; text: string }[]
      )[0]!.text;
      expect(executed.isError, executedText).toBeFalsy();
      expect(
        (JSON.parse(executedText) as { task: { status: string } }).task.status,
      ).toBe("verified_success");

      const receipt = await client.callTool({
        name: "melra_receipt",
        arguments: { taskId: plan.id },
      });
      const receiptText = (
        receipt.content as { type: string; text: string }[]
      )[0]!.text;
      expect(receipt.isError, receiptText).toBeFalsy();
      expect(
        (JSON.parse(receiptText) as { receipts: unknown[] }).receipts.length,
      ).toBeGreaterThan(0);

      // The read-only API is behind the same socket and the same token.
      const status = await fetchOverSocket(
        `http://localhost/api/tasks/${plan.id}`,
        { headers: { authorization: "Bearer test-token" } },
      );
      expect(((await status.json()) as { status: string }).status).toBe(
        "verified_success",
      );
    } finally {
      await client.close();
    }
  });

  it("replaces a stale socket left by a crashed run", async () => {
    staleSocket(socketPath);
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    await serve();
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it("never removes a regular file at the path", async () => {
    writeFileSync(socketPath, "not a socket", "utf8");
    await expect(serve()).rejects.toThrow(/socket_path_exists/);
    expect(readFileSync(socketPath, "utf8")).toBe("not a socket");
  });

  it("does not take over a socket another server is answering on", async () => {
    const other = createNetServer();
    await new Promise<void>((resolveListen) =>
      other.listen(socketPath, () => resolveListen()),
    );
    try {
      await expect(serve()).rejects.toThrow(/socket_in_use/);
      expect(lstatSync(socketPath).isSocket()).toBe(true);
    } finally {
      await new Promise<void>((resolveClose) => other.close(() => resolveClose()));
    }
  });

  it("is allowed in enforced mode, where a public bind is not", async () => {
    await runtime.close();
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: home,
      environment: { MELRA_MODE: "enforced" },
    });
    // A socket is the IPC enforced mode asks for, and narrower than loopback;
    // a host passed alongside it is not bound and so is not a second door.
    const endpoint = await serveHttp({
      runtime,
      socketPath,
      host: "0.0.0.0",
      token: "test-token",
      environment: {},
    });
    served = endpoint;
    expect(endpoint.oauth).toBe(false);
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
  });
});

describe.skipIf(process.platform === "win32")("a socket from a worker thread", () => {
  it("is refused with an error that says why", async () => {
    // The built package, because a worker cannot load the TypeScript source.
    const entry = pathToFileURL(resolve(import.meta.dirname, "../dist/index.js")).href;
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       import(workerData.entry)
         .then(({ serveHttp }) => serveHttp({
           runtime: { policy: { mode: "developer" } },
           socketPath: workerData.socketPath,
         }))
         .then(() => parentPort.postMessage("served"), (error) => parentPort.postMessage(String(error.message)));`,
      { eval: true, workerData: { entry, socketPath: join(tmpdir(), `melra-worker-${process.pid}.sock`) } },
    );
    const message = await new Promise<string>((resolveMessage) => worker.once("message", resolveMessage));
    await worker.terminate();
    expect(message).toMatch(/^socket_transport_requires_main_thread/);
  });
});

describe.runIf(process.platform === "win32")("melra over a Unix socket on Windows", () => {
  it("refuses, because a named pipe's ACL is not a mode it can check", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "melra-sock-ws-"));
    const home = mkdtempSync(join(tmpdir(), "melra-sock-home-"));
    const runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: home,
    });
    try {
      await expect(
        serveHttp({
          runtime,
          socketPath: "\\\\.\\pipe\\melra-test",
          environment: {},
        }),
      ).rejects.toThrow(/socket_transport_unsupported_on_windows/);
    } finally {
      await runtime.close();
      rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
