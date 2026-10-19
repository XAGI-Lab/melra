// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMelraRuntime, serveHttp } from "@melra/server";
import { MelraClient } from "../src/index.js";

type Runtime = Awaited<ReturnType<typeof createMelraRuntime>>;
type Served = Awaited<ReturnType<typeof serveHttp>>;

/**
 * The same three calls over each remote transport, against a real server in
 * this process: what matters is that the tool methods do not care which wire
 * they are on, and that `close()` lets the server shut down cleanly.
 */
async function capabilitiesPlanReceipt(melra: MelraClient): Promise<void> {
  const capabilities = await melra.capabilities();
  expect(capabilities.product).toBe("MELRA");

  const task = await melra.plan({
    goal: "Read one file remotely",
    operation: { kind: "file", action: "read", path: "note.txt" },
  });
  expect(task.status).toBe("planned");

  const executed = await melra.execute(task.id as string);
  expect((executed.task as { status: string }).status).toBe("verified_success");

  const receipt = await melra.receipt({ taskId: task.id as string });
  expect((receipt.receipts as unknown[]).length).toBeGreaterThan(0);
}

describe("MelraClient over remote transports", () => {
  let workspace: string;
  let home: string;
  let socketDirectory: string;
  let runtime: Runtime;
  const servers: Served[] = [];

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "melra-sdk-ws-"));
    home = mkdtempSync(join(tmpdir(), "melra-sdk-home-"));
    // Short on purpose: a socket path has a ~104-byte ceiling on macOS.
    socketDirectory = mkdtempSync(join(tmpdir(), "ms-"));
    writeFileSync(join(workspace, "note.txt"), "hello\n", "utf8");
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: home,
    });
  });

  afterAll(async () => {
    for (const served of servers) await served.close();
    await runtime.close();
    for (const directory of [workspace, home, socketDirectory]) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const serve = async (options: { socketPath?: string } = {}) => {
    const served = await serveHttp({
      runtime,
      port: 0,
      token: "test-token",
      environment: {},
      ...options,
    });
    servers.push(served);
    return served;
  };

  it("works over loopback HTTP", async () => {
    const served = await serve();
    const melra = await MelraClient.connect({
      url: served.mcpUrl,
      token: "test-token",
    });
    try {
      await capabilitiesPlanReceipt(melra);
    } finally {
      await melra.close();
    }
  });

  it("ends its session on the server when closed", async () => {
    const served = await serve();
    const melra = await MelraClient.connect({ url: served.mcpUrl, token: "test-token" });
    const { sessionId } = (
      melra as unknown as { client: { transport: { sessionId?: string } } }
    ).client.transport;
    expect(sessionId).toBeTruthy();
    await melra.close();
    // Closing used to abort only the client's requests: the server kept the
    // session, and this request still got the tool list.
    const reused = await fetch(served.mcpUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(reused.status).toBe(404);
  });

  it("accepts the bare origin, as the console URL prints it", async () => {
    const served = await serve();
    const melra = await MelraClient.connect({
      url: `http://${served.host}:${served.port}/?token=test-token`,
      token: "test-token",
    });
    await melra.close();
  });

  it.skipIf(process.platform === "win32")("works over a Unix socket", async () => {
    const socketPath = join(socketDirectory, "melra.sock");
    await serve({ socketPath });
    const melra = await MelraClient.connect({ socketPath, token: "test-token" });
    try {
      await capabilitiesPlanReceipt(melra);
    } finally {
      await melra.close();
    }
  });

  it("names a refused token instead of a generic HTTP failure", async () => {
    const served = await serve();
    await expect(
      MelraClient.connect({ url: served.mcpUrl, token: "wrong-token" }),
    ).rejects.toThrow(/melra_unauthorized/);
  });

  it.skipIf(process.platform === "win32")(
    "names a refused token over a socket too",
    async () => {
      const socketPath = join(socketDirectory, "wrong.sock");
      await serve({ socketPath });
      await expect(
        MelraClient.connect({ socketPath, token: "wrong-token" }),
      ).rejects.toThrow(/melra_unauthorized/);
    },
  );

  it("refuses to send the token over plain HTTP to a non-loopback host", async () => {
    for (const url of [
      "http://example.com:7457/mcp",
      "http://192.168.1.10:7457/mcp",
      "http://0.0.0.0:7457/mcp",
    ]) {
      await expect(
        MelraClient.connect({ url, token: "test-token" }),
        url,
      ).rejects.toThrow(/melra_insecure_url/);
    }
    // The opt-out lifts only that refusal: the connection is then attempted
    // (and fails at DNS here; `.invalid` never resolves), rather than refused up front.
    await expect(
      MelraClient.connect({
        url: "http://melra-test.invalid:9/mcp",
        token: "test-token",
        allowInsecureHttp: true,
      }),
    ).rejects.not.toThrow(/melra_insecure_url/);
  });

  it("refuses an empty token before connecting", async () => {
    await expect(
      MelraClient.connect({ url: "http://127.0.0.1:1/mcp", token: " " }),
    ).rejects.toThrow(/melra_token_required/);
  });
});

describe.runIf(process.platform === "win32")("MelraClient sockets on Windows", () => {
  it("refuses, as the server does", async () => {
    await expect(
      MelraClient.connect({ socketPath: "\\\\.\\pipe\\melra", token: "t" }),
    ).rejects.toThrow(/socket_transport_unsupported_on_windows/);
  });
});
