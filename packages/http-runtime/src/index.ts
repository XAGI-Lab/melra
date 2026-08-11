// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { HttpOperation } from "@melra/protocol";
import { assertSafeDestination, type NetworkPolicy } from "@melra/policy-core";

export interface HttpRuntimeOptions extends NetworkPolicy {}

/**
 * One governed HTTP call.
 *
 * The interesting part is which socket opens. `assertSafeDestination` resolves
 * the name and checks every answer, then this connects to the address it just
 * checked rather than to the name — the same pinning `PinningProxy` does for the
 * browser, and for the same reason: a resolver that answers public once and
 * private the second time would otherwise make the check meaningless.
 */
export class HttpRuntime {
  constructor(private readonly options: HttpRuntimeOptions) {}

  async execute(
    operation: HttpOperation,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const { url, address } = await assertSafeDestination(
      operation.url,
      this.options,
    );
    // Checked here and not only in the router: the destination check above is
    // an await, and a cancel that lands inside that window would otherwise be
    // lost and the request would go out anyway.
    if (signal?.aborted === true) throw new Error("task_cancelled");
    const secure = url.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {
      ...(operation.headers ?? {}),
      // `Host` carries the name so a name-based virtual host still resolves at
      // the far end even though the socket was opened to a literal address.
      host: url.host,
      ...(operation.idempotencyKey === undefined
        ? {}
        : { "idempotency-key": operation.idempotencyKey }),
    };
    if (operation.content !== undefined) {
      headers["content-length"] = String(Buffer.byteLength(operation.content));
    }

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const call = send(
        {
          host: address,
          port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
          method: operation.method,
          path: `${url.pathname}${url.search}`,
          headers,
          // TLS is validated against the name the caller asked for, not the
          // address the socket went to, or pinning would break every https URL.
          ...(secure ? { servername: url.hostname } : {}),
          timeout: operation.timeoutMs,
        },
        (response: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          let truncated = false;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > operation.maxResponseBytes) {
              // Stop reading rather than buffering an unbounded body into the
              // host's heap. What arrived is still reported, flagged.
              truncated = true;
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          const finish = (): void => {
            const status = response.statusCode ?? 0;
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
              statusText: response.statusMessage ?? "",
              headers: response.headers as Record<string, unknown>,
              content: Buffer.concat(chunks).toString("utf8"),
              bytes,
              truncated,
              url: url.toString(),
              method: operation.method,
            });
          };
          response.on("end", finish);
          response.on("close", finish);
          response.on("error", reject);
        },
      );
      // A timeout fires the event but does not end the request; without this an
      // unresponsive host holds the socket for the life of the process.
      call.on("timeout", () => {
        call.destroy(new Error("http_timeout"));
      });
      call.on("error", reject);
      signal?.addEventListener(
        "abort",
        () => call.destroy(new Error("task_cancelled")),
        { once: true },
      );
      if (operation.content !== undefined) call.write(operation.content);
      call.end();
    });
  }
}
