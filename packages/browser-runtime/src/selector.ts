// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One ancestor step on the path from an anchor down to a snapshot element.
 *
 * The page collects these as plain data and the selector string is assembled
 * here, in Node, so the interesting logic is a pure function of plain objects
 * and can be tested without a DOM.
 */
export interface ElementDescriptor {
  tag: string;
  /** 1-based position among the parent's element children. */
  nth: number;
  id?: string;
  testId?: string;
}

/** CSS identifiers may not start with a digit and may not contain punctuation. */
const PLAIN_IDENTIFIER = /^[A-Za-z_-][\w-]*$/;

function attributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Assemble a CSS selector addressing the element the chain ends at.
 *
 * `snapshot` previously reported `{tag, role, name, type}` and nothing else,
 * which left a caller no way to turn something it had just seen into something
 * it could act on — the only remaining option was `getByText(..., {exact: true})`,
 * which breaks on whitespace, casing, and nested markup. Emitting a selector
 * alongside each element closes that loop.
 *
 * The chain runs anchor-first. Collection stops as soon as it reaches an element
 * carrying an `id` or `data-testid`, so a page that labels its markup produces a
 * short, re-render-durable selector; a page that does not falls back to a
 * positional path, which is exact for the snapshot it came from.
 */
export function buildSelector(chain: ElementDescriptor[]): string {
  if (chain.length === 0) throw new Error("browser_selector_requires_chain");
  return chain
    .map((step) => {
      if (step.id !== undefined) {
        return PLAIN_IDENTIFIER.test(step.id)
          ? `#${step.id}`
          : `[id="${attributeValue(step.id)}"]`;
      }
      if (step.testId !== undefined) {
        return `[data-testid="${attributeValue(step.testId)}"]`;
      }
      return `${step.tag}:nth-child(${step.nth})`;
    })
    .join(" > ");
}
