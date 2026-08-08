// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  Browser,
  BrowserContext,
  Frame,
  Locator,
  Page,
  Route,
} from "playwright-core";
import type { BrowserOperation, BrowserTarget } from "@melra/protocol";
import {
  connectBrowser,
  type BrowserConnection,
} from "./browser-connection.js";
import {
  assertSafeUrl,
  type NetworkPolicy,
} from "./network-policy.js";
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
}

/**
 * How many frames one page is searched across. Ad and analytics stacks attach
 * dozens; the interactive ones a caller cares about are always near the front.
 */
const MAX_FRAMES = 20;

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
 * Collect the readable text and addressable elements of one frame.
 *
 * Module level rather than inline because it is now evaluated once per frame
 * instead of once per page. It runs inside the browser, so it may not close
 * over anything here.
 */
function collectFrame(limit: number) {
  const text = document.body?.innerText ?? "";
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
      value:
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
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

export class BrowserRuntime {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private activePage: Page | undefined;
  private connection: BrowserConnection | undefined;
  private proxy: PinningProxy | undefined;
  private routeHandler: ((route: Route) => Promise<void>) | undefined;
  /**
   * Dialogs raised by the action currently running, cleared by `execute`.
   *
   * One buffer on the runtime rather than one per page because the handler is
   * registered on the context, and because operations execute one at a time —
   * a task owns its runtime for the length of one action.
   */
  private dialogs: Record<string, unknown>[] = [];
  /**
   * Windows the page opened during the action currently running, same lifetime
   * as `dialogs` and reported the same way.
   */
  private popups: Record<string, unknown>[] = [];
  /** Pending closes of blocked popups, awaited before the action reports. */
  private closing: Promise<unknown>[] = [];
  /** True only while `tab_new` is opening the tab the caller asked for. */
  private openingTab = false;

  constructor(private readonly options: BrowserRuntimeOptions) {}

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
      const actual = await realpath(candidate);
      const actualRelative = relative(root, actual);
      if (
        actualRelative === ".." ||
        actualRelative.startsWith(`..${sep}`) ||
        isAbsolute(actualRelative)
      ) {
        throw new Error("browser_upload_outside_workspace");
      }
      if (!(await stat(actual)).isFile()) {
        throw new Error("browser_upload_requires_regular_file");
      }
      resolved.push(actual);
    }
    return resolved;
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
        await assertSafeUrl(requestUrl, this.options);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    };
    await this.context.route("**/*", this.routeHandler);
    if (this.options.replayHarPath !== undefined) {
      // Registered after the destination guard so it runs first: a replayed
      // request is served from the file and never becomes a socket, and
      // `notFound: "abort"` means a request the archive is missing fails
      // visibly rather than falling through to the network the guard would
      // have allowed.
      await this.context.routeFromHAR(this.options.replayHarPath, {
        notFound: "abort",
      });
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
      if (opened === this.activePage || this.openingTab) return;
      // Closing a window the page opened is MELRA's judgement about what the
      // caller should be looking at, so unhinged mode drops it. Reporting it is
      // not a judgement — that stays on, like every other receipt.
      const allowed = this.options.popups === "allow" || this.options.unhinged === true;
      if (this.popups.length < MAX_POPUPS) {
        this.popups.push({ url: opened.url(), blocked: !allowed });
      }
      if (allowed) return;
      // A popup that closed on its own, or whose opener navigated away first,
      // must not turn into the action's error.
      this.closing.push(opened.close().catch(() => undefined));
    });
    return this.context;
  }

  /**
   * Opens a page MELRA asked for, not one the site opened by itself.
   *
   * The popup handler cannot tell the two apart — both arrive as a `page`
   * event — so this flag is the difference, and it is held across exactly the
   * await that emits the event.
   */
  private async openPage(context: BrowserContext): Promise<Page> {
    this.openingTab = true;
    try {
      return await context.newPage();
    } finally {
      this.openingTab = false;
    }
  }

  private async page(): Promise<Page> {
    const context = await this.ensureContext();
    if (this.activePage !== undefined && !this.activePage.isClosed()) {
      return this.activePage;
    }
    this.activePage = context.pages()[0] ?? (await this.openPage(context));
    return this.activePage;
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
        title: await item.title(),
        active: item === this.activePage,
      })),
    );
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
   */
  private candidates(page: Page, target: BrowserTarget): Locator[] {
    return this.frames(page).flatMap((frame) => {
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
   */
  private async locator(
    page: Page,
    target: BrowserTarget | undefined,
  ): Promise<Locator> {
    if (target === undefined) throw new Error("browser_action_requires_target");
    for (const candidate of this.candidates(page, target)) {
      if ((await candidate.count()) > 0) return candidate;
    }
    throw new Error(
      `browser_target_not_found:${JSON.stringify(target)}`,
    );
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
      let reached = negated;
      for (const candidate of this.candidates(page, target)) {
        const element = candidate.first();
        // `isVisible`/`count` report on a missing element rather than throwing,
        // so absence is an answer here: it satisfies `hidden` and `detached`.
        const present =
          state === "attached" || state === "detached"
            ? (await element.count()) > 0
            : await element.isVisible();
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
      if (reached) return;
      if (Date.now() >= deadline) {
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
  private async typeInto(
    locator: Locator,
    value: string,
    operation: BrowserOperation,
  ): Promise<void> {
    const field = locator.first();
    if (operation.clearFirst) {
      await field.fill("", { timeout: operation.timeoutMs });
    }
    await field.pressSequentially(value, {
      delay: operation.delayMs,
      timeout: operation.timeoutMs,
    });
  }

  private async snapshot(page: Page, maxChars: number): Promise<Record<string, unknown>> {
    const frames = this.frames(page);
    const collected = await Promise.all(
      frames.map(async (frame) => {
        try {
          return await frame.evaluate(collectFrame, maxChars);
        } catch {
          // A frame that navigated or detached mid-evaluate is not a failed
          // inspect. Losing an ad frame should not lose the page.
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
      title: await page.title(),
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
  ): Promise<Record<string, unknown>> {
    const locator = (await this.locator(page, operation.target)).first();
    const [text, html] = await Promise.all([
      locator.innerText({ timeout: operation.timeoutMs }),
      locator.innerHTML({ timeout: operation.timeoutMs }),
    ]);
    return {
      url: page.url(),
      title: await page.title(),
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
    const settle = await waitForStableDom(page, {
      quietWindowMs: operation.settleQuietMs,
      timeoutMs: operation.settleTimeoutMs,
    });
    return {
      settle,
      ...(await this.snapshot(page, operation.maxChars)),
    };
  }

  async execute(operation: BrowserOperation): Promise<Record<string, unknown>> {
    // Every branch reports `success: true` on the way out, because a caller who
    // declared no evidence is held to exactly that field: policy derives
    // `result_equals success true` for browser mutations, and a result without
    // it verified as `partial` no matter how well the action went. Failures
    // throw, so reaching a return is what success means here.
    this.dialogs = [];
    this.popups = [];
    const ran = await this.run(operation);
    // A blocked popup is closed from an event handler, which has no way to join
    // the action that provoked it. Waiting here is what stops the next action
    // from seeing a tab this one already reported as closed.
    await Promise.all(this.closing.splice(0));
    const result = { success: true, ...ran };
    // Only present when the page actually asked something, so a caller can test
    // for the field rather than for an empty array.
    return {
      ...result,
      ...(this.dialogs.length === 0 ? {} : { dialogs: this.dialogs }),
      ...(this.popups.length === 0 ? {} : { popups: this.popups }),
    };
  }

  private async run(operation: BrowserOperation): Promise<Record<string, unknown>> {
    const page = await this.page();
    switch (operation.action) {
      case "navigate": {
        if (operation.url === undefined) throw new Error("browser_navigate_requires_url");
        await assertSafeUrl(operation.url, this.options);
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
        const response = await page.reload({
          waitUntil: "domcontentloaded",
          timeout: operation.timeoutMs,
        });
        return {
          status: response?.status() ?? null,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "inspect":
        return operation.target === undefined
          ? await this.snapshot(page, operation.maxChars)
          : await this.extract(page, operation);
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
        await (await this.locator(page, operation.target)).first().click({
          timeout: operation.timeoutMs,
        });
        return {
          clicked: true,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "type": {
        if (operation.value === undefined) throw new Error("browser_type_requires_value");
        await this.typeInto(
          await this.locator(page, operation.target),
          operation.value,
          operation,
        );
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
          await this.typeInto(
            await this.locator(page, field.target),
            field.value,
            operation,
          );
        }
        const submitted = operation.target !== undefined;
        if (submitted) {
          await (await this.locator(page, operation.target)).first().click({
            timeout: operation.timeoutMs,
          });
        }
        return {
          filled: operation.fields.length,
          submitted,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "select": {
        if (operation.values === undefined) throw new Error("browser_select_requires_values");
        const selected = await (await this.locator(page, operation.target))
          .first()
          .selectOption(operation.values, { timeout: operation.timeoutMs });
        return {
          selected,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "press": {
        if (operation.key === undefined) throw new Error("browser_press_requires_key");
        const locator =
          operation.target === undefined
            ? page.locator("body")
            : await this.locator(page, operation.target);
        await locator.first().press(operation.key, { timeout: operation.timeoutMs });
        return {
          pressed: operation.key,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "scroll": {
        const direction = operation.direction ?? "down";
        if (direction === "into_view") {
          await (await this.locator(page, operation.target)).first().scrollIntoViewIfNeeded({
            timeout: operation.timeoutMs,
          });
        } else {
          // A fixed ±600 was too small for a long article and too large for a
          // short scroll container, and nothing could change it.
          await page.evaluate(
            ({ value, pixels }) => {
              if (value === "top") window.scrollTo(0, 0);
              else if (value === "bottom") window.scrollTo(0, document.body.scrollHeight);
              else window.scrollBy(0, value === "up" ? -pixels : pixels);
            },
            { value: direction, pixels: operation.pixels },
          );
        }
        return {
          scrolled: direction,
          // Where we ended up, so a caller paging through a document can tell
          // it has hit the bottom rather than scrolling forever.
          scrollY: await page.evaluate(() => window.scrollY),
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "screenshot": {
        const path = join(
          this.options.artifactDirectory,
          `browser-${randomUUID()}.png`,
        );
        await page.screenshot({ path, fullPage: operation.fullPage, type: "png" });
        const bytes = await readFile(path);
        return {
          captured: true,
          path,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          url: page.url(),
          title: await page.title(),
        };
      }
      case "upload": {
        if (operation.filePaths === undefined) {
          throw new Error("browser_upload_requires_file_paths");
        }
        const files = await this.uploadPaths(operation.filePaths);
        await (await this.locator(page, operation.target)).first().setInputFiles(files, {
          timeout: operation.timeoutMs,
        });
        return {
          uploaded: files.length,
          ...(await this.settledSnapshot(page, operation)),
        };
      }
      case "download": {
        const downloadPromise = page.waitForEvent("download", {
          timeout: operation.timeoutMs,
        });
        await (await this.locator(page, operation.target)).first().click({
          timeout: operation.timeoutMs,
        });
        const download = await downloadPromise;
        const suggested = download.suggestedFilename().replaceAll(/[^A-Za-z0-9._-]/g, "_");
        const path = join(
          this.options.artifactDirectory,
          `${randomUUID()}-${suggested || "download"}`,
        );
        await download.saveAs(path);
        const bytes = await readFile(path);
        return {
          downloaded: true,
          path,
          suggestedFilename: download.suggestedFilename(),
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          url: page.url(),
          settle: await waitForStableDom(page, {
            quietWindowMs: operation.settleQuietMs,
            timeoutMs: operation.settleTimeoutMs,
          }),
        };
      }
      case "tabs": {
        const context = await this.ensureContext();
        return { tabs: await this.describeTabs(context) };
      }
      case "tab_new": {
        const context = await this.ensureContext();
        const opened = await this.openPage(context);
        this.activePage = opened;
        if (operation.url !== undefined) {
          await assertSafeUrl(operation.url, this.options);
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
        const target = context.pages()[operation.tabIndex];
        if (target === undefined) throw new Error("browser_tab_not_found");
        // Bring the tab to the front so a screenshot of it is what the user
        // would actually see; a background page still renders, but modal and
        // focus behaviour differ.
        await target.bringToFront();
        this.activePage = target;
        return {
          switched: true,
          index: operation.tabIndex,
          url: target.url(),
          tabs: await this.describeTabs(context),
        };
      }
      case "close": {
        const context = await this.ensureContext();
        const pages = context.pages();
        const target =
          operation.tabIndex === undefined
            ? page
            : pages[operation.tabIndex];
        if (target === undefined) throw new Error("browser_tab_not_found");
        const url = target.url();
        await target.close();
        this.activePage = context.pages().at(-1);
        return { closed: true, url, tabs: await this.describeTabs(context) };
      }
    }
  }

  async close(): Promise<void> {
    const connection = this.connection;
    if (
      connection !== undefined &&
      !connection.ownsContext &&
      this.routeHandler !== undefined
    ) {
      await connection.context
        .unroute("**/*", this.routeHandler)
        .catch(() => undefined);
    }
    if (connection?.ownsContext === true) {
      await connection.context.close().catch(() => undefined);
    }
    if (connection?.ownsBrowser === true) {
      await connection.browser.close().catch(() => undefined);
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

export * from "./network-policy.js";
export * from "./pinning-proxy.js";
export * from "./selector.js";
export * from "./stable-dom.js";
export * from "./browser-connection.js";
