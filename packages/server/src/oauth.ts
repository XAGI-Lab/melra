// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Principal } from "@melra/protocol";

/**
 * OAuth 2.1 for a client that cannot be handed the startup token by hand.
 *
 * The shared token stays the operator's own key. This is the door for an MCP
 * client that discovers the server, registers itself, and then asks a person
 * to approve it — after which every effect it dispatches carries its name
 * rather than the one anonymous `agent:local`.
 *
 * ponytail: authorization-code + PKCE only, hand-rolled on `node:http`. No
 * refresh tokens, no scopes beyond one, no client secrets — a public client on
 * loopback needs none of them, and the SDK's own router would pull Express
 * into a package whose whole appeal is installing in one step. Add refresh
 * when a token needs to expire.
 */

/** One registered client. Self-asserted until a person approves it. */
export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  registeredAt: string;
  /** Set the moment an operator approves; unapproved clients hold no token. */
  approvedAt?: string;
}

interface StoredToken {
  /** sha256 of the token. The token itself is shown once and never stored. */
  hash: string;
  clientId: string;
  issuedAt: string;
}

interface OAuthState {
  clients: OAuthClient[];
  tokens: StoredToken[];
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
}

/** A registration flood is unauthenticated by design, so it needs a ceiling. */
const MAX_CLIENTS = 100;
const MAX_TOKENS = 200;
const CODE_LIFETIME_MS = 300_000;

const BLOCKED_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "blob:",
  "vbscript:",
]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Where an authorization code may be delivered.
 *
 * Loopback only for http(s), because a code sent anywhere else leaves the
 * machine the operator was approving something on. A private scheme is allowed
 * — a desktop client registers one and the OS decides who owns it, which is
 * the same trust the operator gave by installing it.
 */
export function redirectUriAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (BLOCKED_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === "http:" || url.protocol === "https:") {
    return LOOPBACK.has(url.hostname.replace(/^\[|\]$/g, ""));
  }
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

/** RFC 7636 S256. Plain is not accepted, so this is the only comparison. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The principal an approved client acts as.
 *
 * A client names itself at registration, so the name is a claim and cannot be
 * the whole identity: the client id — which the server minted — is appended so
 * two clients calling themselves the same thing stay distinguishable in a
 * receipt.
 */
export function clientPrincipal(client: OAuthClient): Principal {
  const named = client.name.replace(/[^A-Za-z0-9 ._-]/g, "").trim().slice(0, 60);
  return {
    kind: "harness",
    id: `${named === "" ? "client" : named}#${client.id.slice(0, 8)}`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class OAuthProvider {
  private state: OAuthState = { clients: [], tokens: [] };
  private readonly codes = new Map<string, PendingCode>();
  private readonly path: string;

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.path = join(dataDirectory, "oauth.json");
    try {
      this.state = JSON.parse(readFileSync(this.path, "utf8")) as OAuthState;
      this.state.clients ??= [];
      this.state.tokens ??= [];
    } catch {
      // No file yet, or one this build cannot read. Either way the honest
      // recovery is an empty register: a client re-runs the flow, and the
      // alternative — guessing at half-parsed grants — hands out authority.
    }
  }

  private persist(): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  /** RFC 8414 authorization server metadata. */
  metadata(origin: string): Record<string, unknown> {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["melra"],
    };
  }

  /** RFC 9728 protected resource metadata, which is what MCP clients read. */
  resourceMetadata(origin: string): Record<string, unknown> {
    return {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ["melra"],
      bearer_methods_supported: ["header"],
    };
  }

  /** RFC 7591 dynamic client registration. Grants nothing on its own. */
  register(body: Record<string, unknown>): Record<string, unknown> {
    const uris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    if (uris.length === 0) throw new Error("invalid_redirect_uri");
    if (!uris.every(redirectUriAllowed)) throw new Error("invalid_redirect_uri");
    const name =
      typeof body.client_name === "string" && body.client_name.trim() !== ""
        ? body.client_name.trim().slice(0, 200)
        : "unnamed client";
    const client: OAuthClient = {
      id: randomBytes(16).toString("hex"),
      name,
      redirectUris: uris.slice(0, 10),
      registeredAt: new Date().toISOString(),
    };
    this.state.clients = [...this.state.clients, client].slice(-MAX_CLIENTS);
    this.persist();
    return {
      client_id: client.id,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(Date.parse(client.registeredAt) / 1000),
    };
  }

  private resolve(
    query: URLSearchParams,
  ): { client: OAuthClient; redirectUri: string; challenge: string } {
    const client = this.state.clients.find(
      (candidate) => candidate.id === query.get("client_id"),
    );
    if (client === undefined) throw new Error("invalid_client");
    // Exact match against what was registered. A prefix match here is the
    // classic way an authorization code ends up at someone else's endpoint.
    const redirectUri = query.get("redirect_uri") ?? client.redirectUris[0]!;
    if (!client.redirectUris.includes(redirectUri)) {
      throw new Error("invalid_redirect_uri");
    }
    if (query.get("response_type") !== "code") {
      throw new Error("unsupported_response_type");
    }
    if (query.get("code_challenge_method") !== "S256") {
      throw new Error("invalid_request:pkce_s256_required");
    }
    const challenge = query.get("code_challenge") ?? "";
    if (challenge.length < 43) throw new Error("invalid_request:pkce_required");
    return { client, redirectUri, challenge };
  }

  /** The consent screen. The only place a person is asked. */
  consentPage(query: URLSearchParams): string {
    const { client, redirectUri } = this.resolve(query);
    const fields = ["client_id", "redirect_uri", "state", "code_challenge"]
      .map((name) => [name, query.get(name) ?? ""] as const)
      .filter(([, value]) => value !== "")
      .map(
        ([name, value]) =>
          `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`,
      )
      .join("");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>Approve a client — MELRA</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif; padding: 24px; }
main { max-width: 34rem; }
h1 { font-size: 18px; margin: 0 0 12px; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 16px 0; }
dt { opacity: .6; } dd { margin: 0; word-break: break-all; font-family: ui-monospace, monospace; font-size: 13px; }
p.warn { padding: 10px 12px; border-radius: 6px; background: #b3261e; color: #fff; }
button { font: inherit; padding: 8px 18px; border-radius: 6px; border: 1px solid currentColor;
  background: transparent; color: inherit; cursor: pointer; }
button.go { background: #b3261e; color: #fff; border-color: #b3261e; }
form { display: flex; gap: 10px; margin-top: 20px; }
</style>
</head>
<body>
<main>
<h1>A client is asking to use MELRA on this machine</h1>
<dl>
<dt>Client</dt><dd>${escapeHtml(client.name)}</dd>
<dt>Client&nbsp;id</dt><dd>${escapeHtml(client.id)}</dd>
<dt>Redirect</dt><dd>${escapeHtml(redirectUri)}</dd>
<dt>Registered</dt><dd>${escapeHtml(client.registeredAt)}</dd>
</dl>
<p class="warn">Approving lets this client run every effect your policy allows
— reading and writing files, running commands, driving a browser and the
desktop. Policy, approvals and receipts still apply. Only approve a client you
started yourself, and check the name above matches it.</p>
<form method="post" action="/oauth/authorize">${fields}
<button class="go" type="submit" name="decision" value="approve">Approve ${escapeHtml(client.name)}</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</main>
</body>
</html>
`;
  }

  /** Where the browser goes once the operator has decided. */
  decide(form: URLSearchParams): string {
    const { client, redirectUri, challenge } = this.resolve(
      new URLSearchParams({
        client_id: form.get("client_id") ?? "",
        redirect_uri: form.get("redirect_uri") ?? "",
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: form.get("code_challenge") ?? "",
      }),
    );
    const target = new URL(redirectUri);
    const state = form.get("state");
    if (state !== null) target.searchParams.set("state", state);
    if (form.get("decision") !== "approve") {
      target.searchParams.set("error", "access_denied");
      return target.toString();
    }
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      clientId: client.id,
      redirectUri,
      challenge,
      expiresAt: Date.now() + CODE_LIFETIME_MS,
    });
    client.approvedAt = new Date().toISOString();
    this.persist();
    target.searchParams.set("code", code);
    return target.toString();
  }

  /** Redeems a code for a token. Single use, PKCE-bound, redirect-bound. */
  token(form: URLSearchParams): Record<string, unknown> {
    if (form.get("grant_type") !== "authorization_code") {
      throw new Error("unsupported_grant_type");
    }
    const code = form.get("code") ?? "";
    const pending = this.codes.get(code);
    // Consumed whatever happens next: a code that survived a failed redemption
    // is a code an attacker gets to keep guessing the verifier against.
    this.codes.delete(code);
    if (pending === undefined || pending.expiresAt < Date.now()) {
      throw new Error("invalid_grant");
    }
    if (
      pending.clientId !== form.get("client_id") ||
      pending.redirectUri !== (form.get("redirect_uri") ?? pending.redirectUri)
    ) {
      throw new Error("invalid_grant");
    }
    if (!pkceMatches(form.get("code_verifier") ?? "", pending.challenge)) {
      throw new Error("invalid_grant");
    }
    const token = randomBytes(32).toString("base64url");
    this.state.tokens = [
      ...this.state.tokens,
      {
        hash: hash(token),
        clientId: pending.clientId,
        issuedAt: new Date().toISOString(),
      },
    ].slice(-MAX_TOKENS);
    this.persist();
    return { access_token: token, token_type: "Bearer", scope: "melra" };
  }

  /** The client behind a bearer token, or `undefined` if it is not one of ours. */
  clientFor(token: string): OAuthClient | undefined {
    const issued = this.state.tokens.find((entry) => entry.hash === hash(token));
    if (issued === undefined) return undefined;
    return this.state.clients.find(
      (candidate) => candidate.id === issued.clientId,
    );
  }

  /** Approved clients, for the console and `melra inspect`. */
  clients(): OAuthClient[] {
    return this.state.clients.map((client) => ({ ...client }));
  }

  /** Drops every token for one client, or every token at all. */
  revoke(clientId?: string): number {
    const before = this.state.tokens.length;
    this.state.tokens = this.state.tokens.filter((entry) =>
      clientId === undefined ? false : entry.clientId !== clientId,
    );
    this.persist();
    return before - this.state.tokens.length;
  }
}
