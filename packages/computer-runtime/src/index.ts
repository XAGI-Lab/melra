// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ComputerOperation } from "@melra/protocol";

const execFileAsync = promisify(execFile);

export interface ComputerCapabilities {
  platform: NodeJS.Platform;
  adapter: "macos-native" | "linux-xdotool" | "windows-powershell" | "unavailable";
  available: boolean;
  screenshot: boolean;
  pointer: boolean;
  keyboard: boolean;
  scroll: boolean;
  /** `inspect` can report the focused window and display geometry. */
  inspect: boolean;
  /** `inspect` can list addressable elements, so `target` resolves to a point. */
  elements: boolean;
  /**
   * A screenshot can be read for words, so `target` resolves on a desktop with
   * no accessibility tree. Weaker than `elements` in kind, not only in quality:
   * a tree states what a control *is*, while a reading only says what it looks
   * like, which is why every element it produces carries a `confidence`.
   */
  ocr: boolean;
  /** `drag` can hold the button down between two points. */
  drag: boolean;
  coordinateSpaces: Array<"normalized" | "pixel">;
  limitations: string[];
}

/**
 * One addressable thing on the desktop, in pixel space. `role` is the platform's
 * own word for what it is (`AXButton` on macOS, a UI Automation control type on
 * Windows) rather than a normalised vocabulary: translating it would mean
 * guessing at intent, and a caller that can read `inspect` output can match what
 * it saw there.
 */
export interface DesktopElement {
  role: string;
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * How sure the reading is, `0`–`1`. Present only on an element read off a
   * screenshot; an element the platform reported has no confidence because it
   * is not a reading. Absent therefore means "stated", never "unsure".
   */
  confidence?: number;
}

/**
 * What the desktop looked like at a moment in time. `inspect` returns this, and
 * a caller can hold a task to it with `result_equals` — "the frontmost
 * application is Safari" is a post-condition an adapter cannot fake by
 * returning `success: true`.
 *
 * Every field is optional because the platforms degrade differently: macOS
 * needs Accessibility permission to name a window at all, X11 needs a window
 * manager that sets `_NET_ACTIVE_WINDOW`, and a headless session has no
 * frontmost anything. A missing field is "not observable here", never "empty".
 */
export interface DesktopObservation {
  application?: string;
  windowTitle?: string;
  displayWidth?: number;
  displayHeight?: number;
  /**
   * The OS has given one process exclusive keyboard access — a password field
   * is focused, or a lock screen is up. Synthetic keystrokes do not reach it.
   */
  secureInput?: boolean;
  /**
   * Addressable elements of the frontmost window, when the platform exposes an
   * accessibility tree — or, where it does not, words read off a screenshot,
   * each carrying a `confidence`. Absent — not empty — when neither was
   * possible, because "this window has no buttons" and "I cannot see this
   * window's buttons" have to stay distinguishable to a caller deciding whether
   * to fall back to coordinates.
   */
  elements?: DesktopElement[];
}

/** Depth-first cap on what an adapter may report, matched in each helper script. */
const MAX_ELEMENTS = 200;

/**
 * Reads an adapter helper's JSON into a `DesktopObservation`, keeping only the
 * declared fields and only when they carry a usable value. A helper that reports
 * an empty window title or a zero display is reporting "I could not see it", and
 * that has to arrive as an absent field: a caller verifying `windowTitle` with
 * `result_equals` must not be handed `""` as though it were observed.
 */
function observationFrom(json: string): DesktopObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.trim());
  } catch {
    throw new Error("computer_inspect_unparseable");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("computer_inspect_unparseable");
  }
  const record = parsed as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  };
  const size = (key: string): number | undefined => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.round(value)
      : undefined;
  };
  const application = text("application");
  const windowTitle = text("windowTitle");
  const displayWidth = size("displayWidth");
  const displayHeight = size("displayHeight");
  const elements = elementsFrom(record["elements"]);
  return {
    ...(application === undefined ? {} : { application }),
    ...(windowTitle === undefined ? {} : { windowTitle }),
    ...(displayWidth === undefined ? {} : { displayWidth }),
    ...(displayHeight === undefined ? {} : { displayHeight }),
    ...(elements === undefined ? {} : { elements }),
  };
}

/**
 * An element list is dropped entirely when the key is absent, and entries within
 * it are dropped individually when a platform could not measure one. A
 * zero-sized or unnamed control is real; one with no role or no geometry cannot
 * be clicked, so keeping it would only offer the caller a target that fails at
 * the point of use.
 */
function elementsFrom(value: unknown): DesktopElement[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const elements: DesktopElement[] = [];
  for (const entry of value.slice(0, MAX_ELEMENTS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const role = record["role"];
    const name = record["name"];
    const box = ["x", "y", "width", "height"].map((key) => record[key]);
    const confidence = record["confidence"];
    if (typeof role !== "string" || role.trim() === "") continue;
    if (!box.every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    const [x, y, width, height] = box as number[];
    if (width! <= 0 || height! <= 0) continue;
    elements.push({
      role,
      ...(typeof name === "string" && name.trim() !== "" ? { name } : {}),
      ...(typeof confidence === "number" && Number.isFinite(confidence)
        ? { confidence: Math.min(1, Math.max(0, confidence)) }
        : {}),
      x: Math.round(x!),
      y: Math.round(y!),
      width: Math.round(width!),
      height: Math.round(height!),
    });
  }
  return elements;
}

/**
 * Where each platform's package manager puts `tesseract`. Probed by path rather
 * than resolved through `PATH`, matching the other tool detection here: a `PATH`
 * lookup would let a directory earlier in the caller's environment decide which
 * binary gets to read the screen.
 */
const TESSERACT_PATHS = [
  "/opt/homebrew/bin/tesseract",
  "/usr/local/bin/tesseract",
  "/usr/bin/tesseract",
  "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
];

async function tesseract(): Promise<string | undefined> {
  for (const path of TESSERACT_PATHS) {
    if (await executable(path)) return path;
  }
  return undefined;
}

/** Below this a word is noise rather than a reading, and is not reported. */
const MIN_OCR_CONFIDENCE = 0.3;

/** Below this a word is reported by `inspect` but refused as a click target. */
const MIN_TARGET_CONFIDENCE = 0.7;

/**
 * Words read off a screenshot, in the display's own pixel space.
 *
 * Tesseract's TSV carries one row per token with a `level` column: `1` is the
 * whole page, `5` is a word. Only words are kept, because a line row spanning
 * "Save Cancel" has a centre point that lands between two buttons.
 *
 * The page row's width is what the image measured, and a Retina capture is
 * larger than the display it came from by the backing scale factor, so every
 * box is scaled by the ratio between them. A capture with no readable page row
 * yields nothing rather than coordinates at an assumed scale.
 *
 * Exported for the same reason as `matchElement`: the parsing is the part worth
 * testing without a screen to point at.
 */
export function parseOcrElements(
  tsv: string,
  displayWidth: number,
): DesktopElement[] {
  const rows = tsv.split("\n").map((line) => line.split("\t"));
  const imageWidth = Number(rows.find((columns) => columns[0] === "1")?.[8]);
  if (!Number.isFinite(imageWidth) || imageWidth <= 0) return [];
  const scale = displayWidth / imageWidth;
  const elements: DesktopElement[] = [];
  for (const columns of rows) {
    if (columns[0] !== "5" || columns.length < 12) continue;
    // Text is the last column and tesseract does not quote it, so a token
    // containing a tab would otherwise arrive truncated.
    const name = columns.slice(11).join("\t").trim();
    const confidence = Number(columns[10]) / 100;
    const box = [6, 7, 8, 9].map((index) => Number(columns[index]));
    if (name === "") continue;
    if (!Number.isFinite(confidence) || confidence < MIN_OCR_CONFIDENCE) continue;
    if (!box.every((value) => Number.isFinite(value))) continue;
    const [x, y, width, height] = box as number[];
    if (width! <= 0 || height! <= 0) continue;
    elements.push({
      role: "text",
      name,
      x: Math.round(x! * scale),
      y: Math.round(y! * scale),
      width: Math.round(width! * scale),
      height: Math.round(height! * scale),
      confidence: Math.min(1, Math.round(confidence * 100) / 100),
    });
    if (elements.length >= MAX_ELEMENTS) break;
  }
  return elements;
}

/**
 * Resolves a named target against an observed element list.
 *
 * Ambiguity is an error rather than a first-match, because the failure mode of
 * guessing is clicking the wrong "Delete" and there is no undo for a desktop
 * action. Exact names beat substrings for the same reason: a window with both
 * "Save" and "Save As…" must resolve "Save" to the one the caller wrote. An
 * element read off a screenshot has to clear `MIN_TARGET_CONFIDENCE` on top of
 * matching, since a doubtful reading is a doubtful click and the same reasoning
 * applies — worth reporting from `inspect`, not worth acting on.
 *
 * Exported because the matching rules are the part worth testing directly —
 * everything around them needs a live desktop.
 */
export function matchElement(
  elements: DesktopElement[],
  target: { role?: string | undefined; name?: string | undefined },
): DesktopElement {
  if (target.role === undefined && target.name === undefined) {
    throw new Error("computer_target_requires_role_or_name");
  }
  const role = target.role?.toLocaleLowerCase();
  const candidates =
    role === undefined
      ? elements
      : elements.filter((e) => e.role.toLocaleLowerCase() === role);
  let matches = candidates;
  if (target.name !== undefined) {
    const wanted = target.name.toLocaleLowerCase();
    const exact = candidates.filter(
      (e) => e.name?.toLocaleLowerCase() === wanted,
    );
    matches =
      exact.length > 0
        ? exact
        : candidates.filter((e) =>
            e.name?.toLocaleLowerCase().includes(wanted) === true,
          );
  }
  if (matches.length === 0) throw new Error("computer_target_not_found");
  if (matches.length > 1) {
    const listed = matches
      .slice(0, 5)
      .map((e) => `${e.role}:${e.name ?? "?"}`)
      .join(", ");
    throw new Error(`computer_target_ambiguous: ${listed}`);
  }
  const chosen = matches[0]!;
  if (
    chosen.confidence !== undefined &&
    chosen.confidence < MIN_TARGET_CONFIDENCE
  ) {
    throw new Error(
      `computer_target_confidence_too_low: ${chosen.confidence.toFixed(2)} < ${MIN_TARGET_CONFIDENCE}`,
    );
  }
  return chosen;
}

/**
 * Validates a positional action's coordinates and hands them back already
 * narrowed, so callers work with numbers instead of re-asserting the optionals
 * the schema has to leave open for the actions that carry no position.
 */
function requirePoints(operation: ComputerOperation): {
  x: number;
  y: number;
  to?: { x: number; y: number };
} {
  if (operation.x === undefined || operation.y === undefined) {
    throw new Error(`computer_${operation.action}_requires_coordinates`);
  }
  if (operation.action !== "drag") return { x: operation.x, y: operation.y };
  if (operation.toX === undefined || operation.toY === undefined) {
    throw new Error("computer_drag_requires_destination");
  }
  return {
    x: operation.x,
    y: operation.y,
    to: { x: operation.toX, y: operation.toY },
  };
}

export interface ComputerAdapter {
  capabilities(): Promise<ComputerCapabilities>;
  execute(
    operation: ComputerOperation,
    artifactDirectory: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export interface ComputerRuntimeOptions {
  artifactDirectory: string;
  adapter?: ComputerAdapter;
}

const ALLOWED_KEYS: Record<string, number> = {
  ENTER: 36,
  TAB: 48,
  SPACE: 49,
  BACKSPACE: 51,
  ESCAPE: 53,
  LEFT: 123,
  RIGHT: 124,
  DOWN: 125,
  UP: 126,
  HOME: 115,
  END: 119,
  PAGEUP: 116,
  PAGEDOWN: 121,
  DELETE: 117,
};

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(
  file: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(file, args, {
      timeout: timeoutMs,
      maxBuffer: 1_000_000,
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (cause) {
    /**
     * Node builds this rejection's message from the whole command line, which
     * for an adapter means the entire script: a Windows screenshot failure
     * arrived as fifteen lines of echoed PowerShell with the actual reason
     * nowhere in it, and a timeout arrived as the same fifteen lines with an
     * empty stderr, indistinguishable from a script that failed instantly.
     *
     * Report the interpreter's own words instead, and name a timeout as a
     * timeout — a caller can act on "the helper was killed after 10000ms" and
     * can act on a permission error, but not on a copy of the script it did
     * not write.
     */
    const error = cause as NodeJS.ErrnoException & {
      stderr?: string;
      killed?: boolean;
    };
    const program = basename(file);
    if (error.killed === true || error.code === "ETIMEDOUT") {
      throw new Error(`computer_helper_timeout:${program}:${timeoutMs}ms`);
    }
    if (signal?.aborted === true) throw new Error("task_cancelled");
    // First line only: interpreters follow the reason with a stack trace naming
    // the script we generated, which is noise to whoever reads this.
    const reason = (error.stderr ?? "").trim().split("\n")[0]?.trim();
    throw new Error(
      reason === undefined || reason === ""
        ? `computer_helper_failed:${program}`
        : `computer_helper_failed:${program}: ${reason}`,
    );
  }
}

function coordinateScript(operation: ComputerOperation): string {
  const normalized = operation.coordinateSpace === "normalized";
  const axis = (value: number, side: "width" | "height"): string =>
    normalized ? `frame.size.${side} * ${value}` : String(value);
  return `
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
const frame = $.NSScreen.mainScreen.frame;
const x = ${axis(operation.x ?? 0, "width")};
const y = ${axis(operation.y ?? 0, "height")};
const point = $.CGPointMake(x, y);
function post(type, at) {
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, type, at, $.kCGMouseButtonLeft));
}
post($.kCGEventMouseMoved, point);
${operation.action === "click" ? `
post($.kCGEventLeftMouseDown, point);
post($.kCGEventLeftMouseUp, point);` : ""}
${operation.action === "drag" ? `
const toX = ${axis(operation.toX ?? 0, "width")};
const toY = ${axis(operation.toY ?? 0, "height")};
post($.kCGEventLeftMouseDown, point);
// A single jump from press to release is not a drag to most views — they track
// the intermediate motion and a lone dragged event reads as a click that moved.
for (let step = 1; step <= ${MACOS_DRAG_STEPS}; step += 1) {
  const ratio = step / ${MACOS_DRAG_STEPS};
  post($.kCGEventLeftMouseDragged, $.CGPointMake(x + (toX - x) * ratio, y + (toY - y) * ratio));
}
post($.kCGEventLeftMouseUp, $.CGPointMake(toX, toY));` : ""}
`;
}

/** Intermediate motion events synthesised between a drag's press and release. */
const MACOS_DRAG_STEPS = 10;

/**
 * Depth the accessibility walk descends before stopping.
 *
 * ponytail: fixed depth, not an adaptive budget. Every JXA accessor is an Apple
 * Event round trip, so a full-tree walk of a document-heavy app costs seconds;
 * four levels reaches the toolbar and window controls a caller names by hand
 * without paying for a text view's every glyph run. Raise it here if a real
 * target turns out to sit deeper.
 */
const MACOS_ELEMENT_DEPTH = 4;

const MACOS_INSPECT_SCRIPT = `
ObjC.import("AppKit");
const frame = $.NSScreen.mainScreen.frame;
const out = {
  displayWidth: Math.round(frame.size.width),
  displayHeight: Math.round(frame.size.height),
};
// Naming the frontmost application needs Accessibility permission and naming
// its window needs the application to expose one. Either can be missing on a
// working machine, so each degrades to an absent field instead of an error.
try {
  const frontmost = Application("System Events")
    .applicationProcesses.whose({ frontmost: true })[0];
  out.application = frontmost.name();
  const window = frontmost.windows[0];
  try {
    out.windowTitle = window.name();
  } catch (error) {}
  // Every accessor below is guarded on its own: an element can vanish between
  // being listed and being measured, and one that does must not cost the whole
  // list. A partial tree is useful; an exception here is not.
  const elements = [];
  const label = (node) => {
    for (const read of [() => node.title(), () => node.description(), () => node.value()]) {
      try {
        const value = read();
        if (typeof value === "string" && value.trim() !== "") return value;
      } catch (error) {}
    }
    return null;
  };
  const visit = (node, depth) => {
    if (depth > ${MACOS_ELEMENT_DEPTH} || elements.length >= ${MAX_ELEMENTS}) return;
    let children = [];
    try {
      children = node.uiElements();
    } catch (error) {
      return;
    }
    for (const child of children) {
      if (elements.length >= ${MAX_ELEMENTS}) return;
      try {
        const position = child.position();
        const size = child.size();
        const entry = {
          role: child.role(),
          x: position[0],
          y: position[1],
          width: size[0],
          height: size[1],
        };
        const name = label(child);
        if (name !== null) entry.name = name;
        elements.push(entry);
      } catch (error) {}
      visit(child, depth + 1);
    }
  };
  visit(window, 0);
  out.elements = elements;
} catch (error) {}
JSON.stringify(out);
`;

/**
 * Reads secure-input state out of an `ioreg` dump of the console-session
 * dictionary. `undefined` means the dump held no session at all, which is "not
 * observable here" rather than "off".
 *
 * Exported for the test: the negative case is the one a developer machine
 * naturally produces, so the positive case — a real password field taking the
 * keyboard — can only be exercised against captured output.
 */
export function parseSecureInput(stdout: string): boolean | undefined {
  // Absence of the secure-input key only means "off" if a session was reported.
  if (!stdout.includes("kCGSSessionOnConsoleKey")) return undefined;
  const match = /"kCGSSessionSecureInputPID"=(-?\d+)/.exec(stdout);
  // The key is written with the holding process's pid and cleared to 0, so a
  // present-but-zero value is still "off".
  return match !== null && Number(match[1]) !== 0;
}

/**
 * Whether some process holds a secure keyboard entry session — a password field
 * is focused, or the screen is locked. While it does, synthetic keystrokes are
 * dropped by the window server, so `type` and `key` would report success while
 * typing into nothing.
 *
 * The state lives in the console-session dictionary on `IOResources`. `-d 1`
 * keeps this to a few kilobytes rather than dumping the whole registry.
 */
async function macSecureInput(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  try {
    const { stdout } = await run(
      "/usr/sbin/ioreg",
      ["-l", "-d", "1", "-w", "0", "-r", "-c", "IOResources"],
      Math.min(timeoutMs, 5_000),
      signal,
    );
    return parseSecureInput(stdout);
  } catch {
    return undefined;
  }
}

class MacOsAdapter implements ComputerAdapter {
  async capabilities(): Promise<ComputerCapabilities> {
    const osascript = await executable("/usr/bin/osascript");
    const screencapture = await executable("/usr/sbin/screencapture");
    return {
      platform: "darwin",
      adapter: "macos-native",
      available: osascript || screencapture,
      screenshot: screencapture,
      pointer: osascript,
      keyboard: osascript,
      scroll: osascript,
      inspect: osascript,
      elements: osascript,
      ocr: (await tesseract()) !== undefined,
      drag: osascript,
      coordinateSpaces: ["normalized", "pixel"],
      limitations: [
        "macOS Screen Recording permission is required for screenshots",
        "macOS Accessibility permission is required for input actions",
        "normalized coordinates currently target the main display",
        "inspect omits application and windowTitle without Accessibility permission",
      ],
    };
  }

  /**
   * Refuses to send keystrokes while secure input is held. `osascript` exits 0
   * either way, so without this the task verifies as a success that typed
   * nothing into a focused password field.
   *
   * Unconditional, and deliberately not a policy rule: it is not a restriction
   * MELRA imposes on the caller but a fact about where the events go, so
   * unhinged mode has nothing to lift here. An unobservable state is allowed
   * through — only a positive reading blocks.
   */
  private async assertInputLands(
    operation: ComputerOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    if ((await macSecureInput(operation.timeoutMs, signal)) === true) {
      throw new Error("computer_secure_input_active");
    }
  }

  async execute(
    operation: ComputerOperation,
    artifactDirectory: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    switch (operation.action) {
      case "capabilities":
        return { ...(await this.capabilities()) };
      case "screenshot": {
        await mkdir(artifactDirectory, { recursive: true });
        const path = join(
          artifactDirectory,
          `computer-${randomUUID()}.png`,
        );
        await run(
          "/usr/sbin/screencapture",
          ["-x", path],
          operation.timeoutMs,
          signal,
        );
        const bytes = await readFile(path);
        return {
          success: true,
          captured: true,
          path,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }
      case "inspect": {
        const { stdout } = await run(
          "/usr/bin/osascript",
          ["-l", "JavaScript", "-e", MACOS_INSPECT_SCRIPT],
          operation.timeoutMs,
          signal,
        );
        const secureInput = await macSecureInput(operation.timeoutMs, signal);
        return {
          success: true,
          action: "inspect",
          ...observationFrom(stdout),
          ...(secureInput === undefined ? {} : { secureInput }),
        };
      }
      case "click":
      case "move":
      case "drag":
        requirePoints(operation);
        await run(
          "/usr/bin/osascript",
          ["-l", "JavaScript", "-e", coordinateScript(operation)],
          operation.timeoutMs,
          signal,
        );
        return {
          success: true,
          action: operation.action,
          coordinateSpace: operation.coordinateSpace,
          x: operation.x,
          y: operation.y,
          ...(operation.action === "drag"
            ? { toX: operation.toX, toY: operation.toY }
            : {}),
        };
      case "type": {
        if (operation.text === undefined) {
          throw new Error("computer_type_requires_text");
        }
        await this.assertInputLands(operation, signal);
        await run(
          "/usr/bin/osascript",
          [
            "-e",
            "on run argv",
            "-e",
            "tell application \"System Events\" to keystroke (item 1 of argv)",
            "-e",
            "end run",
            "--",
            operation.text,
          ],
          operation.timeoutMs,
          signal,
        );
        return { success: true, action: "type", characters: operation.text.length };
      }
      case "key": {
        const key = operation.key?.toLocaleUpperCase();
        const keyCode = key === undefined ? undefined : ALLOWED_KEYS[key];
        if (keyCode === undefined) throw new Error("computer_key_not_allowed");
        await this.assertInputLands(operation, signal);
        await run(
          "/usr/bin/osascript",
          [
            "-e",
            `tell application "System Events" to key code ${keyCode}`,
          ],
          operation.timeoutMs,
          signal,
        );
        return { success: true, action: "key", key };
      }
      case "scroll": {
        const deltaY = Math.max(-2_000, Math.min(2_000, operation.deltaY ?? 0));
        const script = `
ObjC.import("CoreGraphics");
const event = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitPixel, 1, ${Math.round(deltaY)});
$.CGEventPost($.kCGHIDEventTap, event);
`;
        await run(
          "/usr/bin/osascript",
          ["-l", "JavaScript", "-e", script],
          operation.timeoutMs,
          signal,
        );
        return { success: true, action: "scroll", deltaY };
      }
    }
  }
}

class LinuxXdotoolAdapter implements ComputerAdapter {
  private async command(name: string): Promise<string | undefined> {
    for (const prefix of ["/usr/bin", "/bin", "/usr/local/bin"]) {
      const path = join(prefix, name);
      if (await executable(path)) return path;
    }
    return undefined;
  }

  async capabilities(): Promise<ComputerCapabilities> {
    const xdotool = await this.command("xdotool");
    const screenshot =
      (await this.command("gnome-screenshot")) ??
      (await this.command("scrot"));
    return {
      platform: "linux",
      adapter: "linux-xdotool",
      available: xdotool !== undefined || screenshot !== undefined,
      screenshot: screenshot !== undefined,
      pointer: xdotool !== undefined,
      keyboard: xdotool !== undefined,
      scroll: xdotool !== undefined,
      inspect: xdotool !== undefined,
      elements: false,
      // X11 has no accessibility tree, so reading the screen is the only way a
      // named target resolves here at all — not a fallback but the whole path.
      ocr: screenshot !== undefined && (await tesseract()) !== undefined,
      drag: xdotool !== undefined,
      coordinateSpaces: ["normalized", "pixel"],
      limitations: [
        "input actions require xdotool and an X11 session",
        "Wayland compositors may deny synthetic input",
        "normalized coordinates target the current display size reported by xdotool",
        "inspect cannot report secure input; X11 has no equivalent state",
        "X11 has no accessibility tree, so a named target is resolved by reading the screen: it needs tesseract installed and finds only text, never an unlabelled icon",
      ],
    };
  }

  private async xdotoolOutput(
    args: string[],
    operation: ComputerOperation,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }> {
    const executablePath = await this.command("xdotool");
    if (executablePath === undefined) throw new Error("computer_input_unavailable");
    return await run(executablePath, args, operation.timeoutMs, signal);
  }

  private async xdotool(
    args: string[],
    operation: ComputerOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.xdotoolOutput(args, operation, signal);
  }

  private async geometry(
    operation: ComputerOperation,
    signal?: AbortSignal,
  ): Promise<{ width: number; height: number }> {
    const { stdout } = await this.xdotoolOutput(
      ["getdisplaygeometry"],
      operation,
      signal,
    );
    const [width, height] = stdout.trim().split(/\s+/).map(Number);
    if (
      width === undefined ||
      height === undefined ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    ) {
      throw new Error("computer_display_geometry_unavailable");
    }
    return { width, height };
  }

  private async toPixels(
    operation: ComputerOperation,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    if (operation.coordinateSpace === "pixel") {
      return { x: Math.round(x), y: Math.round(y) };
    }
    const { width, height } = await this.geometry(operation, signal);
    return { x: Math.round(width * x), y: Math.round(height * y) };
  }

  private async coordinates(
    operation: ComputerOperation,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const point = requirePoints(operation);
    return await this.toPixels(operation, point.x, point.y, signal);
  }

  async execute(
    operation: ComputerOperation,
    artifactDirectory: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    switch (operation.action) {
      case "capabilities":
        return { ...(await this.capabilities()) };
      case "screenshot": {
        await mkdir(artifactDirectory, { recursive: true });
        const path = join(
          artifactDirectory,
          `computer-${randomUUID()}.png`,
        );
        const gnome = await this.command("gnome-screenshot");
        const scrot = await this.command("scrot");
        if (gnome !== undefined) {
          await run(gnome, ["-f", path], operation.timeoutMs, signal);
        } else if (scrot !== undefined) {
          await run(scrot, [path], operation.timeoutMs, signal);
        } else {
          throw new Error("computer_screenshot_unavailable");
        }
        const bytes = await readFile(path);
        return {
          success: true,
          captured: true,
          path,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }
      case "inspect": {
        const { width, height } = await this.geometry(operation, signal);
        const observation: DesktopObservation = {
          displayWidth: width,
          displayHeight: height,
        };
        // No active window is an ordinary state on a bare X session, and
        // `xdotool` exits non-zero for it, so a failure here means "nothing is
        // focused" rather than "inspect failed".
        try {
          const { stdout } = await this.xdotoolOutput(
            ["getactivewindow", "getwindowname"],
            operation,
            signal,
          );
          const title = stdout.trim();
          if (title !== "") observation.windowTitle = title;
        } catch {
          /* no focused window */
        }
        try {
          const { stdout } = await this.xdotoolOutput(
            ["getactivewindow", "getwindowpid"],
            operation,
            signal,
          );
          const pid = Number(stdout.trim());
          if (Number.isInteger(pid) && pid > 0) {
            const command = await readFile(`/proc/${pid}/comm`, "utf8");
            if (command.trim() !== "") observation.application = command.trim();
          }
        } catch {
          /* window belongs to a remote or exited process */
        }
        return { success: true, action: "inspect", ...observation };
      }
      case "click":
      case "move": {
        const point = await this.coordinates(operation, signal);
        const args = ["mousemove", String(point.x), String(point.y)];
        if (operation.action === "click") args.push("click", "1");
        await this.xdotool(args, operation, signal);
        return { success: true, action: operation.action, ...point };
      }
      case "drag": {
        const points = requirePoints(operation);
        // `requirePoints` guarantees this for a drag; repeated so the compiler
        // sees it too, and so a future caller cannot reach here without one.
        if (points.to === undefined) {
          throw new Error("computer_drag_requires_destination");
        }
        const from = await this.toPixels(operation, points.x, points.y, signal);
        const to = await this.toPixels(
          operation,
          points.to.x,
          points.to.y,
          signal,
        );
        await this.xdotool(
          [
            "mousemove",
            String(from.x),
            String(from.y),
            "mousedown",
            "1",
            "mousemove",
            String(to.x),
            String(to.y),
            "mouseup",
            "1",
          ],
          operation,
          signal,
        );
        return {
          success: true,
          action: "drag",
          x: from.x,
          y: from.y,
          toX: to.x,
          toY: to.y,
        };
      }
      case "type":
        if (operation.text === undefined) throw new Error("computer_type_requires_text");
        await this.xdotool(["type", "--", operation.text], operation, signal);
        return { success: true, action: "type", characters: operation.text.length };
      case "key": {
        const key = operation.key?.toLocaleUpperCase();
        const mapping: Record<string, string> = {
          ENTER: "Return",
          TAB: "Tab",
          SPACE: "space",
          BACKSPACE: "BackSpace",
          ESCAPE: "Escape",
          LEFT: "Left",
          RIGHT: "Right",
          DOWN: "Down",
          UP: "Up",
          HOME: "Home",
          END: "End",
          PAGEUP: "Page_Up",
          PAGEDOWN: "Page_Down",
          DELETE: "Delete",
        };
        if (key === undefined || mapping[key] === undefined) {
          throw new Error("computer_key_not_allowed");
        }
        await this.xdotool(["key", mapping[key]], operation, signal);
        return { success: true, action: "key", key };
      }
      case "scroll": {
        const clicks = Math.max(
          -20,
          Math.min(20, Math.round((operation.deltaY ?? 0) / 100)),
        );
        const button = clicks < 0 ? "4" : "5";
        for (let index = 0; index < Math.abs(clicks); index += 1) {
          await this.xdotool(["click", button], operation, signal);
        }
        return { success: true, action: "scroll", deltaY: operation.deltaY ?? 0 };
      }
    }
  }
}

/**
 * `SendKeys` reads `+^%~(){}[]` as modifiers and grouping rather than as
 * literal characters, so a password containing `+` types a Shift chord and a
 * `(` opens a group that never closes. Each one is wrapped in braces, which is
 * how `SendKeys` spells "the literal character".
 *
 * Exported because it is the part of the Windows adapter worth testing on any
 * platform: the escaping is pure, and getting it wrong silently corrupts typed
 * text rather than failing.
 */
export function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (character) => `{${character}}`);
}

/** `SendKeys` names for the fixed key allowlist. */
const WINDOWS_KEYS: Record<string, string> = {
  ENTER: "{ENTER}",
  TAB: "{TAB}",
  SPACE: " ",
  BACKSPACE: "{BACKSPACE}",
  ESCAPE: "{ESC}",
  LEFT: "{LEFT}",
  RIGHT: "{RIGHT}",
  DOWN: "{DOWN}",
  UP: "{UP}",
  HOME: "{HOME}",
  END: "{END}",
  PAGEUP: "{PGUP}",
  PAGEDOWN: "{PGDN}",
  DELETE: "{DELETE}",
};

/**
 * Pointer and wheel input, which .NET does not expose — `SetCursorPos` and
 * `mouse_event` have to be reached through P/Invoke.
 *
 * Reads its inputs from the environment rather than being interpolated with
 * them, so nothing a caller supplies is ever parsed as PowerShell.
 */
const WINDOWS_POINTER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MelraInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
}
'@
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($env:MELRA_NORMALIZED -eq '1') {
  $x = [int][Math]::Round($bounds.X + $bounds.Width * [double]$env:MELRA_X)
  $y = [int][Math]::Round($bounds.Y + $bounds.Height * [double]$env:MELRA_Y)
} else {
  $x = [int][Math]::Round([double]$env:MELRA_X)
  $y = [int][Math]::Round([double]$env:MELRA_Y)
}
if ($env:MELRA_MOVE -eq '1') { [void][MelraInput]::SetCursorPos($x, $y) }
if ($env:MELRA_CLICK -eq '1') {
  [MelraInput]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  [MelraInput]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
}
if ($env:MELRA_DRAG -eq '1') {
  if ($env:MELRA_NORMALIZED -eq '1') {
    $tx = [int][Math]::Round($bounds.X + $bounds.Width * [double]$env:MELRA_TO_X)
    $ty = [int][Math]::Round($bounds.Y + $bounds.Height * [double]$env:MELRA_TO_Y)
  } else {
    $tx = [int][Math]::Round([double]$env:MELRA_TO_X)
    $ty = [int][Math]::Round([double]$env:MELRA_TO_Y)
  }
  [MelraInput]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  # Controls track the motion between press and release; jumping straight to the
  # destination reads as a click, not a drag.
  for ($step = 1; $step -le 10; $step++) {
    [void][MelraInput]::SetCursorPos(
      [int][Math]::Round($x + ($tx - $x) * $step / 10),
      [int][Math]::Round($y + ($ty - $y) * $step / 10))
    Start-Sleep -Milliseconds 10
  }
  [MelraInput]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
}
if ($env:MELRA_WHEEL -ne $null -and $env:MELRA_WHEEL -ne '') {
  [MelraInput]::mouse_event(0x0800, 0, 0, [uint32][int]$env:MELRA_WHEEL, [IntPtr]::Zero)
}
# The press point, and for a drag the release point after it. Both come from
# here because only this script has seen the virtual desktop the caller's
# normalized coordinates resolve against.
Write-Output "$x $y $tx $ty".Trim()
`;

/**
 * Foreground window, its owning process, and the virtual desktop size, as JSON.
 *
 * `ConvertTo-Json` is given an ordered hashtable so the shape is fixed, and
 * `-Compress` keeps it to the single line the caller parses.
 */
const WINDOWS_INSPECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MelraWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
}
'@
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$out = [ordered]@{ displayWidth = $bounds.Width; displayHeight = $bounds.Height }
$window = [MelraWindow]::GetForegroundWindow()
if ($window -ne [IntPtr]::Zero) {
  $buffer = New-Object System.Text.StringBuilder 512
  [void][MelraWindow]::GetWindowTextW($window, $buffer, $buffer.Capacity)
  $out.windowTitle = $buffer.ToString()
  $processId = 0
  [void][MelraWindow]::GetWindowThreadProcessId($window, [ref]$processId)
  # The owning process can exit between the two calls, and a protected process
  # cannot be opened at all; either way the window is still worth reporting.
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process -ne $null) { $out.application = $process.ProcessName }
  # UIAutomationClient ships with the .NET Framework, so listing elements costs
  # no extra install. The walk is wrapped whole rather than per-element: unlike
  # the macOS accessibility API, a failure here is the provider refusing the
  # window outright, not one control going stale, and a half-list would be
  # indistinguishable from a window that really has three buttons.
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::IsControlElementProperty, $true)
    $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $elements = @()
    foreach ($node in $found) {
      if ($elements.Count -ge ${MAX_ELEMENTS}) { break }
      $rect = $node.Current.BoundingRectangle
      if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
      $entry = [ordered]@{
        role = $node.Current.ControlType.ProgrammaticName
        x = [int]$rect.X
        y = [int]$rect.Y
        width = [int]$rect.Width
        height = [int]$rect.Height
      }
      if ($node.Current.Name -ne '') { $entry.name = $node.Current.Name }
      $elements += $entry
    }
    # A single-element array unrolls to a bare object through ConvertTo-Json, so
    # the shape is forced back to a list before the caller ever sees it.
    $out.elements = @($elements)
  } catch {}
}
# The default depth of 2 stops inside the element list and renders each entry as
# a type name; 4 reaches every leaf the shape actually has.
Write-Output ($out | ConvertTo-Json -Compress -Depth 4)
`;

const WINDOWS_SCREENSHOT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size)
  $bitmap.Save($env:MELRA_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
`;

const WINDOWS_TYPE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait($env:MELRA_KEYS)
`;

/**
 * Windows computer use through Windows PowerShell and .NET.
 *
 * `capabilities` used to report `unavailable` here and every input action threw
 * a bare `computer_use_unavailable`, which is the whole of Windows computer use
 * being missing rather than degraded.
 *
 * PowerShell is in the terminal runtime's unconditional deny list, and stays
 * there: this is the trusted adapter invoking a fixed script it owns, the same
 * arrangement under which the macOS adapter uses `osascript`. Nothing a caller
 * supplies reaches the script as source — coordinates, wheel deltas, and text
 * arrive in the environment.
 */
class WindowsAdapter implements ComputerAdapter {
  private readonly powershell = join(
    process.env["SystemRoot"] ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

  async capabilities(): Promise<ComputerCapabilities> {
    // Windows PowerShell 5.1 ships with the OS, so this is present unless the
    // install has been trimmed. `pwsh` is deliberately not consulted: it is an
    // optional install and its absence is not the question being asked.
    const available = await executable(this.powershell);
    return {
      platform: "win32",
      adapter: "windows-powershell",
      available,
      screenshot: available,
      pointer: available,
      keyboard: available,
      scroll: available,
      inspect: available,
      elements: available,
      ocr: available && (await tesseract()) !== undefined,
      drag: available,
      coordinateSpaces: ["normalized", "pixel"],
      limitations: [
        ...(available
          ? []
          : ["Windows PowerShell was not found at the expected system path"]),
        "input is delivered to whichever window holds focus; focus is not verified",
        "SendKeys cannot type into a window running elevated unless this process is elevated too",
        "normalized coordinates span the whole virtual desktop, not one display",
        "per-monitor DPI scaling is not compensated for",
        "inspect cannot report secure input; Windows exposes no equivalent state",
        "every action pays PowerShell startup, and pointer/scroll additionally compile a P/Invoke shim, so raise timeoutMs above its 10s default on a slow or loaded machine",
      ],
    };
  }

  private async powershellScript(
    script: string,
    operation: ComputerOperation,
    env: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!(await executable(this.powershell))) {
      throw new Error("computer_input_unavailable");
    }
    const { stdout } = await run(
      this.powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      operation.timeoutMs,
      signal,
      env,
    );
    return stdout;
  }

  async execute(
    operation: ComputerOperation,
    artifactDirectory: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    switch (operation.action) {
      case "capabilities":
        return { ...(await this.capabilities()) };
      case "screenshot": {
        await mkdir(artifactDirectory, { recursive: true });
        const path = join(artifactDirectory, `computer-${randomUUID()}.png`);
        await this.powershellScript(
          WINDOWS_SCREENSHOT_SCRIPT,
          operation,
          { MELRA_PATH: path },
          signal,
        );
        const bytes = await readFile(path);
        return {
          success: true,
          captured: true,
          path,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }
      case "inspect": {
        const stdout = await this.powershellScript(
          WINDOWS_INSPECT_SCRIPT,
          operation,
          {},
          signal,
        );
        return { success: true, action: "inspect", ...observationFrom(stdout) };
      }
      case "click":
      case "move":
      case "drag": {
        const points = requirePoints(operation);
        const stdout = await this.powershellScript(
          WINDOWS_POINTER_SCRIPT,
          operation,
          {
            MELRA_X: String(points.x),
            MELRA_Y: String(points.y),
            MELRA_NORMALIZED: operation.coordinateSpace === "normalized" ? "1" : "0",
            MELRA_MOVE: "1",
            MELRA_CLICK: operation.action === "click" ? "1" : "0",
            MELRA_DRAG: points.to === undefined ? "0" : "1",
            MELRA_TO_X: String(points.to?.x ?? 0),
            MELRA_TO_Y: String(points.to?.y ?? 0),
            MELRA_WHEEL: "",
          },
          signal,
        );
        // The script resolves normalized coordinates against the virtual
        // desktop, so the pixel points it actually used are reported back rather
        // than recomputed here from a display size this process never saw.
        const [x, y, toX, toY] = stdout.trim().split(/\s+/).map(Number);
        if (
          x === undefined ||
          y === undefined ||
          !Number.isFinite(x) ||
          !Number.isFinite(y)
        ) {
          throw new Error("computer_display_geometry_unavailable");
        }
        if (
          points.to !== undefined &&
          (toX === undefined ||
            toY === undefined ||
            !Number.isFinite(toX) ||
            !Number.isFinite(toY))
        ) {
          throw new Error("computer_display_geometry_unavailable");
        }
        return {
          success: true,
          action: operation.action,
          coordinateSpace: operation.coordinateSpace,
          x,
          y,
          ...(points.to === undefined ? {} : { toX, toY }),
        };
      }
      case "type": {
        if (operation.text === undefined) {
          throw new Error("computer_type_requires_text");
        }
        await this.powershellScript(
          WINDOWS_TYPE_SCRIPT,
          operation,
          { MELRA_KEYS: escapeSendKeys(operation.text) },
          signal,
        );
        return { success: true, action: "type", characters: operation.text.length };
      }
      case "key": {
        const key = operation.key?.toLocaleUpperCase();
        const sequence = key === undefined ? undefined : WINDOWS_KEYS[key];
        if (sequence === undefined) throw new Error("computer_key_not_allowed");
        await this.powershellScript(
          WINDOWS_TYPE_SCRIPT,
          operation,
          { MELRA_KEYS: sequence },
          signal,
        );
        return { success: true, action: "key", key };
      }
      case "scroll": {
        const deltaY = operation.deltaY ?? 0;
        // One wheel notch is 120 units, and the sign is inverted against the
        // web convention: a positive `deltaY` scrolls the page down, which is a
        // negative wheel rotation.
        const notches = Math.max(-20, Math.min(20, Math.round(deltaY / 100)));
        // The wheel goes to the window under the cursor, so scroll positions it
        // first when told where — and leaves it alone when not, rather than
        // parking it at the origin and scrolling whatever happens to be there.
        const positioned = operation.x !== undefined && operation.y !== undefined;
        await this.powershellScript(
          WINDOWS_POINTER_SCRIPT,
          operation,
          {
            MELRA_X: String(operation.x ?? 0),
            MELRA_Y: String(operation.y ?? 0),
            MELRA_NORMALIZED: operation.coordinateSpace === "normalized" ? "1" : "0",
            MELRA_MOVE: positioned ? "1" : "0",
            MELRA_CLICK: "0",
            MELRA_WHEEL: String(-notches * 120),
          },
          signal,
        );
        return { success: true, action: "scroll", deltaY };
      }
    }
  }
}

class UnavailableAdapter implements ComputerAdapter {
  async capabilities(): Promise<ComputerCapabilities> {
    return {
      platform: process.platform,
      adapter: "unavailable",
      available: false,
      screenshot: false,
      pointer: false,
      keyboard: false,
      scroll: false,
      inspect: false,
      elements: false,
      ocr: false,
      drag: false,
      coordinateSpaces: ["normalized", "pixel"],
      limitations: ["no supported local computer-use adapter was detected"],
    };
  }

  async execute(operation: ComputerOperation): Promise<Record<string, unknown>> {
    if (operation.action === "capabilities") {
      return { ...(await this.capabilities()) };
    }
    throw new Error("computer_use_unavailable");
  }
}

/**
 * A recorded desktop: what the platform reported, frozen to a file.
 *
 * Steps are keyed by action rather than ordered, because the runtime issues
 * calls a caller never wrote — resolving a named `target` inspects first — and a
 * positional script would drift the moment that happened.
 */
export interface ComputerTrace {
  capabilities: ComputerCapabilities;
  steps: Record<string, Record<string, unknown>>;
}

/**
 * Replays a recorded desktop instead of touching the real one.
 *
 * Computer use is the one adapter whose evaluations cannot run honestly in CI:
 * asserting what a click does means either taking hold of the mouse on the
 * machine running the suite, or stopping at the approval and never testing what
 * happens after it. Replaying a recording exercises the whole path — resolution,
 * execution, verification, receipt — against a desktop that is identical on
 * every machine.
 *
 * An action the recording does not contain is refused rather than defaulted, so
 * a trace that has drifted from the scenario using it fails loudly.
 */
export class ReplayComputerAdapter implements ComputerAdapter {
  constructor(private readonly trace: ComputerTrace) {}

  async capabilities(): Promise<ComputerCapabilities> {
    return { ...this.trace.capabilities };
  }

  async execute(
    operation: ComputerOperation,
    _artifactDirectory: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted === true) throw new Error("task_cancelled");
    const step = this.trace.steps[operation.action];
    if (step === undefined) {
      throw new Error(`computer_trace_missing_step:${operation.action}`);
    }
    return { ...step };
  }
}

export function createSystemComputerAdapter(): ComputerAdapter {
  if (process.platform === "darwin") return new MacOsAdapter();
  if (process.platform === "linux") return new LinuxXdotoolAdapter();
  if (process.platform === "win32") return new WindowsAdapter();
  return new UnavailableAdapter();
}

export class ComputerRuntime {
  private readonly adapter: ComputerAdapter;

  constructor(private readonly options: ComputerRuntimeOptions) {
    this.adapter = options.adapter ?? createSystemComputerAdapter();
  }

  async execute(
    operation: ComputerOperation,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted === true) throw new Error("task_cancelled");
    const capabilities = await this.adapter.capabilities();
    if (operation.action === "capabilities") {
      return { ...capabilities };
    }
    if (!capabilities.available) {
      throw new Error("computer_use_unavailable");
    }
    const requiredCapability =
      operation.action === "screenshot"
        ? "screenshot"
        : operation.action === "inspect"
          ? "inspect"
          : operation.action === "drag"
            ? "drag"
            : operation.action === "click" || operation.action === "move"
              ? "pointer"
              : operation.action === "type" || operation.action === "key"
                ? "keyboard"
                : operation.action === "scroll"
                  ? "scroll"
                  : undefined;
    if (
      requiredCapability !== undefined &&
      !capabilities[requiredCapability]
    ) {
      throw new Error(`computer_${requiredCapability}_unavailable`);
    }
    if (operation.action === "inspect") {
      return await this.observe(operation, capabilities, signal);
    }
    const positional = ["click", "move", "drag"].includes(operation.action);
    let resolved: ComputerOperation = operation;
    let element: DesktopElement | undefined;
    if (operation.target !== undefined) {
      if (!positional) throw new Error("computer_target_not_positional");
      if (operation.x !== undefined || operation.y !== undefined) {
        throw new Error("computer_target_conflicts_with_coordinates");
      }
      if (!capabilities.elements && !capabilities.ocr) {
        throw new Error("computer_elements_unavailable");
      }
      element = matchElement(
        await this.elements(operation, capabilities, signal),
        operation.target,
      );
      const { target: _named, ...rest } = operation;
      resolved = {
        ...rest,
        // The tree measures in pixels, so a normalized request resolves into
        // pixel space rather than being scaled back into a fraction of a display
        // the element was never expressed against.
        coordinateSpace: "pixel",
        x: element.x + Math.floor(element.width / 2),
        y: element.y + Math.floor(element.height / 2),
      };
    }
    if (positional) {
      requirePoints(resolved);
    }
    if (resolved.coordinateSpace === "normalized") {
      // Every positional field shares one space, so the bound applies to the
      // drag destination as much as to the press point.
      const outOfRange = [
        resolved.x,
        resolved.y,
        resolved.toX,
        resolved.toY,
      ].some((value) => value !== undefined && value > 1);
      if (outOfRange) {
        throw new Error("computer_normalized_coordinates_out_of_range");
      }
    }
    const result = await this.adapter.execute(
      resolved,
      this.options.artifactDirectory,
      signal,
    );
    // The resolved element rides back on the result so a caller can verify what
    // was actually hit with `result_equals` on `element.name`, rather than
    // trusting that the name it asked for was the name that got clicked.
    return element === undefined ? result : { ...result, element };
  }

  /** The frontmost window's elements, or a refusal if the platform saw none. */
  private async elements(
    operation: ComputerOperation,
    capabilities: ComputerCapabilities,
    signal?: AbortSignal,
  ): Promise<DesktopElement[]> {
    const observed = await this.observe(operation, capabilities, signal);
    const elements = elementsFrom(observed["elements"]);
    if (elements === undefined || elements.length === 0) {
      throw new Error("computer_elements_unavailable");
    }
    return elements;
  }

  /**
   * An `inspect` observation, with words read off a screenshot when the platform
   * reported no element tree.
   *
   * The fallback lives here rather than in each adapter so all four inherit it,
   * and it only runs when the tree came back empty: a tree states what a control
   * *is*, while a reading only says what it looks like, so the tree wins
   * wherever there is one. Absence of a display width is a hard stop rather than
   * an assumed scale — without it there is nothing to map a Retina capture back
   * onto, and a wrong scale means a click that lands somewhere nobody named.
   */
  private async observe(
    operation: ComputerOperation,
    capabilities: ComputerCapabilities,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const observed = await this.adapter.execute(
      { ...operation, action: "inspect" },
      this.options.artifactDirectory,
      signal,
    );
    const reported = elementsFrom(observed["elements"]);
    if (reported !== undefined && reported.length > 0) return observed;
    if (!capabilities.ocr || !capabilities.screenshot) return observed;
    const displayWidth = observed["displayWidth"];
    if (typeof displayWidth !== "number") return observed;
    const read = await this.readScreen(operation, displayWidth, signal);
    return read.length === 0 ? observed : { ...observed, elements: read };
  }

  /** Takes a screenshot through the adapter and reads its words. */
  private async readScreen(
    operation: ComputerOperation,
    displayWidth: number,
    signal?: AbortSignal,
  ): Promise<DesktopElement[]> {
    const program = await tesseract();
    if (program === undefined) return [];
    const { target: _named, ...rest } = operation;
    const captured = await this.adapter.execute(
      { ...rest, action: "screenshot" },
      this.options.artifactDirectory,
      signal,
    );
    const path = captured["path"];
    if (typeof path !== "string") return [];
    const { stdout } = await run(
      program,
      [path, "stdout", "tsv"],
      operation.timeoutMs,
      signal,
    );
    return parseOcrElements(stdout, displayWidth);
  }
}
