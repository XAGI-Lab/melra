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
import { createMelraRuntime, serveHttp } from "../src/index.js";
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

  it("answers only its own loopback names, so a rebound page gets nothing", async () => {
    // What a page at attacker.example sends once its name resolves to 127.0.0.1.
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const call = httpRequest(
          { host: http.host, port: http.port, path: "/.well-known/oauth-authorization-server", headers: { host } },
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
    expect(body.tools).toHaveLength(11);
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
      expect(tools.tools).toHaveLength(11);

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
