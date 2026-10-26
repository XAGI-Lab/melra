// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { hold } from "./session-hold.js";

describe("hold", () => {
  it("lets a session go when the socket closes first, as Node 22 leaves a pipelined response", () => {
    const session = { busy: 0 };
    const socket = new EventEmitter();
    const response = new EventEmitter();
    hold(session, { socket }, response);
    expect(session.busy).toBe(1);
    socket.emit("close");
    expect(session.busy).toBe(0);
    // The response closing later does not count it down twice.
    response.emit("close");
    expect(session.busy).toBe(0);
  });

  it("releases once when the socket's close closes the response, as node:http does", () => {
    const session = { busy: 0 };
    const socket = new EventEmitter();
    const response = new EventEmitter();
    // node:http listens on the socket before any handler does, and closes
    // the response from inside the socket's own close.
    socket.on("close", () => response.emit("close"));
    hold(session, { socket }, response);
    socket.emit("close");
    expect(session.busy).toBe(0);
  });

  it("counts each request once, released by its own response", () => {
    const session = { busy: 0 };
    const socket = new EventEmitter();
    const first = new EventEmitter();
    const second = new EventEmitter();
    hold(session, { socket }, first);
    hold(session, { socket }, second);
    first.emit("close");
    expect(session.busy).toBe(1);
    // A keep-alive socket outlives its requests without collecting listeners.
    expect(socket.listenerCount("close")).toBe(1);
    second.emit("close");
    socket.emit("close");
    expect(session.busy).toBe(0);
  });
});
