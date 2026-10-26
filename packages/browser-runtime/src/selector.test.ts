// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { buildSelector } from "./selector.js";

describe("buildSelector", () => {
  it("anchors on an id when the page provides one", () => {
    expect(
      buildSelector([
        { tag: "form", nth: 2, id: "login" },
        { tag: "input", nth: 3 },
      ]),
    ).toBe("#login > input:nth-child(3)");
  });

  it("prefers a test id over positional descent", () => {
    expect(
      buildSelector([
        { tag: "div", nth: 1, testId: "cart" },
        { tag: "button", nth: 2 },
      ]),
    ).toBe('[data-testid="cart"] > button:nth-child(2)');
  });

  it("falls back to a positional path when nothing is labelled", () => {
    expect(
      buildSelector([
        { tag: "html", nth: 1 },
        { tag: "body", nth: 2 },
        { tag: "a", nth: 5 },
      ]),
    ).toBe("html:nth-child(1) > body:nth-child(2) > a:nth-child(5)");
  });

  it("quotes an id that is not a bare CSS identifier", () => {
    // Frameworks emit ids like `:r1:` and `user.email`, which `#id` cannot spell.
    expect(buildSelector([{ tag: "input", nth: 1, id: ":r1:" }])).toBe(
      '[id=":r1:"]',
    );
    expect(buildSelector([{ tag: "input", nth: 1, id: 'a"b' }])).toBe(
      '[id="a\\"b"]',
    );
  });

  it("refuses an empty chain rather than emitting a selector matching everything", () => {
    expect(() => buildSelector([])).toThrow("browser_selector_requires_chain");
  });
});
