// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { inputSent } from "./index.js";

// Playwright 1.64's own text for a click whose page stalled the moment the
// mouse went down, captured with colour off and with FORCE_COLOR=1.
const log = [
  "  - waiting for locator('#go').first()",
  "    - locator resolved to <button id=\"go\">Go</button>",
  "  - attempting click action",
  "    - waiting for element to be visible, enabled and stable",
  "    - element is visible, enabled and stable",
  "    - scrolling into view if needed",
  "    - done scrolling",
  "    - performing click action",
];
const plain = `locator.click: Timeout 2000ms exceeded.\nCall log:\n${log.join("\n")}\n`;
const dim = (line: string) => `\u001b[2m${line}\u001b[22m`;
const coloured = `locator.click: Timeout 2000ms exceeded.\nCall log:\n${log.map(dim).join("\n")}\n`;

describe("inputSent", () => {
  it("finds Playwright's record that the input left, with or without colour", () => {
    expect(inputSent(new Error(plain))).toBe(true);
    // The case the Windows runners hit: every line ends in an escape code, and
    // the click was read as never sent.
    expect(inputSent(new Error(coloured))).toBe(true);
  });

  it("does not claim input left when Playwright never got that far", () => {
    const beforeDispatch = log.slice(0, 5).map(dim).join("\n");
    expect(inputSent(new Error(`locator.click: Timeout 500ms exceeded.\nCall log:\n${beforeDispatch}\n`))).toBe(false);
    expect(inputSent("performing click action")).toBe(false);
  });
});
