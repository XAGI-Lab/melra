// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
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
  /**
   * The approval this code came from, by its timestamp: a revoke ends it, and
   * so does a later approval (one in the same millisecond would not, but that
   * is the operator approving the same client twice).
   */
  approvedAt: string;
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

/** The authorization request a submitted consent form came from. */
export function requestOf(form: URLSearchParams): URLSearchParams {
  return new URLSearchParams({
    client_id: form.get("client_id") ?? "",
    redirect_uri: form.get("redirect_uri") ?? "",
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: form.get("code_challenge") ?? "",
    ...(form.get("state") === null ? {} : { state: form.get("state")! }),
  });
}

/** No framing, so nobody can lay the consent page under a decoy and collect the click. */
export const CONSENT_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** Every write renames a new file into place, so the inode changes too. */
function versionOf(stat: Stats): string {
  return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class OAuthProvider {
  private state: OAuthState = { clients: [], tokens: [] };
  private readonly codes = new Map<string, PendingCode>();
  private readonly path: string;
  /** Which version of the file `state` came from. */
  private loaded = "";

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.path = join(dataDirectory, "oauth.json");
    this.reload();
  }

  /**
   * Re-read the file if anything else has written it since. `melra clients
   * --revoke` is another process: a server that kept its startup copy went on
   * honouring revoked tokens, and its next write put them back on disk.
   */
  private reload(): void {
    let version = "missing";
    try {
      version = versionOf(statSync(this.path));
    } catch {
      // No file: the register is empty.
    }
    if (version === this.loaded) return;
    this.loaded = version;
    this.state = { clients: [], tokens: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<OAuthState>;
      this.state = { clients: parsed.clients ?? [], tokens: parsed.tokens ?? [] };
    } catch {
      // No file yet, or one this build cannot read. Either way the honest
      // recovery is an empty register: a client re-runs the flow, and the
      // alternative — guessing at half-parsed grants — hands out authority.
    }
  }

  /**
   * One read-modify-write of the file, held against every other process.
   *
   * Registration needs no credential, so anyone can make the server write at
   * will. Unlocked, a write timed against `melra clients --revoke` put the
   * revoked tokens back. The version is taken from our own file before it is
   * renamed into place, so a write that lands between the two is reloaded
   * next time rather than mistaken for ours.
   */
  private update<T>(change: () => T): T {
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + 2_000;
    for (;;) {
      try {
        closeSync(openSync(lock, "wx", 0o600));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A holder that died leaves its lock behind; none is held this long.
        try {
          if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true });
        } catch {
          // Released while we looked.
        }
        if (Date.now() > deadline) throw new Error("temporarily_unavailable:oauth state is busy");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      this.reload();
      const result = change();
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
      this.loaded = versionOf(statSync(temporary));
      renameSync(temporary, this.path);
      return result;
    } finally {
      rmSync(lock, { force: true });
    }
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
    this.update(() => {
      // Over the ceiling, the oldest client that holds no token makes room. One
      // that does is never evicted by a registration, which anyone can send: a
      // flood used to push approved clients out and kill their tokens. A client
      // whose tokens were revoked holds none, so revoking frees its slot.
      const holding = new Set(this.state.tokens.map((entry) => entry.clientId));
      const clients = [...this.state.clients, client];
      const spare = clients.findIndex((candidate) => !holding.has(candidate.id));
      if (clients.length > MAX_CLIENTS) {
        if (clients[spare] === client) {
          throw new Error(
            "invalid_client_metadata:every client slot holds a live token; revoke one with melra clients --revoke",
          );
        }
        clients.splice(spare, 1);
      }
      this.state.clients = clients;
    });
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
    this.reload();
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

  /**
   * The consent screen. The only place a person is asked, and approving takes
   * the operator's token: anything that can reach this port can submit the
   * form, and only the operator holds that.
   */
  consentPage(query: URLSearchParams, error?: string): string {
    const { client, redirectUri } = this.resolve(query);
    // The redirect URI the check resolved, not the raw query: a client with one
    // registered URI may leave it out, and an absent field reached `decide` as
    // "" and failed both buttons.
    const fields = ["client_id", "redirect_uri", "state", "code_challenge"]
      .map((name) => [name, name === "redirect_uri" ? redirectUri : query.get(name) ?? ""] as const)
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
form { display: grid; gap: 8px; margin-top: 20px; }
form div { display: flex; gap: 10px; margin-top: 8px; }
input[type=password] { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid currentColor;
  background: transparent; color: inherit; }
p.hint { margin: 0; opacity: .7; font-size: 13px; }
p.error { margin: 0; color: #b3261e; font-weight: 600; }
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
<label for="operator-token">Operator token</label>
<input id="operator-token" type="password" name="operator_token" autocomplete="off" required autofocus />
<p class="hint">The token <code>melra serve --http</code> printed when it started, or your
<code>MELRA_HTTP_TOKEN</code>. It is checked here and never sent to the client.</p>
${error === undefined ? "" : `<p class="error" role="alert">${escapeHtml(error)}</p>`}
<div>
<button class="go" type="submit" name="decision" value="approve">Approve ${escapeHtml(client.name)}</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
</div>
</form>
</main>
</body>
</html>
`;
  }

  /**
   * Where the browser goes once the operator has decided. The caller has
   * already checked the operator token on an approval.
   */
  decide(form: URLSearchParams): string {
    const { redirectUri } = this.resolve(requestOf(form));
    const target = new URL(redirectUri);
    const state = form.get("state");
    if (state !== null) target.searchParams.set("state", state);
    if (form.get("decision") !== "approve") {
      target.searchParams.set("error", "access_denied");
      return target.toString();
    }
    const code = randomBytes(32).toString("base64url");
    this.update(() => {
      // Resolved again under the lock: the client object has to be the one in
      // the state that is about to be written.
      const { client, challenge } = this.resolve(requestOf(form));
      const approvedAt = new Date().toISOString();
      this.codes.set(code, {
        clientId: client.id,
        redirectUri,
        challenge,
        expiresAt: Date.now() + CODE_LIFETIME_MS,
        approvedAt,
      });
      client.approvedAt = approvedAt;
    });
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
    this.update(() => {
      // `melra clients --revoke` runs in another process and cannot reach this
      // map, so it clears the approval instead: a code from before a revoke,
      // still within its lifetime, would otherwise mint a live token after it.
      const client = this.state.clients.find((candidate) => candidate.id === pending.clientId);
      if (client?.approvedAt !== pending.approvedAt) throw new Error("invalid_grant");
      this.state.tokens = [
        ...this.state.tokens,
        {
          hash: hash(token),
          clientId: pending.clientId,
          issuedAt: new Date().toISOString(),
        },
      ].slice(-MAX_TOKENS);
    });
    return { access_token: token, token_type: "Bearer", scope: "melra" };
  }

  /** The client behind a bearer token, or `undefined` if it is not one of ours. */
  clientFor(token: string): OAuthClient | undefined {
    this.reload();
    const issued = this.state.tokens.find((entry) => entry.hash === hash(token));
    if (issued === undefined) return undefined;
    return this.state.clients.find(
      (candidate) => candidate.id === issued.clientId,
    );
  }

  /** Approved clients, for the console and `melra inspect`. */
  clients(): OAuthClient[] {
    this.reload();
    return this.state.clients.map((client) => ({ ...client }));
  }

  /** Drops every token for one client, or every token at all. */
  revoke(clientId?: string): number {
    return this.update(() => {
      const before = this.state.tokens.length;
      this.state.tokens = this.state.tokens.filter((entry) =>
        clientId === undefined ? false : entry.clientId !== clientId,
      );
      // It must be approved again, so it is not listed as approved, and no
      // code from the approval it had is honoured.
      for (const client of this.state.clients) {
        if (clientId === undefined || client.id === clientId) delete client.approvedAt;
      }
      return before - this.state.tokens.length;
    });
  }
}
