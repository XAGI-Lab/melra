// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { APPROVAL_SURFACE } from "@melra/browser-runtime";

/**
 * The Community console: one self-contained page, no build step, no network
 * fetches beyond this server. It is a read-only window onto durable state —
 * planning, approving, and advancing stay on the governed MCP and CLI paths, so
 * nothing here can start work that policy has not seen. For the same reason it
 * never renders an approval phrase, even though, in developer mode, the task
 * API carries one: a phrase on screen is one copy-paste away from an approval
 * nobody read.
 *
 * `approvals` is the same page as `melra console` serves it, where an operator
 * can approve or deny a pending task. Its marker tells a browser runtime
 * attached to the same browser never to send it input, and the page's own script
 * reads the marker to pair instead of reading a token from the URL. The CSP
 * below lets no other script run on it, so nothing can take the marker off.
 */
export function consolePage(approvals = false): string {
  const name = approvals ? "MELRA approval console" : "MELRA console";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
${approvals ? `<meta name="${APPROVAL_SURFACE}" content="operator-only" />\n` : ""}<title>${name}</title>
<style>${CONSOLE_STYLE}</style>
</head>
<body>
<a class="skip" href="#view">Skip to content</a>
<header class="top">
  <div class="brand">
    <span class="mark" aria-hidden="true"></span>
    <h1>${name}</h1>
    <span id="version" class="muted"></span>
  </div>
  <nav role="tablist" aria-label="Views">
    <button role="tab" id="tab-overview" data-view="overview">Overview</button>
    <button role="tab" id="tab-tasks" data-view="tasks">Tasks <span class="count" id="count-tasks"></span></button>
    <button role="tab" id="tab-workflows" data-view="workflows">Workflows <span class="count" id="count-workflows"></span></button>
  </nav>
  <div class="live" id="live" aria-live="polite"><span class="dot"></span><span id="live-text">Connecting…</span></div>
</header>
<div id="warning" role="alert" hidden></div>
<main id="view" tabindex="-1"></main>
<script type="module">${CONSOLE_SCRIPT}</script>
</body>
</html>
`;
}

/**
 * The page's Content-Security-Policy. The inline script and style are allowed
 * by hash rather than `'unsafe-inline'`, so even if a value ever reached the
 * DOM as markup it could not run, and `connect-src 'self'` keeps the bearer
 * token from being sent anywhere but this server.
 */
export function consoleSecurityHeaders(): Record<string, string> {
  return {
    "content-security-policy": [
      "default-src 'none'",
      `script-src '${sha256(CONSOLE_SCRIPT)}'`,
      `style-src '${sha256(CONSOLE_STYLE)}'`,
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}

function sha256(source: string): string {
  return `sha256-${createHash("sha256").update(source, "utf8").digest("base64")}`;
}

const CONSOLE_STYLE = String.raw`
:root {
  color-scheme: light dark;
  --bg: #f7f7f5; --panel: #ffffff; --text: #1b1b1f; --muted: #66666f;
  --line: #e3e3df; --soft: #f0f0ec; --accent: #3a5ccc;
  --ok: #1f7a4a; --ok-bg: #e3f3ea; --warn: #8a5a00; --warn-bg: #fbf0d9;
  --bad: #b3261e; --bad-bg: #fbe5e3; --info: #2f5fb3; --info-bg: #e5edfb;
  --idle: #5d5d66; --idle-bg: #ececea;
  --radius: 10px; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111114; --panel: #18181c; --text: #ececf0; --muted: #9a9aa6;
    --line: #2a2a31; --soft: #202026; --accent: #8ea6ff;
    --ok: #6fd39c; --ok-bg: #16301f; --warn: #f0c060; --warn-bg: #33270f;
    --bad: #ff8a80; --bad-bg: #3a1714; --info: #8fb4ff; --info-bg: #172440;
    --idle: #a5a5b0; --idle-bg: #26262c;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; min-height: 100vh; }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
.skip { position: absolute; left: -999px; top: 8px; background: var(--panel); padding: 6px 10px; z-index: 10; }
.skip:focus { left: 8px; }
.muted { color: var(--muted); }
.mono, .id { font-family: var(--mono); font-size: 12.5px; }
.top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
  padding: 10px 24px; background: var(--panel); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 10px; }
.brand h1 { font-size: 15px; margin: 0; font-weight: 650; letter-spacing: -.01em; }
.mark { width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(135deg, var(--accent), var(--ok)); }
nav { display: flex; gap: 4px; }
nav button { background: none; border: 0; padding: 6px 12px; border-radius: 8px; cursor: pointer; color: var(--muted); }
nav button:hover { background: var(--soft); color: var(--text); }
nav button[aria-selected="true"] { background: var(--soft); color: var(--text); font-weight: 600; }
.count { font-size: 11px; padding: 0 6px; border-radius: 99px; background: var(--line); margin-left: 2px; }
.count:empty { display: none; }
.live { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); }
.live.ok .dot { background: var(--ok); }
.live.bad .dot { background: var(--bad); }
#warning { margin: 12px 24px 0; padding: 10px 14px; border-radius: var(--radius); background: var(--bad); color: #fff; font-weight: 600; }
main { padding: 20px 24px 48px; max-width: 1400px; margin: 0 auto; outline: none; }
h2 { font-size: 12px; margin: 0 0 10px; font-weight: 650; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
h3 { font-size: 15px; margin: 0 0 4px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; min-width: 0; }
.grid { display: grid; gap: 16px; }
.tiles { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-bottom: 16px; }
.tile { display: flex; flex-direction: column; gap: 2px; text-align: left; cursor: pointer; }
.tile:hover { border-color: var(--muted); }
.n.ok { color: var(--ok); } .n.warn { color: var(--warn); } .n.bad { color: var(--bad); }
.head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.tile .n { font-size: 28px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.two { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.split { display: grid; grid-template-columns: minmax(280px, 2fr) minmax(0, 3fr); gap: 16px; align-items: start; }
dl.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; margin: 0; }
dl.kv dt { color: var(--muted); }
dl.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-family: var(--mono); font-size: 12px; padding: 1px 8px; border-radius: 6px; background: var(--soft); border: 1px solid var(--line); }
.badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; padding: 1px 8px;
  border-radius: 99px; white-space: nowrap; background: var(--idle-bg); color: var(--idle); }
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge.ok { background: var(--ok-bg); color: var(--ok); }
.badge.warn { background: var(--warn-bg); color: var(--warn); }
.badge.bad { background: var(--bad-bg); color: var(--bad); }
.badge.info { background: var(--info-bg); color: var(--info); }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
input[type="search"] { font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line);
  border-radius: 8px; padding: 6px 10px; min-width: 220px; flex: 1; }
.filter { background: var(--panel); border: 1px solid var(--line); border-radius: 99px; padding: 3px 10px; cursor: pointer; font-size: 12.5px; }
.filter[aria-pressed="true"] { background: var(--text); color: var(--bg); border-color: var(--text); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: calc(100vh - 220px); overflow: auto; }
.row { width: 100%; text-align: left; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; cursor: pointer;
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; }
.row:hover { border-color: var(--muted); }
.row[aria-current="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.row .what { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .sub { grid-column: 1 / -1; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
table { border-collapse: collapse; width: 100%; }
.scroll-x { overflow-x: auto; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; }
.section { margin-top: 18px; }
.evidence { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.evidence li { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 8px; align-items: start;
  padding: 8px 10px; border-radius: 8px; background: var(--soft); }
.mark-ok { color: var(--ok); font-weight: 700; } .mark-bad { color: var(--bad); font-weight: 700; }
.events { font-family: var(--mono); font-size: 12px; max-height: 320px; overflow: auto; }
.events div { padding: 4px 0; border-bottom: 1px solid var(--line); }
.callout { border-radius: 8px; padding: 10px 12px; background: var(--warn-bg); color: var(--warn); margin: 12px 0; }
.callout.bad { background: var(--bad-bg); color: var(--bad); }
.callout code, .empty code { font-family: var(--mono); font-size: 12.5px; }
.empty { text-align: center; padding: 40px 16px; color: var(--muted); }
.empty h3 { color: var(--text); }
pre { margin: 0; font-family: var(--mono); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere;
  background: var(--soft); border-radius: 8px; padding: 10px 12px; max-height: 360px; overflow: auto; }
details summary { cursor: pointer; color: var(--muted); margin-top: 16px; }
pre.screen { max-height: none; margin: 12px 0; }
pre .line { display: block; padding-left: 4ch; text-indent: -4ch; }
button[aria-disabled="true"] { opacity: .45; cursor: progress; }
.copy { background: none; border: 1px solid var(--line); border-radius: 6px; padding: 0 6px; cursor: pointer; font-size: 11px; color: var(--muted); margin-left: 6px; }
@media (max-width: 860px) {
  .split, .two { grid-template-columns: 1fr; }
  .top { padding: 10px 16px; gap: 10px; } main { padding: 16px; }
  .live { margin-left: 0; width: 100%; }
}
@media (prefers-reduced-motion: no-preference) {
  .live.ok .dot { animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
}
`;

/**
 * Plain JavaScript inside String.raw with no `${` and no backticks, so nothing
 * in it is interpolated on the server. Every value it renders goes through
 * `textContent` — never `innerHTML` — and the page's CSP pins this exact text
 * by hash.
 */
const CONSOLE_SCRIPT = String.raw`
// The approval console (melra console) carries this marker. Its token is a
// session this page gets by pairing, held in this document's memory only: not
// in storage, the DOM or a URL. Anywhere else the page is served behind the
// token in its URL, so it has to stay there: without it a reload would come
// back 401.
const approvals = document.querySelector('meta[name="melra-approval-surface"]') !== null;
let paired = approvals ? await pair() : {};
const token = approvals ? paired.session ?? "" : new URL(location.href).searchParams.get("token") ?? "";

// The code rides in the fragment, which no request line, log or Referer
// carries, and leaves the address bar before it is spent. The server spends it
// once, so the document that spent it is the only one ever paired: any other
// page in this tab, this one reloaded or come back to included, is not. That
// is what keeps a click aimed at another page from landing here when that page
// sends the tab back to this console mid-click.
async function pair() {
  const code = new URLSearchParams(location.hash.slice(1)).get("pair");
  if (code === null) return { error: "not_paired" };
  history.replaceState(null, "", location.pathname);
  const response = await fetch("/pair", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }) }).catch(() => null);
  const body = response ? await response.json().catch(() => ({})) : {};
  return response?.ok ? body : { error: body.error ?? "console_unreachable" };
}
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const auth = { headers: { authorization: "Bearer " + token } };
const view = document.getElementById("view");
// Leaving ends the pairing, before a back/forward cache could keep it. So does
// a move of the URL within this page: the approval console never makes one
// (see go), so whatever did is driving the tab, and the reads of a browser
// runtime attached to it can (navigate to a fragment, back, forward). It ends
// on the console's side too, so the session is worth nothing after, and the
// page drops what it drew, so no click can bring it back.
if (approvals) for (const type of ["pagehide", "hashchange", "popstate"]) addEventListener(type, () => {
  if (token && auth.headers.authorization) {
    void fetch("/unpair", { method: "POST", keepalive: true,
      headers: { ...auth.headers, "content-type": "application/json" }, body: "{}" }).catch(() => {});
  }
  auth.headers.authorization = "";
  paired = { error: "left" };
  state.caps = null;
  setLive(false, "Not paired");
  renderUnauthorized();
});
// Approve and Deny act only once this page has been visible, focused and
// unscrolled for a second, as a browser holds back a permission prompt's
// buttons. Raising a tab and scrolling it can put Approve under a pointer aimed
// at something else; a click that lands sooner than that is ignored. While a
// CDP client with focus emulation is attached, as MELRA's browser runtime is,
// this page reads visible and focused throughout and sees no raise, so only
// scroll and resize restart the hold; that runtime refuses its own raises.
const SETTLE_MS = 1000;
let steadySince = Infinity;
function unsettle() {
  steadySince = document.visibilityState === "visible" && document.hasFocus() ? performance.now() : Infinity;
  showSettling();
}
const settled = (drawnAt) => performance.now() - Math.max(steadySince, drawnAt) >= SETTLE_MS;
function showSettling() {
  const mark = () => {
    for (const button of document.querySelectorAll("button[data-drawn]")) {
      button.setAttribute("aria-disabled", String(!settled(Number(button.dataset.drawn))));
    }
  };
  mark();
  setTimeout(mark, SETTLE_MS + 50);
}
if (approvals) {
  // The window's own focus and blur, not an element's: pressing a button
  // focuses it, and that must not reset anything.
  for (const type of ["visibilitychange", "focus", "blur", "resize"]) addEventListener(type, unsettle);
  // Captured, so a scrolled box inside the page counts as well as the page.
  addEventListener("scroll", unsettle, true);
  unsettle();
}
const state = { caps: null, tasks: [], workflows: [], approvalPendingIds: new Set(), attentionCount: 0, filter: "all", query: "", stream: null, streamId: null, events: [], sig: "" };

const TASK_TONE = {
  verified_success: "ok", partial: "warn", awaiting_approval: "info", waiting_user: "info",
  planned: "", running: "info", verifying: "info", failed: "bad", policy_blocked: "bad",
  budget_exhausted: "warn", recovery_required: "warn", cancelled: "",
};
const RUN_TONE = {
  verified_complete: "ok", partially_complete: "warn", awaiting_approval: "info", awaiting_input: "info",
  running: "info", verifying: "info", ready: "", pending: "", planned: "", draft: "", paused: "warn", suspended: "warn",
  recovery_required: "warn", failed: "bad", cancelled: "", skipped: "", compensated: "warn",
};
const FILTERS = [
  ["all", "All", () => true],
  ["attention", "Needs attention", (t) => t.status === "awaiting_approval"
    ? state.approvalPendingIds.has(t.id) : ["waiting_user", "recovery_required", "partial"].includes(t.status)],
  ["verified", "Verified", (t) => t.status === "verified_success"],
  ["blocked", "Blocked or failed", (t) => ["policy_blocked", "failed", "budget_exhausted"].includes(t.status)],
  ["active", "In flight", (t) => ["planned", "running", "verifying"].includes(t.status)],
];

// The characters approvalScreen spells out (approval-screen.ts; keep the two
// in step), spelled out the same way in all text the approval console draws.
// Most of it is the agent's: targets, errors, prompts, stored records. A bidi
// override, a zero-width character or a stack of combining marks in it would
// otherwise reorder, hide or draw over what it shows. The agent's own console
// approves nothing and shows its text as it is.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cn}\p{Zl}\p{Zp}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}]/gu;
const STACKED = /(?<=[\p{Mn}\p{Me}]{2})[\p{Mn}\p{Me}]/gu;
const spelled = (character) => Array.from({ length: character.length }, (_, i) => "\\u" + character.charCodeAt(i).toString(16).padStart(4, "0")).join("");
const printable = (text) => !approvals ? String(text)
  : String(text).replace(HIDDEN, (character) => character === "\n" ? character : spelled(character)).replace(STACKED, spelled);

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = printable(value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(printable(child)));
  }
  return node;
}
const human = (s) => String(s ?? "").replaceAll("_", " ");
const badge = (status, tones) => el("span", { class: "badge " + (tones[status] ?? ""), text: human(status) });
const kv = (pairs) => el("dl", { class: "kv" }, pairs.filter(([, v]) => v !== undefined && v !== null && v !== "")
  .flatMap(([k, v]) => [el("dt", { text: k }), el("dd", {}, v)]));
const chips = (items) => items.length ? el("div", { class: "chips" }, items.map((i) => el("span", { class: "chip", text: i }))) : el("span", { class: "muted", text: "none" });
const mono = (text) => el("span", { class: "mono", text });

function ago(iso) {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return iso;
  if (seconds < 0) return "in " + until(iso);
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return new Date(iso).toLocaleString();
}
function until(iso) {
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (seconds <= 0) return "expired";
  return seconds < 120 ? seconds + "s" : Math.round(seconds / 60) + "m";
}
// Set as is, not through el: the browser's own locale formats carry marks
// printable would spell out (Arabic puts U+200F in every date).
const when = (iso) => {
  const node = el("time", { datetime: iso, title: iso ? new Date(iso).toLocaleString() : "" });
  node.textContent = ago(iso);
  return node;
};

function copyButton(text) {
  return el("button", { class: "copy", type: "button", "aria-label": "Copy " + text, text: "copy", onclick: async (e) => {
    try { await navigator.clipboard.writeText(text); e.target.textContent = "copied"; } catch { e.target.textContent = "select"; }
    setTimeout(() => { e.target.textContent = "copy"; }, 1200);
  } });
}

function target(op) {
  const command = op.command ? [op.command, ...(op.args ?? [])].join(" ") : undefined;
  return op.path ?? op.url ?? command ?? op.key ?? op.query ?? op.selector ?? "";
}

class HttpError extends Error { constructor(status, path) { super(path + " -> " + status); this.status = status; } }
async function get(path) {
  const response = await fetch(path, auth);
  if (!response.ok) throw new HttpError(response.status, path);
  return response.json();
}

function setLive(ok, text) {
  const live = document.getElementById("live");
  live.className = "live " + (ok ? "ok" : "bad");
  document.getElementById("live-text").textContent = text;
}

async function refresh() {
  try {
    const [caps, tasks, runs] = await Promise.all([get("/api/capabilities"), get("/api/tasks?limit=500"), get("/api/workflows")]);
    state.caps = caps; state.tasks = tasks.tasks; state.workflows = runs.workflows;
    state.approvalPendingIds = new Set(tasks.approvalPendingIds); state.attentionCount = tasks.attentionCount;
    setLive(true, "Live · updated " + new Date().toLocaleTimeString() + (paired.pairedAt ? " · paired at " + clock(paired.pairedAt) : ""));
    document.getElementById("version").textContent = "v" + caps.version + " · " + caps.policy.mode + " mode";
    document.getElementById("count-tasks").textContent = String(state.tasks.length || "");
    document.getElementById("count-workflows").textContent = String(state.workflows.length || "");
    const warning = document.getElementById("warning");
    warning.hidden = !caps.policy.unhinged;
    if (caps.policy.unhinged) warning.textContent = "Unsafe-local mode — " + (caps.policy.unhingedWarning ?? "no policy and no guardrails are applied.");
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      state.caps = null;
      renderUnauthorized();
      setLive(false, approvals ? "Not paired" : "Not authorised");
      return false;
    }
    setLive(false, "Disconnected — retrying");
    return false;
  }
}

// In the approval console the task an Approve applies to is the one this
// page's own clicks chose, kept here: the URL never picks it. Nor does the page
// change its URL once paired, so a change it sees is something else driving the tab,
// and ends the pairing (the pagehide listener above).
let selected = { name: "overview", id: null };
function route() {
  if (approvals) return selected;
  const [name, id] = location.hash.replace(/^#\/?/, "").split("/");
  return { name: ["tasks", "workflows"].includes(name) ? name : "overview", id: id ? decodeURIComponent(id) : null };
}
function go(name, id) {
  if (approvals) { selected = { name, id: id ?? null }; render(); }
  else location.hash = "#/" + name + (id ? "/" + encodeURIComponent(id) : "");
}

function render() {
  if (!state.caps) return;
  const { name, id } = route();
  for (const tab of document.querySelectorAll("[role=tab]")) {
    const selected = tab.dataset.view === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  view.setAttribute("aria-labelledby", "tab-" + name);
  if (name === "tasks") renderTasks(id);
  else if (name === "workflows") renderWorkflows(id);
  else renderOverview();
}

function renderUnauthorized() {
  if (approvals) {
    const taken = paired.error === "console_already_paired";
    view.replaceChildren(el("div", { class: "card empty" },
      el("h3", { text: taken ? "Another tab already paired with this console" : "This page is not paired with a running approval console" }),
      el("p", {}, taken ? "If that was not you, press Ctrl-C in the console's terminal now, then cancel each task it lists as approved with " : "",
        taken ? el("code", { text: "melra approve <task-id> --deny" }) : "", taken ? ". " : "",
        "Run ", el("code", { text: "melra console" }), " in a terminal: the first page to use its one-time code, normally the one it opens, is the only one that can approve. ",
        "Leaving or reloading that page ends its pairing."),
    ));
    return;
  }
  view.replaceChildren(el("div", { class: "card empty" },
    el("h3", { text: "This console needs its access token" }),
    el("p", {}, "Start the server with ", el("code", { text: "melra serve --http --open" }),
      " — it opens this page with the token attached. Or copy the Console URL it prints, which includes ",
      el("code", { text: "?token=…" }), "."),
  ));
}

function renderOverview() {
  const t = state.tasks;
  const count = (f) => t.filter(f).length;
  const p = state.caps.policy;
  const tile = (n, label, filter, tone, note) => el("button", { class: "card tile", type: "button",
    onclick: () => { state.filter = filter; go("tasks"); } },
    el("span", { class: "n " + (tone ?? ""), text: String(n) }), el("span", { class: "muted", text: label }),
    note ? el("span", { class: "muted", text: note }) : null);
  // Each tile counts what its filter lists, the newest 500; the server counts
  // the tasks needing attention past those.
  const attention = count(FILTERS[1][2]);
  const older = state.attentionCount - attention;
  const tiles = el("div", { class: "grid tiles" },
    tile(t.length, "Tasks recorded", "all"),
    tile(count((x) => x.status === "verified_success"), "Verified by evidence", "verified", "ok"),
    tile(attention, "Need attention", "attention", "warn", older > 0 ? older + " more older than the newest 500" : undefined),
    tile(count(FILTERS[3][2]), "Blocked or failed", "blocked", "bad"),
  );
  const posture = el("div", { class: "card" }, el("h2", { text: "Posture" }), kv([
    ["Mode", el("span", {}, badge(p.mode, { enforced: "ok", developer: "info" }), " ", el("span", { class: "muted", text:
      p.mode === "enforced" ? "MELRA is asserted to be the only path to these systems" : "the harness may have another path" }))],
    ["Guardrails", p.unhinged ? badge("off (unsafe-local)", { "off (unsafe-local)": "bad" }) : badge("all applied", { "all applied": "ok" })],
    ["Mutations", p.mutations !== "confirm" ? human(p.mutations)
      : p.mode === "enforced" ? "require an operator's approval (melra approve)" : "require an exact approval phrase"],
    ["Workspace", el("span", {}, mono(p.workspaceRoot), copyButton(p.workspaceRoot))],
    ["Commands allowed", chips(p.allowedCommands ?? [])],
    ["Browser domains", el("span", {}, chips(p.allowedDomains ?? []), p.allowLocalhost ? el("span", { class: "muted", text: " + localhost" }) : null)],
    ["Credentials held", String((p.credentials ?? []).length)],
    ["Capability grants", String(p.capabilityGrants ?? 0) + (p.meteredGrants ? " (" + p.meteredGrants + " metered)" : "")],
    ["Telemetry", p.telemetry],
  ]));
  const ops = state.caps.operations ?? {};
  const adapters = el("div", { class: "card" }, el("h2", { text: "Effect adapters" }),
    kv(Object.entries(ops).map(([kind, actions]) => [kind, chips(actions)])));
  const recent = t.slice(0, 6);
  const activity = el("div", { class: "card section" }, el("h2", { text: "Recent activity" }),
    recent.length === 0 ? gettingStarted() : el("ul", { class: "list" }, recent.map((task) => el("li", {}, taskRow(task, false)))));
  view.replaceChildren(tiles, el("div", { class: "grid two" }, posture, adapters), activity);
}

function gettingStarted() {
  return el("div", { class: "empty" },
    el("h3", { text: "Nothing has run through MELRA yet" }),
    el("p", {}, "Point an agent at this kernel, then ask it to do something. Every effect lands here with its policy decision, evidence, and receipt."),
    el("p", {}, el("code", { text: "melra setup --client claude-code --write" })),
    el("p", { class: "muted" }, "Also: codex, openclaw, hermes, cursor, vscode, windsurf, gemini, copilot, zed, cline, opencode, kilo, kiro, goose, continue, amp, qwen, auggie, warp, junie, droid, kimi, lmstudio, claude-desktop."),
  );
}

function taskRow(task, current) {
  const op = task.request?.operation ?? {};
  return el("button", { class: "row", type: "button", "data-key": task.id, "aria-current": String(current), onclick: () => go("tasks", task.id) },
    el("span", { class: "what", text: op.kind + "." + op.action + (target(op) ? "  " + target(op) : "") }),
    badge(task.status, TASK_TONE),
    el("span", { class: "sub" }, (task.policyDecision ? task.policyDecision.effect + " · " + task.policyDecision.risk + " risk · " : ""), when(task.updatedAt)),
  );
}

function renderTasks(id) {
  const filter = FILTERS.find(([key]) => key === state.filter) ?? FILTERS[0];
  const q = state.query.toLowerCase();
  const shown = state.tasks.filter(filter[2]).filter((task) => !q || [task.id, task.status, task.request?.operation?.kind,
    task.request?.operation?.action, target(task.request?.operation ?? {}), task.policyDecision?.reason].join(" ").toLowerCase().includes(q));
  const search = el("input", { type: "search", placeholder: "Search by id, operation, target, reason…", "aria-label": "Search tasks", value: state.query,
    oninput: (e) => { state.query = e.target.value; const pos = e.target.selectionStart; render(); const s = view.querySelector("input[type=search]"); s.focus(); s.setSelectionRange(pos, pos); } });
  const filters = FILTERS.map(([key, label, f]) => el("button", { class: "filter", type: "button", "aria-pressed": String(state.filter === key),
    onclick: () => { state.filter = key; render(); } }, label + " " + state.tasks.filter(f).length));
  const list = shown.length === 0
    ? el("div", { class: "card empty" }, state.tasks.length === 0 ? gettingStarted() : el("p", { text: "No tasks match." }))
    : el("ul", { class: "list", "aria-label": "Tasks" }, shown.map((task) => el("li", {}, taskRow(task, task.id === id))));
  const detail = el("div", { class: "card", id: "task-detail" });
  if (id) void renderTaskDetail(id, detail);
  else detail.append(el("div", { class: "empty" }, el("p", { text: "Select a task to see its policy decision, evidence, and receipts." })));
  view.replaceChildren(el("div", { class: "toolbar" }, search), el("div", { class: "toolbar", role: "group", "aria-label": "Filter" }, filters),
    el("div", { class: "split" }, list, detail));
}

async function renderTaskDetail(id, into) {
  let task, receipts;
  try {
    [task, receipts] = await Promise.all([get("/api/tasks/" + encodeURIComponent(id)), get("/api/tasks/" + encodeURIComponent(id) + "/receipts").catch(() => null)]);
  } catch {
    into.replaceChildren(el("div", { class: "empty" }, el("p", { text: "Task " + id + " was not found." })));
    return;
  }
  const op = task.request?.operation ?? {};
  const d = task.policyDecision ?? {};
  const parts = [
    el("div", { class: "head" }, el("h3", { text: op.kind + "." + op.action }), badge(task.status, TASK_TONE)),
    el("p", { class: "muted" }, mono(task.id), copyButton(task.id)),
  ];
  if (task.status === "awaiting_approval") {
    const left = task.approval?.expiresAt ? until(task.approval.expiresAt) : undefined;
    const pending = await get("/api/tasks/" + encodeURIComponent(id) + (approvals ? "/approval" : "/approval-state")).catch(() => null);
    if (pending?.decision) parts.push(el("div", { class: "callout" }, "Approved by ", pending.decision.approver, " ", when(pending.decision.decidedAt), ".",
      !pending.step ? " Waiting for the agent to run it." : pending.named === false
        ? [" Its run does not name this step, so no advance runs it. See the run with ", el("code", { text: "melra workflow inspect " + pending.workflowId }), "."]
        : [" This workflow step waits for its run to advance.", ...(resumeHint(pending) ?? [])]));
    else if (left === "expired" || pending?.unusable) parts.push(el("div", { class: "callout" }, closedAdvice(task.id, left, pending)));
    else if (approvals) parts.push(await approvalPanel(task.id, pending));
    else parts.push(el("div", { class: "callout" }, ["Waiting for an approval" + (left ? " — expires in " + left : "") + ". Approve it with ",
        el("code", { text: "melra approve " + task.id }), " or in ", el("code", { text: "melra console" }),
        ", in a terminal. This console is read-only and never shows the phrase."]));
  }
  if (task.error) parts.push(el("div", { class: "callout bad", text: task.error }));
  parts.push(el("div", { class: "section" }, el("h2", { text: "Request" }), kv([
    ["Target", target(op) ? mono(target(op)) : null],
    ["Created", when(task.createdAt)], ["Updated", when(task.updatedAt)],
    ["Attempts", task.attempts !== undefined ? String(task.attempts) : null],
    ["Budget", task.request?.budget ? task.request.budget.maxDurationMs / 1000 + "s, " + task.request.budget.maxRetries + " retries" : null],
  ])));
  parts.push(el("div", { class: "section" }, el("h2", { text: "Policy decision" }), kv([
    ["Outcome", badge(d.outcome, { allow: "ok", confirm: "info", deny: "bad" })],
    ["Reason", human(d.reason)], ["Effect", d.effect], ["Risk", d.risk],
    ["Traits", d.traits?.length ? chips(d.traits) : null], ["Policy version", d.policyVersion],
    ["Policy digest", d.policyDigest ? mono(d.policyDigest) : null],
  ])));
  const evidence = receipts?.certificate?.evidence ?? receipts?.receipts?.flatMap((r) => r.evidence ?? []) ?? [];
  parts.push(el("div", { class: "section" }, el("h2", { text: "Evidence" }), evidence.length === 0
    ? el("p", { class: "muted", text: "No evidence recorded yet." })
    : el("ul", { class: "evidence" }, evidence.map((e) => el("li", {},
      el("span", { class: e.passed ? "mark-ok" : "mark-bad", "aria-label": e.passed ? "passed" : "failed", text: e.passed ? "✓" : "✕" }),
      el("span", {}, el("strong", { text: human(e.type) }), el("div", { class: "muted", text: e.summary ?? "" })),
      e.strength ? el("span", { class: "chip", title: "How this evidence is known", text: e.strength }) : null)))));
  if (receipts?.certificate) parts.push(el("div", { class: "section" }, el("h2", { text: "Certificate" }), kv([
    ["Result", badge(receipts.certificate.result.toLowerCase(), { verified_success: "ok", partial: "warn", failed: "bad" })],
    ["Certificate", mono(receipts.certificate.certificateId)],
  ])));
  for (const r of receipts?.receipts ?? []) {
    parts.push(el("div", { class: "section" }, el("h2", { text: "Receipt" }), kv([
      ["Capability", mono(r.capability)], ["Principal", mono(r.principal)], ["Guarantee", r.executionGuarantee],
      ["Mode", r.mode], ["Sandbox", r.sandbox], ["Target", r.target ? mono(r.target) : null], ["Input digest", mono(r.inputDigest)],
      ["Ran", r.startedAt ? when(r.startedAt) : null],
      ["Redactions", r.redactions?.length ? chips(r.redactions) : null],
    ])));
  }
  // The redacted copy the store holds; the approval block is dropped so the phrase never renders.
  const { approval: _approval, ...stored } = task;
  parts.push(el("details", {}, el("summary", { text: "Stored record (redacted)" }), el("pre", { text: JSON.stringify(stored, null, 2) })));
  if (route().id === id) into.replaceChildren(...parts);
}

/**
 * What to do with a challenge no one can answer now: expired, or holding a
 * decision that cannot be used (in enforced mode, one made in band). The rule
 * melra tasks gives (#299): a workflow's step is never told to deny, which
 * would fail its run, and only a run that can advance is told to.
 */
function closedAdvice(id, left, pending) {
  const code = (text) => el("code", { text });
  if (!pending) return "The approval window for this task has closed.";
  const spent = left === "expired" ? "" : " can no longer be approved: its challenge already holds a decision that cannot be used.";
  if (!pending.step) return [(spent ? "This task" + spent : "The approval window for this task has closed.") + " Plan it again or clear it with ",
    code("melra approve " + id + " --deny"), "."];
  const lead = spent ? "This workflow step" + spent : "This workflow step's approval has expired.";
  const run = pending.workflowId;
  // Only for the task the run names: advancing never takes up an older duplicate.
  // A failed run's advance unwinds: it asks a compensation again, never a forward step.
  const advances = ["awaiting_approval", "running"].includes(pending.workflowStatus) ||
    (pending.compensation === true && pending.workflowStatus === "failed");
  if (pending.named && !spent && advances) return [lead + " Advance it with ", code("melra workflow advance " + run), "."];
  const resume = pending.named ? resumeHint(pending) : null;
  if (resume) return [lead, ...resume];
  // Spent, only an advance after the challenge expires asks again; nothing asks again for an older duplicate.
  const again = pending.named === false ? "" : spent
    ? " where the run still waits on the step, an advance after its challenge expires (in " + until(pending.expiresAt) + ") asks again,"
    : " where the run still waits on the step, its next advance asks again,";
  return [lead + " See its run with ", code("melra workflow inspect " + (run ?? "<workflow-id>")),
    ":" + again + " and a deny would fail the run, or for a compensation stall its unwind."];
}

/** A halted run advances nothing, a step's decision included, until resumed. */
function resumeHint(pending) {
  if (!["paused", "suspended"].includes(pending.workflowStatus)) return null;
  return [" Its run is " + pending.workflowStatus + ", and advances only once resumed with ", el("code", { text: "melra workflow resume " + pending.workflowId }), "."];
}

/**
 * What the task would do, as the CLI's approval screen shows it, and the two
 * answers. MELRA's own summary sits right above the buttons, where the terminal
 * puts it above its question, and the agent's full contract above that, folded.
 * Approve posts the task and the digest this panel drew, fixed when it drew
 * them, so a request that changed since is refused, not approved unseen, and
 * nothing selected since can take the click.
 */
async function approvalPanel(id, pending) {
  if (!pending) return el("div", { class: "callout bad", text: "Could not load what this task would do." });
  const path = "/api/tasks/" + encodeURIComponent(id) + "/";
  const drawn = { taskId: id, renderDigest: pending.renderDigest };
  const drawnAt = performance.now();
  const status = el("p", { role: "status" });
  const answer = async (action, body) => {
    if (!settled(drawnAt)) return;
    for (const button of buttons) button.disabled = true;
    const response = await fetch(path + action, { method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).catch(() => null);
    // The console stopped: nothing here can record a decision any more.
    if (response === null) { status.textContent = "Not sent: the console has stopped. Run 'melra console' again."; return; }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) for (const button of buttons) button.disabled = false;
    status.textContent = !response.ok ? "Refused: " + (result.error ?? response.status)
      : action === "deny" ? "Denied; the task is cancelled."
      : "Approved, " + human(result.decision.channel) + ". The agent's next call runs it.";
  };
  // Why, recorded with a deny for the people who read the record; MELRA never reads the note.
  const reason = el("select", { "aria-label": "Why deny" }, ["wrong_target", "too_broad", "not_now", "never", "other"]
    .map((value) => el("option", { value, text: human(value), selected: value === "other" })));
  const note = el("input", { type: "text", maxlength: 1000, placeholder: "Note (optional)", "aria-label": "Note with a deny" });
  const denial = () => ({ reason: reason.value, ...(note.value.trim() === "" ? {} : { note: note.value }) });
  const buttons = pending.decision ? [] : [
    el("button", { type: "button", class: "filter", text: "Approve", "data-drawn": drawnAt, "aria-disabled": "true", onclick: () => answer("approve", drawn) }),
    el("button", { type: "button", class: "filter", text: "Deny", "data-drawn": drawnAt, "aria-disabled": "true", onclick: () => answer("deny", denial()) }),
  ];
  showSettling();
  return el("div", { class: "section" }, el("h2", { text: "Approve this effect?" }),
    pending.mode === "enforced" ? null : el("div", { class: "callout", text: "Developer mode: this records an in-band decision, which an enforced server will not act on." }),
    el("details", {}, el("summary", { text: "Full contract (JSON)" }),
      el("pre", {}, pending.contract.split("\n").map((line) => el("span", { class: "line", text: line })))),
    // One block per line, each with a hanging indent, here and in the contract
    // above: however agent text in a line wraps, the wrapped part starts
    // indented, so it can never stand at the left edge looking like a line
    // MELRA wrote, its Effect line above all.
    el("pre", { class: "screen" }, pending.summary.replace(/\n$/, "").split("\n").map((line) => el("span", { class: "line", text: line }))),
    pending.decision ? el("p", {}, "Approved by " + pending.decision.approver + " ", when(pending.decision.decidedAt), ".")
      : el("p", {}, buttons[0], " ", buttons[1], " ", reason, " ", note),
    status);
}

function renderWorkflows(id) {
  const runs = state.workflows;
  const list = runs.length === 0
    ? el("div", { class: "card empty" }, el("h3", { text: "No workflows yet" }),
        el("p", {}, "Plan one with ", el("code", { text: "melra workflow plan --definition flow.json" }), " or try ", el("code", { text: "melra demo durable-core" }), "."))
    : el("ul", { class: "list", "aria-label": "Workflows" }, runs.map((run) => el("li", {},
        el("button", { class: "row", type: "button", "data-key": run.id, "aria-current": String(run.id === id), onclick: () => go("workflows", run.id) },
          el("span", { class: "what mono", text: run.id }), badge(run.status, RUN_TONE),
          el("span", { class: "sub" }, Object.keys(run.nodes ?? {}).length + " nodes · ", when(run.updatedAt))))));
  const detail = el("div", { class: "card" });
  if (id) void renderWorkflowDetail(id, detail);
  else {
    closeStream();
    detail.append(el("div", { class: "empty" }, el("p", { text: "Select a workflow to follow its nodes and live event stream." })));
  }
  view.replaceChildren(el("div", { class: "split" }, list, detail));
}

function closeStream() { if (state.stream) state.stream.close(); state.stream = null; state.streamId = null; state.events = []; }
const eventLine = (data) => el("div", {}, "#" + data.sequence + "  ", el("strong", { text: data.type }), "  ", when(data.occurredAt));

function nodeTable(run) {
  return el("table", {}, el("thead", {}, el("tr", {}, ["Node", "Status", "Tasks", "Detail"].map((h) => el("th", { text: h })))),
    el("tbody", {}, Object.entries(run.nodes ?? {}).map(([nodeId, node]) => el("tr", {},
      el("td", { class: "mono", text: nodeId }), el("td", {}, badge(node.status, RUN_TONE)),
      el("td", {}, (node.taskIds ?? []).map((taskId) => el("a", { href: "#/tasks/" + encodeURIComponent(taskId), class: "mono", title: taskId, text: taskId.slice(0, 8) + " ",
        onclick: approvals ? (e) => { e.preventDefault(); go("tasks", taskId); } : undefined }))),
      el("td", { text: node.error ?? node.prompt ?? "" })))));
}

async function renderWorkflowDetail(id, into) {
  let run;
  try { run = await get("/api/workflows/" + encodeURIComponent(id)); }
  catch { into.replaceChildren(el("div", { class: "empty" }, el("p", { text: "Workflow " + id + " was not found." }))); return; }
  // Rebuilt from state so a re-render never drops what the stream already
  // delivered. The approval console has no stream (below), so it reads the
  // events afresh on each render, with its session in a header.
  const listed = approvals
    ? ((await get("/api/workflows/" + encodeURIComponent(id) + "/events").catch(() => null))?.events ?? [])
    : state.streamId === id ? state.events : [];
  const events = el("div", { class: "events", "aria-live": "polite" }, listed.map(eventLine).reverse());
  into.replaceChildren(...[
    el("div", { class: "head" }, el("h3", { class: "mono", text: run.id }), badge(run.status, RUN_TONE),
      el("span", { class: "muted", text: "state v" + run.stateVersion })),
    run.error ? el("div", { class: "callout bad", text: run.error }) : null,
    ["awaiting_approval", "awaiting_input", "planned", "ready", "running"].includes(run.status)
      ? el("div", { class: "callout" }, "Advance it with ", el("code", { text: "melra workflow advance " + run.id }), copyButton("melra workflow advance " + run.id)) : null,
    el("div", { class: "section" }, el("h2", { text: "Nodes" }), el("div", { class: "scroll-x" }, nodeTable(run))),
    el("div", { class: "section" }, el("h2", { text: "Events" }), events),
  ].filter(Boolean));
  // The approval console's session goes in a header, never a URL, and
  // EventSource can only send a URL.
  if (approvals || (state.streamId === id && state.stream)) return;
  closeStream();
  state.streamId = id;
  // Live tail. Every frame is one appended event, so the console never has to
  // guess whether it missed one: the sequence is on the wire.
  state.stream = new EventSource("/api/workflows/" + encodeURIComponent(id) + "/stream?token=" + encodeURIComponent(token));
  state.stream.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    state.events.push(data);
    const box = view.querySelector(".events");
    if (box) box.prepend(eventLine(data));
    if (data.type === "workflow.status_changed") void refresh().then(render);
  });
}

for (const tab of document.querySelectorAll("[role=tab]")) {
  tab.addEventListener("click", () => go(tab.dataset.view));
  tab.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const tabs = [...document.querySelectorAll("[role=tab]")];
    const next = tabs[(tabs.indexOf(tab) + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    next.focus(); go(next.dataset.view);
  });
}
if (!approvals) window.addEventListener("hashchange", render);
// Focus the content without touching the URL, which would end an approval
// console's pairing.
document.querySelector(".skip").addEventListener("click", (e) => { e.preventDefault(); view.focus(); });

if (!token) { renderUnauthorized(); setLive(false, approvals ? "Not paired" : "No token"); }
else if (await refresh()) render();
// The attention fields too: a decision recorded or lapsing leaves the task row as it was.
const signature = () => JSON.stringify([state.tasks.map((t) => [t.id, t.status, t.updatedAt]), state.workflows.map((w) => [w.id, w.status, w.updatedAt]),
  state.attentionCount, [...state.approvalPendingIds]]);
state.sig = signature();
// Poll, but re-render only when something actually changed, and put focus back
// on the same row, so keyboard users and a hovering pointer are never yanked.
setInterval(async () => {
  if (!token || document.hidden || !(await refresh())) return;
  const sig = signature();
  if (sig === state.sig || document.activeElement?.type === "search") return;
  state.sig = sig;
  const key = document.activeElement?.dataset?.key;
  render();
  if (key) view.querySelector('[data-key="' + CSS.escape(key) + '"]')?.focus();
}, 5000);
`;
