// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { connectBrowser } from "./browser-connection.js";

// What each way of getting a browser was asked for, with no Chrome needed.
const asked = vi.hoisted(() => [] as Array<[string, unknown]>);
vi.mock("playwright-core", () => {
  const context = { browser: () => ({}) };
  return {
    chromium: {
      launch: async (options: { args?: unknown }) => {
        asked.push(["launch", options.args]);
        return { newContext: async () => context, close: async () => undefined };
      },
      launchPersistentContext: async (_directory: string, options: { args?: unknown }) => {
        asked.push(["persistent", options.args]);
        return context;
      },
      connectOverCDP: async () => {
        asked.push(["attached", undefined]);
        return { contexts: () => [context] };
      },
    },
  };
});

describe("connectBrowser", () => {
  it("launches its own Chrome with WebRTC's UDP off, and leaves an attached one as it is", async () => {
    await connectBrowser({ executablePath: "/chrome", headless: true });
    await connectBrowser({ executablePath: "/chrome", headless: true, userDataDir: "/profile" });
    await connectBrowser({ headless: true, cdpEndpoint: "http://127.0.0.1:9222" });
    const off = ["--webrtc-ip-handling-policy=disable_non_proxied_udp"];
    expect(asked).toEqual([
      ["launch", off],
      ["persistent", off],
      ["attached", undefined],
    ]);
  });
});
