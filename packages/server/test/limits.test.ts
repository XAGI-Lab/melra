// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Principal } from "@melra/protocol";
import { createMcpServer, createMelraRuntime, serveHttp } from "../src/index.js";
import type { MelraHttpServer } from "../src/http-server.js";
import type { MelraRuntime } from "../src/runtime.js";

type Result = { isError?: boolean; content: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Result>;

const directories: string[] = [];
const runtimes: MelraRuntime[] = [];
const servers: MelraHttpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function open(policy: Record<string, unknown>): Promise<MelraRuntime> {
  const base = mkdtempSync(join(tmpdir(), "melra-limits-"));
  directories.push(base);
  mkdirSync(join(base, "ws"));
  writeFileSync(join(base, "policy.json"), JSON.stringify(policy));
  const runtime = await createMelraRuntime({
    workspaceRoot: join(base, "ws"),
    dataDirectory: join(base, "home"),
    policyPath: join(base, "policy.json"),
    environment: {},
  });
  runtimes.push(runtime);
  return runtime;
}

async function connect(transport: Transport): Promise<Call> {
  const client = new Client({ name: "limits-test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return async (name, args = {}) => (await client.callTool({ name, arguments: args })) as Result;
}

/** A session as stdio serves one: the same server, a transport that authenticates nobody. */
async function session(runtime: MelraRuntime, client?: Principal): Promise<Call> {
  const [left, right] = InMemoryTransport.createLinkedPair();
  await createMcpServer(runtime, client).connect(right);
  return connect(left);
}

const write = (path: string) => ({
  goal: `Write ${path}`,
  operation: { kind: "file", action: "write", path, content: "x" },
  requiredEvidence: [{ type: "file_exists", path }],
});

describe("tools/call rate limit (#422)", () => {
  it("refuses a call past maxCallsPerMinute with when to retry, and takes one once the bucket refills", async () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const runtime = await open({ maxCallsPerMinute: 2 });
    const call = await session(runtime);
    expect((await call("melra_capabilities")).isError).toBeUndefined();
    expect((await call("melra_task_status", { taskId: "00000000-0000-4000-8000-000000000000" })).content[0]!.text).toBe(
      "task_not_found",
    );
    const refused = await call("melra_capabilities");
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toBe(
      "rate_limited: more than 2 tool calls in a minute from this client (maxCallsPerMinute 2); retry in 30000 ms",
    );
    now += 29_999;
    expect((await call("melra_capabilities")).content[0]!.text).toMatch(/^rate_limited: .*; retry in 1 ms$/);
    now += 1;
    expect((await call("melra_capabilities")).isError).toBeUndefined();
  });

  it("counts a call naming an unknown tool, and one failing its input schema", async () => {
    const runtime = await open({ maxCallsPerMinute: 2 });
    const call = await session(runtime);
    expect((await call("no_such_tool")).content[0]!.text).toMatch(/no_such_tool not found/);
    expect((await call("melra_task_status", { taskId: 5 })).content[0]!.text).toMatch(/Input validation error/);
    expect((await call("melra_capabilities")).content[0]!.text).toMatch(/^rate_limited: /);
  });

  it("gives one client one bucket across its sessions, and another client its own", async () => {
    const runtime = await open({ maxCallsPerMinute: 2 });
    const [first, second] = [await session(runtime, { kind: "harness", id: "A" }), await session(runtime, { kind: "harness", id: "A" })];
    const other = await session(runtime, { kind: "harness", id: "B" });
    await first("melra_capabilities");
    await second("melra_capabilities");
    expect((await first("melra_capabilities")).content[0]!.text).toMatch(/^rate_limited: /);
    expect((await second("melra_capabilities")).content[0]!.text).toMatch(/^rate_limited: /);
    expect((await other("melra_capabilities")).isError).toBeUndefined();
  });

  it("holds over loopback HTTP, a new session no fresh allowance", async () => {
    const runtime = await open({ maxCallsPerMinute: 2 });
    const http = await serveHttp({ runtime, port: 0, token: "test-token", environment: {} });
    servers.push(http);
    const fresh = () =>
      connect(
        new StreamableHTTPClientTransport(new URL(http.mcpUrl), {
          requestInit: { headers: { authorization: "Bearer test-token" } },
        }) as unknown as Transport,
      );
    const call = await fresh();
    await call("melra_capabilities");
    await call("melra_capabilities");
    expect((await call("melra_capabilities")).content[0]!.text).toMatch(/^rate_limited: .*; retry in \d+ ms$/);
    expect((await (await fresh())("melra_capabilities")).content[0]!.text).toMatch(/^rate_limited: /);
  });
});

describe("challenges open per caller over MCP (#422)", () => {
  it("publishes the cap and the caller's own count, and refuses the plan past it", async () => {
    const runtime = await open({ maxPendingApprovals: 2 });
    const call = await session(runtime, { kind: "harness", id: "A" });
    const policy = async (send: Call) =>
      (JSON.parse((await send("melra_capabilities")).content[0]!.text) as { policy: Record<string, unknown> }).policy;
    expect(await policy(call)).toMatchObject({ maxPendingApprovals: 2, pendingApprovals: 0, maxCallsPerMinute: 1_200 });
    await call("melra_plan", write("a.txt"));
    await call("melra_plan", write("b.txt"));
    expect(await policy(call)).toMatchObject({ pendingApprovals: 2 });
    const refused = await call("melra_plan", write("c.txt"));
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/^too_many_pending_approvals: 2 tasks .*\(maxPendingApprovals 2\)/);
    // Another client's count is its own.
    const other = await session(runtime, { kind: "harness", id: "B" });
    expect(await policy(other)).toMatchObject({ pendingApprovals: 0 });
    expect(JSON.parse((await other("melra_plan", write("c.txt"))).content[0]!.text)).toMatchObject({ status: "awaiting_approval" });
  });
});
