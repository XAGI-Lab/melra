// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

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
 * `text` with every brokered value the far end echoed replaced. Exact matches
 * only: a credential echoed transformed (encoded, masked, split) is not caught.
 */
function scrubbed(text: string, { headers, secrets }: BrokeredHeaders, cut: boolean): string {
  let out = text;
  // Longest first, so a whole header value goes as one marker.
  for (const value of [...Object.values(headers), ...secrets].sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(value, REDACTED_CREDENTIAL);
  }
  if (!cut || secrets.length === 0) return out;
  // A body cut at the size cap can end partway through a secret, so its end
  // goes whatever it holds. Deciding by whether it looks like the start of one
  // would tell the caller something about the secret. The whole length of the
  // longest; the broker passes only printable ASCII, so a character is a byte.
  const tail = Math.max(...secrets.map((secret) => secret.length));
  return `${out.slice(0, Math.max(0, out.length - tail))}${REDACTED_CREDENTIAL}`;
}

export interface HttpRuntimeOptions extends NetworkPolicy {
  /**
   * Supplies the secrets this adapter is allowed to send. Omitted means every
   * request goes out with exactly the headers the caller wrote.
   */
  credentials?: CredentialBroker;
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
    if (cancelled()) throw new Error("task_cancelled");
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
    if (cancelled()) throw new Error("task_cancelled");

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
      // One deadline for the whole exchange. Node's own `timeout` only notices
      // a socket that goes quiet, so a server sending a byte at a time held the
      // call, and any verification or reconciliation waiting on it, for as
      // long as it liked.
      deadline = setTimeout(() => call.destroy(new Error("http_timeout")), operation.timeoutMs);
      deadline.unref();
      call.on("error", failed);
      signal?.addEventListener(
        "abort",
        () => call.destroy(new Error("task_cancelled")),
        { once: true },
      );
      if (operation.content !== undefined) call.write(operation.content);
      call.end();
    }).finally(() => clearTimeout(deadline));
  }
}
