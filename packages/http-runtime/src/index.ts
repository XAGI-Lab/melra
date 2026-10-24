// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { HttpOperation } from "@melra/protocol";
import { outcomeUnknown } from "@melra/protocol";
import {
  assertSafeDestination,
  classifyOperation,
  type BrokeredHeaders,
  type CredentialBroker,
  type NetworkPolicy,
} from "@melra/policy-core";

const REDACTED_CREDENTIAL = "[REDACTED_CREDENTIAL]";

/**
 * Below this many characters a secret is masked only as itself: the hex or
 * base64 of a few bytes is short enough to turn up in an ordinary body.
 */
const MIN_ENCODED_SECRET_LENGTH = 8;

/**
 * `secret` and, from `MIN_ENCODED_SECRET_LENGTH` up, the fixed encodings a far
 * end may echo it in: base64 (padding dropped, so either way matches),
 * base64url, hex in either case, percent-encoded, and the base64 of an HTTP
 * Basic pair with it as the user or the password and the other half empty.
 * Inside a longer base64 string, such as the encoding of the header value it
 * went out in, its bytes can start a third or two thirds of the way into a
 * group, so for both alphabets it also yields the characters the secret alone
 * decides at each of the three offsets; at most the one at either edge, which
 * it shares with its neighbours, stays.
 */
function forms(secret: string): string[] {
  if (secret.length < MIN_ENCODED_SECRET_LENGTH) return [secret];
  const base64 = (text: string): string => Buffer.from(text).toString("base64").replace(/=+$/, "");
  const hex = Buffer.from(secret).toString("hex");
  // Character i holds bits 6i to 6i + 5, so with k bytes before it the secret
  // alone decides characters ceil(4k / 3) up to floor(4(k + length) / 3).
  const cores = (encoding: "base64" | "base64url"): string[] =>
    [0, 1, 2].map((k) =>
      Buffer.from("\0".repeat(k) + secret)
        .toString(encoding)
        .slice(Math.ceil((4 * k) / 3), Math.floor((4 * (k + secret.length)) / 3)),
    );
  return [
    secret,
    base64(secret),
    Buffer.from(secret).toString("base64url"),
    ...cores("base64"),
    ...cores("base64url"),
    hex,
    hex.toUpperCase(),
    ...percentForms(secret),
    base64(`${secret}:`),
    base64(`:${secret}`),
    ...basicPair(secret),
  ];
}

/**
 * The spellings common URL encoders give `secret`: encodeURIComponent's, one
 * that also escapes `!'()*` (RFC 3986, Go's and PHP's), and one that leaves `/`
 * as it is (Python's `quote`), each with upper- and lower-case escapes.
 */
function percentForms(secret: string): string[] {
  const spell = (safe: RegExp, lower: boolean): string =>
    [...Buffer.from(secret)]
      .map((byte) => {
        const char = String.fromCharCode(byte);
        if (byte < 0x80 && safe.test(char)) return char;
        const escape = byte.toString(16).padStart(2, "0");
        return `%${lower ? escape : escape.toUpperCase()}`;
      })
      .join("");
  const sets = [/[A-Za-z0-9_.~-]/, /[A-Za-z0-9_.~!'()*-]/, /[A-Za-z0-9_.~/-]/];
  return [...new Set(sets.flatMap((safe) => [spell(safe, false), spell(safe, true)]))];
}

/**
 * When `secret` is the base64 of a printable `user:password` pair, as one sent
 * under the `Basic` scheme is configured, the pair and each half as long as
 * `MIN_ENCODED_SECRET_LENGTH`: a far end may echo what it decoded.
 */
function basicPair(secret: string): string[] {
  const pair = Buffer.from(secret, "base64").toString("latin1");
  const colon = pair.indexOf(":");
  if (colon < 0 || !/^[ -~]+$/.test(pair) || Buffer.from(pair, "latin1").toString("base64") !== secret) return [];
  return [pair, pair.slice(0, colon), pair.slice(colon + 1)].filter(
    (part) => part.length >= MIN_ENCODED_SECRET_LENGTH,
  );
}

/**
 * `text` with every brokered value the far end echoed replaced, as sent or in
 * one of its `forms`. A credential echoed otherwise transformed (masked, split,
 * encoded some other way) is not caught.
 */
function scrubbed(text: string, { headers, secrets }: BrokeredHeaders, cut: boolean): string {
  let out = text;
  const masked = secrets.flatMap(forms);
  // Longest first, so a whole header value goes as one marker.
  for (const value of [...new Set([...Object.values(headers), ...masked])].sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(value, REDACTED_CREDENTIAL);
  }
  if (!cut || secrets.length === 0) return out;
  // A body cut at the size cap can end partway through a secret, so its end
  // goes whatever it holds. Deciding by whether it looks like the start of one
  // would tell the caller something about the secret. The whole length of the
  // longest form; the broker passes only printable ASCII, so a character is a
  // byte.
  const tail = Math.max(...masked.map((form) => form.length));
  return `${out.slice(0, Math.max(0, out.length - tail))}${REDACTED_CREDENTIAL}`;
}

export interface HttpRuntimeOptions extends NetworkPolicy {
  /**
   * Supplies the secrets this adapter is allowed to send. Omitted means every
   * request goes out with exactly the headers the caller wrote.
   */
  credentials?: CredentialBroker;
}

function abortReason(signal?: AbortSignal): string {
  const reason = signal?.reason;
  return reason instanceof Error && reason.name !== "AbortError"
    ? reason.message
    : typeof reason === "string"
      ? reason
      : "task_cancelled";
}

/**
 * One governed HTTP call.
 *
 * The interesting part is which socket opens. `assertSafeDestination` resolves
 * the name and checks every answer, then this connects through a `lookup` that
 * answers only with those checked addresses, never by resolving the name again
 * — the same pinning `PinningProxy` does for the browser, and for the same
 * reason: a resolver that answers public once and private the second time
 * would otherwise make the check meaningless. TLS still verifies the name.
 */
export class HttpRuntime {
  constructor(private readonly options: HttpRuntimeOptions) {}

  async execute(
    operation: HttpOperation,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const { url, host, lookup } = await assertSafeDestination(
      operation.url,
      this.options,
    );
    // Checked here and not only in the router: the destination check above is
    // an await, and a cancel that lands inside that window would otherwise be
    // lost and the request would go out anyway.
    const cancelled = (): boolean => signal?.aborted === true;
    if (cancelled()) throw new Error(abortReason(signal));
    const secure = url.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;
    // Brokered against the host that was *checked*: the name, or an IPv6
    // literal without the brackets `URL.hostname` keeps, so `[::1]` and a
    // credential scoped to `::1` are the same host.
    const { capability, target } = classifyOperation(operation);
    const brokered = await this.options.credentials?.headersFor({
      host,
      capability,
      target,
    });
    // Again: reading a credential from a file is an await too, and the abort
    // listener below only hears an abort that comes after it is added.
    if (cancelled()) throw new Error(abortReason(signal));

    const headers: Record<string, string> = {
      // Lowercased before the merge, or `Authorization: guess` from the caller
      // and `authorization: <secret>` from the broker are two distinct keys and
      // both go on the wire — which server wins is then the server's choice.
      ...Object.fromEntries(
        Object.entries(operation.headers ?? {}).map(([name, value]) => [
          name.toLowerCase(),
          value,
        ]),
      ),
      // Last, so a caller cannot name the same header and have its own value
      // ride out under a credential's name.
      ...brokered?.headers,
      // The URL's authority exactly as the caller wrote it.
      host: url.host,
      ...(operation.idempotencyKey === undefined
        ? {}
        : { "idempotency-key": operation.idempotencyKey }),
    };
    if (operation.content !== undefined) {
      headers["content-length"] = String(Buffer.byteLength(operation.content));
    }

    let deadline: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    // Whether a response arrived: from then on its own events settle the call.
    let answered = false;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const call = send(
        {
          host,
          lookup,
          port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
          method: operation.method,
          path: `${url.pathname}${url.search}`,
          headers,
          // A fresh connection per effect, never one from Node's keep-alive
          // pool. A pooled socket the server has already closed takes the whole
          // request and then resets, and below that reads as "the far end may
          // have acted" — a request that never reached anyone parked for
          // reconciliation. On a connection of its own, a reset after the write
          // really is an unknown outcome.
          agent: false,
        },
        (response: IncomingMessage) => {
          answered = true;
          const chunks: Buffer[] = [];
          let bytes = 0;
          let truncated = false;
          response.on("data", (chunk: Buffer) => {
            const room = operation.maxResponseBytes - bytes;
            if (chunk.length > room) {
              // Stop reading rather than buffering an unbounded body into the
              // host's heap. What arrived is still reported, flagged, up to the
              // cap: the chunk that crosses it is cut there, not dropped, or a
              // body that arrives in one read came back empty.
              chunks.push(chunk.subarray(0, room));
              bytes += room;
              truncated = true;
              response.destroy();
              return;
            }
            bytes += chunk.length;
            chunks.push(chunk);
          });
          const finish = (): void => {
            // The headers arrived, so the request did too: a body cut off
            // before its end is an answer that stopped, not a call that never
            // happened, and only `outcomeUnknown` says so. Stopping at the
            // size cap is the one deliberate exception.
            if (!response.complete && !truncated) {
              reject(outcomeUnknown("http_response_incomplete"));
              return;
            }
            const status = response.statusCode ?? 0;
            // A provider can echo the credential it was sent, in an error, a
            // debug header or the reason phrase. The caller, the verifier and
            // every stored copy get what follows, so it goes here, once.
            let redacted = false;
            const scrub = (text: string, cut = false): string => {
              if (brokered === undefined) return text;
              const out = scrubbed(text, brokered, cut);
              // A cut body always counts, whatever its end held.
              if (out !== text || (cut && brokered.secrets.length > 0)) redacted = true;
              return out;
            };
            const statusText = scrub(response.statusMessage ?? "");
            const headers = Object.fromEntries(
              Object.entries(response.headers).map(([name, value]) => [
                name,
                Array.isArray(value) ? value.map((item) => scrub(item)) : typeof value === "string" ? scrub(value) : value,
              ]),
            );
            const content = scrub(Buffer.concat(chunks).toString("utf8"), truncated);
            resolve({
              // The far end's own word, which is all HTTP can offer. A caller
              // who needs more declares an independent re-read as evidence.
              //
              // 3xx is not success: redirects are deliberately not followed —
              // the destination check ran against the URL the caller named, and
              // a `Location` pointing at 169.254.169.254 would walk straight
              // past it. The caller gets the status and the header and can plan
              // a second governed request to wherever it points.
              success: status >= 200 && status < 300,
              status,
              statusText,
              headers,
              content,
              // As received, so it can still be checked against the cap.
              bytes,
              truncated,
              url: url.toString(),
              method: operation.method,
              // Names only. Which credential authorised the call is something a
              // receipt should record; its value is the one thing that must not
              // leave this function.
              credentials: brokered?.used ?? [],
              ...(redacted ? { redactions: [REDACTED_CREDENTIAL] } : {}),
              // Echoed back so a reconciliation predicate can be written
              // against the one fact that was true *before* the call. After a
              // request that went unanswered there is no response to read, so
              // this is the only handle on what the provider was asked to do.
              ...(operation.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: operation.idempotencyKey }),
            });
          };
          response.on("end", finish);
          response.on("close", finish);
          response.on("error", (error) => reject(outcomeUnknown(error.message)));
        },
      );
      // Whether the request made it out. A socket error before this is a
      // request that never happened; after it, the far end may have done the
      // work and lost the reply, and only `outcomeUnknown` says so honestly.
      // `bytesWritten` is not the signal — it counts headers buffered on a
      // socket that never connected, so ECONNREFUSED reports a nonzero count.
      const failed = (error: Error): void => {
        // When every pinned address refuses, Node reports one AggregateError
        // with an empty message; the per-address errors say what happened.
        if (error instanceof AggregateError && error.message === "") {
          error = new Error(error.errors.map((inner: Error) => inner.message).join("; "));
        }
        reject(call.writableFinished ? outcomeUnknown(error.message) : error);
      };
      // Rejected here rather than left to `destroy()` to emit 'error': a
      // request Node has already destroyed emits nothing more, and the call
      // would never settle.
      const stop = (reason: string): void => {
        failed(new Error(reason));
        call.destroy();
      };
      // One deadline for the whole exchange. Node's own `timeout` only notices
      // a socket that goes quiet, so a server sending a byte at a time held the
      // call, and any verification or reconciliation waiting on it, for as
      // long as it liked.
      deadline = setTimeout(() => stop("http_timeout"), operation.timeoutMs);
      deadline.unref();
      call.on("error", failed);
      // A 101 is an upgrade to Node, never a response: without this listener
      // it drops the socket and the request ends with only 'close'. No
      // protocol but HTTP is spoken here, so the switch is refused.
      call.on("upgrade", (_response, socket) => {
        socket.destroy();
        failed(new Error("http_upgrade_refused"));
      });
      // Every other way the request can end without an answer or an error.
      call.on("close", () => {
        if (!answered) failed(new Error("http_closed_without_response"));
      });
      if (signal !== undefined) {
        onAbort = () => stop(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (operation.content !== undefined) call.write(operation.content);
      call.end();
    }).finally(() => {
      clearTimeout(deadline);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    });
  }
}
