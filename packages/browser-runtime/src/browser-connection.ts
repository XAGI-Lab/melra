// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { Browser, BrowserContext } from "playwright-core";
import { chromium } from "playwright-core";

const CHROME_PATHS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

export interface BrowserConnectionOptions {
  executablePath?: string;
  headless: boolean;
  cdpEndpoint?: string;
  cdpContextIndex?: number;
  recordHarPath?: string;
  userDataDir?: string;
  /**
   * Loopback proxy every non-local request is routed through, so the address a
   * destination was checked against is the address the socket opens to. From
   * `startPinningProxy`; absent means the browser resolves names itself and the
   * DNS-rebinding window between check and connect stays open.
   */
  proxyServer?: string;
}

export interface BrowserConnection {
  browser: Browser;
  context: BrowserContext;
  ownsBrowser: boolean;
  ownsContext: boolean;
}

export async function detectBrowserExecutable(): Promise<string | undefined> {
  for (const path of CHROME_PATHS[process.platform] ?? []) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Continue to the next supported browser location.
    }
  }
  return undefined;
}

export async function connectBrowser(
  options: BrowserConnectionOptions,
): Promise<BrowserConnection> {
  if (options.cdpEndpoint !== undefined) {
    if (options.recordHarPath !== undefined) {
      throw new Error("browser_cdp_cannot_start_har_recording");
    }
    let endpoint: URL;
    try {
      endpoint = new URL(options.cdpEndpoint);
    } catch {
      throw new Error("browser_cdp_endpoint_invalid");
    }
    if (!["http:", "https:"].includes(endpoint.protocol)) {
      throw new Error("browser_cdp_endpoint_invalid");
    }
    const browser = await chromium.connectOverCDP(endpoint.href);
    const contexts = browser.contexts();
    const index = options.cdpContextIndex ?? contexts.length - 1;
    const context = contexts.at(index);
    if (context === undefined) {
      throw new Error("browser_cdp_context_not_found");
    }
    return {
      browser,
      context,
      ownsBrowser: false,
      ownsContext: false,
    };
  }
  const executablePath =
    options.executablePath ?? (await detectBrowserExecutable());
  if (executablePath === undefined) {
    throw new Error(
      "browser_not_found: install Chrome, Chromium, or Edge and rerun melra doctor",
    );
  }
  const contextOptions = {
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
    serviceWorkers: "block" as const,
    ...(options.recordHarPath === undefined
      ? {}
      : {
          recordHar: {
            path: options.recordHarPath,
            mode: "full" as const,
            // Bodies are embedded rather than omitted because a recording
            // without them cannot be replayed, which made the recording knob
            // evidence-only. It costs file size, and it means a HAR now holds
            // page content alongside the URLs and headers it always held —
            // treat one as the session itself, not as a log about it.
            content: "embed" as const,
          },
        }),
  };
  const launchOptions = {
    executablePath,
    headless: options.headless,
    ...(options.proxyServer === undefined
      ? {}
      : { proxy: { server: options.proxyServer } }),
  };
  if (options.userDataDir !== undefined) {
    // A persistent profile is a browser, not a context inside one: Chromium
    // locks the directory, so the only way to keep cookies across runs is to
    // launch against it directly. `context.browser()` is what the rest of the
    // runtime closes, and it is the same process either way.
    const context = await chromium.launchPersistentContext(options.userDataDir, {
      ...launchOptions,
      ...contextOptions,
    });
    const browser = context.browser();
    if (browser === null) throw new Error("browser_persistent_profile_unavailable");
    return { browser, context, ownsBrowser: true, ownsContext: true };
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext(contextOptions);
  return {
    browser,
    context,
    ownsBrowser: true,
    ownsContext: true,
  };
}
