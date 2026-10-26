// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import type { EventEmitter } from "node:events";

/**
 * Counts a request against its MCP session until its response or its socket
 * closes, whichever is first. Node 22 never closes a pipelined response whose
 * socket died, and a count that never comes down keeps the session for good.
 */
export function hold(
  session: { busy: number },
  request: { socket: EventEmitter },
  response: EventEmitter,
): void {
  session.busy += 1;
  const { socket } = request;
  // Once only: node:http's own socket listener closes the response while the
  // socket's close is still being emitted, so both listeners run even though
  // the first takes the other off.
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    socket.off("close", release);
    response.off("close", release);
    session.busy -= 1;
  };
  response.once("close", release);
  socket.once("close", release);
}
