// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMelraRuntime, serveHttp } from "../src/index.js";
import { OAuthProvider, redirectUriAllowed } from "../src/oauth.js";
import type { MelraHttpServer } from "../src/http-server.js";
import type { MelraRuntime } from "../src/runtime.js";

const REDIRECT = "http://127.0.0.1:33418/callback";

const form = (base: string, body: Record<string, string>) =>
  fetch(base, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual",
  });

/**
 * The OAuth surface exists so a client that was never handed the operator's
 * token can still get in — and so that once it has, the effects it dispatches
 * carry its name. Both halves are tested here against the real server.
 */
describe("melra oauth", () => {
  let workspace: string;
  let home: string;
  let runtime: MelraRuntime;
  let http: MelraHttpServer;
  let base: string;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "melra-oauth-ws-"));
    home = mkdtempSync(join(tmpdir(), "melra-oauth-home-"));
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: home,
    });
    http = await serveHttp({
      runtime,
      port: 0,
      token: "operator-token",
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

  /** Registration through approval to a usable bearer token. */
  const authorize = async (name: string): Promise<string> => {
    const registered = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }),
    });
    expect(registered.status).toBe(201);
    const clientId = ((await registered.json()) as { client_id: string })
      .client_id;

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const approved = await form(`${base}/oauth/authorize`, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      state: "xyz",
      operator_token: "operator-token",
      decision: "approve",
    });
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("location")!);
    expect(location.searchParams.get("state")).toBe("xyz");

    const issued = await form(`${base}/oauth/token`, {
      grant_type: "authorization_code",
      code: location.searchParams.get("code")!,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(issued.status).toBe(200);
    return ((await issued.json()) as { access_token: string }).access_token;
  };

  it("points an unauthenticated client at the authorization server", async () => {
    const refused = await fetch(`${base}/mcp`);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain(
      "oauth-protected-resource",
    );

    const resource = await fetch(
      `${base}/.well-known/oauth-protected-resource/mcp`,
    );
    const metadataUrl = (
      (await resource.json()) as { authorization_servers: string[] }
    ).authorization_servers[0]!;
    // The port the server actually bound, not the one it was asked for: with
    // port 0 those differ, and a client follows what it is told.
    expect(metadataUrl).toBe(base);

    const server = await fetch(
      `${metadataUrl}/.well-known/oauth-authorization-server`,
    );
    const endpoints = (await server.json()) as {
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(endpoints.registration_endpoint).toBe(`${base}/oauth/register`);
    expect(endpoints.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("names the approved client on the receipt for every effect it dispatches", async () => {
    const token = await authorize("Test Harness");
    const client = new Client({ name: "oauth-test", version: "0.0.0" });
    await client.connect(
      // The SDK types `sessionId` as `string | undefined`, which
      // `exactOptionalPropertyTypes` rejects against `Transport`'s optional
      // `sessionId?: string`. Same cast as src/http-server.ts.
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }) as unknown as Transport,
    );
    try {
      const planned = await client.callTool({
        name: "melra_plan",
        arguments: {
          goal: "Read the workspace root as an authenticated client",
          operation: { kind: "file", action: "list", path: "." },
          // A client may still name an inner principal; what it cannot do is
          // erase the one the transport established above it.
          identity: { principal: { kind: "subagent", id: "reader" } },
        },
      });
      const plan = JSON.parse(
        (planned.content as { type: string; text: string }[])[0]!.text,
      ) as { id: string };
      await client.callTool({
        name: "melra_execute",
        arguments: { taskId: plan.id },
      });

      const receipts = runtime.controller.receipts({ taskId: plan.id });
      expect(receipts.receipts.length).toBeGreaterThan(0);
      // Outermost first: the authenticated harness, then what it declared.
      expect(receipts.receipts[0]!.principal).toMatch(
        /^harness:Test Harness#[0-9a-f]{8}\/subagent:reader$/,
      );
    } finally {
      await client.close();
    }
  });

  it("compares the principal a client declares when it judges, and records the client above it", async () => {
    const token = await authorize("Grading Harness");
    const client = new Client({ name: "oauth-judge", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }) as unknown as Transport,
    );
    const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
    try {
      const planned = JSON.parse(
        text(
          await client.callTool({
            name: "melra_plan",
            arguments: {
              goal: "List the workspace and ask whether it looks tidy",
              operation: { kind: "file", action: "list", path: "." },
              requiredEvidence: [{ type: "semantic", question: "Does the workspace look tidy?" }],
              identity: { principal: { kind: "agent", id: "a" } },
            },
          }),
        ),
      ) as { id: string };
      const waiting = JSON.parse(
        text(await client.callTool({ name: "melra_execute", arguments: { taskId: planned.id } })),
      ) as { task: { status: string; judgements: { judgementId: string }[] } };
      expect(waiting.task.status).toBe("waiting_user");
      const judge = (id: string, onBehalfOf: { kind: string; id: string }[] = [], task = planned.id, on = waiting) =>
        client.callTool({
          name: "melra_task_judge",
          arguments: {
            taskId: task,
            judgementId: on.task.judgements[0]!.judgementId,
            verdict: "yes",
            identity: { principal: { kind: "agent", id }, onBehalfOf },
          },
        }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
      // The client's own name heads the judge's chain and is not compared; what it
      // declares is, so the agent that planned cannot grade itself, nor send
      // a grader acting for it.
      for (const self of [await judge("a"), await judge("grader", [{ kind: "agent", id: "a" }])]) {
        expect(self.isError).toBe(true);
        expect(text(self)).toContain("semantic_judge_is_actor");
      }
      // Another session of the same harness may.
      const judged = JSON.parse(text(await judge("grader"))) as {
        task: { status: string; judgements: { judgedBy: { judge: string } }[] };
      };
      expect(judged.task.status).toBe("verified_success");
      expect(judged.task.judgements[0]!.judgedBy.judge).toMatch(/^harness:Grading Harness#[0-9a-f]{8}\/agent:grader$/);
      expect(runtime.controller.receipts({ taskId: planned.id }).receipts[0]!.principal).toMatch(
        /^harness:Grading Harness#[0-9a-f]{8}\/agent:a$/,
      );
      // Planned declaring nothing, the client is the actor, and heads every
      // chain it sends without the judge naming it.
      const bare = JSON.parse(
        text(
          await client.callTool({
            name: "melra_plan",
            arguments: {
              goal: "List the workspace as the client itself",
              operation: { kind: "file", action: "list", path: "." },
              requiredEvidence: [{ type: "semantic", question: "Does the workspace look tidy?" }],
            },
          }),
        ),
      ) as { id: string };
      const bareWaiting = JSON.parse(
        text(await client.callTool({ name: "melra_execute", arguments: { taskId: bare.id } })),
      ) as typeof waiting;
      expect(JSON.parse(text(await judge("grader", [], bare.id, bareWaiting))).task.status).toBe("verified_success");
    } finally {
      await client.close();
    }
  });

  const connect = async (token: string) => {
    const client = new Client({ name: "oauth-owner", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }) as unknown as Transport,
    );
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { refused: result.isError === true, text: result.content[0]!.text };
  };

  it("keeps each client to the tasks and runs it planned, and the read API to the operator", async () => {
    const otherToken = await authorize("Other Harness");
    const [owner, other, operator] = [
      await connect(await authorize("Owner Harness")),
      await connect(otherToken),
      await connect("operator-token"),
    ];
    try {
      const listing = { goal: "List the workspace for its owner", operation: { kind: "file", action: "list", path: "." } };
      const task = JSON.parse((await call(owner, "melra_plan", listing)).text) as { id: string };
      const run = JSON.parse(
        (
          await call(owner, "melra_workflow_plan", {
            definition: {
              schemaVersion: "1.0.0",
              id: "22222222-2222-4222-8222-222222222222",
              version: 1,
              name: "Owned",
              nodes: [{ id: "list", type: "operation", request: listing }],
            },
          })
        ).text,
      ) as { id: string };
      const refusedAll = async (calls: [string, Record<string, unknown>][], error: string) => {
        for (const [name, args] of calls) {
          const answer = await call(other, name, args);
          expect(answer.refused, name).toBe(true);
          expect(answer.text, name).toContain(error);
        }
      };
      const onTask = (taskId: string): [string, Record<string, unknown>][] => [
        ["melra_execute", { taskId }],
        ["melra_task_status", { taskId }],
        ["melra_task_cancel", { taskId }],
        ["melra_receipt", { taskId }],
        [
          "melra_task_judge",
          {
            taskId,
            judgementId: "33333333-3333-4333-8333-333333333333",
            verdict: "yes",
            identity: { principal: { kind: "agent", id: "grader" } },
          },
        ],
      ];
      await refusedAll(onTask(task.id), "task_belongs_to_another_client");
      await refusedAll(
        [
          ["melra_workflow_advance", { workflowId: run.id }],
          ["melra_workflow_status", { workflowId: run.id }],
          ["melra_workflow_cancel", { workflowId: run.id }],
          ["melra_workflow_control", { workflowId: run.id, action: "pause" }],
        ],
        "workflow_belongs_to_another_client",
      );
      // Nothing ran, was cancelled or halted, and no receipt was written.
      expect(runtime.controller.status(task.id).status).toBe("planned");
      expect(runtime.controller.receipts({ taskId: task.id }).receipts).toEqual([]);
      expect(runtime.workflows.status(run.id).status).toBe("planned");

      // The operator's token is refused nothing; the owner, nothing of its own.
      const ran = JSON.parse((await call(operator, "melra_execute", { taskId: task.id })).text) as {
        task: { status: string };
        receipt: { receiptId: string };
      };
      expect(ran.task.status).toBe("verified_success");
      expect((await call(operator, "melra_workflow_status", { workflowId: run.id })).refused).toBe(false);
      const advanced = JSON.parse((await call(owner, "melra_workflow_advance", { workflowId: run.id })).text) as {
        run: { status: string; nodes: { list: { taskIds: string[] } } };
      };
      expect(advanced.run.status).toBe("verified_complete");
      // A run's steps are its planner's, and a receipt is its task's.
      await refusedAll(onTask(advanced.run.nodes.list.taskIds[0]!), "task_belongs_to_another_client");
      await refusedAll([["melra_receipt", { receiptId: ran.receipt.receiptId }]], "task_belongs_to_another_client");
      expect((await call(owner, "melra_receipt", { receiptId: ran.receipt.receiptId })).refused).toBe(false);

      // The read API lists every caller's ids, so only the operator reads it.
      for (const path of ["/", "/api/tasks", `/api/tasks/${task.id}`, "/api/workflows", `/api/workflows/${run.id}`]) {
        const answer = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${otherToken}` } });
        expect(answer.status, path).toBe(403);
      }
      expect((await fetch(`${base}/api/tasks`, { headers: { authorization: "Bearer operator-token" } })).status).toBe(200);
    } finally {
      for (const client of [owner, other, operator]) await client.close();
    }
  });

  it("leaves a task or run that names no planner open to any caller, and the run's later steps too", async () => {
    const [owner, other] = [await connect(await authorize("Earlier Owner")), await connect(await authorize("Earlier Other"))];
    try {
      const listing = { goal: "List the workspace for an earlier release", operation: { kind: "file", action: "list", path: "." } };
      const task = JSON.parse((await call(owner, "melra_plan", listing)).text) as { id: string };
      const run = JSON.parse(
        (
          await call(owner, "melra_workflow_plan", {
            definition: {
              schemaVersion: "1.0.0",
              id: "44444444-4444-4444-8444-444444444444",
              version: 1,
              name: "Earlier",
              nodes: [{ id: "list", type: "operation", request: listing }],
            },
          })
        ).text,
      ) as { id: string };
      // As a release that recorded no callers wrote them.
      runtime.store.database.prepare("UPDATE tasks SET data = json_remove(data, '$.client') WHERE id = ?").run(task.id);
      runtime.store.database.exec("DROP TRIGGER workflow_events_no_update");
      runtime.store.database
        .prepare("UPDATE workflow_events SET data = json_remove(data, '$.data.client') WHERE aggregate_id = ? AND sequence = 1")
        .run(run.id);

      expect((await call(other, "melra_task_status", { taskId: task.id })).refused).toBe(false);
      expect((await call(other, "melra_workflow_status", { workflowId: run.id })).refused).toBe(false);
      const advanced = JSON.parse((await call(owner, "melra_workflow_advance", { workflowId: run.id })).text) as {
        run: { nodes: { list: { taskIds: string[] } } };
      };
      // A step planned now names no one either, rather than the operator.
      const step = advanced.run.nodes.list.taskIds[0]!;
      for (const client of [owner, other]) {
        expect((await call(client, "melra_task_status", { taskId: step })).refused).toBe(false);
      }
    } finally {
      for (const client of [owner, other]) await client.close();
    }
  });

  it("refuses a code that fails PKCE, and never lets one be spent twice", async () => {
    const registered = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Replay", redirect_uris: [REDIRECT] }),
    });
    const clientId = ((await registered.json()) as { client_id: string })
      .client_id;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redeem = async (code: string, withVerifier: string) =>
      form(`${base}/oauth/token`, {
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: withVerifier,
      });
    const code = async () => {
      const approved = await form(`${base}/oauth/authorize`, {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        operator_token: "operator-token",
        decision: "approve",
      });
      return new URL(approved.headers.get("location")!).searchParams.get(
        "code",
      )!;
    };

    const wrong = await redeem(await code(), randomBytes(32).toString("base64url"));
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );

    // A code burned on a failed attempt stays burned, so a stolen code cannot
    // be brute-forced against the verifier.
    const stolen = await code();
    expect((await redeem(stolen, randomBytes(32).toString("base64url"))).status).toBe(400);
    expect((await redeem(stolen, verifier)).status).toBe(400);

    const clean = await redeem(await code(), verifier);
    expect(clean.status).toBe(200);
  });

  it("takes the operator's token to approve, so a local process cannot approve itself", async () => {
    const registered = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Self-approver", redirect_uris: [REDIRECT] }),
    });
    const clientId = ((await registered.json()) as { client_id: string }).client_id;
    const request = {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: createHash("sha256").update("v").digest("base64url"),
      decision: "approve",
    };
    // What any process that can reach the port used to do: POST its own approval.
    for (const attempt of [request, { ...request, operator_token: "guess" }]) {
      const refused = await form(`${base}/oauth/authorize`, attempt);
      expect(refused.status).toBe(403);
      expect(refused.headers.get("location")).toBe(null);
      expect(await refused.text()).toContain("not this server&#39;s token");
    }
    // Pasted with a stray space, as tokens often are.
    const approved = await form(`${base}/oauth/authorize`, {
      ...request,
      operator_token: " operator-token ",
    });
    expect(new URL(approved.headers.get("location")!).searchParams.get("code")).not.toBe(null);
  });

  it("serves the consent page so it cannot be framed under a decoy", async () => {
    const registered = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Framed", redirect_uris: [REDIRECT] }),
    });
    const clientId = ((await registered.json()) as { client_id: string }).client_id;
    const page = await fetch(
      `${base}/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&code_challenge_method=S256&code_challenge=${"x".repeat(43)}`,
    );
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('name="operator_token"');
  });

  it("turns a denial into a redirect that carries no code", async () => {
    const registered = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Denied", redirect_uris: [REDIRECT] }),
    });
    const clientId = ((await registered.json()) as { client_id: string })
      .client_id;
    const denied = await form(`${base}/oauth/authorize`, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: createHash("sha256").update("v").digest("base64url"),
      decision: "deny",
    });
    const location = new URL(denied.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBe(null);
  });

  it("shows the operator who is asking before it asks them to approve", async () => {
    const registered = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // A name is a claim, so it reaches a person's screen and must not be
      // able to carry markup there.
      body: JSON.stringify({
        client_name: "<img src=x onerror=alert(1)>",
        redirect_uris: [REDIRECT],
      }),
    });
    const clientId = ((await registered.json()) as { client_id: string })
      .client_id;
    const page = await fetch(
      `${base}/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&code_challenge_method=S256&code_challenge=${createHash("sha256")
          .update("verifier")
          .digest("base64url")}`,
    );
    const body = await page.text();
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;img src=x");
    expect(body).toContain(REDIRECT);
  });

  it("refuses a registration whose code could leave the machine", async () => {
    for (const uri of [
      "https://evil.example.com/callback",
      "javascript:alert(1)",
      "not a url",
    ]) {
      const response = await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Bad", redirect_uris: [uri] }),
      });
      expect(response.status, uri).toBe(400);
    }
  });

  it("refuses a registration a web page could send, and leaves the client list alone", async () => {
    const register = (headers: Record<string, string>) =>
      fetch(`${base}/oauth/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({ client_name: "From a page", redirect_uris: [REDIRECT] }),
      });
    const clients = () =>
      (JSON.parse(readFileSync(join(home, "oauth.json"), "utf8")) as { clients: unknown[] }).clients.length;
    // What an MCP client registering from its own process sends.
    expect((await register({ "content-type": "application/json" })).status).toBe(201);
    const before = clients();
    // A page's POST without a preflight: text, with the page's own Origin.
    for (const origin of ["https://evil.example", "null", base]) {
      for (const type of ["text/plain;charset=UTF-8", "application/json"]) {
        const refused = await register({ "content-type": type, origin });
        expect(refused.status, `${origin} ${type}`).toBe(403);
        expect(await refused.json()).toMatchObject({ error: "origin_not_allowed" });
      }
    }
    const text = await register({ "content-type": "text/plain" });
    expect(text.status).toBe(415);
    expect(await text.json()).toMatchObject({ error: "json_required" });
    expect(clients()).toBe(before);
  });

  it("keeps issued tokens in a file only the operator can read", () => {
    const mode = statSync(join(home, "oauth.json")).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("still answers the operator's own token, and refuses an unissued one", async () => {
    const operator = await fetch(`${base}/api/capabilities`, {
      headers: { authorization: "Bearer operator-token" },
    });
    expect(operator.status).toBe(200);
    const forged = await fetch(`${base}/api/capabilities`, {
      headers: { authorization: `Bearer ${randomBytes(32).toString("base64url")}` },
    });
    expect(forged.status).toBe(401);
  });
});

describe("redirectUriAllowed", () => {
  it("takes loopback and private schemes, and nothing that leaves the host", () => {
    for (const uri of [
      "http://127.0.0.1:1455/cb",
      "http://localhost/cb",
      "http://[::1]:9/cb",
      "cursor://anysphere.cursor-retrieval/oauth/callback",
    ]) {
      expect(redirectUriAllowed(uri), uri).toBe(true);
    }
    for (const uri of [
      "http://example.com/cb",
      "https://example.com/cb",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "",
    ]) {
      expect(redirectUriAllowed(uri), uri).toBe(false);
    }
  });
});

describe("OAuthProvider", () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "melra-oauth-provider-"));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  /** Register, approve and redeem, straight through the provider. */
  const issue = (provider: OAuthProvider, name: string): { id: string; token: string } => {
    const id = provider.register({ client_name: name, redirect_uris: [REDIRECT] })
      .client_id as string;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const target = new URL(
      provider.decide(
        new URLSearchParams({ client_id: id, redirect_uri: REDIRECT, code_challenge: challenge, decision: "approve" }),
      ),
    );
    const { access_token } = provider.token(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: target.searchParams.get("code")!,
        client_id: id,
        code_verifier: verifier,
      }),
    ) as { access_token: string };
    return { id, token: access_token };
  };

  it("stops honouring a token another process revoked, and never writes it back", () => {
    const server = new OAuthProvider(join(home, "revoke"));
    const { token } = issue(server, "agent");
    expect(server.clientFor(token)).toBeDefined();

    // `melra clients --revoke all` runs in its own process with its own copy.
    expect(new OAuthProvider(join(home, "revoke")).revoke()).toBe(1);
    expect(server.clientFor(token)).toBeUndefined();

    // The server's next write used to put its stale copy, token included, back.
    server.register({ client_name: "later", redirect_uris: [REDIRECT] });
    expect(new OAuthProvider(join(home, "revoke")).clientFor(token)).toBeUndefined();
  });

  it("lists a revoked client as needing approval again", () => {
    const directory = join(home, "relist");
    const { id } = issue(new OAuthProvider(directory), "agent");
    new OAuthProvider(directory).revoke(id);
    // Its tokens were gone, and it still read `approved`.
    expect(new OAuthProvider(directory).clients().find((client) => client.id === id)?.approvedAt).toBeUndefined();
  });

  it("does not redeem a code issued before another process revoked the client", () => {
    const directory = join(home, "late-code");
    const server = new OAuthProvider(directory);
    const id = server.register({ client_name: "agent", redirect_uris: [REDIRECT] }).client_id as string;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const code = new URL(
      server.decide(
        new URLSearchParams({ client_id: id, redirect_uri: REDIRECT, code_challenge: challenge, decision: "approve" }),
      ),
    ).searchParams.get("code")!;
    // `melra clients --revoke` cannot reach the server's codes, which live for minutes.
    new OAuthProvider(directory).revoke(id);
    expect(() =>
      server.token(
        new URLSearchParams({ grant_type: "authorization_code", code, client_id: id, code_verifier: verifier }),
      ),
    ).toThrow("invalid_grant");
    expect(new OAuthProvider(directory).clients().find((client) => client.id === id)?.approvedAt).toBeUndefined();
  });

  it("never lets a registration flood evict an approved client", () => {
    const provider = new OAuthProvider(join(home, "flood"));
    const { token } = issue(provider, "approved");
    for (let index = 0; index < 150; index += 1) {
      provider.register({ client_name: `flood ${index}`, redirect_uris: [REDIRECT] });
    }
    expect(provider.clientFor(token)?.name).toBe("approved");
  });

  it("frees a slot when a client's tokens are revoked, and only then", () => {
    const provider = new OAuthProvider(join(home, "slots"));
    const issued = Array.from({ length: 100 }, (_, index) => issue(provider, `client ${index}`));
    expect(() => provider.register({ client_name: "one more", redirect_uris: [REDIRECT] })).toThrow(
      /every client slot holds a live token/,
    );
    provider.revoke(issued[5]!.id);
    provider.register({ client_name: "one more", redirect_uris: [REDIRECT] });
    expect(provider.clientFor(issued[6]!.token)).toBeDefined();
  });

  it("clears a lock a dead process left behind", () => {
    const directory = join(home, "stale-lock");
    const provider = new OAuthProvider(directory);
    const lock = join(directory, "oauth.json.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(issue(provider, "after a crash").token).not.toBe("");
  });

  it("approves a client whose authorization request left out its one redirect URI", () => {
    const provider = new OAuthProvider(join(home, "implicit-redirect"));
    const id = provider.register({ client_name: "one-uri", redirect_uris: [REDIRECT] })
      .client_id as string;
    const query = new URLSearchParams({
      client_id: id,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: "x".repeat(43),
    });
    // What the browser submits: every hidden field on the page, plus the button.
    const page = provider.consentPage(query);
    const submitted = new URLSearchParams({ decision: "approve" });
    for (const [, name, value] of page.matchAll(/name="([^"]+)" value="([^"]*)"/g)) {
      submitted.set(name!, value!.replaceAll("&amp;", "&"));
    }
    expect(new URL(provider.decide(submitted)).origin + new URL(REDIRECT).pathname).toBe(REDIRECT);
  });
});
