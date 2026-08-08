// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMelraRuntime, serveHttp } from "../src/index.js";
import { redirectUriAllowed } from "../src/oauth.js";
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
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
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
