// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  ElementHandle,
  Frame,
  JSHandle,
  Locator,
  Page,
  Route,
} from "playwright-core";
import type { BrowserOperation, BrowserTarget } from "@melra/protocol";
import { outcomeUnknown } from "@melra/protocol";
import { bounded, BrowserCallTimeoutError } from "./bounded.js";
import {
  connectBrowser,
  type BrowserConnection,
} from "./browser-connection.js";
import {
  assertSafeUrl,
  classifyOperation,
  type NetworkPolicy,
} from "@melra/policy-core";
import { startPinningProxy, type PinningProxy } from "./pinning-proxy.js";
import { buildSelector } from "./selector.js";
import { waitForStableDom } from "./stable-dom.js";

export interface BrowserRuntimeOptions extends NetworkPolicy {
  artifactDirectory: string;
  workspaceRoot: string;
  executablePath?: string;
  headless?: boolean;
  cdpEndpoint?: string;
  cdpContextIndex?: number;
  recordHarPath?: string;
  /**
   * HTTP archive every request is answered from, instead of the network.
   *
   * A request the archive does not hold is aborted rather than fetched: a
   * replay that quietly reaches the live web is not a replay, and the whole
   * point is that the same task run twice sees the same bytes. Nothing leaves
   * the machine while this is set, so the destination checks below never come
   * up — a recording made against an allowed host stays replayable after the
   * host is removed from the allowlist, because the host is no longer involved.
   */
  replayHarPath?: string;
  /**
   * Directory holding cookies, storage, and profile state between runs.
   *
   * Absent means a fresh throwaway profile per run, which is the safe default
   * and also why a logged-in site had to be logged into again on every task.
   */
  userDataDir?: string;
  /**
   * What to do with a window the page opens itself.
   *
   * `"block"` closes it and reports it, which is the honest default for an
   * unattended agent: a popup that steals focus is a page deciding what the
   * caller looks at next. `"allow"` keeps it as an addressable tab.
   */
  popups?: "allow" | "block";
  /**
   * Whether a path is one the browser may not upload or load, in any mode:
   * the data MELRA itself holds. The runtime passes the file runtime's check.
   */
  reserved?: (path: string) => Promise<boolean>;
}

/**
 * How many frames one page is searched across. Ad and analytics stacks attach
 * dozens; the interactive ones a caller cares about are always near the front.
 */
const MAX_FRAMES = 20;

/**
 * Whether a page call failed because its document went away under it, on
 * Playwright's own wording only: that comes before anything an error quotes,
 * and a quoted selector, the caller's, may say anything.
 */
const navigatedAway = (error: unknown): boolean =>
  error instanceof Error &&
  /execution context was destroyed|cannot find context with specified id|unable to adopt element handle|frame (?:was|has been|got) detached|in detached frame|not attached to the dom|interrupted by another navigation/i.test(
    error.message.split(/["'`]/)[0] ?? "",
  );

/** What a secret-field check found, and the frames it read. */
interface SecretCheck {
  state: "filled" | "clear" | "unknown";
  read: ReadonlySet<Frame>;
}

/**
 * Total elements one `inspect` reports. Each frame contributes at most 250
 * (the cap inside `collectFrame`), so the main document can never consume the
 * whole budget and leave a consent iframe unlisted.
 */
const MAX_ELEMENTS = 400;

/**
 * Dialogs recorded per action. A page can raise them in a loop, and the result
 * is persisted, so the report is bounded even though answering is not.
 */
const MAX_DIALOGS = 20;

/**
 * Popups recorded per action, bounded for the same reason as dialogs: a page
 * can open them in a loop and the report is persisted. Blocking still closes
 * every one of them, whether or not it fit in the report.
 */
const MAX_POPUPS = 20;

/** How often `waitForTarget` re-resolves the target across the frame list. */
const WAIT_POLL_MS = 100;

/**
 * How often `awaitOpenedWindows` rechecks while a window it knows about is
 * still unreported. Only ever spent when a window is actually pending.
 */
const WINDOW_POLL_MS = 25;

/**
 * Bound on the one-time wiring of a fresh context: the destination guard, HAR
 * replay, and the target-tracking session. Not the action's `timeoutMs`,
 * because loading a large replay archive is legitimately slower than a 100ms
 * action deadline, and this runs once per context rather than per action.
 */
const SETUP_TIMEOUT_MS = 30_000;

/**
 * Bound on each teardown call in `close()`. Shutdown has no action to take a
 * deadline from, and a browser that stopped answering must not keep the server
 * from exiting.
 */
const CLOSE_TIMEOUT_MS = 10_000;

/**
 * Frame URLs of the widgets that gate a page behind a human check.
 *
 * These are reported, never solved. Detecting one turns an opaque "click timed
 * out" into a caller-actionable "a captcha is in the way", which is the honest
 * outcome and the only one we will produce.
 */
const CAPTCHA_FRAMES: [RegExp, string][] = [
  [/^https?:\/\/(?:www\.)?(?:google\.com|recaptcha\.net)\/recaptcha\//, "recaptcha"],
  [/^https?:\/\/(?:[^/]+\.)?hcaptcha\.com\//, "hcaptcha"],
  [/^https?:\/\/challenges\.cloudflare\.com\//, "turnstile"],
  [/^https?:\/\/(?:[^/]+\.)?arkoselabs\.com\//, "arkose"],
];

/**
 * Name any human-verification widget embedded in the page.
 *
 * Returns nothing when the page is clear, so a normal snapshot is unchanged.
 */
export function captchaReport(frameUrls: string[]): Record<string, unknown> {
  const vendors = new Set<string>();
  for (const url of frameUrls) {
    for (const [pattern, vendor] of CAPTCHA_FRAMES) {
      if (pattern.test(url)) vendors.add(vendor);
    }
  }
  if (vendors.size === 0) return {};
  return {
    captcha: {
      present: true,
      vendors: [...vendors].sort(),
      // Stated in the payload rather than only in docs, because the caller
      // reading this is usually a model deciding whether to keep retrying.
      note: "A human-verification challenge is present. MELRA does not solve or bypass captchas; the page needs a human, a pre-authenticated session, or a different route.",
    },
  };
}

/**
 * Whether a Playwright action failed after its input had already been sent.
 *
 * A click's own timeout covers more than waiting for the element: after the
 * mouse events go out, Playwright still asks the page to stop its hit-target
 * check. When the click handler stalls the page, that request is what times
 * out — with the click already delivered. Playwright logs `performing <name>
 * action` immediately before dispatching, and the call log is part of the
 * error, so that line is Playwright's own record that the input left. Keyboard,
 * fill, select, and upload calls log no such line; their timeouts stay plain
 * failures, which for them is overwhelmingly a field that never became ready.
 *
 * Playwright paints the call log dim when colour is on (a TTY, FORCE_COLOR),
 * so each line can end in an escape code; those are stripped first. Without
 * that, a click delivered under colour read as never sent: a plain failure
 * where the outcome was unknown, seen first on the Windows CI runners.
 */
export function inputSent(error: unknown): boolean {
  return error instanceof Error && /^\s*- performing .+ action$/m.test(withoutColour(error.message));
}

/** The actions that send a page input, each pinned to the document it was checked on. */
const INPUT_ACTIONS: ReadonlySet<BrowserOperation["action"]> = new Set([
  "click",
  "type",
  "fill_form",
  "select",
  "press",
  "upload",
  "download",
]);

/** The actions that navigate the active page or send it input. */
const DRIVING_ACTIONS: ReadonlySet<BrowserOperation["action"]> = new Set([
  "navigate",
  "back",
  "forward",
  "reload",
  ...INPUT_ACTIONS,
]);

/** A Playwright wait, or one of ours, that ran out. */
const timedOut = (error: unknown): boolean =>
  error instanceof BrowserCallTimeoutError || (error instanceof Error && error.name === "TimeoutError");

/**
 * A wait that ran out at an action's deadline, named for the action's whole
 * `timeout`: whichever call held the last of it (a re-find's slice, a check
 * of the page, the input's own wait) is no measure of how long it waited.
 */
function ranOut(error: unknown, timeout: number): unknown {
  if (error instanceof Error && error.name === "TimeoutError") {
    error.message = error.message.replace(/Timeout \d+ms exceeded/, `Timeout ${timeout}ms exceeded`);
    return error;
  }
  return Object.assign(new Error(`Timeout ${timeout}ms exceeded.`), { name: "TimeoutError" });
}

/** Playwright's word for an element its document no longer holds. */
const detached = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("Element is not attached to the DOM");

/** How long a target found again is searched for before the page is asked whether it left. */
const REFIND_SLICE_MS = 500;

/** What a click waits for, short of the hit-target check only the click itself makes. */
const CLICKABLE = ["visible", "enabled", "stable"] as const;

/** The document an input action was checked against, and the address, if it named one. */
interface Pin {
  page: Page;
  document: JSHandle;
  address: string | undefined;
}

/** A URL without its fragment. */
function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/**
 * A URL as policy names a browser target, without query or fragment. Chrome
 * escapes two path characters Node's URL can keep raw: `|` on every Node, `^`
 * on Node 22. Both are escaped on both sides. Nothing is decoded: no two paths
 * a server tells apart compare equal, and no escape becomes a raw character in
 * a message. Exported for unit testing.
 */
export function pageAddress(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replaceAll("|", "%7C").replaceAll("^", "%5E");
  } catch {
    return url;
  }
}

/**
 * Whether this document, shadow roots included, has a secret field with
 * something in it. Passed to `evaluate`, so it must stand alone; the secret
 * test is the one `collectFrame` and `extract` use.
 */
function filledSecretField(): boolean {
  const secret = (field: Element): field is HTMLInputElement | HTMLTextAreaElement =>
    (field instanceof HTMLInputElement && field.type === "password") ||
    ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
      !["", "none"].includes(getComputedStyle(field).getPropertyValue("-webkit-text-security")));
  const roots: ParentNode[] = [document];
  while (roots.length > 0) {
    for (const element of roots.pop()!.querySelectorAll("*")) {
      if (element.shadowRoot !== null) roots.push(element.shadowRoot);
      // The markup counts as well as the live value: a target can match the
      // `value` attribute, or a textarea's text, after the field was cleared.
      if (secret(element) && (element.value !== "" || element.defaultValue !== "")) return true;
    }
  }
  return false;
}

/** Playwright's terminal colour codes, which mean nothing in a stored record. */
function withoutColour(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Collect the readable text and addressable elements of one frame.
 *
 * Module level rather than inline because it is now evaluated once per frame
 * instead of once per page. It runs inside the browser, so it may not close
 * over anything here.
 */
function collectFrame(limit: number) {
  const text = document.body?.innerText ?? "";
  // A field holding a secret: a password input, or one masked on screen with
  // CSS; one that shows its text is not hiding it. Kept in here: this function
  // runs in the page, where nothing outside it exists.
  const secret = (element: Element): boolean =>
    (element instanceof HTMLInputElement && element.type === "password") ||
    ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      !["", "none"].includes(getComputedStyle(element).getPropertyValue("-webkit-text-security")));
  /**
   * Walk up from the element recording the position of each ancestor, and
   * stop at the first one the page has labelled. The selector string is
   * assembled by the caller so the interesting part stays testable.
   */
  const describe = (element: Element) => {
    const chain: {
      tag: string;
      nth: number;
      id?: string;
      testId?: string;
    }[] = [];
    for (
      let node: Element | null = element;
      node !== null && chain.length < 12;
      node = node.parentElement
    ) {
      const parent: Element | null = node.parentElement;
      const id = node.id === "" ? undefined : node.id;
      const testId = node.getAttribute("data-testid") ?? undefined;
      chain.unshift({
        tag: node.tagName.toLowerCase(),
        nth:
          parent === null
            ? 1
            : Array.prototype.indexOf.call(parent.children, node) + 1,
        ...(id === undefined ? {} : { id }),
        ...(testId === undefined ? {} : { testId }),
      });
      if (id !== undefined || testId !== undefined) break;
    }
    return chain;
  };
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>(
      "a,button,input,select,textarea,[role],[tabindex]",
    ),
  )
    .filter((element) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0;
    })
    .slice(0, 250)
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      name:
        element.getAttribute("aria-label") ??
        element.getAttribute("alt") ??
        element.getAttribute("title") ??
        element.innerText?.trim().slice(0, 200) ??
        null,
      type: element.getAttribute("type"),
      // Everything below is what a caller needs to address the element it is
      // looking at. Without it a snapshot could be read but not acted on.
      chain: describe(element),
      id: element.id === "" ? null : element.id,
      testId: element.getAttribute("data-testid"),
      attributeName: element.getAttribute("name"),
      placeholder: element.getAttribute("placeholder"),
      href: element.getAttribute("href"),
      // Never a secret field's: in a browser someone else also types into,
      // that is their secret, and this is a read anything may ask for.
      value:
        (element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement) &&
        !secret(element)
          ? element.value.slice(0, 200)
          : null,
      disabled:
        element instanceof HTMLInputElement ||
        element instanceof HTMLButtonElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? element.disabled
          : null,
      checked:
        element instanceof HTMLInputElement ? element.checked : null,
    }));
  return {
    text: text.slice(0, limit),
    truncated: text.length > limit,
    elements,
  };
}

/**
 * The `<meta>` name of a page only an operator may act on: `melra console`
 * serves its approval page with it, and its CSP lets no script take it off.
 */
export const APPROVAL_SURFACE = "melra-approval-surface";

export class BrowserRuntime {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private activePage: Page | undefined;
  private connection: BrowserConnection | undefined;
  private proxy: PinningProxy | undefined;
  private routeHandler: ((route: Route) => Promise<void>) | undefined;
  /**
   * Dialogs raised since the last action reported, emptied when one does.
   *
   * One buffer on the runtime rather than one per page because the handler is
   * registered on the context, and because operations execute one at a time:
   * `execute` queues them, so a task owns its runtime for one action. A dialog
   * a page raised between actions is reported by the next one, marked
   * `betweenActions`, rather than dropped: the transfer a late `confirm()`
   * gated still went ahead, and the caller has to hear that it was asked.
   */
  private dialogs: Record<string, unknown>[] = [];
  /** Whether an action is running, so a dialog or popup can say when it came. */
  private acting = false;
  /** The tail of the action queue; see `execute`. */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * Windows the page opened during the action currently running, same lifetime
   * as `dialogs` and reported the same way.
   */
  private popups: Record<string, unknown>[] = [];
  /** Pending closes of blocked popups, awaited before the action reports. */
  private closing: Promise<unknown>[] = [];
  /**
   * The `newPage` call in flight while `openPage` opens a tab MELRA asked for:
   * the page it resolves to is that tab, not a window a site opened.
   */
  private opening: Promise<Page> | undefined;
  /** In a launched browser, pages handed over while `openPage`'s `newPage` is in flight, held until it settles. */
  private openingPagesQueue: Page[] | undefined = undefined;
  /**
   * The windows this runtime owns, by CDP target id: tabs it opened, and every
   * window one it owns or the tab it is driving opened. Decided when Chromium
   * creates the window, from the opener it names then: Playwright's `opener()`
   * comes later, and is null by then if the opener has closed. In a browser
   * this runtime is attached to, the rest belong to someone else, the
   * operator above all.
   *
   * ponytail: a tab a link opens with a modifier or middle click has no
   * opener at all, so between actions it counts as the operator's whichever
   * page clicked it, and while an action runs as the action's. A page's request for one (`Page.frameRequestedNavigation`)
   * cannot be tied to the tab that follows: a refused request leaves nothing
   * to match, and claiming the next opener-less tab would let a page have the
   * operator's tabs, a console's among them, closed. Closing that gap needs a
   * signal Chromium does not give.
   */
  private ownTargets = new Set<string>();
  /**
   * The active page's target id once this runtime has driven it, navigated it
   * or sent it input, since it became active. Until then it may be a tab of
   * the operator's the runtime only picked up, and what it opens is theirs.
   */
  private drivenTarget: string | undefined;
  /** Target ids already looked up; a page keeps its id across navigations. */
  private targetIds = new WeakMap<Page, string>();
  /**
   * Windows Chromium created while an action was running, with that action's
   * number: its popups, whenever Playwright gets round to handing them over.
   */
  private createdActing = new Map<string, number>();
  /**
   * The page targets of this context Chromium has announced and not yet
   * destroyed, the operator's among them, so an opener can be known for a tab
   * rather than, say, a frame of one.
   */
  private pageTargets = new Set<string>();
  /** The running action: what its page opens is the action's if it navigates the page or sends it input. */
  private action: BrowserOperation["action"] | undefined;
  /**
   * The target id of the page an action that navigates it or sends it input
   * acts on, in a browser this runtime is attached to, once looked up: what
   * it opens while the action runs is the action's, even if the runtime has
   * not driven it yet. A read leaves it out: like between actions, what a tab
   * the runtime only landed on opens while the runtime reads it is the
   * operator's, though the read's own calls into the page give it activation.
   */
  private actingTarget: string | undefined;
  /** Counts actions, so a popup reported by a later one says so. */
  private actions = 0;
  /** The page the running action acts on, once it has one. */
  private actingOn: Page | undefined;
  /** Whether the running action has sent its step back or forward. */
  private stepped = false;
  /**
   * Browser-level session that hears about a new window the moment Chromium
   * creates it, which is what lets an action wait for a popup it knows exists
   * instead of guessing how long one might take. Absent if the browser would
   * not grant one; popups are then reported on Playwright's timing alone.
   */
  private targets: CDPSession | undefined;
  /**
   * The windows an action's wait is owed, by CDP target id, with their browser
   * context: every page Chromium creates once tracking began, bar one that is
   * the operator's in a browser this runtime is attached to. A window leaves
   * when Playwright has handed it over and its id is looked up (`targetOf`),
   * or when it is destroyed, which for a blocked popup is the runtime's own
   * close. Those still owed when an action's wait ends, however it ends, or
   * when the action fails before it waits, are given up on: kept, one whose
   * first response never comes would hold every later action to its whole
   * timeout (#226). One handed over later stands in for no other window
   * (#234), and is reported by the action running then (`giveUpOwed`).
   * `popup`: whether it has an opener, as a page's window does and the
   * runtime's own tab does not.
   *
   * ponytail: a window a page opens between actions is owed to the next
   * action, so one that never loads still holds that action up once.
   */
  private owed = new Map<string, { context: string; popup: boolean }>();
  /** Popups given up on in block mode, by target id, with the timer that closes them (`giveUpOwed`). */
  private lapsing = new Map<string, ReturnType<typeof setTimeout>>();
  /** Popups those timers closed, until their targets are destroyed. */
  private lapsedIds = new Set<string>();
  /** Pages handed over closed and blank while one of those was closing: those popups. */
  private lapsedPages = new WeakSet<Page>();
  /** This context's id in CDP, resolved on first use and then fixed. */
  private contextId: string | undefined;
  /**
   * The running action's cancel signal and `timeoutMs`, read by `call`. Same
   * per-action lifetime as `dialogs`, set by `execute`.
   */
  private signal: AbortSignal | undefined;
  private callMs = 30_000;
  /**
   * Set once the running action's effect call has returned. From then on the
   * page may have acted on it, so a failure is no longer evidence that nothing
   * happened — see `execute`.
   */
  private dispatched = false;
  /** Set when the route refused reserved data during the running action. */
  private refusedReserved = false;

  constructor(private readonly options: BrowserRuntimeOptions) {}

  /**
   * Bound a Playwright call that takes no timeout of its own by the running
   * action's `timeoutMs` and cancel signal.
   *
   * `title()`, `evaluate()`, `count()`, `isVisible()`, `close()` and CDP
   * `send` all wait for the renderer or the browser to answer, and one that
   * stopped answering held the action until the task budget ran out — or
   * forever, where nothing armed one. Failing with `browser_call_timeout:<what>`
   * instead spends the budget on something that can still answer.
   */
  private call<T>(promise: Promise<T>, what: string, ms = this.callMs): Promise<T> {
    return bounded(promise, ms, what, this.signal);
  }

  private async uploadPaths(paths: string[]): Promise<string[]> {
    const root = await realpath(this.options.workspaceRoot);
    const resolved: string[] = [];
    for (const input of paths) {
      const candidate = resolve(root, input);
      const rel = relative(root, candidate);
      if (
        rel === ".." ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel)
      ) {
        throw new Error("browser_upload_outside_workspace");
      }
      // Before anything looks the name up, so a reserved name gets the same
      // answer whether it exists or not.
      if ((await this.options.reserved?.(candidate)) === true) throw new Error("browser_path_reserved");
      const actual = await realpath(candidate);
      const actualRelative = relative(root, actual);
      if (
        actualRelative === ".." ||
        actualRelative.startsWith(`..${sep}`) ||
        isAbsolute(actualRelative)
      ) {
        throw new Error("browser_upload_outside_workspace");
      }
      if ((await this.options.reserved?.(actual)) === true) throw new Error("browser_path_reserved");
      if (!(await stat(actual)).isFile()) {
        throw new Error("browser_upload_requires_regular_file");
      }
      resolved.push(actual);
    }
    return resolved;
  }

  /**
   * `assertSafeUrl`, and a file: URL naming reserved data is refused too. Only
   * unhinged mode lets a file: URL through the first, and the reserved data
   * stays out of reach there as it does for the file and terminal adapters.
   */
  private async assertAllowed(url: string): Promise<void> {
    await assertSafeUrl(url, this.options);
    if (this.options.reserved === undefined || !/^file:/i.test(url)) return;
    let path: string;
    try {
      path = fileURLToPath(url);
    } catch {
      throw new Error("browser_path_reserved");
    }
    if (await this.options.reserved(path)) throw new Error("browser_path_reserved");
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context !== undefined) return this.context;
    await mkdir(this.options.artifactDirectory, { recursive: true });
    if (this.options.recordHarPath !== undefined) {
      await mkdir(dirname(this.options.recordHarPath), { recursive: true });
    }
    if (this.options.replayHarPath !== undefined) {
      if (this.options.recordHarPath !== undefined) {
        // Recording a session that is itself a replay would write the archive
        // back out as though it had been observed.
        throw new Error("browser_har_replay_cannot_record");
      }
      if (this.options.cdpEndpoint !== undefined) {
        // The context belongs to whoever started the browser; rerouting its
        // traffic to a file would change a session MELRA does not own.
        throw new Error("browser_cdp_cannot_replay_har");
      }
      // Playwright treats a missing archive as an empty one and aborts every
      // request, which looks like a broken site rather than a wrong path.
      try {
        await access(this.options.replayHarPath, constants.R_OK);
      } catch {
        throw new Error("browser_har_replay_not_readable");
      }
    }
    // Unhinged mode asserts nothing about destinations, so pinning one would be
    // theatre. An attached CDP browser is already running and cannot be told to
    // start proxying, so the rebinding window stays open there and the option is
    // documented as the weaker path rather than silently equivalent. A replay
    // opens no sockets at all, so there is nothing to pin.
    // A context that closed (a crash, a closed window) or failed to start left
    // its proxy listening; a relaunch must not start a second one beside it.
    await this.proxy?.close().catch(() => undefined);
    this.proxy = undefined;
    const proxy =
      this.options.unhinged === true ||
      this.options.cdpEndpoint !== undefined ||
      this.options.replayHarPath !== undefined
        ? undefined
        : await startPinningProxy(this.options);
    this.proxy = proxy;
    const connection = await connectBrowser({
      ...(this.options.executablePath === undefined
        ? {}
        : { executablePath: this.options.executablePath }),
      headless: this.options.headless ?? true,
      ...(this.options.cdpEndpoint === undefined
        ? {}
        : { cdpEndpoint: this.options.cdpEndpoint }),
      ...(this.options.cdpContextIndex === undefined
        ? {}
        : { cdpContextIndex: this.options.cdpContextIndex }),
      ...(this.options.recordHarPath === undefined
        ? {}
        : { recordHarPath: this.options.recordHarPath }),
      ...(this.options.userDataDir === undefined
        ? {}
        : { userDataDir: this.options.userDataDir }),
      ...(proxy === undefined ? {} : { proxyServer: proxy.server }),
    });
    this.connection = connection;
    this.browser = connection.browser;
    this.context = connection.context;
    this.routeHandler = async (route) => {
      const requestUrl = route.request().url();
      if (
        requestUrl.startsWith("data:") ||
        requestUrl.startsWith("blob:") ||
        requestUrl.startsWith("about:")
      ) {
        await route.continue();
        return;
      }
      try {
        await this.assertAllowed(requestUrl);
        await route.continue();
      } catch (error) {
        if (this.acting && error instanceof Error && error.message === "browser_path_reserved") {
          this.refusedReserved = true;
        }
        await route.abort("blockedbyclient");
      }
    };
    try {
      await this.call(
        this.context.route("**/*", this.routeHandler),
        "route",
        SETUP_TIMEOUT_MS,
      );
      if (this.options.cdpEndpoint !== undefined && this.options.unhinged !== true) {
        // `route` never sees a WebSocket, so page script could open one to
        // any address. With a pinning proxy the proxy refuses it; an attached
        // browser has none, so the guard runs here.
        await this.call(
          this.context.routeWebSocket(
            () => true,
            async (socket) => {
              try {
                await assertSafeUrl(socket.url().replace(/^ws/i, "http"), this.options);
                socket.connectToServer();
              } catch {
                await socket.close({ code: 1008, reason: "destination blocked" });
              }
            },
          ),
          "route_websocket",
          SETUP_TIMEOUT_MS,
        );
      }
      if (this.options.replayHarPath !== undefined) {
        // Registered after the destination guard so it runs first: a replayed
        // request is served from the file and never becomes a socket, and
        // `notFound: "abort"` means a request the archive is missing fails
        // visibly rather than falling through to the network the guard would
        // have allowed.
        await this.call(
          this.context.routeFromHAR(this.options.replayHarPath, {
            notFound: "abort",
          }),
          "route_from_har",
          SETUP_TIMEOUT_MS,
        );
      }
    } catch (error) {
      // `this.context` is already set, so the next action would skip straight
      // past this method onto a context whose destination guard may never
      // have been installed. Tearing it down makes the next action start over.
      await this.close();
      throw error;
    }
    /**
     * Answer dialogs instead of letting Playwright discard them.
     *
     * With no handler registered Playwright dismisses every dialog, so a button
     * guarded by `confirm()` reported a successful click while the guarded work
     * never ran — a false success the verifier cannot catch, because the click
     * genuinely did succeed. `beforeunload` is the same defect pointed at
     * navigation and `prompt()` the same pointed at input.
     *
     * Accepting is the honest answer: the caller already approved the action
     * that raised the dialog, and the confirmation is part of that action, not
     * a second one. What makes it safe is that every dialog is reported back —
     * a caller is never told a page was changed without also being told what it
     * was asked. `prompt` accepts its own default rather than inventing a
     * value, since MELRA has nothing to say on the page's behalf.
     *
     * Registered on the context so tabs opened later are covered too.
     */
    this.context.on("dialog", (dialog) => {
      // Bounded because a page can raise dialogs in a loop; recording stops but
      // answering does not, since an unanswered dialog blocks the page forever.
      if (this.dialogs.length < MAX_DIALOGS) {
        this.dialogs.push({
          type: dialog.type(),
          message: dialog.message(),
          accepted: true,
          ...(dialog.type() === "prompt"
            ? { defaultValue: dialog.defaultValue() }
            : {}),
          ...(this.acting ? {} : { betweenActions: true }),
        });
      }
      // The page stays blocked until this settles, and a dialog belonging to a
      // page that closed first can no longer be answered — a rejection here
      // must not become the action's error.
      void dialog.accept().catch(() => undefined);
    });
    this.context.on("close", () => {
      this.context = undefined;
      this.activePage = undefined;
      this.drivenTarget = undefined;
    });
    /**
     * Report every window the page opened itself, and by default close it.
     *
     * Playwright keeps a popup as a live page nobody mentioned, so a click that
     * spawned an ad window returned plain success while a second window sat
     * there holding focus and a session. Reporting it is the point: a caller is
     * never told an action finished without also being told what the page opened
     * behind it. `assertSafeUrl` already governs where a popup may load from —
     * this governs whether it stays.
     */
    this.context.on("page", (opened) => {
      // One the runtime closed when its time ran out (`giveUpOwed`) is handed
      // over closed and blank just before its target is destroyed: told apart
      // now, while its id is still among those closing.
      if (this.lapsedIds.size > 0 && opened.isClosed() && opened.url() === "") this.lapsedPages.add(opened);
      const attached = this.options.cdpEndpoint !== undefined && this.targets !== undefined;
      // In a launched browser the tab `openPage` asked for and a popup handed
      // over in the same instant look alike until `newPage` says which is the
      // tab; `openPage` sorts them then.
      if (!attached && this.openingPagesQueue !== undefined) {
        this.openingPagesQueue.push(opened);
        return;
      }
      const opening = this.opening;
      if (opened === this.activePage && !attached) {
        this.release(opened);
        return;
      }
      const acting = this.acting;
      // `during`: whether the window came while an action ran, which in a
      // browser this runtime is attached to is known from when it was created.
      const adopt = (during = acting) => this.adopt(opened, during);
      // In a browser this runtime is attached to, a tab Chromium created
      // between its actions is the operator's (one they opened, a console
      // `melra console` opened) unless it is one of this runtime's
      // (`ownTargets`): that tab is left alone and not reported. Judged by when
      // it was created, not by when Playwright hands it over, which for a slow
      // first response can be during the next action.
      if (attached) {
        this.closing.push(
          (async () => {
            // The tab this runtime is opening is the page `newPage` resolves
            // to, and is not judged; any other window handed over in that
            // instant is judged like any other, by its id looked up now, while
            // it is still open: one that closes before `newPage` settles could
            // no longer be looked up, and would be taken for a popup.
            if (opening !== undefined) {
              const looked = this.targetOf(opened).catch(() => undefined);
              if (opened === (await opening.catch(() => undefined))) return;
              await looked;
            }
            const { adopt: yes, during } = await this.adoptable(opened, acting);
            return yes ? adopt(during) : undefined;
          })(),
        );
        return;
      }
      const closing = adopt();
      // A blocked popup stops being owed when its close destroys it; one left
      // open, once looked up.
      if (closing === undefined) this.release(opened);
      else this.closing.push(closing);
    });
    /**
     * Hear about new windows when Chromium creates them, not when Playwright
     * announces them.
     *
     * Playwright raises `page` for a popup only once the popup's first response
     * has committed, so a click whose window loaded slowly returned with no
     * `popups` field and the report — and, in block mode, the close — landed in
     * whatever ran next. Chromium creates the target synchronously inside
     * `window.open` or the `target=_blank` click, so `owed` is already complete
     * when the action finishes and `awaitOpenedWindows` knows which reports
     * are still owed. It sees every way of opening a window, and the page
     * cannot see or tamper with it, which an injected `window.open` hook could
     * not promise.
     */
    this.owed = new Map();
    this.forgetLapsing();
    this.contextId = undefined;
    this.ownTargets = new Set();
    this.drivenTarget = undefined;
    this.targetIds = new WeakMap();
    this.createdActing = new Map();
    this.pageTargets = new Set();
    // A session left from a context that closed under us would record into the
    // fresh map below and make every action wait for windows that never come.
    if (this.targets !== undefined) {
      await this.call(this.targets.detach(), "cdp_detach", SETUP_TIMEOUT_MS).catch(
        () => undefined,
      );
    }
    try {
      const targets = await this.call(
        connection.browser.newBrowserCDPSession(),
        "cdp_session",
        SETUP_TIMEOUT_MS,
      );
      // Set once Chromium has announced the windows that were already there:
      // those are no action's popups, and no window of theirs is the runtime's.
      let announced = false;
      targets.on("Target.targetCreated", ({ targetInfo }) => {
        // `browser_ui`, workers, and prerenders never become Playwright pages.
        if (targetInfo.type !== "page" || targetInfo.subtype !== undefined) return;
        this.pageTargets.add(targetInfo.targetId);
        const id = targetInfo.browserContextId ?? "";
        if (announced) {
          const opener = targetInfo.openerId;
          // A window an action's popup opens, before that popup is even judged,
          // is the runtime's like the popup.
          const runtimes = (target: string) =>
            this.ownTargets.has(target) ||
            target === this.drivenTarget ||
            target === this.actingTarget ||
            this.createdActing.has(target);
          // Between actions, a window is the operator's unless the runtime's
          // own tab opened it. While an action runs, it is that action's
          // popup unless it is plainly the operator's: one Chromium says an
          // operator's tab opened, or one with no opener that Chromium creates
          // blank or at one of its own pages (a client's new tab, a tab from
          // the toolbar), which no page can have the browser open. A page's
          // new tab starts out empty, and a window the browser opens for a
          // page (a sign-in window, say) starts at the provider's address, so
          // both stay the action's, and so does any page's activation: the
          // runtime's own calls into a page give it some. A frame's opener, or
          // a page's tab while the page a navigation or an input goes to is
          // not known yet, is the action's.
          const action = this.action;
          const theirs =
            this.options.cdpEndpoint !== undefined &&
            (this.acting
              ? opener === undefined
                ? targetInfo.url === "about:blank" || targetInfo.url.startsWith("chrome://")
                : !(action !== undefined && DRIVING_ACTIONS.has(action) && this.actingTarget === undefined) &&
                  this.pageTargets.has(opener) &&
                  !runtimes(opener)
              : opener === undefined || !runtimes(opener));
          // The operator's, which no action reports, so no wait is owed it.
          if (theirs) return;
          if (this.acting) this.createdActing.set(targetInfo.targetId, this.actions);
          else if (opener !== undefined && runtimes(opener)) this.ownTargets.add(targetInfo.targetId);
          this.owed.set(targetInfo.targetId, { context: id, popup: opener !== undefined });
        }
      });
      // Ids stay after their window closes: one that closes itself as soon as
      // it loads is still to be judged when Playwright hands it over.
      // ponytail: `ownTargets` keeps one id per window the runtime owned for
      // the context's life; prune once its `page` event is handled if that
      // ever matters.
      targets.on("Target.targetDestroyed", ({ targetId }) => {
        if (this.drivenTarget === targetId) this.drivenTarget = undefined;
        this.pageTargets.delete(targetId);
        this.owed.delete(targetId);
        clearTimeout(this.lapsing.get(targetId));
        this.lapsing.delete(targetId);
        this.lapsedIds.delete(targetId);
      });
      await this.call(
        targets.send("Target.setDiscoverTargets", { discover: true }),
        "cdp:Target.setDiscoverTargets",
        SETUP_TIMEOUT_MS,
      );
      // Chromium announces the windows that already exist before it replies.
      // Playwright had them before the `page` handler did, so none is owed.
      announced = true;
      this.targets = targets;
    } catch {
      this.targets = undefined;
    }
    return this.context;
  }

  /**
   * Hold the action's result while this context's windows are still owed
   * (`owed`), so the action that opened a window is the one that reports it.
   * A window stops being owed once it is handed over and looked up, or once it
   * is destroyed: in a launched browser a blocked popup when the runtime's
   * close lands and an allowed one when its lookup returns; in one this
   * runtime is attached to, every window once it is looked up to be judged;
   * and one destroyed before it is handed over, at once.
   *
   * Costs one round trip when nothing was opened. Waits only while a window is
   * owed, bounded by the action's own timeout: the window is part of what the
   * action did. One still owed after that is given up on, so no later action
   * waits for it, and is reported by the action running when Playwright
   * delivers it, if it ever does.
   */
  private async awaitOpenedWindows(timeoutMs: number): Promise<void> {
    const targets = this.targets;
    const context = this.context;
    if (targets === undefined || context === undefined) return;
    try {
      if (!(await this.learnContextId())) return;
      // Events arrive ahead of the reply on the same session, so after this
      // every window created before now is in `owed`.
      await this.call(targets.send("Browser.getVersion"), "cdp:Browser.getVersion");
      const contextId = this.contextId ?? "";
      const owed = () => [...this.owed.values()].some((window) => window.context === contextId);
      const deadline = Date.now() + timeoutMs;
      // A cancel ends the wait at once: what is still owed is given up below,
      // and the queue behind this action is not held to its deadline.
      while (owed() && Date.now() < deadline && this.signal?.aborted !== true) {
        await new Promise((done) => setTimeout(done, WINDOW_POLL_MS));
      }
    } catch {
      // The browser went away mid-action, or stopped answering within the
      // action's bound; either way nothing more will be delivered in time, and
      // this wait only ever decides which action reports a window, so it is
      // not worth failing an action over.
    } finally {
      // However the wait ended, what is still owed is no later action's to
      // wait for. Other contexts' windows go too: none is handed over here.
      this.giveUpOwed(timeoutMs);
    }
  }

  /**
   * Gives up on the windows still owed (`owed`). In block mode a popup among
   * them, which Playwright has not handed over to be closed, is closed by its
   * id once it has had as long again to load (#240). One that loads in that
   * time is handed over, reported with its address, and closed as any popup
   * is; one that never does is handed over closed, with no address, and
   * reported between actions (`adopt`). In a launched browser every window is
   * this runtime's; in one it is attached to, only a window of this context is
   * closed, checked when the timer fires. The context is known by then even
   * when the action giving up failed before its wait: any page looked up
   * tells it (`targetOf`), and an action that drives a page looks it up first.
   *
   * ponytail: "as long again" is the giving-up action's own `grace`
   * (its `timeoutMs`), not a setting; a window that loads later is closed
   * before it can be seen.
   */
  private giveUpOwed(grace: number): void {
    const targets = this.targets;
    const block = this.options.popups !== "allow" && this.options.unhinged !== true;
    for (const [targetId, window] of this.owed) {
      if (!block || targets === undefined || !window.popup) continue;
      const timer = setTimeout(() => {
        this.lapsing.delete(targetId);
        if (this.options.cdpEndpoint !== undefined && window.context !== this.contextId) return;
        this.lapsedIds.add(targetId);
        void targets.send("Target.closeTarget", { targetId }).catch(() => this.lapsedIds.delete(targetId));
      }, grace);
      // Nothing to close once the process is done with everything else.
      timer.unref();
      this.lapsing.set(targetId, timer);
    }
    this.owed.clear();
  }

  private forgetLapsing(): void {
    for (const timer of this.lapsing.values()) clearTimeout(timer);
    this.lapsing.clear();
    this.lapsedIds.clear();
  }

  /**
   * This context's id in CDP, looked up once: what owed windows are kept
   * under. False when there is no page yet to ask.
   */
  private async learnContextId(): Promise<boolean> {
    if (this.contextId !== undefined) return true;
    // A cancelled action does not open a session it would only abandon.
    if (this.signal?.aborted === true) return false;
    const page = this.context?.pages()[0];
    if (page === undefined) return false;
    const opening = page.context().newCDPSession(page);
    const session = await this.call(opening, "cdp_session").catch((error: unknown) => {
      // One that attaches after the bound or a cancel is let go, not left on the page.
      void opening.then((late) => late.detach()).catch(() => undefined);
      throw error;
    });
    try {
      const { targetInfo } = await this.call(session.send("Target.getTargetInfo"), "cdp:Target.getTargetInfo");
      this.contextId = targetInfo.browserContextId ?? "";
      return true;
    } finally {
      // Not waited for, as in `targetOf`: a detach waits on the page's main
      // thread, which a page busy with a long script holds.
      void session.detach().catch(() => undefined);
    }
  }

  /** A window handed over is owed by no wait once its id is known (`owed`). */
  private release(page: Page): void {
    if (this.targets !== undefined) void this.targetOf(page).catch(() => undefined);
  }

  /**
   * Reports a window a page opened and, in block mode, closes it. `during`:
   * whether it came while an action ran.
   */
  private adopt(opened: Page, during = this.acting): Promise<void> | undefined {
    // Closing a window the page opened is MELRA's judgement about what the
    // caller should be looking at, so unhinged mode drops it. Reporting it is
    // not a judgement — that stays on, like every other receipt.
    const allowed = this.options.popups === "allow" || this.options.unhinged === true;
    // One the runtime closed when its time ran out (`giveUpOwed`) came after
    // the action that opened it returned, whatever action runs by now.
    const lapsed = this.lapsedPages.has(opened);
    if (this.popups.length < MAX_POPUPS) {
      this.popups.push({
        // Without its fragment: a console opened by the operator carries its
        // one-time pairing code there until its first script runs.
        url: withoutFragment(opened.url()),
        blocked: !allowed,
        ...(during && !lapsed ? {} : { betweenActions: true }),
      });
    }
    if (allowed) return;
    // A popup that closed on its own, or whose opener navigated away first,
    // must not turn into the action's error.
    return opened.close().catch(() => undefined);
  }

  /**
   * Opens a page MELRA asked for, not one the site opened by itself.
   *
   * The popup handler cannot tell the two apart — both arrive as a `page`
   * event — so `opening` holds the `newPage` call that emits the event, and a
   * browser this runtime is attached to compares the page with what it
   * resolves to. A launched browser looks no window up as it is handed over,
   * so the handler queues every page it is handed then (#233), and they are
   * sorted here once `newPage` has said which one is the tab.
   */
  private async openPage(context: BrowserContext): Promise<Page> {
    const queued: Page[] = [];
    // Where the judgements of windows handed over from here on begin, in a
    // browser this runtime is attached to.
    const judged = this.closing.length;
    this.openingPagesQueue = queued;
    const opening = this.call(context.newPage(), "new_page");
    this.opening = opening;
    // Any page queued but the tab `newPage` returned is a window a page
    // opened. One that failed may still have handed over the tab it was
    // opening: Playwright does so just before it rejects, having closed it, so
    // a closed page queued last is taken for that tab.
    //
    // ponytail: a window a page opened that is handed over last and closed
    // itself already, during a `newPage` that fails, is taken for the tab and
    // not reported: a closed page can no longer be looked up by id.
    const sortQueued = (tab?: Page) => {
      this.opening = undefined;
      this.openingPagesQueue = undefined;
      const last = queued.at(-1);
      const mine = tab ?? (last?.isClosed() === true ? last : undefined);
      return queued.flatMap((page) => {
        const closing = page === mine ? undefined : this.adopt(page);
        if (closing === undefined) this.release(page);
        return closing ?? [];
      });
    };
    let opened: Page;
    try {
      opened = await opening;
    } catch (error) {
      // Their closes are waited for like any other.
      this.closing.push(...sortQueued());
      throw error;
    }
    // Closed before `tab_new` lists the tabs, so the list it returns does not
    // show a window the same result reports as closed: those queued here, and
    // those judged meanwhile in a browser this runtime is attached to, whose
    // judgement waits for `newPage`.
    await this.call(Promise.all([...sortQueued(opened), ...this.closing.slice(judged)]), "close_popup");
    if (this.options.cdpEndpoint !== undefined) this.ownTargets.add(await this.targetOf(opened));
    return opened;
  }

  /**
   * A page's CDP target id. Bounded on its own, not by the action's budget or
   * cancel: between actions those belong to an action that has finished.
   */
  private async targetOf(page: Page): Promise<string> {
    const known = this.targetIds.get(page);
    if (known !== undefined) return known;
    const session = await bounded(page.context().newCDPSession(page), SETUP_TIMEOUT_MS, "cdp_session");
    try {
      const { targetInfo } = await bounded(session.send("Target.getTargetInfo"), SETUP_TIMEOUT_MS, "cdp:Target.getTargetInfo");
      this.targetIds.set(page, targetInfo.targetId);
      // Handed over, since there is a page to ask: owed by no wait now.
      this.owed.delete(targetInfo.targetId);
      // Any page of this context also tells the context, if no action has yet.
      this.contextId ??= targetInfo.browserContextId ?? "";
      return targetInfo.targetId;
    } finally {
      // Not waited for: a detach waits on the page's main thread, which a
      // page busy with a long script holds for as long as it runs.
      void session.detach().catch(() => undefined);
    }
  }

  /**
   * Whether to treat a new window as this runtime's, in a browser it is
   * attached to: one created while an action ran, which then counts as the
   * runtime's for the windows it opens, or one of `ownTargets`. `during`
   * says whether the action reporting it is the one it came in; any other
   * reports it as between actions. Asked twice before giving up. One that
   * closed before it could be asked is reported, as everywhere else; that
   * one, and one still open that cannot be asked, count by when Playwright
   * handed it over.
   */
  private async adoptable(page: Page, acting: boolean): Promise<{ adopt: boolean; during: boolean }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const id = await this.targetOf(page);
        const createdIn = this.createdActing.get(id);
        if (createdIn === undefined) return { adopt: this.ownTargets.has(id), during: false };
        this.createdActing.delete(id);
        this.ownTargets.add(id);
        return { adopt: true, during: this.acting && createdIn === this.actions };
      } catch {
        if (page.isClosed()) return { adopt: true, during: acting };
      }
    }
    return { adopt: acting, during: acting };
  }

  /**
   * Makes `page` the one actions land on. It is not driven yet: it may be a
   * tab of the operator's the runtime only picked up, and what it opens stays
   * theirs until the runtime navigates it or sends it input (`drive`). The
   * page already active stays driven if it was.
   */
  private activate(page: Page | undefined): void {
    if (page !== this.activePage) this.drivenTarget = undefined;
    this.activePage = page;
  }

  /**
   * The runtime is navigating the active page or has sent it input, so from
   * here what that page opens is the runtime's, until another page is made
   * active. Not before: an action refused, or one whose target was never
   * found, leaves an operator's tab theirs.
   */
  private async drive(page: Page | undefined): Promise<void> {
    if (this.options.cdpEndpoint === undefined || page === undefined) return;
    const id = await this.targetOf(page);
    if (this.activePage === page) this.drivenTarget = id;
  }

  private async page(): Promise<Page> {
    const context = await this.ensureContext();
    if (this.activePage !== undefined && !this.activePage.isClosed()) {
      return this.activePage;
    }
    const page = context.pages()[0] ?? (await this.openPage(context));
    this.activate(page);
    return page;
  }

  /**
   * The tab list, with the index each entry can be addressed by.
   *
   * Returned by every tab action rather than only by `tabs`, because opening,
   * switching, and closing all renumber the list — a caller that had to issue a
   * separate `tabs` call after each one would be acting on a stale index.
   */
  private async describeTabs(
    context: BrowserContext,
  ): Promise<Record<string, unknown>[]> {
    return await Promise.all(
      context.pages().map(async (item, index) => ({
        index,
        url: item.url(),
        title: await this.call(item.title(), "title"),
        active: item === this.activePage,
      })),
    );
  }

  /**
   * Whether any frame of the page holds a filled secret field, and the frames
   * it read: a targeted read searches only those, so it never looks in a frame
   * this did not vouch for. Every frame, not the bounded set a snapshot reads:
   * a selector can enter any of them, including one that attached while the
   * others were being asked, so the list is read again until it stops growing.
   * "unknown" when some frame could not answer, which a read must not take for
   * "clear". The whole check takes at most `ms`.
   */
  private async secretFieldFilled(page: Page, ms = this.callMs): Promise<SecretCheck> {
    const deadline = Date.now() + ms;
    const asked = new Set<Frame>();
    const read = new Set<Frame>();
    let state: "clear" | "unknown" = "clear";
    for (let round = 0; round < 3; round += 1) {
      const fresh = page.frames().filter((frame) => !asked.has(frame));
      if (fresh.length === 0) return { state, read };
      for (const frame of fresh) asked.add(frame);
      const answers = await Promise.all(fresh.map((frame) => this.frameHoldsSecret(frame, deadline - Date.now())));
      if (answers.includes("filled")) return { state: "filled", read };
      if (answers.includes("unknown")) state = "unknown";
      fresh.forEach((frame, index) => answers[index] === "clear" && read.add(frame));
    }
    return { state: page.frames().some((frame) => !asked.has(frame)) ? "unknown" : state, read };
  }

  /** The frames a targeted read may search, or its refusal while a secret field is filled. */
  private async clearOfSecrets(page: Page): Promise<ReadonlySet<Frame>> {
    const secret = await this.secretFieldFilled(page);
    if (secret.state === "filled") throw new Error("browser_secret_field_filled");
    if (secret.state === "unknown") throw new Error("browser_secret_check_unavailable");
    return secret.read;
  }

  /**
   * A frame mid-navigation is asked again once its next document has loaded;
   * a detached one holds nothing. A frame with no document yet (a lazy or
   * still-loading iframe) that does not answer is "unread": it does not make
   * the page unknown, and a targeted read does not search it. A cancelled task
   * is not "unknown": it stops. Each frame is given at most `ms` in all, and
   * one that gets its document while being asked is asked again with what is
   * left, which is not one of its retries.
   */
  private async frameHoldsSecret(frame: Frame, ms = this.callMs): Promise<"filled" | "clear" | "unknown" | "unread"> {
    const deadline = Date.now() + ms;
    let retries = 0;
    while (retries < 3) {
      if (frame.isDetached()) return "clear";
      const documentless = frame.url() === "";
      const left = deadline - Date.now();
      if (left <= 0) break;
      try {
        const filled = await this.call(frame.evaluate(filledSecretField), "secret_check", documentless ? Math.min(left, 250) : left);
        return filled ? "filled" : "clear";
      } catch (error) {
        this.signal?.throwIfAborted();
        // Gone while being asked: whatever the error says, it holds nothing.
        if (frame.isDetached()) return "clear";
        if (documentless) {
          if (frame.url() === "") return "unread";
          continue;
        }
        if (!navigatedAway(error)) return "unknown";
        retries += 1;
        if (retries < 3) {
          await frame
            .waitForLoadState("domcontentloaded", { timeout: Math.max(1, Math.min(2_000, deadline - Date.now())) })
            .catch(() => undefined);
        }
      }
    }
    return frame.url() === "" ? "unread" : "unknown";
  }

  /**
   * The frames a target may live in, main frame first.
   *
   * Consent banners, cookie walls, payment fields, and captcha widgets are
   * almost always in an iframe, and `page.locator` only ever searched the main
   * document — so the element an agent could plainly see in a screenshot was
   * unaddressable, and the run died on an action timeout. Searching every frame
   * with the main one first keeps precise callers unaffected and makes the
   * embedded case work without a new field to pass.
   *
   * Ad and analytics pages can attach dozens of frames, so the list is bounded.
   */
  private frames(page: Page): Frame[] {
    return page.frames().slice(0, MAX_FRAMES);
  }

  /**
   * Every way the caller gave us to find the element, in the order we trust
   * them. Split out from `locator` because waiting and acting need the same
   * list but disagree about what to do when nothing matches yet.
   *
   * `within` starts a checked read only in the frames its check read; where a
   * match may end up is `readFirst`'s to judge.
   */
  private candidates(page: Page, target: BrowserTarget, within?: ReadonlySet<Frame>): Locator[] {
    return this.frames(page).filter((frame) => within?.has(frame) ?? true).flatMap((frame) => {
      const found: Locator[] = [];
      if (target.role !== undefined) {
        found.push(
          frame.getByRole(target.role as Parameters<Frame["getByRole"]>[0], {
            ...(target.name === undefined ? {} : { name: target.name }),
          }),
        );
      }
      if (target.selector !== undefined) found.push(frame.locator(target.selector));
      if (target.text !== undefined) {
        found.push(
          frame.getByText(target.text, { exact: true }),
          frame.getByText(target.text, { exact: false }),
        );
      }
      if (found.length === 0) {
        throw new Error("browser_target_requires_role_selector_or_text");
      }
      return found;
    });
  }

  /**
   * Resolve a target to a locator that actually matches something.
   *
   * Text matching used to be `exact: true` only, which fails on the whitespace,
   * casing, and nested-markup differences that real pages are full of — a button
   * rendered as `<button> Sign in </button>` never matched `"Sign in"`. Exact is
   * still tried first so a precise caller keeps precise behaviour; the substring
   * form is only consulted when exact found nothing.
   *
   * A target that matches nothing is reported as such instead of being handed to
   * Playwright to fail as an opaque action timeout thirty seconds later.
   *
   * Resolution only reads the page and always runs before an action's effect,
   * so a `count` that times out here fails a click or a fill cleanly: nothing
   * was sent, and `execute` does not report it as an unknown outcome.
   *
   */
  private async locator(
    page: Page,
    target: BrowserTarget | undefined,
  ): Promise<Locator> {
    if (target === undefined) throw new Error("browser_action_requires_target");
    for (const candidate of this.candidates(page, target)) {
      if ((await this.call(candidate.count(), "count")) > 0) return candidate;
    }
    throw new Error(
      `browser_target_not_found:${JSON.stringify(target)}`,
    );
  }

  /**
   * A candidate's first match, if its own document is one a secret check
   * read. A selector or role can lead from the frame it starts in to another,
   * so a checked read judges the element it would use, not the route to it:
   * a match anywhere else counts as none, and what it is makes no difference.
   */
  private async readFirst(candidate: Locator, within: ReadonlySet<Frame> | undefined): Promise<ElementHandle | undefined> {
    const pending = candidate.first().elementHandles();
    const [element] = await this.call(pending, "count").catch((error: unknown) => {
      // Released once it arrives, if it arrives after the bound or a cancel.
      void pending.then((late) => late.forEach((handle) => void handle.dispose().catch(() => undefined)), () => undefined);
      throw error;
    });
    if (element === undefined || within === undefined) return element;
    let kept = false;
    try {
      const frame = await this.call(element.ownerFrame(), "count");
      kept = frame !== null && within.has(frame);
      return kept ? element : undefined;
    } finally {
      if (!kept) await element.dispose().catch(() => undefined);
    }
  }

  /** `locator` for a checked read: the element itself, from the read frames. */
  private async readTarget(
    page: Page,
    target: BrowserTarget | undefined,
    within: ReadonlySet<Frame> | undefined,
  ): Promise<ElementHandle> {
    if (target === undefined) throw new Error("browser_action_requires_target");
    for (const candidate of this.candidates(page, target, within)) {
      const element = await this.readFirst(candidate, within);
      if (element !== undefined) return element;
    }
    throw new Error(`browser_target_not_found:${JSON.stringify(target)}`);
  }

  /**
   * Wait for a target to reach a state, re-resolving it on every poll.
   *
   * Playwright's own `waitFor` is bound to one frame decided up front, which is
   * exactly wrong here: the consent iframe or captcha widget being waited for
   * usually does not exist yet when the wait starts. Re-reading `page.frames()`
   * each round costs a poll interval of latency and covers the frame that
   * appears halfway through.
   *
   * `visible` and `attached` are satisfied by any one candidate; `hidden` and
   * `detached` must hold for all of them. Fanning out across frames makes that
   * distinction load-bearing — most frames never contain the target, so "some
   * candidate is absent" is true from the first poll and would report a banner
   * as dismissed while it is still on screen.
   */
  private async waitForTarget(
    page: Page,
    target: BrowserTarget,
    state: NonNullable<BrowserOperation["state"]>,
    timeoutMs: number,
  ): Promise<void> {
    const negated = state === "hidden" || state === "detached";
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // Asked on every poll: someone can fill a secret field while this waits.
      // A poll that finds one filled, or cannot tell, looks for nothing and
      // waits for the next one: a login form stays filled while it signs in.
      // The question gets what is left of the wait, but at least a second, so
      // the last poll is not starved into "unknown".
      this.signal?.throwIfAborted();
      const secret = await this.secretFieldFilled(page, Math.max(1_000, deadline - Date.now()));
      let reached = negated && secret.state === "clear";
      for (const candidate of secret.state === "clear" ? this.candidates(page, target, secret.read) : []) {
        // Absence is an answer here: it satisfies `hidden` and `detached`. A
        // document that went away mid-poll is not: the poll decides nothing.
        let present: boolean | undefined;
        try {
          const element = await this.readFirst(candidate, secret.read);
          try {
            if (element === undefined) present = false;
            else if (state === "attached" || state === "detached") present = true;
            else if (await this.call(element.isVisible(), "is_visible")) present = true;
            // isVisible() also answers false for an element whose document went
            // away, so a false counts only for one still in its document.
            else present = (await this.call(element.evaluate((node) => node.isConnected), "is_visible")) ? false : undefined;
          } finally {
            await element?.dispose().catch(() => undefined);
          }
        } catch (error) {
          if (!navigatedAway(error)) {
            // A search that failed outright is answered like any other: the
            // check after it wins over what it met.
            const after = (await this.secretFieldFilled(page, Math.max(1_000, deadline - Date.now()))).state;
            if (after === "filled") throw new Error("browser_secret_field_filled");
            if (after === "unknown") throw new Error("browser_secret_check_unavailable");
            throw error;
          }
        }
        if (present === undefined) {
          reached = false;
          break;
        }
        if (negated) {
          if (present) {
            reached = false;
            break;
          }
        } else if (present) {
          reached = true;
          break;
        }
      }
      // What a poll found, or did not, counts only if no field was filled
      // while it looked: every poll that searched is checked again after.
      let last = secret.state;
      if (secret.state === "clear") {
        last = (await this.secretFieldFilled(page, Math.max(1_000, deadline - Date.now()))).state;
        if (reached && last === "clear") return;
      }
      if (Date.now() >= deadline) {
        // Not the target's fault when the last poll could not look for it,
        // or could not vouch for what it saw.
        if (last === "filled") throw new Error("browser_secret_field_filled");
        if (last === "unknown") throw new Error("browser_secret_check_unavailable");
        throw new Error(
          `browser_wait_timeout:${state}:${JSON.stringify(target)}`,
        );
      }
      await page.waitForTimeout(WAIT_POLL_MS);
    }
  }

  /**
   * Type by pressing keys rather than by assigning the value.
   *
   * `.fill()` sets the field and fires a single `input` event. Anything that
   * listens for keystrokes never sees the text: React inputs with key handlers,
   * autocomplete dropdowns, comboboxes that filter as you type, and fields that
   * enable a submit button only after a `keyup`. The old server used
   * `page.type`, and losing that is most of why typing "stopped working".
   * `.fill("")` is still how the field gets cleared, because it empties one
   * reliably no matter what is in it.
   */
  private async typeInto(pin: Pin, locator: Locator, value: string, operation: BrowserOperation): Promise<void> {
    const ready = operation.clearFirst ? (["visible", "editable"] as const) : (["visible"] as const);
    await this.actOn(pin, locator, operation.timeoutMs, async (field, timeout) => {
      if (operation.clearFirst) {
        await field.fill("", { timeout });
        this.dispatched = true;
      }
      // Found first, then counted as sent before the first key: typing is one
      // key per round trip, so a deadline can land after some keys (an Enter
      // among them) reached the page, and that is not "nothing happened".
      await field.waitForElementState("visible", { timeout });
      this.dispatched = true;
      // Focused as `pressSequentially` focuses it (typing nothing does just
      // that), then typed as it types, one key at a time, each only while the
      // page is still the checked document: keys go wherever focus is, so a
      // page that navigates midway would otherwise get the rest. Its address
      // was checked before the first input; a page may rewrite its own path as
      // it is typed into. Once the keys start, nothing here fails on the field
      // going away.
      await field.type("", { timeout });
      // The value gets the whole timeout once typing starts, as
      // `pressSequentially` gave it; a key still going then is not waited for.
      // A new document shows up as Playwright's `framenavigated` for the main
      // frame, which costs no round trip, so the document is asked about only
      // then (a page rewriting its own path raises it too): asking before
      // every key halved how fast a long value went in.
      const deadline = Date.now() + operation.timeoutMs;
      let navigated = false;
      const onNavigated = (frame: Frame) => {
        if (frame === pin.page.mainFrame()) navigated = true;
      };
      pin.page.on("framenavigated", onNavigated);
      try {
        for (const character of value) {
          const left = deadline - Date.now();
          if (left <= 0) throw new BrowserCallTimeoutError("type");
          if (navigated) {
            navigated = false;
            if (await this.moved(pin, false, left)) throw new Error("browser_page_changed");
          }
          await this.call(pin.page.keyboard.type(character, { delay: operation.delayMs }), "type", Math.max(1, deadline - Date.now()));
        }
      } finally {
        pin.page.off("framenavigated", onNavigated);
      }
      this.dispatched = true;
    }, ready);
  }

  /**
   * An input action on its target's element, held to the documents it was
   * checked on: the page's, and the one the target was first found in, which
   * for a target inside a frame is that frame's. The input goes through the
   * element, which a navigation takes away, so a page or frame that navigates
   * itself while the action waits (for the element to show, say) fails the
   * action rather than having the target found, and acted on, in the new
   * document. The target is found again only in the document it was found
   * in, and only before any input reached it.
   *
   * The element is first waited for as the action would wait (`ready`: the
   * states named, which sends the page nothing), so the check after that is
   * the last thing before the input, the address it named included. Once the
   * action has sent input (an earlier field of a form, say), only its
   * document is held: a page may rewrite its own path in answer, as it may
   * while it is typed into. A target found again after a re-render is not
   * waited for twice, so one re-rendered faster than that can still be hit.
   * Whatever runs out is reported as the action's `timeout` running out
   * (`ranOut`).
   *
   * ponytail: Playwright's own hit-target check and dispatch come after this,
   * so a navigation that commits in that instant can still receive the one
   * click or key; closing it needs input that names its document, which CDP
   * lacks.
   */
  private async actOn<T>(
    pin: Pin,
    locator: Locator,
    timeout: number,
    act: (element: ElementHandle, timeout: number) => Promise<T>,
    ready: readonly ("visible" | "enabled" | "editable" | "stable")[] = [],
  ): Promise<T> {
    const deadline = Date.now() + timeout;
    const left = () => Math.max(1, deadline - Date.now());
    let found: JSHandle | undefined;
    try {
      for (;;) {
        const element =
          found === undefined
            ? // Bounded by its own timeout; the call only adds the cancel.
              await this.handle(locator.first().elementHandle({ timeout: left() }), "count", Infinity)
            : await this.refind(pin, locator, found, deadline);
        try {
          let moved: boolean;
          if (found === undefined) {
            found = await this.handle(element.evaluateHandle((node) => node.ownerDocument), "evaluate", left());
            for (const state of ready) await element.waitForElementState(state, { timeout: left() });
            moved = await this.moved(pin, !this.dispatched, left());
          } else {
            const same = await this.call(element.evaluate((node, first) => node.ownerDocument === first, found), "evaluate", left()).catch(
              (error: unknown) => {
                // No answer is not a different document.
                if (timedOut(error) || this.signal?.aborted === true) throw error;
                return false;
              },
            );
            if (!same) {
              throw new Error("browser_page_changed: the target's frame is now at another document");
            }
            // Still in the document it was found in, so the page has not
            // navigated either: a navigation takes its frames' documents with
            // it. Only the address is left, and that needs no round trip.
            moved = !this.dispatched && pin.address !== undefined && pageAddress(pin.page.url()) !== pin.address;
          }
          if (!moved) return await act(element, left());
        } catch (error) {
          // Replaced below, so what `execute` reads from it is kept here.
          if (inputSent(error)) this.dispatched = true;
          // A wait that ran out is the answer; the page is not asked again.
          if (timedOut(error) || Date.now() >= deadline) throw error;
          if (!(await this.moved(pin, !this.dispatched, left()))) {
            // Re-rendered, or its frame reloaded, while the page stayed: found
            // again, as Playwright's own locator would, in the same document
            // or not at all, which the next pass checks before it acts. That
            // holds even after Playwright logged the click as performed: its
            // hit-target guard stops the events that did not reach the
            // element, which is why its locator retries this too. The page is
            // asked first every time, so one that navigated is refused at
            // once, one that leaves while the target is searched for again
            // within a slice, and a target first found in a document that
            // came in after the checks is never acted on.
            if (detached(error)) continue;
            throw error;
          }
        } finally {
          await element.dispose().catch(() => undefined);
        }
        throw new Error(`browser_page_changed: the page is now at ${pageAddress(pin.page.url())}`);
      }
    } catch (error) {
      // Every bound in here is the action's deadline (typing's, which starts
      // later, is as long), so whatever timed out ran out the action's time.
      // Not read off the clock: a 1 ms bound can fire just before it ticks.
      if (timedOut(error)) throw ranOut(error, timeout);
      throw error;
    } finally {
      void found?.dispose().catch(() => undefined);
    }
  }

  /**
   * The target found again after it went away, searched for in slices that
   * each end by asking whether the page, or the document it was first found
   * in (a frame's), has left: a page that takes the target away and then
   * navigates to a document without it would otherwise be waited on until
   * the timeout. A slice cut short, by a frame detaching as the page around
   * it leaves, is asked about the same way.
   */
  private async refind(pin: Pin, locator: Locator, found: JSHandle, deadline: number): Promise<ElementHandle> {
    const left = () => Math.max(1, deadline - Date.now());
    for (;;) {
      let failure: unknown;
      try {
        return await this.handle(locator.first().elementHandle({ timeout: Math.min(REFIND_SLICE_MS, left()) }), "count", Infinity);
      } catch (error) {
        // A cancel, or a page that closed, has its own error.
        if (this.signal?.aborted === true || pin.page.isClosed()) throw error;
        failure = error;
      }
      if (Date.now() >= deadline) throw failure;
      if (await this.moved(pin, !this.dispatched, left())) {
        throw new Error(`browser_page_changed: the page is now at ${pageAddress(pin.page.url())}`);
      }
      const there = await this.call(found.evaluate((first: Document) => first.defaultView?.document === first), "evaluate", left()).catch(
        (error: unknown) => {
          // No answer is not a different document, and a closed page has its own error.
          if (timedOut(error) || this.signal?.aborted === true || pin.page.isClosed()) throw error;
          return false;
        },
      );
      if (!there) throw new Error("browser_page_changed: the target's frame has left the document it was found in");
      if (!timedOut(failure)) throw failure;
    }
  }

  /** `call` for a handle: one that arrives after the bound or a cancel is released, not left in the page. */
  private handle<H extends JSHandle>(pending: Promise<H>, what: string, ms?: number): Promise<H> {
    return this.call(pending, what, ms).catch((error: unknown) => {
      void pending.then(
        (late) => late.dispose().catch(() => undefined),
        () => undefined,
      );
      throw error;
    });
  }

  /**
   * Whether the page has left the document an input action was checked on,
   * or, with `address`, the address it named. A navigation destroys the old
   * document's context, so asking its handle fails. A call that timed out or
   * was cancelled is no answer either way and is passed on, and a closed page
   * has not moved anywhere: the action's own error says what happened.
   */
  private async moved(pin: Pin, address = true, ms = this.callMs): Promise<boolean> {
    if (pin.page.isClosed()) return false;
    if (address && pin.address !== undefined && pageAddress(pin.page.url()) !== pin.address) return true;
    try {
      return !(await this.call(pin.document.evaluate((checked) => checked === document), "evaluate", ms));
    } catch (error) {
      if (error instanceof BrowserCallTimeoutError || this.signal?.aborted === true) throw error;
      return true;
    }
  }

  /**
   * An attached CDP browser has no pinning proxy, and Chromium follows a
   * redirect without showing the hop to the route guard, so an allowed page
   * that redirects to 169.254.169.254 or a LAN address loads there. The request
   * cannot be stopped from here; what can be is reading it back. A page whose
   * address the guard refuses is blanked and the action fails, and a frame
   * the guard refuses is left out.
   */
  private async refusedFrames(page: Page, frames: Frame[]): Promise<Set<Frame>> {
    const refused = new Set<Frame>();
    if (this.options.cdpEndpoint === undefined || this.options.unhinged === true) return refused;
    for (const frame of frames) {
      const url = frame.url();
      if (!/^https?:/i.test(url)) continue;
      try {
        await assertSafeUrl(url, this.options);
      } catch (error) {
        if (frame !== page.mainFrame()) {
          refused.add(frame);
          continue;
        }
        await page.goto("about:blank").catch(() => undefined);
        throw error;
      }
    }
    return refused;
  }

  private async snapshot(page: Page, maxChars: number): Promise<Record<string, unknown>> {
    const all = this.frames(page);
    const refused = await this.refusedFrames(page, all);
    const frames = all.filter((frame) => !refused.has(frame));
    const collected = await Promise.all(
      frames.map(async (frame, index) => {
        try {
          return await this.call(frame.evaluate(collectFrame, maxChars), "evaluate");
        } catch (error) {
          // The main document not answering is a failed inspect: reporting it
          // as empty would hand back a plausible snapshot of nothing.
          if (index === 0 && error instanceof BrowserCallTimeoutError) throw error;
          // A frame that navigated or detached mid-evaluate is not a failed
          // inspect. Losing an ad frame should not lose the page, and neither
          // should one whose out-of-process renderer stopped answering.
          return undefined;
        }
      }),
    );
    const main = collected[0];
    const elements = collected
      .flatMap((data, frameIndex) =>
        (data?.elements ?? []).map(({ chain, ...element }) => ({
          ...element,
          selector: buildSelector(chain),
          // Which document the element lives in. `null` is the main one; a
          // caller does not need this to act (targets are resolved across every
          // frame) but it explains why an element is not in the page text.
          frame: frameIndex === 0 ? null : (frames[frameIndex]?.url() ?? null),
        })),
      )
      .slice(0, MAX_ELEMENTS)
      // Numbered after flattening: a per-frame index would repeat across
      // frames, and this one is only ever a handle on the returned list.
      .map((element, index) => ({ index, ...element }));
    return {
      url: page.url(),
      title: await this.call(page.title(), "title"),
      text: main?.text ?? "",
      truncated: main?.truncated ?? false,
      elements,
      ...captchaReport(frames.map((frame) => frame.url())),
      untrustedContent: true,
    };
  }

  /**
   * Read one element rather than the whole page.
   *
   * The old server had `extract_text` and `extract_html`; both were dropped, so
   * a caller wanting one table out of a large document had to take the entire
   * page text and cut it up itself. `inspect` already accepts a target, so
   * scoping it needs no new action.
   */
  private async extract(
    page: Page,
    operation: BrowserOperation,
    within: ReadonlySet<Frame> | undefined,
  ): Promise<Record<string, unknown>> {
    const element = await this.readTarget(page, operation.target, within);
    const [text, html] = await Promise.all([
      this.call(element.innerText(), "inner_text", operation.timeoutMs),
      // From a copy with secret fields emptied: frameworks such as React
      // mirror what is typed into the `value` attribute, which markup carries.
      this.call(element.evaluate(
        (node) => {
          const element = node as Element;
          const secret = (field: Element): boolean =>
            (field instanceof HTMLInputElement && field.type === "password") ||
            ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
              !["", "none"].includes(getComputedStyle(field).getPropertyValue("-webkit-text-security")));
          // The target itself too: a secret textarea's markup is its content.
          const live = [element, ...element.querySelectorAll("input, textarea")];
          const copy = element.cloneNode(true) as Element;
          const copies = [copy, ...copy.querySelectorAll("input, textarea")];
          live.forEach((field, index) => {
            if (!secret(field)) return;
            copies[index]!.removeAttribute("value");
            copies[index]!.textContent = "";
          });
          return copy.innerHTML;
        },
      ), "evaluate", operation.timeoutMs),
    ]).finally(() => element.dispose().catch(() => undefined));
    return {
      url: page.url(),
      title: await this.call(page.title(), "title"),
      target: operation.target,
      text: text.slice(0, operation.maxChars),
      html: html.slice(0, operation.maxChars),
      truncated:
        text.length > operation.maxChars || html.length > operation.maxChars,
      untrustedContent: true,
    };
  }

  private async settledSnapshot(
    page: Page,
    operation: BrowserOperation,
  ): Promise<Record<string, unknown>> {
    // Bounded by its own `settleTimeoutMs` plus a grace, not by `timeoutMs`:
    // the settle window is a deliberate wait and must not be cut short.
    const settle = await waitForStableDom(
      page,
      {
        quietWindowMs: operation.settleQuietMs,
        timeoutMs: operation.settleTimeoutMs,
      },
      this.signal,
    );
    return {
      settle,
      ...(await this.snapshot(page, operation.maxChars)),
    };
  }

  /**
   * One action at a time, in arrival order. A single runtime serves every task,
   * and a parallel workflow node or two concurrent MCP calls used to run here
   * at once: the second reset the first's cancel signal, timeout and
   * `dispatched` flag mid-flight, so a click that landed was reported as a
   * plain failure, and one task's cancel stopped another's action.
   */
  async execute(
    operation: BrowserOperation,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const turn = this.queue.then(() => this.executeOne(operation, signal));
    this.queue = turn.catch(() => undefined);
    return await turn;
  }

  private async executeOne(
    operation: BrowserOperation,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted === true) throw new Error("task_cancelled");
    // Every branch reports `success: true` on the way out, because a caller who
    // declared no evidence is held to exactly that field: policy derives
    // `result_equals success true` for browser mutations, and a result without
    // it verified as `partial` no matter how well the action went. Failures
    // throw, so reaching a return is what success means here.
    this.signal = signal;
    this.callMs = operation.timeoutMs;
    this.dispatched = false;
    this.refusedReserved = false;
    this.actingOn = undefined;
    this.actingTarget = undefined;
    this.action = operation.action;
    this.stepped = false;
    // Chromium reports a window's creation on the browser-level session,
    // ahead of any later reply there; one round trip before the action
    // starts takes every window created until now as created between
    // actions, however late that report would otherwise be handled.
    if (this.options.cdpEndpoint !== undefined && this.targets !== undefined) {
      await bounded(this.targets.send("Browser.getVersion"), operation.timeoutMs, "cdp:Browser.getVersion", signal).catch(
        () => undefined,
      );
    }
    // The round trip above swallows a cancel, and nothing has run yet. (The
    // check at the top narrowed `aborted`, which an await can change.)
    if ((signal?.aborted as boolean | undefined) === true) throw new Error("task_cancelled");
    this.actions += 1;
    this.acting = true;
    try {
      const ran = await this.run(operation);
      // An input action that went through, or a step back or forward that
      // moved, drove its page; windows it opened meanwhile are the action's
      // anyway (`createdActing`). Navigations mark it before they are sent.
      if (DRIVING_ACTIONS.has(operation.action) && ran.moved !== false) await this.drive(this.actingOn).catch(() => undefined);
      await this.awaitOpenedWindows(operation.timeoutMs);
      // A blocked popup is closed from an event handler, which has no way to
      // join the action that provoked it. Waiting here is what stops the next
      // action from seeing a tab this one already reported as closed.
      await this.call(Promise.all(this.closing.splice(0)), "close_popup");
      const result = { success: true, ...ran };
      const dialogs = this.dialogs.splice(0);
      const popups = this.popups.splice(0);
      // Only present when the page actually asked something, so a caller can
      // test for the field rather than for an empty array.
      return {
        ...result,
        ...(dialogs.length === 0 ? {} : { dialogs }),
        ...(popups.length === 0 ? {} : { popups }),
      };
    } catch (error) {
      // Only mutations ever set `dispatched`, and only once their effect call
      // has returned. Anything that fails after that — the settle, the
      // snapshot, the popup close, a bound or the task budget running out —
      // fails after the page may have acted, so it is reported as an unknown
      // outcome for the controller to park rather than as a failure it would
      // read as "nothing happened". So is a pointer action that Playwright
      // itself timed out after it had sent the input. A failure before either,
      // including a timeout resolving the target, is an ordinary failure:
      // nothing was sent, and for a read the controller may simply retry.
      // The message is stored on the task record and shown in the console.
      // An action that failed before its wait gives up on what it opened here.
      this.giveUpOwed(operation.timeoutMs);
      if (error instanceof Error) error.message = withoutColour(error.message);
      const sent = this.dispatched || inputSent(error);
      // So did one that failed after its input went out, or a step back or
      // forward that may have moved before it ran out of time. A `close`
      // drives nothing, whatever page it leaves active.
      if (DRIVING_ACTIONS.has(operation.action) && (sent || this.stepped)) {
        await this.drive(this.actingOn).catch(() => undefined);
      }
      if (!sent) throw error;
      throw outcomeUnknown(error instanceof Error ? error.message : String(error));
    } finally {
      this.acting = false;
      this.actingTarget = undefined;
      this.action = undefined;
    }
  }

  private async run(operation: BrowserOperation): Promise<Record<string, unknown>> {
    const page = await this.page();
    this.actingOn = page;
    // What it opens while this action navigates it or sends it input is the
    // action's, which in a browser this runtime is attached to is judged by
    // target id (`Target.targetCreated`).
    if (DRIVING_ACTIONS.has(operation.action) && this.options.cdpEndpoint !== undefined && this.targets !== undefined) {
      this.actingTarget = await this.targetOf(page).catch(() => undefined);
    }
    // Taken before the checks below, so an input action that passes them
    // reaches the document they read or nothing (`actOn`).
    const pin = INPUT_ACTIONS.has(operation.action)
      ? {
          page,
          document: await this.handle(page.evaluateHandle(() => document), "evaluate"),
          address: operation.url === undefined ? undefined : pageAddress(operation.url),
        }
      : undefined;
    try {
      return await this.act(operation, page, pin);
    } finally {
      void pin?.document.dispose().catch(() => undefined);
    }
  }

  private async act(operation: BrowserOperation, page: Page, pin: Pin | undefined): Promise<Record<string, unknown>> {
    // Anywhere but on the way to it, a url names the page the action acts on:
    // the active page, or for `close` and `tab_switch` the tab they name.
    // Policy shows it to the approver as the target and matches grants against
    // it, so the action is refused, before anything is sent, when that page is
    // elsewhere. Compared as policy shows it, without query or fragment. An
    // input action stays on the page checked here: one that navigates itself
    // while the action waits is refused with `browser_page_changed`.
    const acted =
      (operation.action === "close" || operation.action === "tab_switch") && operation.tabIndex !== undefined
        ? (await this.ensureContext()).pages()[operation.tabIndex]
        : page;
    if (operation.url !== undefined && operation.action !== "navigate" && operation.action !== "tab_new") {
      const at = acted === undefined ? "no such tab" : pageAddress(acted.url());
      if (at !== pageAddress(operation.url)) throw new Error(`browser_page_not_at_url: the page is at ${at}`);
    }
    // An approval console open in a browser this runtime is attached to is a
    // read away (`tabs`), and an action without a url acts on whatever page is
    // active. So no input reaches one, whatever approved the action and in
    // every mode: an approval there is the operator's act alone. Nor do the two
    // reads that can put its Approve under the operator's pointer: raising its
    // tab (`tab_switch`) and scrolling it. Reads that move its URL still work,
    // and the console unpairs when they do.
    // The console holds its buttons back for a second after it is raised, but
    // in a browser this runtime is attached to, Playwright's focus emulation
    // makes every page report itself visible and focused, so the console never
    // sees being raised. Whatever of ours could raise it is refused instead.
    // An input action is then held to the document checked here, as above.
    if (
      (operation.action === "tab_switch" ||
        operation.action === "scroll" ||
        (operation.action !== "close" && classifyOperation(operation).effect !== "read")) &&
      acted !== undefined &&
      (await this.call(acted.locator(`meta[name="${APPROVAL_SURFACE}"]`).count(), "count")) > 0
    ) {
      throw new Error("browser_refuses_approval_surface");
    }
    // Closing a tab lets the browser raise a neighbour, which can be a
    // console, and switching to a tab raises its split-view partner with it,
    // which CDP does not say. So in a browser this runtime is attached to,
    // where an operator can have one open, `close` and `tab_switch` are
    // refused while any other page here carries the marker, whatever the tab
    // acted on carries itself: any page can carry it. A marked tab of the agent's can be navigated away first. A browser
    // this runtime launched has no operator's console in it. A page that does
    // not answer within a second could be a console too busy to, so it holds
    // the others open the same way, under its own reason naming its tab; it
    // can be closed itself unless another tab also does not answer. One closed
    // meanwhile holds nothing. Attached over CDP, every page of the browser is
    // in this one context.
    if ((operation.action === "close" || operation.action === "tab_switch") && this.options.cdpEndpoint !== undefined) {
      if (operation.tabIndex !== undefined && acted === undefined) throw new Error("browser_tab_not_found");
      const pages = (await this.ensureContext()).pages();
      const marks = await Promise.all(
        pages.map((other) =>
          other === acted
            ? 0
            : bounded(other.locator(`meta[name="${APPROVAL_SURFACE}"]`).count(), 1_000, "count").catch(() =>
                other.isClosed() ? 0 : -1,
              ),
        ),
      );
      if (marks.some((count) => count > 0)) throw new Error("browser_refuses_approval_surface");
      const silent = marks.flatMap((count, index) => (count < 0 ? [index] : []));
      if (silent.length > 0) {
        throw new Error(`browser_approval_surface_check_unavailable: tab ${silent.join(", ")} did not answer`);
      }
    }
    // A targeted read says whether its target exists, and whether a target
    // exists can be made to depend on a secret field's content, however the
    // target is written. So while any frame holds a filled secret field a read
    // may look at the whole page but not aim at part of it: the refusal
    // depends on the page, never on the target. Asked again once the read has
    // looked, since a field can be filled while it does. `wait` asks on every
    // poll instead, within its own deadline.
    const targetedRead =
      ["inspect", "scroll", "screenshot"].includes(operation.action) && operation.target !== undefined;
    const within = targetedRead ? await this.clearOfSecrets(page) : undefined;
    switch (operation.action) {
      case "navigate": {
        if (operation.url === undefined) throw new Error("browser_navigate_requires_url");
        await this.assertAllowed(operation.url);
        await this.drive(page);
        const response = await page.goto(operation.url, {
          waitUntil: "domcontentloaded",
          timeout: operation.timeoutMs,
        });
        return {
          status: response?.status() ?? null,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "back":
      case "forward": {
        const before = page.url();
        this.stepped = true;
        const moved =
          operation.action === "back"
            ? await page.goBack({
                waitUntil: "domcontentloaded",
                timeout: operation.timeoutMs,
              })
            : await page.goForward({
                waitUntil: "domcontentloaded",
                timeout: operation.timeoutMs,
              });
        return {
          // Playwright returns null both when there is nowhere to go *and* when
          // the entry it landed on produced no HTTP response — `about:blank`, a
          // hash change, a `data:` URL. Only the URL tells those apart, and the
          // difference matters: a caller probing "go back unless we are at the
          // start" would otherwise be told it had not moved when it had.
          moved: moved !== null || page.url() !== before,
          status: moved?.status() ?? null,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "reload": {
        // `page.reload()` re-issues the request that produced the current page,
        // which for a POST result means re-submitting it. That is the documented
        // meaning of reload and matches `navigate`, whose target URL may have any
        // server-side effect; the domain allowlist, not the read/mutate split, is
        // what bounds what a navigation may reach.
        await this.drive(page);
        const response = await page.reload({
          waitUntil: "domcontentloaded",
          timeout: operation.timeoutMs,
        });
        return {
          status: response?.status() ?? null,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "inspect": {
        if (operation.target === undefined) return await this.snapshot(page, operation.maxChars);
        // Whatever the read found, or failed to find, a field filled while it
        // looked voids it: the refusal in `finally` replaces either.
        try {
          return await this.extract(page, operation, within);
        } finally {
          await this.clearOfSecrets(page);
        }
      }
      /**
       * Block until the page reaches a state, instead of guessing a sleep.
       *
       * Without this the only way to handle a slow login redirect or a modal
       * that animates in was to retry the next action and hope, which is why
       * `settleTimeoutMs` kept getting raised as a substitute. Waiting for the
       * thing you are actually waiting for is both faster and honest about what
       * failed when it times out.
       */
      case "wait": {
        const deadline = operation.timeoutMs;
        if (operation.urlContains !== undefined) {
          const needle = operation.urlContains;
          await page.waitForURL((url) => url.href.includes(needle), {
            timeout: deadline,
          });
        } else if (operation.target !== undefined) {
          await this.waitForTarget(
            page,
            operation.target,
            operation.state ?? "visible",
            deadline,
          );
        } else if (operation.value !== undefined) {
          const needle = operation.value;
          await page.waitForFunction(
            (text) => document.body?.innerText.includes(text) === true,
            needle,
            { timeout: deadline },
          );
        } else {
          throw new Error("browser_wait_requires_target_url_contains_or_value");
        }
        return {
          waited: true,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "click": {
        await this.actOn(
          pin!,
          await this.locator(page, operation.target),
          operation.timeoutMs,
          (element, timeout) => element.click({ timeout }),
          CLICKABLE,
        );
        // Set after the click returns, not before: Playwright's own timeout
        // mostly fires while it waits for the element to become clickable,
        // and reporting that as "may have clicked" would park every covered
        // button for reconciliation. A timeout after the input went out is
        // caught by `inputSent` instead. See `execute` for what this changes.
        this.dispatched = true;
        return {
          clicked: true,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "type": {
        if (operation.value === undefined) throw new Error("browser_type_requires_value");
        await this.typeInto(pin!, await this.locator(page, operation.target), operation.value, operation);
        return {
          typed: true,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      /**
       * Fill several fields and optionally submit, as one governed action.
       *
       * Each field is its own mutation under the per-action model, so a
       * six-field checkout form cost six typed approval phrases and six DOM
       * settles. The approval covers the whole form because the whole form is
       * what the caller planned, and it is digested into the challenge like any
       * other operation.
       */
      case "fill_form": {
        if (operation.fields === undefined) {
          throw new Error("browser_fill_form_requires_fields");
        }
        for (const field of operation.fields) {
          await this.typeInto(pin!, await this.locator(page, field.target), field.value, operation);
        }
        const submitted = operation.target !== undefined;
        if (submitted) {
          await this.actOn(
            pin!,
            await this.locator(page, operation.target),
            operation.timeoutMs,
            (element, timeout) => element.click({ timeout }),
            CLICKABLE,
          );
          this.dispatched = true;
        }
        return {
          filled: operation.fields.length,
          submitted,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "select": {
        if (operation.values === undefined) throw new Error("browser_select_requires_values");
        const values = operation.values;
        const selected = await this.actOn(
          pin!,
          await this.locator(page, operation.target),
          operation.timeoutMs,
          (element, timeout) => element.selectOption(values, { timeout }),
          ["visible", "enabled"],
        );
        this.dispatched = true;
        return {
          selected,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "press": {
        if (operation.key === undefined) throw new Error("browser_press_requires_key");
        const key = operation.key;
        const locator =
          operation.target === undefined
            ? page.locator("body")
            : await this.locator(page, operation.target);
        await this.actOn(pin!, locator, operation.timeoutMs, (element, timeout) =>
          element.press(key, { timeout }),
        );
        this.dispatched = true;
        return {
          pressed: operation.key,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "scroll": {
        const direction = operation.direction ?? "down";
        if (direction === "into_view") {
          // As for inspect: the check after the read wins over its outcome.
          try {
            const element = await this.readTarget(page, operation.target, within);
            await element
              .scrollIntoViewIfNeeded({ timeout: operation.timeoutMs })
              .finally(() => element.dispose().catch(() => undefined));
          } finally {
            await this.clearOfSecrets(page);
          }
        } else {
          // A fixed ±600 was too small for a long article and too large for a
          // short scroll container, and nothing could change it.
          await this.call(
            page.evaluate(
              ({ value, pixels }) => {
                if (value === "top") window.scrollTo(0, 0);
                else if (value === "bottom") window.scrollTo(0, document.body.scrollHeight);
                else window.scrollBy(0, value === "up" ? -pixels : pixels);
              },
              { value: direction, pixels: operation.pixels },
            ),
            "evaluate",
          );
        }
        return {
          scrolled: direction,
          // Where we ended up, so a caller paging through a document can tell
          // it has hit the bottom rather than scrolling forever.
          scrollY: await this.call(page.evaluate(() => window.scrollY), "evaluate"),
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "screenshot": {
        const path = join(
          this.options.artifactDirectory,
          `browser-${randomUUID()}.png`,
        );
        await page.screenshot({
          path,
          fullPage: operation.fullPage,
          type: "png",
          timeout: operation.timeoutMs,
        });
        const bytes = await readFile(path);
        return {
          captured: true,
          path,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          url: page.url(),
          title: await this.call(page.title(), "title"),
        };
      }
      case "upload": {
        if (operation.filePaths === undefined) {
          throw new Error("browser_upload_requires_file_paths");
        }
        const files = await this.uploadPaths(operation.filePaths);
        await this.actOn(pin!, await this.locator(page, operation.target), operation.timeoutMs, (element, timeout) =>
          element.setInputFiles(files, { timeout }),
        );
        this.dispatched = true;
        return {
          uploaded: files.length,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "download": {
        const downloadPromise = page.waitForEvent("download", {
          timeout: operation.timeoutMs,
        });
        // If resolving or clicking the target throws first, nobody awaits the
        // download wait, and its own timeout would surface as an unhandled
        // rejection long after this action failed.
        downloadPromise.catch(() => undefined);
        await this.actOn(
          pin!,
          await this.locator(page, operation.target),
          operation.timeoutMs,
          (element, timeout) => element.click({ timeout }),
          CLICKABLE,
        );
        this.dispatched = true;
        // The click went out, so this stays an unknown outcome, but one that
        // names the refusal when the route turned the file away.
        const download = await downloadPromise.catch((error: unknown) => {
          throw this.refusedReserved ? new Error("browser_path_reserved") : error;
        });
        const suggested = download.suggestedFilename().replaceAll(/[^A-Za-z0-9._-]/g, "_");
        const path = join(
          this.options.artifactDirectory,
          `${randomUUID()}-${suggested || "download"}`,
        );
        // Bounded by the task budget only. Saving waits for the whole file to
        // arrive, and how long that legitimately takes depends on the file, not
        // on the per-call `timeoutMs`.
        await this.call(download.saveAs(path), "save_download", Infinity);
        const bytes = await readFile(path);
        return {
          downloaded: true,
          path,
          suggestedFilename: download.suggestedFilename(),
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          url: page.url(),
          settle: await waitForStableDom(
            page,
            {
              quietWindowMs: operation.settleQuietMs,
              timeoutMs: operation.settleTimeoutMs,
            },
            this.signal,
          ),
        };
      }
      case "tabs": {
        const context = await this.ensureContext();
        return { tabs: await this.describeTabs(context) };
      }
      case "tab_new": {
        const context = await this.ensureContext();
        const opened = await this.openPage(context);
        this.activate(opened);
        if (operation.url !== undefined) {
          await this.assertAllowed(operation.url);
          await opened.goto(operation.url, {
            waitUntil: "domcontentloaded",
            timeout: operation.timeoutMs,
          });
        }
        return {
          opened: true,
          index: context.pages().indexOf(opened),
          tabs: await this.describeTabs(context),
        };
      }
      case "tab_switch": {
        const context = await this.ensureContext();
        if (operation.tabIndex === undefined) {
          throw new Error("browser_tab_switch_requires_tab_index");
        }
        // The page checked above, not whichever holds its index by now.
        const target = acted;
        if (target === undefined || target.isClosed()) throw new Error("browser_tab_not_found");
        // Bring the tab to the front so a screenshot of it is what the user
        // would actually see; a background page still renders, but modal and
        // focus behaviour differ.
        await this.call(target.bringToFront(), "bring_to_front");
        this.activate(target);
        return {
          switched: true,
          index: (await this.ensureContext()).pages().indexOf(target),
          url: target.url(),
          tabs: await this.describeTabs(context),
        };
      }
      case "close": {
        const context = await this.ensureContext();
        // The page checked above, not whichever holds its index by now.
        const target = acted;
        if (target === undefined || target.isClosed()) throw new Error("browser_tab_not_found");
        const url = target.url();
        // Set before the close, unlike the other mutations: this call is the
        // effect and has no wait-for-ready phase, so once it is in flight a
        // bound running out cannot say whether the tab went away.
        this.dispatched = true;
        await this.call(target.close(), "close");
        this.activate(context.pages().at(-1));
        return { closed: true, url, tabs: await this.describeTabs(context) };
      }
    }
  }

  async close(): Promise<void> {
    const connection = this.connection;
    const quietly = (call: Promise<unknown>, what: string) =>
      bounded(call, CLOSE_TIMEOUT_MS, what).catch(() => undefined);
    // An attached browser outlives us; stop asking it to narrate its targets.
    if (this.targets !== undefined) await quietly(this.targets.detach(), "cdp_detach");
    this.targets = undefined;
    this.forgetLapsing();
    if (
      connection !== undefined &&
      !connection.ownsContext &&
      this.routeHandler !== undefined
    ) {
      await quietly(connection.context.unroute("**/*", this.routeHandler), "unroute");
    }
    if (connection?.ownsContext === true) {
      await quietly(connection.context.close(), "close_context");
    }
    if (connection?.ownsBrowser === true) {
      await quietly(connection.browser.close(), "close_browser");
    }
    // After the browser, so a request in flight is not left without a proxy.
    await this.proxy?.close().catch(() => undefined);
    this.proxy = undefined;
    this.activePage = undefined;
    this.context = undefined;
    this.browser = undefined;
    this.connection = undefined;
    this.routeHandler = undefined;
  }
}

// The destination guard moved to `@melra/policy-core` so the HTTP adapter can
// reach it without pulling in Playwright. Re-exported here because it was part
// of this package's published surface.
export {
  assertSafeDestination,
  assertSafeUrl,
  isPrivateAddress,
  type NetworkPolicy,
  type SafeDestination,
} from "@melra/policy-core";
export * from "./pinning-proxy.js";
export * from "./selector.js";
export * from "./stable-dom.js";
export * from "./browser-connection.js";
export * from "./bounded.js";
