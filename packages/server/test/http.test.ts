// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { TaskRequestSchema, WorkflowDefinitionSchema } from "@melra/protocol";
import { DEFAULT_HTTP_PORT, configuredHttpPort, createMelraRuntime, serveHttp } from "../src/index.js";
import type { MelraHttpServer } from "../src/http-server.js";
import type { MelraRuntime } from "../src/runtime.js";

/**
 * The HTTP surface is a second front door onto the same runtime, so what these
 * tests care about is that it is the *same* runtime and that the door is shut:
 * no token, no answer.
 */
describe("melra http server", () => {
  let workspace: string;
  let home: string;
  let runtime: MelraRuntime;
  let http: MelraHttpServer;
  let base: string;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "melra-http-ws-"));
    home = mkdtempSync(join(tmpdir(), "melra-http-home-"));
    writeFileSync(join(workspace, "note.txt"), "hello\n", "utf8");
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: home,
    });
    // Port 0 so a developer already serving on the default port can still run
    // the suite, and two runs in parallel cannot collide.
    http = await serveHttp({
      runtime,
      port: 0,
      token: "test-token",
      environment: {},
    });
    base = `http://${http.host}:${http.port}`;
  });

  afterAll(async () => {
    await http.close();
    await runtime.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const authed = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { authorization: "Bearer test-token" },
    });

  it("refuses every route without the token", async () => {
    for (const path of ["/", "/api/capabilities", "/api/workflows", "/mcp"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(401);
    }
  });

  it("refuses a wrong token", async () => {
    const response = await fetch(`${base}/api/capabilities`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(response.status).toBe(401);
  });

  it("treats an empty MELRA_HTTP_TOKEN as unset rather than as a token", async () => {
    // `MELRA_HTTP_TOKEN=${TOKEN}` with TOKEN unset: an empty token used to
    // match `?token=` and an empty Bearer header, so anyone was the operator.
    const blank = await serveHttp({
      runtime,
      port: 0,
      environment: { MELRA_HTTP_TOKEN: "  " },
    });
    try {
      expect(blank.token.length).toBeGreaterThan(16);
      const origin = `http://${blank.host}:${blank.port}`;
      expect((await fetch(`${origin}/api/capabilities?token=`)).status).toBe(401);
      const bearer = await fetch(`${origin}/api/capabilities`, {
        headers: { authorization: "Bearer " },
      });
      expect(bearer.status).toBe(401);
    } finally {
      await blank.close();
    }
    await expect(serveHttp({ runtime, port: 0, token: "", environment: {} })).rejects.toThrow(
      "http_token_empty",
    );
  });

  it("listens on 7457 when no port is given and MELRA_HTTP_PORT is unset or blank", async () => {
    expect(configuredHttpPort({})).toBeUndefined();
    expect(configuredHttpPort({ MELRA_HTTP_PORT: " " })).toBeUndefined();
    expect(configuredHttpPort({ MELRA_HTTP_PORT: "0" })).toBe(0);
    expect(configuredHttpPort({ MELRA_HTTP_PORT: " 8080 " })).toBe(8080);
    for (const environment of [{}, { MELRA_HTTP_PORT: "" }]) {
      // Unset read as Number(""), which is 0: a random port every restart.
      const served = await serveHttp({ runtime, token: "t", environment }).catch(
        (error: Error) => error,
      );
      if (served instanceof Error) {
        // Something on this machine holds the default port, or the OS reserves
        // it (EACCES in a Windows excluded range): it was still the one asked for.
        expect((served as Error & { port?: number }).port).toBe(DEFAULT_HTTP_PORT);
        continue;
      }
      try {
        expect(served.port).toBe(DEFAULT_HTTP_PORT);
      } finally {
        await served.close();
      }
    }
  });

  it("answers sign-in only to loopback names, so a rebound page gets nothing", async () => {
    // What a page at attacker.example sends once its name resolves to 127.0.0.1.
    const status = (host: string, path = "/.well-known/oauth-authorization-server") =>
      new Promise<number>((resolve, reject) => {
        const call = httpRequest(
          { host: http.host, port: http.port, path, headers: { host } },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        call.on("error", reject);
        call.end();
      });
    expect(await status(`attacker.example:${http.port}`)).toBe(421);
    expect(await status("attacker.example")).toBe(421);
    expect(await status(`localhost.attacker.example:${http.port}`)).toBe(421);
    // Any port: an SSH tunnel or forwarded port arrives on its own.
    for (const name of ["127.0.0.1", "localhost", "LOCALHOST", "[::1]", "localhost:9000", "127.0.0.1"]) {
      const host = name.includes(":") && !name.startsWith("[") ? name : `${name}:${http.port}`;
      expect(await status(host), host).not.toBe(421);
    }
    // A route that needs the token answers under any name: a container reaching
    // the host as host.docker.internal still gets in with it, and a rebound
    // page without it still gets a 401.
    expect(await status("host.docker.internal:7457", "/api/capabilities?token=test-token")).toBe(200);
    expect(await status("attacker.example", "/api/capabilities")).toBe(401);
  });

  it("accepts the token in the query string, for EventSource", async () => {
    const response = await fetch(`${base}/api/capabilities?token=test-token`);
    expect(response.status).toBe(200);
  });

  it("reports the same capabilities the MCP tool reports", async () => {
    const response = await authed("/api/capabilities");
    const body = (await response.json()) as {
      product: string;
      tools: string[];
      policy: { unhinged: boolean; workspaceRoot: string };
    };
    expect(body.product).toBe("MELRA");
    expect(body.tools).toHaveLength(12);
    expect(body.policy.unhinged).toBe(false);
    expect(body.policy.workspaceRoot).toBe(runtime.policy.workspaceRoot);
  });

  it("serves a console page that carries no external references", async () => {
    const response = await authed("/");
    expect(response.headers.get("content-type")).toContain("text/html");
    const page = await response.text();
    expect(page).toContain("MELRA console");
    // A local console that reaches out to a CDN would leak the fact of a run to
    // a third party, and would break on an air-gapped machine.
    expect(page).not.toMatch(/src="https?:/);
    expect(page).not.toMatch(/href="https?:/);
    // Values reach the DOM as text only.
    expect(page).not.toContain("innerHTML");
  });

  it("pins the console's own script and style by hash and refuses framing", async () => {
    const response = await authed("/");
    const page = await response.text();
    const csp = response.headers.get("content-security-policy") ?? "";
    const hash = (body: string | undefined) =>
      `'sha256-${createHash("sha256").update(body ?? "", "utf8").digest("base64")}'`;
    // An edit to the inline script that forgot the header would ship a blank
    // console: the browser refuses any script whose hash is not listed.
    expect(csp).toContain(`script-src ${hash(/<script type="module">([\s\S]*?)<\/script>/.exec(page)?.[1])}`);
    expect(csp).toContain(`style-src ${hash(/<style>([\s\S]*?)<\/style>/.exec(page)?.[1])}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers a missing id with 404 rather than 400", async () => {
    const workflow = await authed(
      "/api/workflows/00000000-0000-4000-8000-000000000000",
    );
    expect(workflow.status).toBe(404);
    const task = await authed(
      "/api/tasks/00000000-0000-4000-8000-000000000000",
    );
    expect(task.status).toBe(404);
  });

  it("rejects a write to the read-only API", async () => {
    const response = await fetch(`${base}/api/workflows`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(405);
  });

  it("drives a real task over the HTTP MCP transport and reads it back", async () => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(
      // The SDK types `sessionId` as `string | undefined`, which
      // `exactOptionalPropertyTypes` rejects against `Transport`'s optional
      // `sessionId?: string`. Same cast as src/http-server.ts.
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer test-token" } },
      }) as unknown as Transport,
    );
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(12);

      const planned = await client.callTool({
        name: "melra_plan",
        arguments: {
          goal: "Read one file over HTTP",
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
      const result = JSON.parse(executedText) as {
        task: { status: string };
      };
      expect(result.task.status).toBe("verified_success");

      // The REST side reads the same durable record the MCP side just wrote.
      const status = await authed(`/api/tasks/${plan.id}`);
      expect(status.status).toBe(200);
      expect(((await status.json()) as { status: string }).status).toBe(
        "verified_success",
      );

      const receipts = await authed(`/api/tasks/${plan.id}/receipts`);
      expect(receipts.status).toBe(200);
      expect(
        ((await receipts.json()) as { receipts: unknown[] }).receipts.length,
      ).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("gives each client its own session over one runtime", async () => {
    const connect = async (name: string) => {
      const client = new Client({ name, version: "0.0.0" });
      await client.connect(
        // Same SDK typing gap as above.
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: "Bearer test-token" } },
        }) as unknown as Transport,
      );
      return client;
    };
    const [one, two] = await Promise.all([connect("one"), connect("two")]);
    try {
      // Separate protocol state: two sessions, two ids.
      const call = async (client: Client) => {
        const planned = await client.callTool({
          name: "melra_plan",
          arguments: {
            goal: "Read one file per session",
            operation: { kind: "file", action: "read", path: "note.txt" },
          },
        });
        return JSON.parse(
          (planned.content as { type: string; text: string }[])[0]!.text,
        ) as { id: string };
      };
      const [first, second] = await Promise.all([call(one), call(two)]);
      expect(first.id).not.toBe(second.id);

      // Shared durable state: either session can read either task, exactly as
      // two stdio servers over one data directory already can.
      for (const id of [first.id, second.id]) {
        const status = await authed(`/api/tasks/${id}`);
        expect(status.status, id).toBe(200);
      }
    } finally {
      await one.close();
      await two.close();
    }
  });

  describe("MCP sessions", () => {
    const post = (url: string, body: unknown, sessionId?: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
        },
        body: JSON.stringify(body),
      });
    const open = async (url: string) => {
      const response = await post(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw", version: "0.0.0" },
        },
      });
      await response.text();
      return response.headers.get("mcp-session-id")!;
    };
    const listTools = async (url: string, sessionId: string) => {
      const response = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId);
      await response.text();
      return response.status;
    };

    it("answers a session it does not have with 404, so the client starts over", async () => {
      const url = `${base}/mcp`;
      const unknown = await post(
        url,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        "00000000-0000-4000-8000-000000000000",
      );
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({ error: { code: -32001 } });

      const ended = await open(url);
      const deleted = await fetch(url, {
        method: "DELETE",
        headers: { authorization: "Bearer test-token", "mcp-session-id": ended },
      });
      expect(deleted.status).toBe(200);
      expect(await listTools(url, ended)).toBe(404);

      // No session named at all is still a malformed request.
      const bare = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(bare.status).toBe(400);
    });

    it("ends the least recently used idle session once 256 are open", async () => {
      // Its own server, so sessions other tests left open do not count.
      const own = await serveHttp({ runtime, port: 0, token: "test-token", environment: {} });
      const url = own.mcpUrl;
      const stream = new AbortController();
      try {
        // Oldest, but holding an event stream open: never ended under it.
        const held = await open(url);
        const listening = await fetch(url, {
          headers: {
            authorization: "Bearer test-token",
            accept: "text/event-stream",
            "mcp-session-id": held,
          },
          signal: stream.signal,
        });
        expect(listening.status).toBe(200);
        const used = await open(url);
        const unused = await open(url);
        // Used after `unused` was opened, so `unused` is now the stalest.
        expect(await listTools(url, used)).toBe(200);
        for (let opened = 3; opened < 256; opened += 1) await open(url);

        await open(url);
        expect(await listTools(url, unused)).toBe(404);
        expect(await listTools(url, used)).toBe(200);
        expect(await listTools(url, held)).toBe(200);
        // Referenced to the end: a response collected as garbage closes its
        // stream, and the held session would go idle under the test.
        expect(listening.bodyUsed).toBe(false);
      } finally {
        stream.abort();
        await own.close();
      }
    }, 60_000);

    it("comes back down to 256 once a burst of busy sessions goes idle", async () => {
      const own = await serveHttp({ runtime, port: 0, token: "test-token", environment: {} });
      const url = own.mcpUrl;
      const streams = new AbortController();
      try {
        // 258 clients each holding an event stream: all busy, so none ended.
        // The responses are kept: one collected as garbage closes its stream.
        const held: string[] = [];
        const listening: Response[] = [];
        for (let count = 0; count < 258; count += 1) {
          const id = await open(url);
          const stream = await fetch(url, {
            headers: { authorization: "Bearer test-token", accept: "text/event-stream", "mcp-session-id": id },
            signal: streams.signal,
          });
          expect(stream.status).toBe(200);
          listening.push(stream);
          held.push(id);
        }
        streams.abort();
        await new Promise((resolve) => setTimeout(resolve, 200));
        // One more, with all 258 idle: back down to the cap, not one at a time.
        await open(url);
        let alive = 0;
        for (const id of held) if ((await listTools(url, id)) === 200) alive += 1;
        expect(alive).toBe(255);
      } finally {
        streams.abort();
        await own.close();
      }
    }, 120_000);
  });

  it("streams workflow events and replays from a cursor", async () => {
    const planned = runtime.workflows.plan({
      schemaVersion: "1.0.0",
      id: "22222222-2222-4222-8222-222222222222",
      version: 1,
      name: "http-stream",
      nodes: [
        {
          id: "read",
          type: "operation",
          request: {
            goal: "Read one file for the stream test",
            operation: { kind: "file", action: "read", path: "note.txt" },
          },
        },
      ],
    } as Parameters<typeof runtime.workflows.plan>[0]);

    await runtime.workflows.advance(planned.id, [], []);

    const events = await authed(`/api/workflows/${planned.id}/events`);
    const body = (await events.json()) as {
      events: { sequence: number; type: string }[];
    };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events[0]!.sequence).toBe(1);

    // `after` is exclusive, so the same call with the last sequence is empty.
    const last = body.events[body.events.length - 1]!.sequence;
    const tail = await authed(
      `/api/workflows/${planned.id}/events?after=${last}`,
    );
    expect(((await tail.json()) as { events: unknown[] }).events).toHaveLength(
      0,
    );

    const stream = await fetch(
      `${base}/api/workflows/${planned.id}/stream?token=test-token`,
    );
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("data: ");
    expect(first).toContain("workflow.");
    await reader.cancel();
  });
});

describe("melra http server in enforced mode", () => {
  it("serves no approval phrase on any task or workflow route", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "melra-http-enf-ws-"));
    const home = mkdtempSync(join(tmpdir(), "melra-http-enf-home-"));
    const runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: home,
      environment: { MELRA_MODE: "enforced" },
    });
    const http = await serveHttp({ runtime, port: 0, token: "t", environment: {} });
    const write = (path: string) =>
      TaskRequestSchema.parse({
        goal: `Write ${path}`,
        operation: { kind: "file", action: "write", path, content: "x" },
        requiredEvidence: [{ type: "file_exists", path }],
      });
    try {
      const task = runtime.controller.plan(write("w.txt"));
      const planned = runtime.workflows.plan(
        WorkflowDefinitionSchema.parse({
          schemaVersion: "1.0.0",
          id: "77777777-7777-4777-8777-777777777777",
          version: 1,
          name: "enforced-http",
          nodes: [{ id: "write", type: "operation", request: write("v.txt") }],
        }),
      );
      await runtime.workflows.advance(planned.id);
      for (const path of [
        `/api/tasks/${task.id}`,
        "/api/tasks",
        "/api/workflows",
        `/api/workflows/${planned.id}`,
        `/api/workflows/${planned.id}/events`,
      ]) {
        const text = await (
          await fetch(`http://${http.host}:${http.port}${path}`, { headers: { authorization: "Bearer t" } })
        ).text();
        expect(text, path).toContain("approvalId");
        expect(text, path).not.toMatch(/"phrase"|APPROVE [a-f0-9]{12}/);
      }
    } finally {
      await http.close();
      await runtime.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
