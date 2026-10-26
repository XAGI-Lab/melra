// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Zed, VS Code, and Amp read their settings as JSONC: JSON plus `//` and
// `/* */` comments and trailing commas. A round-trip through JSON.parse and
// JSON.stringify would drop every comment, so `setup --write` edits those
// files in place instead, which needs the source offsets JSON.parse does not
// give. This is the whole JSONC grammar in a few dozen lines, so it is written
// here rather than pulled in as a dependency for one call site.

export interface JsoncMember {
  key: string;
  keyStart: number;
  value: JsoncNode;
}

export interface JsoncNode {
  // Offsets into the source: `end` is one past the value's last character.
  start: number;
  end: number;
  value: unknown;
  // Objects only: every member in source order, duplicates kept, so an edit
  // can refuse a key the client might read from either place.
  members?: JsoncMember[];
  // Objects only: the offset of a comma after the last member, if there is one.
  trailingComma?: number;
}

type ObjectNode = JsoncNode & { members: JsoncMember[] };

const NUMBER_OR_LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

export function parseJsonc(text: string): JsoncNode {
  let at = 0;
  const error = (what: string) =>
    new Error(`${what} at line ${text.slice(0, at).split("\n").length}`);

  const skip = () => {
    for (;;) {
      const c = text[at];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || (c === "﻿" && at === 0)) {
        at++;
      } else if (text.startsWith("//", at)) {
        const newline = text.indexOf("\n", at);
        at = newline === -1 ? text.length : newline;
      } else if (text.startsWith("/*", at)) {
        const close = text.indexOf("*/", at + 2);
        if (close === -1) throw error("unterminated comment");
        at = close + 2;
      } else {
        return;
      }
    }
  };

  // Find the closing quote by hand so `//` or `/*` inside a string is never
  // taken for a comment, then let JSON.parse decode and validate the escapes.
  const string = (): string => {
    const start = at++;
    for (;;) {
      const c = text[at];
      if (c === undefined) throw error("unterminated string");
      at += c === "\\" ? 2 : 1;
      if (c === '"') break;
    }
    try {
      return JSON.parse(text.slice(start, at)) as string;
    } catch {
      throw error("invalid string");
    }
  };

  const object = (): ObjectNode => {
    const start = at++;
    const members: JsoncMember[] = [];
    const value: Record<string, unknown> = {};
    let trailingComma: number | undefined;
    skip();
    while (text[at] !== "}") {
      if (text[at] !== '"') throw error("expected a quoted key or '}'");
      const keyStart = at;
      const key = string();
      skip();
      if (text[at] !== ":") throw error("expected ':'");
      at++;
      const node = parse();
      members.push({ key, keyStart, value: node });
      // defineProperty, not assignment, so a `__proto__` key stays plain data.
      Object.defineProperty(value, key, {
        value: node.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      skip();
      trailingComma = undefined;
      if (text[at] === ",") {
        trailingComma = at++;
        skip();
      } else if (text[at] !== "}") {
        throw error("expected ',' or '}'");
      }
    }
    at++;
    return { start, end: at, value, members, ...(trailingComma === undefined ? {} : { trailingComma }) };
  };

  const array = (): JsoncNode => {
    const start = at++;
    const items: unknown[] = [];
    skip();
    while (text[at] !== "]") {
      items.push(parse().value);
      skip();
      if (text[at] === ",") {
        at++;
        skip();
      } else if (text[at] !== "]") {
        throw error("expected ',' or ']'");
      }
    }
    at++;
    return { start, end: at, value: items };
  };

  const parse = (): JsoncNode => {
    skip();
    const start = at;
    const c = text[at];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') {
      const value = string();
      return { start, end: at, value };
    }
    NUMBER_OR_LITERAL.lastIndex = at;
    const match = NUMBER_OR_LITERAL.exec(text);
    if (match === null) {
      throw error(c === undefined ? "unexpected end of file" : `unexpected ${JSON.stringify(c)}`);
    }
    at = NUMBER_OR_LITERAL.lastIndex;
    return { start, end: at, value: JSON.parse(match[0]) };
  };

  const root = parse();
  skip();
  if (at < text.length) throw error("unexpected content after the value");
  return root;
}

const splice = (text: string, from: number, to: number, insert: string) =>
  `${text.slice(0, from)}${insert}${text.slice(to)}`;

const lineStart = (text: string, offset: number) => text.lastIndexOf("\n", offset - 1) + 1;

// The run of spaces and tabs that starts the line holding `offset`.
const lineIndent = (text: string, offset: number) =>
  /^[ \t]*/.exec(text.slice(lineStart(text, offset), offset))?.[0] ?? "";

const startsLine = (text: string, offset: number) =>
  text.slice(lineStart(text, offset), offset).trim() === "";

// The end of the line after `from` when only blanks and comments follow it
// there, so a member inserted after `"a": 1, // why` lands below the comment
// instead of stealing it; otherwise `from` itself.
function endOfTriviaLine(text: string, from: number): number {
  let at = from;
  for (;;) {
    while (text[at] === " " || text[at] === "\t") at++;
    if (text.startsWith("//", at)) {
      const newline = text.indexOf("\n", at);
      if (newline === -1) return from;
      at = newline;
    } else if (text.startsWith("/*", at)) {
      const close = text.indexOf("*/", at);
      if (close === -1 || text.slice(at, close).includes("\n")) return from;
      at = close + 2;
      continue;
    }
    if (text[at] === "\r" && text[at + 1] === "\n") return at;
    if (text[at] === "\n") return text[at - 1] === "\r" ? at - 1 : at;
    return from;
  }
}

/**
 * Set `path` to `value` in JSONC `text`, rewriting only that member and
 * leaving every other byte (comments, trailing commas, formatting, key order,
 * line endings) as it was. A missing member is inserted into the deepest
 * object that exists, indented to match its siblings. With `keepExisting`, a
 * member that is already there is left alone. Throws when the root or a step
 * of the path is not an object, or a step appears twice in one object, since
 * which duplicate a client honours is not knowable from here.
 */
export function upsertJsonc(
  text: string,
  path: string[],
  value: unknown,
  keepExisting = false,
): string {
  const root = parseJsonc(text);
  if (root.members === undefined) throw new Error("it does not hold a JSON object");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const rootIndent = lineIndent(text, root.start);
  const nested = root.members.find((member) => startsLine(text, member.keyStart));
  const unit =
    (nested === undefined ? "" : lineIndent(text, nested.keyStart).slice(rootIndent.length)) ||
    "  ";
  // An object written on one line gets its new member on that line too.
  const render = (data: unknown, indent: string, inline: boolean) =>
    inline
      ? JSON.stringify(data)
      : JSON.stringify(data, null, unit).replaceAll("\n", `${eol}${indent}`);

  let object = root as ObjectNode;
  for (const [depth, key] of path.entries()) {
    const name = JSON.stringify(path.slice(0, depth + 1).join("."));
    const matches = object.members.filter((member) => member.key === key);
    if (matches.length > 1) {
      throw new Error(`${name} appears more than once, so which one is read is ambiguous`);
    }
    const inline = !text.slice(object.start, object.end).includes("\n");
    const found = matches[0];
    if (found !== undefined && depth === path.length - 1) {
      if (keepExisting) return text;
      const indent = lineIndent(text, found.keyStart);
      return splice(text, found.value.start, found.value.end, render(value, indent, inline));
    }
    if (found !== undefined) {
      if (found.value.members === undefined) throw new Error(`${name} is not an object`);
      object = found.value as ObjectNode;
      continue;
    }

    // Insert `"key": value`, wrapping it in whatever of the path is missing.
    const data = path
      .slice(depth + 1)
      .reduceRight<unknown>((inner, step) => ({ [step]: inner }), value);
    const last = object.members.at(-1);
    const objectIndent = lineIndent(text, object.start);
    const indent =
      last !== undefined && startsLine(text, last.keyStart)
        ? lineIndent(text, last.keyStart)
        : `${objectIndent}${unit}`;
    const member = `${JSON.stringify(key)}: ${render(data, indent, inline && last !== undefined)}`;
    if (last === undefined) {
      const close = object.end - 1;
      if (text.slice(object.start + 1, close).trim() === "") {
        return splice(text, object.start + 1, close, `${eol}${indent}${member}${eol}${objectIndent}`);
      }
      // Only comments inside: keep them, and put the member just above `}`.
      if (startsLine(text, close)) {
        const at = lineStart(text, close);
        return splice(text, at, at, `${indent}${member}${eol}`);
      }
      return splice(text, close, close, `${eol}${indent}${member}${eol}${objectIndent}`);
    }
    // Append after the last member, keeping the object's trailing-comma style:
    // with one, the new last member gets one too; without, the old last
    // member gains the separating comma.
    const comma = object.trailingComma;
    const anchor = comma === undefined ? last.value.end : comma + 1;
    const at = inline ? anchor : endOfTriviaLine(text, anchor);
    const added = splice(
      text,
      at,
      at,
      `${inline ? " " : `${eol}${indent}`}${member}${comma === undefined ? "" : ","}`,
    );
    return comma === undefined ? splice(added, anchor, anchor, ",") : added;
  }
  // Only reachable with an empty path, which no caller passes.
  throw new Error("nothing to set");
}
