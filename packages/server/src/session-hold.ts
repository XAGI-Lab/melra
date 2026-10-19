// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

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
  const release = () => {
    socket.off("close", release);
    response.off("close", release);
    session.busy -= 1;
  };
  response.once("close", release);
  socket.once("close", release);
}
