// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

/**
 * The Community console: one self-contained page, no build step, no network
 * fetches beyond this server. It is a read-only window onto durable state —
 * planning, approving, and advancing stay on the governed MCP and CLI paths, so
 * nothing here can start work that policy has not seen. For the same reason it
 * never renders an approval phrase, even though, in developer mode, the task
 * API carries one: a phrase on screen is one copy-paste away from an approval
 * nobody read.
 */
export function consolePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>MELRA console</title>
<style>${CONSOLE_STYLE}</style>
</head>
<body>
<a class="skip" href="#view">Skip to content</a>
<header class="top">
  <div class="brand">
    <span class="mark" aria-hidden="true"></span>
    <h1>MELRA console</h1>
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
// The page itself is served behind this token, so it has to stay in the URL:
// without it a reload would come back 401.
const token = new URL(location.href).searchParams.get("token") ?? "";

const auth = { headers: { authorization: "Bearer " + token } };
const view = document.getElementById("view");
const state = { caps: null, tasks: [], workflows: [], filter: "all", query: "", stream: null, streamId: null, events: [], sig: "" };

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
  ["attention", "Needs attention", (t) => ["awaiting_approval", "waiting_user", "recovery_required", "partial"].includes(t.status)],
  ["verified", "Verified", (t) => t.status === "verified_success"],
  ["blocked", "Blocked or failed", (t) => ["policy_blocked", "failed", "budget_exhausted"].includes(t.status)],
  ["active", "In flight", (t) => ["planned", "running", "verifying"].includes(t.status)],
];

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
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
const when = (iso) => el("time", { datetime: iso, title: iso ? new Date(iso).toLocaleString() : "", text: ago(iso) });

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
    setLive(true, "Live · updated " + new Date().toLocaleTimeString());
    document.getElementById("version").textContent = "v" + caps.version + " · " + caps.policy.mode + " mode";
    document.getElementById("count-tasks").textContent = String(state.tasks.length || "");
    document.getElementById("count-workflows").textContent = String(state.workflows.length || "");
    const warning = document.getElementById("warning");
    warning.hidden = !caps.policy.unhinged;
    if (caps.policy.unhinged) warning.textContent = "Unsafe-local mode — " + (caps.policy.unhingedWarning ?? "no policy and no guardrails are applied.");
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) { renderUnauthorized(); setLive(false, "Not authorised"); return false; }
    setLive(false, "Disconnected — retrying");
    return false;
  }
}

function route() {
  const [name, id] = location.hash.replace(/^#\/?/, "").split("/");
  return { name: ["tasks", "workflows"].includes(name) ? name : "overview", id: id ? decodeURIComponent(id) : null };
}
function go(name, id) { location.hash = "#/" + name + (id ? "/" + encodeURIComponent(id) : ""); }

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
  const tile = (n, label, filter, tone) => el("button", { class: "card tile", type: "button",
    onclick: () => { state.filter = filter; go("tasks"); } },
    el("span", { class: "n " + (tone ?? ""), text: String(n) }), el("span", { class: "muted", text: label }));
  const tiles = el("div", { class: "grid tiles" },
    tile(t.length, "Tasks recorded", "all"),
    tile(count((x) => x.status === "verified_success"), "Verified by evidence", "verified", "ok"),
    tile(count(FILTERS[1][2]), "Need attention", "attention", "warn"),
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
    parts.push(el("div", { class: "callout" }, left === "expired"
      ? "The approval window for this task has closed. Plan it again to get a fresh challenge."
      : ["Waiting for an approval" + (left ? " — expires in " + left : "") + ". Approve it with ",
        el("code", { text: "melra approve " + task.id }), " in a terminal. The console is read-only and never shows the phrase."]));
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
      ["Mode", r.mode], ["Target", r.target ? mono(r.target) : null], ["Input digest", mono(r.inputDigest)],
      ["Ran", r.startedAt ? when(r.startedAt) : null],
      ["Redactions", r.redactions?.length ? chips(r.redactions) : null],
    ])));
  }
  // The redacted copy the store holds; the approval block is dropped so the phrase never renders.
  const { approval: _approval, ...stored } = task;
  parts.push(el("details", {}, el("summary", { text: "Stored record (redacted)" }), el("pre", { text: JSON.stringify(stored, null, 2) })));
  if (route().id === id) into.replaceChildren(...parts);
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
const eventLine = (data) => el("div", {}, "#" + data.sequence + "  ", el("strong", { text: data.type }), "  " + ago(data.occurredAt));

function nodeTable(run) {
  return el("table", {}, el("thead", {}, el("tr", {}, ["Node", "Status", "Tasks", "Detail"].map((h) => el("th", { text: h })))),
    el("tbody", {}, Object.entries(run.nodes ?? {}).map(([nodeId, node]) => el("tr", {},
      el("td", { class: "mono", text: nodeId }), el("td", {}, badge(node.status, RUN_TONE)),
      el("td", {}, (node.taskIds ?? []).map((taskId) => el("a", { href: "#/tasks/" + encodeURIComponent(taskId), class: "mono", title: taskId, text: taskId.slice(0, 8) + " " }))),
      el("td", { text: node.error ?? node.prompt ?? "" })))));
}

async function renderWorkflowDetail(id, into) {
  let run;
  try { run = await get("/api/workflows/" + encodeURIComponent(id)); }
  catch { into.replaceChildren(el("div", { class: "empty" }, el("p", { text: "Workflow " + id + " was not found." }))); return; }
  // Rebuilt from state so a re-render never drops what the stream already delivered.
  const events = el("div", { class: "events", "aria-live": "polite" }, state.streamId === id ? state.events.map(eventLine).reverse() : []);
  into.replaceChildren(...[
    el("div", { class: "head" }, el("h3", { class: "mono", text: run.id }), badge(run.status, RUN_TONE),
      el("span", { class: "muted", text: "state v" + run.stateVersion })),
    run.error ? el("div", { class: "callout bad", text: run.error }) : null,
    ["awaiting_approval", "awaiting_input", "planned", "ready", "running"].includes(run.status)
      ? el("div", { class: "callout" }, "Advance it with ", el("code", { text: "melra workflow advance " + run.id }), copyButton("melra workflow advance " + run.id)) : null,
    el("div", { class: "section" }, el("h2", { text: "Nodes" }), el("div", { class: "scroll-x" }, nodeTable(run))),
    el("div", { class: "section" }, el("h2", { text: "Events" }), events),
  ].filter(Boolean));
  if (state.streamId === id && state.stream) return;
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
window.addEventListener("hashchange", render);

if (!token) { renderUnauthorized(); setLive(false, "No token"); }
else if (await refresh()) render();
const signature = () => JSON.stringify([state.tasks.map((t) => [t.id, t.status, t.updatedAt]), state.workflows.map((w) => [w.id, w.status, w.updatedAt])]);
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
